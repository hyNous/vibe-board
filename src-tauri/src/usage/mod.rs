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
use futures_util::FutureExt;
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

/// How an authorized provider is queried: an HTTP endpoint, or a local program
/// that performs the provider request itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum UsageNetworkKind {
    Http,
    Cli,
}

/// What the user is asked to approve before a provider may query online. It
/// never carries a credential value — only the file location to display.
#[derive(Debug, Clone, Default)]
pub struct UsageNetworkPlan {
    pub kind: Option<UsageNetworkKind>,
    /// Endpoint URL (HTTP) or the local program command (CLI).
    pub target: Option<&'static str>,
    /// Local credential file the query reads, if any.
    pub credential: Option<String>,
    /// Stable reason code when online querying is deliberately not wired yet.
    pub unsupported_reason: Option<&'static str>,
}

impl UsageNetworkPlan {
    fn is_supported(&self) -> bool {
        self.kind.is_some()
    }
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
    /// True when this provider has a wired online query path (M8c).
    pub network_supported: bool,
    /// True when the user explicitly allowed this provider's online query.
    /// Nothing is requested while this is false.
    pub network_authorized: bool,
    /// `http` or `cli`; `None` when online querying is not supported.
    pub network_kind: Option<UsageNetworkKind>,
    /// Endpoint URL or local program command shown in the confirmation.
    pub network_target: Option<String>,
    /// Local credential file location (never the value).
    pub network_credential: Option<String>,
    /// Reason code shown when online querying is not wired (for example
    /// `unverified` for Claude Code).
    pub network_unsupported_reason: Option<String>,
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

    /// What online querying would do, and which credential file it reads.
    /// Providers without a verified online path return the default plan.
    fn network_plan(&self) -> UsageNetworkPlan {
        UsageNetworkPlan::default()
    }

    /// True when [`UsageProvider::fetch_network`] may reach the network or
    /// launch a provider-owned process. Derived from the network plan.
    fn requires_network(&self) -> bool {
        self.network_plan().is_supported()
    }

    /// Step 2a — local-only data (session logs, local statusline files). Always
    /// allowed; never starts a provider process or an HTTP request.
    fn fetch_local<'a>(&'a self) -> BoxFuture<'a, UsageFetch>;

    /// Step 2b — the provider query. Called only after the user authorized
    /// this provider; implementations must not be reached otherwise.
    fn fetch_network<'a>(&'a self) -> BoxFuture<'a, UsageFetch> {
        async { UsageFetch::default() }.boxed()
    }

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
    let plan = provider.network_plan();
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
        network_supported: plan.is_supported(),
        network_authorized: false,
        network_kind: plan.kind,
        network_target: plan.target.map(str::to_string),
        network_credential: plan.credential.clone(),
        network_unsupported_reason: plan.unsupported_reason.map(str::to_string),
    }
}

/// Keeps local data when the provider query fails or returns nothing, and lets
/// a successful query replace the local rate-limit snapshot.
fn merge_usage_fetch(local: UsageFetch, network: UsageFetch) -> UsageFetch {
    let mut merged = local;
    match network.rate_limits {
        Some(rate_limits) => {
            merged.rate_limits = Some(rate_limits);
            merged.source = network.source;
            merged.error = None;
            if !network.detail.is_empty() {
                merged.detail = network.detail;
            }
        }
        None => {
            if merged.rate_limits.is_none() {
                merged.error = network.error;
                if !network.detail.is_empty() {
                    merged.detail = network.detail;
                }
            } else if let Some(error) = network.error {
                if !merged.detail.is_empty() {
                    merged.detail.push(' ');
                }
                merged
                    .detail
                    .push_str(&format!("Live query failed: {error}"));
            }
        }
    }
    if network.history.available {
        merged.history = network.history;
    }
    merged
}

pub(crate) fn is_network_authorized(authorized: &[String], provider_id: &str) -> bool {
    authorized.iter().any(|id| id == provider_id)
}

