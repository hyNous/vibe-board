//! Filesystem helpers for Skill Manager v2 — stable directory hashing,
//! SKILL.md frontmatter parsing, recursive copy, symlink creation with
//! fallback, and file-tree building.

#![allow(clippy::needless_question_mark)]

use sha1::Sha1;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path, PathBuf};

/// Ignore these directory/file names when hashing or copying skill contents.
pub fn is_ignored_entry(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | ".DS_Store"
            | "node_modules"
            | "target"
            | "__pycache__"
            | ".idea"
            | ".venv"
            | "venv"
            | "output"
    ) || name.ends_with(".tmp")
        || name.ends_with(".swp")
}

pub fn home() -> PathBuf {
    // Shared resolution: prefers VIBEBOARD_HOME/$HOME so tests that set them get
    // their temp dir even when dirs::home_dir() resolves the real OS profile.
    crate::data_dir::home_dir()
}

pub fn vibeboard_home() -> PathBuf {
    home().join(".vibeboard")
}

pub fn legacy_agent_island_home() -> PathBuf {
    home().join(".agent-island")
}

/// Legacy AgentBro data root retained for one-way migration and compatibility.
pub fn legacy_agentbro_home() -> PathBuf {
    home().join(".agentbro")
}

/// Compatibility alias for older callers. New Vibe Board data belongs under
/// `.vibeboard`.
pub fn agentbro_home() -> PathBuf {
    vibeboard_home()
}

pub fn unified_center_marker_path() -> PathBuf {
    vibeboard_home().join("unified-skill-center")
}

pub fn unified_center_active() -> bool {
    unified_center_marker_path().is_file()
        || legacy_agent_island_home()
            .join("unified-skill-center")
            .is_file()
}

/// Activate the single shared Skill center used by Codex, Claude Code and any
/// compatible Agent. Existing `.agentbro/skills` content is copied once; the
/// legacy directory is never deleted so rollback remains possible.
pub fn activate_unified_center() -> Result<(), String> {
    if unified_center_active() {
        // Move a marker written under the previous data root forward once.
        let legacy_marker = legacy_agent_island_home().join("unified-skill-center");
        if !unified_center_marker_path().exists() && legacy_marker.exists() {
            let _ = crate::data_dir::migrate_file(&legacy_marker, &unified_center_marker_path());
        }
        return Ok(());
    }
    let canonical = home().join(".agents").join("skills");
    let legacy = legacy_agentbro_home().join("skills");
    fs::create_dir_all(&canonical).map_err(|e| format!("create shared Skill center: {e}"))?;
    if legacy.is_dir() {
        let entries =
            fs::read_dir(&legacy).map_err(|e| format!("read legacy Skill center: {e}"))?;
        for entry in entries.flatten() {
            let source = entry.path();
            let target = canonical.join(entry.file_name());
            if target.exists() || target.symlink_metadata().is_ok() || !is_skill_dir(&source) {
                continue;
            }
            copy_dir_recursive(&source, &target)
                .map_err(|e| format!("migrate Skill {}: {e}", source.display()))?;
        }
    }
    let marker = unified_center_marker_path();
    if let Some(parent) = marker.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create Vibe Board data dir: {e}"))?;
    }
    fs::write(marker, b"Vibe Board unified Skill center\n")
        .map_err(|e| format!("write unified Skill center marker: {e}"))
}

/// Primary center library for Skill Manager v2. Runtime builds activate the
/// shared `.agents/skills` root; tests and old callers remain on the legacy
/// path until activation so their migration behavior stays backwards-safe.
pub fn default_center_path() -> PathBuf {
    if unified_center_active() {
        home().join(".agents").join("skills")
    } else {
        legacy_agentbro_home().join("skills")
    }
}

/// Both roots stay discoverable for migration/diagnosis. New writes use the
/// activated shared root.
pub fn all_center_dirs() -> Vec<PathBuf> {
    let primary = default_center_path();
    let legacy = legacy_agentbro_home().join("skills");
    if primary == legacy {
        vec![primary]
    } else {
        vec![primary, legacy]
    }
}

