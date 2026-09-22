// Codex usage provider: account quota (app-server bridge → stdio → local
// rollout JSONL) plus token aggregation from local session logs.

use super::normalize::{
    date_from_value, number_field, positive_window_minutes, provider_rate_limits,
    usage_snapshot_within_age, UsageRateLimitSnapshot,
};
use super::{
    build_snapshot, resolve_state, UsageAuthStatus, UsageCredential, UsageFetch, UsageHistory,
    UsagePeriod, UsageProvider, UsageSnapshot, UsageTokens,
};
use crate::hooks::session_store::RateLimitInfo;
use futures_util::future::BoxFuture;
use futures_util::FutureExt;
use std::fs;
use std::io::{BufRead, BufReader as StdBufReader};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader as TokioBufReader};
use tokio::process::ChildStdin;
use tokio::sync::Mutex as TokioMutex;

const CODEX_USAGE_LIVE_CACHE_TTL: Duration = Duration::from_secs(300);
const CODEX_USAGE_LIVE_FAILURE_TTL: Duration = Duration::from_secs(60);
const CODEX_DAYS7_SECONDS: i64 = 7 * 86_400;
const CODEX_DAYS30_SECONDS: i64 = 30 * 86_400;
/// Stable, path-free label for the token usage data source so the UI never
/// exposes the user's absolute sessions directory.
const CODEX_TOKEN_SOURCE_LABEL: &str = "Codex local session logs";

pub struct CodexUsageProvider;

impl UsageProvider for CodexUsageProvider {
    fn id(&self) -> &'static str {
        "codex"
    }

    fn label(&self) -> &'static str {
        "Codex"
    }

    fn implementation_status(&self) -> &'static str {
        "active"
    }

    fn settings_order(&self) -> Option<u32> {
        Some(0)
    }

    fn authorize_command(&self) -> Option<(&'static str, &'static [&'static str])> {
        Some(("codex", &["login"]))
    }

    fn read_credentials(&self) -> UsageCredential {
        let path = dirs::home_dir().map(|home| home.join(".codex").join("auth.json"));
        let exists = path.as_ref().is_some_and(|path| path.exists());
        UsageCredential {
            status: if exists {
                UsageAuthStatus::Authorized
            } else {
                UsageAuthStatus::Missing
            },
            path: path.map(|path| path.display().to_string()),
            can_authorize: crate::commands::find_binary("codex").is_some(),
        }
    }

    fn fetch<'a>(&'a self, live: bool) -> BoxFuture<'a, UsageFetch> {
        async move {
            let (quota, error) = load_codex_quota(live).await;
            let detail = if let Some(snapshot) = &quota {
                let updated = snapshot
                    .captured_at
                    .map(|date| format!(" updated {}", date.format("%H:%M:%S")))
                    .unwrap_or_default();
                format!("Codex account rate limits found.{updated}")
            } else if let Some(error) = &error {
                format!("Codex account quota request failed: {error}")
            } else if codex_auth_configured() {
                "Codex auth found, waiting for account quota data.".to_string()
            } else {
                "No Codex auth or account quota data found.".to_string()
            };

            UsageFetch {
                rate_limits: quota.map(|snapshot| snapshot.rate_limits),
                history: load_codex_token_usage_history(),
                detail,
                error,
                ..UsageFetch::default()
            }
        }
        .boxed()
    }

    fn normalize(
        &self,
        enabled: bool,
        credentials: UsageCredential,
        fetched: UsageFetch,
    ) -> UsageSnapshot {
        let state = resolve_state(self, enabled, &credentials, &fetched);
        let detail = fetched.detail.clone();
        build_snapshot(self, enabled, &credentials, &fetched, state, detail)
    }
}

/// Legacy shape used by the island and agent status commands.
pub(crate) async fn load_rate_limits(live: bool) -> Option<RateLimitInfo> {
    load_codex_quota(live)
        .await
        .0
        .map(|snapshot| snapshot.rate_limits)
}

fn codex_auth_configured() -> bool {
    dirs::home_dir()
        .map(|home| home.join(".codex").join("auth.json"))
        .is_some_and(|path| path.exists())
}

async fn load_codex_quota(live: bool) -> (Option<UsageRateLimitSnapshot>, Option<String>) {
    if !live {
        return (load_codex_usage_rate_limits_from_jsonl(), None);
    }

    let (live_snapshot, error) = load_codex_usage_rate_limits_live_cached_with_error().await;
    if live_snapshot.is_some() {
        return (live_snapshot, None);
    }
    match load_codex_usage_rate_limits_from_jsonl() {
        Some(snapshot) => (Some(snapshot), None),
        None => (None, error),
    }
}

#[derive(Default)]
struct CodexUsageLiveCache {
    fetched_at: Option<Instant>,
    snapshot: Option<UsageRateLimitSnapshot>,
    error: Option<String>,
}

