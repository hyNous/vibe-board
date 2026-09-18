//! SQLite storage for Skill Manager v2 — schema, migrations, and typed row
//! access. The connection lives in a `Mutex<Connection>` held by `Service`.

use crate::skills::v2::fsutil;
use crate::skills::v2::models::{Snapshot, SCHEMA_VERSION};
use rusqlite::{params, Connection, ErrorCode, OpenFlags, OptionalExtension};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub const MIGRATIONS: &[&str] = &[
    // v1 — initial schema
    r#"
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      skill_type TEXT NOT NULL DEFAULT 'skill',
      center_path TEXT NOT NULL,
      current_hash TEXT NOT NULL,
      frontmatter_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_scanned_at TEXT
    );

    CREATE TABLE IF NOT EXISTS skill_sources (
      skill_id TEXT PRIMARY KEY REFERENCES skills(id) ON DELETE CASCADE,
      source_type TEXT NOT NULL,
      source_uri TEXT,
      source_ref TEXT,
      imported_from_agent TEXT,
      imported_from_path TEXT,
      installed_via TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      skills_dir TEXT,
      config_path TEXT,
      mcp_config_path TEXT,
      plugin_dir TEXT,
      version TEXT,
      latest_version TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_scanned_at TEXT
    );

    CREATE TABLE IF NOT EXISTS skill_targets (
      id TEXT PRIMARY KEY,
      skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      target_path TEXT NOT NULL,
      install_mode TEXT NOT NULL,
      actual_mode TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      current_hash TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(skill_id, agent_id, target_path)
    );

    CREATE TABLE IF NOT EXISTS skill_target_claims (
      id TEXT PRIMARY KEY,
      target_id TEXT NOT NULL REFERENCES skill_targets(id) ON DELETE CASCADE,
      claim_type TEXT NOT NULL,
      pack_id TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(target_id, claim_type, pack_id)
    );

    CREATE TABLE IF NOT EXISTS skill_packs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      tags_json TEXT NOT NULL DEFAULT '[]',
      revision INTEGER NOT NULL DEFAULT 1,
      last_sync_status TEXT NOT NULL DEFAULT 'synced',
      last_sync_error TEXT,
      last_synced_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS skill_pack_members (
      pack_id TEXT NOT NULL REFERENCES skill_packs(id) ON DELETE CASCADE,
      skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      required INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY(pack_id, skill_id)
    );

    CREATE TABLE IF NOT EXISTS skill_pack_agent_syncs (
      pack_id TEXT NOT NULL REFERENCES skill_packs(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      synced_revision INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'synced',
      error TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(pack_id, agent_id)
    );

    CREATE TABLE IF NOT EXISTS unmanaged_items (
      id TEXT PRIMARY KEY,
      item_type TEXT NOT NULL,
      agent_id TEXT,
      path TEXT NOT NULL,
      inferred_skill_id TEXT,
      hash TEXT,
      reason TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS diagnosis_issues (
      id TEXT PRIMARY KEY,
      issue_type TEXT NOT NULL,
      severity TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      title TEXT NOT NULL,
      detail TEXT NOT NULL,
      fix_kind TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );

    CREATE TABLE IF NOT EXISTS operations (
      id TEXT PRIMARY KEY,
      operation_type TEXT NOT NULL,
      status TEXT NOT NULL,
      preview_json TEXT NOT NULL DEFAULT '{}',
      result_json TEXT NOT NULL DEFAULT '{}',
      error TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_scanned_at TEXT,
      pinned INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_skill_targets_agent ON skill_targets(agent_id);
    CREATE INDEX IF NOT EXISTS idx_claims_pack ON skill_target_claims(pack_id);
    CREATE INDEX IF NOT EXISTS idx_pack_agent_syncs_status ON skill_pack_agent_syncs(pack_id, status);
    CREATE INDEX IF NOT EXISTS idx_issues_type ON diagnosis_issues(issue_type, resolved_at);
    CREATE INDEX IF NOT EXISTS idx_projects_root_path ON projects(root_path);
    "#,
];

pub struct Db {
    pub conn: Mutex<Connection>,
}

impl Db {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("create db dir {}: {}", parent.display(), e))?;
        }
        let is_canonical = is_canonical_database_path(path);
        // Copy databases written by older Agent Island/AgentBro builds only
        // into the canonical Vibe Board database. Any other path (tests, or a
        // user-configured sqlite location) must never touch the legacy data
        // roots. The legacy originals are retained next to the copied data.
        if is_canonical {
            migrate_legacy_database(path)?;
        }
        match inspect_database(path)? {
            DatabaseShape::Empty | DatabaseShape::Vibeboard => {}
            // Never reset or replace a database we cannot recognize. The file
            // (and its sidecars) stays exactly where it is so the user can
            // inspect or move it; a rename-based quarantine would itself be an
            // interruption window.
            DatabaseShape::Foreign => {
                return Err(format!(
                    "{} is not a Vibe Board Skill database; refusing to modify it. Move the file or choose a different sqlite path in Skill settings.",
                    path.display()
                ));
            }
        }
        let conn = Connection::open(path).map_err(|e| format!("open db: {}", e))?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
            .map_err(|e| format!("pragma: {}", e))?;
        for sql in MIGRATIONS {
            conn.execute_batch(sql)
                .map_err(|e| format!("migration: {}", e))?;
        }
        ensure_skill_pack_sync_schema(&conn)?;
        // record applied version (idempotent)
        let now = now_iso();
        conn.execute(
            "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?1, ?2)",
            params![SCHEMA_VERSION, now],
        )
        .map_err(|e| format!("record migration: {}", e))?;
        Ok(Db {
            conn: Mutex::new(conn),
        })
    }

    pub fn with_conn<F, T>(&self, f: F) -> Result<T, String>
    where
        F: FnOnce(&Connection) -> Result<T, String>,
    {
        let conn = self.conn.lock().map_err(|e| format!("db lock: {}", e))?;
        f(&conn)
    }

    pub fn transaction<F, T>(&self, f: F) -> Result<T, String>
    where
        F: FnOnce(&rusqlite::Transaction<'_>) -> Result<T, String>,
    {
        let mut conn = self.conn.lock().map_err(|e| format!("db lock: {}", e))?;
        let tx = conn.transaction().map_err(|e| format!("begin tx: {}", e))?;
        let res = f(&tx)?;
        tx.commit().map_err(|e| format!("commit: {}", e))?;
        Ok(res)
    }

    pub fn applied_version(&self) -> Result<i64, String> {
        self.with_conn(|c| {
            c.query_row(
                "SELECT COALESCE(MAX(version), 0) FROM schema_migrations",
                [],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())
        })
    }
}

