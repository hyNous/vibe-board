// OpenCode usage provider. This is the only usage reader that talks to the
// network: the pre-existing OpenCode Go usage request, migrated unchanged from
// `commands/mod.rs`. No other request may be added here (M8a).

use super::normalize::{remaining_label, usage_window, used_percentage};
use super::{
    build_snapshot, resolve_state, unknown_history, UsageCredential, UsageFetch, UsageProvider,
    UsageSnapshot,
};
use crate::hooks::session_store::RateLimitInfo;
use futures_util::future::BoxFuture;
use futures_util::FutureExt;
use std::fs;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tokio::sync::Mutex as TokioMutex;

/// Pre-existing OpenCode Go usage endpoint (authorized by the user's API key).
/// Kept unchanged; the only outgoing request in this module.
const OPENCODE_GO_USAGE_URL: &str = "https://opencode.ai/zen/go/v1/usage";
const OPENCODE_USAGE_CACHE_TTL: Duration = Duration::from_secs(60);

pub struct OpenCodeUsageProvider;

impl UsageProvider for OpenCodeUsageProvider {
    fn id(&self) -> &'static str {
        "opencode"
    }

    fn label(&self) -> &'static str {
        "OpenCode Go"
    }

    fn implementation_status(&self) -> &'static str {
        "active"
    }

    fn settings_order(&self) -> Option<u32> {
        Some(9)
    }

    fn authorize_command(&self) -> Option<(&'static str, &'static [&'static str])> {
        Some(("opencode", &["auth", "login"]))
    }

    fn read_credentials(&self) -> UsageCredential {
        let presence = opencode_presence();
        let has_api_key = load_opencode_api_key().is_some();
        let has_credentials = presence.has_auth || has_api_key;
        UsageCredential {
            status: if has_credentials {
                super::UsageAuthStatus::Authorized
            } else {
                super::UsageAuthStatus::Missing
            },
            path: presence.display_path(),
            can_authorize: !has_credentials && crate::commands::find_binary("opencode").is_some(),
        }
    }

    fn fetch<'a>(&'a self, _live: bool) -> BoxFuture<'a, UsageFetch> {
        async move {
            let presence = opencode_presence();
            let snapshot = load_opencode_usage_rate_limits().await;
            let has_api_key = load_opencode_api_key().is_some();

            let detail = if snapshot.is_some() {
                "OpenCode Go account quota found.".to_string()
            } else if presence.has_auth || has_api_key {
                "OpenCode auth found; no Go account quota data is available yet.".to_string()
            } else if presence.has_config {
                "OpenCode config found; run OpenCode provider authorization if usage data is needed."
                    .to_string()
            } else {
                "OpenCode config directory was not found.".to_string()
            };

            UsageFetch {
                rate_limits: snapshot.map(|snapshot| snapshot.rate_limits),
                history: unknown_history("No local OpenCode token history reader yet"),
                detail,
                error: None,
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
pub(crate) async fn load_rate_limits() -> Option<RateLimitInfo> {
    load_opencode_usage_rate_limits()
        .await
        .map(|snapshot| snapshot.rate_limits)
}

struct OpenCodePresence {
    config_dir: Option<PathBuf>,
    auth_path: Option<PathBuf>,
    has_config: bool,
    has_auth: bool,
}

impl OpenCodePresence {
    fn display_path(&self) -> Option<String> {
        let path = if self.has_auth {
            self.auth_path.as_ref()
        } else {
            self.config_dir.as_ref()
        };
        path.map(|path| path.display().to_string())
    }
}

fn opencode_presence() -> OpenCodePresence {
    let home = dirs::home_dir();
    let config_dir = home
        .as_ref()
        .map(|home| home.join(".config").join("opencode"));
    let auth_path = home.as_ref().map(|home| {
        home.join(".local")
            .join("share")
            .join("opencode")
            .join("auth.json")
    });
    let has_config = config_dir.as_ref().is_some_and(|path| path.exists());
    let has_auth = auth_path.as_ref().is_some_and(|path| path.exists());
    OpenCodePresence {
        config_dir,
        auth_path,
        has_config,
        has_auth,
    }
}

#[derive(Default)]
struct OpenCodeUsageCache {
    fetched_at: Option<Instant>,
    snapshot: Option<super::normalize::UsageRateLimitSnapshot>,
}

async fn load_opencode_usage_rate_limits() -> Option<super::normalize::UsageRateLimitSnapshot> {
    static CACHE: OnceLock<TokioMutex<OpenCodeUsageCache>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| TokioMutex::new(OpenCodeUsageCache::default()));
    {
        let cached = cache.lock().await;
        if cached
            .fetched_at
            .is_some_and(|fetched_at| fetched_at.elapsed() < OPENCODE_USAGE_CACHE_TTL)
        {
            return cached.snapshot.clone();
        }
    }

    let fresh = fetch_opencode_usage_rate_limits().await;
    let mut cached = cache.lock().await;
    cached.fetched_at = Some(Instant::now());
    if fresh.is_some() {
        cached.snapshot = fresh;
    }
    cached.snapshot.clone()
}

async fn fetch_opencode_usage_rate_limits() -> Option<super::normalize::UsageRateLimitSnapshot> {
    let api_key = load_opencode_api_key()?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .ok()?;
    let response = client
        .get(OPENCODE_GO_USAGE_URL)
        .bearer_auth(api_key)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let payload = response.json::<serde_json::Value>().await.ok()?;
    parse_opencode_usage_payload(&payload, chrono::Utc::now())
}

fn load_opencode_api_key() -> Option<String> {
    for variable in ["OPENCODE_GO_API_KEY", "OPENCODE_API_KEY"] {
        if let Ok(value) = std::env::var(variable) {
            let value = value.trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }

    let path = dirs::home_dir()?
        .join(".local")
        .join("share")
        .join("opencode")
        .join("auth.json");
    let payload: serde_json::Value = serde_json::from_str(&fs::read_to_string(path).ok()?).ok()?;
    ["opencode-go", "opencode"]
        .into_iter()
        .find_map(|provider| payload.get(provider).and_then(opencode_api_key_from_entry))
}

fn opencode_api_key_from_entry(entry: &serde_json::Value) -> Option<String> {
    if entry
        .get("type")
        .and_then(|value| value.as_str())
        .is_some_and(|kind| kind != "api")
    {
        return None;
    }
    entry
        .as_str()
        .or_else(|| entry.get("key").and_then(|value| value.as_str()))
        .or_else(|| entry.get("apiKey").and_then(|value| value.as_str()))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn parse_opencode_usage_payload(
    payload: &serde_json::Value,
    captured_at: chrono::DateTime<chrono::Utc>,
) -> Option<super::normalize::UsageRateLimitSnapshot> {
    let usage = payload.get("usage").unwrap_or(payload);
    let rolling = usage
        .get("rolling")
        .or_else(|| payload.get("rollingUsage"))?;
    let weekly = usage.get("weekly").or_else(|| payload.get("weeklyUsage"))?;
    let monthly = usage
        .get("monthly")
        .or_else(|| payload.get("monthlyUsage"))?;
    let five_hour_usage = used_percentage(rolling)?;
    let seven_day_usage = used_percentage(weekly)?;

    Some(super::normalize::UsageRateLimitSnapshot {
        rate_limits: RateLimitInfo {
            five_hour_usage,
            five_hour_remaining: remaining_label(rolling),
            seven_day_usage,
            seven_day_remaining: remaining_label(weekly),
            provider: Some("opencode".to_string()),
            provider_label: Some("OpenCode Go".to_string()),
            source: Some("opencode-go-api".to_string()),
            updated_at: Some(captured_at.timestamp_millis()),
            windows: vec![
                usage_window("rolling", "5h", rolling, Some(300))?,
                usage_window("weekly", "7d", weekly, Some(10_080))?,
                usage_window("monthly", "30d", monthly, None)?,
            ],
        },
        captured_at: Some(captured_at),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_opencode_go_usage_payload() {
        let captured_at = chrono::DateTime::parse_from_rfc3339("2026-09-02T00:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        let snapshot = parse_opencode_usage_payload(
            &serde_json::json!({
                "usage": {
                    "rolling": { "status": "ok", "percent": 12, "resetsAt": "2026-09-02T05:00:00Z" },
                    "weekly": { "status": "ok", "percent": 8, "resetsAt": "2026-09-07T00:00:00Z" },
                    "monthly": { "status": "ok", "percent": 3, "resetsAt": "2026-10-01T00:00:00Z" }
                }
            }),
            captured_at,
        )
        .expect("valid OpenCode Go usage payload");

        assert_eq!(snapshot.rate_limits.provider.as_deref(), Some("opencode"));
        assert_eq!(snapshot.rate_limits.five_hour_usage, 12.0);
        assert_eq!(snapshot.rate_limits.seven_day_usage, 8.0);
        assert_eq!(snapshot.rate_limits.windows.len(), 3);
        assert_eq!(snapshot.rate_limits.windows[2].used_percent, 3.0);
        assert_eq!(
            snapshot.rate_limits.windows[2].remaining_percent,
            Some(97.0)
        );
    }
}
