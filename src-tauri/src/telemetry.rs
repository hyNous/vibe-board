use crate::config::AppConfig;
use chrono::{Datelike, Local};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

const SCHEMA_VERSION: &str = "1";
const DEFAULT_TOPIC: &str = "product-telemetry";
const DEFAULT_SOURCE: &str = "vibeboard";

#[derive(Debug, Clone)]
pub struct TelemetryConfiguration {
    sls_host: String,
    project: String,
    logstore: String,
    topic: String,
    source: String,
    daily_event_limit: usize,
}

impl TelemetryConfiguration {
    pub fn from_build_env() -> Self {
        Self::new(
            option_env!("VIBEBOARD_TELEMETRY_SLS_HOST")
                .or(option_env!("AGENT_ISLAND_TELEMETRY_SLS_HOST"))
                .unwrap_or(""),
            option_env!("VIBEBOARD_TELEMETRY_SLS_PROJECT")
                .or(option_env!("AGENT_ISLAND_TELEMETRY_SLS_PROJECT"))
                .unwrap_or(""),
            option_env!("VIBEBOARD_TELEMETRY_SLS_LOGSTORE")
                .or(option_env!("AGENT_ISLAND_TELEMETRY_SLS_LOGSTORE"))
                .unwrap_or(""),
        )
    }

    pub fn new(sls_host: &str, project: &str, logstore: &str) -> Self {
        Self {
            sls_host: normalize_host(sls_host),
            project: project.trim().to_string(),
            logstore: logstore.trim().to_string(),
            topic: DEFAULT_TOPIC.to_string(),
            source: DEFAULT_SOURCE.to_string(),
            daily_event_limit: 1,
        }
    }

    pub fn is_enabled(&self) -> bool {
        !self.sls_host.is_empty() && !self.project.is_empty() && !self.logstore.is_empty()
    }

    fn endpoint_url(&self) -> Option<String> {
        if !self.is_enabled() {
            return None;
        }
        Some(format!(
            "https://{}.{}/logstores/{}/track",
            self.project, self.sls_host, self.logstore
        ))
    }
}

