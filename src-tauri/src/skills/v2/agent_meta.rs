//! Agent display metadata + skill-dir resolution for Skill Manager v2.
//!
//! Reuses the existing `agent_paths` resolver for on-disk locations and layers
//! a stable display-name + icon-key mapping on top.

use crate::skills::{agent_paths, registry};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// The filesystem probe costs a few hundred milliseconds for every known
/// Agent, so results are reused briefly instead of re-walking `PATH` on each
/// overview refresh.
const PROGRAM_PROBE_TTL: Duration = Duration::from_secs(60);
static PROGRAM_PROBE_CACHE: OnceLock<Mutex<HashMap<String, (Instant, bool)>>> = OnceLock::new();

pub struct AgentMeta {
    pub id: &'static str,
    pub display_name: &'static str,
    pub icon_key: &'static str,
}

pub fn display_name(id: &str) -> String {
    table()
        .iter()
        .find(|m| m.id == id)
        .map(|m| m.display_name.to_string())
        .or_else(|| {
            registry::list_custom_agents()
                .into_iter()
                .find(|agent| agent.id == id && agent.is_enabled)
                .map(|agent| agent.display_name)
        })
        .unwrap_or_else(|| humanize(id))
}

pub fn icon_key(id: &str) -> String {
    table()
        .iter()
        .find(|m| m.id == id)
        .map(|m| m.icon_key.to_string())
        .or_else(|| {
            registry::list_custom_agents()
                .into_iter()
                .find(|agent| agent.id == id && agent.is_enabled)
                .and_then(|agent| agent.icon_name)
        })
        .unwrap_or_else(|| id.to_string())
}

/// Agents that can be managed targets, in canonical display order.
pub fn managed_agent_ids() -> Vec<String> {
    let mut ids = vec![
        "agents",
        "claude-code",
        "codex",
        "gemini",
        "antigravity",
        "cursor",
        "opencode",
        "openclaw",
        "qclaw",
        "easyclaw",
        "easyclaw-v2",
        "autoclaw",
        "copilot",
        "qwen",
        "kimi",
        "doubao",
        "deepseek",
        "workbuddy",
        "zcode",
        "windsurf",
        "augment",
        "kilocode",
        "aider",
        "amp",
        "kiro",
        "hermes",
    ]
    .into_iter()
    .map(ToString::to_string)
    .collect::<Vec<_>>();

    for agent in registry::list_custom_agents() {
        if agent.is_enabled && !ids.iter().any(|id| id == &agent.id) {
            ids.push(agent.id);
        }
    }

    ids
}

/// Real coding agents shown in Agent management views. The shared `.agents`
/// skill directory is scanned as an import source, but is not an agent.
pub fn visible_agent_ids() -> Vec<String> {
    managed_agent_ids()
        .into_iter()
        .filter(|id| id != "agents")
        .collect()
}

