use super::agent_paths;
use super::{DiscoveredSkill, ScanRoot, SkillCollection, SkillPack, SyncConfig};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SkillSourceEntry {
    pub origin: String,
    pub installed_via: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Metadata {
    #[serde(default)]
    pub sources: HashMap<String, SkillSourceEntry>,
    #[serde(default)]
    pub packs: Vec<SkillPack>,
    #[serde(default)]
    pub collections: Vec<SkillCollection>,
    #[serde(default)]
    pub scan_roots: Vec<ScanRoot>,
    #[serde(default)]
    pub discovered_skills: Vec<DiscoveredSkill>,
    #[serde(default)]
    pub discovered_scanned_at: Option<String>,
    #[serde(default)]
    pub sync: Option<SyncConfig>,
    #[serde(default)]
    pub custom_agents: Vec<CustomAgentEntry>,
    #[serde(default)]
    pub explanations: HashMap<String, SkillExplanationEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SkillExplanationEntry {
    pub skill_id: String,
    pub lang: String,
    pub model: String,
    pub text: String,
    pub cached_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomAgentEntry {
    pub id: String,
    pub display_name: String,
    pub category: String,
    pub global_skills_dir: String,
    pub icon_name: Option<String>,
    pub is_enabled: bool,
    #[serde(default)]
    pub config_dir: Option<String>,
    #[serde(default)]
    pub settings_file: Option<String>,
    #[serde(default)]
    pub mcp_config: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomAgentConfig {
    pub id: Option<String>,
    pub display_name: String,
    pub category: Option<String>,
    pub global_skills_dir: String,
    #[serde(default)]
    pub icon_name: Option<String>,
    #[serde(default)]
    pub config_dir: Option<String>,
    #[serde(default)]
    pub settings_file: Option<String>,
    #[serde(default)]
    pub mcp_config: Option<String>,
}

pub fn load() -> Metadata {
    agent_paths::read_metadata()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_default()
}

pub fn save(metadata: &Metadata) -> Result<(), String> {
    let path = agent_paths::vibeboard_metadata_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let content = serde_json::to_string_pretty(metadata).map_err(|e| e.to_string())?;
    fs::write(&path, content).map_err(|e| e.to_string())
}

pub fn get_sync_config() -> Option<SyncConfig> {
    load().sync
}

pub fn list_custom_agents() -> Vec<CustomAgentEntry> {
    load().custom_agents
}

pub fn add_custom_agent(config: CustomAgentConfig) -> Result<CustomAgentEntry, String> {
    if config.display_name.trim().is_empty() {
        return Err("Agent display name cannot be empty".to_string());
    }
    if config.global_skills_dir.trim().is_empty() {
        return Err("Agent skills directory cannot be empty".to_string());
    }

    let mut meta = load();
    let id = config
        .id
        .as_deref()
        .map(normalize_agent_id)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| format!("custom-{}", normalize_agent_id(&config.display_name)));

    if id == "custom-" {
        return Err("Agent ID cannot be empty".to_string());
    }
    if agent_paths::known_agent_ids().contains(&id.as_str())
        || meta.custom_agents.iter().any(|agent| agent.id == id)
    {
        return Err(format!("Agent already exists: {id}"));
    }

    let entry = CustomAgentEntry {
        id,
        display_name: config.display_name.trim().to_string(),
        category: config.category.unwrap_or_else(|| "custom".to_string()),
        global_skills_dir: normalize_path(&config.global_skills_dir),
        icon_name: config.icon_name.filter(|value| !value.trim().is_empty()),
        is_enabled: true,
        config_dir: config.config_dir.map(|value| normalize_path(&value)),
        settings_file: config.settings_file.map(|value| normalize_path(&value)),
        mcp_config: config.mcp_config.map(|value| normalize_path(&value)),
    };
    meta.custom_agents.push(entry.clone());
    save(&meta)?;
    Ok(entry)
}

pub fn remove_custom_agent(agent_id: &str) -> Result<(), String> {
    let mut meta = load();
    let before = meta.custom_agents.len();
    meta.custom_agents.retain(|agent| agent.id != agent_id);
    if meta.custom_agents.len() == before {
        return Err(format!("Custom agent not found: {agent_id}"));
    }
    save(&meta)
}

fn normalize_agent_id(value: &str) -> String {
    value
        .trim()
        .to_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

fn normalize_path(path: &str) -> String {
    let trimmed = path.trim();
    if trimmed.starts_with("~/") {
        return expand_home(trimmed).display().to_string();
    }
    #[cfg(target_os = "windows")]
    if trimmed.starts_with("~\\") {
        return expand_home(trimmed).display().to_string();
    }
    trimmed.to_string()
}

fn expand_home(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    #[cfg(target_os = "windows")]
    if let Some(rest) = path.strip_prefix("~\\") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    Path::new(path).to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_path_expands_posix_home_prefix() {
        let Some(home) = dirs::home_dir() else {
            return;
        };

        assert_eq!(
            normalize_path("~/AgentBro/skills"),
            home.join("AgentBro/skills").display().to_string()
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn normalize_path_expands_windows_home_prefix() {
        let Some(home) = dirs::home_dir() else {
            return;
        };

        assert_eq!(
            normalize_path(r"~\AgentBro\skills"),
            home.join(r"AgentBro\skills").display().to_string()
        );
    }
}
