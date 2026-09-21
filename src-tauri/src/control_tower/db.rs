use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};

use super::models::{AgentRunRecord, TaskEventRecord, TaskRecord};

pub struct ControlTowerDatabase {
    conn: Mutex<Connection>,
}

#[derive(Debug, Clone)]
pub(crate) struct ParentRunContext {
    pub task_id: String,
    pub trace_id: String,
    pub project: String,
    pub parent_run_id: String,
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

    fn get_events_for_run(conn: &Connection, run_id: &str) -> anyhow::Result<Vec<TaskEventRecord>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, task_id, run_id, timestamp_ms, kind, event_type, title, detail, status, payload_json, created_at
            FROM task_events WHERE run_id = ?1
            ORDER BY timestamp_ms ASC, id ASC
            "#,
        )?;
        let rows = stmt
            .query_map(params![run_id], |r| {
                Ok(TaskEventRecord {
                    id: r.get(0)?,
                    task_id: r.get(1)?,
                    run_id: r.get(2)?,
                    timestamp_ms: r.get::<_, i64>(3)? as u64,
                    kind: r.get(4)?,
                    event_type: r.get(5)?,
                    title: r.get(6)?,
                    detail: r.get(7)?,
                    status: r.get(8)?,
                    payload_json: r.get(9)?,
                    created_at: r.get(10)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    }

    fn get_runs_tree_for_task(
        conn: &Connection,
        task_id: &str,
    ) -> anyhow::Result<Vec<AgentRunRecord>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, task_id, session_id, parent_run_id, agent, role, dispatched_task, title, status, started_at, completed_at, pid, exit_code, created_at, updated_at
            FROM agent_runs WHERE task_id = ?1
            ORDER BY started_at ASC, id ASC
            "#,
        )?;
        let raw_runs = stmt
            .query_map(params![task_id], |r| {
                Ok(AgentRunRecord {
                    id: r.get(0)?,
                    task_id: r.get(1)?,
                    session_id: r.get(2)?,
                    parent_run_id: r.get(3)?,
                    agent: r.get(4)?,
                    role: r.get(5)?,
                    dispatched_task: r.get(6)?,
                    title: r.get(7)?,
                    status: r.get(8)?,
                    started_at: r.get(9)?,
                    completed_at: r.get(10)?,
                    pid: r.get(11)?,
                    exit_code: r.get(12)?,
                    children: Vec::new(),
                    events: Vec::new(),
                    created_at: r.get(13)?,
                    updated_at: r.get(14)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let mut runs_with_events = Vec::new();
        for mut run in raw_runs {
            run.events = Self::get_events_for_run(conn, &run.id)?;
            runs_with_events.push(run);
        }

        let (root_runs, child_runs): (Vec<_>, Vec<_>) = runs_with_events
            .into_iter()
            .partition(|r| r.parent_run_id.is_none());

        let mut roots = Vec::new();
        for mut root in root_runs {
            root.children = child_runs
                .iter()
                .filter(|c| c.parent_run_id.as_deref() == Some(&root.id))
                .cloned()
                .collect();
            roots.push(root);
        }

        Ok(roots)
    }

    pub fn get_all_tasks(&self) -> anyhow::Result<Vec<TaskRecord>> {
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        let mut stmt = conn.prepare(
            r#"
            SELECT id, trace_id, project, title, status, created_at, updated_at
            FROM tasks ORDER BY created_at DESC, id DESC
            "#,
        )?;
        let tasks_base = stmt
            .query_map([], |r| {
                Ok(TaskRecord {
                    id: r.get(0)?,
                    trace_id: r.get(1)?,
                    project: r.get(2)?,
                    title: r.get(3)?,
                    status: r.get(4)?,
                    runs: Vec::new(),
                    created_at: r.get(5)?,
                    updated_at: r.get(6)?,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;

        let mut result = Vec::new();
        for mut task in tasks_base {
            task.runs = Self::get_runs_tree_for_task(&conn, &task.id)?;
            result.push(task);
        }
        Ok(result)
    }

    pub(crate) fn find_parent_run(
        &self,
        task_id: Option<&str>,
        parent_run_id: Option<&str>,
    ) -> anyhow::Result<Option<ParentRunContext>> {
        let conn = self.conn.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        let mut stmt = conn.prepare(
            r#"
            SELECT r.task_id, t.trace_id, t.project, r.id
            FROM agent_runs r
            JOIN tasks t ON t.id = r.task_id
            WHERE r.agent = 'codex'
              AND r.role = 'orchestrator'
              AND (?1 IS NULL OR r.task_id = ?1)
              AND (?2 IS NULL OR r.id = ?2)
            ORDER BY r.updated_at DESC, r.id DESC
            LIMIT 1
            "#,
        )?;
        stmt.query_row(params![task_id, parent_run_id], |row| {
            Ok(ParentRunContext {
                task_id: row.get(0)?,
                trace_id: row.get(1)?,
                project: row.get(2)?,
                parent_run_id: row.get(3)?,
            })
        })
        .optional()
        .map_err(Into::into)
    }

    pub(crate) fn insert_child_run(
        &self,
        run: &AgentRunRecord,
        event: &TaskEventRecord,
    ) -> anyhow::Result<()> {
        let mut conn = self.conn.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        let tx = conn.transaction()?;
        tx.execute(
            r#"
            INSERT INTO agent_runs (
                id, task_id, session_id, parent_run_id, agent, role,
                dispatched_task, title, status, started_at, completed_at,
                pid, exit_code, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
            ON CONFLICT(id) DO UPDATE SET
                task_id = excluded.task_id,
                session_id = excluded.session_id,
                parent_run_id = excluded.parent_run_id,
                agent = excluded.agent,
                role = excluded.role,
                dispatched_task = excluded.dispatched_task,
                title = excluded.title,
                status = excluded.status,
                started_at = excluded.started_at,
                completed_at = excluded.completed_at,
                pid = excluded.pid,
                exit_code = excluded.exit_code,
                updated_at = excluded.updated_at
            "#,
            params![
                run.id,
                run.task_id,
                run.session_id,
                run.parent_run_id,
                run.agent,
                run.role,
                run.dispatched_task,
                run.title,
                run.status,
                run.started_at,
                run.completed_at,
                run.pid.map(i64::from),
                run.exit_code,
                run.created_at,
                run.updated_at,
            ],
        )?;
        tx.execute(
            "UPDATE tasks SET status = 'running', updated_at = ?1 WHERE id = ?2",
            params![run.updated_at, run.task_id],
        )?;
        Self::insert_event_tx(&tx, event)?;
        tx.commit()?;
        Ok(())
    }

    pub(crate) fn mark_run_started(
        &self,
        run_id: &str,
        pid: Option<u32>,
        event: &TaskEventRecord,
    ) -> anyhow::Result<()> {
        let mut conn = self.conn.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        let tx = conn.transaction()?;
        tx.execute(
            "UPDATE agent_runs SET status = 'running', pid = ?1, updated_at = ?2 WHERE id = ?3",
            params![pid.map(i64::from), event.created_at, run_id],
        )?;
        Self::insert_event_tx(&tx, event)?;
        tx.commit()?;
        Ok(())
    }

    pub(crate) fn mark_run_finished(
        &self,
        run_id: &str,
        status: &str,
        exit_code: Option<i32>,
        completed_at: i64,
        event: &TaskEventRecord,
    ) -> anyhow::Result<()> {
        let mut conn = self.conn.lock().map_err(|e| anyhow::anyhow!("{e}"))?;
        let tx = conn.transaction()?;
        let task_id: String = tx.query_row(
            "SELECT task_id FROM agent_runs WHERE id = ?1",
            params![run_id],
            |row| row.get(0),
        )?;
        let current_status: String = tx.query_row(
            "SELECT status FROM agent_runs WHERE id = ?1",
            params![run_id],
            |row| row.get(0),
        )?;
        let latest_native_status: Option<String> = tx
            .query_row(
                "SELECT status FROM task_events WHERE run_id = ?1 AND kind = 'native' AND status IS NOT NULL ORDER BY timestamp_ms DESC, id DESC LIMIT 1",
                params![run_id],
                |row| row.get(0),
            )
            .optional()?;
        let final_status = if current_status == "error"
            || status == "error"
            || matches!(latest_native_status.as_deref(), Some("error"))
        {
            "error"
        } else if status == "completed"
            && matches!(
                latest_native_status.as_deref(),
                Some("waiting_approval" | "waiting_input" | "blocked")
            )
        {
            latest_native_status.as_deref().unwrap_or(status)
        } else {
            status
        };
        tx.execute(
            "UPDATE agent_runs SET status = ?1, exit_code = ?2, completed_at = ?3, updated_at = ?4 WHERE id = ?5",
            params![final_status, exit_code, completed_at, event.created_at, run_id],
        )?;
        let active_children: i64 = tx.query_row(
            "SELECT COUNT(*) FROM agent_runs WHERE task_id = ?1 AND status IN ('starting', 'running')",
            params![task_id],
            |row| row.get(0),
        )?;
        let task_status = Self::task_status_for_run(final_status, active_children);
        tx.execute(
            "UPDATE tasks SET status = ?1, updated_at = ?2 WHERE id = ?3",
            params![task_status, event.created_at, task_id],
        )?;
        Self::insert_event_tx(&tx, event)?;
        tx.commit()?;
        Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    fn seed_task_with_runs(
        db: &ControlTowerDatabase,
        task_id: &str,
        root_run_id: &str,
        child_run_id: &str,
    ) {
        let conn = db.conn.lock().expect("lock");
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO tasks (id, trace_id, project, title, status, created_at, updated_at)
             VALUES (?1, 'trace-native-race', 'control-tower', 'Native race', 'running', ?2, ?2)",
            params![task_id, now],
        )
        .expect("insert task");
        for (index, (run_id, parent, role)) in [
            (root_run_id, None::<&str>, "orchestrator"),
            (child_run_id, Some(root_run_id), "worker"),
        ]
        .into_iter()
        .enumerate()
        {
            conn.execute(
                "INSERT INTO agent_runs (
                    id, task_id, session_id, parent_run_id, agent, role,
                    dispatched_task, title, status, started_at, completed_at, created_at, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, 'codex', ?5, NULL, ?6, 'running', ?7, NULL, ?8, ?8)",
                params![
                    run_id,
                    task_id,
                    format!("session-{run_id}"),
                    parent,
                    role,
                    run_id,
                    index as i64,
                    now
                ],
            )
            .expect("insert run");
        }
    }

    #[test]
    fn native_blocking_state_wins_process_completion_race() {
        let db = ControlTowerDatabase::open_in_memory().expect("in memory db");
        let task_id = "task-native-race";
        let root_run_id = "run-native-root";
        let child_run_id = "run-native-child";
        seed_task_with_runs(&db, task_id, root_run_id, child_run_id);
        let now = Utc::now();
        let native_event = TaskEventRecord {
            id: "evt-native-waiting".to_string(),
            task_id: task_id.to_string(),
            run_id: child_run_id.to_string(),
            timestamp_ms: now.timestamp_millis() as u64,
            kind: "native".to_string(),
            event_type: "native.PermissionRequest".to_string(),
            title: "Waiting for permission: Bash".to_string(),
            detail: None,
            status: Some("waiting_approval".to_string()),
            payload_json: None,
            created_at: now.to_rfc3339(),
        };

        assert!(db
            .record_native_event(&native_event, "waiting_approval")
            .expect("record native event"));

        let process_event = TaskEventRecord {
            id: "evt-process-completed".to_string(),
            task_id: native_event.task_id.clone(),
            run_id: native_event.run_id.clone(),
            timestamp_ms: native_event.timestamp_ms + 1,
            kind: "process".to_string(),
            event_type: "process.completed".to_string(),
            title: "Child Run Completed".to_string(),
            detail: None,
            status: Some("completed".to_string()),
            payload_json: None,
            created_at: (now + chrono::Duration::milliseconds(1)).to_rfc3339(),
        };
        db.mark_run_finished(
            &native_event.run_id,
            "completed",
            Some(0),
            now.timestamp(),
            &process_event,
        )
        .expect("record process completion");

        let task = db
            .get_all_tasks()
            .expect("get tasks")
            .into_iter()
            .find(|task| task.id == native_event.task_id)
            .expect("task");
        assert_eq!(task.status, "waiting_approval");
        assert_eq!(task.runs[0].children[0].status, "waiting_approval");
    }
}
