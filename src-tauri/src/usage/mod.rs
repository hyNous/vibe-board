//! Usage providers.
//!
//! Every provider implements the same pipeline — read credentials → fetch data
//! → normalize into one snapshot type — so the Usage page can render provider
//! rows without knowing anything provider-specific.
//!
//! Network policy (M8a): the only outgoing request in this module is the
//! pre-existing OpenCode Go usage call in [`opencode`], kept unchanged. All
//! other readers work on local files or local CLIs.

pub mod antigravity;
pub mod catalog;
pub mod claude;
pub mod codex;
pub mod history;
pub mod normalize;
pub mod opencode;

use crate::commands::AppState;
use crate::hooks::session_store::{RateLimitInfo, UsageRateWindow};
use futures_util::future::BoxFuture;
use tauri::State;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum UsageState {
    Ok,
    Disabled,
    Unauthorized,
    Unavailable,
    Failed,
    Unsupported,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum UsageAuthStatus {
    Authorized,
    Missing,
    #[default]
    Unknown,
}

impl UsageAuthStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Authorized => "authorized",
            Self::Missing => "missing",
            Self::Unknown => "unknown",
        }
    }
}

/// What the provider found while reading local credentials. Never carries a
/// credential value — only presence, path, and whether the CLI can authorize.
#[derive(Debug, Clone, Default)]
pub struct UsageCredential {
    pub status: UsageAuthStatus,
    pub path: Option<String>,
    pub can_authorize: bool,
}

#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageTokens {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_create: u64,
}

/// Equivalent cost for a model or a period, always presented as an estimate.
/// `complete` is false when some usage in the period has no price entry, so the
/// UI can mark the amount as a lower bound instead of pretending it is exact.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageCost {
    pub amount: f64,
    pub currency: String,
    pub effective_date: Option<String>,
    /// False when the maintainer has not yet confirmed this price entry.
    pub verified: bool,
    pub complete: bool,
}

/// One model's contribution to a period.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageModelPeriod {
    pub model: String,
    pub tokens: UsageTokens,
    pub requests: u64,
    /// `None` means the model is not in the built-in price table, so the cost is
    /// Unknown (never 0).
    pub cost: Option<UsageCost>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsagePeriod {
    /// Stable id used by the period switch: `today`, `week`, or `month`.
    pub id: String,
    /// `None` means the provider cannot report this period — the UI shows Unknown.
    pub tokens: Option<UsageTokens>,
    pub requests: Option<u64>,
    pub cost: Option<UsageCost>,
    pub models: Vec<UsageModelPeriod>,
    /// Models seen in this period that are missing from the price table; their
    /// cost is Unknown and the period estimate is only a lower bound.
    pub unpriced_models: Vec<String>,
}

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageHistory {
    pub available: bool,
    pub source: Option<String>,
    pub detail: String,
    pub sessions_scanned: Option<usize>,
    pub token_events: Option<usize>,
    pub pricing_effective_date: Option<String>,
    pub periods: Vec<UsagePeriod>,
}

#[derive(Debug, Clone, Default)]
pub struct UsageFetch {
    pub rate_limits: Option<RateLimitInfo>,
    pub history: UsageHistory,
    /// Source label when there is no `rate_limits` payload (catalog entries).
    pub source: Option<String>,
    pub detail: String,
    pub error: Option<String>,
}

pub(crate) const USAGE_PERIOD_IDS: [&str; 3] = ["today", "week", "month"];

pub(crate) fn unknown_history(detail: impl Into<String>) -> UsageHistory {
    UsageHistory {
        detail: detail.into(),
        periods: USAGE_PERIOD_IDS
            .iter()
            .map(|id| UsagePeriod {
                id: id.to_string(),
                tokens: None,
                requests: None,
                cost: None,
                models: Vec::new(),
                unpriced_models: Vec::new(),
            })
            .collect(),
        ..UsageHistory::default()
    }
}

/// One provider's normalized view: remaining quota, reset time, source,
/// freshness, and status, plus local token history when the provider has one.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    pub provider: String,
    pub label: String,
    pub state: UsageState,
    pub detail: String,
    pub source: Option<String>,
    pub fetched_at: Option<i64>,
    pub windows: Vec<UsageRateWindow>,
    pub history: UsageHistory,
    pub enabled: bool,
    pub catalog_supported: bool,
    pub implementation_status: String,
    /// Order in the settings list; `None` means the provider is catalog-only.
    pub settings_order: Option<u32>,
    pub auth_status: String,
    pub auth_path: Option<String>,
    pub can_authorize: bool,
}

pub trait UsageProvider: Send + Sync {
    fn id(&self) -> &'static str;
    fn label(&self) -> &'static str;

