use super::{agent_paths, zcode_config};
use super::{
    AgentSkillState, DiscoveredSkill, InstallMode, ObsidianVault, ScannedSkill, SkillSource,
    SkillType,
};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

pub fn scan_agent(agent: &str) -> Vec<ScannedSkill> {
    let paths = agent_paths::paths_for_agent(agent);
    let mut results = Vec::new();

    for skill_dir in &paths.skill_dirs {
        if !skill_dir.is_dir() {
            continue;
        }
        scan_directory(skill_dir, agent, &mut results);
    }

    results
}

pub fn scan_all() -> std::collections::HashMap<String, Vec<ScannedSkill>> {
    let mut map = std::collections::HashMap::new();
    for agent in agent_paths::known_agent_ids() {
        let skills = scan_agent(agent);
        if !skills.is_empty() {
            map.insert((*agent).to_string(), skills);
        }
    }
    for agent in super::registry::list_custom_agents() {
        if !agent.is_enabled {
            continue;
        }
        let skills = scan_agent(&agent.id);
        if !skills.is_empty() {
            map.insert(agent.id, skills);
        }
    }
    map
}

pub fn discover_project_skills(roots: &[String]) -> Vec<DiscoveredSkill> {
    let mut results = Vec::new();
    let mut seen = HashSet::new();
    for root in roots {
        let path = expand_user_path(root);
        if path.is_dir() {
            discover_in_dir(&path, &path, 0, &mut seen, &mut results);
        }
        if results.len() >= 400 {
            break;
        }
    }
    results
}

pub fn discover_project_skills_from_scan_roots() -> Vec<DiscoveredSkill> {
    let roots = super::registry::list_scan_roots()
        .into_iter()
        .filter(|root| root.enabled)
        .map(|root| root.path)
        .collect::<Vec<_>>();
    discover_project_skills(&roots)
}

pub fn get_obsidian_vaults() -> Vec<ObsidianVault> {
    let mut vaults = Vec::new();
    let mut seen = HashSet::new();
    let roots = super::registry::list_scan_roots()
        .into_iter()
        .filter(|root| root.enabled)
        .map(|root| expand_user_path(&root.path))
        .collect::<Vec<_>>();

    for root in roots {
        if root.is_dir() {
            discover_obsidian_vaults_in_dir(&root, 0, &mut seen, &mut vaults);
        }
        if vaults.len() >= 100 {
            break;
        }
    }
    vaults.sort_by_key(|a| a.name.to_lowercase());
    vaults
}

pub fn get_obsidian_vault_skills(vault_path: &str) -> Vec<DiscoveredSkill> {
    let path = expand_user_path(vault_path);
    if !path.is_dir() || !path.join(".obsidian").is_dir() {
        return Vec::new();
    }
    let mut results = Vec::new();
    let mut seen = HashSet::new();
    discover_in_dir(&path, &path, 0, &mut seen, &mut results);
    results
}

fn discover_obsidian_vaults_in_dir(
    dir: &Path,
    depth: usize,
    seen: &mut HashSet<String>,
    vaults: &mut Vec<ObsidianVault>,
) {
    if depth > 6 || vaults.len() >= 100 {
        return;
    }
    if dir.join(".obsidian").is_dir() {
        let key = dir.display().to_string();
        if seen.insert(key.clone()) {
            let skills = get_obsidian_vault_skills(&key);
            vaults.push(ObsidianVault {
                id: stable_id(&key),
                name: dir
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string(),
                path: key,
                skill_count: skills.len(),
            });
        }
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if matches!(
            name.as_str(),
            "node_modules" | ".git" | "target" | "dist" | "build" | ".next" | ".turbo"
        ) {
            continue;
        }
        discover_obsidian_vaults_in_dir(&path, depth + 1, seen, vaults);
    }
}

