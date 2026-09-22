//! Local usage history: incremental scanning of Agent session logs, persisted
//! per-day aggregation, and week/month settlement with estimated costs (M8b).
//!
//! Everything here is local: logs are read from disk, the price table ships
//! with the app, and no request is ever made. Scans run on a background thread
//! and report progress through [`USAGE_HISTORY_SCAN_EVENT`] so the Usage page
//! can keep rendering while the first full scan is still running.
//!
//! Day buckets use the user's local timezone (`chrono::Local`), the week starts
//! on Monday, and the month is the local calendar month. Because the daily
//! aggregate is persisted, deleting the source logs never removes history, and
//! rescanning unchanged files neither reparses them nor counts them twice.

pub mod pricing;
pub mod scanner;
pub mod store;

use super::{unknown_history, UsageCost, UsageHistory, UsageModelPeriod, UsagePeriod, UsageTokens};
use chrono::{DateTime, Datelike, Duration, Local, NaiveDate};
use pricing::PriceTable;
use scanner::SourceRoot;
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};
use store::{TokenCounts, UsageHistoryStore, USAGE_HISTORY_DB_FILE};

/// Emitted with [`UsageHistoryScanStatus`] while a scan runs and once when it
/// finishes.
pub const USAGE_HISTORY_SCAN_EVENT: &str = "usage-history-scan";
/// Files between progress events; a full Codex sessions tree has hundreds.
const PROGRESS_FILE_STEP: usize = 25;
/// Memory bound asserted by the large-log test (the reader itself caps a single
/// line at `scanner::MAX_LOG_LINE_BYTES`).
pub const LARGE_SCAN_MEMORY_BOUND_BYTES: u64 = 128 * 1024 * 1024;

/// Providers with a local session-log reader.
const HISTORY_PROVIDERS: [(&str, &str); 2] = [("codex", "Codex"), ("claude-code", "Claude Code")];

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageHistoryScanStatus {
    pub scanning: bool,
    pub files_total: usize,
    pub files_scanned: usize,
    pub files_parsed: usize,
    pub files_skipped: usize,
    pub oversized_lines: usize,
    pub events: usize,
    pub error: Option<String>,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
}

fn history_provider_label(provider: &str) -> Option<&'static str> {
    HISTORY_PROVIDERS
        .iter()
        .find(|(id, _)| *id == provider)
        .map(|(_, label)| *label)
}

/// Default local session-log roots. Resolved lazily on the scan thread because
/// the Claude config root may probe the login shell on some platforms.
fn default_sources() -> Vec<SourceRoot> {
    let home = crate::data_dir::home_dir();
    vec![
        SourceRoot {
            provider: "codex",
            root: home.join(".codex").join("sessions"),
        },
        SourceRoot {
            provider: "claude-code",
            root: crate::agents::claude_code::default_config_root().join("projects"),
        },
    ]
}

pub struct UsageHistoryService {
    store: UsageHistoryStore,
    pricing: PriceTable,
    /// `None` resolves [`default_sources`] at scan time; tests inject roots.
    roots: Option<Vec<SourceRoot>>,
    status: Mutex<UsageHistoryScanStatus>,
}

