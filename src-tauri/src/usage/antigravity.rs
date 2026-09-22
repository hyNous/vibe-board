// Antigravity usage provider: runs the local `agy /usage` command and
// normalizes its JSON. No network access.

use super::normalize::{number_from_value, UsageRateLimitSnapshot};
use super::{
    build_snapshot, resolve_state, unknown_history, UsageCredential, UsageFetch, UsageNetworkKind,
    UsageNetworkPlan, UsageProvider, UsageSnapshot,
};
use crate::hooks::session_store::{RateLimitInfo, UsageRateWindow};
use futures_util::future::BoxFuture;
use futures_util::FutureExt;
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tokio::sync::Mutex as TokioMutex;

const ANTIGRAVITY_USAGE_CACHE_TTL: Duration = Duration::from_secs(60);
/// `agy /usage` was measured at 12–15 seconds, so the bound is 20 seconds.
const ANTIGRAVITY_USAGE_TIMEOUT: Duration = Duration::from_secs(20);
const ANTIGRAVITY_USAGE_COMMAND: &str = "agy /usage";

pub struct AntigravityUsageProvider;

impl UsageProvider for AntigravityUsageProvider {
    fn id(&self) -> &'static str {
        "antigravity"
    }

    fn label(&self) -> &'static str {
        "Antigravity"
    }

    fn implementation_status(&self) -> &'static str {
        "active"
    }

    fn settings_order(&self) -> Option<u32> {
        Some(12)
    }

    fn read_credentials(&self) -> UsageCredential {
        UsageCredential {
            status: super::UsageAuthStatus::Unknown,
            path: None,
            can_authorize: false,
        }
    }

    fn network_plan(&self) -> UsageNetworkPlan {
        UsageNetworkPlan {
            kind: Some(UsageNetworkKind::Cli),
            target: Some(ANTIGRAVITY_USAGE_COMMAND),
            // The Antigravity CLI owns its own login; Vibe Board never reads it.
            credential: None,
            unsupported_reason: None,
        }
    }

    fn fetch_local<'a>(&'a self) -> BoxFuture<'a, UsageFetch> {
        async move {
            let binary_available = find_antigravity_binary().is_some();
            let detail = if binary_available {
                "Antigravity CLI found; no local quota source.".to_string()
            } else {
                "Antigravity CLI (agy) was not found.".to_string()
            };

            UsageFetch {
                history: unknown_history("No local Antigravity token history reader yet"),
                detail,
                ..UsageFetch::default()
            }
        }
        .boxed()
    }

    fn fetch_network<'a>(&'a self) -> BoxFuture<'a, UsageFetch> {
        async move {
            let (snapshot, error) = load_antigravity_usage_rate_limits().await;
            let detail = if snapshot.is_some() {
                "Antigravity /usage quota synced.".to_string()
            } else if let Some(error) = &error {
                format!("Antigravity /usage request failed: {error}")
            } else {
                "Antigravity /usage returned no quota data.".to_string()
            };

            UsageFetch {
                rate_limits: snapshot.map(|snapshot| snapshot.rate_limits),
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
        let mut snapshot = build_snapshot(self, enabled, &credentials, &fetched, state, detail);
        if fetched.rate_limits.is_some() {
            snapshot.auth_status = "authorized".to_string();
        }
        snapshot
    }
}

/// Legacy shape used by the island and agent status commands. Callers gate it
/// on authorization because it runs the Antigravity CLI, which goes online.
pub(crate) async fn load_rate_limits() -> Option<RateLimitInfo> {
    load_antigravity_usage_rate_limits()
        .await
        .0
        .map(|snapshot| snapshot.rate_limits)
}

#[derive(Default)]
struct AntigravityUsageCache {
    fetched_at: Option<Instant>,
    snapshot: Option<UsageRateLimitSnapshot>,
    error: Option<String>,
}

async fn load_antigravity_usage_rate_limits() -> (Option<UsageRateLimitSnapshot>, Option<String>) {
    static CACHE: OnceLock<TokioMutex<AntigravityUsageCache>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| TokioMutex::new(AntigravityUsageCache::default()));
    {
        let cached = cache.lock().await;
        if cached
            .fetched_at
            .is_some_and(|fetched_at| fetched_at.elapsed() < ANTIGRAVITY_USAGE_CACHE_TTL)
        {
            return (cached.snapshot.clone(), visible_error(&cached));
        }
    }

    let fresh = fetch_antigravity_usage_rate_limits().await;
    let mut cached = cache.lock().await;
    cached.fetched_at = Some(Instant::now());
    match fresh {
        (Some(snapshot), _) => {
            cached.snapshot = Some(snapshot);
            cached.error = None;
        }
        (None, error) => {
            cached.error = error;
        }
    }
    (cached.snapshot.clone(), visible_error(&cached))
}

fn visible_error(cached: &AntigravityUsageCache) -> Option<String> {
    if cached.snapshot.is_some() {
        None
    } else {
        cached.error.clone()
    }
}

