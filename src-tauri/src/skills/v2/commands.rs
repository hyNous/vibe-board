//! Tauri command wrappers for Skill Manager v2.

#![allow(dead_code)]
// `Ok(svc()?.method()?)` reads clearly at the command boundary; the wrapper
// shape is intentional and uniform across every command here.
#![allow(clippy::needless_question_mark)]

use crate::skills::v2::models::*;
use crate::skills::v2::service::{
    AdoptBatchItem, AdoptBatchResult, ClaimOrigin, DeleteSkillTargetDistributionsResult,
    DeleteUnmanagedAgentSkillsResult, Service,
};
use crate::skills::v2::{diagnosis, snapshot};
use std::sync::Arc;

fn svc() -> Result<Arc<Service>, String> {
    crate::skills::v2::service()
}

#[tauri::command(async)]
pub fn skill_manager_bootstrap() -> Result<(), String> {
    let svc = svc()?;
    svc.bootstrap()
}

#[tauri::command(async)]
pub fn skill_manager_init() -> Result<(), String> {
    let svc = svc()?;
    svc.init()
}

#[tauri::command(async)]
pub fn skill_manager_overview() -> Result<SkillManagerOverview, String> {
    Ok(svc()?.overview()?)
}

#[tauri::command(async)]
pub fn skill_manager_refresh() -> Result<(), String> {
    svc()?.refresh()
}

#[tauri::command(async)]
pub fn skill_manager_refresh_overview() -> Result<SkillManagerOverview, String> {
    Ok(svc()?.refresh_overview()?)
}

#[tauri::command(async)]
pub fn skill_manager_update_settings(
    update: SettingsUpdate,
) -> Result<SkillManagerSettings, String> {
    svc()?.update_settings(update)
}

#[tauri::command(async)]
pub fn get_skill_detail_v2(skill_id: String) -> Result<SkillDetail, String> {
    Ok(svc()?.get_skill_detail(&skill_id)?)
}

// `(async)` runs the blocking body on a worker thread instead of the main
// thread, so a network skill download never freezes the webview and multiple
// installs can run concurrently.
#[tauri::command(async)]
pub fn preview_add_center_skill(
    input: AddCenterSkillInput,
) -> Result<AddCenterSkillPreview, String> {
    Ok(svc()?.preview_add_center_skill(input)?)
}

#[tauri::command(async)]
pub fn execute_add_center_skill(
    input: AddCenterSkillInput,
    decisions: Vec<AddCenterSkillDecision>,
) -> Result<AddCenterSkillResult, String> {
    Ok(svc()?.execute_add_center_skill(input, decisions)?)
}

// Open-source Skill updates run on worker threads: the batch check and the
// single update both clone from GitHub and must not freeze the webview.
#[tauri::command(async)]
pub fn skill_update_status() -> Result<SkillUpdateStatus, String> {
    Ok(svc()?.skill_update_status()?)
}

#[tauri::command(async)]
pub fn check_all_skill_updates() -> Result<SkillUpdateCheckReport, String> {
    Ok(svc()?.check_all_skill_updates()?)
}

#[tauri::command(async)]
pub fn check_skill_update(skill_id: String) -> Result<SkillUpdateCheckEntry, String> {
    Ok(svc()?.check_skill_update(&skill_id)?)
}

#[tauri::command(async)]
pub fn run_periodic_skill_update_check() -> Result<PeriodicSkillUpdateResult, String> {
    Ok(svc()?.run_periodic_skill_update_check()?)
}

#[tauri::command(async)]
pub fn update_skill_from_source(
    skill_id: String,
    allow_local_overwrite: bool,
) -> Result<SkillUpdateRunResult, String> {
    Ok(svc()?.update_skill_from_source(&skill_id, allow_local_overwrite)?)
}

#[tauri::command(async)]
pub fn set_skill_auto_update(skill_id: String, enabled: bool) -> Result<SkillUpdateStatus, String> {
    Ok(svc()?.set_skill_auto_update(&skill_id, enabled)?)
}

#[tauri::command(async)]
pub fn preview_delete_center_skill(skill_id: String) -> Result<DeleteCenterSkillPreview, String> {
    Ok(svc()?.preview_delete_center_skill(&skill_id)?)
}

#[tauri::command(async)]
pub fn execute_delete_center_skill(skill_id: String, remove_linked: bool) -> Result<(), String> {
    svc()?.execute_delete_center_skill(&skill_id, remove_linked)
}

#[tauri::command(async)]
pub fn preview_delete_center_skills(
    skill_ids: Vec<String>,
) -> Result<DeleteCenterSkillPreview, String> {
    Ok(svc()?.preview_delete_center_skills(skill_ids)?)
}

#[tauri::command(async)]
pub fn execute_delete_center_skills(
    skill_ids: Vec<String>,
    remove_linked: bool,
) -> Result<(), String> {
    svc()?.execute_delete_center_skills(skill_ids, remove_linked)
}

#[tauri::command(async)]
pub fn preview_distribute_skill(
    skill_ids: Vec<String>,
    target_agents: Vec<String>,
    requested_mode: String,
) -> Result<DistributionPreview, String> {
    Ok(svc()?.preview_distribute_skill(skill_ids, target_agents, requested_mode)?)
}

