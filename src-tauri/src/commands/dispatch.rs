//! Handoff relationship tree (settings → 派活关系).
//!
//! The dispatch tool is the separately published `hyNous/agent-dispatch` Skill
//! set. Vibe Board no longer bundles it: the page detects whether this machine
//! already has it under the shared `~/.agents/skills` root, offers an explicit
//! install from GitHub when it does not, and only then shows which Agent can
//! read which worker Skill. Detection follows the Agent read-directory table in
//! `skills::v2::agent_meta`; a Skill visible through the shared root is shared
//! by every Agent that reads it, and disconnecting one of those Agents warns
//! about the others. Disconnecting removes a link itself, never the directory
//! it points to, and leaves user-edited copies alone. It never installs a CLI,
//! never reads credential values, and never edits global instruction files
//! (`CLAUDE.md` / `AGENTS.md`).

use crate::platform::process::background_command;
use crate::skills::v2::{agent_meta, fsutil, skill_lock};
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

/// The separately published Skill repository this page installs on demand.
const DISPATCH_REPO: &str = "hyNous/agent-dispatch";
const DISPATCH_REPO_OWNER: &str = "hyNous";
const DISPATCH_REPO_NAME: &str = "agent-dispatch";

/// Only the Claude Code and Codex dispatchers were verified end to end; other
/// Agents can be connected too, but their node is marked as unverified.
const VERIFIED_AGENT_IDS: [&str; 2] = ["claude-code", "codex"];

/// Worker id → Skill directory name.
const WORKER_SKILLS: [(&str, &str); 2] = [
    ("opencode", "opencode-agent"),
    ("antigravity", "antigravity-agent"),
];

/// Every Skill the dispatch tool installs under `~/.agents/skills`.
const INSTALLED_SKILLS: [&str; 4] = [
    "external-agent-core",
    "external-agent-setup",
    "opencode-agent",
    "antigravity-agent",
];

/// Shared parts of every connection: the runtime the worker Skill loads and
/// the setup Skill that connects tools which are not built in. The setup Skill
/// stays behind when the last worker is disconnected.
const SHARED_SKILLS: [&str; 2] = ["external-agent-core", "external-agent-setup"];
const WORKER_ORDER: [&str; 2] = ["opencode", "antigravity"];
const CATALOG_RELATIVE: &str = "external-agent-setup/providers.json";
const VERSION_TIMEOUT: Duration = Duration::from_secs(5);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(300);
const VERSION_MAX_CHARS: usize = 120;
const INSTALL_OUTPUT_MAX_CHARS: usize = 600;
const SAFE_ENV_NAMES: [&str; 18] = [
    "PATH",
    "Path",
    "PATHEXT",
    "APPDATA",
    "LOCALAPPDATA",
    "USERPROFILE",
    "HOME",
    "SystemRoot",
    "windir",
    "TEMP",
    "TMP",
    "ComSpec",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "LANG",
    "LC_ALL",
    "TERM",
    "USERNAME",
];