    /// Alternative ids accepted by `authorize_usage_provider`.
    fn aliases(&self) -> &'static [&'static str] {
        &[]
    }

    fn catalog_supported(&self) -> bool {
        true
    }

    fn implementation_status(&self) -> &'static str {
        if self.catalog_supported() {
            "available"
        } else {
            "unsupported"
        }
    }

    fn settings_order(&self) -> Option<u32> {
        None
    }

    /// Terminal command that starts this provider's official login flow.
    fn authorize_command(&self) -> Option<(&'static str, &'static [&'static str])> {
        None
    }

    /// Step 1 — read local credential presence. Never returns the secret value.
    fn read_credentials(&self) -> UsageCredential;

    /// Step 2 — fetch provider data. Local only, except the pre-existing
    /// OpenCode Go request.
    fn fetch<'a>(&'a self, live: bool) -> BoxFuture<'a, UsageFetch>;

    /// Step 3 — normalize credential + fetch into the shared snapshot type.
    fn normalize(
        &self,
        enabled: bool,
        credentials: UsageCredential,
        fetched: UsageFetch,
    ) -> UsageSnapshot;
}

pub(crate) fn resolve_state(
    provider: &dyn UsageProvider,
    enabled: bool,
    credentials: &UsageCredential,
    fetched: &UsageFetch,
) -> UsageState {
    if !enabled {
        return UsageState::Disabled;
    }
    if !provider.catalog_supported() {
        return UsageState::Unsupported;
    }
    if fetched.error.is_some() {
        return UsageState::Failed;
    }
    if fetched.rate_limits.is_some() || fetched.history.available {
        return UsageState::Ok;
    }
    if credentials.status == UsageAuthStatus::Missing {
        return UsageState::Unauthorized;
    }
    UsageState::Unavailable
}

pub(crate) fn build_snapshot(
    provider: &dyn UsageProvider,
    enabled: bool,
    credentials: &UsageCredential,
    fetched: &UsageFetch,
    state: UsageState,
    detail: String,
) -> UsageSnapshot {
    UsageSnapshot {
        provider: provider.id().to_string(),
        label: provider.label().to_string(),
        state,
        detail,
        source: fetched
            .rate_limits
            .as_ref()
            .and_then(|rate_limits| rate_limits.source.clone())
            .or_else(|| fetched.source.clone()),
        fetched_at: fetched
            .rate_limits
            .as_ref()
            .and_then(|rate_limits| rate_limits.updated_at),
        windows: fetched
            .rate_limits
            .as_ref()
            .map(normalize::windows_from_rate_limits)
            .unwrap_or_default(),
        history: fetched.history.clone(),
        enabled,
        catalog_supported: provider.catalog_supported(),
        implementation_status: provider.implementation_status().to_string(),
        settings_order: provider.settings_order(),
        auth_status: credentials.status.as_str().to_string(),
        auth_path: credentials.path.clone(),
        can_authorize: credentials.can_authorize,
    }
}

/// Runs the shared pipeline for one provider. The settings list has always
/// surfaced local provider state even while the query toggle is off, so
/// `enabled` only changes the reported state; the dashboard checks the toggle
/// before collecting at all.
pub async fn collect_snapshot(
    provider: &dyn UsageProvider,
    enabled: bool,
    live: bool,
) -> UsageSnapshot {
    let credentials = provider.read_credentials();
    let fetched = provider.fetch(live).await;
    provider.normalize(enabled, credentials, fetched)
}

fn disabled_snapshot(provider: &dyn UsageProvider) -> UsageSnapshot {
    let credentials = provider.read_credentials();
    let mut snapshot = provider.normalize(false, credentials, UsageFetch::default());
    snapshot.detail = "Usage query is disabled".to_string();
    snapshot.windows.clear();
    snapshot.history = UsageHistory::default();
    snapshot
}

pub fn all_providers() -> Vec<Box<dyn UsageProvider>> {
    let mut providers: Vec<Box<dyn UsageProvider>> = vec![
        Box::new(codex::CodexUsageProvider),
        Box::new(claude::ClaudeUsageProvider),
        Box::new(opencode::OpenCodeUsageProvider),
        Box::new(antigravity::AntigravityUsageProvider),
    ];
    providers.extend(catalog::supported_providers());
    providers.extend(catalog::unsupported_providers());
    providers.sort_by_key(|provider| provider.settings_order().unwrap_or(u32::MAX));
    providers
}

pub(crate) async fn dashboard_snapshots(enabled: bool) -> Vec<UsageSnapshot> {
    let mut snapshots = Vec::new();
    for provider in all_providers() {
        if provider.implementation_status() != "active" {
            continue;
        }
        snapshots.push(if enabled {
            collect_snapshot(provider.as_ref(), true, true).await
        } else {
            disabled_snapshot(provider.as_ref())
        });
    }
    snapshots
}