#[tauri::command(async)]
pub fn execute_distribute_skill(
    preview: DistributionPreview,
) -> Result<DistributionPreview, String> {
    svc()?.execute_distribute_skill(preview, ClaimOrigin::Direct)
}

#[tauri::command(async)]
pub fn scan_agent_inventory(agent_id: String) -> Result<serde_json::Value, String> {
    let svc = svc()?;
    let result = svc.scan_agent_inventory_into_db(&agent_id)?;
    Ok(serde_json::json!({
        "agentId": agent_id,
        "managed": result.managed,
        "unmanaged": result.unmanaged,
        "readOnly": result.read_only,
        "includedShared": result.included_shared,
        "sharedManaged": result.shared_managed,
        "sharedUnmanaged": result.shared_unmanaged,
        "sharedReadOnly": result.shared_read_only,
    }))
}

#[tauri::command(async)]
pub fn preview_adopt_agent_skill(
    agent_id: String,
    unmanaged_id: String,
) -> Result<crate::skills::v2::service::AdoptPreview, String> {
    Ok(svc()?.preview_adopt_agent_skill(&agent_id, &unmanaged_id)?)
}

#[tauri::command(async)]
pub fn execute_adopt_agent_skill(
    agent_id: String,
    unmanaged_id: String,
    option: String,
    renamed_id: Option<String>,
) -> Result<String, String> {
    svc()?.execute_adopt_agent_skill(&agent_id, &unmanaged_id, &option, renamed_id)
}

#[tauri::command(async)]
pub fn execute_adopt_agent_skills(items: Vec<AdoptBatchItem>) -> Result<AdoptBatchResult, String> {
    svc()?.execute_adopt_agent_skills(items)
}

#[tauri::command(async)]
pub fn takeover_center_agent_skills(
    agent_id: String,
    unmanaged_ids: Vec<String>,
) -> Result<AdoptBatchResult, String> {
    svc()?.takeover_center_agent_skills(&agent_id, unmanaged_ids)
}

#[tauri::command(async)]
pub fn delete_unmanaged_agent_skill(agent_id: String, unmanaged_id: String) -> Result<(), String> {
    svc()?.delete_unmanaged_agent_skill(&agent_id, &unmanaged_id)
}

#[tauri::command(async)]
pub fn delete_unmanaged_agent_skills(
    agent_id: String,
    unmanaged_ids: Vec<String>,
) -> Result<DeleteUnmanagedAgentSkillsResult, String> {
    svc()?.delete_unmanaged_agent_skills(&agent_id, unmanaged_ids)
}

#[tauri::command(async)]
pub fn preview_copy_target_diff(
    target_id: String,
) -> Result<crate::skills::v2::service::CopyTargetDiffPreview, String> {
    Ok(svc()?.preview_copy_target_diff(&target_id)?)
}

#[tauri::command(async)]
pub fn execute_sync_copy_target(
    target_id: String,
    action: String,
) -> Result<crate::skills::v2::service::CopySyncPreview, String> {
    svc()?.execute_sync_copy_target(&target_id, &action)
}

#[tauri::command(async)]
pub fn delete_skill_target_distribution(target_id: String) -> Result<(), String> {
    svc()?.delete_skill_target_distribution(&target_id)
}

#[tauri::command(async)]
pub fn delete_skill_target_distributions(
    target_ids: Vec<String>,
) -> Result<DeleteSkillTargetDistributionsResult, String> {
    svc()?.delete_skill_target_distributions(target_ids)
}

#[tauri::command(async)]
pub fn get_agent_detail_v2(agent_id: String) -> Result<AgentDetail, String> {
    Ok(svc()?.get_agent_detail(&agent_id)?)
}

#[tauri::command(async)]
pub fn refresh_agent_skill_view_v2(agent_id: String) -> Result<AgentSkillViewSnapshot, String> {
    svc()?.refresh_agent_skill_view(&agent_id)
}

#[tauri::command(async)]
pub fn list_unmanaged_v2() -> Result<Vec<UnmanagedItemDto>, String> {
    Ok(svc()?.list_unmanaged()?)
}

#[tauri::command(async)]
pub fn list_agent_skill_inventory_v2() -> Result<Vec<AgentSkillInventoryAgent>, String> {
    Ok(svc()?.list_agent_skill_inventory()?)
}

#[tauri::command(async)]
pub fn run_skill_manager_diagnosis() -> Result<Vec<DiagnosisIssue>, String> {
    let svc = svc()?;
    svc.refresh()?;
    diagnosis::run(&svc)
}

#[tauri::command(async)]
pub fn execute_fix_diagnosis_issue(issue_type: String, entity_id: String) -> Result<(), String> {
    let svc = svc()?;
    diagnosis::execute_fix(&svc, &issue_type, &entity_id)
}

#[tauri::command(async)]
pub fn execute_safe_fixes() -> Result<usize, String> {
    let svc = svc()?;
    diagnosis::execute_safe_fixes(&svc)
}

#[tauri::command(async)]
pub fn skill_manager_export_snapshot() -> Result<String, String> {
    let svc = svc()?;
    snapshot::export_to_file(&svc)
}

#[tauri::command(async)]
pub fn open_skill_path(path: String) -> Result<(), String> {
    crate::skills::v2::fsutil::open_path(&path)
}

#[tauri::command(async)]
pub fn reveal_skill_path(path: String) -> Result<(), String> {
    crate::skills::v2::fsutil::reveal_path(&path)
}
