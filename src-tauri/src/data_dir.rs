use std::path::{Path, PathBuf};

pub fn legacy_agentbro_home() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".agentbro")
}

/// Small, Vibe Board-owned runtime directory for integration markers.
/// Legacy files are only consulted when they still exist and are migrated once.
pub fn agent_island_home() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".agent-island")
}

pub fn executable_marker_path() -> PathBuf {
    agent_island_home().join("agent-island.path")
}

pub fn usage_host_path() -> PathBuf {
    agent_island_home().join("usage-host")
}

pub fn remember_executable(path: &Path) -> std::io::Result<()> {
    let marker = executable_marker_path();
    if let Some(parent) = marker.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(marker, path.to_string_lossy().as_bytes())
}

pub fn normalize_usage_host(provider: &str) -> Option<&'static str> {
    match provider.trim().to_ascii_lowercase().as_str() {
        "codex" | "openai.codex" => Some("codex"),
        "claude" | "claude-code" | "anthropic" => Some("claude-code"),
        "opencode" | "open-code" => Some("opencode"),
        "antigravity" | "agy" => Some("antigravity"),
        _ => None,
    }
}

pub fn usage_host() -> Option<String> {
    std::fs::read_to_string(usage_host_path())
        .ok()
        .and_then(|value| normalize_usage_host(&value).map(str::to_string))
}

pub fn set_usage_host(provider: &str) -> std::io::Result<()> {
    let host = normalize_usage_host(provider).ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "unsupported usage host")
    })?;
    let marker = usage_host_path();
    if let Some(parent) = marker.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(marker, host.as_bytes())
}

pub fn migrate_file(old: &Path, new: &Path) {
    if old.exists() && !new.exists() {
        if let Some(parent) = new.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::rename(old, new);
    }
}

pub fn migrate_sqlite(old_db: &Path, new_db: &Path) {
    migrate_file(old_db, new_db);
    let old_wal = old_db.with_extension("db-wal");
    let new_wal = new_db.with_extension("db-wal");
    migrate_file(&old_wal, &new_wal);
    let old_shm = old_db.with_extension("db-shm");
    let new_shm = new_db.with_extension("db-shm");
    migrate_file(&old_shm, &new_shm);
}

#[cfg(test)]
mod tests {
    use super::normalize_usage_host;

    #[test]
    fn normalizes_supported_usage_hosts() {
        assert_eq!(normalize_usage_host("Codex"), Some("codex"));
        assert_eq!(normalize_usage_host("claude"), Some("claude-code"));
        assert_eq!(normalize_usage_host("open-code"), Some("opencode"));
        assert_eq!(normalize_usage_host("agy"), Some("antigravity"));
        assert_eq!(normalize_usage_host("unknown"), None);
    }
}