fn canonical_provider_id(provider_id: &str) -> String {
    all_providers()
        .into_iter()
        .find_map(|spec| {
            if spec.id() == provider_id || spec.aliases().contains(&provider_id) {
                Some(spec.id().to_string())
            } else {
                None
            }
        })
        .unwrap_or_else(|| provider_id.to_string())
}

pub(crate) fn merge_rate_limits(snapshot: &mut UsageSnapshot, rate_limits: &RateLimitInfo) {
    let incoming = rate_limits.updated_at.unwrap_or_default();
    if incoming <= snapshot.fetched_at.unwrap_or_default() {
        return;
    }
    snapshot.source = rate_limits.source.clone();
    snapshot.fetched_at = rate_limits.updated_at;
    snapshot.windows = normalize::windows_from_rate_limits(rate_limits);
    if snapshot.state != UsageState::Ok {
        snapshot.state = UsageState::Ok;
        snapshot.detail = "Live hook session rate limits".to_string();
    }
}

// ── Legacy readers kept for the island / agent status commands ───────────

pub async fn load_usage_snapshots() -> Vec<RateLimitInfo> {
    [
        codex::load_rate_limits(true).await,
        claude::load_rate_limits(),
        opencode::load_rate_limits().await,
        antigravity::load_rate_limits().await,
    ]
    .into_iter()
    .flatten()
    .collect()
}

pub async fn load_latest_usage_rate_limits() -> Option<RateLimitInfo> {
    load_usage_snapshots()
        .await
        .into_iter()
        .max_by_key(|rate_limits| rate_limits.updated_at)
}

// ── Tauri commands ───────────────────────────────────────────────────────

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageDashboard {
    pub providers: Vec<UsageSnapshot>,
    pub computed_at: i64,
    /// When the built-in price table used for the cost estimates took effect.
    pub pricing_effective_date: Option<String>,
}

#[tauri::command]
pub async fn get_usage_dashboard(state: State<'_, AppState>) -> Result<UsageDashboard, String> {
    let enabled = state.config_store.get().usage_query_enabled;
    let mut providers = dashboard_snapshots(enabled).await;

    if enabled {
        // Rate limits reported by live hook sessions are one of the local
        // sources the page already showed; keep merging them by provider id.
        for status in state.session_store.get_agent_status_snapshots() {
            let Some(rate_limits) = status.rate_limits else {
                continue;
            };
            let Some(provider_id) = rate_limits.provider.as_deref() else {
                continue;
            };
            let canonical_id = canonical_provider_id(provider_id);
            if let Some(snapshot) = providers
                .iter_mut()
                .find(|snapshot| snapshot.provider == canonical_id)
            {
                merge_rate_limits(snapshot, &rate_limits);
            }
        }
    }

    Ok(UsageDashboard {
        providers,
        computed_at: chrono::Utc::now().timestamp_millis(),
        pricing_effective_date: history::global_pricing_effective_date(),
    })
}

#[tauri::command]
pub async fn list_usage_providers(
    state: State<'_, AppState>,
    live: Option<bool>,
) -> Result<Vec<UsageSnapshot>, String> {
    let enabled = state.config_store.get().usage_query_enabled;
    let live = live.unwrap_or(true);
    let mut providers = Vec::new();
    for provider in all_providers() {
        providers.push(collect_snapshot(provider.as_ref(), enabled, live).await);
    }
    Ok(providers)
}

/// Opens the provider's own login flow in a terminal. Behavior is unchanged
/// from the original command; only the provider lookup moved into the registry.
#[tauri::command]
pub async fn authorize_usage_provider(provider: String) -> Result<(), String> {
    let Some((binary, args)) = authorize_target(&provider) else {
        return Err(format!("Unsupported usage provider: {provider}"));
    };

    let Some(binary_path) = crate::commands::find_binary(binary) else {
        return Err(format!("{} CLI not found in PATH.", binary));
    };
    let command = std::iter::once(crate::commands::shell_quote(&binary_path))
        .chain(args.iter().map(|arg| crate::commands::shell_quote(arg)))
        .collect::<Vec<_>>()
        .join(" ");
    let cwd = dirs::home_dir()
        .unwrap_or_else(std::env::temp_dir)
        .to_string_lossy()
        .to_string();
    crate::commands::launch_in_terminal("Terminal", &cwd, &command)
}