fn table() -> &'static [AgentMeta] {
    &[
        AgentMeta {
            id: "agents",
            display_name: ".agents",
            icon_key: "agents",
        },
        AgentMeta {
            id: "claude-code",
            display_name: "Claude Code",
            icon_key: "claude-code",
        },
        AgentMeta {
            id: "codex",
            display_name: "Codex",
            icon_key: "codex",
        },
        AgentMeta {
            id: "gemini",
            display_name: "Gemini CLI",
            icon_key: "gemini",
        },
        AgentMeta {
            id: "antigravity",
            display_name: "Antigravity",
            icon_key: "antigravity",
        },
        AgentMeta {
            id: "cursor",
            display_name: "Cursor",
            icon_key: "cursor",
        },
        AgentMeta {
            id: "opencode",
            display_name: "OpenCode",
            icon_key: "opencode",
        },
        AgentMeta {
            id: "openclaw",
            display_name: "OpenClaw",
            icon_key: "openclaw",
        },
        AgentMeta {
            id: "qclaw",
            display_name: "QClaw",
            icon_key: "qclaw",
        },
        AgentMeta {
            id: "easyclaw",
            display_name: "EasyClaw",
            icon_key: "easyclaw",
        },
        AgentMeta {
            id: "easyclaw-v2",
            display_name: "EasyClaw V2",
            icon_key: "easyclaw",
        },
        AgentMeta {
            id: "autoclaw",
            display_name: "AutoClaw",
            icon_key: "autoclaw",
        },
        AgentMeta {
            id: "copilot",
            display_name: "Copilot",
            icon_key: "copilot",
        },
        AgentMeta {
            id: "qwen",
            display_name: "Qwen",
            icon_key: "qwen",
        },
        AgentMeta {
            id: "kimi",
            display_name: "Kimi Code",
            icon_key: "kimi",
        },
        AgentMeta {
            id: "doubao",
            display_name: "Doubao",
            icon_key: "doubao",
        },
        AgentMeta {
            id: "deepseek",
            display_name: "DeepSeek",
            icon_key: "deepseek",
        },
        AgentMeta {
            id: "workbuddy",
            display_name: "WorkBuddy",
            icon_key: "workbuddy",
        },
        AgentMeta {
            id: "zcode",
            display_name: "ZCode",
            icon_key: "zcode",
        },
        AgentMeta {
            id: "windsurf",
            display_name: "Windsurf",
            icon_key: "windsurf",
        },
        AgentMeta {
            id: "augment",
            display_name: "Augment",
            icon_key: "augment",
        },
        AgentMeta {
            id: "kilocode",
            display_name: "Kilo Code",
            icon_key: "kilocode",
        },
        AgentMeta {
            id: "aider",
            display_name: "Aider",
            icon_key: "aider",
        },
        AgentMeta {
            id: "amp",
            display_name: "Amp",
            icon_key: "amp",
        },
        AgentMeta {
            id: "kiro",
            display_name: "Kiro",
            icon_key: "kiro",
        },
        AgentMeta {
            id: "hermes",
            display_name: "Hermes",
            icon_key: "hermes",
        },
    ]
}