impl UsageHistoryService {
    pub(crate) fn new(store_path: PathBuf, pricing: PriceTable) -> Self {
        Self {
            store: UsageHistoryStore::at(store_path),
            pricing,
            roots: None,
            status: Mutex::new(UsageHistoryScanStatus::default()),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_roots(
        store_path: PathBuf,
        roots: Vec<SourceRoot>,
        pricing: PriceTable,
    ) -> Self {
        Self {
            roots: Some(roots),
            ..Self::new(store_path, pricing)
        }
    }

    pub fn from_app(app: &tauri::AppHandle) -> Self {
        use tauri::Manager;
        let resource_dir = app.path().resource_dir().ok();
        Self::new(
            crate::data_dir::resolve_home_entry(USAGE_HISTORY_DB_FILE),
            PriceTable::load(&pricing::default_candidates(resource_dir.as_deref())),
        )
    }

    pub fn scan_status(&self) -> UsageHistoryScanStatus {
        self.status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub fn pricing_effective_date(&self) -> Option<&str> {
        self.pricing.effective_date()
    }

    fn update_status(&self, update: impl FnOnce(&mut UsageHistoryScanStatus)) {
        let mut status = self
            .status
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        update(&mut status);
    }

    /// Starts a scan on a background thread. Returns `false` when a scan is
    /// already running so repeated page loads cannot pile up.
    pub fn start_scan<F>(self: &Arc<Self>, on_progress: F) -> bool
    where
        F: Fn(&UsageHistoryScanStatus) + Send + 'static,
    {
        {
            let mut status = self
                .status
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if status.scanning {
                return false;
            }
            status.scanning = true;
            status.started_at = Some(chrono::Utc::now().timestamp_millis());
            status.finished_at = None;
            status.error = None;
        }

        let service = Arc::clone(self);
        let spawn = std::thread::Builder::new()
            .name("usage-history-scan".to_string())
            .spawn(move || {
                let result = service.run_scan(&|status| on_progress(status));
                service.update_status(|status| {
                    status.scanning = false;
                    status.finished_at = Some(chrono::Utc::now().timestamp_millis());
                    status.error = result.err();
                });
                on_progress(&service.scan_status());
            });
        if let Err(error) = spawn {
            self.update_status(|status| {
                status.scanning = false;
                status.error = Some(format!("usage history scan thread failed: {error}"));
            });
            return false;
        }
        true
    }

    /// One synchronous scan pass. Exposed for tests and for callers that want
    /// to await completion.
    pub(crate) fn run_scan(
        &self,
        on_progress: &dyn Fn(&UsageHistoryScanStatus),
    ) -> Result<(), String> {
        self.update_status(|status| {
            *status = UsageHistoryScanStatus {
                scanning: true,
                started_at: Some(chrono::Utc::now().timestamp_millis()),
                ..UsageHistoryScanStatus::default()
            };
        });
        on_progress(&self.scan_status());

        let roots = self.roots.clone().unwrap_or_else(default_sources);
        let files = scanner::discover_source_files(&roots);
        self.update_status(|status| status.files_total = files.len());
        on_progress(&self.scan_status());

        let mut files_parsed = 0usize;
        let mut files_skipped = 0usize;
        let mut oversized_lines = 0usize;
        let mut events = 0usize;
        for (index, file) in files.iter().enumerate() {
            let cached = match self.store.cached_file(file.provider, &file.path) {
                Ok(cached) => cached,
                Err(error) => {
                    log::warn!(
                        "Could not read usage scan cache for {}: {error}",
                        file.path.display()
                    );
                    None
                }
            };
            if let Some(state) = &cached {
                if state.size == file.size && state.modified == file.modified {
                    files_skipped += 1;
                    self.report_progress(
                        index + 1,
                        files_parsed,
                        files_skipped,
                        oversized_lines,
                        events,
                        on_progress,
                    );
                    continue;
                }
            }
            // Only an unchanged prefix may be resumed: the file must have grown
            // and the bytes before the recorded offset are re-hashed inside the
            // parser before it trusts the offset.
            let resume = cached.as_ref().filter(|state| file.size > state.size);
            match scanner::parse_source_file(file.provider, file, resume) {
                Ok(result) => {
                    match self.store.apply_file(
                        file.provider,
                        &file.path,
                        file.size,
                        file.modified,
                        &result.parsed,
                        result.replace_existing,
                    ) {
                        Ok(()) => {
                            files_parsed += 1;
                            oversized_lines += result.parsed.oversized_lines;
                            events += result.parsed.events;
                        }
                        Err(error) => log::warn!(
                            "Could not store usage history for {}: {error}",
                            file.path.display()
                        ),
                    }
                }
                Err(error) => {
                    log::warn!("Could not read usage log {}: {error}", file.path.display())
                }
            }
            self.report_progress(
                index + 1,
                files_parsed,
                files_skipped,
                oversized_lines,
                events,
                on_progress,
            );
        }

        log::debug!("Usage history scan finished with {files_parsed} file(s) parsed");
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn report_progress(
        &self,
        files_scanned: usize,
        files_parsed: usize,
        files_skipped: usize,
        oversized_lines: usize,
        events: usize,
        on_progress: &dyn Fn(&UsageHistoryScanStatus),
    ) {
        let total = self.scan_status().files_total;
        if files_scanned % PROGRESS_FILE_STEP != 0 && files_scanned != total {
            return;
        }
        self.update_status(|status| {
            status.files_scanned = files_scanned;
            status.files_parsed = files_parsed;
            status.files_skipped = files_skipped;
            status.oversized_lines = oversized_lines;
            status.events = events;
        });
        on_progress(&self.scan_status());
    }

    /// Reads the persisted daily aggregate for one provider and settles the
    /// today/week/month periods from it. `now` is injected so tests can pin the
    /// local settlement windows.
    pub fn history_for_provider(&self, provider: &str, now: DateTime<Local>) -> UsageHistory {
        let Some(label) = history_provider_label(provider) else {
            return unknown_history("No local session log reader is available for this provider");
        };
        let today = now.date_naive();
        let week_start = week_start_for(today);
        let month_start = month_start_for(today);
        let start_day = week_start.min(month_start).format("%Y-%m-%d").to_string();
        let end_day = today.format("%Y-%m-%d").to_string();

        let rows = match self.store.provider_rows(provider, &start_day, &end_day) {
            Ok(rows) => rows,
            Err(error) => {
                log::warn!("Usage history query failed for {provider}: {error}");
                return unknown_history("Local usage history could not be read");
            }
        };
        let has_history = match self.store.provider_has_rows(provider) {
            Ok(has_history) => has_history,
            Err(error) => {
                log::warn!("Usage history query failed for {provider}: {error}");
                return unknown_history("Local usage history could not be read");
            }
        };
        if !has_history {
            return unknown_history(
                "No local session logs with token usage have been aggregated yet",
            );
        }

        let file_count = self.store.provider_file_count(provider).unwrap_or(0);
        let request_total = self.store.provider_request_total(provider).unwrap_or(0);
        let periods = [
            ("today", today, today),
            ("week", week_start, today),
            ("month", month_start, today),
        ]
        .into_iter()
        .map(|(id, start, end)| self.build_period(id, start, end, &rows))
        .collect();

        UsageHistory {
            available: true,
            source: Some(format!("{label} local session logs")),
            detail: format!("Aggregated from {file_count} local session log(s)"),
            sessions_scanned: Some(file_count),
            token_events: Some(request_total as usize),
            pricing_effective_date: self.pricing.effective_date().map(ToString::to_string),
            periods,
        }
    }

    fn build_period(
        &self,
        id: &str,
        start: NaiveDate,
        end: NaiveDate,
        rows: &[(String, String, TokenCounts)],
    ) -> UsagePeriod {
        let start_key = start.format("%Y-%m-%d").to_string();
        let end_key = end.format("%Y-%m-%d").to_string();
        let mut totals = TokenCounts::default();
        let mut models: BTreeMap<String, TokenCounts> = BTreeMap::new();
        for (day, model, counts) in rows {
            if day < &start_key || day > &end_key {
                continue;
            }
            add_counts(&mut totals, counts);
            add_counts(models.entry(model.clone()).or_default(), counts);
        }

        let mut model_periods = Vec::with_capacity(models.len());
        let mut unpriced_models = Vec::new();
        let mut priced_cost = 0.0f64;
        let mut priced_any = false;
        let mut all_verified = true;
        for (model, counts) in models {
            match self.pricing.estimate(
                &model,
                counts.input,
                counts.output,
                counts.cache_read,
                counts.cache_create,
            ) {
                Some(estimate) => {
                    priced_any = true;
                    priced_cost += estimate.amount;
                    all_verified &= estimate.verified;
                    model_periods.push(UsageModelPeriod {
                        model,
                        tokens: tokens_from(counts),
                        requests: counts.requests,
                        cost: Some(UsageCost {
                            amount: estimate.amount,
                            currency: estimate.currency,
                            effective_date: estimate.effective_date,
                            verified: estimate.verified,
                            complete: true,
                        }),
                    });
                }
                None => {
                    unpriced_models.push(model.clone());
                    model_periods.push(UsageModelPeriod {
                        model,
                        tokens: tokens_from(counts),
                        requests: counts.requests,
                        cost: None,
                    });
                }
            }
        }
        model_periods.sort_by(|left, right| {
            token_total(&right.tokens)
                .cmp(&token_total(&left.tokens))
                .then_with(|| left.model.cmp(&right.model))
        });

        let cost = if priced_any {
            Some(UsageCost {
                amount: priced_cost,
                currency: self.pricing.currency().to_string(),
                effective_date: self.pricing.effective_date().map(ToString::to_string),
                verified: all_verified,
                complete: unpriced_models.is_empty(),
            })
        } else if unpriced_models.is_empty() {
            // A period with no usage at all is a known zero, not Unknown.
            Some(UsageCost {
                amount: 0.0,
                currency: self.pricing.currency().to_string(),
                effective_date: self.pricing.effective_date().map(ToString::to_string),
                verified: true,
                complete: true,
            })
        } else {
            None
        };

        UsagePeriod {
            id: id.to_string(),
            tokens: Some(tokens_from(totals)),
            requests: Some(totals.requests),
            cost,
            models: model_periods,
            unpriced_models,
        }
    }
}

fn add_counts(target: &mut TokenCounts, source: &TokenCounts) {
    target.input += source.input;
    target.output += source.output;
    target.cache_read += source.cache_read;
    target.cache_create += source.cache_create;
    target.requests += source.requests;
}

fn tokens_from(counts: TokenCounts) -> UsageTokens {
    UsageTokens {
        input: counts.input,
        output: counts.output,
        cache_read: counts.cache_read,
        cache_create: counts.cache_create,
    }
}

fn token_total(tokens: &UsageTokens) -> u64 {
    tokens.input + tokens.output + tokens.cache_read + tokens.cache_create
}

/// Monday of the local calendar week containing `today` (the local convention
/// used for the weekly settlement).
pub(crate) fn week_start_for(today: NaiveDate) -> NaiveDate {
    today - Duration::days(today.weekday().num_days_from_monday() as i64)
}

pub(crate) fn month_start_for(today: NaiveDate) -> NaiveDate {
    NaiveDate::from_ymd_opt(today.year(), today.month(), 1).unwrap_or(today)
}

// ── Global handle + Tauri commands ───────────────────────────────────────

static SERVICE: OnceLock<Arc<UsageHistoryService>> = OnceLock::new();

/// Registers the process-wide service. Called once from app setup.
pub fn init(app: &tauri::AppHandle) -> Arc<UsageHistoryService> {
    let service = Arc::new(UsageHistoryService::from_app(app));
    let _ = SERVICE.set(Arc::clone(&service));
    SERVICE.get().cloned().unwrap_or(service)
}

pub fn global() -> Option<Arc<UsageHistoryService>> {
    SERVICE.get().cloned()
}

/// Effective date of the built-in price table, surfaced to the Usage page even
/// before any local usage has been aggregated.
pub fn global_pricing_effective_date() -> Option<String> {
    global().and_then(|service| service.pricing_effective_date().map(ToString::to_string))
}

/// History for the provider readers in [`super::codex`] and
/// [`super::claude`]. Falls back to Unknown when the app is not running (for
/// example in unit tests), never to fabricated zeros.
pub(crate) fn provider_history(provider: &str) -> UsageHistory {
    match global() {
        Some(service) => service.history_for_provider(provider, Local::now()),
        None => unknown_history("Usage history scanner is not running"),
    }
}

#[tauri::command]
pub fn start_usage_history_scan(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Emitter;
    let service =
        global().ok_or_else(|| "Usage history service is not initialized yet".to_string())?;
    let handle = app.clone();
    service.start_scan(move |status| {
        let _ = handle.emit(USAGE_HISTORY_SCAN_EVENT, status);
    });
    Ok(())
}

#[tauri::command]
pub fn get_usage_history_scan_status() -> UsageHistoryScanStatus {
    global()
        .map(|service| service.scan_status())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Utc};
    use std::io::Write;

    const COST_TEST_BYTES: u64 = 150 * 1024 * 1024;
    const PROBE_ENV: &str = "VIBEBOARD_USAGE_HISTORY_LARGE_PROBE";

    struct Fixture {
        root: PathBuf,
        store_path: PathBuf,
    }

    impl Fixture {
        fn new(label: &str) -> Self {
            let root = std::env::temp_dir().join(format!(
                "vibeboard-usage-history-{label}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .expect("system time")
                    .as_nanos()
            ));
            std::fs::create_dir_all(&root).expect("create fixture root");
            Self {
                store_path: root.join("state").join(USAGE_HISTORY_DB_FILE),
                root,
            }
        }

        fn service(&self, provider: &'static str, dir: &str) -> UsageHistoryService {
            UsageHistoryService::with_roots(
                self.store_path.clone(),
                vec![SourceRoot {
                    provider,
                    root: self.root.join(dir),
                }],
                PriceTable::load(&[]),
            )
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn local_noon(day: NaiveDate) -> DateTime<Utc> {
        Local
            .with_ymd_and_hms(day.year(), day.month(), day.day(), 12, 0, 0)
            .single()
            .expect("unambiguous local noon")
            .with_timezone(&chrono::Utc)
    }

    fn codex_event_line(
        timestamp: DateTime<chrono::Utc>,
        model: &str,
        input: u64,
        cached: u64,
        output: u64,
    ) -> String {
        let timestamp = timestamp.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let context = serde_json::json!({
            "type": "turn_context",
            "timestamp": timestamp,
            "payload": { "model": model },
        });
        let event = serde_json::json!({
            "type": "event_msg",
            "timestamp": timestamp,
            "payload": {
                "type": "token_count",
                "info": {
                    "total_token_usage": {
                        "input_tokens": input,
                        "cached_input_tokens": cached,
                        "output_tokens": output,
                    }
                }
            }
        });
        format!("{context}\n{event}\n")
    }

    fn claude_event_line(
        timestamp: DateTime<chrono::Utc>,
        model: &str,
        message_id: &str,
        input: u64,
        cached: u64,
        output: u64,
    ) -> String {
        let timestamp = timestamp.to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let event = serde_json::json!({
            "type": "assistant",
            "message": {
                "id": message_id,
                "model": model,
                "usage": {
                    "input_tokens": input,
                    "cache_read_input_tokens": cached,
                    "output_tokens": output,
                }
            },
            "timestamp": timestamp,
        });
        format!("{event}\n")
    }

    fn scan(service: &UsageHistoryService) {
        service.run_scan(&|_| {}).expect("scan");
    }

    fn total_tokens(period: &UsagePeriod) -> u64 {
        period.tokens.as_ref().map(token_total).unwrap_or_default()
    }

    #[test]
    fn unchanged_files_are_not_reparsed_and_are_not_counted_twice() {
        let fixture = Fixture::new("incremental");
        let sessions = fixture.root.join("sessions");
        std::fs::create_dir_all(&sessions).expect("create sessions");
        let day = Local::now().date_naive();
        std::fs::write(
            sessions.join("rollout-a.jsonl"),
            codex_event_line(local_noon(day), "gpt-5-codex", 1_000, 200, 100),
        )
        .expect("write log");
        let service = fixture.service("codex", "sessions");

        scan(&service);
        let first = service.scan_status();
        assert_eq!(first.files_total, 1);
        assert_eq!(first.files_parsed, 1);
        assert_eq!(first.files_skipped, 0);
        let first_history = service.history_for_provider("codex", Local::now());
        let first_today = total_tokens(
            first_history
                .periods
                .iter()
                .find(|period| period.id == "today")
                .expect("today period"),
        );

        scan(&service);
        let second = service.scan_status();
        assert_eq!(
            second.files_parsed, 0,
            "unchanged file must not be reparsed"
        );
        assert_eq!(second.files_skipped, 1);
        let second_history = service.history_for_provider("codex", Local::now());
        let second_today = total_tokens(
            second_history
                .periods
                .iter()
                .find(|period| period.id == "today")
                .expect("today period"),
        );
        assert_eq!(first_today, second_today, "rescan must not double count");
        assert_eq!(second_today, 1_100);
        assert_eq!(second_history.periods[0].requests, Some(1));
        assert_eq!(
            second_history.source.as_deref(),
            Some("Codex local session logs")
        );
        assert!(
            !second_history
                .source
                .unwrap_or_default()
                .contains(fixture.root.to_str().unwrap_or_default()),
            "the source label must not expose the user's absolute log path"
        );
    }

    #[test]
    fn appended_logs_resume_from_the_last_offset() {
        let fixture = Fixture::new("resume");
        let sessions = fixture.root.join("sessions");
        std::fs::create_dir_all(&sessions).expect("create sessions");
        let path = sessions.join("rollout-resume.jsonl");
        let day = Local::now().date_naive();
        std::fs::write(
            &path,
            codex_event_line(local_noon(day), "gpt-5-codex", 1_000, 0, 100),
        )
        .expect("write first chunk");
        let service = fixture.service("codex", "sessions");

        scan(&service);
        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .expect("open log")
            .write_all(codex_event_line(local_noon(day), "gpt-5-codex", 1_400, 0, 140).as_bytes())
            .expect("append log");
        scan(&service);

        let history = service.history_for_provider("codex", Local::now());
        let today = history
            .periods
            .iter()
            .find(|period| period.id == "today")
            .expect("today period");
        assert_eq!(total_tokens(today), 1_100 + 440);
        assert_eq!(today.requests, Some(2));
    }

    #[test]
    fn week_and_month_settlement_matches_direct_event_totals() {
        let fixture = Fixture::new("settlement");
        let projects = fixture.root.join("projects");
        let project = projects.join("demo");
        std::fs::create_dir_all(&project).expect("create project dir");
        let today = Local::now().date_naive();
        let week_start = week_start_for(today);
        let month_start = month_start_for(today);
        let days = [
            today,
            week_start,
            week_start - Duration::days(1),
            month_start - Duration::days(1),
        ];
        let mut content = String::new();
        for (index, day) in days.iter().enumerate() {
            content.push_str(&claude_event_line(
                local_noon(*day),
                "claude-sonnet-4-5",
                &format!("msg-{index}"),
                1_000 * (index as u64 + 1),
                0,
                100,
            ));
        }
        std::fs::write(project.join("session.jsonl"), &content).expect("write transcript");
        let service = fixture.service("claude-code", "projects");

        scan(&service);
        let history = service.history_for_provider("claude-code", Local::now());
        let period = |id: &str| {
            history
                .periods
                .iter()
                .find(|period| period.id == id)
                .expect("period")
        };
        // Direct event-level aggregation over the same local days, independent
        // of the persisted daily rows the service sums.
        let direct = |start: NaiveDate, end: NaiveDate| -> u64 {
            days.iter()
                .enumerate()
                .filter(|(_, day)| **day >= start && **day <= end)
                .map(|(index, _)| 1_000 * (index as u64 + 1) + 100)
                .sum()
        };
        assert_eq!(total_tokens(period("today")), direct(today, today));
        assert_eq!(
            total_tokens(period("week")),
            direct(week_start, today),
            "week starts on Monday"
        );
        assert_eq!(
            total_tokens(period("month")),
            direct(month_start, today),
            "month uses the local calendar month"
        );
        let before_week = direct(month_start, week_start - Duration::days(1));
        assert_eq!(
            total_tokens(period("month")),
            total_tokens(period("week")) + before_week,
            "month is the daily sums of its weeks"
        );
        assert_eq!(
            history.pricing_effective_date.as_deref(),
            Some("2026-09-22")
        );
    }

    #[test]
    fn deleting_source_logs_keeps_the_persisted_history() {
        let fixture = Fixture::new("deleted");
        let sessions = fixture.root.join("sessions");
        std::fs::create_dir_all(&sessions).expect("create sessions");
        let day = Local::now().date_naive();
        let path = sessions.join("rollout-deleted.jsonl");
        std::fs::write(
            &path,
            codex_event_line(local_noon(day), "gpt-5-codex", 900, 0, 90),
        )
        .expect("write log");
        let service = fixture.service("codex", "sessions");
        scan(&service);
        let before = total_tokens(
            service
                .history_for_provider("codex", Local::now())
                .periods
                .iter()
                .find(|period| period.id == "today")
                .expect("today period"),
        );
        assert_eq!(before, 990);

        std::fs::remove_file(&path).expect("delete log");
        scan(&service);

        let history = service.history_for_provider("codex", Local::now());
        assert!(history.available);
        let after = total_tokens(
            history
                .periods
                .iter()
                .find(|period| period.id == "today")
                .expect("today period"),
        );
        assert_eq!(after, 990, "aggregated history must survive log deletion");
    }

    #[test]
    fn claude_responses_copied_into_resumed_session_logs_count_once() {
        let fixture = Fixture::new("claude-resume");
        let projects = fixture.root.join("projects").join("demo");
        std::fs::create_dir_all(&projects).expect("create projects");
        let ts = local_noon(Local::now().date_naive())
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let line = |id: &str, output: u64| {
            serde_json::json!({
                "type": "assistant",
                "timestamp": ts,
                "message": {
                    "id": id,
                    "model": "claude-opus-5",
                    "usage": { "input_tokens": 10, "output_tokens": output }
                }
            })
            .to_string()
        };
        // The original session, then a resumed session whose log repeats the
        // earlier response (msg-a, written twice as two content blocks) before
        // adding a new one (msg-b).
        std::fs::write(
            projects.join("original.jsonl"),
            format!("{}\n{}\n", line("msg-a", 5), line("msg-a", 5)),
        )
        .expect("write original");
        std::fs::write(
            projects.join("resumed.jsonl"),
            format!("{}\n{}\n", line("msg-a", 5), line("msg-b", 7)),
        )
        .expect("write resumed");

        let service = fixture.service("claude-code", "projects");
        scan(&service);
        let today = |service: &UsageHistoryService| {
            let history = service.history_for_provider("claude-code", Local::now());
            let period = history
                .periods
                .iter()
                .find(|period| period.id == "today")
                .cloned()
                .expect("today period");
            (total_tokens(&period), period.requests)
        };
        assert_eq!(today(&service), (10 + 5 + 10 + 7, Some(2)));

        // Rescanning, or rewriting one file, must not count msg-a again.
        std::fs::write(
            projects.join("resumed.jsonl"),
            format!(
                "{}\n{}\n{}\n",
                line("msg-a", 5),
                line("msg-b", 7),
                line("msg-c", 1)
            ),
        )
        .expect("append resumed");
        scan(&service);
        assert_eq!(today(&service), (10 + 5 + 10 + 7 + 10 + 1, Some(3)));
    }

    #[test]
    fn unknown_models_show_unknown_cost_and_are_named() {
        let fixture = Fixture::new("unknown-model");
        let sessions = fixture.root.join("sessions");
        std::fs::create_dir_all(&sessions).expect("create sessions");
        let day = Local::now().date_naive();
        std::fs::write(
            sessions.join("rollout-mixed.jsonl"),
            format!(
                "{}{}",
                codex_event_line(local_noon(day), "gpt-5-codex", 1_000_000, 0, 100_000),
                codex_event_line(
                    local_noon(day),
                    "gpt-5.2-codex-unreleased",
                    1_000_500,
                    0,
                    100_050
                ),
            ),
        )
        .expect("write log");
        let service = fixture.service("codex", "sessions");
        scan(&service);

        let history = service.history_for_provider("codex", Local::now());
        let today = history
            .periods
            .iter()
            .find(|period| period.id == "today")
            .expect("today period");
        assert_eq!(
            today.unpriced_models,
            vec!["gpt-5.2-codex-unreleased".to_string()]
        );
        let unknown = today
            .models
            .iter()
            .find(|model| model.model == "gpt-5.2-codex-unreleased")
            .expect("unpriced model row");
        assert!(unknown.cost.is_none(), "unpriced models must be Unknown");
        let known = today
            .models
            .iter()
            .find(|model| model.model == "gpt-5-codex")
            .expect("priced model row");
        let known_cost = known.cost.as_ref().expect("priced cost");
        assert!(
            known_cost.complete,
            "a priced model's own estimate is complete"
        );
        let total_cost = today.cost.as_ref().expect("partial estimate");
        assert!(!total_cost.complete);
        // gpt-5-codex: 1M input at 1.25 + 0.1M output at 10.0
        assert!((total_cost.amount - (1.25 + 1.0)).abs() < 1e-9);
        assert!(!total_cost.verified);
    }

    #[test]
    fn period_without_usage_reports_zero_not_unknown() {
        let fixture = Fixture::new("empty-period");
        let sessions = fixture.root.join("sessions");
        std::fs::create_dir_all(&sessions).expect("create sessions");
        let old_day = Local::now().date_naive() - Duration::days(2);
        std::fs::write(
            sessions.join("rollout-old.jsonl"),
            codex_event_line(local_noon(old_day), "gpt-5-codex", 100, 0, 10),
        )
        .expect("write log");
        let service = fixture.service("codex", "sessions");
        scan(&service);

        let history = service.history_for_provider("codex", Local::now());
        assert!(history.available);
        let today = history
            .periods
            .iter()
            .find(|period| period.id == "today")
            .expect("today period");
        assert_eq!(total_tokens(today), 0);
        let cost = today.cost.as_ref().expect("known zero cost");
        assert_eq!(cost.amount, 0.0);
        assert!(cost.complete);
    }

    #[test]
    fn history_is_unknown_before_any_scan() {
        let fixture = Fixture::new("no-scan");
        let service = fixture.service("codex", "sessions");
        let history = service.history_for_provider("codex", Local::now());
        assert!(!history.available);
        assert!(history.periods.iter().all(|period| period.tokens.is_none()));
    }

    #[test]
    fn providers_without_a_log_reader_report_unknown() {
        let fixture = Fixture::new("unknown-provider");
        let service = fixture.service("codex", "sessions");
        let history = service.history_for_provider("opencode", Local::now());
        assert!(!history.available);
    }

    #[test]
    fn week_start_is_monday() {
        let monday = NaiveDate::from_ymd_opt(2026, 9, 21).expect("valid date");
        assert_eq!(monday.weekday(), chrono::Weekday::Mon);
        assert_eq!(week_start_for(monday), monday);
        assert_eq!(
            week_start_for(NaiveDate::from_ymd_opt(2026, 9, 27).expect("valid date")),
            monday
        );
        assert_eq!(
            month_start_for(monday),
            NaiveDate::from_ymd_opt(2026, 9, 1).unwrap()
        );
    }

    // ── Large-log memory probe ────────────────────────────────────────────

    /// Writes a synthetic log of at least 150 MB (one oversized line included),
    /// scans it, and prints the process peak working set plus the aggregated
    /// input total. Runs in a child process started by
    /// `large_log_scan_stays_within_the_memory_bound` so the measurement is not
    /// polluted by other tests sharing the harness process.
    #[test]
    fn large_log_scan_memory_probe() {
        if std::env::var_os(PROBE_ENV).is_none() {
            return;
        }
        let fixture = Fixture::new("large-probe");
        let sessions = fixture.root.join("sessions");
        std::fs::create_dir_all(&sessions).expect("create sessions");
        let path = sessions.join("rollout-large.jsonl");
        let day = Local::now().date_naive();
        let timestamp = local_noon(day).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        // Long thin lines like a real rollout with embedded context. Each event
        // advances the cumulative session total by 317 fresh input / 11 output.
        let pad = "x".repeat(900);
        let mut events = 0u64;
        let mut written = 0u64;
        {
            let handle = std::fs::File::create(&path).expect("create large log");
            let mut writer = std::io::BufWriter::with_capacity(1 << 20, handle);
            while written < COST_TEST_BYTES {
                if events == 1_000 {
                    writer
                        .write_all(&vec![b'x'; scanner::MAX_LOG_LINE_BYTES + 32])
                        .expect("write oversized line");
                    writer.write_all(b"\n").expect("terminate oversized line");
                }
                let input = 317 * (events + 1);
                let output = 11 * (events + 1);
                let mut line = serde_json::json!({
                    "type": "event_msg",
                    "timestamp": timestamp,
                    "payload": {
                        "type": "token_count",
                        "pad": pad.as_str(),
                        "info": {
                            "total_token_usage": {
                                "input_tokens": input,
                                "cached_input_tokens": 0,
                                "output_tokens": output,
                            }
                        }
                    }
                })
                .to_string();
                line.push('\n');
                writer.write_all(line.as_bytes()).expect("write event");
                written += line.len() as u64;
                events += 1;
            }
            writer.flush().expect("flush large log");
        }
        let size = std::fs::metadata(&path).expect("metadata").len();
        assert!(
            size >= COST_TEST_BYTES,
            "synthetic log must be at least 150 MB, got {size}"
        );

        let service = fixture.service("codex", "sessions");
        scan(&service);
        let history = service.history_for_provider("codex", Local::now());
        let today = history
            .periods
            .iter()
            .find(|period| period.id == "today")
            .expect("today period");
        assert_eq!(today.requests, Some(events));
        assert_eq!(total_tokens(today), 328 * events);
        let status = service.scan_status();
        assert_eq!(status.oversized_lines, 1);
        let peak = process_peak_working_set_bytes().unwrap_or(0);
        println!("VIBEBOARD_USAGE_HISTORY_PEAK_BYTES={peak}");
        println!("VIBEBOARD_USAGE_HISTORY_LOG_BYTES={size}");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn large_log_scan_stays_within_the_memory_bound() {
        // The child process only runs the probe test.
        if std::env::var_os(PROBE_ENV).is_some() {
            return;
        }
        let Some(executable) = std::env::current_exe().ok() else {
            return;
        };
        let output = std::process::Command::new(executable)
            .args([
                "--exact",
                "usage::history::tests::large_log_scan_memory_probe",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(PROBE_ENV, "1")
            .output()
            .expect("run the memory probe child process");
        assert!(
            output.status.success(),
            "probe failed:\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        let stdout = String::from_utf8_lossy(&output.stdout);
        // The harness writes `test <name> ... ` without a newline before the
        // first captured print, so the marker is found anywhere in a line.
        let marker = |prefix: &str| {
            stdout
                .lines()
                .find_map(|line| line.split(prefix).nth(1))
                .and_then(|value| value.trim().parse::<u64>().ok())
        };
        let peak = marker("VIBEBOARD_USAGE_HISTORY_PEAK_BYTES=").filter(|value| *value > 0);
        let log_bytes = marker("VIBEBOARD_USAGE_HISTORY_LOG_BYTES=").unwrap_or_default();
        println!("usage history large-scan probe: {log_bytes} bytes, peak {peak:?} bytes");
        if let Some(peak) = peak {
            assert!(
                peak <= LARGE_SCAN_MEMORY_BOUND_BYTES,
                "scanning a {log_bytes} byte log peaked at {peak} bytes, above the {LARGE_SCAN_MEMORY_BOUND_BYTES} byte bound"
            );
        }
        assert!(log_bytes >= COST_TEST_BYTES);
    }

    #[cfg(target_os = "windows")]
    fn process_peak_working_set_bytes() -> Option<u64> {
        use windows_sys::Win32::System::ProcessStatus::{
            GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS,
        };
        use windows_sys::Win32::System::Threading::GetCurrentProcess;
        let mut counters = PROCESS_MEMORY_COUNTERS::default();
        counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
        let ok = unsafe { GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, counters.cb) };
        (ok != 0).then_some(counters.PeakWorkingSetSize as u64)
    }

    #[cfg(target_os = "linux")]
    fn process_peak_working_set_bytes() -> Option<u64> {
        let status = std::fs::read_to_string("/proc/self/status").ok()?;
        status.lines().find_map(|line| {
            line.strip_prefix("VmHWM:")
                .and_then(|value| value.split_whitespace().next())
                .and_then(|kilobytes| kilobytes.parse::<u64>().ok())
                .map(|kilobytes| kilobytes * 1024)
        })
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux")))]
    fn process_peak_working_set_bytes() -> Option<u64> {
        None
    }
}
