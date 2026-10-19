// Claude Code usage provider. Locally it reads the island/statusline
// rate-limit file; once the user authorizes online querying it also asks
// Anthropic for the account's 5-hour and weekly quota with the OAuth token the
// `claude` CLI keeps in ~/.claude/.credentials.json (M16 follow-up).

use super::normalize::{provider_rate_limits, UsageRateLimitSnapshot};
use super::{
    build_snapshot, resolve_state, UsageAuthStatus, UsageCredential, UsageFetch, UsageNetworkKind,
    UsageNetworkPlan, UsageProvider, UsageSnapshot,
};
use crate::hooks::session_store::RateLimitInfo;
use futures_util::future::BoxFuture;
use futures_util::FutureExt;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use tokio::sync::Mutex as TokioMutex;

/// Not an officially documented endpoint: it is what Claude Code itself uses
/// for `/usage`, as described by community tools (CodexBar).
const CLAUDE_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_OAUTH_BETA: &str = "oauth-2025-04-20";
/// The endpoint rate-limits aggressively, so successful answers are reused.
const CLAUDE_USAGE_CACHE_TTL: Duration = Duration::from_secs(5 * 60);
const CLAUDE_USAGE_TIMEOUT: Duration = Duration::from_secs(10);
const CLAUDE_REDACTED: &str = "[redacted]";
/// When the access token has expired, Vibe Board asks the Claude CLI to renew
/// it instead of refreshing it itself: the CLI rotates the single-use refresh
/// token and keeps the credential file consistent. A read-only command is used
/// so the renewal never upgrades Claude Code.
const CLAUDE_RENEW_ARGS: [&str; 2] = ["auth", "status"];
const CLAUDE_RENEW_TIMEOUT: Duration = Duration::from_secs(30);
/// At most one renewal attempt per window, so a broken login is not hammered.
const CLAUDE_RENEW_COOLDOWN: Duration = Duration::from_secs(10 * 60);
pub(crate) const CLAUDE_NOT_LOGGED_IN: &str =
    "Claude CLI is not logged in; run `claude` in a terminal and log in with your Claude account.";