fn humanize(id: &str) -> String {
    id.split(['-', '_'])
        .map(|w| {
            let mut c = w.chars();
            match c.next() {
                Some(first) => first.to_uppercase().collect::<String>() + c.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// One user-level Skills directory an Agent reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentSkillReadDir {
    pub path: PathBuf,
    /// The shared `.agents/skills` root. Several Agents read it, so Vibe Board
    /// never writes a second per-Agent copy for Agents that only see a Skill
    /// through this directory.
    pub shared: bool,
}

/// The single source of truth for "which Skills directories does this Agent
/// read". The Handoff page and Skill Manager both resolve paths through this.
#[derive(Debug, Clone)]
pub struct AgentSkillReadDirs {
    pub dirs: Vec<AgentSkillReadDir>,
    /// True when the read locations were verified against real Agent behaviour
    /// on 2026-10-08. Unverified Agents keep the historical table values.
    pub verified: bool,
}

fn read_dirs(
    verified: bool,
    entries: Vec<(PathBuf, bool)>,
    shared_root: &Path,
) -> AgentSkillReadDirs {
    AgentSkillReadDirs {
        dirs: entries
            .into_iter()
            .map(|(path, shared)| AgentSkillReadDir {
                shared: shared || path == shared_root,
                path,
            })
            .collect(),
        verified,
    }
}

/// Verified read locations (maintainer machine, 2026-10-08):
/// - Claude Code reads `~/.claude/skills`.
/// - Codex reads `~/.agents/skills`; `~/.codex/skills` holds its own system
///   Skills.
/// - OpenCode reads `~/.agents/skills` and `~/.claude/skills`.
/// - Antigravity reads `~/.gemini/config/skills` plus every directory declared
///   in `~/.gemini/config/skills.json` under `entries`.
///
/// Every other Agent is marked unverified and keeps its historical values.
pub fn agent_read_skill_dirs(home: &Path, agent: &str) -> AgentSkillReadDirs {
    // Keep the historical path spellings for the shared root and each Agent
    // directory so stored/unmanaged path strings stay stable.
    let shared = home.join(".agents/skills");
    match agent {
        "claude-code" => read_dirs(true, vec![(home.join(".claude/skills"), false)], &shared),
        "codex" => read_dirs(
            true,
            vec![(home.join(".codex/skills"), false), (shared.clone(), true)],
            &shared,
        ),
        "opencode" => read_dirs(
            true,
            vec![(shared.clone(), true), (home.join(".claude/skills"), false)],
            &shared,
        ),
        "antigravity" => {
            let mut entries = vec![(home.join(".gemini/config/skills"), false)];
            entries.extend(
                antigravity_declared_skill_dirs(home)
                    .into_iter()
                    .map(|path| (path, false)),
            );
            read_dirs(true, entries, &shared)
        }
        // Unverified Agents: historical values, never silently corrected.
        "agents" => read_dirs(false, vec![(shared.clone(), true)], &shared),
        "openclaw" => {
            let workspace = openclaw_workspace_dir(home);
            let mut entries = vec![
                (workspace.join("skills"), false),
                (workspace.join(".agents").join("skills"), false),
                (shared.clone(), true),
                (home.join(".openclaw").join("skills"), false),
                (home.join(".openclaw").join("plugin-skills"), false),
            ];
            entries.extend(
                openclaw_bundled_skill_dirs()
                    .into_iter()
                    .map(|path| (path, false)),
            );
            read_dirs(false, entries, &shared)
        }
        "doubao" => read_dirs(
            false,
            agent_paths::doubao_skill_dirs_for(home)
                .into_iter()
                .map(|path| (path, false))
                .collect(),
            &shared,
        ),
        "kimi" => read_dirs(
            false,
            vec![
                (agent_paths::kimi_code_home_for(home).join("skills"), false),
                (shared.clone(), true),
            ],
            &shared,
        ),
        other => {
            let rel = match other {
                "gemini" => Some(".gemini/skills"),
                "cursor" => Some(".cursor/skills"),
                "qclaw" => Some(".qclaw/skills"),
                "easyclaw" => Some(".easyclaw/skills"),
                "easyclaw-v2" => Some(".easyclaw-20260322-01/skills"),
                "autoclaw" => Some(".openclaw-autoclaw/skills"),
                "copilot" => Some(".copilot/skills"),
                "qwen" => Some(".qwen/skills"),
                "deepseek" => Some(".deepseek/skills"),
                "workbuddy" => Some(".workbuddy/skills"),
                "zcode" => Some(".zcode/skills"),
                "windsurf" => Some(".windsurf/skills"),
                "augment" => Some(".augment/skills"),
                "kilocode" => Some(".kilocode/skills"),
                "aider" => Some(".aider/skills"),
                "amp" => Some(".amp/skills"),
                "kiro" => Some(".kiro/skills"),
                "hermes" => Some(".hermes/skills"),
                _ => None,
            };
            match rel {
                Some(rel) => {
                    let mut entries = vec![(home.join(rel), false)];
                    if other == "zcode" {
                        entries.push((shared.clone(), true));
                    }
                    read_dirs(false, entries, &shared)
                }
                None => read_dirs(
                    false,
                    agent_paths::paths_for_agent(other)
                        .skill_dirs
                        .into_iter()
                        .map(|path| (path, false))
                        .collect(),
                    &shared,
                ),
            }
        }
    }
}

/// Directories Antigravity reads because `~/.gemini/config/skills.json` lists
/// them under `entries`. Entries are path strings or objects carrying a
/// path-like field. Relative entries are ignored rather than guessed.
fn antigravity_declared_skill_dirs(home: &Path) -> Vec<PathBuf> {
    let path = home.join(".gemini").join("config").join("skills.json");
    let Ok(content) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) else {
        return Vec::new();
    };
    let Some(entries) = json.get("entries").and_then(|value| value.as_array()) else {
        return Vec::new();
    };
    let mut dirs = Vec::new();
    for entry in entries {
        let raw = entry.as_str().map(ToString::to_string).or_else(|| {
            ["path", "dir", "directory", "skillDir", "skillsDir"]
                .iter()
                .find_map(|key| {
                    entry
                        .get(*key)
                        .and_then(|value| value.as_str())
                        .map(ToString::to_string)
                })
        });
        let Some(raw) = raw else {
            continue;
        };
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        let expanded = expand_home(home, trimmed);
        if expanded.is_absolute() {
            dirs.push(expanded);
        }
    }
    dedupe_paths(dirs)
}

/// Resolve the primary Skills directory for an Agent under a given home.
pub fn agent_skills_dir(home: &std::path::Path, agent: &str) -> Option<PathBuf> {
    agent_read_skill_dirs(home, agent)
        .dirs
        .into_iter()
        .next()
        .map(|dir| dir.path)
}

/// Resolve every skill root an Agent reads, ordered from highest precedence
/// to lowest.
pub fn agent_skill_dirs(home: &Path, agent: &str) -> Vec<PathBuf> {
    agent_read_skill_dirs(home, agent)
        .dirs
        .into_iter()
        .map(|dir| dir.path)
        .collect()
}

/// Whether this Agent reads the shared `.agents/skills` root.
pub fn reads_shared_agents_skills(home: &Path, agent: &str) -> bool {
    agent_read_skill_dirs(home, agent)
        .dirs
        .iter()
        .any(|dir| dir.shared)
}

pub fn agent_owned_skill_dirs(home: &Path, agent: &str) -> Vec<PathBuf> {
    if agent == "doubao" {
        return vec![agent_paths::doubao_user_skills_dir_for(home)];
    }
    if agent == "agents" {
        return vec![home.join(".agents").join("skills")];
    }
    if agent == "openclaw" {
        return vec![
            openclaw_workspace_dir(home).join("skills"),
            home.join(".openclaw").join("skills"),
            home.join(".openclaw").join("plugin-skills"),
        ];
    }
    agent_read_skill_dirs(home, agent)
        .dirs
        .into_iter()
        .filter(|dir| !dir.shared)
        .map(|dir| dir.path)
        .collect()
}

pub fn agent_read_only_skill_dirs(home: &Path, agent: &str) -> Vec<PathBuf> {
    if agent == "doubao" {
        return agent_paths::doubao_builtin_skill_dirs_for(home);
    }
    Vec::new()
}

pub fn is_read_only_agent_skill_path(home: &Path, agent: &str, path: &Path) -> bool {
    agent_read_only_skill_dirs(home, agent)
        .into_iter()
        .any(|root| path.strip_prefix(root).is_ok())
}

/// Runtime status includes the program and Agent-owned residual capabilities;
/// fixture homes keep the broader path-based behavior used by service tests.
pub fn agent_installed(home: &std::path::Path, agent: &str) -> bool {
    #[cfg(not(target_os = "windows"))]
    if is_runtime_home(home) && crate::agents::programs::has_program_metadata(agent) {
        if agent_program_installed(agent) {
            return true;
        }
        if agent_owned_skill_dirs(home, agent)
            .into_iter()
            .any(|path| directory_has_valid_skill(&path, agent == "openclaw"))
        {
            return true;
        }
        let paths = agent_paths::paths_for_agent(agent);
        return [paths.settings_file, paths.mcp_config]
            .into_iter()
            .flatten()
            .any(|path| crate::agents::hook_manager::has_agentbro_hooks(&path));
    }

    for dir in agent_skill_dirs(home, agent) {
        if dir.exists() {
            return true;
        }
    }
    let paths = agent_paths::paths_for_agent(agent);
    if paths
        .settings_file
        .as_ref()
        .is_some_and(|path| path.exists())
        || paths.mcp_config.as_ref().is_some_and(|path| path.exists())
        || paths.skill_dirs.first().is_some_and(|path| path.exists())
    {
        return true;
    }

    #[cfg(target_os = "windows")]
    {
        // Keep the Skill Manager list cheap on Windows. Program probing walks
        // PATH and can block the settings window while every agent is listed.
        false
    }

    #[cfg(not(target_os = "windows"))]
    false
}

/// Whether the local program that backs this Agent was detected. The probe is
/// filesystem-only so the Skill manager can group non-installed Agents behind
/// an explicit control without blocking the settings window. Custom or unknown
/// Agents have no known executable; their config presence is the only signal.
pub fn agent_program_detected(agent: &str, installed: bool) -> bool {
    if !crate::agents::programs::has_program_metadata(agent) {
        return installed;
    }
    let cache = PROGRAM_PROBE_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let mut cache = match cache.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    if let Some((probed_at, value)) = cache.get(agent) {
        if probed_at.elapsed() < PROGRAM_PROBE_TTL {
            return *value;
        }
    }
    let value = crate::agents::programs::program_detected_without_probe(agent);
    cache.insert(agent.to_string(), (Instant::now(), value));
    value
}

fn directory_has_valid_skill(path: &Path, recursive: bool) -> bool {
    directory_has_valid_skill_inner(path, recursive, 0)
}

fn directory_has_valid_skill_inner(path: &Path, recursive: bool, depth: usize) -> bool {
    if depth > 8 {
        return false;
    }
    std::fs::read_dir(path).ok().is_some_and(|entries| {
        entries.filter_map(Result::ok).any(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            if crate::skills::v2::fsutil::is_ignored_entry(&name) || name.starts_with('.') {
                return false;
            }
            let child = entry.path();
            child.is_dir()
                && (crate::skills::v2::fsutil::is_skill_dir(&child)
                    || recursive && directory_has_valid_skill_inner(&child, true, depth + 1))
        })
    })
}

#[cfg(not(target_os = "windows"))]
fn agent_program_installed(agent: &str) -> bool {
    use crate::agents::AdapterStatus;

    matches!(
        crate::agents::programs::detected_status_for_agent_program(agent),
        AdapterStatus::Active | AdapterStatus::Installed | AdapterStatus::Available
    )
}

#[cfg(not(target_os = "windows"))]
fn is_runtime_home(home: &Path) -> bool {
    same_path(home, &crate::skills::v2::fsutil::home())
}

#[cfg(not(target_os = "windows"))]
fn same_path(a: &Path, b: &Path) -> bool {
    let a = a.canonicalize().unwrap_or_else(|_| a.to_path_buf());
    let b = b.canonicalize().unwrap_or_else(|_| b.to_path_buf());
    a == b
}

#[cfg(all(target_os = "windows", test))]
fn same_path(a: &Path, b: &Path) -> bool {
    let a = a.canonicalize().unwrap_or_else(|_| a.to_path_buf());
    let b = b.canonicalize().unwrap_or_else(|_| b.to_path_buf());
    a.to_string_lossy().to_ascii_lowercase() == b.to_string_lossy().to_ascii_lowercase()
}

fn openclaw_workspace_dir(home: &Path) -> PathBuf {
    let config_path = home.join(".openclaw").join("openclaw.json");
    let workspace = std::fs::read_to_string(config_path)
        .ok()
        .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
        .and_then(|json| {
            json.pointer("/agents/defaults/workspace")
                .and_then(|value| value.as_str())
                .map(|value| expand_home(home, value))
        });
    workspace.unwrap_or_else(|| home.join(".openclaw").join("workspace"))
}

fn openclaw_bundled_skill_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(exe) = find_in_path("openclaw") {
        if let Ok(real) = exe.canonicalize() {
            if let Some(parent) = real.parent() {
                dirs.push(parent.join("skills"));
            }
        }
    }
    dirs.push(PathBuf::from(
        "/opt/homebrew/lib/node_modules/openclaw/skills",
    ));
    dirs.push(PathBuf::from("/usr/local/lib/node_modules/openclaw/skills"));
    dirs
}

