pub mod agent_paths;
pub mod config_file_editor;
pub mod explanation;
pub mod frontmatter;
pub mod installer;
pub mod registry;
pub mod scanner;
pub mod sync;
pub mod v2;
pub mod zcode_config;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredSkill {
    pub id: String,
    pub name: String,
    pub description: String,
    pub file_path: String,
    pub dir_path: String,
    pub project_path: String,
    pub project_name: String,
    pub source_kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubSkillPreview {
    pub source_path: String,
    pub name: String,
    pub description: String,
    pub directory_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillPack {
    pub id: String,
    pub name: String,
    pub description: String,
    pub skills: Vec<String>,
    pub target_agents: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillCollection {
    pub id: String,
    pub name: String,
    pub description: String,
    pub skills: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanRoot {
    pub path: String,
    pub enabled: bool,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConfig {
    pub method: String,
    pub github_repo: Option<String>,
    pub github_token: Option<String>,
    pub last_sync_at: Option<String>,
    pub auto_sync: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTreeNode {
    pub name: String,
    pub node_type: String,
    pub path: String,
    pub children: Option<Vec<FileTreeNode>>,
}

/// Shared lock for tests that mutate the process-global `HOME` env var.
/// Mutating `HOME` from parallel test threads races; this serializes every
/// HOME-dependent skill test (both the legacy `mod tests` and v2 tests) so
/// `cargo test` is deterministic.
#[cfg(test)]
pub(crate) static SHARED_HOME_TEST_LOCK: std::sync::OnceLock<std::sync::Mutex<()>> =
    std::sync::OnceLock::new();

#[cfg(test)]
pub(crate) fn lock_shared_test_home() -> std::sync::MutexGuard<'static, ()> {
    // Recover from poison: if a prior test panicked while holding the lock,
    // the panicking thread is gone and its Drop already restored HOME, so it is
    // safe for the next test to proceed. Without this, one failure cascades.
    SHARED_HOME_TEST_LOCK
        .get_or_init(|| std::sync::Mutex::new(()))
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}