pub fn default_sqlite_path() -> PathBuf {
    vibeboard_home()
        .join("skill-manager")
        .join("skill-manager.db")
}

pub fn default_snapshot_path() -> PathBuf {
    default_center_path().join("vibeboard-skills.snapshot.json")
}

pub fn settings_path() -> PathBuf {
    vibeboard_home().join("skill-manager").join("settings.json")
}

pub fn expand_tilde(p: &str) -> PathBuf {
    if let Some(rest) = p.strip_prefix("~/") {
        home().join(rest)
    } else {
        PathBuf::from(p)
    }
}

pub fn normalized_path(path: &Path) -> PathBuf {
    path.canonicalize()
        .unwrap_or_else(|_| resolve_non_existing_path(path))
}

pub fn is_path_within(base: &Path, target: &Path) -> bool {
    let base_resolved = normalized_path(base);
    let target_resolved = target
        .canonicalize()
        .unwrap_or_else(|_| resolve_non_existing_path(target));
    target_resolved.starts_with(base_resolved)
}

fn resolve_non_existing_path(path: &Path) -> PathBuf {
    for ancestor in path.ancestors() {
        if let Ok(real) = ancestor.canonicalize() {
            let mut out = real;
            if let Ok(rest) = path.strip_prefix(ancestor) {
                out.push(rest);
            }
            return normalize_path(&out);
        }
    }
    normalize_path(path)
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn ensure_destination_not_inside_source(src: &Path, dst: &Path) -> Result<(), String> {
    let Ok(src_resolved) = src.canonicalize() else {
        return Ok(());
    };
    let dst_resolved = dst.canonicalize().ok().or_else(|| {
        let parent = dst.parent()?.canonicalize().ok()?;
        let name = dst.file_name()?;
        Some(parent.join(name))
    });
    if let Some(dst_resolved) = dst_resolved {
        if dst_resolved.starts_with(&src_resolved) {
            return Err(format!(
                "Destination {} is inside source {}; refusing recursive copy",
                dst.display(),
                src.display()
            ));
        }
    }
    Ok(())
}

/// Open a path or URL in the OS-default app. Best-effort.
pub fn open_path(target: &str) -> Result<(), String> {
    let target = target.trim();
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        c.arg(expand_tilde(target));
        c
    };
    #[cfg(target_os = "windows")]
    {
        return open_path_windows(target);
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(expand_tilde(target));
        c
    };
    #[cfg(not(target_os = "windows"))]
    cmd.spawn().map(|_| ()).map_err(|e| format!("open: {}", e))
}

/// Reveal a path in Finder without resolving symlinks to their destination.
pub fn reveal_path(target: &str) -> Result<(), String> {
    let target = expand_tilde(target);
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&target)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("reveal: {}", e))
    }
    #[cfg(target_os = "windows")]
    {
        reveal_path_windows(&target)
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        open_path(&target.display().to_string())
    }
}

#[cfg(target_os = "windows")]
fn open_path_windows(target: &str) -> Result<(), String> {
    if target.is_empty() {
        return Err("open: target path is empty".to_string());
    }

    if is_url(target) {
        return std::process::Command::new("rundll32.exe")
            .args(["url.dll,FileProtocolHandler", target])
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("open: {}", e));
    }

    let path = expand_tilde(target);
    std::process::Command::new("explorer.exe")
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("open: {}", e))
}

#[cfg(target_os = "windows")]
fn reveal_path_windows(target: &Path) -> Result<(), String> {
    let target = normalized_path(target);
    let explorer_arg = if target.is_file() {
        format!("/select,{}", target.display())
    } else {
        target.display().to_string()
    };

    std::process::Command::new("explorer.exe")
        .arg(explorer_arg)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("reveal: {}", e))
}