async fn load_codex_usage_rate_limits_live_cached_with_error(
) -> (Option<UsageRateLimitSnapshot>, Option<String>) {
    static CACHE: OnceLock<TokioMutex<CodexUsageLiveCache>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| TokioMutex::new(CodexUsageLiveCache::default()));
    let mut guard = cache.lock().await;

    if let Some(fetched_at) = guard.fetched_at {
        let ttl = if guard.snapshot.is_some() {
            CODEX_USAGE_LIVE_CACHE_TTL
        } else {
            CODEX_USAGE_LIVE_FAILURE_TTL
        };
        if fetched_at.elapsed() < ttl {
            return (guard.snapshot.clone(), guard.error.clone());
        }
    }

    let (snapshot, error) = load_codex_usage_rate_limits_live_uncached().await;
    guard.fetched_at = Some(Instant::now());
    guard.snapshot = snapshot.clone();
    guard.error = error.clone();
    (snapshot, error)
}

async fn load_codex_usage_rate_limits_live_uncached(
) -> (Option<UsageRateLimitSnapshot>, Option<String>) {
    // Prefer the persistent app-server WebSocket bridge when it's attached —
    // sidesteps a redundant stdio spawn on every rate-limit poll.
    let mut live_error: Option<String> = None;
    if let Some(bridge) = crate::commands::global_codex_app_server_bridge() {
        match bridge.fetch_rate_limits().await {
            Ok(Some(response)) => {
                if let Some(snapshot) = codex_usage_snapshot_from_rpc_message(&response) {
                    return (Some(snapshot), None);
                }
                // bridge responded but payload wasn't parseable — fall through
                // to stdio fallback rather than silently giving up.
            }
            Ok(None) => {
                // bridge not attached; fall through
            }
            Err(err) => {
                log::debug!("Codex app-server bridge rate-limit fetch failed: {err}");
                live_error = Some(err);
            }
        }
    }

    let Some(binary) = crate::commands::find_binary("codex") else {
        return (None, live_error);
    };
    (codex_rate_limits_via_stdio(&binary).await, live_error)
}

async fn codex_rate_limits_via_stdio(binary: &str) -> Option<UsageRateLimitSnapshot> {
    let mut child = crate::platform::process::background_tokio_command(binary)
        .args(["-s", "read-only", "-a", "untrusted", "app-server"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    let mut stdin = child.stdin.take()?;
    let stdout = child.stdout.take()?;
    let mut lines = TokioBufReader::new(stdout).lines();

    let result = tokio::time::timeout(Duration::from_secs(8), async {
        write_json_rpc(
            &mut stdin,
            serde_json::json!({
                "id": 1,
                "method": "initialize",
                "params": {
                    "clientInfo": {
                        "name": "Vibe Board",
                        "version": env!("CARGO_PKG_VERSION")
                    }
                }
            }),
        )
        .await?;
        read_json_rpc_response(&mut lines, 1).await?;

        write_json_rpc(
            &mut stdin,
            serde_json::json!({
                "method": "initialized",
                "params": {}
            }),
        )
        .await?;

        write_json_rpc(
            &mut stdin,
            serde_json::json!({
                "id": 2,
                "method": "account/rateLimits/read",
                "params": {}
            }),
        )
        .await?;
        let response = read_json_rpc_response(&mut lines, 2).await?;
        codex_usage_snapshot_from_rpc_message(&response)
    })
    .await
    .ok()
    .flatten();

    if child.try_wait().ok().flatten().is_none() {
        let _ = child.start_kill();
        let _ = child.wait().await;
    }

    result
}

async fn write_json_rpc(stdin: &mut ChildStdin, payload: serde_json::Value) -> Option<()> {
    let mut line = serde_json::to_vec(&payload).ok()?;
    line.push(b'\n');
    stdin.write_all(&line).await.ok()?;
    stdin.flush().await.ok()?;
    Some(())
}

async fn read_json_rpc_response(
    lines: &mut tokio::io::Lines<TokioBufReader<tokio::process::ChildStdout>>,
    expected_id: i64,
) -> Option<serde_json::Value> {
    while let Some(line) = lines.next_line().await.ok()? {
        let value: serde_json::Value = serde_json::from_str(&line).ok()?;
        if value.get("id").and_then(|id| id.as_i64()) != Some(expected_id) {
            continue;
        }
        if value.get("error").is_some() {
            return None;
        }
        return Some(value);
    }
    None
}

fn codex_usage_snapshot_from_rpc_message(
    message: &serde_json::Value,
) -> Option<UsageRateLimitSnapshot> {
    let rate_limits = message
        .get("result")?
        .get("rateLimits")
        .or_else(|| message.get("result")?.get("rate_limits"))?;
    let (five_hour, seven_day) = codex_window_pair(rate_limits)?;
    let captured_at = Some(chrono::Utc::now());

    Some(UsageRateLimitSnapshot {
        rate_limits: provider_rate_limits(
            "codex",
            "Codex",
            "codex-cli",
            captured_at,
            five_hour,
            seven_day,
        )?,
        captured_at,
    })
}

fn load_codex_usage_rate_limits_from_jsonl() -> Option<UsageRateLimitSnapshot> {
    let root = dirs::home_dir()?.join(".codex").join("sessions");
    let mut candidates = Vec::new();
    collect_codex_rollout_files(&root, &mut candidates);
    candidates.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| b.0.cmp(&a.0)));

    let mut best: Option<UsageRateLimitSnapshot> = None;
    for (path, modified_at) in candidates.into_iter().take(40) {
        let Some(snapshot) = load_codex_usage_rate_limits_from_file(&path, modified_at) else {
            continue;
        };
        if !usage_snapshot_within_age(&snapshot, chrono::Duration::hours(6)) {
            continue;
        }
        let snapshot_time = snapshot
            .captured_at
            .unwrap_or(chrono::DateTime::<chrono::Utc>::MIN_UTC);
        let best_time = best
            .as_ref()
            .and_then(|candidate| candidate.captured_at)
            .unwrap_or(chrono::DateTime::<chrono::Utc>::MIN_UTC);
        if snapshot_time >= best_time {
            best = Some(snapshot);
        }
    }
    best
}