fn is_canonical_database_path(path: &Path) -> bool {
    fsutil::normalized_path(path) == fsutil::normalized_path(&fsutil::default_sqlite_path())
}

/// Legacy Skill database locations, newest data root first. Only consulted for
/// the canonical database so opening any other path cannot touch user data.
fn legacy_database_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    for root in crate::data_dir::legacy_homes() {
        candidates.push(root.join("skill-manager").join("skill-manager.db"));
        candidates.push(root.join("skill-manager.db"));
    }
    candidates
}

fn migrate_legacy_database(new_db: &Path) -> Result<(), String> {
    if new_db.exists() {
        return Ok(());
    }
    for old_db in legacy_database_candidates() {
        if !old_db.is_file() {
            continue;
        }
        return crate::data_dir::migrate_sqlite(&old_db, new_db)
            .map(|_| ())
            .map_err(|error| {
                format!(
                    "migrate legacy Skill database {} to {}: {}",
                    old_db.display(),
                    new_db.display(),
                    error
                )
            });
    }
    Ok(())
}

enum DatabaseShape {
    Empty,
    Vibeboard,
    Foreign,
}

fn inspect_database(path: &Path) -> Result<DatabaseShape, String> {
    // Never let SQLite create a fresh database next to orphaned WAL/SHM/
    // journal files: replaying an unrelated journal into a new database
    // corrupts it.
    crate::data_dir::ensure_no_orphan_sqlite_sidecars(path).map_err(|error| error.to_string())?;
    if !path.exists() {
        return Ok(DatabaseShape::Empty);
    }
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("inspect db {}: {}", path.display(), e))?;

    let tables = match table_names(&conn) {
        Ok(tables) => tables,
        Err(rusqlite::Error::SqliteFailure(error, _)) if error.code == ErrorCode::NotADatabase => {
            return Ok(DatabaseShape::Foreign);
        }
        Err(error) => return Err(format!("inspect db {}: {}", path.display(), error)),
    };
    if tables.is_empty() {
        return Ok(DatabaseShape::Empty);
    }
    if tables.iter().any(|name| name == "skills") {
        let has_skill_type = column_names(&conn, "skills")?
            .iter()
            .any(|name| name == "skill_type");
        return Ok(if has_skill_type {
            DatabaseShape::Vibeboard
        } else {
            DatabaseShape::Foreign
        });
    }
    if tables.iter().any(|name| name == "schema_migrations") {
        // A previous migration was interrupted before `skills` was created.
        return Ok(DatabaseShape::Vibeboard);
    }
    Ok(DatabaseShape::Foreign)
}

