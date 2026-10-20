use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};

use super::models::TaskEventRecord;

pub struct ControlTowerDatabase {
    conn: Mutex<Connection>,
}

impl ControlTowerDatabase {
    pub fn open() -> anyhow::Result<Self> {
        let db_dir = Self::db_dir()?;
        std::fs::create_dir_all(&db_dir)?;
        let db_path = db_dir.join("tasks.db");
        // Carry the trace database over from the retired Agent Island/AgentBro
        // roots before opening it. The copy is published as one complete SQLite
        // file (the legacy original is retained) and a failed copy is reported
        // instead of opening a fresh database next to leftover files.
        if !db_path.exists() {
            for legacy_root in crate::data_dir::legacy_homes() {
                let legacy = legacy_root.join("control_tower").join("tasks.db");
                if crate::data_dir::migrate_sqlite(&legacy, &db_path).map_err(|error| {
                    anyhow::anyhow!(
                        "migrate legacy task database {}: {}",
                        legacy.display(),
                        error
                    )
                })? {
                    break;
                }
            }
        }
        // A leftover journal without its database must not be replayed into a
        // freshly created one.
        crate::data_dir::ensure_no_orphan_sqlite_sidecars(&db_path)?;
        let conn = Connection::open(&db_path)?;
        Self::init_connection(&conn, true)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn open_in_memory() -> anyhow::Result<Self> {
        let conn = Connection::open_in_memory()?;
        Self::init_connection(&conn, false)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn init_connection(conn: &Connection, persistent: bool) -> anyhow::Result<()> {
        if persistent {
            conn.execute_batch("PRAGMA journal_mode=WAL;")?;
        }
        conn.execute_batch("PRAGMA foreign_keys=ON;")?;

        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY,
                trace_id TEXT NOT NULL,
                project TEXT NOT NULL,
                title TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS agent_runs (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                session_id TEXT NOT NULL,
                parent_run_id TEXT REFERENCES agent_runs(id) ON DELETE CASCADE,
                agent TEXT NOT NULL,
                role TEXT NOT NULL,
                dispatched_task TEXT,
                title TEXT NOT NULL,
                status TEXT NOT NULL,
                started_at INTEGER NOT NULL,
                completed_at INTEGER,
                pid INTEGER,
                exit_code INTEGER,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS task_events (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
                timestamp_ms INTEGER NOT NULL,
                kind TEXT NOT NULL,
                event_type TEXT NOT NULL,
                title TEXT NOT NULL,
                detail TEXT,
                status TEXT,
                payload_json TEXT,
                created_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_agent_runs_task ON agent_runs(task_id);
            CREATE INDEX IF NOT EXISTS idx_agent_runs_parent ON agent_runs(parent_run_id);
            CREATE INDEX IF NOT EXISTS idx_task_events_run ON task_events(run_id);
            "#,
        )?;

        // Keep databases created by the previous Trace milestone readable.
        Self::ensure_agent_run_columns(conn)?;

        Ok(())
    }

    fn ensure_agent_run_columns(conn: &Connection) -> anyhow::Result<()> {
        let mut stmt = conn.prepare("PRAGMA table_info(agent_runs)")?;
        let columns = stmt
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<Result<Vec<_>, _>>()?;
        for (name, definition) in [("pid", "INTEGER"), ("exit_code", "INTEGER")] {
            if !columns.iter().any(|column| column == name) {
                conn.execute(
                    &format!("ALTER TABLE agent_runs ADD COLUMN {name} {definition}"),
                    [],
                )?;
            }
        }
        Ok(())
    }

    fn db_dir() -> anyhow::Result<PathBuf> {
        Ok(crate::data_dir::vibeboard_home().join("control_tower"))
    }

    pub(crate) fn record_native_event(
        &self,
        event: &TaskEventRecord,
        native_status: &str,
    ) -> anyhow::Result<bool> {
        let mut conn = self.conn.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        let tx = conn.transaction()?;
        let run_context: Option<(String, String)> = tx
            .query_row(
                "SELECT task_id, status FROM agent_runs WHERE id = ?1",
                params![event.run_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((task_id, current_status)) = run_context else {
            return Ok(false);
        };
        if task_id != event.task_id {
            return Ok(false);
        }

        let effective_status = if current_status == "error" && native_status != "error" {
            "error"
        } else {
            native_status
        };
        tx.execute(
            "UPDATE agent_runs SET status = ?1, updated_at = ?2 WHERE id = ?3",
            params![effective_status, event.created_at, event.run_id],
        )?;
        let task_status = Self::task_status_for_run(effective_status, 0);
        tx.execute(
            "UPDATE tasks SET status = ?1, updated_at = ?2 WHERE id = ?3",
            params![task_status, event.created_at, task_id],
        )?;
        Self::insert_event_tx(&tx, event)?;
        tx.commit()?;
        Ok(true)
    }

    fn task_status_for_run(run_status: &str, active_children: i64) -> &str {
        match run_status {
            "error" => "error",
            "waiting_approval" | "waiting_input" | "blocked" => run_status,
            "interrupted" => "interrupted",
            "starting" | "running" | "processing" | "compacting" => "running",
            _ if active_children > 0 => "running",
            _ => "completed",
        }
    }

    fn insert_event_tx(
        tx: &rusqlite::Transaction<'_>,
        event: &TaskEventRecord,
    ) -> anyhow::Result<()> {
        tx.execute(
            r#"
            INSERT INTO task_events (
                id, task_id, run_id, timestamp_ms, kind, event_type,
                title, detail, status, payload_json, created_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
            ON CONFLICT(id) DO UPDATE SET
                kind = excluded.kind,
                event_type = excluded.event_type,
                title = excluded.title,
                detail = excluded.detail,
                status = excluded.status,
                payload_json = excluded.payload_json
            "#,
            params![
                event.id,
                event.task_id,
                event.run_id,
                event.timestamp_ms as i64,
                event.kind,
                event.event_type,
                event.title,
                event.detail,
                event.status,
                event.payload_json,
                event.created_at,
            ],
        )?;
        Ok(())
    }
}