fn stable_id(value: &str) -> String {
    value
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

fn discover_in_dir(
    root: &Path,
    dir: &Path,
    depth: usize,
    seen: &mut HashSet<String>,
    results: &mut Vec<DiscoveredSkill>,
) {
    if depth > 8 || results.len() >= 400 {
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if !path.is_dir() {
            continue;
        }
        if matches!(
            name.as_str(),
            "node_modules" | ".git" | "target" | "dist" | "build" | ".next" | ".turbo"
        ) {
            continue;
        }

        let skill_file = path.join("SKILL.md");
        if skill_file.exists() && is_project_skill_dir(&path) {
            let key = path.display().to_string();
            if seen.insert(key) {
                results.push(discovered_skill(root, &path, &skill_file));
            }
        }
        discover_in_dir(root, &path, depth + 1, seen, results);
        if results.len() >= 400 {
            break;
        }
    }
}

fn is_project_skill_dir(path: &Path) -> bool {
    let text = path.display().to_string();
    text.contains("/.skills/")
        || text.ends_with("/.skills")
        || text.contains("/.agents/skills/")
        || text.ends_with("/.agents/skills")
        || text.contains("/.claude/skills/")
        || text.ends_with("/.claude/skills")
}

fn discovered_skill(root: &Path, dir_path: &Path, skill_file: &Path) -> DiscoveredSkill {
    let fm = parse_frontmatter(skill_file);
    let name = fm.get("name").cloned().unwrap_or_else(|| {
        dir_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string()
    });
    let project_path = project_path_for(root, dir_path);
    let project_name = project_path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    DiscoveredSkill {
        id: format!("{}:{}", project_path.display(), name),
        name,
        description: fm.get("description").cloned().unwrap_or_default(),
        file_path: skill_file.display().to_string(),
        dir_path: dir_path.display().to_string(),
        project_path: project_path.display().to_string(),
        project_name,
        source_kind: discover_source_kind(dir_path),
    }
}

fn project_path_for(root: &Path, dir_path: &Path) -> PathBuf {
    let components = dir_path.components().collect::<Vec<_>>();
    for (index, component) in components.iter().enumerate() {
        let value = component.as_os_str().to_string_lossy();
        if matches!(value.as_ref(), ".skills" | ".agents" | ".claude") {
            let mut project = PathBuf::new();
            for part in &components[..index] {
                project.push(part.as_os_str());
            }
            return project;
        }
    }
    root.to_path_buf()
}

fn discover_source_kind(dir_path: &Path) -> String {
    let text = dir_path.display().to_string();
    let prefix = if is_obsidian_vault_skill(dir_path) {
        "obsidian/"
    } else {
        ""
    };
    if text.contains("/.agents/skills") {
        format!("{prefix}.agents/skills")
    } else if text.contains("/.claude/skills") {
        format!("{prefix}.claude/skills")
    } else {
        format!("{prefix}.skills")
    }
}

fn is_obsidian_vault_skill(dir_path: &Path) -> bool {
    for ancestor in dir_path.ancestors() {
        if ancestor.join(".obsidian").is_dir() {
            return true;
        }
        let text = ancestor.display().to_string();
        if text.ends_with(".obsidian") {
            return true;
        }
    }
    false
}

fn scan_directory(dir: &Path, agent: &str, results: &mut Vec<ScannedSkill>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    let disabled_skills = disabled_skill_ids(agent);

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            let index = find_index_file(&path);
            if let Some(index_path) = index {
                let fm = parse_frontmatter(&index_path);
                let skill_name = fm.get("name").cloned().unwrap_or_else(|| {
                    path.file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_string()
                });
                let desc = fm.get("description").cloned().unwrap_or_default();
                let meta = fs::metadata(&path).ok();
                let is_symlink = entry
                    .path()
                    .symlink_metadata()
                    .map(|m| m.file_type().is_symlink())
                    .unwrap_or(false);
                let link_target = if is_symlink {
                    symlink_target(&path)
                } else {
                    None
                };

                results.push(ScannedSkill {
                    id: skill_name.clone(),
                    name: skill_name.clone(),
                    description: desc,
                    skill_type: SkillType::Skill,
                    icon: None,
                    source: SkillSource::Local,
                    origin_url: None,
                    has_update: false,
                    file_path: path.display().to_string(),
                    file_size: dir_size(&path),
                    modified_at: meta
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs())
                        .unwrap_or(0),
                    agents: vec![AgentSkillState {
                        agent: agent.to_string(),
                        install_path: path.display().to_string(),
                        link_target,
                        install_mode: if is_symlink {
                            InstallMode::Symlink
                        } else {
                            InstallMode::Direct
                        },
                        enabled: skill_enabled(agent, &path, &skill_name, &disabled_skills),
                    }],
                    frontmatter: fm,
                });
            }
        } else if path.extension().map(|e| e == "md").unwrap_or(false) {
            let fm = parse_frontmatter(&path);
            let skill_name = fm.get("name").cloned().unwrap_or_else(|| {
                path.file_stem()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string()
            });
            let desc = fm.get("description").cloned().unwrap_or_default();
            let meta = fs::metadata(&path).ok();

            results.push(ScannedSkill {
                id: skill_name.clone(),
                name: skill_name.clone(),
                description: desc,
                skill_type: SkillType::Skill,
                icon: None,
                source: SkillSource::Local,
                origin_url: None,
                has_update: false,
                file_path: path.display().to_string(),
                file_size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
                modified_at: meta
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0),
                agents: vec![AgentSkillState {
                    agent: agent.to_string(),
                    install_path: path.display().to_string(),
                    link_target: None,
                    install_mode: InstallMode::Direct,
                    enabled: skill_enabled(agent, &path, &skill_name, &disabled_skills),
                }],
                frontmatter: fm,
            });
        }
    }
}