pub(crate) fn collect_codex_rollout_files(
    root: &Path,
    candidates: &mut Vec<(PathBuf, std::time::SystemTime)>,
) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(metadata) = entry.metadata() else {
            continue;
        };

        if metadata.is_dir() {
            collect_codex_rollout_files(&path, candidates);
            continue;
        }

        let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if file_name.starts_with("rollout-")
            && path.extension().and_then(|value| value.to_str()) == Some("jsonl")
        {
            candidates.push((
                path,
                metadata
                    .modified()
                    .unwrap_or(std::time::SystemTime::UNIX_EPOCH),
            ));
        }
    }
}

fn load_codex_usage_rate_limits_from_file(
    path: &Path,
    modified_at: std::time::SystemTime,
) -> Option<UsageRateLimitSnapshot> {
    let file = fs::File::open(path).ok()?;
    let fallback_time = chrono::DateTime::<chrono::Utc>::from(modified_at);
    let mut latest: Option<UsageRateLimitSnapshot> = None;

    for line in StdBufReader::new(file).lines().map_while(Result::ok) {
        let Some(snapshot) = codex_usage_snapshot_from_line(&line, fallback_time) else {
            continue;
        };
        latest = Some(snapshot);
    }

    latest
}

fn codex_usage_snapshot_from_line(
    line: &str,
    fallback_time: chrono::DateTime<chrono::Utc>,
) -> Option<UsageRateLimitSnapshot> {
    let object: serde_json::Value = serde_json::from_str(line).ok()?;
    if object.get("type").and_then(|value| value.as_str()) != Some("event_msg") {
        return None;
    }

    let payload = object.get("payload")?;
    if payload.get("type").and_then(|value| value.as_str()) != Some("token_count") {
        return None;
    }

    let rate_limits = payload.get("rate_limits")?;
    let (five_hour, seven_day) = codex_window_pair(rate_limits)?;

    Some(UsageRateLimitSnapshot {
        rate_limits: provider_rate_limits(
            "codex",
            "Codex",
            "codex-jsonl",
            object
                .get("timestamp")
                .and_then(date_from_value)
                .or(Some(fallback_time)),
            five_hour,
            seven_day,
        )?,
        captured_at: object
            .get("timestamp")
            .and_then(date_from_value)
            .or(Some(fallback_time)),
    })
}

fn codex_window_pair(
    rate_limits: &serde_json::Value,
) -> Option<(&serde_json::Value, &serde_json::Value)> {
    let primary = rate_limits.get("primary")?;
    let secondary = rate_limits.get("secondary")?;
    let primary_minutes = positive_window_minutes(primary)?;
    let secondary_minutes = positive_window_minutes(secondary)?;
    let primary_is_long = primary_minutes >= 1_440;
    let secondary_is_long = secondary_minutes >= 1_440;

    match (primary_is_long, secondary_is_long) {
        (false, true) => Some((primary, secondary)),
        (true, false) => Some((secondary, primary)),
        _ => None,
    }
}

// ── Local token usage aggregation ────────────────────────────────────────

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct CodexTokenCounts {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_create: u64,
}

/// Per-event token usage parsed from a Codex rollout line. Current Codex
/// events carry both the real per-turn usage (`last_token_usage`) and the
/// cumulative session totals (`total_token_usage`); older formats expose only
/// one of the two.
#[derive(Debug, Clone, Copy, Default)]
struct CodexTokenCountsEvent {
    /// Real per-turn usage from `payload.info.last_token_usage`, when present.
    per_turn: Option<CodexTokenCounts>,
    /// Cumulative session totals from `payload.info.total_token_usage` (or the
    /// legacy `payload.tokens` shape), when present.
    cumulative: Option<CodexTokenCounts>,
}

#[derive(Debug, Clone, Default)]
struct CodexTokenBucket {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_create: u64,
    sessions: usize,
}

#[derive(Debug, Clone, Default)]
struct CodexTokenUsageSummary {
    today: CodexTokenBucket,
    days7: CodexTokenBucket,
    days30: CodexTokenBucket,
    source: String,
    sessions_scanned: usize,
    token_events: usize,
    available: bool,
    detail: String,
}

fn load_codex_token_usage_history() -> UsageHistory {
    token_usage_history_from_summary(&load_codex_token_usage_summary())
}