fn table_names(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    rows.collect()
}

fn column_names(conn: &Connection, table: &str) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

fn ensure_skill_pack_sync_schema(conn: &Connection) -> Result<(), String> {
    ensure_column(
        conn,
        "skill_packs",
        "revision",
        "ALTER TABLE skill_packs ADD COLUMN revision INTEGER NOT NULL DEFAULT 1",
    )?;
    ensure_column(
        conn,
        "skill_packs",
        "last_sync_status",
        "ALTER TABLE skill_packs ADD COLUMN last_sync_status TEXT NOT NULL DEFAULT 'synced'",
    )?;
    ensure_column(
        conn,
        "skill_packs",
        "last_sync_error",
        "ALTER TABLE skill_packs ADD COLUMN last_sync_error TEXT",
    )?;
    ensure_column(
        conn,
        "skill_packs",
        "last_synced_at",
        "ALTER TABLE skill_packs ADD COLUMN last_synced_at TEXT",
    )?;
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS skill_pack_agent_syncs (
          pack_id TEXT NOT NULL REFERENCES skill_packs(id) ON DELETE CASCADE,
          agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
          synced_revision INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'synced',
          error TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(pack_id, agent_id)
        );
        CREATE INDEX IF NOT EXISTS idx_pack_agent_syncs_status ON skill_pack_agent_syncs(pack_id, status);
        "#,
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn ensure_column(
    conn: &Connection,
    table: &str,
    column: &str,
    alter_sql: &str,
) -> Result<(), String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(1))
        .map_err(|e| e.to_string())?;
    for row in rows {
        if row.map_err(|e| e.to_string())? == column {
            return Ok(());
        }
    }
    conn.execute(alter_sql, []).map_err(|e| e.to_string())?;
    Ok(())
}

// ── Settings (key/value in DB, with JSON file mirror) ─────────────

pub fn load_settings_json(conn: &Connection) -> serde_json::Value {
    let row: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'settings'",
            [],
            |r| r.get(0),
        )
        .optional()
        .ok()
        .flatten();
    row.and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}

