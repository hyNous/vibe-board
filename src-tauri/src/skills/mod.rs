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
pub enum SkillType {
    Skill,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InstallMode {
    Direct,
    Symlink,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SkillSource {
    Island,
    Local,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkillState {
    pub agent: String,
    pub install_path: String,
    pub link_target: Option<String>,
    pub install_mode: InstallMode,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedSkill {
    pub id: String,
    pub name: String,
    pub description: String,
    pub skill_type: SkillType,
    pub icon: Option<String>,
    pub source: SkillSource,
    pub origin_url: Option<String>,
    pub has_update: bool,
    pub file_path: String,
    pub file_size: u64,
    pub modified_at: u64,
    pub agents: Vec<AgentSkillState>,
    pub frontmatter: std::collections::HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CentralSkillBundle {
    pub name: String,
    pub path: String,
    pub skill_count: usize,
    pub linked_agent_count: usize,
    pub skill_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CentralDeletePreview {
    pub path: String,
    pub skill_ids: Vec<String>,
    pub linked_install_paths: Vec<String>,
    pub removable_paths: Vec<String>,
    pub warnings: Vec<String>,
}

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
pub struct CollectionExport {
    pub schema_version: u32,
    pub collection: SkillCollection,
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
pub struct ObsidianVault {
    pub id: String,
    pub name: String,
    pub path: String,
    pub skill_count: usize,
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
pub struct TargetConfig {
    pub agent: String,
    pub install_mode: InstallMode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileTreeNode {
    pub name: String,
    pub node_type: String,
    pub path: String,
    pub children: Option<Vec<FileTreeNode>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pub success: bool,
    pub message: String,
    pub conflicts: Vec<SyncConflict>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConflict {
    pub skill_id: String,
    pub local_modified: String,
    pub remote_modified: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPreview {
    pub to_copy: u32,
    pub to_skip: u32,
    pub to_update: u32,
    pub details: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictResolution {
    pub skill_id: String,
    pub action: String,
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn lock_home() -> std::sync::MutexGuard<'static, ()> {
        super::lock_shared_test_home()
    }

    struct TempHome {
        path: PathBuf,
        previous_home: Option<String>,
    }

    impl TempHome {
        fn new(name: &str) -> Self {
            let suffix = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system time before epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!("agentbro-{name}-{suffix}"));
            fs::create_dir_all(&path).expect("create temp home");
            let previous_home = std::env::var("HOME").ok();
            std::env::set_var("HOME", &path);
            Self {
                path,
                previous_home,
            }
        }
    }

    impl Drop for TempHome {
        fn drop(&mut self) {
            if let Some(home) = &self.previous_home {
                std::env::set_var("HOME", home);
            } else {
                std::env::remove_var("HOME");
            }
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn write_skill(root: &Path, dir_name: &str, skill_name: &str) -> PathBuf {
        let dir = root.join(dir_name);
        fs::create_dir_all(&dir).expect("create skill dir");
        fs::write(
            dir.join("SKILL.md"),
            format!(
                "---\nname: {skill_name}\ndescription: Temporary test skill\nversion: 1.2.3\n---\n# {skill_name}\n"
            ),
        )
        .expect("write skill");
        dir
    }

    #[test]
    fn installs_scans_toggles_and_uninstalls_without_real_home() {
        let _guard = lock_home();
        let home = TempHome::new("skills-lifecycle");
        let source = write_skill(&home.path.join("sources"), "fixture-dir", "fixture-skill");
        fs::create_dir_all(home.path.join(".claude")).expect("create claude config dir");
        fs::write(
            home.path.join(".claude/settings.json"),
            r#"{"disabledSkills":[]}"#,
        )
        .expect("write claude settings");

        let targets = vec![TargetConfig {
            agent: "claude-code".to_string(),
            install_mode: InstallMode::Symlink,
        }];
        let installed_ids = installer::install_skill(
            source.to_str().expect("source path"),
            &targets,
            &InstallMode::Symlink,
        )
        .expect("install skill");
        assert!(
            installed_ids.iter().any(|id| id == "fixture-skill"),
            "installer should report frontmatter skill id for registry tracking"
        );

        let installed_path = home.path.join(".claude/skills/fixture-dir");
        assert!(
            installed_path.symlink_metadata().is_ok(),
            "installed path should exist"
        );

        let scanned = scanner::scan_agent("claude-code");
        let skill = scanned
            .iter()
            .find(|skill| skill.id == "fixture-skill")
            .expect("scan installed skill by frontmatter name");
        assert_eq!(
            skill.frontmatter.get("version").map(String::as_str),
            Some("1.2.3")
        );
        assert!(matches!(skill.skill_type, SkillType::Skill));
        assert!(matches!(skill.agents[0].install_mode, InstallMode::Symlink));

        installer::toggle_skill("fixture-skill", "claude-code", false).expect("disable skill");
        let settings =
            fs::read_to_string(home.path.join(".claude/settings.json")).expect("read settings");
        assert!(
            settings.contains("fixture-skill"),
            "disabled skill should be persisted"
        );

        installer::uninstall_skill(installed_path.to_str().expect("installed path"))
            .expect("uninstall skill");
        assert!(
            installed_path.symlink_metadata().is_err(),
            "installed symlink should be removed"
        );
    }

    #[test]
    fn scans_central_skills_dirs() {
        let _guard = lock_home();
        let home = TempHome::new("central-scan");
        write_skill(
            &home.path.join(".agents/skills"),
            "central-dir",
            "central-fixture",
        );
        write_skill(
            &home.path.join(".agentbro/skills"),
            "legacy-dir",
            "legacy-fixture",
        );

        let scanned = scanner::scan_agent("central");
        let skill = scanned
            .iter()
            .find(|skill| skill.id == "central-fixture")
            .expect("central skill should be scanned");

        assert!(matches!(skill.skill_type, SkillType::Skill));
        assert_eq!(skill.agents[0].agent, "central");
        assert!(
            skill.file_path.contains(".agents/skills/central-dir"),
            "central scan should point at canonical ~/.agents skill path"
        );
        assert!(
            scanned.iter().any(|skill| skill.id == "legacy-fixture"
                && skill.file_path.contains(".agentbro/skills/legacy-dir")),
            "central scan should retain compatibility with legacy AgentBro skill path"
        );
    }

    #[test]
    fn persists_collections_scan_roots_and_discovers_obsidian_skills() {
        let _guard = lock_home();
        let home = TempHome::new("collections-discover");
        let project_skill = write_skill(
            &home.path.join("workspace/demo/.agents/skills"),
            "reviewer",
            "reviewer",
        );
        let vault_skill = write_skill(
            &home.path.join("vaults/Notes/.skills"),
            "article",
            "article-writer",
        );
        fs::create_dir_all(home.path.join("vaults/Notes/.obsidian")).expect("create vault marker");

        registry::set_scan_roots(vec![
            ScanRoot {
                path: home.path.join("workspace").display().to_string(),
                enabled: true,
                label: "workspace".to_string(),
            },
            ScanRoot {
                path: home.path.join("vaults").display().to_string(),
                enabled: true,
                label: "vaults".to_string(),
            },
        ])
        .expect("save scan roots");

        let discovered = scanner::discover_project_skills_from_scan_roots();
        registry::cache_discovered_skills(discovered.clone()).expect("cache discovered skills");
        assert!(
            discovered
                .iter()
                .any(|skill| skill.dir_path == project_skill.display().to_string()),
            "enabled scan roots should discover project skills"
        );
        assert!(
            registry::list_discovered_skills()
                .iter()
                .any(|skill| skill.dir_path == project_skill.display().to_string()),
            "discovered skills should be cached for later navigation"
        );

        let vaults = scanner::get_obsidian_vaults();
        let vault = vaults
            .iter()
            .find(|vault| vault.name == "Notes")
            .expect("obsidian vault should be discovered");
        assert_eq!(vault.skill_count, 1);
        let vault_skills = scanner::get_obsidian_vault_skills(&vault.path);
        assert!(
            vault_skills
                .iter()
                .any(|skill| skill.dir_path == vault_skill.display().to_string()),
            "vault skills should be discoverable from the vault view"
        );

        let collection = registry::upsert_collection(SkillCollection {
            id: "collection-one".to_string(),
            name: "Review Workflow".to_string(),
            description: "Code review skills".to_string(),
            skills: vec!["reviewer".to_string(), "reviewer".to_string()],
            created_at: String::new(),
            updated_at: String::new(),
        })
        .expect("create collection");
        assert_eq!(collection.skills, vec!["reviewer"]);

        let exported = registry::export_collection("collection-one").expect("export collection");
        registry::delete_collection("collection-one").expect("delete collection");
        registry::import_collection(&exported).expect("import collection");
        assert!(
            registry::list_collections()
                .iter()
                .any(|item| item.name == "Review Workflow"),
            "imported collection should be listed"
        );
    }

    #[test]
    fn scans_mcp_and_round_trips_backup() {
        let _guard = lock_home();
        let home = TempHome::new("skills-backup");

        let central_skill = write_skill(&agent_paths::agentbro_skills_dir(), "central", "central");
        registry::add_source("central", central_skill.to_str().expect("central path"))
            .expect("record source");
        registry::create_pack(SkillPack {
            id: "pack-one".to_string(),
            name: "Pack One".to_string(),
            description: "Temporary pack".to_string(),
            skills: vec!["central".to_string()],
            target_agents: vec!["codex".to_string()],
        })
        .expect("create pack");

        let backup = home.path.join("backup.zip");
        sync::export_backup(backup.to_str().expect("backup path")).expect("export backup");
        fs::remove_dir_all(home.path.join(".agentbro")).expect("clear metadata");
        fs::remove_dir_all(home.path.join(".agents")).expect("clear central skills");
        sync::import_backup(backup.to_str().expect("backup path")).expect("import backup");

        let meta = registry::load();
        assert!(meta.sources.contains_key("central"));
        assert!(meta.packs.iter().any(|pack| pack.id == "pack-one"));
        assert!(agent_paths::agentbro_skills_dir().join("central").exists());
    }

    #[test]
    fn scans_and_manages_zcode_native_config() {
        let _guard = lock_home();
        let home = TempHome::new("zcode-config");
        let skill = write_skill(
            &home.path.join(".zcode/skills"),
            "fixture-dir",
            "fixture-skill",
        );
        fs::create_dir_all(home.path.join(".zcode/cli")).expect("create ZCode config dir");
        fs::write(
            home.path.join(".zcode/cli/config.json"),
            serde_json::to_string(&serde_json::json!({
                "skill": {
                    skill.display().to_string(): { "enable": false }
                }
            }))
            .unwrap(),
        )
        .expect("write ZCode config");

        let scanned = scanner::scan_agent("zcode");
        assert!(scanned.iter().any(|item| {
            item.id == "fixture-skill"
                && matches!(item.skill_type, SkillType::Skill)
                && !item.agents[0].enabled
        }));

        installer::toggle_skill("fixture-skill", "zcode", true).expect("enable ZCode skill");

        let config: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(home.path.join(".zcode/cli/config.json"))
                .expect("read ZCode config"),
        )
        .unwrap();
        assert_eq!(config["skill"][skill.display().to_string()]["enable"], true);
    }

    #[test]
    fn validates_mcp_and_resolves_pending_sync_conflicts() {
        let _guard = lock_home();
        let home = TempHome::new("sync-conflicts");

        registry::create_pack(SkillPack {
            id: "pack-one".to_string(),
            name: "Local Pack".to_string(),
            description: "local".to_string(),
            skills: vec!["local".to_string()],
            target_agents: vec!["codex".to_string()],
        })
        .expect("create local pack");
        let local_skill = agent_paths::agentbro_skills_dir().join("shared");
        fs::create_dir_all(&local_skill).expect("create local shared skill");
        fs::write(
            local_skill.join("SKILL.md"),
            "---\nname: shared\n---\nlocal",
        )
        .expect("write local shared skill");

        let pending = home.path.join(".agentbro/sync/pending-pull");
        fs::create_dir_all(pending.join("skills/shared")).expect("create pending shared skill");
        let remote_meta = registry::Metadata {
            packs: vec![SkillPack {
                id: "pack-one".to_string(),
                name: "Remote Pack".to_string(),
                description: "remote".to_string(),
                skills: vec!["remote".to_string()],
                target_agents: vec!["claude-code".to_string()],
            }],
            ..Default::default()
        };
        fs::write(
            pending.join("metadata.json"),
            serde_json::to_string(&remote_meta).expect("serialize remote metadata"),
        )
        .expect("write pending metadata");
        fs::write(
            pending.join("skills/shared/SKILL.md"),
            "---\nname: shared\n---\nremote",
        )
        .expect("write remote shared skill");

        sync::resolve_conflicts(vec![
            ConflictResolution {
                skill_id: "pack:pack-one".to_string(),
                action: "use_remote".to_string(),
            },
            ConflictResolution {
                skill_id: "shared".to_string(),
                action: "keep_both".to_string(),
            },
        ])
        .expect("resolve conflicts");

        let meta = registry::load();
        let pack = meta
            .packs
            .iter()
            .find(|pack| pack.id == "pack-one")
            .expect("pack should exist");
        assert_eq!(pack.description, "remote");
        assert!(agent_paths::agentbro_skills_dir().join("shared").exists());
        assert!(
            fs::read_dir(agent_paths::agentbro_skills_dir())
                .expect("read central skills")
                .flatten()
                .any(|entry| entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("shared-remote-")),
            "keep_both should copy remote skill under a unique name"
        );
        assert!(
            !pending.exists(),
            "pending conflict payload should be cleaned up after resolution"
        );
    }
}