fn token_usage_history_from_summary(summary: &CodexTokenUsageSummary) -> UsageHistory {
    let period = |id: &str, bucket: &CodexTokenBucket| UsagePeriod {
        id: id.to_string(),
        tokens: summary.available.then_some(UsageTokens {
            input: bucket.input,
            output: bucket.output,
            cache_read: bucket.cache_read,
            cache_create: bucket.cache_create,
        }),
        sessions: summary.available.then_some(bucket.sessions),
    };

    UsageHistory {
        available: summary.available,
        source: Some(if summary.source.is_empty() {
            CODEX_TOKEN_SOURCE_LABEL.to_string()
        } else {
            summary.source.clone()
        }),
        detail: summary.detail.clone(),
        sessions_scanned: Some(summary.sessions_scanned),
        token_events: Some(summary.token_events),
        periods: vec![
            period("today", &summary.today),
            period("week", &summary.days7),
            period("month", &summary.days30),
        ],
    }
}

/// Aggregates Codex token usage from real session rollout files
/// (`~/.codex/sessions/**/rollout-*.jsonl`) for today, the last 7 days, and
/// the last 30 days. `token_count` events carry the real per-turn usage
/// (`last_token_usage`) alongside cumulative session totals; per-turn values
/// are used directly so usage survives cumulative resets, and events that only
/// expose cumulative totals fall back to consecutive-event deltas attributed
/// to the later event's timestamp (the first event contributes its full
/// recorded total). Duplicate snapshots that repeat an unchanged cumulative
/// total are skipped instead of double counted. Missing or unknown values are
/// reported as zeros without estimation.
fn load_codex_token_usage_summary() -> CodexTokenUsageSummary {
    let Some(home) = dirs::home_dir() else {
        return CodexTokenUsageSummary {
            detail: "Codex home directory not found".to_string(),
            ..CodexTokenUsageSummary::default()
        };
    };
    load_codex_token_usage_summary_from_root(&home.join(".codex").join("sessions"))
}

fn load_codex_token_usage_summary_from_root(root: &Path) -> CodexTokenUsageSummary {
    if !root.is_dir() {
        return CodexTokenUsageSummary {
            detail: "No Codex local sessions directory found".to_string(),
            ..CodexTokenUsageSummary::default()
        };
    }

    let mut candidates = Vec::new();
    collect_codex_rollout_files(root, &mut candidates);

    let now = chrono::Utc::now();
    let today_start = chrono::Local::now()
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .and_then(|time| time.and_local_timezone(chrono::Local).single())
        .map(|date| date.timestamp())
        .unwrap_or_else(|| now.timestamp());
    let cutoff_7d = now.timestamp() - CODEX_DAYS7_SECONDS;
    let cutoff_30d = now.timestamp() - CODEX_DAYS30_SECONDS;
    let cutoff_30d_time =
        std::time::UNIX_EPOCH + std::time::Duration::from_secs(cutoff_30d.max(0) as u64);

    let mut summary = CodexTokenUsageSummary {
        source: CODEX_TOKEN_SOURCE_LABEL.to_string(),
        ..CodexTokenUsageSummary::default()
    };
    let mut token_events = 0usize;
    let mut files_with_usage = 0usize;

    for (path, modified_at) in candidates {
        // Rollout events are chronological and the file mtime tracks the last
        // event, so files untouched before the 30-day cutoff cannot contribute
        // to any queried bucket. Skipping them avoids rescanning months of
        // irrelevant history on every refresh. Unknown mtimes (UNIX_EPOCH
        // fallback) are still read so valid event timestamps are not lost.
        if modified_at > std::time::UNIX_EPOCH && modified_at < cutoff_30d_time {
            continue;
        }
        summary.sessions_scanned += 1;
        let fallback_time = chrono::DateTime::<chrono::Utc>::from(modified_at);
        let file = match fs::File::open(&path) {
            Ok(file) => file,
            Err(_) => continue,
        };
        let mut previous_cumulative: Option<CodexTokenCounts> = None;
        let mut bucket_input = [0u64; 3];
        let mut bucket_output = [0u64; 3];
        let mut bucket_cache_read = [0u64; 3];
        let mut bucket_cache_create = [0u64; 3];
        let mut bucket_sessions = [false; 3];

        for line in StdBufReader::new(file).lines().map_while(Result::ok) {
            let Ok(object) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            let Some(event) = codex_token_counts_from_line(&object) else {
                continue;
            };
            token_events += 1;

            let timestamp = object
                .get("timestamp")
                .and_then(date_from_value)
                .unwrap_or(fallback_time)
                .timestamp();

            // Prefer the real per-turn usage from `last_token_usage` whenever
            // the cumulative session total advanced (or is missing): per-turn
            // values stay correct across cumulative resets, while duplicate
            // snapshots that repeat an unchanged total are skipped instead of
            // double counted. Events that only expose cumulative totals (older
            // formats) fall back to consecutive-event deltas; the first event
            // contributes its full recorded total.
            let cumulative_advanced = event
                .cumulative
                .as_ref()
                .is_none_or(|total| previous_cumulative.as_ref() != Some(total));
            let delta = event.per_turn.filter(|_| cumulative_advanced).or_else(|| {
                event.cumulative.as_ref().map(|total| CodexTokenCounts {
                    input: total
                        .input
                        .saturating_sub(previous_cumulative.map_or(0, |previous| previous.input)),
                    output: total
                        .output
                        .saturating_sub(previous_cumulative.map_or(0, |previous| previous.output)),
                    cache_read: total.cache_read.saturating_sub(
                        previous_cumulative.map_or(0, |previous| previous.cache_read),
                    ),
                    cache_create: total.cache_create.saturating_sub(
                        previous_cumulative.map_or(0, |previous| previous.cache_create),
                    ),
                })
            });
            if let Some(total) = event.cumulative {
                previous_cumulative = Some(total);
            }
            let Some(delta) = delta else {
                continue;
            };

            if delta.is_zero() {
                continue;
            }
            if timestamp >= today_start {
                add_bucket_delta(
                    &mut bucket_input[0],
                    &mut bucket_output[0],
                    &mut bucket_cache_read[0],
                    &mut bucket_cache_create[0],
                    &mut bucket_sessions[0],
                    delta,
                );
            }
            if timestamp >= cutoff_7d {
                add_bucket_delta(
                    &mut bucket_input[1],
                    &mut bucket_output[1],
                    &mut bucket_cache_read[1],
                    &mut bucket_cache_create[1],
                    &mut bucket_sessions[1],
                    delta,
                );
            }
            if timestamp >= cutoff_30d {
                add_bucket_delta(
                    &mut bucket_input[2],
                    &mut bucket_output[2],
                    &mut bucket_cache_read[2],
                    &mut bucket_cache_create[2],
                    &mut bucket_sessions[2],
                    delta,
                );
            }
        }

        let file_counted = bucket_sessions.iter().any(|used| *used);
        if file_counted {
            files_with_usage += 1;
        }
        summary.today.input += bucket_input[0];
        summary.today.output += bucket_output[0];
        summary.today.cache_read += bucket_cache_read[0];
        summary.today.cache_create += bucket_cache_create[0];
        summary.today.sessions += usize::from(bucket_sessions[0]);
        summary.days7.input += bucket_input[1];
        summary.days7.output += bucket_output[1];
        summary.days7.cache_read += bucket_cache_read[1];
        summary.days7.cache_create += bucket_cache_create[1];
        summary.days7.sessions += usize::from(bucket_sessions[1]);
        summary.days30.input += bucket_input[2];
        summary.days30.output += bucket_output[2];
        summary.days30.cache_read += bucket_cache_read[2];
        summary.days30.cache_create += bucket_cache_create[2];
        summary.days30.sessions += usize::from(bucket_sessions[2]);
    }

    summary.token_events = token_events;
    summary.available = files_with_usage > 0;
    summary.detail = if summary.available {
        format!(
            "Aggregated from {} Codex session file(s) with token events",
            files_with_usage
        )
    } else if token_events == 0 {
        "No Codex token usage events found in local session files".to_string()
    } else {
        "Codex token events found outside the queried time windows".to_string()
    };
    summary
}

