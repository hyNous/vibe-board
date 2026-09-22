// Codex usage provider: account quota (app-server bridge → stdio → local
// rollout JSONL) plus token aggregation from local session logs.

use super::normalize::{
    date_from_value, number_field, positive_window_minutes, provider_rate_limits,
    usage_snapshot_within_age, UsageRateLimitSnapshot,
};
use super::{
    build_snapshot, resolve_state, UsageAuthStatus, UsageCredential, UsageFetch, UsageProvider,
    UsageSnapshot,
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
                // Token usage comes from the persisted daily aggregate; the
                // scanner runs on its own background thread (M8b).
                history: super::history::provider_history("codex"),
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

// ── Local token usage parsing ────────────────────────────────────────────
//
// The incremental scanner (`usage::history`) owns file discovery, caching,
// persistence, and the settlement windows. These helpers only turn one rollout
// line into cache-split token counts and apply the per-turn / cumulative delta
// rule while a file is being read.

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct CodexTokenCounts {
    pub(crate) input: u64,
    pub(crate) output: u64,
    pub(crate) cache_read: u64,
    pub(crate) cache_create: u64,
}

/// Per-event token usage parsed from a Codex rollout line. Current Codex
/// events carry both the real per-turn usage (`last_token_usage`) and the
/// cumulative session totals (`total_token_usage`); older formats expose only
/// one of the two.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct CodexTokenCountsEvent {
    /// Real per-turn usage from `payload.info.last_token_usage`, when present.
    pub(crate) per_turn: Option<CodexTokenCounts>,
    /// Cumulative session totals from `payload.info.total_token_usage` (or the
    /// legacy `payload.tokens` shape), when present.
    pub(crate) cumulative: Option<CodexTokenCounts>,
}

/// Applies the per-turn / cumulative delta rule to one parsed event while a
/// file is being read. Per-turn `last_token_usage` wins whenever the cumulative
/// total advanced (or is missing), so usage survives cumulative resets and a
/// snapshot that repeats an unchanged total is skipped instead of double
/// counted. Events with only cumulative totals fall back to consecutive-event
/// deltas; the first event contributes its full recorded total.
pub(crate) fn codex_token_delta(
    event: &CodexTokenCountsEvent,
    previous_cumulative: &mut Option<CodexTokenCounts>,
) -> Option<CodexTokenCounts> {
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
            cache_read: total
                .cache_read
                .saturating_sub(previous_cumulative.map_or(0, |previous| previous.cache_read)),
            cache_create: total
                .cache_create
                .saturating_sub(previous_cumulative.map_or(0, |previous| previous.cache_create)),
        })
    });
    if let Some(total) = event.cumulative {
        *previous_cumulative = Some(total);
    }
    delta
}

pub(crate) fn codex_token_counts_from_line(
    object: &serde_json::Value,
) -> Option<CodexTokenCountsEvent> {
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
pub(crate) fn codex_token_counts_from_usage(usage: &serde_json::Value) -> Option<CodexTokenCounts> {
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
    pub(crate) fn is_zero(&self) -> bool {
        self.input == 0 && self.output == 0 && self.cache_read == 0 && self.cache_create == 0
    }
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
    fn codex_token_delta_prefers_per_turn_usage_after_a_cumulative_reset() {
        let events = [
            serde_json::json!({
                "type": "event_msg",
                "payload": { "type": "token_count", "info": {
                    "total_token_usage": { "input_tokens": 1000, "cached_input_tokens": 200, "output_tokens": 100 },
                    "last_token_usage": { "input_tokens": 1000, "cached_input_tokens": 200, "output_tokens": 100 }
                }}
            }),
            serde_json::json!({
                "type": "event_msg",
                "payload": { "type": "token_count", "info": {
                    "total_token_usage": { "input_tokens": 2500, "cached_input_tokens": 300, "output_tokens": 250 },
                    "last_token_usage": { "input_tokens": 1500, "cached_input_tokens": 100, "output_tokens": 150 }
                }}
            }),
            // The cumulative total dropped below the previous one: a session
            // reset. Per-turn last_token_usage still carries the real usage.
            serde_json::json!({
                "type": "event_msg",
                "payload": { "type": "token_count", "info": {
                    "total_token_usage": { "input_tokens": 800, "cached_input_tokens": 0, "output_tokens": 60 },
                    "last_token_usage": { "input_tokens": 800, "cached_input_tokens": 0, "output_tokens": 60 }
                }}
            }),
            serde_json::json!({
                "type": "event_msg",
                "payload": { "type": "token_count", "info": {
                    "total_token_usage": { "input_tokens": 1000, "cached_input_tokens": 0, "output_tokens": 90 },
                    "last_token_usage": { "input_tokens": 200, "cached_input_tokens": 0, "output_tokens": 30 }
                }}
            }),
        ];

        let mut previous = None;
        let mut totals = CodexTokenCounts::default();
        for object in &events {
            let event = codex_token_counts_from_line(object).expect("parse");
            let delta = codex_token_delta(&event, &mut previous).expect("delta");
            totals.input += delta.input;
            totals.output += delta.output;
            totals.cache_read += delta.cache_read;
            totals.cache_create += delta.cache_create;
        }

        assert_eq!(totals.input, 800 + 1_400 + 800 + 200);
        assert_eq!(totals.cache_read, 200 + 100);
        assert_eq!(totals.output, 100 + 150 + 60 + 30);
    }

    #[test]
    fn codex_token_delta_skips_duplicate_snapshots() {
        let event = |total_input: u64, last_input: u64| {
            codex_token_counts_from_line(&serde_json::json!({
                "type": "event_msg",
                "payload": { "type": "token_count", "info": {
                    "total_token_usage": { "input_tokens": total_input, "cached_input_tokens": 0, "output_tokens": 10 },
                    "last_token_usage": { "input_tokens": last_input, "cached_input_tokens": 0, "output_tokens": 10 }
                }}
            }))
            .expect("parse")
        };

        let mut previous = None;
        let first = codex_token_delta(&event(1_000, 1_000), &mut previous).expect("first");
        let second = codex_token_delta(&event(1_500, 500), &mut previous).expect("second");
        // Same cumulative total as the second event: must not be counted again.
        let duplicate = codex_token_delta(&event(1_500, 500), &mut previous).expect("duplicate");
        assert_eq!(duplicate.input, 0);
        let third = codex_token_delta(&event(1_600, 100), &mut previous).expect("third");
        assert_eq!(
            first.input + second.input + duplicate.input + third.input,
            1_000 + 500 + 0 + 100
        );
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
}