#[cfg(target_os = "windows")]
fn is_url(target: &str) -> bool {
    target.starts_with("http://")
        || target.starts_with("https://")
        || target.starts_with("mailto:")
        || target.starts_with("vibeboard:")
        || target.starts_with("agentisland:")
        || target.starts_with("agentbro:")
        || target.starts_with("ccswitch:")
}

/// Stable hash over a directory's files: relative paths + contents, sorted,
/// ignoring noise entries. Returns hex digest.
pub fn hash_dir(dir: &Path) -> String {
    hash_dir_with_root(dir, true)
}

pub fn hash_dir_contents(dir: &Path) -> String {
    hash_dir_with_root(dir, false)
}

fn hash_dir_with_root(dir: &Path, include_root: bool) -> String {
    let mut entries: Vec<(PathBuf, PathBuf)> = Vec::new();
    collect_files(dir, dir, &mut entries);
    entries.sort_by(|a, b| a.1.cmp(&b.1));

    let mut hasher = Sha256::new();
    if include_root {
        hasher.update(
            dir.file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default()
                .as_bytes(),
        );
    }
    for (abs, rel) in &entries {
        hasher.update(rel.to_string_lossy().as_bytes());
        hasher.update(b"\0");
        match fs::read(abs) {
            Ok(bytes) => hasher.update(&bytes),
            Err(_) => hasher.update(b"<missing>"),
        }
        hasher.update(b"\0");
    }
    hex_encode(&hasher.finalize())
}

fn collect_files(root: &Path, dir: &Path, out: &mut Vec<(PathBuf, PathBuf)>) {
    let Ok(rd) = fs::read_dir(dir) else {
        return;
    };
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if is_ignored_entry(&name) {
            continue;
        }
        let path = entry.path();
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if ft.is_dir() {
            // Don't follow symlinks into other trees.
            if path.is_symlink() {
                continue;
            }
            collect_files(root, &path, out);
        } else if ft.is_file() {
            if let Ok(rel) = path.strip_prefix(root) {
                out.push((path.clone(), rel.to_path_buf()));
            }
        }
    }
}

pub fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

/// Relative path -> absolute path for every file under `dir`, ignoring noise
/// entries. Used for update previews (added / modified / removed files).
pub fn file_map(dir: &Path) -> BTreeMap<String, PathBuf> {
    let mut out = BTreeMap::new();
    collect_relative_files(dir, dir, &mut out);
    out
}

fn collect_relative_files(root: &Path, dir: &Path, out: &mut BTreeMap<String, PathBuf>) {
    let Ok(rd) = fs::read_dir(dir) else {
        return;
    };
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if is_ignored_entry(&name) {
            continue;
        }
        let path = entry.path();
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if ft.is_dir() {
            if path.is_symlink() {
                continue;
            }
            collect_relative_files(root, &path, out);
        } else if ft.is_file() {
            if let Ok(rel) = path.strip_prefix(root) {
                out.insert(rel.to_string_lossy().replace('\\', "/"), path);
            }
        }
    }
}

/// Git tree object SHA-1 for a directory, matching the `skillFolderHash` that
/// the external `skills` tool records from the GitHub Trees API. Returns an
/// empty string when the directory cannot be fully read; callers treat that as
/// "unknown / changed" rather than "unchanged".
pub fn git_tree_hash(dir: &Path) -> String {
    match git_tree_oid(dir) {
        Some(oid) => hex_encode(&oid[..]),
        None => String::new(),
    }
}