fn codex_token_counts_from_line(object: &serde_json::Value) -> Option<CodexTokenCountsEvent> {
    if object.get("type").and_then(|value| value.as_str()) != Some("event_msg") {
        return None;
    }
    let payload = object.get("payload")?;
    if payload.get("type").and_then(|value| value.as_str()) != Some("token_count") {
        return None;
    }

    // Current Codex CLI shape: payload.info carries both the per-turn usage of
    // the last request (`last_token_usage`) and the cumulative session totals
    // (`total_token_usage`). input_tokens already includes cached input (and,
    // when present, cache-write input), so both cache-read and cache-write are
    // split out to keep input as only fresh (non-cached) input.
    if let Some(info) = payload.get("info") {
        let per_turn = info
            .get("last_token_usage")
            .and_then(codex_token_counts_from_usage);
        let cumulative = info
            .get("total_token_usage")
            .and_then(codex_token_counts_from_usage);
        if per_turn.is_some() || cumulative.is_some() {
            return Some(CodexTokenCountsEvent {
                per_turn,
                cumulative,
            });
        }
    }

    // Older Codex CLI shape: payload.tokens with separate input/output/cache
    // counters that are already non-cached.
    let tokens = payload.get("tokens")?;
    Some(CodexTokenCountsEvent {
        per_turn: None,
        cumulative: Some(CodexTokenCounts {
            input: number_field(tokens, "input")?.max(0.0) as u64,
            output: number_field(tokens, "output").unwrap_or(0.0).max(0.0) as u64,
            cache_read: number_field(tokens, "cache_read").unwrap_or(0.0).max(0.0) as u64,
            cache_create: number_field(tokens, "cache_creation")
                .unwrap_or(0.0)
                .max(0.0) as u64,
        }),
    })
}

/// Parses one `TokenUsage` object (either `last_token_usage` or
/// `total_token_usage`) into the cache-split counts.
fn codex_token_counts_from_usage(usage: &serde_json::Value) -> Option<CodexTokenCounts> {
    let input = number_field(usage, "input_tokens")?;
    let cached = number_field(usage, "cached_input_tokens").unwrap_or(0.0);
    let cache_write = number_field(usage, "cache_write_input_tokens")
        .or_else(|| number_field(usage, "cache_creation_input_tokens"))
        .unwrap_or(0.0);
    let output = number_field(usage, "output_tokens").unwrap_or(0.0);
    Some(CodexTokenCounts {
        input: (input - cached - cache_write).max(0.0) as u64,
        output: output.max(0.0) as u64,
        cache_read: cached.max(0.0) as u64,
        cache_create: cache_write.max(0.0) as u64,
    })
}