pub fn save_settings_json(conn: &Connection, value: &serde_json::Value) -> Result<(), String> {
    let s = serde_json::to_string(value).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO settings(key, value) VALUES('settings', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![s],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

// ── Snapshot export (raw rows) ────────────────────────────────────

pub fn export_snapshot(conn: &Connection, center_path: &str) -> Result<Snapshot, String> {
    let table_rows = |table: &str| -> Result<Vec<serde_json::Value>, String> {
        let mut stmt = conn
            .prepare(&format!("SELECT * FROM {table}"))
            .map_err(|e| e.to_string())?;
        let cols: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
        let rows = stmt
            .query_map([], |r| {
                let mut obj = serde_json::Map::new();
                for (i, col) in cols.iter().enumerate() {
                    let val: serde_json::Value = match r.get_ref(i) {
                        Ok(rusqlite::types::ValueRef::Null) => serde_json::Value::Null,
                        Ok(rusqlite::types::ValueRef::Integer(n)) => serde_json::json!(n),
                        Ok(rusqlite::types::ValueRef::Real(f)) => serde_json::json!(f),
                        Ok(rusqlite::types::ValueRef::Text(t)) => {
                            serde_json::Value::String(String::from_utf8_lossy(t).to_string())
                        }
                        Ok(rusqlite::types::ValueRef::Blob(b)) => {
                            serde_json::Value::String(hex::encode_simple(b))
                        }
                        Err(_) => serde_json::Value::Null,
                    };
                    obj.insert(col.clone(), val);
                }
                Ok(serde_json::Value::Object(obj))
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| e.to_string())?);
        }
        Ok(out)
    };

    Ok(Snapshot {
        schema_version: SCHEMA_VERSION,
        exported_at: now_iso(),
        center_path: center_path.to_string(),
        skills: table_rows("skills")?,
        sources: table_rows("skill_sources")?,
        agents: table_rows("agents")?,
        targets: table_rows("skill_targets")?,
        claims: table_rows("skill_target_claims")?,
        packs: table_rows("skill_packs")?,
        projects: table_rows("projects")?,
        diagnosis_summary: serde_json::json!({}),
    })
}

mod hex {
    pub fn encode_simple(b: &[u8]) -> String {
        let mut s = String::with_capacity(b.len() * 2);
        for byte in b {
            s.push_str(&format!("{:02x}", byte));
        }
        s
    }
}

// helper for migration: read the retired metadata.json copies, newest first
pub fn legacy_metadata_paths() -> [PathBuf; 2] {
    [
        fsutil::home().join(".agent-island").join("metadata.json"),
        fsutil::home().join(".agentbro").join("metadata.json"),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// Isolated home for migration tests. `VIBEBOARD_HOME` is the only override
    /// the migration paths consult, so the real user profile is never visible.
    struct TempHome {
        path: PathBuf,
        previous_home: Option<OsString>,
        previous_override: Option<OsString>,
    }

    impl TempHome {
        fn new(label: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "vibeboard-db-migration-{label}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .expect("system time")
                    .as_nanos()
            ));
            std::fs::create_dir_all(&path).expect("create temp home");
            let previous_home = std::env::var_os("HOME");
            let previous_override = std::env::var_os("VIBEBOARD_HOME");
            std::env::set_var("VIBEBOARD_HOME", &path);
            // Guard rail: every migration root must resolve inside the isolated
            // temp home, never the real user profile.
            assert!(crate::data_dir::vibeboard_home().starts_with(&path));
            assert!(crate::data_dir::legacy_agent_island_home().starts_with(&path));
            assert!(crate::data_dir::legacy_agentbro_home().starts_with(&path));
            Self {
                path,
                previous_home,
                previous_override,
            }
        }
    }

    impl Drop for TempHome {
        fn drop(&mut self) {
            restore_env("HOME", self.previous_home.as_ref());
            restore_env("VIBEBOARD_HOME", self.previous_override.as_ref());
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    fn restore_env(name: &str, value: Option<&OsString>) {
        match value {
            Some(value) => std::env::set_var(name, value),
            None => std::env::remove_var(name),
        }
    }

    fn write_legacy_database(path: &Path) {
        std::fs::create_dir_all(path.parent().expect("legacy db parent")).expect("legacy dir");
        let conn = Connection::open(path).expect("open legacy db");
        // Seed the real Vibe Board v1 schema so the file is recognized as a
        // still-relevant Skill database, plus one row that must survive.
        conn.execute_batch(MIGRATIONS[0]).expect("legacy schema");
        conn.execute_batch(
            "CREATE TABLE legacy_marker(id INTEGER PRIMARY KEY, label TEXT);
             INSERT INTO legacy_marker(label) VALUES ('kept');",
        )
        .expect("seed legacy db");
    }

    fn has_legacy_marker(db: &Db) -> bool {
        db.with_conn(|conn| {
            conn.query_row("SELECT label FROM legacy_marker LIMIT 1", [], |row| {
                row.get::<_, String>(0)
            })
            .map(|_| ())
            .map_err(|e| e.to_string())
        })
        .is_ok()
    }

    #[test]
    fn canonical_open_migrates_the_legacy_database() {
        let _lock = crate::skills::lock_shared_test_home();
        let _home = TempHome::new("canonical");
        let legacy_db = crate::data_dir::legacy_agent_island_home()
            .join("skill-manager")
            .join("skill-manager.db");
        write_legacy_database(&legacy_db);

        let db = Db::open(&fsutil::default_sqlite_path()).expect("open canonical db");

        assert!(has_legacy_marker(&db), "legacy rows must survive the copy");
        assert!(
            legacy_db.is_file(),
            "the legacy database must be retained next to its retired root"
        );
    }

    #[test]
    fn canonical_open_falls_back_to_the_agentbro_database() {
        let _lock = crate::skills::lock_shared_test_home();
        let _home = TempHome::new("agentbro-fallback");
        let legacy_db = crate::data_dir::legacy_agentbro_home()
            .join("skill-manager")
            .join("skill-manager.db");
        write_legacy_database(&legacy_db);

        let db = Db::open(&fsutil::default_sqlite_path()).expect("open canonical db");

        assert!(
            has_legacy_marker(&db),
            "AgentBro rows must survive the copy"
        );
        assert!(legacy_db.is_file(), "the AgentBro source must be retained");
    }

    #[test]
    fn opening_a_non_canonical_path_never_touches_legacy_roots() {
        let _lock = crate::skills::lock_shared_test_home();
        let home = TempHome::new("non-canonical");
        let legacy_db = crate::data_dir::legacy_agent_island_home()
            .join("skill-manager")
            .join("skill-manager.db");
        write_legacy_database(&legacy_db);

        let other = home.path.join("elsewhere").join("unrelated.db");
        let db = Db::open(&other).expect("open arbitrary db");

        assert!(
            legacy_db.exists(),
            "an arbitrary db open must not move legacy user data"
        );
        assert!(
            !has_legacy_marker(&db),
            "the arbitrary db must be created fresh, not inherit legacy rows"
        );
    }

    #[test]
    fn canonical_open_refuses_an_unfamiliar_database_instead_of_resetting_it() {
        let _lock = crate::skills::lock_shared_test_home();
        let _home = TempHome::new("foreign-canonical");
        let default_db = fsutil::default_sqlite_path();
        std::fs::create_dir_all(default_db.parent().expect("db parent")).expect("db dir");
        {
            let conn = Connection::open(&default_db).expect("open foreign db");
            conn.execute_batch(
                "CREATE TABLE notes(body TEXT);
                 INSERT INTO notes(body) VALUES ('user data');",
            )
            .expect("seed foreign db");
        }

        let error = Db::open(&default_db)
            .err()
            .expect("an unfamiliar canonical database must fail instead of being reset");

        assert!(error.contains("not a Vibe Board Skill database"), "{error}");
        assert!(
            default_db.exists(),
            "the refused database must stay exactly where it was"
        );
        let retained = Connection::open(&default_db).expect("open refused db");
        let body: String = retained
            .query_row("SELECT body FROM notes", [], |row| row.get(0))
            .expect("foreign rows must survive the refusal");
        assert_eq!(body, "user data");
    }

    #[test]
    fn canonical_open_refuses_a_foreign_database_with_committed_wal_rows() {
        use rusqlite::config::DbConfig;

        let _lock = crate::skills::lock_shared_test_home();
        let _home = TempHome::new("foreign-canonical-wal");
        let default_db = fsutil::default_sqlite_path();
        std::fs::create_dir_all(default_db.parent().expect("db parent")).expect("db dir");
        {
            let conn = Connection::open(&default_db).expect("open foreign db");
            conn.pragma_update(None, "journal_mode", "WAL")
                .expect("wal journal mode");
            conn.set_db_config(DbConfig::SQLITE_DBCONFIG_NO_CKPT_ON_CLOSE, true)
                .expect("keep the wal on close");
            conn.pragma_update(None, "wal_autocheckpoint", 0)
                .expect("disable auto checkpoint");
            conn.execute_batch(
                "CREATE TABLE notes(body TEXT);
                 INSERT INTO notes(body) VALUES ('from the wal');",
            )
            .expect("seed foreign db");
        }
        let default_wal = crate::data_dir::sqlite_sidecar_path(&default_db, "-wal");
        assert!(
            default_wal.is_file(),
            "the foreign database must keep a real WAL"
        );

        let error = Db::open(&default_db)
            .err()
            .expect("an unfamiliar canonical database must fail instead of being reset");

        assert!(error.contains("not a Vibe Board Skill database"), "{error}");
        assert!(
            default_db.is_file(),
            "the refused database must stay in place"
        );
        assert!(
            default_wal.is_file(),
            "the committed WAL must stay next to the refused database"
        );
        let retained = Connection::open(&default_db).expect("open refused db");
        let body: String = retained
            .query_row("SELECT body FROM notes", [], |row| row.get(0))
            .expect("rows committed through the WAL must survive the refusal");
        assert_eq!(body, "from the wal");
    }

    #[test]
    fn open_refuses_a_leftover_journal_without_its_database() {
        let _lock = crate::skills::lock_shared_test_home();
        let home = TempHome::new("orphan-sidecar");
        let db_path = home.path.join("orphan").join("skills.db");
        std::fs::create_dir_all(db_path.parent().expect("db parent")).expect("db dir");
        std::fs::write(
            crate::data_dir::sqlite_sidecar_path(&db_path, "-wal"),
            b"orphan wal",
        )
        .expect("orphan wal");

        let error = Db::open(&db_path)
            .err()
            .expect("an orphan journal must block a fresh database");

        assert!(error.contains("leftover journal"), "{error}");
        assert!(
            !db_path.exists(),
            "no fresh database may be opened against the orphan journal"
        );
    }

    #[test]
    fn non_canonical_open_fails_explicitly_for_an_unfamiliar_database() {
        let _lock = crate::skills::lock_shared_test_home();
        let home = TempHome::new("foreign-custom");
        let custom_db = home.path.join("custom").join("skills.db");
        std::fs::create_dir_all(custom_db.parent().expect("db parent")).expect("db dir");
        {
            let conn = Connection::open(&custom_db).expect("open foreign db");
            conn.execute_batch("CREATE TABLE notes(body TEXT);")
                .expect("seed foreign db");
        }

        let error = Db::open(&custom_db)
            .err()
            .expect("unfamiliar custom db must fail");

        assert!(error.contains("not a Vibe Board Skill database"), "{error}");
        assert!(
            custom_db.exists(),
            "the refused database must stay untouched"
        );
    }

    #[test]
    fn canonical_open_fails_explicitly_when_the_database_cannot_be_prepared() {
        let _lock = crate::skills::lock_shared_test_home();
        let home = TempHome::new("blocked");
        let legacy_db = crate::data_dir::legacy_agent_island_home()
            .join("skill-manager")
            .join("skill-manager.db");
        write_legacy_database(&legacy_db);

        let blocked = home.path.join(".vibeboard").join("skill-manager");
        std::fs::create_dir_all(home.path.join(".vibeboard")).expect("vibeboard dir");
        std::fs::write(&blocked, b"a file blocks the database directory").expect("blocker file");

        let error = Db::open(&fsutil::default_sqlite_path())
            .err()
            .expect("a blocked target must fail instead of silently dropping data");

        assert!(error.contains("create db dir"), "{error}");
        assert!(legacy_db.exists(), "the legacy source must stay in place");
    }
}