fn git_tree_oid(dir: &Path) -> Option<[u8; 20]> {
    let mut entries: Vec<GitTreeEntry> = Vec::new();
    let rd = fs::read_dir(dir).ok()?;
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if is_ignored_entry(&name) {
            continue;
        }
        let path = entry.path();
        let ft = entry.file_type().ok()?;
        if ft.is_symlink() {
            let target = fs::read_link(&path).ok()?;
            let bytes = target.to_string_lossy().into_owned().into_bytes();
            entries.push(GitTreeEntry {
                mode: "120000",
                name,
                oid: git_object_oid(b"blob", &bytes),
            });
        } else if ft.is_dir() {
            entries.push(GitTreeEntry {
                mode: "40000",
                name,
                oid: git_tree_oid(&path)?,
            });
        } else if ft.is_file() {
            let bytes = fs::read(&path).ok()?;
            let mode = if file_is_executable(&entry) {
                "100755"
            } else {
                "100644"
            };
            entries.push(GitTreeEntry {
                mode,
                name,
                oid: git_object_oid(b"blob", &bytes),
            });
        }
    }
    entries.sort_by_key(git_tree_sort_key);
    let mut body = Vec::new();
    for entry in &entries {
        body.extend_from_slice(entry.mode.as_bytes());
        body.push(b' ');
        body.extend_from_slice(entry.name.as_bytes());
        body.push(0);
        body.extend_from_slice(&entry.oid);
    }
    Some(git_object_oid(b"tree", &body))
}

struct GitTreeEntry {
    mode: &'static str,
    name: String,
    oid: [u8; 20],
}

fn git_tree_sort_key(entry: &GitTreeEntry) -> Vec<u8> {
    let mut key = entry.name.as_bytes().to_vec();
    if entry.mode == "40000" {
        key.push(b'/');
    }
    key
}

fn git_object_oid(kind: &[u8], content: &[u8]) -> [u8; 20] {
    let mut hasher = Sha1::new();
    hasher.update(kind);
    hasher.update(b" ");
    hasher.update(content.len().to_string().as_bytes());
    hasher.update(b"\0");
    hasher.update(content);
    let digest = hasher.finalize();
    let mut oid = [0u8; 20];
    oid.copy_from_slice(&digest);
    oid
}

#[cfg(unix)]
fn file_is_executable(entry: &fs::DirEntry) -> bool {
    use std::os::unix::fs::PermissionsExt;
    entry
        .metadata()
        .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn file_is_executable(_entry: &fs::DirEntry) -> bool {
    false
}

/// Sanitize a directory/file segment into a safe skill id.
pub fn sanitize_id(raw: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for ch in raw.trim().chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            out.push(ch);
            prev_dash = ch == '-';
        } else if (ch == ' ' || ch == '.' || ch == '/' || ch == '\\')
            && !prev_dash
            && !out.is_empty()
        {
            out.push('-');
            prev_dash = true;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "skill".to_string()
    } else {
        trimmed
    }
}

#[derive(Debug, Clone, Default)]
pub struct Frontmatter {
    pub map: std::collections::BTreeMap<String, String>,
}

impl Frontmatter {
    pub fn name(&self) -> Option<&str> {
        self.map.get("name").map(String::as_str)
    }
    pub fn description(&self) -> &str {
        self.map
            .get("description")
            .map(String::as_str)
            .unwrap_or("")
    }
}

/// A directory is a valid skill if it contains a SKILL.md file.
pub fn is_skill_dir(dir: &Path) -> bool {
    dir.join("SKILL.md").is_file()
}

pub fn read_frontmatter(dir: &Path) -> Frontmatter {
    let path = dir.join("SKILL.md");
    let Ok(content) = fs::read_to_string(&path) else {
        return Frontmatter::default();
    };
    Frontmatter {
        map: parse_frontmatter_text(&content),
    }
}

pub fn parse_frontmatter_text(content: &str) -> std::collections::BTreeMap<String, String> {
    crate::skills::frontmatter::parse_content(content)
}

/// Resolve a skill id from a directory: prefer frontmatter `name`, else
/// sanitized directory name.
pub fn infer_skill_id(dir: &Path) -> String {
    let fm = read_frontmatter(dir);
    if let Some(name) = fm.name().filter(|n| !n.trim().is_empty()) {
        return sanitize_id(name);
    }
    sanitize_id(
        dir.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default()
            .as_str(),
    )
}