impl CodexTokenCounts {
    fn is_zero(&self) -> bool {
        self.input == 0 && self.output == 0 && self.cache_read == 0 && self.cache_create == 0
    }
}

#[allow(clippy::too_many_arguments)]
fn add_bucket_delta(
    input: &mut u64,
    output: &mut u64,
    cache_read: &mut u64,
    cache_create: &mut u64,
    sessions: &mut bool,
    delta: CodexTokenCounts,
) {
    *input += delta.input;
    *output += delta.output;
    *cache_read += delta.cache_read;
    *cache_create += delta.cache_create;
    *sessions = true;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_token_counts_split_cached_input_from_info_totals() {
        let object = serde_json::json!({
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "info": {
                    "total_token_usage": {
                        "input_tokens": 120_000,
                        "cached_input_tokens": 100_000,
                        "output_tokens": 2_500,
                        "total_tokens": 122_500
                    }
                }
            }
        });

        let counts = codex_token_counts_from_line(&object)
            .expect("parse")
            .cumulative
            .expect("totals");
        assert_eq!(counts.input, 20_000);
        assert_eq!(counts.output, 2_500);
        assert_eq!(counts.cache_read, 100_000);
        assert_eq!(counts.cache_create, 0);
    }

    #[test]
    fn codex_token_counts_parse_legacy_tokens_shape() {
        let object = serde_json::json!({
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "tokens": {
                    "input": 300,
                    "output": 45,
                    "cache_read": 60,
                    "cache_creation": 12
                }
            }
        });

        let counts = codex_token_counts_from_line(&object)
            .expect("parse")
            .cumulative
            .expect("totals");
        assert_eq!(counts.input, 300);
        assert_eq!(counts.output, 45);
        assert_eq!(counts.cache_read, 60);
        assert_eq!(counts.cache_create, 12);
    }

    #[test]
    fn codex_token_counts_ignore_non_token_events() {
        assert!(codex_token_counts_from_line(&serde_json::json!({
            "type": "event_msg",
            "payload": { "type": "session_meta" }
        }))
        .is_none());
        assert!(codex_token_counts_from_line(&serde_json::json!({
            "type": "session_meta",
            "payload": { "id": "s1" }
        }))
        .is_none());
    }

    #[test]
    fn codex_token_usage_aggregates_deltas_into_time_buckets() {
        let root =
            std::env::temp_dir().join(format!("agentbro-codex-usage-{}", uuid::Uuid::new_v4()));
        let day_dir = root.join("2026").join("08").join("30");
        fs::create_dir_all(&day_dir).expect("create day dir");
        let now = chrono::Utc::now();
        let today = now.format("%Y-%m-%dT%H:%M:%SZ").to_string();
        let three_days_ago = (now - chrono::Duration::days(3))
            .format("%Y-%m-%dT%H:%M:%SZ")
            .to_string();
        fs::write(
            day_dir.join("rollout-today.jsonl"),
            format!(
                r#"{{"type":"event_msg","timestamp":"{three_days_ago}","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":1000,"cached_input_tokens":200,"output_tokens":100,"total_tokens":1100}}}}}}}}
{{"type":"event_msg","timestamp":"{today}","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":1500,"cached_input_tokens":300,"output_tokens":250,"total_tokens":1750}}}}}}}}"#,
            ),
        )
        .expect("write today rollout");

        let summary = load_codex_token_usage_summary_from_root(&root);

        assert!(summary.available);
        assert_eq!(summary.sessions_scanned, 1);
        assert_eq!(summary.token_events, 2);
        // First event (3 days ago) contributes its full totals; second event
        // contributes only the advancing deltas (400 fresh input, 100 cached,
        // 150 out), where fresh input is input_tokens minus cached_input_tokens.
        assert_eq!(summary.days7.input, 800 + 400);
        assert_eq!(summary.days7.cache_read, 200 + 100);
        assert_eq!(summary.days7.output, 100 + 150);
        assert_eq!(summary.days7.sessions, 1);
        assert_eq!(summary.days30.input, summary.days7.input);
        assert_eq!(summary.today.input, 400);
        assert_eq!(summary.today.output, 150);
        assert_eq!(summary.today.cache_read, 100);
        assert_eq!(summary.today.sessions, 1);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn codex_token_usage_reports_missing_directory_without_fabrication() {
        let root = std::env::temp_dir().join(format!(
            "agentbro-codex-usage-missing-{}",
            uuid::Uuid::new_v4()
        ));
        let summary = load_codex_token_usage_summary_from_root(&root);

        assert!(!summary.available);
        assert_eq!(summary.sessions_scanned, 0);
        assert_eq!(summary.token_events, 0);
        assert_eq!(summary.today.input, 0);
        assert_eq!(summary.today.sessions, 0);
        assert!(summary.detail.contains("No Codex local sessions directory"));
    }

    #[test]
    fn codex_token_usage_history_marks_unavailable_periods_as_unknown() {
        let summary = CodexTokenUsageSummary {
            detail: "No Codex local sessions directory found".to_string(),
            ..CodexTokenUsageSummary::default()
        };
        let history = token_usage_history_from_summary(&summary);
        assert!(!history.available);
        assert_eq!(history.periods.len(), 3);
        assert!(history.periods.iter().all(|period| period.tokens.is_none()));
        assert_eq!(history.periods[0].id, "today");
        assert_eq!(history.periods[2].id, "month");
    }

    #[test]
    fn codex_token_counts_split_cache_write_without_double_counting_input() {
        let object = serde_json::json!({
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "info": {
                    "total_token_usage": {
                        "input_tokens": 30_000,
                        "cached_input_tokens": 20_000,
                        "cache_write_input_tokens": 2_000,
                        "output_tokens": 1_000,
                        "total_tokens": 31_000
                    }
                }
            }
        });

        let counts = codex_token_counts_from_line(&object)
            .expect("parse")
            .cumulative
            .expect("totals");
        // input_tokens includes both cached-read and cache-write; both are
        // split out so input only reflects fresh input and cache_write is not
        // double counted.
        assert_eq!(counts.input, 30_000 - 20_000 - 2_000);
        assert_eq!(counts.output, 1_000);
        assert_eq!(counts.cache_read, 20_000);
        assert_eq!(counts.cache_create, 2_000);
    }

    #[test]
    fn codex_token_usage_skips_files_untouched_since_before_cutoff() {
        let root =
            std::env::temp_dir().join(format!("agentbro-codex-usage-old-{}", uuid::Uuid::new_v4()));
        let day_dir = root.join("2026").join("08").join("30");
        fs::create_dir_all(&day_dir).expect("create day dir");
        let now = chrono::Utc::now();
        let today = now.format("%Y-%m-%dT%H:%M:%SZ").to_string();
        let forty_days_ago = (now - chrono::Duration::days(40))
            .format("%Y-%m-%dT%H:%M:%SZ")
            .to_string();
        let old_path = day_dir.join("rollout-old.jsonl");
        let new_path = day_dir.join("rollout-new.jsonl");
        fs::write(
            &old_path,
            format!(
                r#"{{"type":"event_msg","timestamp":"{forty_days_ago}","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":900,"cached_input_tokens":0,"output_tokens":90,"total_tokens":990}}}}}}}}"#,
            ),
        )
        .expect("write old rollout");
        fs::write(
            &new_path,
            format!(
                r#"{{"type":"event_msg","timestamp":"{today}","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":100,"cached_input_tokens":0,"output_tokens":10,"total_tokens":110}}}}}}}}"#,
            ),
        )
        .expect("write new rollout");
        let old_mtime = std::time::UNIX_EPOCH
            + std::time::Duration::from_secs(
                (now - chrono::Duration::days(40)).timestamp().max(0) as u64
            );
        let file = fs::OpenOptions::new()
            .write(true)
            .open(&old_path)
            .expect("open old rollout");
        file.set_times(std::fs::FileTimes::new().set_modified(old_mtime))
            .expect("set old mtime");
        drop(file);

        let summary = load_codex_token_usage_summary_from_root(&root);

        assert!(summary.available);
        assert_eq!(summary.sessions_scanned, 1);
        assert_eq!(summary.token_events, 1);
        assert_eq!(summary.days30.input, 100);
        assert_eq!(summary.days30.sessions, 1);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn codex_token_usage_source_is_path_free() {
        let root =
            std::env::temp_dir().join(format!("agentbro-codex-usage-src-{}", uuid::Uuid::new_v4()));
        let day_dir = root.join("2026").join("08").join("30");
        fs::create_dir_all(&day_dir).expect("create day dir");
        let today = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
        fs::write(
            day_dir.join("rollout-src.jsonl"),
            format!(
                r#"{{"type":"event_msg","timestamp":"{today}","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":10,"cached_input_tokens":0,"output_tokens":5,"total_tokens":15}}}}}}}}"#,
            ),
        )
        .expect("write rollout");

        let summary = load_codex_token_usage_summary_from_root(&root);
        assert!(summary.available);
        assert_eq!(summary.source, CODEX_TOKEN_SOURCE_LABEL);
        assert!(!summary.source.contains(root.to_str().unwrap()));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn codex_token_counts_parse_per_turn_last_usage() {
        let object = serde_json::json!({
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "info": {
                    "total_token_usage": {
                        "input_tokens": 500_000,
                        "cached_input_tokens": 400_000,
                        "output_tokens": 50_000,
                        "total_tokens": 550_000
                    },
                    "last_token_usage": {
                        "input_tokens": 60_000,
                        "cached_input_tokens": 50_000,
                        "output_tokens": 8_000,
                        "total_tokens": 68_000
                    }
                }
            }
        });

        let event = codex_token_counts_from_line(&object).expect("parse");
        let per_turn = event.per_turn.expect("per-turn usage");
        let cumulative = event.cumulative.expect("cumulative totals");
        assert_eq!(per_turn.input, 10_000);
        assert_eq!(per_turn.output, 8_000);
        assert_eq!(per_turn.cache_read, 50_000);
        assert_eq!(cumulative.input, 100_000);
        assert_eq!(cumulative.output, 50_000);
        assert_eq!(cumulative.cache_read, 400_000);
    }

    #[test]
    fn codex_token_usage_recovers_usage_after_cumulative_reset() {
        let root = std::env::temp_dir().join(format!(
            "agentbro-codex-usage-reset-{}",
            uuid::Uuid::new_v4()
        ));
        let day_dir = root.join("2026").join("08").join("30");
        fs::create_dir_all(&day_dir).expect("create day dir");
        let now = chrono::Utc::now();
        let ts = |offset_days: i64| {
            (now - chrono::Duration::days(offset_days))
                .format("%Y-%m-%dT%H:%M:%SZ")
                .to_string()
        };
        fs::write(
            day_dir.join("rollout-reset.jsonl"),
            format!(
                r#"{{"type":"event_msg","timestamp":"{}","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":1000,"cached_input_tokens":200,"output_tokens":100,"total_tokens":1100}},"last_token_usage":{{"input_tokens":1000,"cached_input_tokens":200,"output_tokens":100,"total_tokens":1100}}}}}}}}
{{"type":"event_msg","timestamp":"{}","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":2500,"cached_input_tokens":300,"output_tokens":250,"total_tokens":2750}},"last_token_usage":{{"input_tokens":1500,"cached_input_tokens":100,"output_tokens":150,"total_tokens":1650}}}}}}}}
{{"type":"event_msg","timestamp":"{}","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":800,"cached_input_tokens":0,"output_tokens":60,"total_tokens":860}},"last_token_usage":{{"input_tokens":800,"cached_input_tokens":0,"output_tokens":60,"total_tokens":860}}}}}}}}
{{"type":"event_msg","timestamp":"{}","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":1000,"cached_input_tokens":0,"output_tokens":90,"total_tokens":1090}},"last_token_usage":{{"input_tokens":200,"cached_input_tokens":0,"output_tokens":30,"total_tokens":230}}}}}}}}"#,
                ts(3),
                ts(2),
                ts(1),
                ts(0),
            ),
        )
        .expect("write reset rollout");

        let summary = load_codex_token_usage_summary_from_root(&root);

        assert!(summary.available);
        assert_eq!(summary.token_events, 4);
        // The third event's cumulative total dropped below the previous total
        // (a session reset/rollback). Per-turn last_token_usage still carries
        // the real usage, so nothing is lost: 800 + 1400 + 800 + 200 fresh
        // input across the four events.
        assert_eq!(summary.days30.input, 800 + 1400 + 800 + 200);
        assert_eq!(summary.days30.cache_read, 200 + 100);
        assert_eq!(summary.days30.output, 100 + 150 + 60 + 30);
        assert_eq!(summary.days30.sessions, 1);
        assert_eq!(summary.today.input, 200);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn codex_token_usage_skips_duplicate_snapshots_with_repeated_last_usage() {
        let root =
            std::env::temp_dir().join(format!("agentbro-codex-usage-dup-{}", uuid::Uuid::new_v4()));
        let day_dir = root.join("2026").join("08").join("30");
        fs::create_dir_all(&day_dir).expect("create day dir");
        let today = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
        fs::write(
            day_dir.join("rollout-dup.jsonl"),
            format!(
                r#"{{"type":"event_msg","timestamp":"{today}","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":1000,"cached_input_tokens":200,"output_tokens":100,"total_tokens":1100}},"last_token_usage":{{"input_tokens":1000,"cached_input_tokens":200,"output_tokens":100,"total_tokens":1100}}}}}}}}
{{"type":"event_msg","timestamp":"{today}","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":1500,"cached_input_tokens":300,"output_tokens":250,"total_tokens":1750}},"last_token_usage":{{"input_tokens":500,"cached_input_tokens":100,"output_tokens":150,"total_tokens":650}}}}}}}}
{{"type":"event_msg","timestamp":"{today}","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":1500,"cached_input_tokens":300,"output_tokens":250,"total_tokens":1750}},"last_token_usage":{{"input_tokens":500,"cached_input_tokens":100,"output_tokens":150,"total_tokens":650}}}}}}}}
{{"type":"event_msg","timestamp":"{today}","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":1600,"cached_input_tokens":300,"output_tokens":280,"total_tokens":1880}},"last_token_usage":{{"input_tokens":100,"cached_input_tokens":0,"output_tokens":30,"total_tokens":130}}}}}}}}"#,
            ),
        )
        .expect("write duplicate rollout");

        let summary = load_codex_token_usage_summary_from_root(&root);

        assert!(summary.available);
        assert_eq!(summary.token_events, 4);
        // The third event repeats the second event's cumulative totals; even
        // though it repeats the same per-turn last_token_usage, it must not be
        // counted twice: 800 + 400 + 0 + 100 fresh input.
        assert_eq!(summary.today.input, 800 + 400 + 100);
        assert_eq!(summary.today.cache_read, 200 + 100);
        assert_eq!(summary.today.output, 100 + 150 + 30);
        assert_eq!(summary.today.sessions, 1);

        let _ = fs::remove_dir_all(root);
    }
}
