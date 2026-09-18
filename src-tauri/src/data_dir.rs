use std::io;
use std::path::{Path, PathBuf};

/// Home-directory overrides, newest first. `VIBEBOARD_HOME` lets tests and
/// portable installs redirect every home-relative data root; `HOME` is honored
/// next so the existing `$HOME`-based test isolation keeps working on Windows,
/// where `dirs::home_dir()` ignores the environment and reads the real profile.
const HOME_DIR_ENV: [&str; 2] = ["VIBEBOARD_HOME", "HOME"];

pub fn home_dir() -> PathBuf {
    for name in HOME_DIR_ENV {
        if let Some(value) = std::env::var_os(name).filter(|value| !value.is_empty()) {
            return PathBuf::from(value);
        }
    }
    dirs::home_dir().unwrap_or_else(std::env::temp_dir)
}

pub fn legacy_agentbro_home() -> PathBuf {
    home_dir().join(".agentbro")
}

/// First Vibe Board data root. Reads fall back to it so installs created before
/// the `vibeboard` namespace migration keep their state.
pub fn legacy_agent_island_home() -> PathBuf {
    home_dir().join(".agent-island")
}

/// Current Vibe Board data root. All new state is written here.
pub fn vibeboard_home() -> PathBuf {
    home_dir().join(".vibeboard")
}

/// Legacy roots newest-first. Only used for compatibility reads and one-time
/// migration; never as a write destination.
pub fn legacy_homes() -> [PathBuf; 2] {
    [legacy_agent_island_home(), legacy_agentbro_home()]
}

/// Resolve a path under the Vibe Board home, moving the newest legacy copy in
/// once so an installed app keeps its data after the namespace change.
pub fn resolve_home_entry(relative: &str) -> PathBuf {
    let current = vibeboard_home().join(relative);
    if !current.exists() {
        for legacy in legacy_homes() {
            let old = legacy.join(relative);
            if old.exists() && migrate_file(&old, &current).unwrap_or(false) {
                break;
            }
        }
    }
    current
}

/// Read the first existing legacy copy of a home-relative file.
pub fn read_legacy_home_file(relative: &str) -> Option<String> {
    legacy_homes()
        .into_iter()
        .map(|legacy| legacy.join(relative))
        .find_map(|path| std::fs::read_to_string(path).ok())
}

pub fn executable_marker_path() -> PathBuf {
    vibeboard_home().join("vibeboard.path")
}

fn legacy_executable_marker_paths() -> [PathBuf; 2] {
    [
        legacy_agent_island_home().join("agent-island.path"),
        legacy_agentbro_home().join("agentbro.path"),
    ]
}

pub fn usage_host_path() -> PathBuf {
    vibeboard_home().join("usage-host")
}

pub fn remember_executable(path: &Path) -> std::io::Result<()> {
    let marker = executable_marker_path();
    if let Some(parent) = marker.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(marker, path.to_string_lossy().as_bytes())
}