/// Recursive copy of a directory, skipping ignored entries. Used for `copy`
/// distribution and importing into the center library.
pub fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    if !src.is_dir() {
        return Err(format!("Source is not a directory: {}", src.display()));
    }
    ensure_destination_not_inside_source(src, dst)?;
    fs::create_dir_all(dst).map_err(|e| format!("create dir {}: {}", dst.display(), e))?;
    let rd = fs::read_dir(src).map_err(|e| format!("read dir {}: {}", src.display(), e))?;
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if is_ignored_entry(&name) {
            continue;
        }
        let from = entry.path();
        let to = dst.join(&name);
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if ft.is_dir() {
            if from.is_symlink() {
                continue;
            }
            copy_dir_recursive(&from, &to)?;
        } else if ft.is_file() {
            fs::copy(&from, &to).map_err(|e| format!("copy {}: {}", from.display(), e))?;
        }
    }
    Ok(())
}

/// Attempt a symlink. On unix, relative symlink within the agent dir is not
/// safe across machines, so use an absolute target. Returns Ok(true) if link
/// created, Ok(false) if it could not be created (caller decides fallback).
pub fn try_symlink(target: &Path, link: &Path) -> Result<bool, String> {
    if link.exists() || link.is_symlink() {
        return Ok(false);
    }
    if let Some(parent) = link.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir {}: {}", parent.display(), e))?;
    }
    #[cfg(unix)]
    {
        let abs_target = if target.is_absolute() {
            target.to_path_buf()
        } else {
            std::env::current_dir().unwrap_or_default().join(target)
        };
        match std::os::unix::fs::symlink(&abs_target, link) {
            Ok(_) => Ok(true),
            Err(_) => Ok(false),
        }
    }
    #[cfg(windows)]
    {
        // Windows directory symlink requires privileges; treat as unavailable.
        let _ = target;
        Ok(false)
    }
    #[cfg(not(any(unix, windows)))]
    {
        Ok(false)
    }
}

/// Remove a file or symlink or directory tree at the given path.
pub fn remove_path(path: &Path) -> Result<(), String> {
    if path.is_symlink() {
        fs::remove_file(path).map_err(|e| format!("remove link {}: {}", path.display(), e))
    } else if path.is_dir() {
        fs::remove_dir_all(path).map_err(|e| format!("remove dir {}: {}", path.display(), e))
    } else if path.exists() {
        fs::remove_file(path).map_err(|e| format!("remove file {}: {}", path.display(), e))
    } else {
        Ok(())
    }
}

/// What does a target path currently point to?
pub fn inspect_path(path: &Path) -> PathKind {
    if !path.exists() && !path.is_symlink() {
        return PathKind::Missing;
    }
    if path.is_symlink() {
        if let Ok(target) = fs::read_link(path) {
            let resolved = if target.is_absolute() {
                target
            } else {
                path.parent().unwrap_or(Path::new("")).join(target)
            };
            let resolved = resolve_symlink_chain(resolved);
            if resolved.exists() {
                return PathKind::Symlink(resolved);
            }
            return PathKind::BrokenSymlink;
        }
        return PathKind::BrokenSymlink;
    }
    if path.is_dir() {
        PathKind::Dir
    } else {
        PathKind::File
    }
}

pub fn resolved_symlink_target(path: &Path) -> Option<PathBuf> {
    match inspect_path(path) {
        PathKind::Symlink(target) => Some(target),
        _ => None,
    }
}

#[derive(Debug, Clone)]
pub enum PathKind {
    Missing,
    File,
    Dir,
    Symlink(PathBuf),
    BrokenSymlink,
}