fn authorize_target(provider: &str) -> Option<(&'static str, &'static [&'static str])> {
    all_providers().into_iter().find_map(|spec| {
        if spec.id() == provider || spec.aliases().contains(&provider) {
            spec.authorize_command()
        } else {
            None
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;

    const USAGE_SOURCE_FILES: [&str; 11] = [
        "mod.rs",
        "normalize.rs",
        "codex.rs",
        "claude.rs",
        "opencode.rs",
        "antigravity.rs",
        "catalog.rs",
        "history/mod.rs",
        "history/scanner.rs",
        "history/store.rs",
        "history/pricing.rs",
    ];

    /// M8a network guard: new usage code must not add HTTP clients. The one
    /// allowed exception is the pre-existing OpenCode Go usage request, which
    /// is kept unchanged in `opencode.rs`.
    #[test]
    fn usage_module_only_existing_opencode_call_uses_an_http_client() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join("usage");
        for file in USAGE_SOURCE_FILES {
            let source = fs::read_to_string(root.join(file)).expect("read usage source");
            let production = source
                .split("#[cfg(test)]")
                .next()
                .expect("usage source before tests");
            if file == "opencode.rs" {
                assert_eq!(
                    production.matches("reqwest::Client").count(),
                    1,
                    "opencode.rs must keep exactly the one pre-existing HTTP client"
                );
                assert!(production.contains("const OPENCODE_GO_USAGE_URL"));
                assert!(production.contains("https://opencode.ai/zen/go/v1/usage"));
                continue;
            }
            for forbidden in ["reqwest", "http://", "https://", ".send()"] {
                assert!(
                    !production.contains(forbidden),
                    "{file} must not contain `{forbidden}` — M8a adds no network calls"
                );
            }
        }
    }

    #[tokio::test]
    async fn catalog_providers_share_the_same_snapshot_shape() {
        let unsupported = catalog::unsupported_providers()
            .into_iter()
            .find(|provider| provider.id() == "qoder")
            .expect("qoder catalog entry");
        let snapshot = unsupported.normalize(
            true,
            unsupported.read_credentials(),
            UsageFetch {
                detail: "No usage reader is available for this Agent yet.".to_string(),
                ..UsageFetch::default()
            },
        );
        assert_eq!(snapshot.state, UsageState::Unsupported);
        assert_eq!(snapshot.implementation_status, "unsupported");
        assert!(!snapshot.catalog_supported);
        assert!(snapshot.windows.is_empty());
        assert_eq!(snapshot.history.periods.len(), 0);

        let known = catalog::supported_providers()
            .into_iter()
            .find(|provider| provider.id() == "kimi")
            .expect("kimi catalog entry");
        let snapshot = known.normalize(true, known.read_credentials(), known.fetch(true).await);
        assert_eq!(snapshot.state, UsageState::Unavailable);
        assert!(snapshot.settings_order.is_some());
        assert_eq!(snapshot.auth_status, "unknown");
    }

    #[tokio::test]
    async fn disabled_providers_never_reread_or_fetch_usage() {
        let providers = all_providers();
        let codex = providers
            .iter()
            .find(|provider| provider.id() == "codex")
            .expect("codex provider");
        let snapshot = disabled_snapshot(codex.as_ref());
        assert_eq!(snapshot.state, UsageState::Disabled);
        assert!(snapshot.windows.is_empty());
        assert!(!snapshot.history.available);
        assert_eq!(snapshot.detail, "Usage query is disabled");
    }

    #[test]
    fn provider_registry_orders_settings_entries_before_catalog_only_ones() {
        let providers = all_providers();
        let ids = providers
            .iter()
            .map(|provider| provider.id())
            .collect::<Vec<_>>();
        assert_eq!(ids[0], "codex");
        assert_eq!(ids[1], "claude-code");
        assert!(ids.contains(&"opencode"));
        assert!(ids.contains(&"antigravity"));
        let opencode_index = ids.iter().position(|id| *id == "opencode").unwrap();
        let droid_index = ids.iter().position(|id| *id == "droid").unwrap();
        assert!(opencode_index < droid_index);
        assert_eq!(
            providers
                .iter()
                .filter(|provider| provider.settings_order().is_none())
                .count(),
            9
        );
    }

    #[test]
    fn authorize_lookup_keeps_the_original_aliases() {
        assert_eq!(
            authorize_target("codex"),
            Some(("codex", ["login"].as_slice()))
        );
        assert_eq!(
            authorize_target("claude"),
            Some(("claude", ["login"].as_slice()))
        );
        assert_eq!(
            authorize_target("gemini"),
            Some(("gemini", ["auth"].as_slice()))
        );
        assert_eq!(
            authorize_target("copilot"),
            Some(("gh", ["auth", "login"].as_slice()))
        );
        assert_eq!(authorize_target("unknown-provider"), None);
    }
}