#[cfg(windows)]
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchNodeStatus {
    pub available: bool,
    pub program_path: Option<String>,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchWorkerStatus {
    pub id: String,
    pub display_name: String,
    pub detected: bool,
    pub program_path: Option<String>,
    pub version: Option<String>,
    /// Credential *file* presence only; values are never read or reported.
    /// `null` when the installed profile declares no credential file.
    pub credential_file_present: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchReadDir {
    pub path: String,
    /// The shared `.agents/skills` root.
    pub shared: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchConnection {
    pub worker_id: String,
    pub display_name: String,
    pub skill_id: String,
    /// The Agent read-directory that currently contains the worker Skill.
    pub dir: String,
    /// Other visible Agents that read the same shared directory and therefore
    /// see the same worker; empty for an Agent-private directory.
    pub shared_with: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchAgentNode {
    pub agent_id: String,
    pub display_name: String,
    /// Whether this dispatcher has been verified end to end. Unverified Agents
    /// are shown with a light hint and can still be connected.
    pub verified: bool,
    pub read_dirs: Vec<DispatchReadDir>,
    pub connections: Vec<DispatchConnection>,
    /// Detected workers that are not connected to this Agent yet.
    pub addable_workers: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchTree {
    pub node: DispatchNodeStatus,
    pub agents: Vec<DispatchAgentNode>,
    pub workers: Vec<DispatchWorkerStatus>,
    /// False until the `hyNous/agent-dispatch` Skills are installed under
    /// `~/.agents/skills`; the page then offers the GitHub install.
    pub tool_installed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchInstallResult {
    pub tool_installed: bool,
    /// True when `~/.agents/.skill-lock.json` records the GitHub origin, so the
    /// Skill update check can take over later.
    pub source_recorded: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchPlanFile {
    pub skill_id: String,
    pub relative_path: String,
    pub source_path: String,
    pub target_path: String,
    /// What confirming does to this path: `create` (new file), `unchanged`
    /// (identical content already there) or `overwrite` (a different file
    /// exists, e.g. the user's own edited copy, and will be replaced).
    pub change: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchConnectPlan {
    pub agent_id: String,
    pub agent_display_name: String,
    pub worker_id: String,
    pub worker_display_name: String,
    pub files: Vec<DispatchPlanFile>,
    pub blockers: Vec<String>,
    pub can_apply: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchConnectResult {
    pub written_files: Vec<DispatchPlanFile>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchRemoval {
    pub skill_id: String,
    pub target_path: String,
    /// `remove` (installed copy removed), `remove_link` (only the link is
    /// removed) or `keep_modified` (user-edited copy left in place).
    pub action: String,
    /// Other visible Agents that share this directory, so the page can say who
    /// else is affected.
    pub shared_with: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchDisconnectPlan {
    pub agent_id: String,
    pub agent_display_name: String,
    pub worker_id: String,
    pub worker_display_name: String,
    pub removals: Vec<DispatchRemoval>,
    pub kept: Vec<DispatchRemoval>,
    /// Union of the other Agents affected because a removal happens in a
    /// directory they also read.
    pub affected_agents: Vec<String>,
    pub can_apply: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchDisconnectResult {
    pub removed: Vec<DispatchRemoval>,
    pub kept: Vec<DispatchRemoval>,
}

#[tauri::command(async)]
pub fn dispatch_tree() -> Result<DispatchTree, String> {
    let home = fsutil::home();
    let program_detected = |agent_id: &str| {
        agent_meta::agent_program_detected(agent_id, agent_meta::agent_installed(&home, agent_id))
    };
    Ok(tree_at(&home, &program_detected))
}

#[tauri::command(async)]
pub fn dispatch_install_tool(confirm: bool) -> Result<DispatchInstallResult, String> {
    install_tool_at(&fsutil::home(), confirm)
}

#[tauri::command(async)]
pub fn dispatch_connect_plan(
    agent_id: String,
    worker_id: String,
) -> Result<DispatchConnectPlan, String> {
    connect_plan_at(&fsutil::home(), &agent_id, &worker_id)
}

#[tauri::command(async)]
pub fn dispatch_connect_apply(
    agent_id: String,
    worker_id: String,
    confirm: bool,
) -> Result<DispatchConnectResult, String> {
    connect_apply_at(&fsutil::home(), &agent_id, &worker_id, confirm)
}

#[tauri::command(async)]
pub fn dispatch_disconnect_plan(
    agent_id: String,
    worker_id: String,
) -> Result<DispatchDisconnectPlan, String> {
    disconnect_plan_at(&fsutil::home(), &agent_id, &worker_id)
}

#[tauri::command(async)]
pub fn dispatch_disconnect_apply(
    agent_id: String,
    worker_id: String,
    confirm: bool,
) -> Result<DispatchDisconnectResult, String> {
    disconnect_apply_at(&fsutil::home(), &agent_id, &worker_id, confirm)
}

/// The shared root every Agent that reads it loads Skills from.
fn installed_skills_root(home: &Path) -> PathBuf {
    home.join(".agents").join("skills")
}

/// Whether the separately published dispatch tool is installed on this machine.
fn dispatch_skills_installed(home: &Path) -> bool {
    let root = installed_skills_root(home);
    INSTALLED_SKILLS
        .iter()
        .all(|skill_id| root.join(skill_id).join("SKILL.md").is_file())
}

/// Install the tool from GitHub through `npx skills`, after confirmation.
/// Network access happens inside the user's own Node/npm tooling; Vibe Board
/// only runs the documented command and verifies the result.
fn install_tool_at(home: &Path, confirm: bool) -> Result<DispatchInstallResult, String> {
    if !confirm {
        return Err(
            "CONFIRMATION_REQUIRED: explain the GitHub download and confirm before installing"
                .to_string(),
        );
    }
    let npx = find_on_path("npx")
        .ok_or_else(|| "NODE_MISSING: Node.js (npx) was not found on PATH".to_string())?;
    let mut command = npx_command(&npx);
    command
        .args([
            "skills",
            "add",
            DISPATCH_REPO,
            "--global",
            "--agent",
            "claude-code",
            "--agent",
            "codex",
            "--yes",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_safe_env(&mut command, home);
    let output = run_with_timeout(command, INSTALL_TIMEOUT)
        .ok_or_else(|| "INSTALL_TIMEOUT: the install command did not finish".to_string())?;
    if !output.status.success() {
        return Err(format!(
            "INSTALL_FAILED: {}",
            install_output_detail(&output)
        ));
    }
    if !dispatch_skills_installed(home) {
        return Err(
            "INSTALL_INCOMPLETE: the install command finished but the Skill files are missing"
                .to_string(),
        );
    }
    let lock = skill_lock::load(home);
    let source_recorded = INSTALLED_SKILLS.iter().all(|skill_id| {
        skill_lock::find(&lock, skill_id)
            .and_then(skill_lock::github_repo)
            .is_some_and(|(owner, repo)| {
                owner.eq_ignore_ascii_case(DISPATCH_REPO_OWNER)
                    && repo.eq_ignore_ascii_case(DISPATCH_REPO_NAME)
            })
    });
    Ok(DispatchInstallResult {
        tool_installed: true,
        source_recorded,
    })
}

fn npx_command(npx: &Path) -> Command {
    #[cfg(windows)]
    {
        // `npx` is a `.cmd` shim that CreateProcess cannot run directly; cmd.exe
        // also resolves it from the already-verified PATH.
        let _ = npx;
        let mut command = background_command("cmd");
        command.arg("/C").arg("npx");
        command
    }
    #[cfg(not(windows))]
    {
        background_command(npx)
    }
}

fn install_output_detail(output: &Output) -> String {
    let bytes = if output.stderr.iter().any(|byte| !byte.is_ascii_whitespace()) {
        &output.stderr
    } else {
        &output.stdout
    };
    let text = String::from_utf8_lossy(bytes);
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("no output")
        .chars()
        .take(INSTALL_OUTPUT_MAX_CHARS)
        .collect()
}

struct WorkerProfile {
    command: String,
    command_env: Option<String>,
    command_candidates: Vec<String>,
    check_args: Vec<String>,
    credential_file_candidates: Vec<String>,
}

/// Worker command profiles come from the installed `external-agent-setup`
/// Skill, so detection follows the same catalog the worker itself uses.
fn load_profiles(home: &Path) -> Result<BTreeMap<String, WorkerProfile>, String> {
    let path = installed_skills_root(home).join(CATALOG_RELATIVE);
    let content = std::fs::read_to_string(&path)
        .map_err(|error| format!("failed to read {}: {error}", path.display()))?;
    let catalog: serde_json::Value = serde_json::from_str(&content)
        .map_err(|error| format!("failed to parse {}: {error}", path.display()))?;
    let providers = catalog
        .get("providers")
        .and_then(|value| value.as_object())
        .ok_or_else(|| format!("{} must contain a providers object", path.display()))?;
    let mut profiles = BTreeMap::new();
    for (name, profile) in providers {
        let command = profile
            .get("command")
            .and_then(|value| value.as_str())
            .ok_or_else(|| format!("provider '{name}' is missing a command"))?;
        let strings = |field: &str| -> Vec<String> {
            profile
                .get(field)
                .and_then(|value| value.as_array())
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|item| item.as_str().map(ToString::to_string))
                        .collect()
                })
                .unwrap_or_default()
        };
        let check_args = {
            let args = strings("check_args");
            if args.is_empty() {
                vec!["--version".to_string()]
            } else {
                args
            }
        };
        let credential_file_candidates = profile
            .get("quota_check")
            .and_then(|value| value.get("credential_file_candidates"))
            .and_then(|value| value.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(ToString::to_string))
                    .collect()
            })
            .unwrap_or_default();
        profiles.insert(
            name.clone(),
            WorkerProfile {
                command: command.to_string(),
                command_env: profile
                    .get("command_env")
                    .and_then(|value| value.as_str())
                    .map(ToString::to_string),
                command_candidates: strings("command_candidates"),
                check_args,
                credential_file_candidates,
            },
        );
    }
    Ok(profiles)
}

fn tree_at(home: &Path, program_detected: &dyn Fn(&str) -> bool) -> DispatchTree {
    let tool_installed = dispatch_skills_installed(home);
    let profiles = load_profiles(home).ok();
    let workers = profiles
        .as_ref()
        .map(|profiles| detect_workers(profiles, home))
        .unwrap_or_default();
    let detected_workers = workers
        .iter()
        .filter(|worker| worker.detected)
        .map(|worker| worker.id.clone())
        .collect::<Vec<_>>();

    let agent_ids = agent_meta::visible_agent_ids()
        .into_iter()
        .filter(|agent_id| program_detected(agent_id))
        .collect::<Vec<_>>();
    let agents = agent_ids
        .iter()
        .map(|agent_id| {
            let read = agent_meta::agent_read_skill_dirs(home, agent_id);
            let read_dirs = read
                .dirs
                .iter()
                .map(|dir| DispatchReadDir {
                    path: native_path(&dir.path).display().to_string(),
                    shared: dir.shared,
                })
                .collect::<Vec<_>>();
            // An Agent never dispatches to itself: OpenCode reading the shared
            // folder that holds opencode-agent is not a connection to itself.
            let connections = WORKER_SKILLS
                .iter()
                .filter(|(worker_id, _)| *worker_id != agent_id.as_str())
                .filter_map(|(worker_id, skill_id)| {
                    let (matched, shared_with) =
                        find_worker_dir(home, agent_id, skill_id, &read.dirs, &agent_ids)?;
                    Some(DispatchConnection {
                        worker_id: (*worker_id).to_string(),
                        display_name: agent_meta::display_name(worker_id),
                        skill_id: (*skill_id).to_string(),
                        dir: native_path(&matched.path).display().to_string(),
                        shared_with,
                    })
                })
                .collect::<Vec<_>>();
            let connected = connections
                .iter()
                .map(|connection| connection.worker_id.as_str())
                .collect::<Vec<_>>();
            // An Agent never dispatches to itself (OpenCode is not its own worker).
            let addable_workers = detected_workers
                .iter()
                .filter(|worker_id| worker_id.as_str() != agent_id.as_str())
                .filter(|worker_id| !connected.contains(&worker_id.as_str()))
                .map(|worker_id| worker_id.to_string())
                .collect::<Vec<_>>();
            DispatchAgentNode {
                agent_id: agent_id.clone(),
                display_name: agent_meta::display_name(agent_id),
                verified: VERIFIED_AGENT_IDS.contains(&agent_id.as_str()),
                read_dirs,
                connections,
                addable_workers,
            }
        })
        .collect();

    DispatchTree {
        node: detect_node(home),
        agents,
        workers,
        tool_installed,
    }
}

/// Find the first read directory that contains the worker Skill. For a shared
/// directory the other visible Agents reading it are reported too.
fn find_worker_dir(
    home: &Path,
    agent_id: &str,
    skill_id: &str,
    read_dirs: &[agent_meta::AgentSkillReadDir],
    visible_agents: &[String],
) -> Option<(agent_meta::AgentSkillReadDir, Vec<String>)> {
    for dir in read_dirs {
        if !dir.path.join(skill_id).join("SKILL.md").is_file() {
            continue;
        }
        let shared_with = if dir.shared {
            shared_dir_agents(home, &dir.path, skill_id, agent_id, visible_agents)
                .into_iter()
                .map(|other| agent_meta::display_name(&other))
                .collect()
        } else {
            Vec::new()
        };
        return Some((dir.clone(), shared_with));
    }
    None
}

/// Other visible Agents that read the same shared directory and see the same
/// worker Skill there.
fn shared_dir_agents(
    home: &Path,
    dir: &Path,
    skill_id: &str,
    agent_id: &str,
    visible_agents: &[String],
) -> Vec<String> {
    visible_agents
        .iter()
        .filter(|other| other.as_str() != agent_id)
        .filter(|other| {
            agent_meta::agent_read_skill_dirs(home, other)
                .dirs
                .iter()
                .any(|candidate| {
                    candidate.shared
                        && candidate.path.as_path() == dir
                        && candidate.path.join(skill_id).join("SKILL.md").is_file()
                })
        })
        .cloned()
        .collect()
}

fn detect_node(home: &Path) -> DispatchNodeStatus {
    match find_on_path("node") {
        Some(path) => DispatchNodeStatus {
            available: true,
            program_path: Some(path.display().to_string()),
            version: probe_version(&path, &["--version".to_string()], home),
        },
        None => DispatchNodeStatus {
            available: false,
            program_path: None,
            version: None,
        },
    }
}

fn detect_workers(
    profiles: &BTreeMap<String, WorkerProfile>,
    home: &Path,
) -> Vec<DispatchWorkerStatus> {
    let mut ordered: Vec<&String> = profiles.keys().collect();
    ordered.sort_by_key(|id| {
        WORKER_ORDER
            .iter()
            .position(|known| known == id)
            .unwrap_or(WORKER_ORDER.len())
    });
    ordered
        .into_iter()
        .map(|id| {
            let profile = &profiles[id];
            let resolved = resolve_worker_command(profile, home);
            let (program_path, version) = match &resolved {
                Some(path) => (
                    Some(path.display().to_string()),
                    probe_version(path, &profile.check_args, home),
                ),
                None => (None, None),
            };
            DispatchWorkerStatus {
                id: id.clone(),
                display_name: agent_meta::display_name(id),
                detected: resolved.is_some(),
                program_path,
                version,
                credential_file_present: credential_file_present(profile, home),
            }
        })
        .collect()
}

fn worker_skill_id(worker_id: &str) -> Option<&'static str> {
    WORKER_SKILLS
        .iter()
        .find(|(id, _)| *id == worker_id)
        .map(|(_, skill_id)| *skill_id)
}

/// The Skill directories a connection writes, in plan order.
fn connection_skill_ids(worker_id: &str) -> Result<Vec<&'static str>, String> {
    let worker_skill = worker_skill_id(worker_id)
        .ok_or_else(|| format!("UNKNOWN_WORKER: {worker_id} is not a known worker"))?;
    let mut skill_ids = SHARED_SKILLS.to_vec();
    skill_ids.push(worker_skill);
    Ok(skill_ids)
}

/// The directory a connection writes. A shared read location comes first: a
/// Skill written there is visible to every Agent that reads it, so no
/// Agent-private duplicate is created. Agents without a shared location use
/// their first private directory.
fn dispatch_target_dir(home: &Path, agent_id: &str) -> Result<PathBuf, String> {
    if !agent_meta::visible_agent_ids()
        .iter()
        .any(|id| id == agent_id)
    {
        return Err(format!("UNKNOWN_AGENT: {agent_id} is not a known Agent"));
    }
    let read = agent_meta::agent_read_skill_dirs(home, agent_id);
    read.dirs
        .iter()
        .find(|dir| dir.shared)
        .or_else(|| read.dirs.first())
        .map(|dir| native_path(&dir.path))
        .ok_or_else(|| format!("NO_SKILLS_DIR: {agent_id} has no user-level Skill directory"))
}

fn connect_plan_at(
    home: &Path,
    agent_id: &str,
    worker_id: &str,
) -> Result<DispatchConnectPlan, String> {
    if agent_id == worker_id {
        return Err(format!("{agent_id} cannot dispatch tasks to itself"));
    }
    let target_dir = dispatch_target_dir(home, agent_id)?;
    let skill_ids = connection_skill_ids(worker_id)?;
    let source_root = installed_skills_root(home);

    let mut files = Vec::new();
    let mut missing_skills = !dispatch_skills_installed(home);
    if !missing_skills {
        for skill_id in skill_ids {
            let source_dir = source_root.join(skill_id);
            if !source_dir.join("SKILL.md").is_file() {
                missing_skills = true;
                continue;
            }
            let target = target_dir.join(skill_id);
            for (relative, source_path) in collect_skill_files(&source_dir)? {
                let target_path = join_relative(&target, &relative);
                let change = planned_change(&source_path, &target_path);
                files.push(DispatchPlanFile {
                    skill_id: skill_id.to_string(),
                    relative_path: relative,
                    source_path: source_path.display().to_string(),
                    target_path: target_path.display().to_string(),
                    change: change.to_string(),
                });
            }
        }
    }

    let mut blockers = Vec::new();
    if missing_skills {
        blockers.push("tool_missing".to_string());
    }
    if !detect_node(home).available {
        blockers.push("node_missing".to_string());
    }
    let can_apply = blockers.is_empty() && !files.is_empty();

    Ok(DispatchConnectPlan {
        agent_id: agent_id.to_string(),
        agent_display_name: agent_meta::display_name(agent_id),
        worker_id: worker_id.to_string(),
        worker_display_name: agent_meta::display_name(worker_id),
        files,
        blockers,
        can_apply,
    })
}

fn connect_apply_at(
    home: &Path,
    agent_id: &str,
    worker_id: &str,
    confirm: bool,
) -> Result<DispatchConnectResult, String> {
    if !confirm {
        return Err(
            "CONFIRMATION_REQUIRED: preview the file list and confirm before connecting"
                .to_string(),
        );
    }
    let plan = connect_plan_at(home, agent_id, worker_id)?;
    if !plan.blockers.is_empty() {
        return Err(format!(
            "DISPATCH_PLAN_BLOCKED: {}",
            plan.blockers.join(", ")
        ));
    }
    if plan.files.is_empty() {
        return Err(
            "DISPATCH_PLAN_EMPTY: no dispatch Skill files are available to install".to_string(),
        );
    }
    for file in &plan.files {
        let target = Path::new(&file.target_path);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
        }
        let bytes = std::fs::read(&file.source_path)
            .map_err(|error| format!("failed to read {}: {error}", file.source_path))?;
        std::fs::write(target, bytes)
            .map_err(|error| format!("failed to write {}: {error}", target.display()))?;
    }
    Ok(DispatchConnectResult {
        written_files: plan.files,
    })
}

/// What is currently sitting at a target Skill directory.
#[derive(Debug, Clone, Copy, PartialEq)]
enum SkillTargetState {
    Missing,
    Link,
    InstalledCopy,
    /// The one real copy in the shared Skill folder (`~/.agents/skills`) that
    /// every Agent reading that folder uses. Disconnecting never deletes it:
    /// there is no other copy to compare against, so local edits would be
    /// lost, and links from other Agents would be left dangling.
    SharedInstall,
    Modified,
}

fn disconnect_plan_at(
    home: &Path,
    agent_id: &str,
    worker_id: &str,
) -> Result<DispatchDisconnectPlan, String> {
    let worker_skill = worker_skill_id(worker_id)
        .ok_or_else(|| format!("UNKNOWN_WORKER: {worker_id} is not a known worker"))?;
    let read = agent_meta::agent_read_skill_dirs(home, agent_id);
    if !agent_meta::visible_agent_ids()
        .iter()
        .any(|id| id == agent_id)
    {
        return Err(format!("UNKNOWN_AGENT: {agent_id} is not a known Agent"));
    }
    let detected_agents = detected_visible_agents(home);

    let mut removals = Vec::new();
    let mut kept = Vec::new();
    let mut removing_dirs: Vec<PathBuf> = Vec::new();

    for dir in &read.dirs {
        let target = native_path(&dir.path).join(worker_skill);
        let shared_with = if dir.shared {
            shared_dir_agents(home, &dir.path, worker_skill, agent_id, &detected_agents)
                .into_iter()
                .map(|other| agent_meta::display_name(&other))
                .collect()
        } else {
            Vec::new()
        };
        let source = installed_skill_dir(home, worker_skill);
        match classify_target(source, &target) {
            SkillTargetState::Missing => {}
            SkillTargetState::Link => {
                removals.push(removal(worker_skill, &target, "remove_link", shared_with));
                removing_dirs.push(dir.path.clone());
            }
            SkillTargetState::InstalledCopy => {
                removals.push(removal(worker_skill, &target, "remove", shared_with));
                removing_dirs.push(dir.path.clone());
            }
            SkillTargetState::SharedInstall => {
                kept.push(removal(worker_skill, &target, "keep_shared", shared_with));
            }
            SkillTargetState::Modified => {
                kept.push(removal(worker_skill, &target, "keep_modified", shared_with));
            }
        }
    }

    // Remove the shared core from a directory only when no other worker remains
    // there and no other Agent that reads the directory still dispatches from it.
    for dir in &removing_dirs {
        let other_worker_connected = WORKER_SKILLS
            .iter()
            .filter(|(id, _)| *id != worker_id)
            .any(|(_, skill_id)| dir.join(skill_id).join("SKILL.md").is_file());
        let other_agent_connected = detected_agents.iter().any(|other| {
            other.as_str() != agent_id
                && agent_meta::agent_read_skill_dirs(home, other)
                    .dirs
                    .iter()
                    .any(|candidate| {
                        candidate.shared
                            && candidate.path.as_path() == dir.as_path()
                            && WORKER_SKILLS.iter().any(|(_, skill_id)| {
                                candidate.path.join(skill_id).join("SKILL.md").is_file()
                            })
                    })
        });
        if other_worker_connected || other_agent_connected {
            continue;
        }
        let core_skill = "external-agent-core";
        let core_target = dir.join(core_skill);
        let shared_with = detected_agents
            .iter()
            .filter(|other| other.as_str() != agent_id)
            .filter(|other| {
                agent_meta::agent_read_skill_dirs(home, other)
                    .dirs
                    .iter()
                    .any(|candidate| candidate.shared && candidate.path.as_path() == dir.as_path())
            })
            .map(|other| agent_meta::display_name(other))
            .collect();
        match classify_target(installed_skill_dir(home, core_skill), &core_target) {
            SkillTargetState::Missing => {}
            SkillTargetState::Link => removals.push(removal(
                core_skill,
                &core_target,
                "remove_link",
                shared_with,
            )),
            SkillTargetState::InstalledCopy => {
                removals.push(removal(core_skill, &core_target, "remove", shared_with))
            }
            SkillTargetState::SharedInstall => kept.push(removal(
                core_skill,
                &core_target,
                "keep_shared",
                shared_with,
            )),
            SkillTargetState::Modified => kept.push(removal(
                core_skill,
                &core_target,
                "keep_modified",
                shared_with,
            )),
        }
    }

    let mut affected_agents = Vec::new();
    for entry in &removals {
        for agent in &entry.shared_with {
            if !affected_agents.contains(agent) {
                affected_agents.push(agent.clone());
            }
        }
    }

    Ok(DispatchDisconnectPlan {
        agent_id: agent_id.to_string(),
        agent_display_name: agent_meta::display_name(agent_id),
        worker_id: worker_id.to_string(),
        worker_display_name: agent_meta::display_name(worker_id),
        can_apply: !removals.is_empty() || !kept.is_empty(),
        removals,
        kept,
        affected_agents,
    })
}

fn disconnect_apply_at(
    home: &Path,
    agent_id: &str,
    worker_id: &str,
    confirm: bool,
) -> Result<DispatchDisconnectResult, String> {
    if !confirm {
        return Err(
            "CONFIRMATION_REQUIRED: preview what will be removed and confirm before disconnecting"
                .to_string(),
        );
    }
    let plan = disconnect_plan_at(home, agent_id, worker_id)?;
    let mut removed = Vec::new();
    for entry in &plan.removals {
        let path = Path::new(&entry.target_path);
        if entry.action == "remove_link" {
            remove_link(path)?;
        } else {
            std::fs::remove_dir_all(path)
                .map_err(|error| format!("failed to remove {}: {error}", path.display()))?;
        }
        removed.push(entry.clone());
    }
    Ok(DispatchDisconnectResult {
        removed,
        kept: plan.kept,
    })
}

fn removal(
    skill_id: &str,
    target: &Path,
    action: &str,
    shared_with: Vec<String>,
) -> DispatchRemoval {
    DispatchRemoval {
        skill_id: skill_id.to_string(),
        target_path: native_path(target).display().to_string(),
        action: action.to_string(),
        shared_with,
    }
}

fn installed_skill_dir(home: &Path, skill_id: &str) -> Option<PathBuf> {
    let path = installed_skills_root(home).join(skill_id);
    path.is_dir().then_some(path)
}

fn classify_target(source_dir: Option<PathBuf>, target_dir: &Path) -> SkillTargetState {
    let Ok(metadata) = std::fs::symlink_metadata(target_dir) else {
        return SkillTargetState::Missing;
    };
    if is_link_like(&metadata) {
        return SkillTargetState::Link;
    }
    if !metadata.is_dir() {
        return SkillTargetState::Modified;
    }
    let Some(source_dir) = source_dir else {
        // Without an unmodified installed copy there is no proof the local
        // files are untouched, so a user directory is never deleted.
        return SkillTargetState::Modified;
    };
    if source_dir.as_path() == target_dir {
        return SkillTargetState::SharedInstall;
    }
    match directory_matches_source(&source_dir, target_dir) {
        Ok(true) => SkillTargetState::InstalledCopy,
        _ => SkillTargetState::Modified,
    }
}

fn directory_matches_source(source_dir: &Path, target_dir: &Path) -> Result<bool, String> {
    let source = collect_skill_files(source_dir)?;
    let target = collect_skill_files(target_dir)?;
    if source.len() != target.len() {
        return Ok(false);
    }
    for ((source_relative, source_path), (target_relative, target_path)) in
        source.iter().zip(target.iter())
    {
        if source_relative != target_relative {
            return Ok(false);
        }
        let source_bytes = std::fs::read(source_path)
            .map_err(|error| format!("failed to read {}: {error}", source_path.display()))?;
        let target_bytes = std::fs::read(target_path)
            .map_err(|error| format!("failed to read {}: {error}", target_path.display()))?;
        if source_bytes != target_bytes {
            return Ok(false);
        }
    }
    Ok(true)
}

fn detected_visible_agents(home: &Path) -> Vec<String> {
    agent_meta::visible_agent_ids()
        .into_iter()
        .filter(|agent_id| {
            agent_meta::agent_program_detected(
                agent_id,
                agent_meta::agent_installed(home, agent_id),
            )
        })
        .collect()
}

#[cfg(windows)]
fn is_link_like(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    // Junctions are reparse points but not always reported as symlinks.
    metadata.file_type().is_symlink()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_link_like(metadata: &std::fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

fn remove_link(path: &Path) -> Result<(), String> {
    // A symlink to a file is removed as a file; a directory symlink or a
    // Windows junction only goes away with remove_dir. Neither follows the
    // link, so the directory it points to is left untouched.
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(file_error) => std::fs::remove_dir(path).map_err(|dir_error| {
            format!(
                "failed to remove link {}: {file_error}; {dir_error}",
                path.display()
            )
        }),
    }
}

fn resolve_worker_command(profile: &WorkerProfile, home: &Path) -> Option<PathBuf> {
    if let Some(name) = profile.command_env.as_deref() {
        if let Some(value) = std::env::var_os(name) {
            let candidate = PathBuf::from(value);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    for candidate in &profile.command_candidates {
        let path = PathBuf::from(expand_vars(candidate, home));
        if path.is_file() {
            return Some(path);
        }
    }
    find_on_path(&profile.command)
}

fn credential_file_present(profile: &WorkerProfile, home: &Path) -> Option<bool> {
    if profile.credential_file_candidates.is_empty() {
        return None;
    }
    Some(
        profile
            .credential_file_candidates
            .iter()
            .any(|candidate| Path::new(&expand_vars(candidate, home)).is_file()),
    )
}

fn expand_vars(value: &str, home: &Path) -> String {
    let chars: Vec<char> = value.chars().collect();
    let mut out = String::with_capacity(value.len());
    let mut index = 0;
    while index < chars.len() {
        if chars[index] == '$' && chars.get(index + 1) == Some(&'{') {
            if let Some(end) = chars[index + 2..].iter().position(|c| *c == '}') {
                let name: String = chars[index + 2..index + 2 + end].iter().collect();
                out.push_str(&variable_value(&name, home));
                index += end + 3;
                continue;
            }
        }
        if chars[index] == '%' {
            if let Some(end) = chars[index + 1..].iter().position(|c| *c == '%') {
                let name: String = chars[index + 1..index + 1 + end].iter().collect();
                if !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                    out.push_str(&variable_value(&name, home));
                    index += end + 2;
                    continue;
                }
            }
        }
        out.push(chars[index]);
        index += 1;
    }
    out
}

fn variable_value(name: &str, home: &Path) -> String {
    if name.eq_ignore_ascii_case("USERPROFILE") || name.eq_ignore_ascii_case("HOME") {
        return home.display().to_string();
    }
    std::env::var(name).unwrap_or_default()
}

fn find_on_path(command: &str) -> Option<PathBuf> {
    let direct = Path::new(command);
    if direct.is_file() {
        return Some(direct.to_path_buf());
    }
    let names = command_file_names(command);
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        for name in &names {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn command_file_names(command: &str) -> Vec<String> {
    if cfg!(windows) && Path::new(command).extension().is_none() {
        vec![
            format!("{command}.exe"),
            format!("{command}.cmd"),
            format!("{command}.bat"),
            command.to_string(),
        ]
    } else {
        vec![command.to_string()]
    }
}

fn probe_version(path: &Path, args: &[String], home: &Path) -> Option<String> {
    let mut command = background_command(path);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    apply_safe_env(&mut command, home);
    let output = run_with_timeout(command, VERSION_TIMEOUT)?;
    let bytes = if output.stdout.iter().any(|byte| !byte.is_ascii_whitespace()) {
        output.stdout
    } else {
        output.stderr
    };
    let text = String::from_utf8_lossy(&bytes);
    let line = text.lines().map(str::trim).find(|line| !line.is_empty())?;
    Some(line.chars().take(VERSION_MAX_CHARS).collect())
}

/// Keep credential-bearing environment variables away from the probed CLI;
/// only what a `--version` call needs is forwarded.
fn apply_safe_env(command: &mut Command, home: &Path) {
    command.env_clear();
    for name in SAFE_ENV_NAMES {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    if std::env::var_os("HOME").is_none() {
        command.env("HOME", home);
    }
}

fn run_with_timeout(mut command: Command, timeout: Duration) -> Option<Output> {
    let mut child = command.spawn().ok()?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return child.wait_with_output().ok(),
            Ok(None) => {
                if started.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(_) => return None,
        }
    }
}

fn collect_skill_files(skill_root: &Path) -> Result<Vec<(String, PathBuf)>, String> {
    let mut files = Vec::new();
    collect_files_inner(skill_root, skill_root, &mut files)?;
    files.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(files)
}

fn collect_files_inner(
    dir: &Path,
    skill_root: &Path,
    files: &mut Vec<(String, PathBuf)>,
) -> Result<(), String> {
    let entries = std::fs::read_dir(dir)
        .map_err(|error| format!("failed to read {}: {error}", dir.display()))?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if fsutil::is_ignored_entry(&name) {
            continue;
        }
        let path = entry.path();
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|error| format!("failed to inspect {}: {error}", path.display()))?;
        if metadata.is_dir() {
            collect_files_inner(&path, skill_root, files)?;
        } else if metadata.is_file() {
            let relative = path
                .strip_prefix(skill_root)
                .map_err(|error| format!("failed to resolve {}: {error}", path.display()))?
                .to_string_lossy()
                .replace('\\', "/");
            files.push((relative, path));
        }
    }
    Ok(())
}

fn planned_change(source: &Path, target: &Path) -> &'static str {
    if !target.exists() {
        return "create";
    }
    match (std::fs::read(source), std::fs::read(target)) {
        (Ok(source), Ok(target)) if source == target => "unchanged",
        _ => "overwrite",
    }
}

fn join_relative(root: &Path, relative: &str) -> PathBuf {
    relative
        .split('/')
        .fold(root.to_path_buf(), |path, segment| path.join(segment))
}

/// Re-join a path from its components so mixed separators from the Agent
/// metadata table (`home.join(".claude/skills")`) render natively.
fn native_path(path: &Path) -> PathBuf {
    path.components().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::sync::MutexGuard;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempEnv {
        home: PathBuf,
        bin: PathBuf,
        lock: MutexGuard<'static, ()>,
        previous: Vec<(&'static str, Option<OsString>)>,
    }

    const ISOLATED_VARS: [&str; 8] = [
        "HOME",
        "VIBEBOARD_HOME",
        "PATH",
        "USERPROFILE",
        "APPDATA",
        "LOCALAPPDATA",
        "OPENCODE_BIN",
        "AGY_BIN",
    ];

    impl TempEnv {
        fn new(label: &str) -> Self {
            let lock = crate::skills::lock_shared_test_home();
            let suffix = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let home = std::env::temp_dir().join(format!("vibe-board-dispatch-{label}-{suffix}"));
            let bin = home.join("bin");
            std::fs::create_dir_all(&bin).unwrap();
            let previous = ISOLATED_VARS
                .iter()
                .map(|name| (*name, std::env::var_os(name)))
                .collect::<Vec<_>>();
            for name in ISOLATED_VARS {
                let value = match name {
                    "PATH" => bin.display().to_string(),
                    // Never let a real CLI override the isolated stubs.
                    "OPENCODE_BIN" | "AGY_BIN" => String::new(),
                    _ => home.display().to_string(),
                };
                std::env::set_var(name, value);
            }
            Self {
                home,
                bin,
                lock,
                previous,
            }
        }

        fn stub(&self, name: &str, version: &str) -> PathBuf {
            let path = self.bin.join(stub_file_name(name));
            #[cfg(windows)]
            std::fs::write(
                &path,
                format!("@echo off\r\necho {version}\r\nexit /b 0\r\n"),
            )
            .unwrap();
            #[cfg(not(windows))]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::write(&path, format!("#!/bin/sh\necho {version}\n")).unwrap();
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
            path
        }

        /// A local stand-in for `npx skills add`: writes the installed Skill
        /// tree and the `.skill-lock.json` source records itself, so no test
        /// ever reaches GitHub or a real npm.
        fn stub_npx_install(&self) -> PathBuf {
            let path = self.bin.join(stub_file_name("npx"));
            #[cfg(windows)]
            {
                let script = format!(
                    "@echo off\r\n\
                     echo %*> \"%HOME%\\npx-args.txt\"\r\n\
                     set \"ROOT=%HOME%\\.agents\\skills\"\r\n\
                     mkdir \"%ROOT%\\external-agent-core\" 2>nul\r\n\
                     mkdir \"%ROOT%\\external-agent-setup\" 2>nul\r\n\
                     mkdir \"%ROOT%\\opencode-agent\" 2>nul\r\n\
                     mkdir \"%ROOT%\\antigravity-agent\" 2>nul\r\n\
                     echo # core> \"%ROOT%\\external-agent-core\\SKILL.md\"\r\n\
                     echo # setup> \"%ROOT%\\external-agent-setup\\SKILL.md\"\r\n\
                     echo # opencode> \"%ROOT%\\opencode-agent\\SKILL.md\"\r\n\
                     echo # antigravity> \"%ROOT%\\antigravity-agent\\SKILL.md\"\r\n\
                     echo {{\"version\":3,\"skills\":{{\"external-agent-core\":{{\"sourceType\":\"github\",\"sourceUrl\":\"https://github.com/hyNous/agent-dispatch.git\",\"skillPath\":\"skills/external-agent-core/SKILL.md\"}},\"external-agent-setup\":{{\"sourceType\":\"github\",\"sourceUrl\":\"https://github.com/hyNous/agent-dispatch.git\"}},\"opencode-agent\":{{\"sourceType\":\"github\",\"sourceUrl\":\"https://github.com/hyNous/agent-dispatch.git\"}},\"antigravity-agent\":{{\"sourceType\":\"github\",\"sourceUrl\":\"https://github.com/hyNous/agent-dispatch.git\"}}}}}}> \"%HOME%\\.agents\\.skill-lock.json\"\r\n\
                     exit /b 0\r\n"
                );
                std::fs::write(&path, script).unwrap();
            }
            #[cfg(not(windows))]
            {
                use std::os::unix::fs::PermissionsExt;
                let script = "#!/bin/sh\n\
                    printf '%s\\n' \"$@\" > \"$HOME/npx-args.txt\"\n\
                    ROOT=\"$HOME/.agents/skills\"\n\
                    mkdir -p \"$ROOT/external-agent-core\" \"$ROOT/external-agent-setup\" \"$ROOT/opencode-agent\" \"$ROOT/antigravity-agent\"\n\
                    printf '# core\\n' > \"$ROOT/external-agent-core/SKILL.md\"\n\
                    printf '# setup\\n' > \"$ROOT/external-agent-setup/SKILL.md\"\n\
                    printf '# opencode\\n' > \"$ROOT/opencode-agent/SKILL.md\"\n\
                    printf '# antigravity\\n' > \"$ROOT/antigravity-agent/SKILL.md\"\n\
                    printf '{\"version\":3,\"skills\":{\"external-agent-core\":{\"sourceType\":\"github\",\"sourceUrl\":\"https://github.com/hyNous/agent-dispatch.git\"},\"external-agent-setup\":{\"sourceType\":\"github\",\"sourceUrl\":\"https://github.com/hyNous/agent-dispatch.git\"},\"opencode-agent\":{\"sourceType\":\"github\",\"sourceUrl\":\"https://github.com/hyNous/agent-dispatch.git\"},\"antigravity-agent\":{\"sourceType\":\"github\",\"sourceUrl\":\"https://github.com/hyNous/agent-dispatch.git\"}}}\\n' > \"$HOME/.agents/.skill-lock.json\"\n\
                    exit 0\n";
                std::fs::write(&path, script).unwrap();
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
            path
        }
    }

    #[cfg(windows)]
    fn stub_file_name(name: &str) -> String {
        format!("{name}.cmd")
    }

    #[cfg(not(windows))]
    fn stub_file_name(name: &str) -> String {
        name.to_string()
    }

    impl Drop for TempEnv {
        fn drop(&mut self) {
            for (name, value) in self.previous.drain(..) {
                match value {
                    Some(value) => std::env::set_var(name, value),
                    None => std::env::remove_var(name),
                }
            }
            let _ = std::fs::remove_dir_all(&self.home);
            let _ = &self.lock;
        }
    }

    /// Reproduce the maintainer machine: the dispatch Skills are installed in
    /// the shared root and a local catalog describes the two workers.
    fn seed_installed_dispatch_skills(env: &TempEnv) {
        let root = installed_skills_root(&env.home);
        for skill in INSTALLED_SKILLS {
            std::fs::create_dir_all(root.join(skill)).unwrap();
            std::fs::write(root.join(skill).join("SKILL.md"), format!("# {skill}\n")).unwrap();
        }
        std::fs::write(
            root.join("external-agent-setup").join("providers.json"),
            serde_json::json!({
                "providers": {
                    "opencode": {
                        "command": "opencode",
                        "command_env": "OPENCODE_BIN",
                        "check_args": ["--version"],
                        "quota_check": {
                            "credential_file_candidates": ["${USERPROFILE}/.local/share/opencode/auth.json"]
                        }
                    },
                    "antigravity": {
                        "command": "agy",
                        "command_env": "AGY_BIN",
                        "check_args": ["--version"]
                    }
                }
            })
            .to_string(),
        )
        .unwrap();
    }

    fn stub_workers(env: &TempEnv) {
        env.stub("node", "v20.11.0");
        env.stub("opencode", "1.2.3");
        env.stub("agy", "3.4.5");
    }

    fn walk_files(root: &Path) -> Vec<PathBuf> {
        let mut files = Vec::new();
        if !root.is_dir() {
            return files;
        }
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).unwrap().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else {
                    files.push(path);
                }
            }
        }
        files.sort();
        files
    }

    /// Directory symlink on unix, junction on Windows (junctions need no
    /// privilege). Returns false when the filesystem refuses to make one; the
    /// caller then skips the link-specific assertions with a note.
    fn make_dir_link(target: &Path, link: &Path) -> bool {
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link).is_ok()
        }
        #[cfg(windows)]
        {
            let status = Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(link)
                .arg(target)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            matches!(status, Ok(status) if status.success())
                && std::fs::symlink_metadata(link)
                    .map(|metadata| metadata.file_type().is_symlink())
                    .unwrap_or(false)
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = (target, link);
            false
        }
    }

    fn tree_for(env: &TempEnv, detected: &[&str]) -> DispatchTree {
        // Production detection walks PATH; tests inject the Agent ids so the
        // tree shape never depends on programs installed on the test machine.
        tree_at(&env.home, &|agent_id| detected.contains(&agent_id))
    }

    fn connection_workers(node: &DispatchAgentNode) -> Vec<&str> {
        node.connections
            .iter()
            .map(|connection| connection.worker_id.as_str())
            .collect()
    }

    #[test]
    fn ignored_entries_are_not_part_of_a_connection() {
        let root = std::env::temp_dir().join(format!(
            "vibe-board-dispatch-walk-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(root.join("scripts")).unwrap();
        std::fs::create_dir_all(root.join("node_modules").join("pkg")).unwrap();
        std::fs::write(root.join("SKILL.md"), "# Skill").unwrap();
        std::fs::write(root.join("scripts").join("run.mjs"), "export {};\n").unwrap();
        std::fs::write(root.join("node_modules").join("pkg").join("index.js"), "0").unwrap();
        std::fs::write(root.join(".DS_Store"), "junk").unwrap();

        let files = collect_skill_files(&root).unwrap();
        let relative = files
            .iter()
            .map(|(relative, _)| relative.clone())
            .collect::<Vec<_>>();

        assert_eq!(relative, vec!["SKILL.md", "scripts/run.mjs"]);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn tree_offers_the_github_install_before_the_tool_is_installed() {
        let env = TempEnv::new("not-installed");
        stub_workers(&env);

        let tree = tree_for(&env, &["claude-code", "codex"]);

        assert!(!tree.tool_installed);
        assert!(tree.workers.is_empty(), "no catalog before the install");
        assert!(tree.agents.iter().all(|agent| agent.connections.is_empty()));
        assert!(tree
            .agents
            .iter()
            .all(|agent| agent.addable_workers.is_empty()));
    }

    #[test]
    fn install_requires_confirmation_then_installs_through_a_local_stub() {
        let env = TempEnv::new("install");
        stub_workers(&env);
        env.stub_npx_install();

        let error = install_tool_at(&env.home, false).unwrap_err();
        assert!(error.contains("CONFIRMATION_REQUIRED"), "{error}");
        assert!(!env.home.join(".agents").exists());

        let result = install_tool_at(&env.home, true).unwrap();
        assert!(result.tool_installed);
        assert!(result.source_recorded);
        assert!(dispatch_skills_installed(&env.home));

        let args = std::fs::read_to_string(env.home.join("npx-args.txt")).unwrap();
        for expected in [
            "skills",
            "add",
            "hyNous/agent-dispatch",
            "--global",
            "--agent",
            "claude-code",
            "--agent",
            "codex",
            "--yes",
        ] {
            assert!(args.contains(expected), "{expected} missing from {args}");
        }

        let lock = skill_lock::load(&env.home);
        assert_eq!(
            skill_lock::github_repo(skill_lock::find(&lock, "opencode-agent").unwrap()),
            Some(("hyNous".to_string(), "agent-dispatch".to_string()))
        );

        let tree = tree_for(&env, &["claude-code", "codex"]);
        assert!(tree.tool_installed);
    }

    #[test]
    fn install_without_npx_reports_missing_node() {
        let env = TempEnv::new("install-no-node");

        let error = install_tool_at(&env.home, true).unwrap_err();
        assert!(error.contains("NODE_MISSING"), "{error}");
        assert!(!env.home.join(".agents").exists());
    }

    #[test]
    fn maintainer_fixture_connects_claude_code_codex_and_opencode() {
        let env = TempEnv::new("fixture");
        stub_workers(&env);
        seed_installed_dispatch_skills(&env);

        let shared = installed_skills_root(&env.home);
        let claude_root = env.home.join(".claude").join("skills");
        std::fs::create_dir_all(&claude_root).unwrap();
        for skill in INSTALLED_SKILLS {
            if !make_dir_link(&shared.join(skill), &claude_root.join(skill)) {
                eprintln!(
                    "skipping link assertions: this filesystem cannot create directory links"
                );
                return;
            }
        }

        let tree = tree_for(&env, &["claude-code", "codex", "opencode"]);
        assert!(tree.tool_installed);
        let node = |id: &str| {
            tree.agents
                .iter()
                .find(|agent| agent.agent_id == id)
                .unwrap_or_else(|| panic!("{id} node"))
        };
        for agent_id in ["claude-code", "codex"] {
            assert_eq!(
                connection_workers(node(agent_id)),
                vec!["opencode", "antigravity"],
                "{agent_id} must read both workers"
            );
        }
        // OpenCode reads the same folder but is never its own worker.
        assert_eq!(connection_workers(node("opencode")), vec!["antigravity"]);

        // The shared-dir Agents name each other; Claude Code has its own links.
        let codex = node("codex");
        let shared_connection = codex
            .connections
            .iter()
            .find(|connection| connection.worker_id == "opencode")
            .unwrap();
        assert!(Path::new(&shared_connection.dir) == installed_skills_root(&env.home).as_path());
        assert!(
            shared_connection
                .shared_with
                .iter()
                .any(|name| name == "OpenCode"),
            "{:?}",
            shared_connection.shared_with
        );
        let claude = node("claude-code");
        assert!(claude
            .connections
            .iter()
            .all(|connection| connection.shared_with.is_empty()));
        let opencode = node("opencode");
        assert!(
            opencode
                .connections
                .iter()
                .all(|connection| connection.shared_with.iter().any(|name| name == "Codex")),
            "{:?}",
            opencode.connections
        );

        assert!(node("claude-code").addable_workers.is_empty());
        assert!(node("codex").addable_workers.is_empty());
        assert!(node("opencode").addable_workers.is_empty());
    }

    #[test]
    fn an_agent_is_never_offered_as_its_own_worker() {
        let env = TempEnv::new("self");
        stub_workers(&env);
        seed_installed_dispatch_skills(&env);
        // The fixture pre-installs both workers, so make them addable again by
        // removing the workers from the shared root.
        for skill in ["opencode-agent", "antigravity-agent"] {
            std::fs::remove_dir_all(installed_skills_root(&env.home).join(skill)).unwrap();
        }

        let tree = tree_for(&env, &["opencode", "antigravity"]);
        let node = |id: &str| {
            tree.agents
                .iter()
                .find(|agent| agent.agent_id == id)
                .unwrap_or_else(|| panic!("{id} node"))
        };
        assert_eq!(node("opencode").addable_workers, vec!["antigravity"]);
        assert_eq!(node("antigravity").addable_workers, vec!["opencode"]);

        let error = connect_plan_at(&env.home, "opencode", "opencode")
            .expect_err("self dispatch is rejected");
        assert!(error.contains("itself"), "{error}");
    }

    #[test]
    fn tree_omits_agents_without_a_detected_program() {
        let env = TempEnv::new("tree-undetected");
        stub_workers(&env);
        seed_installed_dispatch_skills(&env);

        let tree = tree_for(&env, &["claude-code"]);

        assert_eq!(tree.agents.len(), 1);
        assert_eq!(tree.agents[0].agent_id, "claude-code");
    }

    #[test]
    fn tree_reports_a_linked_worker_as_connected() {
        let env = TempEnv::new("tree-link");
        stub_workers(&env);
        seed_installed_dispatch_skills(&env);
        let stored = installed_skills_root(&env.home).join("opencode-agent");
        let link = env
            .home
            .join(".claude")
            .join("skills")
            .join("opencode-agent");
        std::fs::create_dir_all(link.parent().unwrap()).unwrap();
        if !make_dir_link(&stored, &link) {
            eprintln!("skipping link assertions: this filesystem cannot create directory links");
            return;
        }

        let tree = tree_for(&env, &["claude-code"]);

        assert_eq!(connection_workers(&tree.agents[0]), vec!["opencode"]);
    }

    #[test]
    fn detection_reports_stub_programs_without_credential_values() {
        let env = TempEnv::new("detect");
        stub_workers(&env);
        seed_installed_dispatch_skills(&env);
        let credential_file = env.home.join(".local/share/opencode/auth.json");
        std::fs::create_dir_all(credential_file.parent().unwrap()).unwrap();
        std::fs::write(
            &credential_file,
            r#"{"opencode-go":"super-secret-credential-value"}"#,
        )
        .unwrap();
        std::env::set_var("OPENCODE_API_KEY", "another-secret-marker");

        let tree = tree_for(&env, &["claude-code"]);

        assert!(tree.node.available);
        assert!(tree
            .node
            .version
            .as_deref()
            .is_some_and(|version| version.contains("20.11.0")));
        assert!(tree
            .node
            .program_path
            .as_deref()
            .is_some_and(|path| path.ends_with(&stub_file_name("node"))));

        let opencode = tree
            .workers
            .iter()
            .find(|worker| worker.id == "opencode")
            .unwrap();
        assert_eq!(opencode.display_name, "OpenCode");
        assert_eq!(opencode.version.as_deref(), Some("1.2.3"));
        assert_eq!(opencode.credential_file_present, Some(true));

        let antigravity = tree
            .workers
            .iter()
            .find(|worker| worker.id == "antigravity")
            .unwrap();
        assert_eq!(antigravity.version.as_deref(), Some("3.4.5"));
        assert_eq!(antigravity.credential_file_present, None);

        let json = serde_json::to_string(&tree).unwrap();
        assert!(!json.contains("super-secret-credential-value"));
        assert!(!json.contains("another-secret-marker"));

        std::env::remove_var("OPENCODE_API_KEY");
    }

    #[test]
    fn connect_plan_lists_exactly_the_files_apply_writes() {
        let env = TempEnv::new("plan-apply");
        stub_workers(&env);
        seed_installed_dispatch_skills(&env);

        let plan = connect_plan_at(&env.home, "claude-code", "opencode").unwrap();
        assert!(plan.blockers.is_empty(), "{:?}", plan.blockers);
        assert!(plan.can_apply);
        assert_eq!(plan.agent_display_name, "Claude Code");
        assert_eq!(plan.worker_display_name, "OpenCode");
        assert!(!plan.files.is_empty());

        let mut planned_paths = plan
            .files
            .iter()
            .map(|file| file.target_path.clone())
            .collect::<Vec<_>>();
        let unique = {
            let mut sorted = planned_paths.clone();
            sorted.sort();
            sorted.dedup();
            sorted
        };
        assert_eq!(
            unique.len(),
            planned_paths.len(),
            "no duplicate plan entries"
        );
        planned_paths.sort();

        let skills_root = env.home.join(".claude").join("skills");
        for file in &plan.files {
            let target = Path::new(&file.target_path);
            assert!(
                target.starts_with(&skills_root),
                "{} must be inside the Agent skill directory",
                file.target_path
            );
            assert!(Path::new(&file.source_path).is_file());
        }
        for skill in [
            "external-agent-core",
            "external-agent-setup",
            "opencode-agent",
        ] {
            assert!(
                plan.files.iter().any(|file| file.skill_id == skill),
                "{skill} must be planned"
            );
        }

        let result = connect_apply_at(&env.home, "claude-code", "opencode", true).unwrap();
        assert_eq!(result.written_files, plan.files);

        let written = walk_files(&skills_root);
        let mut written_strings = written
            .iter()
            .map(|path| path.display().to_string())
            .collect::<Vec<_>>();
        written_strings.sort();
        assert_eq!(written_strings, planned_paths);

        for file in &plan.files {
            let source = std::fs::read(&file.source_path).unwrap();
            let target = std::fs::read(&file.target_path).unwrap();
            assert_eq!(source, target, "{} content must match", file.target_path);
        }
    }

    #[test]
    fn connect_requires_confirmation_and_writes_nothing_without_it() {
        let env = TempEnv::new("confirm");
        stub_workers(&env);
        seed_installed_dispatch_skills(&env);

        let error = connect_apply_at(&env.home, "claude-code", "opencode", false).unwrap_err();
        assert!(error.contains("CONFIRMATION_REQUIRED"), "{error}");
        assert!(!env.home.join(".claude").exists());

        let error = disconnect_apply_at(&env.home, "claude-code", "opencode", false).unwrap_err();
        assert!(error.contains("CONFIRMATION_REQUIRED"), "{error}");
        assert!(!env.home.join(".claude").exists());
    }

    #[test]
    fn connect_is_idempotent_and_never_touches_global_instruction_files() {
        let env = TempEnv::new("idempotent");
        stub_workers(&env);
        seed_installed_dispatch_skills(&env);

        let instruction_files = [
            env.home.join(".claude").join("CLAUDE.md"),
            env.home.join(".codex").join("AGENTS.md"),
            env.home.join("AGENTS.md"),
        ];
        for (index, path) in instruction_files.iter().enumerate() {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(
                path,
                format!("# user rules {index}\nkeep me byte-identical\n"),
            )
            .unwrap();
        }
        let before = instruction_files
            .iter()
            .map(|path| std::fs::read(path).unwrap())
            .collect::<Vec<_>>();

        let first = connect_apply_at(&env.home, "claude-code", "opencode", true).unwrap();
        let first_snapshot = walk_files(&env.home.join(".claude").join("skills"))
            .into_iter()
            .map(|path| (path.clone(), std::fs::read(&path).unwrap()))
            .collect::<Vec<_>>();
        assert!(first
            .written_files
            .iter()
            .all(|file| file.change == "create"));

        let second = connect_apply_at(&env.home, "claude-code", "opencode", true).unwrap();
        let paths = |files: &[DispatchPlanFile]| {
            files
                .iter()
                .map(|file| file.target_path.clone())
                .collect::<Vec<_>>()
        };
        assert_eq!(paths(&second.written_files), paths(&first.written_files));
        assert!(second
            .written_files
            .iter()
            .all(|file| file.change == "unchanged"));

        let second_snapshot = walk_files(&env.home.join(".claude").join("skills"))
            .into_iter()
            .map(|path| (path.clone(), std::fs::read(&path).unwrap()))
            .collect::<Vec<_>>();
        assert_eq!(second_snapshot, first_snapshot);

        let after = instruction_files
            .iter()
            .map(|path| std::fs::read(path).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(after, before);
    }

    #[test]
    fn connect_plan_marks_a_locally_edited_copy_as_overwritten() {
        let env = TempEnv::new("overwrite");
        stub_workers(&env);
        seed_installed_dispatch_skills(&env);
        connect_apply_at(&env.home, "claude-code", "opencode", true).unwrap();

        let edited = env
            .home
            .join(".claude")
            .join("skills")
            .join("opencode-agent")
            .join("SKILL.md");
        std::fs::write(&edited, "my own edited copy\n").unwrap();

        let plan = connect_plan_at(&env.home, "claude-code", "opencode").unwrap();
        let edited_entry = plan
            .files
            .iter()
            .find(|file| Path::new(&file.target_path) == edited)
            .expect("edited file is part of the plan");
        assert_eq!(edited_entry.change, "overwrite");
        assert_eq!(
            plan.files
                .iter()
                .filter(|file| file.change == "overwrite")
                .count(),
            1
        );
        assert!(plan
            .files
            .iter()
            .filter(|file| Path::new(&file.target_path) != edited)
            .all(|file| file.change == "unchanged"));
    }

    #[test]
    fn missing_node_blocks_connecting() {
        let env = TempEnv::new("no-node");
        env.stub("opencode", "1.2.3");
        env.stub("agy", "3.4.5");
        seed_installed_dispatch_skills(&env);

        let tree = tree_for(&env, &["claude-code"]);
        assert!(!tree.node.available);

        let plan = connect_plan_at(&env.home, "claude-code", "opencode").unwrap();
        assert!(plan.blockers.contains(&"node_missing".to_string()));
        assert!(!plan.can_apply);
        assert!(
            !plan.files.is_empty(),
            "preview still lists what would be installed"
        );

        let error = connect_apply_at(&env.home, "claude-code", "opencode", true).unwrap_err();
        assert!(error.contains("node_missing"), "{error}");
        assert!(!env.home.join(".claude").exists());
    }

    #[test]
    fn disconnect_removes_links_without_touching_their_targets() {
        let env = TempEnv::new("disconnect-link");
        stub_workers(&env);
        seed_installed_dispatch_skills(&env);
        connect_apply_at(&env.home, "claude-code", "opencode", true).unwrap();

        let skills_root = env.home.join(".claude").join("skills");
        let worker_link = skills_root.join("opencode-agent");
        let core_link = skills_root.join("external-agent-core");
        std::fs::remove_dir_all(&worker_link).unwrap();
        std::fs::remove_dir_all(&core_link).unwrap();
        if !make_dir_link(
            &installed_skills_root(&env.home).join("opencode-agent"),
            &worker_link,
        ) || !make_dir_link(
            &installed_skills_root(&env.home).join("external-agent-core"),
            &core_link,
        ) {
            eprintln!("skipping link assertions: this filesystem cannot create directory links");
            return;
        }

        let plan = disconnect_plan_at(&env.home, "claude-code", "opencode").unwrap();
        assert!(plan.can_apply);
        assert_eq!(
            plan.removals
                .iter()
                .map(|entry| (entry.skill_id.as_str(), entry.action.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("opencode-agent", "remove_link"),
                ("external-agent-core", "remove_link")
            ]
        );
        assert!(plan.kept.is_empty());

        let result = disconnect_apply_at(&env.home, "claude-code", "opencode", true).unwrap();
        assert_eq!(result.removed, plan.removals);
        assert!(!worker_link.exists(), "the link must be gone");
        assert!(!core_link.exists(), "the core link must be gone");
        assert!(installed_skills_root(&env.home)
            .join("opencode-agent")
            .join("SKILL.md")
            .is_file());
        assert!(
            skills_root
                .join("external-agent-setup")
                .join("SKILL.md")
                .is_file(),
            "the setup Skill stays so other tools can still be connected"
        );
    }

    #[test]
    fn disconnect_keeps_a_user_modified_worker_skill_and_explains_why() {
        let env = TempEnv::new("disconnect-modified");
        stub_workers(&env);
        seed_installed_dispatch_skills(&env);
        connect_apply_at(&env.home, "claude-code", "opencode", true).unwrap();

        let worker_skill = env
            .home
            .join(".claude")
            .join("skills")
            .join("opencode-agent");
        std::fs::write(worker_skill.join("SKILL.md"), "my own edited copy\n").unwrap();

        let plan = disconnect_plan_at(&env.home, "claude-code", "opencode").unwrap();
        assert!(
            plan.can_apply,
            "the user can still confirm and see the reason"
        );
        assert_eq!(
            plan.kept
                .iter()
                .map(|entry| (entry.skill_id.as_str(), entry.action.as_str()))
                .collect::<Vec<_>>(),
            vec![("opencode-agent", "keep_modified")]
        );
        assert!(
            plan.removals.is_empty(),
            "the shared core must stay while the worker copy remains"
        );

        let result = disconnect_apply_at(&env.home, "claude-code", "opencode", true).unwrap();
        assert!(result.removed.is_empty());
        assert_eq!(result.kept, plan.kept);
        assert!(worker_skill.join("SKILL.md").is_file());
        assert!(env
            .home
            .join(".claude")
            .join("skills")
            .join("external-agent-core")
            .join("SKILL.md")
            .is_file());
    }

    #[test]
    fn disconnect_removes_the_shared_core_only_after_the_last_worker() {
        let env = TempEnv::new("disconnect-last");
        stub_workers(&env);
        seed_installed_dispatch_skills(&env);
        connect_apply_at(&env.home, "claude-code", "opencode", true).unwrap();
        connect_apply_at(&env.home, "claude-code", "antigravity", true).unwrap();

        let skills_root = env.home.join(".claude").join("skills");
        let core = skills_root.join("external-agent-core");

        let first = disconnect_apply_at(&env.home, "claude-code", "opencode", true).unwrap();
        assert_eq!(
            first
                .removed
                .iter()
                .map(|entry| entry.skill_id.as_str())
                .collect::<Vec<_>>(),
            vec!["opencode-agent"]
        );
        assert!(
            core.join("SKILL.md").is_file(),
            "another worker still needs the core"
        );

        let second = disconnect_apply_at(&env.home, "claude-code", "antigravity", true).unwrap();
        assert_eq!(
            second
                .removed
                .iter()
                .map(|entry| entry.skill_id.as_str())
                .collect::<Vec<_>>(),
            vec!["antigravity-agent", "external-agent-core"]
        );
        assert!(!core.exists());

        let tree = tree_for(&env, &["claude-code"]);
        assert!(tree.agents[0].connections.is_empty());
    }

    #[test]
    fn disconnecting_a_shared_worker_warns_about_the_other_shared_agent() {
        let env = TempEnv::new("disconnect-shared");
        stub_workers(&env);
        seed_installed_dispatch_skills(&env);

        // Codex reads the worker from the one shared copy in ~/.agents/skills.
        // Disconnecting must not delete that copy: every other Agent reading the
        // folder (OpenCode here, Claude Code through its link) would lose it,
        // and local edits there have nothing to be compared against.
        let shared_copy = env
            .home
            .join(".agents")
            .join("skills")
            .join("opencode-agent");
        let plan = disconnect_plan_at(&env.home, "codex", "opencode").unwrap();
        let kept = plan
            .kept
            .iter()
            .find(|entry| entry.skill_id == "opencode-agent")
            .expect("shared copy is kept");
        assert_eq!(kept.action, "keep_shared");
        assert!(
            kept.shared_with.iter().any(|name| name == "OpenCode"),
            "{:?}",
            kept.shared_with
        );
        assert!(plan
            .removals
            .iter()
            .all(|entry| Path::new(&entry.target_path) != shared_copy));

        let result = disconnect_apply_at(&env.home, "codex", "opencode", true).unwrap();
        assert!(result
            .removed
            .iter()
            .all(|entry| entry.skill_id != "opencode-agent"));
        assert!(
            shared_copy.join("SKILL.md").is_file(),
            "shared copy survives"
        );
    }
}