pub fn read_executable_marker() -> Option<String> {
    std::fs::read_to_string(executable_marker_path())
        .ok()
        .or_else(|| {
            legacy_executable_marker_paths()
                .into_iter()
                .find_map(|path| std::fs::read_to_string(path).ok())
        })
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
        .or_else(|| read_legacy_home_file("usage-host"))
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

/// Move `old` to `new` once. Returns `Ok(true)` when the file was moved and
/// `Ok(false)` when there was nothing to move (missing source or an existing
/// destination). Errors are surfaced instead of swallowed so callers can
/// decide whether a failed migration must fail explicitly.
pub fn migrate_file(old: &Path, new: &Path) -> io::Result<bool> {
    if !old.exists() || new.exists() {
        return Ok(false);
    }
    if let Some(parent) = new.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::rename(old, new)?;
    Ok(true)
}

/// SQLite names its WAL/SHM/journal sidecars by appending the suffix to the
/// full database file name, so `db.sqlite` has `db.sqlite-wal`;
/// `Path::with_extension` would rewrite the extension and miss (or invent)
/// files.
pub const SQLITE_SIDECAR_SUFFIXES: [&str; 3] = ["-wal", "-shm", "-journal"];

pub fn sqlite_sidecar_path(db: &Path, suffix: &str) -> PathBuf {
    let mut name = db.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// Refuse to let SQLite create a fresh database next to a leftover WAL/SHM/
/// journal file: replaying an unrelated journal into a new database corrupts
/// it.
pub fn ensure_no_orphan_sqlite_sidecars(db: &Path) -> io::Result<()> {
    if db.exists() {
        return Ok(());
    }
    for suffix in SQLITE_SIDECAR_SUFFIXES {
        let sidecar = sqlite_sidecar_path(db, suffix);
        if sidecar.exists() {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                format!(
                    "{} is missing but its SQLite sidecar {} still exists; move or remove the leftover journal before creating a new database",
                    db.display(),
                    sidecar.display()
                ),
            ));
        }
    }
    Ok(())
}

/// Staging suffix for the database copy that is about to be published. The
/// staged file sits next to the destination so the final rename stays on one
/// filesystem and can never be mistaken for a published database.
const SQLITE_STAGING_SUFFIX: &str = ".vibeboard-staging";

fn sqlite_staging_path(db: &Path) -> PathBuf {
    let mut name = db.as_os_str().to_owned();
    name.push(SQLITE_STAGING_SUFFIX);
    PathBuf::from(name)
}

/// Best-effort removal of a database and its sidecars. Used to discard a
/// staging file an interrupted attempt left behind; failures are ignored
/// because the retry reports its own error if the path stays in the way.
fn remove_sqlite_files(db: &Path) {
    let _ = std::fs::remove_file(db);
    for suffix in SQLITE_SIDECAR_SUFFIXES {
        let _ = std::fs::remove_file(sqlite_sidecar_path(db, suffix));
    }
}

/// Copy every committed row of a SQLite database into a new self-contained
/// file. The source is opened read-only, so the original database, its WAL and
/// its SHM are never written; `VACUUM INTO` still reads all data committed
/// through the WAL.
fn copy_sqlite_database(source: &Path, destination: &Path) -> io::Result<()> {
    let conn = rusqlite::Connection::open_with_flags(
        source,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| io::Error::other(format!("open {} read-only: {}", source.display(), error)))?;
    conn.execute("VACUUM INTO ?1", [destination.to_string_lossy().as_ref()])
        .map_err(|error| {
            io::Error::other(format!(
                "copy {} into {} with VACUUM INTO: {}",
                source.display(),
                destination.display(),
                error
            ))
        })?;
    Ok(())
}

/// Publish a complete copy of a SQLite database at `new_db` without moving or
/// deleting the original. The copy is built with SQLite's `VACUUM INTO` into a
/// staging file next to the destination and is renamed into place only once it
/// is complete, so the destination is either absent or a complete database and
/// the source database plus its sidecars stay usable (source retention).
///
/// A process that exits during the copy leaves the source intact and at most a
/// partial staging file, which the next call discards and replaces; a process
/// that exits after the rename leaves the complete destination and the source
/// as they are. A destination sidecar that already exists still refuses the
/// migration: publishing a database next to an unrelated journal would replay
/// that journal into it.
pub fn migrate_sqlite(old_db: &Path, new_db: &Path) -> io::Result<bool> {
    if new_db.exists() || !old_db.is_file() {
        return Ok(false);
    }
    if let Some(parent) = new_db.parent() {
        std::fs::create_dir_all(parent)?;
    }
    for suffix in SQLITE_SIDECAR_SUFFIXES {
        let destination = sqlite_sidecar_path(new_db, suffix);
        if destination.exists() {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                format!(
                    "refusing to migrate {}: destination sidecar {} already exists",
                    old_db.display(),
                    destination.display()
                ),
            ));
        }
    }
    let staging = sqlite_staging_path(new_db);
    remove_sqlite_files(&staging);
    if let Err(error) = copy_sqlite_database(old_db, &staging) {
        remove_sqlite_files(&staging);
        return Err(io::Error::new(
            error.kind(),
            format!(
                "prepare {} for publishing at {}: {}",
                old_db.display(),
                new_db.display(),
                error
            ),
        ));
    }
    if let Err(error) = std::fs::rename(&staging, new_db) {
        remove_sqlite_files(&staging);
        return Err(io::Error::new(
            error.kind(),
            format!(
                "publish {} from staging {}: {}",
                new_db.display(),
                staging.display(),
                error
            ),
        ));
    }
    Ok(true)
}

