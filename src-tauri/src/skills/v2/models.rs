//! Skill Manager v2 — data transfer objects, enums and DB row models.
//!
//! All structs use `#[serde(rename_all = "camelCase")]` so the DTO shapes that
//! cross the Tauri boundary match the TypeScript types in `skillApi.ts`.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const SCHEMA_VERSION: i64 = 4;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillManagerSettings {
    #[serde(default = "default_center_path")]
    pub center_path: String,
    #[serde(default = "default_sqlite_path")]
    pub sqlite_path: String,
    /// "link" | "copy"
    #[serde(default = "default_mode")]
    pub default_distribute_mode: String,
    /// "ask" | "copy" — behaviour when a symlink cannot be created
    #[serde(default = "default_link_fail")]
    pub link_fail_policy: String,
    #[serde(default = "default_true")]
    pub startup_scan: bool,
    #[serde(default = "default_true")]
    pub show_unmanaged: bool,
    #[serde(default = "default_true")]
    pub auto_sync_skill_packs: bool,
    /// Periodic open-source Skill update check. Off by default: turning it on
    /// lets Vibe Board contact GitHub at most once per day.
    #[serde(default = "default_false")]
    pub periodic_skill_update_check: bool,
    #[serde(default)]
    pub last_skill_update_check_at: Option<String>,
}

fn default_false() -> bool {
    false
}

fn default_center_path() -> String {
    crate::skills::v2::fsutil::default_center_path()
        .to_string_lossy()
        .to_string()
}
fn default_sqlite_path() -> String {
    crate::skills::v2::fsutil::default_sqlite_path()
        .to_string_lossy()
        .to_string()
}
fn default_mode() -> String {
    if cfg!(target_os = "windows") {
        "copy"
    } else {
        "link"
    }
    .to_string()
}
fn default_link_fail() -> String {
    if cfg!(target_os = "windows") {
        "copy"
    } else {
        "ask"
    }
    .to_string()
}
fn default_true() -> bool {
    true
}