fn normalize_host(value: &str) -> String {
    value
        .trim()
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_matches('/')
        .to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct DailyAggregate {
    app_launch_count: u32,
    session_count: u32,
    #[serde(default)]
    client_session_counts: BTreeMap<String, u32>,
    #[serde(default)]
    hook_install_counts: BTreeMap<String, u32>,
    #[serde(default)]
    hook_uninstall_counts: BTreeMap<String, u32>,
}

impl DailyAggregate {
    fn has_activity(&self) -> bool {
        self.app_launch_count > 0
            || self.session_count > 0
            || !self.client_session_counts.is_empty()
            || !self.hook_install_counts.is_empty()
            || !self.hook_uninstall_counts.is_empty()
    }
}

#[derive(Debug, Clone, Serialize)]
struct TelemetryRecord {
    fields: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
struct SlsPayload {
    #[serde(rename = "__topic__")]
    topic: String,
    #[serde(rename = "__source__")]
    source: String,
    #[serde(rename = "__logs__")]
    logs: Vec<BTreeMap<String, String>>,
    #[serde(rename = "__tags__")]
    tags: BTreeMap<String, String>,
}

#[derive(Clone)]
pub struct TelemetryService {
    configuration: TelemetryConfiguration,
    state_dir: PathBuf,
    client: reqwest::Client,
}

impl TelemetryService {
    pub fn new() -> Self {
        Self::with_configuration(TelemetryConfiguration::from_build_env())
    }

    fn with_configuration(configuration: TelemetryConfiguration) -> Self {
        let base = dirs::config_dir()
            .or_else(dirs::data_local_dir)
            .unwrap_or_else(std::env::temp_dir);
        let state_dir = base.join("vibeboard").join("telemetry");
        if !state_dir.exists() {
            for legacy in ["agent-island", "agentbro"] {
                let old_dir = base.join(legacy).join("telemetry");
                let _ = crate::data_dir::migrate_dir(&old_dir, &state_dir);
                if state_dir.exists() {
                    break;
                }
            }
        }
        Self {
            configuration,
            state_dir,
            client: reqwest::Client::new(),
        }
    }

    pub fn is_configured(&self) -> bool {
        self.configuration.is_enabled()
    }

    pub async fn handle_consent_changed(&self, config: &AppConfig) {
        if config.analytics_enabled {
            self.record_app_launch(config).await;
        } else {
            self.clear_state();
        }
    }

    pub async fn record_app_launch(&self, config: &AppConfig) {
        if !self.is_active(config) {
            return;
        }
        self.mutate_today(|aggregate| {
            aggregate.app_launch_count = aggregate.app_launch_count.saturating_add(1);
        });
        self.ensure_first_seen_date();
        self.upload_pending_daily_usage_snapshots(config).await;
    }

    pub async fn record_session_detected(&self, config: &AppConfig, client_id: &str) {
        if !self.is_active(config) {
            return;
        }
        let client_id = sanitized_value(client_id);
        self.mutate_today(|aggregate| {
            aggregate.session_count = aggregate.session_count.saturating_add(1);
            *aggregate
                .client_session_counts
                .entry(client_id)
                .or_insert(0) += 1;
        });
        self.upload_pending_daily_usage_snapshots(config).await;
    }

    pub async fn record_hook_install(&self, config: &AppConfig, tool_name: &str) {
        if !self.is_active(config) {
            return;
        }
        let tool_name = sanitized_value(tool_name);
        self.mutate_today(|aggregate| {
            *aggregate.hook_install_counts.entry(tool_name).or_insert(0) += 1;
        });
        self.upload_pending_daily_usage_snapshots(config).await;
    }

    pub async fn record_hook_uninstall(&self, config: &AppConfig, tool_name: &str) {
        if !self.is_active(config) {
            return;
        }
        let tool_name = sanitized_value(tool_name);
        self.mutate_today(|aggregate| {
            *aggregate
                .hook_uninstall_counts
                .entry(tool_name)
                .or_insert(0) += 1;
        });
        self.upload_pending_daily_usage_snapshots(config).await;
    }

    pub async fn upload_pending_daily_usage_snapshots(&self, config: &AppConfig) {
        if !self.is_active(config) {
            return;
        }

        let today = today_bucket();
        let mut buckets = self.aggregate_buckets();
        buckets.retain(|bucket| bucket != &today && !self.snapshot_uploaded(bucket));

        for bucket in buckets
            .into_iter()
            .take(self.configuration.daily_event_limit)
        {
            let Some(record) = self.daily_usage_record(&bucket) else {
                self.mark_snapshot_uploaded(&bucket);
                self.remove_aggregate(&bucket);
                continue;
            };
            if self.send_records(vec![record]).await.is_ok() {
                self.mark_snapshot_uploaded(&bucket);
                self.remove_aggregate(&bucket);
            } else {
                break;
            }
        }
    }

    fn is_active(&self, config: &AppConfig) -> bool {
        config.analytics_enabled && self.configuration.is_enabled()
    }

    async fn send_records(&self, records: Vec<TelemetryRecord>) -> Result<(), String> {
        let Some(endpoint) = self.configuration.endpoint_url() else {
            return Ok(());
        };
        if records.is_empty() {
            return Ok(());
        }

        let mut tags = BTreeMap::new();
        tags.insert("app".to_string(), "vibeboard".to_string());
        tags.insert("schema".to_string(), SCHEMA_VERSION.to_string());

        let payload = SlsPayload {
            topic: self.configuration.topic.clone(),
            source: self.configuration.source.clone(),
            logs: records.into_iter().map(|record| record.fields).collect(),
            tags,
        };
        let body = serde_json::to_vec(&payload).map_err(|e| e.to_string())?;
        let response = self
            .client
            .post(endpoint)
            .header("Content-Type", "application/json")
            .header("x-log-apiversion", "0.6.0")
            .header("x-log-bodyrawsize", body.len().to_string())
            .body(body)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if response.status().is_success() {
            Ok(())
        } else {
            Err(format!("SLS returned {}", response.status()))
        }
    }

    fn daily_usage_record(&self, bucket: &str) -> Option<TelemetryRecord> {
        let aggregate = self.read_aggregate(bucket);
        if !aggregate.has_activity() {
            return None;
        }

        let mut fields = common_fields();
        fields.insert("event".to_string(), "daily_usage_snapshot".to_string());
        fields.insert("schema_version".to_string(), SCHEMA_VERSION.to_string());
        fields.insert("report_date".to_string(), sanitized_value(bucket));
        fields.insert("active_device".to_string(), "true".to_string());
        fields.insert(
            "anonymous_device_id".to_string(),
            self.anonymous_device_id(),
        );
        fields.insert(
            "first_seen".to_string(),
            (self.first_seen_date().as_deref() == Some(bucket)).to_string(),
        );
        fields.insert(
            "app_launch_count".to_string(),
            aggregate.app_launch_count.to_string(),
        );
        fields.insert(
            "session_count".to_string(),
            aggregate.session_count.to_string(),
        );
        fields.insert(
            "client_session_counts".to_string(),
            compact_counts(&aggregate.client_session_counts),
        );
        fields.insert(
            "hook_install_counts".to_string(),
            compact_counts(&aggregate.hook_install_counts),
        );
        add_count_fields(&mut fields, "hook_install", &aggregate.hook_install_counts);
        fields.insert(
            "hook_uninstall_counts".to_string(),
            compact_counts(&aggregate.hook_uninstall_counts),
        );
        add_count_fields(
            &mut fields,
            "hook_uninstall",
            &aggregate.hook_uninstall_counts,
        );

        Some(TelemetryRecord { fields })
    }

    fn mutate_today(&self, update: impl FnOnce(&mut DailyAggregate)) {
        let bucket = today_bucket();
        let mut aggregate = self.read_aggregate(&bucket);
        update(&mut aggregate);
        self.write_aggregate(&bucket, &aggregate);
        self.remember_aggregate_bucket(&bucket);
    }

    fn read_aggregate(&self, bucket: &str) -> DailyAggregate {
        std::fs::read(self.aggregate_path(bucket))
            .ok()
            .and_then(|data| serde_json::from_slice(&data).ok())
            .unwrap_or_default()
    }

    fn write_aggregate(&self, bucket: &str, aggregate: &DailyAggregate) {
        let _ = std::fs::create_dir_all(&self.state_dir);
        if let Ok(data) = serde_json::to_vec(aggregate) {
            let _ = std::fs::write(self.aggregate_path(bucket), data);
        }
    }

    fn remove_aggregate(&self, bucket: &str) {
        let _ = std::fs::remove_file(self.aggregate_path(bucket));
    }

    fn aggregate_path(&self, bucket: &str) -> PathBuf {
        self.state_dir
            .join(format!("daily-{}.json", safe_file_key(bucket)))
    }

    fn aggregate_buckets(&self) -> Vec<String> {
        std::fs::read_to_string(self.buckets_path())
            .ok()
            .and_then(|content| serde_json::from_str::<Vec<String>>(&content).ok())
            .unwrap_or_default()
    }

    fn remember_aggregate_bucket(&self, bucket: &str) {
        let mut buckets = self
            .aggregate_buckets()
            .into_iter()
            .collect::<BTreeSet<_>>();
        buckets.insert(bucket.to_string());
        let _ = std::fs::create_dir_all(&self.state_dir);
        if let Ok(data) = serde_json::to_vec(&buckets.into_iter().collect::<Vec<_>>()) {
            let _ = std::fs::write(self.buckets_path(), data);
        }
    }

    fn buckets_path(&self) -> PathBuf {
        self.state_dir.join("daily-buckets.json")
    }

    fn snapshot_uploaded(&self, bucket: &str) -> bool {
        self.uploaded_path(bucket).exists()
    }

    fn mark_snapshot_uploaded(&self, bucket: &str) {
        let _ = std::fs::create_dir_all(&self.state_dir);
        let _ = std::fs::write(self.uploaded_path(bucket), b"true");
    }

    fn uploaded_path(&self, bucket: &str) -> PathBuf {
        self.state_dir
            .join(format!("uploaded-{}", safe_file_key(bucket)))
    }

    fn anonymous_device_id(&self) -> String {
        let path = self.state_dir.join("anonymous-device-id");
        if let Ok(id) = std::fs::read_to_string(&path) {
            let trimmed = id.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }

        let id = uuid::Uuid::new_v4().to_string();
        let _ = std::fs::create_dir_all(&self.state_dir);
        let _ = std::fs::write(path, &id);
        id
    }

    fn ensure_first_seen_date(&self) {
        if self.first_seen_date().is_some() {
            return;
        }
        let _ = std::fs::create_dir_all(&self.state_dir);
        let _ = std::fs::write(self.state_dir.join("first-seen-date"), today_bucket());
    }

    fn first_seen_date(&self) -> Option<String> {
        std::fs::read_to_string(self.state_dir.join("first-seen-date"))
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    }

    fn clear_state(&self) {
        let _ = std::fs::remove_dir_all(&self.state_dir);
    }
}

impl Default for TelemetryService {
    fn default() -> Self {
        Self::new()
    }
}

fn common_fields() -> BTreeMap<String, String> {
    let mut fields = BTreeMap::new();
    fields.insert(
        "app_version".to_string(),
        env!("CARGO_PKG_VERSION").to_string(),
    );
    fields.insert("os".to_string(), std::env::consts::OS.to_string());
    fields.insert("arch".to_string(), std::env::consts::ARCH.to_string());
    fields.insert("language".to_string(), language_bucket());
    fields.insert("install_channel".to_string(), install_channel());
    fields
}

fn today_bucket() -> String {
    let today = Local::now().date_naive();
    format!("{}-{:02}-{:02}", today.year(), today.month(), today.day())
}

fn language_bucket() -> String {
    let raw = std::env::var("LANG").unwrap_or_default().to_lowercase();
    if raw.starts_with("zh") {
        "zh".to_string()
    } else if raw.starts_with("ja") {
        "ja".to_string()
    } else if raw.starts_with("ko") {
        "ko".to_string()
    } else if raw.starts_with("tr") {
        "tr".to_string()
    } else if raw.starts_with("en") {
        "en".to_string()
    } else {
        "other".to_string()
    }
}

fn install_channel() -> String {
    if PathBuf::from("/opt/homebrew/Caskroom/agent-island").exists()
        || PathBuf::from("/usr/local/Caskroom/agent-island").exists()
    {
        return "homebrew".to_string();
    }

    let exe = std::env::current_exe()
        .ok()
        .map(|path| path.display().to_string())
        .unwrap_or_default();
    if exe.contains("/Applications/Vibe Board.app/") {
        "github_dmg".to_string()
    } else {
        "dev".to_string()
    }
}

fn compact_counts(counts: &BTreeMap<String, u32>) -> String {
    if counts.is_empty() {
        return "none".to_string();
    }
    counts
        .iter()
        .take(12)
        .map(|(key, value)| format!("{}={}", sanitized_value(key), value))
        .collect::<Vec<_>>()
        .join(",")
}

fn add_count_fields(
    fields: &mut BTreeMap<String, String>,
    prefix: &str,
    counts: &BTreeMap<String, u32>,
) {
    let total = counts.values().copied().sum::<u32>();
    fields.insert(format!("{}_total", prefix), total.to_string());
    for (key, value) in counts.iter().take(12) {
        fields.insert(format!("{}_{}", prefix, metric_key(key)), value.to_string());
    }
}

fn sanitized_value(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric()
                || matches!(ch, '.' | '_' | '-' | ':' | ',' | ';' | '|' | '=' | ' ')
            {
                ch
            } else {
                '_'
            }
        })
        .take(160)
        .collect()
}

