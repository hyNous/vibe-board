//! Access to `~/.agents/.skill-lock.json`, the source record written by the
//! mainstream `npx skills` tool.
//!
//! Vibe Board reads this file to enrich Skills that the tool installed with
//! their real GitHub origin, and writes back only the two fields that must stay
//! consistent after Vibe Board updated a Skill in place: `skillFolderHash`
//! (the GitHub tree SHA of the installed version) and `updatedAt`. Everything
//! else in the file is left byte-for-byte untouched and the original file is
//! backed up first. A missing, unreadable, or malformed file yields an empty
//! index instead of an error.

use serde::Deserialize;
use std::collections::HashMap;
use std::ops::Range;
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
    #[serde(default, rename = "ref")]
    pub source_ref: Option<String>,
    #[serde(default)]
    pub skill_path: Option<String>,
    #[serde(default)]
    pub skill_folder_hash: Option<String>,
    #[serde(default)]
    pub installed_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

/// Outcome of a Vibe Board write to one lock entry.
#[derive(Debug, Clone)]
pub struct SkillLockUpdate {
    pub backup_path: PathBuf,
    pub folder_hash: String,
    pub updated_at: String,
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

/// Owner/repo recorded for a GitHub-backed entry.
pub fn github_repo(entry: &SkillLockEntry) -> Option<(String, String)> {
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
    Some((owner.to_string(), repo.to_string()))
}

/// The Skill folder inside the repository: `skillPath` with a trailing
/// `SKILL.md` removed. Empty means the repository root is the Skill.
pub fn skill_dir(entry: &SkillLockEntry) -> String {
    entry
        .skill_path
        .as_deref()
        .map(skill_dir_from_path)
        .unwrap_or_default()
}

/// A `github:owner/repo[/subdir]` spec the installer can resolve, built from the
/// recorded repository URL and the in-repository `skillPath`.
pub fn github_source_spec(entry: &SkillLockEntry) -> Option<String> {
    let (owner, repo) = github_repo(entry)?;
    let mut spec = format!("github:{owner}/{repo}");
    let subdir = skill_dir(entry);
    if !subdir.is_empty() {
        spec.push('/');
        spec.push_str(&subdir);
    }
    Some(spec)
}

pub fn skill_dir_from_path(skill_path: &str) -> String {
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

// ── Single-entry write-back ───────────────────────────────────────

/// Update `skillFolderHash` and `updatedAt` for one installed Skill, leaving
/// every other byte of the lock file untouched. The original file is copied to
/// `<lock>.vibeboard-bak` before the write. Only call this after a successful
/// in-place update, so the recorded hash matches the files on disk.
pub fn update_installed_skill(
    home: &Path,
    skill_id: &str,
    folder_hash: &str,
    updated_at: &str,
) -> Result<SkillLockUpdate, String> {
    let path = lock_path(home);
    let content = std::fs::read_to_string(&path)
        .map_err(|error| format!("read source record {}: {error}", path.display()))?;
    let root: serde_json::Value = serde_json::from_str(&content)
        .map_err(|error| format!("parse source record {}: {error}", path.display()))?;
    let skills = root
        .get("skills")
        .and_then(|value| value.as_object())
        .ok_or_else(|| "source record has no skills section".to_string())?;
    let key = skills
        .keys()
        .find(|name| name.eq_ignore_ascii_case(skill_id))
        .cloned()
        .ok_or_else(|| format!("Skill '{skill_id}' has no source record"))?;
    if !skills.get(&key).is_some_and(|value| value.is_object()) {
        return Err(format!("source record entry '{key}' is not an object"));
    }

    let root_span = json_value_span(&content, 0)?;
    let skills_span = object_member_span(&content, &root_span, "skills")?
        .ok_or_else(|| "source record has no skills section".to_string())?;
    let entry_span = object_member_span(&content, &skills_span, &key)?
        .ok_or_else(|| format!("Skill '{skill_id}' has no source record"))?;

    let hash_literal = serde_json::to_string(folder_hash).map_err(|error| error.to_string())?;
    let updated_literal = serde_json::to_string(updated_at).map_err(|error| error.to_string())?;
    let edits = [
        string_field_edit(&content, &entry_span, "skillFolderHash", &hash_literal)?,
        string_field_edit(&content, &entry_span, "updatedAt", &updated_literal)?,
    ];

    let mut next = content.clone();
    let mut replacements: Vec<(Range<usize>, String)> = edits.into_iter().flatten().collect();
    replacements.sort_by_key(|(span, _)| std::cmp::Reverse(span.start));
    for (span, literal) in replacements {
        next.replace_range(span, &literal);
    }

    let backup_path = path.with_file_name(format!(
        "{}.vibeboard-bak",
        path.file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| ".skill-lock.json".to_string())
    ));
    std::fs::copy(&path, &backup_path)
        .map_err(|error| format!("back up source record {}: {error}", path.display()))?;
    std::fs::write(&path, next)
        .map_err(|error| format!("write source record {}: {error}", path.display()))?;

    Ok(SkillLockUpdate {
        backup_path,
        folder_hash: folder_hash.to_string(),
        updated_at: updated_at.to_string(),
    })
}

/// Byte range of the value for `field`, or an insertion point right after the
/// object's opening brace when the field does not exist yet. `None` when the
/// value already equals the literal.
fn string_field_edit(
    text: &str,
    object_span: &Range<usize>,
    field: &str,
    literal: &str,
) -> Result<Option<(Range<usize>, String)>, String> {
    let members = object_members(text, object_span)?;
    for (key, value_span) in &members {
        if key == field {
            let current = &text[value_span.clone()];
            if current == literal {
                return Ok(None);
            }
            return Ok(Some((value_span.clone(), literal.to_string())));
        }
    }
    let separator = if members.is_empty() { "" } else { "," };
    let insertion = format!("\"{field}\":{literal}{separator}");
    Ok(Some((
        object_span.start + 1..object_span.start + 1,
        insertion,
    )))
}

fn object_member_span(
    text: &str,
    object_span: &Range<usize>,
    field: &str,
) -> Result<Option<Range<usize>>, String> {
    for (key, value_span) in object_members(text, object_span)? {
        if key == field {
            return Ok(Some(value_span));
        }
    }
    Ok(None)
}

/// Members of a JSON object: key plus the byte range of its value.
fn object_members(
    text: &str,
    object_span: &Range<usize>,
) -> Result<Vec<(String, Range<usize>)>, String> {
    let bytes = text.as_bytes();
    if object_span.end > bytes.len() || bytes.get(object_span.start) != Some(&b'{') {
        return Err("source record object is malformed".to_string());
    }
    let mut members = Vec::new();
    let mut pos = object_span.start + 1;
    loop {
        pos = skip_ws(bytes, pos, object_span.end);
        if pos >= object_span.end {
            return Err("source record object is truncated".to_string());
        }
        if bytes[pos] == b'}' {
            return Ok(members);
        }
        if bytes[pos] != b'"' {
            return Err("source record key is not a string".to_string());
        }
        let key_end = string_end(bytes, pos)?;
        let key: String = serde_json::from_str(&text[pos..key_end])
            .map_err(|error| format!("source record key is malformed: {error}"))?;
        pos = skip_ws(bytes, key_end, object_span.end);
        if bytes.get(pos) != Some(&b':') {
            return Err("source record key has no value".to_string());
        }
        let value_span = json_value_span(text, pos + 1)?;
        if value_span.end > object_span.end {
            return Err("source record value is truncated".to_string());
        }
        members.push((key, value_span.clone()));
        pos = skip_ws(bytes, value_span.end, object_span.end);
        match bytes.get(pos) {
            Some(b',') => pos += 1,
            Some(b'}') => return Ok(members),
            _ => return Err("source record object is malformed".to_string()),
        }
    }
}

fn json_value_span(text: &str, start: usize) -> Result<Range<usize>, String> {
    let bytes = text.as_bytes();
    let start = skip_ws(bytes, start, bytes.len());
    let Some(&first) = bytes.get(start) else {
        return Err("source record value is missing".to_string());
    };
    match first {
        b'"' => {
            let end = string_end(bytes, start)?;
            Ok(start..end)
        }
        b'{' | b'[' => {
            let close = if first == b'{' { b'}' } else { b']' };
            let mut depth = 0usize;
            let mut pos = start;
            while pos < bytes.len() {
                match bytes[pos] {
                    b'"' => {
                        pos = string_end(bytes, pos)?;
                        continue;
                    }
                    byte if byte == first => depth += 1,
                    byte if byte == close => {
                        depth -= 1;
                        if depth == 0 {
                            return Ok(start..pos + 1);
                        }
                    }
                    _ => {}
                }
                pos += 1;
            }
            Err("source record value is truncated".to_string())
        }
        _ => {
            let mut pos = start;
            while pos < bytes.len()
                && !matches!(
                    bytes[pos],
                    b',' | b'}' | b']' | b' ' | b'\t' | b'\r' | b'\n'
                )
            {
                pos += 1;
            }
            Ok(start..pos)
        }
    }
}

fn string_end(bytes: &[u8], start: usize) -> Result<usize, String> {
    let mut pos = start + 1;
    while pos < bytes.len() {
        match bytes[pos] {
            b'\\' => pos += 2,
            b'"' => return Ok(pos + 1),
            _ => pos += 1,
        }
    }
    Err("source record string is truncated".to_string())
}

fn skip_ws(bytes: &[u8], mut pos: usize, end: usize) -> usize {
    while pos < end && matches!(bytes[pos], b' ' | b'\t' | b'\r' | b'\n') {
        pos += 1;
    }
    pos
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

    #[test]
    fn installed_skill_update_touches_one_entry_only_and_backs_up() {
        let home = temp_home("write");
        let original = r#"{
  "version": 3,
  "skills": {
    "alpha": {
      "source": "owner/repo",
      "sourceType": "github",
      "sourceUrl": "https://github.com/owner/repo.git",
      "skillPath": "skills/alpha/SKILL.md",
      "skillFolderHash": "1111111111111111111111111111111111111111",
      "installedAt": "2026-01-01T00:00:00Z",
      "updatedAt": "2026-01-01T00:00:00Z"
    },
    "beta": {
      "sourceType": "local",
      "sourceUrl": "",
      "skillPath": "D:/skills/beta/SKILL.md",
      "updatedAt": "2026-01-02T00:00:00Z"
    }
  },
  "dismissed": {"findSkillsPrompt": true}
}"#;
        fs::write(lock_path(&home), original).unwrap();

        let result = update_installed_skill(
            &home,
            "alpha",
            "2222222222222222222222222222222222222222",
            "2026-10-07T12:00:00Z",
        )
        .unwrap();
        assert!(result.backup_path.is_file());
        assert_eq!(fs::read_to_string(&result.backup_path).unwrap(), original);

        let updated = fs::read_to_string(lock_path(&home)).unwrap();
        assert!(updated.contains("2222222222222222222222222222222222222222"));
        assert!(updated.contains("2026-10-07T12:00:00Z"));
        // Only the two values of the target entry changed.
        let expected = original
            .replace(
                "1111111111111111111111111111111111111111",
                "2222222222222222222222222222222222222222",
            )
            .replace(
                "\"updatedAt\": \"2026-01-01T00:00:00Z\"",
                "\"updatedAt\": \"2026-10-07T12:00:00Z\"",
            );
        assert_eq!(updated, expected);
        // The file still parses and the untouched entry keeps its values.
        let index = load(&home);
        let beta = find(&index, "beta").unwrap();
        assert_eq!(beta.updated_at.as_deref(), Some("2026-01-02T00:00:00Z"));
        assert_eq!(beta.skill_path.as_deref(), Some("D:/skills/beta/SKILL.md"));
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn installed_skill_update_inserts_missing_fields() {
        let home = temp_home("insert");
        let original = r#"{"version":3,"skills":{"alpha":{"sourceType":"github","sourceUrl":"https://github.com/owner/repo.git"}}}"#;
        fs::write(lock_path(&home), original).unwrap();

        update_installed_skill(&home, "alpha", "aaaa", "2026-10-07T12:00:00Z").unwrap();
        let index = load(&home);
        let entry = find(&index, "alpha").unwrap();
        assert_eq!(entry.skill_folder_hash.as_deref(), Some("aaaa"));
        assert_eq!(entry.updated_at.as_deref(), Some("2026-10-07T12:00:00Z"));
        assert_eq!(
            github_source_spec(entry).as_deref(),
            Some("github:owner/repo")
        );
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn installed_skill_update_ignores_skill_id_case() {
        let home = temp_home("write-case");
        fs::write(
            lock_path(&home),
            r#"{"skills":{"Find-Skills":{"sourceType":"github","sourceUrl":"https://github.com/vercel-labs/skills.git","skillFolderHash":"old","updatedAt":"old"}}}"#,
        )
        .unwrap();
        update_installed_skill(&home, "find-skills", "new", "now").unwrap();
        let index = load(&home);
        let entry = find(&index, "find-skills").unwrap();
        assert_eq!(entry.skill_folder_hash.as_deref(), Some("new"));
        assert_eq!(entry.updated_at.as_deref(), Some("now"));
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn installed_skill_update_errors_without_entry_or_file() {
        let home = temp_home("write-missing");
        assert!(update_installed_skill(&home, "alpha", "hash", "now").is_err());
        fs::write(lock_path(&home), r#"{"skills":{"beta":{}}}"#).unwrap();
        assert!(update_installed_skill(&home, "alpha", "hash", "now").is_err());
        // Malformed JSON is refused without touching the file.
        fs::write(lock_path(&home), "{ not json").unwrap();
        assert!(update_installed_skill(&home, "beta", "hash", "now").is_err());
        assert_eq!(fs::read_to_string(lock_path(&home)).unwrap(), "{ not json");
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn github_entry_exposes_repo_ref_and_skill_dir() {
        let entry = SkillLockEntry {
            source_type: Some("github".to_string()),
            source_url: Some("https://github.com/Owner/Repo.git".to_string()),
            source_ref: Some("v1.2.3".to_string()),
            skill_path: Some("skills/alpha/SKILL.md".to_string()),
            ..SkillLockEntry::default()
        };
        assert_eq!(
            github_repo(&entry),
            Some(("Owner".to_string(), "Repo".to_string()))
        );
        assert_eq!(entry.source_ref.as_deref(), Some("v1.2.3"));
        assert_eq!(skill_dir(&entry), "skills/alpha");
        assert_eq!(
            github_source_spec(&entry).as_deref(),
            Some("github:Owner/Repo/skills/alpha")
        );
    }
}
