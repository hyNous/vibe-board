//! Dispatch framework setup wizard (settings → 派发框架).
//!
//! Detects the external CLI workers (OpenCode / Antigravity) and Node.js,
//! previews the exact files that installing the bundled dispatch Skills would
//! write into the dispatcher Agents' user-level Skill directories, and copies
//! them only after an explicit confirmation. It never installs a CLI, never
//! reads credential values, and never edits global instruction files
//! (`CLAUDE.md` / `AGENTS.md`).

use crate::platform::process::background_command;
use crate::skills::v2::{agent_meta, fsutil};
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const DISPATCH_AGENT_IDS: [&str; 2] = ["claude-code", "codex"];
const DISPATCH_SKILLS: [&str; 4] = [
    "external-agent-core",
    "external-agent-setup",
    "opencode-agent",
    "antigravity-agent",
];
const WORKER_ORDER: [&str; 2] = ["opencode", "antigravity"];
const CATALOG_RELATIVE: &str = "external-agent-setup/providers.json";
const VERSION_TIMEOUT: Duration = Duration::from_secs(5);
const VERSION_MAX_CHARS: usize = 120;
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
    pub command: String,
    pub detected: bool,
    pub program_path: Option<String>,
    pub version: Option<String>,
    /// Credential *file* presence only; values are never read or reported.
    /// `null` when the bundled profile declares no credential file.
    pub credential_file_present: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchTargetStatus {
    pub agent_id: String,
    pub display_name: String,
    pub program_detected: bool,
    pub skills_dir: String,
    pub installed_skills: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchSkillStatus {
    pub id: String,
    pub present: bool,
    pub file_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchDetection {
    pub node: DispatchNodeStatus,
    pub workers: Vec<DispatchWorkerStatus>,
    pub targets: Vec<DispatchTargetStatus>,
    pub skills: Vec<DispatchSkillStatus>,
    pub resources_root: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchPlanFile {
    pub skill_id: String,
    pub agent_id: String,
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
pub struct DispatchPlan {
    pub detection: DispatchDetection,
    pub files: Vec<DispatchPlanFile>,
    pub blockers: Vec<String>,
    pub can_apply: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchApplyResult {
    pub written_files: Vec<DispatchPlanFile>,
    pub targets: Vec<String>,
}

#[tauri::command(async)]
pub fn dispatch_detect(app: AppHandle) -> Result<DispatchDetection, String> {
    Ok(detect_at(
        dispatch_skills_root(&app).as_deref(),
        &fsutil::home(),
    ))
}

#[tauri::command(async)]
pub fn dispatch_plan(app: AppHandle) -> Result<DispatchPlan, String> {
    plan_at(dispatch_skills_root(&app).as_deref(), &fsutil::home())
}

#[tauri::command(async)]
pub fn dispatch_apply(app: AppHandle, confirm: bool) -> Result<DispatchApplyResult, String> {
    if !confirm {
        return Err(
            "CONFIRMATION_REQUIRED: preview the file list and confirm before installing"
                .to_string(),
        );
    }
    let root = dispatch_skills_root(&app);
    if root.is_none() {
        return Err(
            "DISPATCH_SKILLS_MISSING: bundled dispatch Skills were not found in this installation"
                .to_string(),
        );
    }
    apply_at(root.as_deref(), &fsutil::home(), true)
}

fn dispatch_skills_root(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("dispatch-skills"));
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("dispatch-skills"),
    );
    candidates.into_iter().find(|path| path.is_dir())
}

struct WorkerProfile {
    command: String,
    command_env: Option<String>,
    command_candidates: Vec<String>,
    check_args: Vec<String>,
    credential_file_candidates: Vec<String>,
}

fn load_profiles(resources_root: &Path) -> Result<BTreeMap<String, WorkerProfile>, String> {
    let path = resources_root.join(CATALOG_RELATIVE);
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

fn detect_at(resources_root: Option<&Path>, home: &Path) -> DispatchDetection {
    let skills = DISPATCH_SKILLS
        .iter()
        .map(|id| {
            let dir = resources_root.map(|root| root.join(id));
            let present = dir
                .as_deref()
                .is_some_and(|path| path.join("SKILL.md").is_file());
            let file_count = dir
                .as_deref()
                .and_then(|path| collect_skill_files(path).ok())
                .map(|files| files.len())
                .unwrap_or(0);
            DispatchSkillStatus {
                id: (*id).to_string(),
                present,
                file_count,
            }
        })
        .collect();

    DispatchDetection {
        node: detect_node(home),
        workers: resources_root
            .and_then(|root| load_profiles(root).ok())
            .map(|profiles| detect_workers(&profiles, home))
            .unwrap_or_default(),
        targets: dispatch_targets(home),
        skills,
        resources_root: resources_root.map(|path| path.display().to_string()),
    }
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
                command: profile.command.clone(),
                detected: resolved.is_some(),
                program_path,
                version,
                credential_file_present: credential_file_present(profile, home),
            }
        })
        .collect()
}

fn dispatch_targets(home: &Path) -> Vec<DispatchTargetStatus> {
    DISPATCH_AGENT_IDS
        .iter()
        .filter_map(|agent_id| {
            let skills_dir = agent_meta::agent_skills_dir(home, agent_id)?;
            let installed_skills = DISPATCH_SKILLS
                .iter()
                .filter(|id| skills_dir.join(id).join("SKILL.md").is_file())
                .map(|id| (*id).to_string())
                .collect();
            Some(DispatchTargetStatus {
                agent_id: (*agent_id).to_string(),
                display_name: agent_meta::display_name(agent_id),
                program_detected: agent_meta::agent_program_detected(
                    agent_id,
                    agent_meta::agent_installed(home, agent_id),
                ),
                skills_dir: native_path(&skills_dir).display().to_string(),
                installed_skills,
            })
        })
        .collect()
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

fn plan_at(resources_root: Option<&Path>, home: &Path) -> Result<DispatchPlan, String> {
    let detection = detect_at(resources_root, home);
    let mut blockers = Vec::new();
    if !detection.node.available {
        blockers.push("node_missing".to_string());
    }
    if detection.skills.iter().any(|skill| !skill.present) {
        blockers.push("skills_missing".to_string());
    }
    let catalog_ready = match resources_root {
        Some(root) => match load_profiles(root) {
            Ok(_) => true,
            Err(_) => {
                blockers.push("catalog_invalid".to_string());
                false
            }
        },
        None => false,
    };

    let mut files = Vec::new();
    if catalog_ready && !blockers.iter().any(|blocker| blocker == "skills_missing") {
        if let Some(root) = resources_root {
            for target in &detection.targets {
                let target_root = PathBuf::from(&target.skills_dir);
                for skill_id in DISPATCH_SKILLS {
                    let source_dir = root.join(skill_id);
                    let skill_target = target_root.join(skill_id);
                    for (relative, source_path) in collect_skill_files(&source_dir)? {
                        let target_path = join_relative(&skill_target, &relative);
                        let change = planned_change(&source_path, &target_path);
                        files.push(DispatchPlanFile {
                            skill_id: skill_id.to_string(),
                            agent_id: target.agent_id.clone(),
                            relative_path: relative.clone(),
                            source_path: source_path.display().to_string(),
                            target_path: target_path.display().to_string(),
                            change: change.to_string(),
                        });
                    }
                }
            }
        }
    }

    let can_apply = blockers.is_empty() && !files.is_empty();
    Ok(DispatchPlan {
        detection,
        files,
        blockers,
        can_apply,
    })
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

fn apply_at(
    resources_root: Option<&Path>,
    home: &Path,
    confirm: bool,
) -> Result<DispatchApplyResult, String> {
    if !confirm {
        return Err(
            "CONFIRMATION_REQUIRED: preview the file list and confirm before installing"
                .to_string(),
        );
    }
    let plan = plan_at(resources_root, home)?;
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

    let mut targets = Vec::new();
    for file in &plan.files {
        if !targets.iter().any(|target| target == &file.agent_id) {
            targets.push(file.agent_id.clone());
        }
    }
    Ok(DispatchApplyResult {
        written_files: plan.files,
        targets,
    })
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

    fn repository_resources() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("dispatch-skills")
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

    #[test]
    fn ignored_entries_are_not_part_of_the_installation() {
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
    fn detection_reports_stub_programs_without_credential_values() {
        let env = TempEnv::new("detect");
        env.stub("node", "v20.11.0");
        env.stub("opencode", "1.2.3");
        env.stub("agy", "3.4.5");
        let credential_file = env.home.join(".local/share/opencode/auth.json");
        std::fs::create_dir_all(credential_file.parent().unwrap()).unwrap();
        std::fs::write(
            &credential_file,
            r#"{"opencode-go":"super-secret-credential-value"}"#,
        )
        .unwrap();
        std::env::set_var("OPENCODE_API_KEY", "another-secret-marker");

        let detection = detect_at(Some(&repository_resources()), &env.home);

        assert!(detection.node.available);
        assert!(detection
            .node
            .version
            .as_deref()
            .is_some_and(|version| version.contains("20.11.0")));
        assert!(detection
            .node
            .program_path
            .as_deref()
            .is_some_and(|path| path.ends_with(&stub_file_name("node"))));

        let opencode = detection
            .workers
            .iter()
            .find(|worker| worker.id == "opencode")
            .unwrap();
        assert!(opencode.detected);
        assert_eq!(opencode.display_name, "OpenCode");
        assert_eq!(opencode.version.as_deref(), Some("1.2.3"));
        assert!(opencode
            .program_path
            .as_deref()
            .is_some_and(|path| path.ends_with(&stub_file_name("opencode"))));
        assert_eq!(opencode.credential_file_present, Some(true));

        let antigravity = detection
            .workers
            .iter()
            .find(|worker| worker.id == "antigravity")
            .unwrap();
        assert!(antigravity.detected);
        assert_eq!(antigravity.version.as_deref(), Some("3.4.5"));
        assert_eq!(antigravity.credential_file_present, None);

        let json = serde_json::to_string(&detection).unwrap();
        assert!(!json.contains("super-secret-credential-value"));
        assert!(!json.contains("another-secret-marker"));

        std::env::remove_var("OPENCODE_API_KEY");
    }

    #[test]
    fn plan_lists_exactly_the_files_apply_writes() {
        let env = TempEnv::new("plan-apply");
        env.stub("node", "v20.11.0");
        env.stub("opencode", "1.2.3");
        env.stub("agy", "3.4.5");
        let resources = repository_resources();

        let plan = plan_at(Some(&resources), &env.home).unwrap();
        assert!(plan.blockers.is_empty(), "{:?}", plan.blockers);
        assert!(plan.can_apply);
        assert_eq!(plan.detection.targets.len(), 2);
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

        let claude_root = env.home.join(".claude").join("skills");
        let codex_root = env.home.join(".codex").join("skills");
        for file in &plan.files {
            let target = Path::new(&file.target_path);
            assert!(
                target.starts_with(&claude_root) || target.starts_with(&codex_root),
                "{} must be a dispatcher skill path",
                file.target_path
            );
            assert!(Path::new(&file.source_path).is_file());
        }
        for skill in DISPATCH_SKILLS {
            assert!(
                plan.files
                    .iter()
                    .any(|file| file.skill_id == skill && file.agent_id == "claude-code"),
                "{skill} must be planned for Claude Code"
            );
            assert!(
                plan.files
                    .iter()
                    .any(|file| file.skill_id == skill && file.agent_id == "codex"),
                "{skill} must be planned for Codex"
            );
        }

        let result = apply_at(Some(&resources), &env.home, true).unwrap();
        assert_eq!(result.written_files, plan.files);
        assert_eq!(result.targets, vec!["claude-code", "codex"]);

        let mut written = walk_files(&claude_root);
        written.extend(walk_files(&codex_root));
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
    fn apply_requires_confirmation_and_writes_nothing_without_it() {
        let env = TempEnv::new("confirm");
        env.stub("node", "v20.11.0");
        env.stub("opencode", "1.2.3");
        env.stub("agy", "3.4.5");
        let resources = repository_resources();

        let error = apply_at(Some(&resources), &env.home, false).unwrap_err();
        assert!(error.contains("CONFIRMATION_REQUIRED"), "{error}");
        assert!(!env.home.join(".claude").exists());
        assert!(!env.home.join(".codex").exists());
    }

    #[test]
    fn install_is_idempotent_and_never_touches_global_instruction_files() {
        let env = TempEnv::new("idempotent");
        env.stub("node", "v20.11.0");
        env.stub("opencode", "1.2.3");
        env.stub("agy", "3.4.5");
        let resources = repository_resources();

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

        let first = apply_at(Some(&resources), &env.home, true).unwrap();
        let first_snapshot = walk_files(&env.home.join(".claude").join("skills"))
            .into_iter()
            .chain(walk_files(&env.home.join(".codex").join("skills")))
            .map(|path| (path.clone(), std::fs::read(&path).unwrap()))
            .collect::<Vec<_>>();

        assert!(first
            .written_files
            .iter()
            .all(|file| file.change == "create"));
        let second = apply_at(Some(&resources), &env.home, true).unwrap();
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
            .chain(walk_files(&env.home.join(".codex").join("skills")))
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
    fn preview_marks_a_locally_edited_copy_as_overwritten() {
        let env = TempEnv::new("overwrite");
        env.stub("node", "v20.11.0");
        env.stub("opencode", "1.2.3");
        env.stub("agy", "3.4.5");
        let resources = repository_resources();
        apply_at(Some(&resources), &env.home, true).unwrap();

        let edited = env
            .home
            .join(".claude")
            .join("skills")
            .join("opencode-agent")
            .join("SKILL.md");
        std::fs::write(
            &edited,
            "my own edited copy
",
        )
        .unwrap();

        let plan = plan_at(Some(&resources), &env.home).unwrap();
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
    fn missing_node_blocks_the_installation() {
        let env = TempEnv::new("no-node");
        env.stub("opencode", "1.2.3");
        env.stub("agy", "3.4.5");
        let resources = repository_resources();

        let plan = plan_at(Some(&resources), &env.home).unwrap();
        assert!(!plan.detection.node.available);
        assert!(plan.blockers.contains(&"node_missing".to_string()));
        assert!(!plan.can_apply);
        assert!(
            !plan.files.is_empty(),
            "preview still lists what would be installed"
        );

        let error = apply_at(Some(&resources), &env.home, true).unwrap_err();
        assert!(error.contains("node_missing"), "{error}");
        assert!(!env.home.join(".claude").exists());
        assert!(!env.home.join(".codex").exists());
    }
}