pub(crate) const CLAUDE_LOGIN_EXPIRED: &str =
    "Claude login has expired; run `claude` in a terminal once to refresh it.";

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
        // Claude Code 2.x moved sign-in under `claude auth login`.
        Some(("claude", &["auth", "login"]))
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

    fn network_plan(&self) -> UsageNetworkPlan {
        UsageNetworkPlan {
            kind: Some(UsageNetworkKind::Http),
            target: Some(CLAUDE_USAGE_URL),
            credential: claude_credentials_path().map(|path| path.display().to_string()),
            unsupported_reason: None,
        }
    }

    fn fetch_network<'a>(&'a self) -> BoxFuture<'a, UsageFetch> {
        async move {
            let (snapshot, error) = load_claude_oauth_rate_limits().await;
            let detail = if snapshot.is_some() {
                "Claude account quota found.".to_string()
            } else if let Some(error) = &error {
                format!("Claude usage request failed: {error}")
            } else {
                "No Claude account quota data is available yet.".to_string()
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

#[derive(Default)]
struct ClaudeUsageCache {
    fetched_at: Option<Instant>,
    snapshot: Option<UsageRateLimitSnapshot>,
    error: Option<String>,
}

async fn load_claude_oauth_rate_limits() -> (Option<UsageRateLimitSnapshot>, Option<String>) {
    static CACHE: OnceLock<TokioMutex<ClaudeUsageCache>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| TokioMutex::new(ClaudeUsageCache::default()));
    {
        let cached = cache.lock().await;
        if cached.snapshot.is_some()
            && cached
                .fetched_at
                .is_some_and(|fetched_at| fetched_at.elapsed() < CLAUDE_USAGE_CACHE_TTL)
        {
            return (cached.snapshot.clone(), None);
        }
    }

    let fresh = fetch_claude_oauth_rate_limits().await;
    let mut cached = cache.lock().await;
    match fresh {
        Ok(snapshot) => {
            cached.fetched_at = Some(Instant::now());
            cached.snapshot = Some(snapshot);
            cached.error = None;
        }
        Err(error) => cached.error = Some(error),
    }
    // A stale answer still counts as data; the failure only shows when there
    // is nothing else to show.
    let error = if cached.snapshot.is_some() {
        None
    } else {
        cached.error.clone()
    };
    (cached.snapshot.clone(), error)
}

async fn fetch_claude_oauth_rate_limits() -> Result<UsageRateLimitSnapshot, String> {
    let path = claude_credentials_path().ok_or_else(|| CLAUDE_NOT_LOGGED_IN.to_string())?;
    let payload = match query_claude_usage(&path).await {
        Err(error) if error == CLAUDE_LOGIN_EXPIRED && renew_claude_login().await => {
            query_claude_usage(&path).await?
        }
        result => result?,
    };
    parse_claude_usage(&payload, chrono::Utc::now())
        .ok_or_else(|| "the response did not contain 5-hour and weekly quota windows".to_string())
}

async fn query_claude_usage(path: &Path) -> Result<serde_json::Value, String> {
    let token = claude_oauth_token(path, chrono::Utc::now())?;
    request_claude_usage(&token).await
}

/// Runs the Claude CLI once so it renews its own OAuth token. Returns whether
/// an attempt was made (a retry is only worth it then).
async fn renew_claude_login() -> bool {
    static LAST_ATTEMPT: OnceLock<TokioMutex<Option<Instant>>> = OnceLock::new();
    let last = LAST_ATTEMPT.get_or_init(|| TokioMutex::new(None));
    {
        let mut last = last.lock().await;
        if last.is_some_and(|at| at.elapsed() < CLAUDE_RENEW_COOLDOWN) {
            return false;
        }
        *last = Some(Instant::now());
    }
    let Some(binary) = crate::commands::find_binary("claude") else {
        return false;
    };
    let mut command = crate::platform::process::background_tokio_command(binary);
    command
        .args(CLAUDE_RENEW_ARGS)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    match tokio::time::timeout(CLAUDE_RENEW_TIMEOUT, command.status()).await {
        Ok(Ok(_)) => true,
        Ok(Err(error)) => {
            log::debug!("Claude login renewal could not start: {error}");
            false
        }
        Err(_) => {
            log::debug!("Claude login renewal timed out");
            false
        }
    }
}

/// Reads the CLI's OAuth access token. Vibe Board never refreshes it: the CLI
/// rotates the refresh token, and a second writer could log the user out.
fn claude_oauth_token(path: &Path, now: chrono::DateTime<chrono::Utc>) -> Result<String, String> {
    let content = fs::read_to_string(path).map_err(|_| CLAUDE_NOT_LOGGED_IN.to_string())?;
    let payload: serde_json::Value =
        serde_json::from_str(&content).map_err(|_| CLAUDE_NOT_LOGGED_IN.to_string())?;
    let oauth = payload
        .get("claudeAiOauth")
        .ok_or_else(|| CLAUDE_NOT_LOGGED_IN.to_string())?;
    let token = oauth
        .get("accessToken")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .ok_or_else(|| CLAUDE_NOT_LOGGED_IN.to_string())?;
    let expired = oauth
        .get("expiresAt")
        .and_then(|value| value.as_i64())
        .is_some_and(|expires_at| expires_at <= now.timestamp_millis());
    if expired {
        return Err(CLAUDE_LOGIN_EXPIRED.to_string());
    }
    Ok(token.to_string())
}

async fn request_claude_usage(token: &str) -> Result<serde_json::Value, String> {
    let redact = |message: String| message.replace(token, CLAUDE_REDACTED);
    let client = reqwest::Client::builder()
        .timeout(CLAUDE_USAGE_TIMEOUT)
        .build()
        .map_err(|_| "could not create the HTTP client".to_string())?;
    let response = client
        .get(CLAUDE_USAGE_URL)
        .bearer_auth(token)
        .header("anthropic-beta", CLAUDE_OAUTH_BETA)
        .header("User-Agent", claude_user_agent())
        .send()
        .await
        .map_err(|error| redact(format!("{error}")))?;
    let status = response.status();
    if status.as_u16() == 401 {
        return Err(CLAUDE_LOGIN_EXPIRED.to_string());
    }
    if !status.is_success() {
        return Err(format!("HTTP {}", status.as_u16()));
    }
    response
        .json::<serde_json::Value>()
        .await
        .map_err(|error| redact(format!("{error}")))
}

/// The usage endpoint is reported to throttle unknown clients harder, so the
/// request identifies itself the way the installed CLI does.
fn claude_user_agent() -> String {
    static AGENT: OnceLock<String> = OnceLock::new();
    AGENT
        .get_or_init(|| {
            let version = crate::commands::find_binary("claude")
                .and_then(|binary| {
                    crate::platform::process::background_command(binary)
                        .arg("--version")
                        .output()
                        .ok()
                })
                .and_then(|output| String::from_utf8(output.stdout).ok())
                .and_then(|text| text.split_whitespace().next().map(str::to_string))
                .filter(|version| version.chars().next().is_some_and(|c| c.is_ascii_digit()));
            match version {
                Some(version) => format!("claude-cli/{version} (external, cli)"),
                None => "claude-cli (external, cli)".to_string(),
            }
        })
        .clone()
}

/// `five_hour` / `seven_day` carry `utilization` (0-100) and `resets_at`.
fn parse_claude_usage(
    payload: &serde_json::Value,
    now: chrono::DateTime<chrono::Utc>,
) -> Option<UsageRateLimitSnapshot> {
    let five_hour = payload.get("five_hour").filter(|value| !value.is_null())?;
    let seven_day = payload.get("seven_day").filter(|value| !value.is_null())?;
    Some(UsageRateLimitSnapshot {
        rate_limits: provider_rate_limits(
            "claude-code",
            "Claude",
            "claude-oauth",
            Some(now),
            five_hour,
            seven_day,
        )?,
        captured_at: Some(now),
    })
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

#[cfg(test)]
mod tests {
    use super::*;

    fn write_credentials(name: &str, body: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("vb-claude-usage-{name}-{}", std::process::id()));
        fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join(".credentials.json");
        fs::write(&path, body).expect("write credentials");
        path
    }

    #[test]
    fn network_plan_points_at_the_usage_endpoint_and_credential_file() {
        let plan = ClaudeUsageProvider.network_plan();
        assert_eq!(plan.kind, Some(UsageNetworkKind::Http));
        assert_eq!(plan.target, Some(CLAUDE_USAGE_URL));
        assert!(plan.unsupported_reason.is_none());
        let credential = plan.credential.expect("credential path");
        assert!(credential.ends_with(".credentials.json"), "{credential}");
    }

    #[test]
    fn reads_a_valid_oauth_token() {
        let now = chrono::Utc::now();
        let path = write_credentials(
            "valid",
            &format!(
                r#"{{"claudeAiOauth":{{"accessToken":"tok-123","refreshToken":"r","expiresAt":{}}}}}"#,
                now.timestamp_millis() + 3_600_000
            ),
        );
        assert_eq!(claude_oauth_token(&path, now).as_deref(), Ok("tok-123"));
    }

    #[test]
    fn reports_an_expired_login_instead_of_refreshing_it() {
        let now = chrono::Utc::now();
        let path = write_credentials(
            "expired",
            &format!(
                r#"{{"claudeAiOauth":{{"accessToken":"tok-123","expiresAt":{}}}}}"#,
                now.timestamp_millis() - 1
            ),
        );
        assert_eq!(
            claude_oauth_token(&path, now),
            Err(CLAUDE_LOGIN_EXPIRED.to_string())
        );
    }

    #[test]
    fn reports_not_logged_in_without_an_oauth_section() {
        let now = chrono::Utc::now();
        let missing = std::env::temp_dir().join("vb-claude-usage-none/.credentials.json");
        assert_eq!(
            claude_oauth_token(&missing, now),
            Err(CLAUDE_NOT_LOGGED_IN.to_string())
        );
        let mcp_only = write_credentials("mcp", r#"{"mcpOAuth":{}}"#);
        assert_eq!(
            claude_oauth_token(&mcp_only, now),
            Err(CLAUDE_NOT_LOGGED_IN.to_string())
        );
    }

    #[test]
    fn login_renewal_never_upgrades_claude_code() {
        assert_eq!(CLAUDE_RENEW_ARGS, ["auth", "status"]);
        assert!(!CLAUDE_RENEW_ARGS.contains(&"update"));
    }

    #[test]
    fn parses_five_hour_and_weekly_utilization() {
        let now = chrono::Utc::now();
        let payload = serde_json::json!({
            "five_hour": { "utilization": 38.0, "resets_at": "2026-10-18T14:00:00Z" },
            "seven_day": { "utilization": 61.5, "resets_at": "2026-10-21T08:00:00Z" },
            "seven_day_opus": null
        });
        let snapshot = parse_claude_usage(&payload, now).expect("snapshot");
        let limits = snapshot.rate_limits;
        assert_eq!(limits.provider.as_deref(), Some("claude-code"));
        assert_eq!(limits.source.as_deref(), Some("claude-oauth"));
        assert_eq!(limits.windows.len(), 2);
        assert_eq!(limits.windows[0].used_percent, 38.0);
        assert_eq!(limits.windows[1].remaining_percent, Some(38.5));
        assert!(limits.windows[1].resets_at.is_some());
    }

    #[test]
    fn ignores_a_response_without_both_windows() {
        let payload = serde_json::json!({ "five_hour": null, "seven_day": { "utilization": 10 } });
        assert!(parse_claude_usage(&payload, chrono::Utc::now()).is_none());
    }
}