/// Move a Vibe Board-owned directory once. Only used for directories the app
/// created itself; user-editable legacy roots are never renamed.
pub fn migrate_dir(old: &Path, new: &Path) -> io::Result<bool> {
    if !old.is_dir() || new.exists() {
        return Ok(false);
    }
    if let Some(parent) = new.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::rename(old, new)?;
    Ok(true)
}

/// Retired Tauri identifiers whose WebView data directory can hold preferences
/// written before the Vibe Board namespace change, newest first.
#[cfg(target_os = "windows")]
const LEGACY_WEBVIEW_IDENTIFIERS: [&str; 2] = ["com.agentisland.desktop", "com.agentbro.desktop"];

#[cfg(target_os = "windows")]
fn webview_local_storage_dir(data_dir: &Path) -> PathBuf {
    data_dir
        .join("EBWebView")
        .join("Default")
        .join("Local Storage")
}

#[cfg(target_os = "windows")]
fn copy_dir_all(source: &Path, destination: &Path) -> io::Result<()> {
    std::fs::create_dir_all(destination)?;
    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let target = destination.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_all(&entry.path(), &target)?;
        } else if file_type.is_file() {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn webview_storage_migration_marker(data_dir: &Path) -> PathBuf {
    data_dir.join("vibeboard-webview-storage.migrated")
}

#[cfg(target_os = "windows")]
fn webview_storage_staging_dir(data_dir: &Path) -> PathBuf {
    data_dir
        .join("EBWebView")
        .join("Default")
        .join("Local Storage.vibeboard-migration")
}

/// Copy the retained WebView2 local-storage database from a legacy identifier
/// into the current one so UI-only preferences (for example `sideIslandSize`)
/// survive the changed storage namespace. The legacy directory is copied,
/// never moved or deleted. The copy is staged next to the destination and only
/// renamed into place once complete, so a failed or interrupted copy cannot
/// leave a partial destination behind. A marker records the completed
/// carry-over; while it is missing, every launch retries. If the current
/// namespace already has live storage the legacy LevelDB cannot be merged into
/// it safely, so the call fails explicitly and leaves both stores untouched.
#[cfg(target_os = "windows")]
pub fn copy_legacy_webview_local_storage(
    current_data_dir: &Path,
    legacy_data_dirs: &[PathBuf],
) -> io::Result<bool> {
    let marker = webview_storage_migration_marker(current_data_dir);
    if marker.exists() {
        return Ok(false);
    }
    let destination = webview_local_storage_dir(current_data_dir);
    for legacy in legacy_data_dirs {
        let source = webview_local_storage_dir(legacy);
        if !source.is_dir() {
            continue;
        }
        if destination.exists() {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                format!(
                    "legacy UI storage {} was not carried over because {} already exists; move the current WebView storage aside to retry",
                    source.display(),
                    destination.display()
                ),
            ));
        }
        let staging = webview_storage_staging_dir(current_data_dir);
        if staging.exists() {
            std::fs::remove_dir_all(&staging).map_err(|error| {
                io::Error::new(
                    error.kind(),
                    format!(
                        "clear previous WebView storage staging {}: {}",
                        staging.display(),
                        error
                    ),
                )
            })?;
        }
        copy_dir_all(&source, &staging).map_err(|error| {
            let _ = std::fs::remove_dir_all(&staging);
            error
        })?;
        if let Err(error) = std::fs::rename(&staging, &destination) {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(error);
        }
        if let Err(error) = std::fs::write(&marker, b"copied\n") {
            return Err(io::Error::new(
                error.kind(),
                format!(
                    "record WebView storage carry-over {}: {}",
                    marker.display(),
                    error
                ),
            ));
        }
        return Ok(true);
    }
    Ok(false)
}