fn find_in_path(binary: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    std::env::split_paths(&path_var)
        .map(|dir| dir.join(binary))
        .find(|candidate| candidate.is_file())
}

fn expand_home(home: &Path, value: &str) -> PathBuf {
    if let Some(rest) = value.strip_prefix("~/") {
        home.join(rest)
    } else if cfg!(target_os = "windows") {
        value
            .strip_prefix("~\\")
            .map(|rest| home.join(rest))
            .unwrap_or_else(|| PathBuf::from(value))
    } else {
        PathBuf::from(value)
    }
}

fn dedupe_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = std::collections::BTreeSet::new();
    paths
        .into_iter()
        .filter(|path| {
            let key = path.display().to_string();
            seen.insert(key)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workbuddy_is_visible_and_uses_installed_skills_dir() {
        assert!(visible_agent_ids().iter().any(|id| id == "workbuddy"));
        assert_eq!(display_name("workbuddy"), "WorkBuddy");
        assert_eq!(icon_key("workbuddy"), "workbuddy");

        let home = Path::new("/Users/tester");
        assert_eq!(
            agent_skills_dir(home, "workbuddy"),
            Some(home.join(".workbuddy/skills"))
        );
    }

    #[test]
    fn owned_skill_dirs_include_shared_inventory_root() {
        let home = Path::new("/Users/tester");
        assert_eq!(
            agent_owned_skill_dirs(home, "agents"),
            vec![home.join(".agents/skills")]
        );
        assert_eq!(
            agent_owned_skill_dirs(home, "codex"),
            vec![home.join(".codex/skills")]
        );
        assert!(agent_skill_dirs(home, "codex")
            .iter()
            .any(|path| path == &home.join(".agents/skills")));
        assert!(!agent_owned_skill_dirs(home, "openclaw")
            .iter()
            .any(|path| path == &home.join(".agents/skills")));
    }

    #[test]
    fn verified_read_locations_match_agent_behavior() {
        let home = Path::new("/Users/tester");
        let shared = home.join(".agents/skills");
        let entries = |agent: &str| {
            agent_read_skill_dirs(home, agent)
                .dirs
                .into_iter()
                .map(|dir| (dir.path, dir.shared))
                .collect::<Vec<_>>()
        };

        let claude = agent_read_skill_dirs(home, "claude-code");
        assert!(claude.verified);
        assert_eq!(
            entries("claude-code"),
            vec![(home.join(".claude/skills"), false)]
        );

        let codex = agent_read_skill_dirs(home, "codex");
        assert!(codex.verified);
        assert_eq!(
            entries("codex"),
            vec![(home.join(".codex/skills"), false), (shared.clone(), true)]
        );

        let opencode = agent_read_skill_dirs(home, "opencode");
        assert!(opencode.verified);
        assert_eq!(
            entries("opencode"),
            vec![(shared.clone(), true), (home.join(".claude/skills"), false)]
        );
        assert_eq!(
            agent_skills_dir(home, "opencode"),
            Some(shared.clone()),
            "the shared root is OpenCode's primary location"
        );

        let antigravity = agent_read_skill_dirs(home, "antigravity");
        assert!(antigravity.verified);
        assert_eq!(
            entries("antigravity"),
            vec![(home.join(".gemini/config/skills"), false)]
        );

        // Unverified Agents keep the historical table.
        assert!(!agent_read_skill_dirs(home, "gemini").verified);
        assert_eq!(
            entries("gemini"),
            vec![(home.join(".gemini/skills"), false)]
        );
    }

    #[test]
    fn shared_agents_skill_consumers_come_from_the_read_table() {
        let home = Path::new("/Users/tester");
        for agent in ["codex", "kimi", "openclaw", "opencode", "zcode", "agents"] {
            assert!(reads_shared_agents_skills(home, agent), "{agent}");
        }
        for agent in ["claude-code", "cursor", "gemini"] {
            assert!(!reads_shared_agents_skills(home, agent), "{agent}");
        }
    }

    #[test]
    fn antigravity_reads_directories_declared_in_skills_json() {
        let home = std::env::temp_dir().join(format!(
            "agentbro-antigravity-read-dirs-{}",
            uuid::Uuid::new_v4()
        ));
        let config = home.join(".gemini").join("config");
        std::fs::create_dir_all(&config).unwrap();
        let custom = home.join("custom-skills").display().to_string();
        std::fs::write(
            config.join("skills.json"),
            serde_json::json!({
                "entries": [
                    "~/.agents/skills",
                    { "path": custom },
                    { "path": "relative/ignored" },
                    "",
                ]
            })
            .to_string(),
        )
        .unwrap();

        let dirs = agent_read_skill_dirs(&home, "antigravity");
        let paths = dirs
            .dirs
            .iter()
            .map(|dir| (dir.path.clone(), dir.shared))
            .collect::<Vec<_>>();
        assert_eq!(
            paths,
            vec![
                (home.join(".gemini/config/skills"), false),
                (home.join(".agents/skills"), true),
                (home.join("custom-skills"), false),
            ]
        );

        std::fs::remove_dir_all(home).unwrap();
    }

    #[test]
    fn skill_manifest_alone_is_not_an_installed_capability() {
        let root = std::env::temp_dir().join(format!(
            "agentbro-agent-meta-skills-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join(".skills-manifest.json"), "{}").unwrap();

        assert!(!directory_has_valid_skill(&root, false));

        let skill = root.join("release-checklist");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(skill.join("SKILL.md"), "# Release checklist").unwrap();
        assert!(directory_has_valid_skill(&root, false));

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn zcode_is_visible_and_uses_official_skills_dir() {
        assert!(visible_agent_ids().iter().any(|id| id == "zcode"));
        assert_eq!(display_name("zcode"), "ZCode");
        assert_eq!(icon_key("zcode"), "zcode");

        let home = Path::new("/Users/tester");
        assert_eq!(
            agent_skills_dir(home, "zcode"),
            Some(home.join(".zcode/skills"))
        );
    }

    #[test]
    fn antigravity_is_visible_and_uses_official_skills_dir() {
        assert!(visible_agent_ids().iter().any(|id| id == "antigravity"));
        assert_eq!(display_name("antigravity"), "Antigravity");
        assert_eq!(icon_key("antigravity"), "antigravity");

        let home = Path::new("/Users/tester");
        assert_eq!(
            agent_skills_dir(home, "antigravity"),
            Some(home.join(".gemini/config/skills"))
        );
    }

    #[test]
    fn doubao_is_visible_and_separates_user_and_builtin_skills() {
        assert!(visible_agent_ids().iter().any(|id| id == "doubao"));
        assert_eq!(display_name("doubao"), "Doubao");
        assert_eq!(icon_key("doubao"), "doubao");

        let home = Path::new("/Users/tester");
        assert_eq!(
            agent_skills_dir(home, "doubao"),
            Some(home.join("Doubao/skills"))
        );
        assert_eq!(
            agent_owned_skill_dirs(home, "doubao"),
            vec![home.join("Doubao/skills")]
        );
        let builtin = home.join(
            "Library/Application Support/Doubao/Default/.doubao/agent_mode/workspace/.skills",
        );
        assert_eq!(
            agent_skill_dirs(home, "doubao"),
            vec![home.join("Doubao/skills"), builtin.clone()]
        );
        assert!(is_read_only_agent_skill_path(
            home,
            "doubao",
            &builtin.join("browser-task")
        ));
        assert!(!is_read_only_agent_skill_path(
            home,
            "doubao",
            &home.join("Doubao/skills/custom")
        ));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_same_path_is_case_insensitive() {
        assert!(same_path(
            Path::new(r"C:\Users\AgentBro"),
            Path::new(r"c:\users\agentbro")
        ));
    }

    #[test]
    fn agents_without_program_metadata_fall_back_to_their_config_state() {
        assert!(agent_program_detected("definitely-not-an-agent", true));
        assert!(!agent_program_detected("definitely-not-an-agent", false));
    }
}
