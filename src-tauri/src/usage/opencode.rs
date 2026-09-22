// OpenCode usage provider. The online query (the pre-existing OpenCode Go
// request, migrated unchanged from `commands/mod.rs`) runs only after the user
// authorized this provider; nothing else in this module touches the network.

use super::normalize::{remaining_label, usage_window, used_percentage};
use super::{
    build_snapshot, resolve_state, unknown_history, UsageCredential, UsageFetch, UsageNetworkKind,
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

/// Pre-existing OpenCode Go usage endpoint (authorized by the user's API key).
/// Kept unchanged; the only outgoing request in this module.
const OPENCODE_GO_USAGE_URL: &str = "https://opencode.ai/zen/go/v1/usage";
const OPENCODE_USAGE_CACHE_TTL: Duration = Duration::from_secs(60);
const OPENCODE_USAGE_TIMEOUT: Duration = Duration::from_secs(10);
const OPENCODE_NO_API_KEY: &str = "no local OpenCode API key was found";
const OPENCODE_REDACTED: &str = "[redacted]";

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

    fn network_plan(&self) -> UsageNetworkPlan {
        UsageNetworkPlan {
            kind: Some(UsageNetworkKind::Http),
            target: Some(OPENCODE_GO_USAGE_URL),
            credential: opencode_auth_path().map(|path| path.display().to_string()),
            unsupported_reason: None,
        }
    }

    fn fetch_local<'a>(&'a self) -> BoxFuture<'a, UsageFetch> {
        async move {
            let presence = opencode_presence();
            let has_api_key = load_opencode_api_key().is_some();

            let detail = if presence.has_auth || has_api_key {
                "OpenCode auth found; no local quota source.".to_string()
            } else if presence.has_config {
                "OpenCode config found; run OpenCode provider authorization if usage data is needed."
                    .to_string()
            } else {
                "OpenCode config directory was not found.".to_string()
            };

            UsageFetch {
                history: unknown_history("No local OpenCode token history reader yet"),
                detail,
                ..UsageFetch::default()
            }
        }
        .boxed()
    }

    fn fetch_network<'a>(&'a self) -> BoxFuture<'a, UsageFetch> {
        async move {
            let (snapshot, error) = load_opencode_usage_rate_limits().await;
            let detail = if snapshot.is_some() {
                "OpenCode Go account quota found.".to_string()
            } else if let Some(error) = &error {
                format!("OpenCode usage request failed: {error}")
            } else {
                "No OpenCode Go account quota data is available yet.".to_string()
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
pub(crate) async fn load_rate_limits() -> Option<RateLimitInfo> {
    load_opencode_usage_rate_limits()
        .await
        .0
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

fn opencode_auth_path() -> Option<PathBuf> {
    dirs::home_dir().map(|home| opencode_auth_path_from(&home))
}

fn opencode_auth_path_from(home: &Path) -> PathBuf {
    home.join(".local")
        .join("share")
        .join("opencode")
        .join("auth.json")
}

fn opencode_presence() -> OpenCodePresence {
    let home = dirs::home_dir();
    let config_dir = home
        .as_ref()
        .map(|home| home.join(".config").join("opencode"));
    let auth_path = home.as_ref().map(|home| opencode_auth_path_from(home));
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
    error: Option<String>,
}

async fn load_opencode_usage_rate_limits() -> (
    Option<super::normalize::UsageRateLimitSnapshot>,
    Option<String>,
) {
    static CACHE: OnceLock<TokioMutex<OpenCodeUsageCache>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| TokioMutex::new(OpenCodeUsageCache::default()));
    {
        let cached = cache.lock().await;
        if cached
            .fetched_at
            .is_some_and(|fetched_at| fetched_at.elapsed() < OPENCODE_USAGE_CACHE_TTL)
        {
            return (cached.snapshot.clone(), visible_error(&cached));
        }
    }

    let fresh = fetch_opencode_usage_rate_limits().await;
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

/// A stale snapshot still counts as data; the failure reason is only surfaced
/// when there is nothing to show.
fn visible_error(cached: &OpenCodeUsageCache) -> Option<String> {
    if cached.snapshot.is_some() {
        None
    } else {
        cached.error.clone()
    }
}

async fn fetch_opencode_usage_rate_limits() -> (
    Option<super::normalize::UsageRateLimitSnapshot>,
    Option<String>,
) {
    let Some(api_key) = load_opencode_api_key() else {
        return (None, Some(OPENCODE_NO_API_KEY.to_string()));
    };
    fetch_opencode_usage_with_key(&api_key).await
}

async fn fetch_opencode_usage_with_key(
    api_key: &str,
) -> (
    Option<super::normalize::UsageRateLimitSnapshot>,
    Option<String>,
) {
    match request_opencode_usage_payload(api_key).await {
        Ok(payload) => match parse_opencode_usage_payload(&payload, chrono::Utc::now()) {
            Some(snapshot) => (Some(snapshot), None),
            None => (
                None,
                Some("the provider response did not contain quota windows".to_string()),
            ),
        },
        Err(error) => {
            let error = redact_secret(&error, api_key);
            log::debug!("OpenCode usage request failed: {error}");
            (None, Some(error))
        }
    }
}

/// The credential value must never reach a log, an error string, or the UI.
fn redact_secret(message: &str, secret: &str) -> String {
    if secret.is_empty() {
        return message.to_string();
    }
    message.replace(secret, OPENCODE_REDACTED)
}

async fn request_opencode_usage_payload(api_key: &str) -> Result<serde_json::Value, String> {
    if let Some(result) = test_http_response(api_key) {
        return result;
    }

    let client = reqwest::Client::builder()
        .timeout(OPENCODE_USAGE_TIMEOUT)
        .build()
        .map_err(|_| "could not create the HTTP client".to_string())?;
    let response = client
        .get(OPENCODE_GO_USAGE_URL)
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|error| redact_secret(&format!("{error}"), api_key))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("HTTP {}", status.as_u16()));
    }
    response
        .json::<serde_json::Value>()
        .await
        .map_err(|error| redact_secret(&format!("{error}"), api_key))
}