/// One-time carry-over of retained WebView storage for `identifier`, called
/// before any window is created. Tauri pins WebView2 state to
/// `%LOCALAPPDATA%\{identifier}` on Windows; other platforms keep the legacy
/// storage in a browser-managed location and are left untouched.
pub fn migrate_legacy_webview_storage(identifier: &str) -> io::Result<bool> {
    #[cfg(target_os = "windows")]
    {
        let Some(base) = dirs::data_local_dir() else {
            return Ok(false);
        };
        let legacy_data_dirs: Vec<PathBuf> = LEGACY_WEBVIEW_IDENTIFIERS
            .iter()
            .map(|legacy| base.join(legacy))
            .collect();
        copy_legacy_webview_local_storage(&base.join(identifier), &legacy_data_dirs)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = identifier;
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "windows")]
    use super::copy_legacy_webview_local_storage;
    use super::{
        ensure_no_orphan_sqlite_sidecars, migrate_file, migrate_sqlite, normalize_usage_host,
        sqlite_sidecar_path, sqlite_staging_path,
    };
    use std::io;
    use std::path::{Path, PathBuf};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "vibeboard-data-dir-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system time")
                .as_nanos()
        ));
        std::fs::create_dir_all(&path).expect("temp dir");
        path
    }

    fn read(path: &Path) -> String {
        std::fs::read_to_string(path).expect("read file")
    }

    fn seed_notes_database(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().expect("db parent")).expect("db dir");
        let conn = rusqlite::Connection::open(path).expect("open seeded db");
        conn.execute_batch("CREATE TABLE notes(body TEXT NOT NULL);")
            .expect("seed schema");
        conn.execute("INSERT INTO notes(body) VALUES (?1)", [body])
            .expect("seed row");
    }

    fn seed_notes_database_with_wal(path: &Path, body: &str) {
        use rusqlite::config::DbConfig;

        std::fs::create_dir_all(path.parent().expect("db parent")).expect("db dir");
        let conn = rusqlite::Connection::open(path).expect("open seeded db");
        conn.pragma_update(None, "journal_mode", "WAL")
            .expect("wal journal mode");
        conn.set_db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, true)
            .expect("keep the wal on close");
        conn.pragma_update(None, "wal_autocheckpoint", 0)
            .expect("disable auto checkpoint");
        conn.execute_batch("CREATE TABLE notes(body TEXT NOT NULL);")
            .expect("seed schema");
        conn.execute("INSERT INTO notes(body) VALUES (?1)", [body])
            .expect("seed row");
    }

    fn notes_body(path: &Path) -> String {
        let conn = rusqlite::Connection::open(path).expect("open db");
        conn.query_row("SELECT body FROM notes", [], |row| row.get(0))
            .expect("read note")
    }

    #[test]
    fn normalizes_supported_usage_hosts() {
        assert_eq!(normalize_usage_host("Codex"), Some("codex"));
        assert_eq!(normalize_usage_host("claude"), Some("claude-code"));
        assert_eq!(normalize_usage_host("open-code"), Some("opencode"));
        assert_eq!(normalize_usage_host("agy"), Some("antigravity"));
        assert_eq!(normalize_usage_host("unknown"), None);
    }

    #[test]
    fn migrate_sqlite_publishes_a_complete_destination_and_keeps_the_source() {
        let root = temp_dir("sqlite-unit");
        let old_db = root.join("old").join("skill-manager.sqlite");
        let new_db = root.join("new").join("skill-manager.sqlite");
        seed_notes_database(&old_db, "database");

        assert!(migrate_sqlite(&old_db, &new_db).expect("migrate"));

        assert_eq!(notes_body(&new_db), "database");
        assert!(
            !sqlite_sidecar_path(&new_db, "-wal").exists(),
            "the published database must be one complete file"
        );
        assert!(
            old_db.is_file(),
            "the source database must be retained after publishing"
        );
        assert_eq!(notes_body(&old_db), "database");
        assert!(
            !sqlite_staging_path(&new_db).exists(),
            "the staging file must be consumed by the publish"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn migrate_sqlite_never_attaches_sidecars_to_an_existing_database() {
        let root = temp_dir("sqlite-existing");
        let old_db = root.join("old").join("skill-manager.db");
        let new_db = root.join("new").join("skill-manager.db");
        std::fs::create_dir_all(old_db.parent().expect("old parent")).expect("old dir");
        std::fs::create_dir_all(new_db.parent().expect("new parent")).expect("new dir");
        std::fs::write(&old_db, b"old database").expect("old db");
        std::fs::write(sqlite_sidecar_path(&old_db, "-wal"), b"old wal").expect("old wal");
        std::fs::write(&new_db, b"existing database").expect("new db");

        assert!(!migrate_sqlite(&old_db, &new_db).expect("migrate"));

        assert_eq!(read(&new_db), "existing database");
        assert!(!sqlite_sidecar_path(&new_db, "-wal").exists());
        assert_eq!(read(&sqlite_sidecar_path(&old_db, "-wal")), "old wal");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn sqlite_sidecars_append_to_the_full_database_name() {
        assert_eq!(
            sqlite_sidecar_path(Path::new("skill-manager.db"), "-wal"),
            PathBuf::from("skill-manager.db-wal")
        );
        assert_eq!(
            sqlite_sidecar_path(Path::new("db.sqlite"), "-shm"),
            PathBuf::from("db.sqlite-shm")
        );
        assert_eq!(
            sqlite_sidecar_path(Path::new("noextension"), "-wal"),
            PathBuf::from("noextension-wal")
        );
    }

    #[test]
    fn migrate_sqlite_refuses_a_leftover_destination_sidecar() {
        let root = temp_dir("sqlite-leftover");
        let old_db = root.join("old").join("skill-manager.db");
        let new_db = root.join("new").join("skill-manager.db");
        std::fs::create_dir_all(old_db.parent().expect("old parent")).expect("old dir");
        std::fs::create_dir_all(new_db.parent().expect("new parent")).expect("new dir");
        std::fs::write(&old_db, b"database").expect("db");
        std::fs::write(sqlite_sidecar_path(&old_db, "-wal"), b"old wal").expect("old wal");
        std::fs::write(sqlite_sidecar_path(&new_db, "-wal"), b"leftover wal").expect("leftover");

        let error = migrate_sqlite(&old_db, &new_db)
            .expect_err("a leftover destination journal must fail the migration");

        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert!(old_db.exists(), "the source database must stay in place");
        assert_eq!(read(&sqlite_sidecar_path(&old_db, "-wal")), "old wal");
        assert!(
            !new_db.exists(),
            "no database may be opened against the leftover journal"
        );
        assert_eq!(read(&sqlite_sidecar_path(&new_db, "-wal")), "leftover wal");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn migrate_sqlite_publishes_committed_wal_rows_and_keeps_the_source_wal() {
        let root = temp_dir("sqlite-real-wal");
        // A non-`.db` name also proves the sidecars follow SQLite's append rule.
        let old_db = root.join("old").join("skill-manager.sqlite");
        let new_db = root.join("new").join("skill-manager.sqlite");
        seed_notes_database_with_wal(&old_db, "written through the wal");
        let old_wal = sqlite_sidecar_path(&old_db, "-wal");
        assert!(
            old_wal.is_file(),
            "closing without a checkpoint must leave the committed WAL behind"
        );

        assert!(migrate_sqlite(&old_db, &new_db).expect("migrate"));

        assert_eq!(
            notes_body(&new_db),
            "written through the wal",
            "committed WAL rows must be published with the copy"
        );
        assert!(
            !sqlite_sidecar_path(&new_db, "-wal").exists(),
            "the published database must be one complete file"
        );
        assert!(old_db.is_file(), "the source database must be retained");
        assert!(
            old_wal.is_file(),
            "the committed source WAL must stay next to its retained database"
        );
        assert_eq!(notes_body(&old_db), "written through the wal");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn migrate_sqlite_retries_after_an_interrupted_attempt() {
        let root = temp_dir("sqlite-interrupted");
        let old_db = root.join("old").join("skill-manager.sqlite");
        let new_db = root.join("new").join("skill-manager.sqlite");
        seed_notes_database_with_wal(&old_db, "committed before the interruption");
        // What an interrupted `VACUUM INTO` leaves behind: a partial staging
        // database plus its journal, and no destination.
        let staging = sqlite_staging_path(&new_db);
        std::fs::create_dir_all(new_db.parent().expect("new parent")).expect("new dir");
        std::fs::write(&staging, b"partial staging database").expect("stale staging");
        std::fs::write(sqlite_sidecar_path(&staging, "-journal"), b"stale journal")
            .expect("stale staging journal");

        assert!(migrate_sqlite(&old_db, &new_db).expect("retry after the interruption"));

        assert_eq!(notes_body(&new_db), "committed before the interruption");
        assert!(
            !staging.exists(),
            "the stale staging file must be discarded before the retry"
        );
        assert!(!sqlite_sidecar_path(&staging, "-journal").exists());
        assert!(
            old_db.is_file(),
            "the source must survive the interrupted attempt"
        );

        // A crash after the publish leaves exactly this state: a complete
        // destination and the retained source. Retrying must change neither.
        assert!(!migrate_sqlite(&old_db, &new_db).expect("second call"));
        assert_eq!(notes_body(&new_db), "committed before the interruption");
        assert_eq!(notes_body(&old_db), "committed before the interruption");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn migrate_sqlite_refuses_a_source_that_is_not_a_database() {
        let root = temp_dir("sqlite-foreign-source");
        let old_db = root.join("old").join("skill-manager.db");
        let new_db = root.join("new").join("skill-manager.db");
        std::fs::create_dir_all(old_db.parent().expect("old parent")).expect("old dir");
        std::fs::write(&old_db, b"not a database").expect("foreign file");

        let error = migrate_sqlite(&old_db, &new_db)
            .expect_err("a source that is not a database must not be published");

        assert!(!error.to_string().is_empty());
        assert_eq!(read(&old_db), "not a database");
        assert!(!new_db.exists(), "no destination may be published");
        assert!(
            !sqlite_staging_path(&new_db).exists(),
            "no staging file may be left behind"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn migrate_sqlite_leaves_the_source_when_it_cannot_be_read() {
        use std::os::windows::fs::OpenOptionsExt;

        let root = temp_dir("sqlite-locked");
        let old_db = root.join("old").join("skill-manager.db");
        let new_db = root.join("new").join("skill-manager.db");
        seed_notes_database(&old_db, "database");
        // Deny all sharing so SQLite cannot read the source, like a live
        // database held by another process.
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&old_db)
            .expect("lock the source database");

        let error = migrate_sqlite(&old_db, &new_db).expect_err("the source must not be read");

        assert!(!error.to_string().is_empty());
        assert!(old_db.is_file(), "the source database must stay in place");
        assert!(!new_db.exists(), "no destination may be published");
        assert!(
            !sqlite_staging_path(&new_db).exists(),
            "no staging file may be left behind"
        );
        drop(lock);
        assert_eq!(notes_body(&old_db), "database");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn orphan_sqlite_sidecar_without_a_database_is_refused() {
        let root = temp_dir("sqlite-orphan");
        let db = root.join("skill-manager.db");
        std::fs::write(sqlite_sidecar_path(&db, "-wal"), b"orphan wal").expect("orphan");

        let error = ensure_no_orphan_sqlite_sidecars(&db)
            .expect_err("a leftover journal must block a fresh database");

        assert!(error.to_string().contains("leftover journal"), "{error}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn migrate_file_reports_failures_and_keeps_the_source() {
        let root = temp_dir("migrate-failure");
        let old = root.join("old.db");
        std::fs::write(&old, b"source").expect("source");
        let blocker = root.join("blocker");
        std::fs::write(&blocker, b"not a directory").expect("blocker");
        let new = blocker.join("moved.db");

        let result = migrate_file(&old, &new);

        assert!(result.is_err(), "a failed move must be reported");
        assert!(old.exists(), "the source must survive a failed move");
        assert_eq!(read(&old), "source");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn webview_storage_carry_over_copies_without_touching_the_source() {
        let root = temp_dir("webview-copy");
        let legacy = root.join("com.agentisland.desktop");
        let current = root.join("com.vibeboard.desktop");
        let legacy_storage = legacy
            .join("EBWebView")
            .join("Default")
            .join("Local Storage")
            .join("leveldb");
        std::fs::create_dir_all(&legacy_storage).expect("legacy storage");
        std::fs::write(legacy_storage.join("CURRENT"), b"legacy prefs").expect("legacy file");

        assert!(
            copy_legacy_webview_local_storage(&current, std::slice::from_ref(&legacy))
                .expect("copy storage")
        );
        let copied = current
            .join("EBWebView")
            .join("Default")
            .join("Local Storage")
            .join("leveldb")
            .join("CURRENT");
        assert_eq!(read(&copied), "legacy prefs");
        assert!(
            legacy_storage.join("CURRENT").exists(),
            "the legacy storage must be copied, not moved"
        );
        assert!(
            current.join("vibeboard-webview-storage.migrated").exists(),
            "a completed carry-over must be recorded"
        );

        // A second launch must not overwrite storage the new namespace owns.
        std::fs::write(&copied, b"new prefs").expect("new file");
        assert!(
            !copy_legacy_webview_local_storage(&current, std::slice::from_ref(&legacy))
                .expect("copy storage")
        );
        assert_eq!(read(&copied), "new prefs");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn webview_storage_pending_carry_over_is_explicit_and_recoverable() {
        let root = temp_dir("webview-pending");
        let legacy = root.join("com.agentisland.desktop");
        let current = root.join("com.vibeboard.desktop");
        let legacy_storage = legacy
            .join("EBWebView")
            .join("Default")
            .join("Local Storage")
            .join("leveldb");
        std::fs::create_dir_all(&legacy_storage).expect("legacy storage");
        std::fs::write(legacy_storage.join("CURRENT"), b"legacy prefs").expect("legacy file");
        // Startup already created live storage in the new namespace.
        let destination = current
            .join("EBWebView")
            .join("Default")
            .join("Local Storage")
            .join("leveldb");
        std::fs::create_dir_all(&destination).expect("destination storage");
        std::fs::write(destination.join("CURRENT"), b"current prefs").expect("current file");

        let error = copy_legacy_webview_local_storage(&current, std::slice::from_ref(&legacy))
            .expect_err("an existing destination must not be overwritten or skipped silently");

        assert!(error.to_string().contains("already exists"), "{error}");
        assert_eq!(read(&destination.join("CURRENT")), "current prefs");
        assert_eq!(read(&legacy_storage.join("CURRENT")), "legacy prefs");
        assert!(
            !current.join("vibeboard-webview-storage.migrated").exists(),
            "a pending carry-over must not be marked complete"
        );

        // Once the new namespace storage is moved aside the retry succeeds.
        std::fs::remove_dir_all(current.join("EBWebView")).expect("clear destination");
        assert!(
            copy_legacy_webview_local_storage(&current, std::slice::from_ref(&legacy))
                .expect("retry copy")
        );
        assert_eq!(read(&destination.join("CURRENT")), "legacy prefs");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn webview_storage_carry_over_without_a_source_is_retried_later() {
        let root = temp_dir("webview-late-source");
        let current = root.join("com.vibeboard.desktop");
        let legacy = root.join("com.agentisland.desktop");
        let legacy_storage = legacy
            .join("EBWebView")
            .join("Default")
            .join("Local Storage")
            .join("leveldb");

        assert!(
            !copy_legacy_webview_local_storage(&current, std::slice::from_ref(&legacy))
                .expect("nothing to copy")
        );
        assert!(
            !current.join("vibeboard-webview-storage.migrated").exists(),
            "a missing source must not be recorded as carried over"
        );

        std::fs::create_dir_all(&legacy_storage).expect("legacy storage");
        std::fs::write(legacy_storage.join("CURRENT"), b"legacy prefs").expect("legacy file");
        assert!(
            copy_legacy_webview_local_storage(&current, std::slice::from_ref(&legacy))
                .expect("copy the late source")
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn webview_storage_carry_over_failure_leaves_no_destination() {
        let root = temp_dir("webview-failure");
        let legacy = root.join("com.agentisland.desktop");
        let legacy_storage = legacy
            .join("EBWebView")
            .join("Default")
            .join("Local Storage")
            .join("leveldb");
        std::fs::create_dir_all(&legacy_storage).expect("legacy storage");
        std::fs::write(legacy_storage.join("CURRENT"), b"legacy prefs").expect("legacy file");
        // A file where the current data directory belongs makes the staged copy fail.
        let current = root.join("com.vibeboard.desktop");
        std::fs::write(&current, b"not a directory").expect("current blocker");

        let error = copy_legacy_webview_local_storage(&current, std::slice::from_ref(&legacy))
            .expect_err("an impossible copy must be reported");

        assert!(!error.to_string().is_empty());
        assert_eq!(read(&legacy_storage.join("CURRENT")), "legacy prefs");
        assert!(
            !current.join("vibeboard-webview-storage.migrated").exists(),
            "a failed copy must not be recorded as carried over"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn webview_storage_locked_source_is_reported_and_left_in_place() {
        use std::os::windows::fs::OpenOptionsExt;

        let root = temp_dir("webview-locked");
        let legacy = root.join("com.agentisland.desktop");
        let current = root.join("com.vibeboard.desktop");
        let legacy_storage = legacy
            .join("EBWebView")
            .join("Default")
            .join("Local Storage")
            .join("leveldb");
        std::fs::create_dir_all(&legacy_storage).expect("legacy storage");
        std::fs::write(legacy_storage.join("CURRENT"), b"legacy prefs").expect("legacy file");
        // A live WebView holds its LevelDB files without sharing.
        let lock = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(legacy_storage.join("CURRENT"))
            .expect("lock legacy file");

        let error = copy_legacy_webview_local_storage(&current, std::slice::from_ref(&legacy))
            .expect_err("a live legacy store must not be copied silently");

        assert!(!error.to_string().is_empty());
        assert!(legacy_storage.join("CURRENT").exists());
        assert!(
            !super::webview_local_storage_dir(&current).exists(),
            "no partial destination may be left behind"
        );
        assert!(
            !current.join("vibeboard-webview-storage.migrated").exists(),
            "a locked source must not be recorded as carried over"
        );
        drop(lock);
        let _ = std::fs::remove_dir_all(&root);
    }
}