impl Default for SkillManagerSettings {
    fn default() -> Self {
        Self {
            center_path: default_center_path(),
            sqlite_path: default_sqlite_path(),
            default_distribute_mode: default_mode(),
            link_fail_policy: default_link_fail(),
            startup_scan: true,
            show_unmanaged: true,
            auto_sync_skill_packs: true,
            periodic_skill_update_check: false,
            last_skill_update_check_at: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillManagerMetrics {
    pub center_skill_count: usize,
    pub target_count: usize,
    pub unmanaged_count: usize,
    pub issue_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillManagerOverview {
    pub metrics: SkillManagerMetrics,
    pub skills: Vec<SkillSummary>,
    pub agents: Vec<AgentSummary>,
    pub packs: Vec<SkillPackSummary>,
    pub issues: Vec<DiagnosisIssue>,
    pub settings: SkillManagerSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkillViewSnapshot {
    pub agent_detail: AgentDetail,
    pub overview: SkillManagerOverview,
    pub unmanaged: Vec<UnmanagedItemDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    pub root_path: String,
    pub created_at: String,
    pub updated_at: String,
    pub last_scanned_at: Option<String>,
    pub detected_agent_count: usize,
    pub skill_count: usize,
    pub instruction_count: usize,
    pub issue_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectDetail {
    #[serde(flatten)]
    pub summary: ProjectSummary,
    pub agents: Vec<ProjectAgentDetail>,
    pub instructions: Vec<ProjectInstructionFile>,
    pub health: Vec<ProjectHealthIssue>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectAgentDetail {
    pub agent_id: String,
    pub display_name: String,
    pub icon_key: String,
    pub skills_dirs: Vec<String>,
    pub config_paths: Vec<String>,
    pub skills: Vec<ProjectSkillItem>,
    pub health: Vec<ProjectHealthIssue>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSkillItem {
    pub id: String,
    pub name: String,
    pub description: String,
    pub agent_id: String,
    pub path: String,
    pub hash: String,
    pub status: String,
    pub importable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInstructionFile {
    pub agent_id: String,
    pub path: String,
    pub exists: bool,
    pub bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectHealthIssue {
    pub agent_id: Option<String>,
    pub kind: String,
    pub message: String,
    pub severity: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSummary {
    pub id: String,
    pub name: String,
    pub description: String,
    pub skill_type: String,
    pub source_type: String,
    pub source_uri: Option<String>,
    pub center_path: String,
    pub current_hash: String,
    pub status: String,
    pub installed_agents: Vec<InstalledAgentRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledAgentRef {
    pub agent_id: String,
    pub display_name: String,
    pub icon_key: String,
    pub mode: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDetail {
    #[serde(flatten)]
    pub summary: SkillSummary,
    pub center_resolved_path: Option<String>,
    pub frontmatter: std::collections::BTreeMap<String, String>,
    pub files: Option<FileTreeNode>,
    pub targets: Vec<SkillTargetDetail>,
    pub source: Option<SkillSourceDetail>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSourceDetail {
    pub source_type: String,
    pub source_uri: Option<String>,
    pub source_ref: Option<String>,
    pub imported_from_agent: Option<String>,
    pub imported_from_path: Option<String>,
    pub installed_via: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillTargetDetail {
    pub id: String,
    pub skill_id: String,
    pub agent_id: String,
    pub target_path: String,
    pub resolved_target_path: Option<String>,
    pub install_mode: String,
    pub actual_mode: String,
    pub source_hash: String,
    pub current_hash: Option<String>,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    pub claims: Vec<TargetClaim>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetClaim {
    pub id: String,
    pub claim_type: String,
    pub pack_id: Option<String>,
    pub pack_name: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSummary {
    pub id: String,
    pub display_name: String,
    pub icon_key: String,
    pub enabled: bool,
    pub skills_dir: Option<String>,
    pub version: Option<String>,
    pub latest_version: Option<String>,
    pub installed: bool,
    /// The Agent's own executable/application was detected. `installed` is also
    /// true when only configuration or Skill directories exist.
    pub program_installed: bool,
    pub managed_skill_count: usize,
    pub unmanaged_skill_count: usize,
    pub read_only_skill_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDetail {
    pub id: String,
    pub display_name: String,
    pub icon_key: String,
    pub version: Option<String>,
    pub latest_version: Option<String>,
    pub skills_dir: Option<String>,
    pub config_path: Option<String>,
    pub agent_dir: Option<String>,
    pub skills: Vec<SkillTargetDetail>,
    pub inherits_shared_skills: bool,
    pub inherited_managed_skills: Vec<SkillTargetDetail>,
    pub inherited_unmanaged_skills: Vec<UnmanagedItemDto>,
    pub applied_packs: Vec<AppliedPackSummary>,
    pub available_packs: Vec<SkillPackSummary>,
    pub health: Vec<AgentHealthIssue>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedPackSummary {
    pub pack_id: String,
    pub pack_name: String,
    pub member_count: usize,
    pub agent_id: Option<String>,
    pub display_name: Option<String>,
    pub icon_key: Option<String>,
    pub pack_revision: i64,
    pub synced_revision: i64,
    pub sync_status: String,
    pub sync_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillPackSummary {
    pub id: String,
    pub name: String,
    pub description: String,
    pub tags: Vec<String>,
    pub member_count: usize,
    pub applied_agent_count: usize,
    pub healthy: bool,
    pub revision: i64,
    pub sync_status: String,
    pub pending_sync_count: usize,
    pub failed_sync_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillPackPickerData {
    pub agents: Vec<AgentSummary>,
    pub packs: Vec<SkillPackSummary>,
    pub applied_by_agent: HashMap<String, Vec<String>>,
    pub default_distribute_mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillPackDetail {
    pub id: String,
    pub name: String,
    pub description: String,
    pub tags: Vec<String>,
    pub members: Vec<PackMember>,
    pub applied_agents: Vec<AppliedPackSummary>,
    pub revision: i64,
    pub sync_status: String,
    pub pending_sync_count: usize,
    pub failed_sync_count: usize,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackMember {
    pub skill_id: String,
    pub skill_name: String,
    pub required: bool,
    pub sort_order: i64,
    pub missing: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHealthIssue {
    pub kind: String,
    pub message: String,
    pub severity: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTreeNode {
    pub name: String,
    pub node_type: String,
    pub path: String,
    pub children: Option<Vec<FileTreeNode>>,
}

// ── Preview / execution DTOs ──────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictBlocker {
    pub skill_id: String,
    pub agent_id: String,
    pub reason: String,
    pub existing_path: Option<String>,
    pub existing_path_kind: Option<String>,
    pub resolved_existing_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DistributionBlockerDecision {
    pub skill_id: String,
    pub agent_id: String,
    pub action: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DistributionChange {
    pub skill_id: String,
    pub agent_id: String,
    pub action: String,
    pub actual_mode: Option<String>,
    pub reason: Option<String>,
    pub target_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DistributionPreview {
    pub skill_ids: Vec<String>,
    pub target_agents: Vec<String>,
    pub requested_mode: String,
    pub changes: Vec<DistributionChange>,
    pub blockers: Vec<ConflictBlocker>,
    #[serde(default)]
    pub blocker_decisions: Vec<DistributionBlockerDecision>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddCenterSkillInput {
    pub source_path: String,
    /// "local_folder" | "archive" | "agent_import" | "manual_center" | ...
    pub source_type: String,
    pub source_uri: Option<String>,
    pub imported_from_agent: Option<String>,
    pub imported_from_path: Option<String>,
    /// when importing a directory holding many skills
    pub multi: Option<bool>,
    /// "copy" | "link"; defaults to "copy" when omitted.
    #[serde(default)]
    pub import_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddCenterSkillCandidate {
    pub skill_id: String,
    pub proposed_skill_id: String,
    pub name: String,
    pub description: String,
    pub source_dir: String,
    pub hash: String,
    pub action: String, // "create" | "update" | "blocked_same_name_diff_source"
    pub existing_source_type: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddCenterSkillPreview {
    pub candidates: Vec<AddCenterSkillCandidate>,
    pub blockers: Vec<AddCenterSkillCandidate>,
    pub unchanged_count: usize,
    pub center_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddCenterSkillDecision {
    pub skill_id: String,
    pub proposed_skill_id: Option<String>,
    /// "create" | "update" | "skip"
    pub resolution: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddCenterSkillResult {
    pub skill_ids: Vec<String>,
    pub updated: Vec<String>,
    pub skipped: Vec<String>,
}

// ── Open-source Skill update checks ───────────────────────────────

/// One file that differs between the installed Skill and its remote source.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillUpdateFileChange {
    pub path: String,
    /// "added" | "modified" | "removed"
    pub change_type: String,
}

/// Human-sized summary of what an update would change. `files` is capped; the
/// counts always cover every difference.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillUpdateChangeSummary {
    pub added: usize,
    pub modified: usize,
    pub removed: usize,
    pub files: Vec<SkillUpdateFileChange>,
    pub truncated: bool,
}

/// One Skill in a batch update check.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillUpdateCheckEntry {
    pub skill_id: String,
    pub name: String,
    pub source_uri: String,
    pub update_available: bool,
    pub locally_modified: bool,
    /// False when neither the source record nor Vibe Board has a baseline for
    /// this Skill, so local changes cannot be judged.
    pub baseline_known: bool,
    pub auto_update_enabled: bool,
    /// Set on the periodic-check path when the new version was applied.
    pub auto_updated: bool,
    /// "locally_modified" | "apply_failed" when an enabled auto-update was skipped.
    pub auto_update_skipped: Option<String>,
    /// "network" | "not_found" | "rate_limited" | "unknown"
    pub error_kind: Option<String>,
    pub error_detail: Option<String>,
    pub changes: Option<SkillUpdateChangeSummary>,
}

/// Batch result for the user-triggered and periodic checks.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillUpdateCheckReport {
    pub checked_at: String,
    pub checked_count: usize,
    pub update_count: usize,
    pub failed_count: usize,
    pub entries: Vec<SkillUpdateCheckEntry>,
}

/// Persisted update state, so the library can show the last result after a
/// startup check that happened while the page was closed.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillUpdateStatus {
    pub periodic_check_enabled: bool,
    pub last_checked_at: Option<String>,
    pub report: Option<SkillUpdateCheckReport>,
    pub auto_update_skill_ids: Vec<String>,
}

/// Result of updating one Skill in place from its recorded source.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillUpdateRunResult {
    pub skill_id: String,
    pub name: String,
    pub source_uri: String,
    pub updated: bool,
    /// "no_update" | "locally_modified" | "not_found" when nothing was written.
    pub skipped_reason: Option<String>,
    pub locally_modified: bool,
    pub changes: Option<SkillUpdateChangeSummary>,
    pub synced_at: String,
    /// "network" | "not_found" | "rate_limited" | "unknown"
    pub error_kind: Option<String>,
    pub error_detail: Option<String>,
}

/// Result of the app-startup periodic check.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeriodicSkillUpdateResult {
    pub ran: bool,
    /// "disabled" | "recent" when the check was skipped.
    pub skip_reason: Option<String>,
    pub report: Option<SkillUpdateCheckReport>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteCenterSkillPreview {
    pub skill_id: String,
    pub skill_ids: Vec<String>,
    pub affected_targets: Vec<AffectedTarget>,
    pub removable: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AffectedTarget {
    pub target_id: String,
    pub agent_id: String,
    pub display_name: String,
    pub target_path: String,
    pub mode: String,
    pub claim_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteSkillPackPreview {
    pub pack_id: String,
    pub pack_name: String,
    pub applied_agents: Vec<String>,
    pub affected_targets: Vec<AffectedTarget>,
    pub removable: bool,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemovePackFromAgentPreview {
    pub pack_id: String,
    pub pack_name: String,
    pub agent_id: String,
    pub display_name: String,
    pub affected_targets: Vec<AffectedTarget>,
    pub will_remove_targets: usize,
    pub will_preserve_targets: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveSkillFromPackPreview {
    pub pack_id: String,
    pub pack_name: String,
    pub skill_id: String,
    pub skill_name: String,
    pub affected_targets: Vec<AffectedTarget>,
    pub applied_agent_count: usize,
    pub can_keep_standalone: bool,
    pub can_remove_targets: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveDirectSkillToPackPreview {
    pub target_id: String,
    pub skill_id: String,
    pub skill_name: String,
    pub agent_id: String,
    pub display_name: String,
    pub pack_id: String,
    pub pack_name: String,
    pub already_member: bool,
    pub already_applied: bool,
    pub will_add_to_pack: bool,
    pub other_member_count: usize,
    pub distribution: DistributionPreview,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillPackSyncAgentResult {
    pub agent_id: String,
    pub display_name: String,
    pub status: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillPackSyncResult {
    pub pack_id: String,
    pub pack_name: String,
    pub revision: i64,
    pub status: String,
    pub agents: Vec<SkillPackSyncAgentResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnmanagedItemDto {
    pub id: String,
    pub item_type: String,
    pub agent_id: Option<String>,
    pub path: String,
    pub inferred_skill_id: Option<String>,
    pub hash: Option<String>,
    pub reason: String,
    pub read_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkillInventoryAgent {
    pub agent_id: String,
    pub display_name: String,
    pub icon_key: String,
    pub skills_dir: Option<String>,
    pub installed: bool,
    /// The Agent's own executable/application was detected.
    pub program_installed: bool,
    pub managed_count: usize,
    pub unmanaged_count: usize,
    pub read_only_count: usize,
    pub importable_count: usize,
    pub items: Vec<AgentSkillInventoryItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkillInventoryItem {
    pub id: String,
    pub agent_id: String,
    pub skill_id: String,
    pub name: String,
    pub path: String,
    pub managed: bool,
    pub read_only: bool,
    pub can_import: bool,
    pub status: String,
    pub status_label: String,
    pub reason: Option<String>,
    pub target_id: Option<String>,
    pub actual_mode: Option<String>,
    pub hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosisIssue {
    pub id: String,
    pub issue_type: String,
    pub severity: String,
    pub fix_kind: String,
    pub title: String,
    pub detail: String,
    pub entity_type: String,
    pub entity_id: Option<String>,
    pub actions: Vec<DiagnosisAction>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosisAction {
    pub id: String,
    pub label: String,
    pub destructive: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub schema_version: i64,
    pub exported_at: String,
    pub center_path: String,
    pub skills: Vec<serde_json::Value>,
    pub sources: Vec<serde_json::Value>,
    pub agents: Vec<serde_json::Value>,
    pub targets: Vec<serde_json::Value>,
    pub claims: Vec<serde_json::Value>,
    pub packs: Vec<serde_json::Value>,
    pub projects: Vec<serde_json::Value>,
    pub diagnosis_summary: serde_json::Value,
}

// ── Settings update input ─────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsUpdate {
    pub center_path: Option<String>,
    pub sqlite_path: Option<String>,
    pub default_distribute_mode: Option<String>,
    pub link_fail_policy: Option<String>,
    pub startup_scan: Option<bool>,
    pub show_unmanaged: Option<bool>,
    pub auto_sync_skill_packs: Option<bool>,
    pub periodic_skill_update_check: Option<bool>,
}