#[cfg(not(test))]
fn test_http_response(_api_key: &str) -> Option<Result<serde_json::Value, String>> {
    None
}

#[cfg(test)]
fn test_http_response(api_key: &str) -> Option<Result<serde_json::Value, String>> {
    http_stub::call(api_key)
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

    load_opencode_api_key_from(&dirs::home_dir()?)
}

fn load_opencode_api_key_from(home: &Path) -> Option<String> {
    let path = opencode_auth_path_from(home);
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
mod http_stub {
    use std::sync::Mutex;

    type Stub = Box<dyn Fn(&str) -> Result<serde_json::Value, String> + Send + Sync>;

    static STUB: Mutex<Option<Stub>> = Mutex::new(None);

    pub(super) fn set(stub: Stub) {
        *STUB.lock().unwrap_or_else(|error| error.into_inner()) = Some(stub);
    }

    pub(super) fn clear() {
        *STUB.lock().unwrap_or_else(|error| error.into_inner()) = None;
    }

    pub(super) fn call(api_key: &str) -> Option<Result<serde_json::Value, String>> {
        STUB.lock()
            .unwrap_or_else(|error| error.into_inner())
            .as_ref()
            .map(|stub| stub(api_key))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    const FAKE_API_KEY: &str = "sk-fake-opencode-credential-marker";
    const FAKE_USAGE_PAYLOAD: &str = r#"{"usage":{"rolling":{"status":"ok","percent":12,"resetsAt":"2026-09-02T05:00:00Z"},"weekly":{"status":"ok","percent":8,"resetsAt":"2026-09-07T00:00:00Z"},"monthly":{"status":"ok","percent":3,"resetsAt":"2026-10-01T00:00:00Z"}}}"#;

    /// Serializes the stub so the HTTP seam and the log buffer are not shared
    /// across parallel tests.
    static STUB_LOCK: Mutex<()> = Mutex::new(());

    static LOGS: Mutex<Vec<String>> = Mutex::new(Vec::new());
    static CAPTURE_LOGGER: CaptureLogger = CaptureLogger;
    static LOGGER_READY: OnceLock<()> = OnceLock::new();

    struct CaptureLogger;

    impl log::Log for CaptureLogger {
        fn enabled(&self, _metadata: &log::Metadata) -> bool {
            true
        }

        fn log(&self, record: &log::Record) {
            LOGS.lock()
                .unwrap_or_else(|error| error.into_inner())
                .push(record.args().to_string());
        }

        fn flush(&self) {}
    }

    fn init_log_capture() {
        LOGGER_READY.get_or_init(|| {
            let _ = log::set_logger(&CAPTURE_LOGGER);
            log::set_max_level(log::LevelFilter::Debug);
        });
    }

    fn captured_logs() -> Vec<String> {
        LOGS.lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    fn clear_logs() {
        LOGS.lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
    }

    fn write_fake_credentials(home: &Path) {
        let path = opencode_auth_path_from(home);
        fs::create_dir_all(path.parent().expect("auth parent")).expect("auth dir");
        fs::write(
            &path,
            format!(r#"{{"opencode-go":{{"type":"api","key":"{FAKE_API_KEY}"}}}}"#),
        )
        .expect("write auth file");
    }

    fn assert_no_credential_value(text: &str) {
        assert!(
            !text.contains(FAKE_API_KEY),
            "the credential value leaked into: {text}"
        );
    }

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

    #[tokio::test]
    async fn credential_file_success_path_never_exposes_the_key() {
        let _guard = STUB_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        init_log_capture();
        clear_logs();

        let home = std::env::temp_dir().join(format!(
            "vibeboard-opencode-leak-ok-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time")
                .as_nanos()
        ));
        write_fake_credentials(&home);

        let api_key = load_opencode_api_key_from(&home).expect("credential file key");
        assert_eq!(api_key, FAKE_API_KEY);

        let seen_keys = std::sync::Arc::new(Mutex::new(Vec::new()));
        let recorder = std::sync::Arc::clone(&seen_keys);
        http_stub::set(Box::new(move |key: &str| {
            recorder
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .push(key.to_string());
            Ok(serde_json::from_str(FAKE_USAGE_PAYLOAD).expect("payload"))
        }));

        let (snapshot, error) = fetch_opencode_usage_with_key(&api_key).await;
        http_stub::clear();

        assert_eq!(
            seen_keys
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .as_slice(),
            &[FAKE_API_KEY.to_string()],
            "the request must read the credential file"
        );
        assert!(error.is_none());
        let snapshot = snapshot.expect("quota snapshot");
        assert_eq!(snapshot.rate_limits.five_hour_usage, 12.0);

        assert_no_credential_value(&snapshot.rate_limits.five_hour_remaining);
        assert_no_credential_value(&serde_json::to_string(&snapshot.rate_limits).expect("json"));
        for line in captured_logs() {
            assert_no_credential_value(&line);
        }

        let _ = fs::remove_dir_all(&home);
    }

    #[tokio::test]
    async fn credential_file_failure_path_never_exposes_the_key() {
        let _guard = STUB_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        init_log_capture();
        clear_logs();

        let home = std::env::temp_dir().join(format!(
            "vibeboard-opencode-leak-fail-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time")
                .as_nanos()
        ));
        write_fake_credentials(&home);
        let api_key = load_opencode_api_key_from(&home).expect("credential file key");

        http_stub::set(Box::new(move |key: &str| {
            // Worst case: the provider echoes the credential back in an error.
            Err(format!("provider rejected credential {key}"))
        }));

        let (snapshot, error) = fetch_opencode_usage_with_key(&api_key).await;
        http_stub::clear();

        assert!(snapshot.is_none());
        let error = error.expect("failure reason");
        assert_no_credential_value(&error);
        assert!(error.contains(OPENCODE_REDACTED));
        for line in captured_logs() {
            assert_no_credential_value(&line);
        }

        let _ = fs::remove_dir_all(&home);
    }

    #[tokio::test]
    async fn unauthorized_provider_does_not_reach_the_http_stub() {
        let _guard = STUB_LOCK.lock().unwrap_or_else(|error| error.into_inner());
        let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = std::sync::Arc::clone(&calls);
        http_stub::set(Box::new(move |_key: &str| {
            counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(serde_json::from_str(FAKE_USAGE_PAYLOAD).expect("payload"))
        }));

        let snapshot =
            super::super::collect_snapshot(&OpenCodeUsageProvider, true, true, false).await;
        http_stub::clear();

        assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);
        assert!(!snapshot.network_authorized);
        assert!(snapshot.windows.is_empty());
        assert!(snapshot.detail.contains("not authorized"));
    }

    #[test]
    fn network_plan_points_at_the_endpoint_and_credential_file() {
        let plan = OpenCodeUsageProvider.network_plan();
        assert_eq!(plan.kind, Some(UsageNetworkKind::Http));
        assert_eq!(plan.target, Some(OPENCODE_GO_USAGE_URL));
        let credential = plan.credential.expect("credential path");
        assert!(credential.ends_with("auth.json"), "{credential}");
        assert!(!credential.contains(FAKE_API_KEY));
    }
}