fn metric_key(value: &str) -> String {
    let key = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .take(80)
        .collect::<String>()
        .trim_matches('_')
        .to_string();
    if key.is_empty() {
        "unknown".to_string()
    } else {
        key
    }
}

fn safe_file_key(value: &str) -> String {
    sanitized_value(value).replace(' ', "_")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_without_complete_sls_target() {
        assert!(!TelemetryConfiguration::new("", "project", "logstore").is_enabled());
        assert!(!TelemetryConfiguration::new("host", "", "logstore").is_enabled());
        assert!(!TelemetryConfiguration::new("host", "project", "").is_enabled());
        assert!(
            TelemetryConfiguration::new("https://example.com/", "project", "logstore").is_enabled()
        );
    }

    #[test]
    fn sanitizes_values() {
        assert_eq!(sanitized_value("codex/../../secret"), "codex_.._.._secret");
        assert_eq!(sanitized_value("Claude Code"), "Claude Code");
    }

    #[test]
    fn compact_counts_limits_surface() {
        let mut counts = BTreeMap::new();
        counts.insert("codex".to_string(), 2);
        counts.insert("claude-code".to_string(), 1);
        assert_eq!(compact_counts(&counts), "claude-code=1,codex=2");
    }

    #[test]
    fn metric_keys_are_field_safe() {
        assert_eq!(metric_key("Claude Code"), "claude_code");
        assert_eq!(metric_key("codex/../../secret"), "codex_______secret");
        assert_eq!(metric_key(""), "unknown");
    }
}
