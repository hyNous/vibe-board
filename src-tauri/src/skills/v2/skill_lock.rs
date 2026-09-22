//! Read-only access to `~/.agents/.skill-lock.json`, the source record written
//! by the mainstream `npx skills` tool.
//!
//! Vibe Board never writes this file. It only enriches Skills that the tool
//! installed with their real GitHub origin, so the Skill library can show where
//! they came from. A missing, unreadable, or malformed file yields an empty
//! index instead of an error.

use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillLockEntry {
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub source_type: Option<String>,
    #[serde(default)]
    pub source_url: Option<String>,
    #[serde(default)]
    pub skill_path: Option<String>,
    #[serde(default)]
    pub installed_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct SkillLockFile {
    #[serde(default)]
    skills: HashMap<String, SkillLockEntry>,
}

pub type SkillLockIndex = HashMap<String, SkillLockEntry>;

pub fn lock_path(home: &Path) -> PathBuf {
    home.join(".agents").join(".skill-lock.json")
}

pub fn load(home: &Path) -> SkillLockIndex {
    let path = lock_path(home);
    let Ok(content) = std::fs::read_to_string(&path) else {
        return SkillLockIndex::new();
    };
    match serde_json::from_str::<SkillLockFile>(&content) {
        Ok(file) => file.skills,
        Err(error) => {
            log::warn!(
                "ignoring malformed Skill lock file {}: {error}",
                path.display()
            );
            SkillLockIndex::new()
        }
    }
}

pub fn find<'a>(index: &'a SkillLockIndex, skill_id: &str) -> Option<&'a SkillLockEntry> {
    if let Some(entry) = index.get(skill_id) {
        return Some(entry);
    }
    index
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case(skill_id))
        .map(|(_, entry)| entry)
}

/// A `github:owner/repo[/subdir]` spec the installer can resolve, built from the
/// recorded repository URL and the in-repository `skillPath`.
pub fn github_source_spec(entry: &SkillLockEntry) -> Option<String> {
    if !entry
        .source_type
        .as_deref()
        .is_some_and(|value| value.eq_ignore_ascii_case("github"))
    {
        return None;
    }
    let url = entry.source_url.as_deref()?.trim();
    let rest = url
        .strip_prefix("https://github.com/")
        .or_else(|| url.strip_prefix("http://github.com/"))
        .or_else(|| url.strip_prefix("github.com/"))?;
    let mut parts = rest
        .split('/')
        .map(str::trim)
        .filter(|part| !part.is_empty());
    let owner = parts.next()?;
    let repo = parts.next()?.trim_end_matches(".git");
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    let mut spec = format!("github:{owner}/{repo}");
    if let Some(subdir) = entry
        .skill_path
        .as_deref()
        .map(skill_dir_from_path)
        .filter(|path| !path.is_empty())
    {
        spec.push('/');
        spec.push_str(&subdir);
    }
    Some(spec)
}

fn skill_dir_from_path(skill_path: &str) -> String {
    let path = skill_path.trim().replace('\\', "/");
    let mut parts: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
    if parts
        .last()
        .is_some_and(|file| file.eq_ignore_ascii_case("SKILL.md"))
    {
        parts.pop();
    }
    parts.join("/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn temp_home(label: &str) -> PathBuf {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let home = std::env::temp_dir().join(format!("vb-skill-lock-{label}-{suffix}"));
        fs::create_dir_all(home.join(".agents")).unwrap();
        home
    }

    #[test]
    fn github_entry_becomes_a_resolvable_source_spec() {
        let home = temp_home("github");
        fs::write(
            lock_path(&home),
            r#"{
              "version": 3,
              "skills": {
                "create-technical-spike": {
                  "source": "github/awesome-copilot",
                  "sourceType": "github",
                  "sourceUrl": "https://github.com/github/awesome-copilot.git",
                  "skillPath": "skills/create-technical-spike/SKILL.md",
                  "installedAt": "2026-07-13T08:48:00Z"
                },
                "tutor": {
                  "source": "local",
                  "sourceType": "local",
                  "sourceUrl": "",
                  "skillPath": "D:/Second Brain/.agents/skills/tutor/SKILL.md"
                }
              }
            }"#,
        )
        .unwrap();

        let index = load(&home);
        assert_eq!(index.len(), 2);
        let entry = find(&index, "create-technical-spike").unwrap();
        assert_eq!(
            github_source_spec(entry).as_deref(),
            Some("github:github/awesome-copilot/skills/create-technical-spike")
        );
        let local = find(&index, "tutor").unwrap();
        assert_eq!(github_source_spec(local), None);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn missing_or_malformed_file_yields_an_empty_index() {
        let home = temp_home("broken");
        assert!(load(&home).is_empty());

        fs::write(lock_path(&home), "{ this is not json").unwrap();
        assert!(load(&home).is_empty());

        fs::write(
            lock_path(&home),
            r#"{"skills": {"a": {"sourceType": "github", "sourceUrl": ""}}}"#,
        )
        .unwrap();
        let index = load(&home);
        assert_eq!(index.len(), 1);
        assert_eq!(github_source_spec(find(&index, "a").unwrap()), None);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn entry_lookup_ignores_case() {
        let home = temp_home("case");
        fs::write(
            lock_path(&home),
            r#"{"skills": {"Find-Skills": {"sourceType": "github", "sourceUrl": "https://github.com/vercel-labs/skills.git"}}}"#,
        )
        .unwrap();
        let index = load(&home);
        assert!(find(&index, "find-skills").is_some());
        let _ = fs::remove_dir_all(&home);
    }
}