/// Runs the shared pipeline for one provider. Local sources always run; the
/// online query runs only when the user authorized this provider and a live
/// refresh was requested.
pub async fn collect_snapshot(
    provider: &dyn UsageProvider,
    enabled: bool,
    live: bool,
    network_authorized: bool,
) -> UsageSnapshot {
    let credentials = provider.read_credentials();
    let mut fetched = provider.fetch_local().await;
    let authorized = network_authorized && provider.requires_network();
    if authorized && live {
        fetched = merge_usage_fetch(fetched, provider.fetch_network().await);
    } else if provider.requires_network() && !network_authorized {
        if !fetched.detail.is_empty() {
            fetched.detail.push(' ');
        }
        fetched
            .detail
            .push_str("Online usage query is not authorized.");
    }
    let mut snapshot = provider.normalize(enabled, credentials, fetched);
    snapshot.network_authorized = authorized;
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

pub(crate) async fn dashboard_snapshots(
    enabled: bool,
    network_authorized: &[String],
) -> Vec<UsageSnapshot> {
    let mut snapshots = Vec::new();
    for provider in all_providers() {
        if provider.implementation_status() != "active" {
            continue;
        }
        let authorized = is_network_authorized(network_authorized, provider.id());
        snapshots.push(collect_snapshot(provider.as_ref(), enabled, true, authorized).await);
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

/// Local-only readers always run; the provider queries run only for providers
/// the user authorized.
pub async fn load_usage_snapshots(network_authorized: &[String]) -> Vec<RateLimitInfo> {
    let mut snapshots = Vec::new();
    snapshots.extend(codex::load_local_rate_limits());
    snapshots.extend(claude::load_rate_limits());
    if is_network_authorized(network_authorized, "codex") {
        snapshots.extend(codex::load_live_rate_limits().await);
    }
    if is_network_authorized(network_authorized, "opencode") {
        snapshots.extend(opencode::load_rate_limits().await);
    }
    if is_network_authorized(network_authorized, "antigravity") {
        snapshots.extend(antigravity::load_rate_limits().await);
    }
    snapshots
}

pub async fn load_latest_usage_rate_limits(network_authorized: &[String]) -> Option<RateLimitInfo> {
    load_usage_snapshots(network_authorized)
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
    let config = state.config_store.get();
    let enabled = config.usage_query_enabled;
    let mut providers =
        dashboard_snapshots(enabled, &config.usage_network_authorized_providers).await;

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
    let config = state.config_store.get();
    let enabled = config.usage_query_enabled;
    let live = live.unwrap_or(true);
    let mut providers = Vec::new();
    for provider in all_providers() {
        let authorized =
            is_network_authorized(&config.usage_network_authorized_providers, provider.id());
        providers.push(collect_snapshot(provider.as_ref(), enabled, live, authorized).await);
    }
    Ok(providers)
}

/// Grants or revokes one provider's permission to query online. Revoking takes
/// effect for every later request; nothing is queried while the id is absent.
#[tauri::command]
pub async fn set_usage_network_authorization(
    state: State<'_, AppState>,
    provider: String,
    authorized: bool,
) -> Result<Vec<String>, String> {
    let canonical_id = canonical_provider_id(&provider);
    let Some(spec) = all_providers()
        .into_iter()
        .find(|spec| spec.id() == canonical_id)
    else {
        return Err(format!("Unsupported usage provider: {provider}"));
    };
    if authorized && !spec.requires_network() {
        return Err(format!(
            "{} has no verified online usage query.",
            spec.label()
        ));
    }

    let mut config = state.config_store.get();
    config
        .usage_network_authorized_providers
        .retain(|id| id != &canonical_id);
    if authorized {
        config
            .usage_network_authorized_providers
            .push(canonical_id.clone());
    }
    config.usage_network_authorized_providers.sort();
    config.usage_network_authorized_providers.dedup();
    state.config_store.update(config)?;
    Ok(state.config_store.get().usage_network_authorized_providers)
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
    use futures_util::FutureExt;
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
        assert!(!snapshot.network_supported);

        let known = catalog::supported_providers()
            .into_iter()
            .find(|provider| provider.id() == "kimi")
            .expect("kimi catalog entry");
        let snapshot = known.normalize(true, known.read_credentials(), known.fetch_local().await);
        assert_eq!(snapshot.state, UsageState::Unavailable);
        assert!(snapshot.settings_order.is_some());
        assert_eq!(snapshot.auth_status, "unknown");
    }

    #[derive(Default)]
    struct StubCounters {
        local: std::sync::atomic::AtomicUsize,
        network: std::sync::atomic::AtomicUsize,
    }

    struct StubProvider {
        counters: std::sync::Arc<StubCounters>,
        plan: UsageNetworkPlan,
    }

    fn stub_plan() -> UsageNetworkPlan {
        UsageNetworkPlan {
            kind: Some(UsageNetworkKind::Http),
            target: Some("https://example.invalid/usage"),
            credential: Some("/tmp/stub-credentials.json".to_string()),
            unsupported_reason: None,
        }
    }

    impl UsageProvider for StubProvider {
        fn id(&self) -> &'static str {
            "stub"
        }

        fn label(&self) -> &'static str {
            "Stub"
        }

        fn implementation_status(&self) -> &'static str {
            "active"
        }

        fn read_credentials(&self) -> UsageCredential {
            UsageCredential::default()
        }

        fn network_plan(&self) -> UsageNetworkPlan {
            self.plan.clone()
        }

        fn fetch_local<'a>(&'a self) -> BoxFuture<'a, UsageFetch> {
            async move {
                self.counters
                    .local
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                UsageFetch {
                    detail: "Local stub data.".to_string(),
                    ..UsageFetch::default()
                }
            }
            .boxed()
        }

        fn fetch_network<'a>(&'a self) -> BoxFuture<'a, UsageFetch> {
            async move {
                self.counters
                    .network
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                UsageFetch {
                    rate_limits: Some(crate::hooks::session_store::RateLimitInfo {
                        five_hour_usage: 10.0,
                        five_hour_remaining: "90%".to_string(),
                        seven_day_usage: 20.0,
                        seven_day_remaining: "80%".to_string(),
                        provider: Some("stub".to_string()),
                        provider_label: Some("Stub".to_string()),
                        source: Some("stub-network".to_string()),
                        updated_at: Some(chrono::Utc::now().timestamp_millis()),
                        windows: Vec::new(),
                    }),
                    detail: "Network stub data.".to_string(),
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

    fn stub_provider() -> (StubProvider, std::sync::Arc<StubCounters>) {
        let counters = std::sync::Arc::new(StubCounters::default());
        (
            StubProvider {
                counters: std::sync::Arc::clone(&counters),
                plan: stub_plan(),
            },
            counters,
        )
    }

    #[tokio::test]
    async fn unauthorized_network_provider_never_calls_fetch_network() {
        let (provider, counters) = stub_provider();

        let snapshot = collect_snapshot(&provider, true, true, false).await;

        assert_eq!(
            counters.network.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "an unauthorized provider must not be queried"
        );
        assert_eq!(
            counters.local.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "local sources stay available without authorization"
        );
        assert!(!snapshot.network_authorized);
        assert!(snapshot.network_supported);
        assert_eq!(snapshot.network_target.as_deref(), stub_plan().target);
        assert!(snapshot.windows.is_empty());
        assert!(snapshot.detail.contains("not authorized"));
    }

    #[tokio::test]
    async fn authorized_network_provider_queries_only_on_a_live_refresh() {
        let (provider, counters) = stub_provider();

        let cached = collect_snapshot(&provider, true, false, true).await;
        assert_eq!(
            counters.network.load(std::sync::atomic::Ordering::SeqCst),
            0,
            "a non-live refresh must not query the provider"
        );
        assert!(cached.network_authorized);
        assert!(cached.windows.is_empty());

        let live = collect_snapshot(&provider, true, true, true).await;
        assert_eq!(
            counters.network.load(std::sync::atomic::Ordering::SeqCst),
            1
        );
        assert_eq!(live.state, UsageState::Ok);
        assert_eq!(live.source.as_deref(), Some("stub-network"));
        assert_eq!(live.windows.len(), 2);
    }

    #[tokio::test]
    async fn revoked_authorization_stops_further_queries() {
        let (provider, counters) = stub_provider();

        let authorized = collect_snapshot(&provider, true, true, true).await;
        assert_eq!(authorized.state, UsageState::Ok);

        let revoked = collect_snapshot(&provider, true, true, false).await;
        assert_eq!(
            counters.network.load(std::sync::atomic::Ordering::SeqCst),
            1,
            "revoking must not trigger another provider query"
        );
        assert!(!revoked.network_authorized);
        assert!(revoked.windows.is_empty());
    }

    #[test]
    fn network_plans_match_the_verified_provider_matrix() {
        let providers = all_providers();
        for id in ["codex", "opencode", "antigravity"] {
            let provider = providers
                .iter()
                .find(|provider| provider.id() == id)
                .unwrap_or_else(|| panic!("{id} provider"));
            assert!(
                provider.requires_network(),
                "{id} is a verified online provider"
            );
            assert!(provider.network_plan().target.is_some(), "{id} target");
        }

        let claude = providers
            .iter()
            .find(|provider| provider.id() == "claude-code")
            .expect("claude provider");
        assert!(
            !claude.requires_network(),
            "Claude Code's online query is unverified and must stay offline"
        );
        assert_eq!(claude.network_plan().unsupported_reason, Some("unverified"));

        let kimi = providers
            .iter()
            .find(|provider| provider.id() == "kimi")
            .expect("kimi catalog provider");
        assert!(!kimi.requires_network());
        assert_eq!(kimi.network_plan().unsupported_reason, None);
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