fn disabled_skill_ids(agent: &str) -> HashSet<String> {
    let Some(settings_path) = agent_paths::paths_for_agent(agent).settings_file else {
        return HashSet::new();
    };
    let Ok(content) = fs::read_to_string(&settings_path) else {
        return HashSet::new();
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&content) else {
        return HashSet::new();
    };
    if agent == "zcode" {
        return zcode_config::disabled_skill_paths(&json);
    }
    json.get("disabledSkills")
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(ToString::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn skill_enabled(agent: &str, path: &Path, skill_name: &str, disabled: &HashSet<String>) -> bool {
    if agent == "zcode" {
        !disabled.contains(path.to_string_lossy().as_ref())
    } else {
        !disabled.contains(skill_name)
    }
}

fn symlink_target(path: &Path) -> Option<String> {
    let target = fs::read_link(path).ok()?;
    let absolute = if target.is_absolute() {
        target
    } else {
        path.parent()
            .map(|parent| parent.join(&target))
            .unwrap_or(target)
    };
    Some(absolute.display().to_string())
}

fn find_index_file(dir: &Path) -> Option<PathBuf> {
    for name in &["SKILL.md", "index.md", "README.md", "main.md"] {
        let p = dir.join(name);
        if p.exists() {
            return Some(p);
        }
    }
    fs::read_dir(dir)
        .ok()?
        .flatten()
        .find(|e| e.path().extension().map(|x| x == "md").unwrap_or(false))
        .map(|e| e.path())
}

fn parse_frontmatter(path: &Path) -> std::collections::HashMap<String, String> {
    let content = match fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return std::collections::HashMap::new(),
    };

    if !content.starts_with("---") {
        return std::collections::HashMap::new();
    }

    let parts: Vec<&str> = content.split("---").collect();
    if parts.len() < 3 {
        return std::collections::HashMap::new();
    }

    let fm_text = parts[1];
    parse_frontmatter_text(fm_text)
}

fn parse_frontmatter_text(fm_text: &str) -> std::collections::HashMap<String, String> {
    crate::skills::frontmatter::parse_section(fm_text)
        .into_iter()
        .collect()
}

fn expand_user_path(path: &str) -> PathBuf {
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
    PathBuf::from(path)
}

fn dir_size(path: &Path) -> u64 {
    fs::read_dir(path)
        .ok()
        .map(|entries| {
            entries
                .flatten()
                .map(|e| {
                    let p = e.path();
                    if p.is_file() {
                        fs::metadata(&p).map(|m| m.len()).unwrap_or(0)
                    } else if p.is_dir() {
                        dir_size(&p)
                    } else {
                        0
                    }
                })
                .sum()
        })
        .unwrap_or(0)
}

pub fn read_file_tree(skill_path: &str) -> super::FileTreeNode {
    let path = PathBuf::from(skill_path);
    build_tree(&path)
}

fn build_tree(path: &Path) -> super::FileTreeNode {
    let name = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    if path.is_file() {
        return super::FileTreeNode {
            name,
            node_type: "file".to_string(),
            path: path.display().to_string(),
            children: None,
        };
    }

    let children: Vec<super::FileTreeNode> = fs::read_dir(path)
        .ok()
        .map(|entries| {
            let mut nodes: Vec<_> = entries
                .flatten()
                .filter(|e| !e.file_name().to_string_lossy().starts_with('.'))
                .map(|e| build_tree(&e.path()))
                .collect();
            nodes.sort_by(|a, b| {
                let a_dir = a.node_type == "dir";
                let b_dir = b.node_type == "dir";
                b_dir.cmp(&a_dir).then(a.name.cmp(&b.name))
            });
            nodes
        })
        .unwrap_or_default();

    super::FileTreeNode {
        name,
        node_type: "dir".to_string(),
        path: path.display().to_string(),
        children: Some(children),
    }
}