fn find_antigravity_binary() -> Option<String> {
    if let Some(path) = crate::agents::executable::find_binary("agy") {
        return Some(path.display().to_string());
    }

    let mut candidates = Vec::new();
    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".agy").join("bin").join("agy"));
        #[cfg(target_os = "windows")]
        candidates.push(
            home.join("AppData")
                .join("Local")
                .join("agy")
                .join("bin")
                .join("agy.exe"),
        );
    }
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .map(|path| path.display().to_string())
}

async fn fetch_antigravity_usage_rate_limits() -> (Option<UsageRateLimitSnapshot>, Option<String>) {
    let Some(binary) = find_antigravity_binary() else {
        return (
            None,
            Some("the Antigravity CLI (agy) was not found".to_string()),
        );
    };
    let mut command = crate::platform::process::background_tokio_command(binary);
    command
        .args([
            "--print",
            "/usage",
            "--output-format",
            "json",
            "--mode",
            "plan",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let output = match tokio::time::timeout(ANTIGRAVITY_USAGE_TIMEOUT, command.output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => return (None, Some(format!("could not run agy /usage: {error}"))),
        Err(_) => {
            return (
                None,
                Some(format!(
                    "agy /usage timed out after {} seconds",
                    ANTIGRAVITY_USAGE_TIMEOUT.as_secs()
                )),
            )
        }
    };
    if !output.status.success() {
        return (
            None,
            Some(format!("agy /usage exited with {}", output.status)),
        );
    }
    let payload = match serde_json::from_slice::<serde_json::Value>(&output.stdout) {
        Ok(payload) => payload,
        Err(_) => return (None, Some("agy /usage did not return JSON".to_string())),
    };
    match parse_antigravity_usage_payload(&payload, chrono::Utc::now()) {
        Some(snapshot) => (Some(snapshot), None),
        None => (
            None,
            Some("agy /usage returned no quota windows".to_string()),
        ),
    }
}

fn parse_antigravity_usage_payload(
    payload: &serde_json::Value,
    captured_at: chrono::DateTime<chrono::Utc>,
) -> Option<UsageRateLimitSnapshot> {
    let groups = payload
        .pointer("/command/data/groups")
        .or_else(|| payload.pointer("/data/groups"))?
        .as_array()?;
    let mut windows = Vec::new();
    let mut legacy_five_hour: Option<(f64, String)> = None;
    let mut legacy_seven_day: Option<(f64, String)> = None;

    for (group_index, group) in groups.iter().enumerate() {
        let group_name = group
            .get("name")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let group_label = antigravity_group_label(group_name);
        let Some(buckets) = group.get("buckets").and_then(|value| value.as_array()) else {
            continue;
        };
        for (bucket_index, bucket) in buckets.iter().enumerate() {
            let Some(remaining_percent) = antigravity_remaining_percent(bucket) else {
                continue;
            };
            let used_percent = (100.0 - remaining_percent).clamp(0.0, 100.0);
            let window_kind = bucket
                .get("window")
                .and_then(|value| value.as_str())
                .unwrap_or("window");
            let window_title = antigravity_window_title(window_kind);
            let remaining_label = format!("{remaining_percent:.0}%");
            let id = bucket
                .get("id")
                .and_then(|value| value.as_str())
                .filter(|value| !value.trim().is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| format!("group-{group_index}-{window_kind}-{bucket_index}"));
            windows.push(UsageRateWindow {
                id,
                title: format!("{group_label} {window_title}"),
                used_percent,
                remaining_percent: Some(remaining_percent),
                remaining_label: Some(remaining_label.clone()),
                resets_at: antigravity_reset_at(bucket),
                window_minutes: antigravity_window_minutes(bucket, window_kind),
            });

            match window_kind.to_ascii_lowercase().as_str() {
                "5h" | "five_hour" | "five-hour" => {
                    legacy_five_hour.get_or_insert((used_percent, remaining_label));
                }
                "weekly" | "7d" | "seven_day" | "seven-day" => {
                    legacy_seven_day.get_or_insert((used_percent, remaining_label));
                }
                _ => {}
            }
        }
    }

    if windows.is_empty() {
        return None;
    }
    let (five_hour_usage, five_hour_remaining) = legacy_five_hour.unwrap_or((0.0, String::new()));
    let (seven_day_usage, seven_day_remaining) = legacy_seven_day.unwrap_or((0.0, String::new()));
    Some(UsageRateLimitSnapshot {
        rate_limits: RateLimitInfo {
            five_hour_usage,
            five_hour_remaining,
            seven_day_usage,
            seven_day_remaining,
            provider: Some("antigravity".to_string()),
            provider_label: Some("Antigravity".to_string()),
            source: Some("antigravity-cli:/usage".to_string()),
            updated_at: Some(captured_at.timestamp_millis()),
            windows,
        },
        captured_at: Some(captured_at),
    })
}

fn antigravity_group_label(name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    if lower.contains("gemini") {
        "Gemini".to_string()
    } else if lower.contains("claude") && lower.contains("gpt") {
        "Claude/GPT".to_string()
    } else if name.trim().is_empty() {
        "Models".to_string()
    } else {
        name.trim().to_string()
    }
}

fn antigravity_window_title(window: &str) -> String {
    match window.to_ascii_lowercase().as_str() {
        "5h" | "five_hour" | "five-hour" => "5h".to_string(),
        "weekly" | "7d" | "seven_day" | "seven-day" => "7d".to_string(),
        "monthly" | "30d" | "thirty_day" | "thirty-day" => "30d".to_string(),
        _ => window.trim().to_string(),
    }
}

fn antigravity_remaining_percent(bucket: &serde_json::Value) -> Option<f64> {
    let raw = bucket
        .get("remaining_fraction")
        .or_else(|| bucket.get("remainingFraction"))
        .or_else(|| bucket.get("remaining_percent"))
        .or_else(|| bucket.get("remainingPercent"))
        .and_then(number_from_value)?;
    Some(if raw <= 1.0 { raw * 100.0 } else { raw }.clamp(0.0, 100.0))
}

fn antigravity_reset_at(bucket: &serde_json::Value) -> Option<String> {
    bucket
        .get("reset_time")
        .or_else(|| bucket.get("resetTime"))
        .or_else(|| bucket.get("resets_at"))
        .or_else(|| bucket.get("resetsAt"))
        .and_then(super::normalize::date_from_value)
        .map(|date| date.to_rfc3339())
}

fn antigravity_window_minutes(bucket: &serde_json::Value, window: &str) -> Option<i64> {
    super::normalize::window_minutes(bucket).or_else(|| {
        match window.to_ascii_lowercase().as_str() {
            "5h" | "five_hour" | "five-hour" => Some(300),
            "weekly" | "7d" | "seven_day" | "seven-day" => Some(10_080),
            "monthly" | "30d" | "thirty_day" | "thirty-day" => Some(43_200),
            _ => None,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn network_plan_runs_agy_with_a_twenty_second_bound() {
        let plan = AntigravityUsageProvider.network_plan();
        assert_eq!(plan.kind, Some(UsageNetworkKind::Cli));
        assert_eq!(plan.target, Some(ANTIGRAVITY_USAGE_COMMAND));
        assert!(plan.credential.is_none());
        assert_eq!(ANTIGRAVITY_USAGE_TIMEOUT, Duration::from_secs(20));
    }

    #[tokio::test]
    async fn unauthorized_provider_reports_no_quota_source() {
        let snapshot =
            super::super::collect_snapshot(&AntigravityUsageProvider, true, true, false).await;

        assert!(!snapshot.network_authorized);
        assert!(snapshot.network_supported);
        assert!(snapshot.source.is_none());
        assert!(snapshot.windows.is_empty());
        assert!(snapshot.detail.contains("not authorized"));
    }

    #[test]
    fn parses_antigravity_usage_payload_with_all_model_windows() {
        let captured_at = chrono::DateTime::parse_from_rfc3339("2026-09-02T00:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        let snapshot = parse_antigravity_usage_payload(
            &serde_json::json!({
                "command": { "data": { "groups": [
                    { "name": "Gemini Models", "buckets": [
                        { "id": "gemini-weekly", "window": "weekly", "remaining_fraction": 0.8, "reset_time": "2026-09-05T11:03:35Z" },
                        { "id": "gemini-5h", "window": "5h", "remaining_fraction": 0.77, "reset_time": "2026-09-02T10:15:04Z" }
                    ] },
                    { "name": "Claude and GPT models", "buckets": [
                        { "id": "3p-weekly", "window": "weekly", "remaining_fraction": 0.52, "reset_time": "2026-09-08T06:20:44Z" },
                        { "id": "3p-5h", "window": "5h", "remaining_fraction": 1.0, "reset_time": "2026-09-02T11:22:35Z" }
                    ] }
                ] } }
            }),
            captured_at,
        )
        .expect("valid Antigravity /usage payload");

        assert_eq!(
            snapshot.rate_limits.provider.as_deref(),
            Some("antigravity")
        );
        assert_eq!(snapshot.rate_limits.windows.len(), 4);
        assert_eq!(snapshot.rate_limits.windows[0].title, "Gemini 7d");
        assert_eq!(
            snapshot.rate_limits.windows[1].remaining_percent,
            Some(77.0)
        );
        assert_eq!(snapshot.rate_limits.windows[2].title, "Claude/GPT 7d");
        assert_eq!(snapshot.rate_limits.windows[3].used_percent, 0.0);
        assert_eq!(snapshot.rate_limits.five_hour_usage, 23.0);
        assert_eq!(snapshot.rate_limits.seven_day_usage, 20.0);
    }
}
