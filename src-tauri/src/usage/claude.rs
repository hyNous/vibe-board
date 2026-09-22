// Claude Code usage provider: reads the island/statusline rate-limit file that
// Claude Code writes next to the user's credentials.

use super::normalize::{provider_rate_limits, UsageRateLimitSnapshot};
use super::{
    build_snapshot, resolve_state, UsageAuthStatus, UsageCredential, UsageFetch, UsageNetworkPlan,
    UsageProvider, UsageSnapshot,
};
use crate::hooks::session_store::RateLimitInfo;
use futures_util::future::BoxFuture;
use futures_util::FutureExt;
use std::fs;
use std::path::PathBuf;

pub struct ClaudeUsageProvider;

impl UsageProvider for ClaudeUsageProvider {
    fn id(&self) -> &'static str {
        "claude-code"
    }

    fn label(&self) -> &'static str {
        "Claude Code"
    }

    fn aliases(&self) -> &'static [&'static str] {
        &["claude"]
    }

    fn implementation_status(&self) -> &'static str {
        "active"
    }

    fn settings_order(&self) -> Option<u32> {
        Some(1)
    }

    fn authorize_command(&self) -> Option<(&'static str, &'static [&'static str])> {
        Some(("claude", &["login"]))
    }

    fn read_credentials(&self) -> UsageCredential {
        let path = dirs::home_dir().map(|home| home.join(".claude").join(".credentials.json"));
        let exists = path.as_ref().is_some_and(|path| path.exists());
        UsageCredential {
            status: if exists {
                UsageAuthStatus::Authorized
            } else {
                UsageAuthStatus::Missing
            },
            path: path.map(|path| path.display().to_string()),
            can_authorize: crate::commands::find_binary("claude").is_some(),
        }
    }

    fn fetch_local<'a>(&'a self) -> BoxFuture<'a, UsageFetch> {
        async move {
            let snapshot = load_claude_usage_rate_limits();
            let has_temp = claude_rate_limit_paths().iter().any(|path| path.exists());
            let has_auth = claude_credentials_path()
                .as_ref()
                .is_some_and(|path| path.exists());

            let detail = if snapshot.is_some() {
                "Claude island/statusline rate limits found.".to_string()
            } else if has_temp {
                "Claude rate-limit file exists but could not be parsed.".to_string()
            } else if has_auth {
                "Claude credentials found, waiting for statusline rate-limit data.".to_string()
            } else {
                "No Claude credentials or rate-limit statusline data found.".to_string()
            };

            UsageFetch {
                rate_limits: snapshot.map(|snapshot| snapshot.rate_limits),
                // Token usage comes from the persisted daily aggregate; the
                // scanner runs on its own background thread (M8b).
                history: super::history::provider_history("claude-code"),
                detail,
                error: None,
                ..UsageFetch::default()
            }
        }
        .boxed()
    }

    /// Claude Code's online quota query needs its OAuth token and has never
    /// been verified, so it stays offline (M8c capability matrix).
    fn network_plan(&self) -> UsageNetworkPlan {
        UsageNetworkPlan {
            unsupported_reason: Some("unverified"),
            ..UsageNetworkPlan::default()
        }
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
pub(crate) fn load_rate_limits() -> Option<RateLimitInfo> {
    load_claude_usage_rate_limits().map(|snapshot| snapshot.rate_limits)
}

fn claude_credentials_path() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".claude").join(".credentials.json"))
}

fn claude_rate_limit_paths() -> [PathBuf; 2] {
    [
        std::env::temp_dir().join("island-rate-limits.json"),
        PathBuf::from("/tmp/island-rate-limits.json"),
    ]
}

fn load_claude_usage_rate_limits() -> Option<UsageRateLimitSnapshot> {
    let path = claude_rate_limit_paths()
        .into_iter()
        .find(|path| path.is_file())?;
    let content = fs::read_to_string(&path).ok()?;
    let payload: serde_json::Value = serde_json::from_str(&content).ok()?;
    let metadata_time = fs::metadata(&path)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .map(chrono::DateTime::<chrono::Utc>::from);

    let five_hour = payload
        .get("five_hour")
        .or_else(|| payload.get("fiveHour"))?;
    let seven_day = payload
        .get("seven_day")
        .or_else(|| payload.get("sevenDay"))?;
    let captured_at = metadata_time;

    Some(UsageRateLimitSnapshot {
        rate_limits: provider_rate_limits(
            "claude-code",
            "Claude",
            "claude-island",
            captured_at,
            five_hour,
            seven_day,
        )?,
        captured_at,
    })
}