/// Build a limited file tree for the detail panel (depth-bounded).
pub fn build_file_tree(
    root: &Path,
    max_depth: u32,
) -> Option<crate::skills::v2::models::FileTreeNode> {
    fn build(
        path: &Path,
        _root: &Path,
        depth: u32,
        max_depth: u32,
    ) -> Option<crate::skills::v2::models::FileTreeNode> {
        if depth > max_depth {
            return None;
        }
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if fs::symlink_metadata(path).is_err() {
            return None;
        }
        let is_dir = path.is_dir();
        if is_dir {
            let mut children = Vec::new();
            if let Ok(rd) = fs::read_dir(path) {
                let mut entries: Vec<_> = rd.flatten().collect();
                entries.sort_by_key(|e| e.file_name());
                for entry in entries {
                    let ename = entry.file_name().to_string_lossy().to_string();
                    if crate::skills::v2::fsutil::is_ignored_entry(&ename) {
                        continue;
                    }
                    if let Some(child) = build(&entry.path(), _root, depth + 1, max_depth) {
                        children.push(child);
                    }
                }
            }
            Some(crate::skills::v2::models::FileTreeNode {
                name,
                node_type: "dir".to_string(),
                path: path.display().to_string(),
                children: Some(children),
            })
        } else {
            Some(crate::skills::v2::models::FileTreeNode {
                name,
                node_type: "file".to_string(),
                path: path.display().to_string(),
                children: None,
            })
        }
    }
    build(root, root, 0, max_depth)
}

fn resolve_symlink_chain(mut path: PathBuf) -> PathBuf {
    for _ in 0..8 {
        if !path.is_symlink() {
            break;
        }
        let Ok(target) = fs::read_link(&path) else {
            break;
        };
        path = if target.is_absolute() {
            target
        } else {
            path.parent().unwrap_or(Path::new("")).join(target)
        };
    }
    path
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(label: &str) -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("vb-git-tree-{label}-{suffix}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn git_tree_hash_matches_git_tree_object() {
        let dir = temp_dir("known");
        fs::write(
            dir.join("SKILL.md"),
            "---\nname: alpha\ndescription: demo\n---\n# alpha\n",
        )
        .unwrap();
        fs::write(dir.join("reference.md"), "body").unwrap();
        fs::create_dir_all(dir.join("nested")).unwrap();
        fs::write(dir.join("nested/deep.txt"), "deep").unwrap();

        // `git write-tree` in a scratch repository, as computed by Git itself.
        assert_eq!(
            git_tree_hash(&dir),
            "e2a68a120828c529154ecf9455118c6bfa5ee7c3"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn git_tree_hash_ignores_noise_and_follows_content() {
        let dir = temp_dir("noise");
        fs::write(dir.join("SKILL.md"), "one").unwrap();
        let first = git_tree_hash(&dir);
        assert_eq!(first.len(), 40);

        fs::write(dir.join(".DS_Store"), "noise").unwrap();
        fs::create_dir_all(dir.join("node_modules")).unwrap();
        fs::write(dir.join("node_modules/dep.js"), "generated").unwrap();
        assert_eq!(git_tree_hash(&dir), first);

        fs::write(dir.join("SKILL.md"), "two").unwrap();
        assert_ne!(git_tree_hash(&dir), first);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn file_map_skips_ignored_entries_and_normalizes_separators() {
        let dir = temp_dir("map");
        fs::write(dir.join("SKILL.md"), "x").unwrap();
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("sub/ref.md"), "y").unwrap();
        fs::write(dir.join("node_modules.js.tmp"), "noise").unwrap();

        let map = file_map(&dir);
        let keys: Vec<&str> = map.keys().map(String::as_str).collect();
        assert_eq!(keys, vec!["SKILL.md", "sub/ref.md"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_open_path_recognizes_urls_without_treating_paths_as_urls() {
        assert!(super::is_url("https://github.com/shirenchuang/agentbro"));
        assert!(super::is_url("mailto:hello@example.com"));
        assert!(super::is_url("agentbro://settings"));
        assert!(!super::is_url(r"C:\Users\admin\Documents\github\agentbro"));
        assert!(!super::is_url(r"\\server\share\agentbro"));
    }
}
