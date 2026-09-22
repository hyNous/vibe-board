//! SQLite persistence for local usage history (M8b).
//!
//! Two tables:
//!
//! * `usage_files` — the incremental-scan cache and resume state. The cache
//!   key is `(provider, path)` with the file's size and modification time;
//!   `offset` / `tail_hash` / cumulative counters let an append-only log
//!   continue from the last read position.
//! * `usage_day_model` — the persisted daily aggregate, grouped by provider,
//!   source file, local day, and model. Aggregate queries sum these rows, so
//!   deleting a source log never removes already recorded history.

use super::scanner::ParsedFile;
use rusqlite::{params, Connection, OptionalExtension};

use std::path::{Path, PathBuf};
use std::time::Duration;

const BUSY_TIMEOUT_MS: u64 = 5_000;
pub(crate) const USAGE_HISTORY_DB_FILE: &str = "usage-history.db";

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS usage_files (
    provider TEXT NOT NULL,
    path TEXT NOT NULL,
    size INTEGER NOT NULL,
    modified INTEGER NOT NULL,
    offset INTEGER NOT NULL,
    tail_hash TEXT NOT NULL DEFAULT '',
    last_model TEXT,
    cumulative_input INTEGER,
    cumulative_output INTEGER,
    cumulative_cache_read INTEGER,
    cumulative_cache_create INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (provider, path)
);
CREATE TABLE IF NOT EXISTS usage_day_model (
    provider TEXT NOT NULL,
    path TEXT NOT NULL,
    day TEXT NOT NULL,
    model TEXT NOT NULL,
    input INTEGER NOT NULL DEFAULT 0,
    output INTEGER NOT NULL DEFAULT 0,
    cache_read INTEGER NOT NULL DEFAULT 0,
    cache_create INTEGER NOT NULL DEFAULT 0,
    requests INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (provider, path, day, model)
);
CREATE INDEX IF NOT EXISTS idx_usage_day_model_provider_day
    ON usage_day_model(provider, day);
";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct TokenCounts {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_create: u64,
    pub requests: u64,
}

/// A cached source-file row plus the state needed to resume reading it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FileState {
    pub size: u64,
    pub modified: i64,
    pub offset: u64,
    pub tail_hash: String,
    pub last_model: Option<String>,
    pub cumulative: Option<[i64; 4]>,
}

#[derive(Debug, Clone)]
pub(crate) struct UsageHistoryStore {
    path: PathBuf,
}

impl UsageHistoryStore {
    pub(crate) fn at(path: PathBuf) -> Self {
        Self { path }
    }

    fn open(&self) -> Result<Connection, String> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("create {}: {error}", parent.display()))?;
        }
        // Never let SQLite create a fresh database next to a leftover
        // WAL/SHM/journal file; replaying an unrelated journal corrupts it.
        crate::data_dir::ensure_no_orphan_sqlite_sidecars(&self.path)
            .map_err(|error| error.to_string())?;
        let conn = Connection::open(&self.path)
            .map_err(|error| format!("open {}: {error}", self.path.display()))?;
        conn.busy_timeout(Duration::from_millis(BUSY_TIMEOUT_MS))
            .map_err(|error| error.to_string())?;
        conn.execute_batch(SCHEMA)
            .map_err(|error| error.to_string())?;
        Ok(conn)
    }

    pub(crate) fn cached_file(
        &self,
        provider: &str,
        path: &Path,
    ) -> Result<Option<FileState>, String> {
        let conn = self.open()?;
        let path = path.to_string_lossy();
        conn.query_row(
            "SELECT size, modified, offset, tail_hash, last_model,
                    cumulative_input, cumulative_output, cumulative_cache_read, cumulative_cache_create
             FROM usage_files WHERE provider = ?1 AND path = ?2",
            params![provider, path],
            |row| {
                let cumulative = match (
                    row.get::<_, Option<i64>>(5)?,
                    row.get::<_, Option<i64>>(6)?,
                    row.get::<_, Option<i64>>(7)?,
                    row.get::<_, Option<i64>>(8)?,
                ) {
                    (Some(input), Some(output), Some(cache_read), Some(cache_create)) => {
                        Some([input, output, cache_read, cache_create])
                    }
                    _ => None,
                };
                Ok(FileState {
                    size: row.get::<_, i64>(0)?.max(0) as u64,
                    modified: row.get(1)?,
                    offset: row.get::<_, i64>(2)?.max(0) as u64,
                    tail_hash: row.get(3)?,
                    last_model: row.get(4)?,
                    cumulative,
                })
            },
        )
        .optional()
        .map_err(|error| error.to_string())
    }

    /// Records one file's parse result. `replace` drops the file's previous
    /// daily rows first (the file was rewritten or truncated and was reparsed
    /// from the start); otherwise the new rows are added to the existing ones
    /// (an append-only log resumed from its last offset).
    pub(crate) fn apply_file(
        &self,
        provider: &str,
        path: &Path,
        size: u64,
        modified: i64,
        parsed: &ParsedFile,
        replace: bool,
    ) -> Result<(), String> {
        let mut conn = self.open()?;
        let path_text = path.to_string_lossy().to_string();
        let tx = conn.transaction().map_err(|error| error.to_string())?;
        if replace {
            tx.execute(
                "DELETE FROM usage_day_model WHERE provider = ?1 AND path = ?2",
                params![provider, path_text],
            )
            .map_err(|error| error.to_string())?;
        }
        for (day, model, counts) in &parsed.rows {
            tx.execute(
                "INSERT INTO usage_day_model
                     (provider, path, day, model, input, output, cache_read, cache_create, requests)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(provider, path, day, model) DO UPDATE SET
                     input = input + excluded.input,
                     output = output + excluded.output,
                     cache_read = cache_read + excluded.cache_read,
                     cache_create = cache_create + excluded.cache_create,
                     requests = requests + excluded.requests",
                params![
                    provider,
                    path_text,
                    day,
                    model,
                    counts.input as i64,
                    counts.output as i64,
                    counts.cache_read as i64,
                    counts.cache_create as i64,
                    counts.requests as i64
                ],
            )
            .map_err(|error| error.to_string())?;
        }
        let cumulative = parsed.cumulative;
        tx.execute(
            "INSERT INTO usage_files
                 (provider, path, size, modified, offset, tail_hash, last_model,
                  cumulative_input, cumulative_output, cumulative_cache_read, cumulative_cache_create,
                  updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(provider, path) DO UPDATE SET
                 size = excluded.size,
                 modified = excluded.modified,
                 offset = excluded.offset,
                 tail_hash = excluded.tail_hash,
                 last_model = excluded.last_model,
                 cumulative_input = excluded.cumulative_input,
                 cumulative_output = excluded.cumulative_output,
                 cumulative_cache_read = excluded.cumulative_cache_read,
                 cumulative_cache_create = excluded.cumulative_cache_create,
                 updated_at = excluded.updated_at",
            params![
                provider,
                path_text,
                size as i64,
                modified,
                parsed.offset as i64,
                parsed.tail_hash,
                parsed.last_model,
                cumulative.map(|values| values[0]),
                cumulative.map(|values| values[1]),
                cumulative.map(|values| values[2]),
                cumulative.map(|values| values[3]),
                chrono::Utc::now().timestamp_millis()
            ],
        )
        .map_err(|error| error.to_string())?;
        tx.commit().map_err(|error| error.to_string())
    }

    /// Daily rows within `[start_day, end_day]` (inclusive, `YYYY-MM-DD`
    /// strings sort chronologically) for one provider.
    pub(crate) fn provider_rows(
        &self,
        provider: &str,
        start_day: &str,
        end_day: &str,
    ) -> Result<Vec<(String, String, TokenCounts)>, String> {
        let conn = self.open()?;
        let mut statement = conn
            .prepare(
                "SELECT day, model, SUM(input), SUM(output), SUM(cache_read), SUM(cache_create), SUM(requests)
                 FROM usage_day_model
                 WHERE provider = ?1 AND day >= ?2 AND day <= ?3
                 GROUP BY day, model
                 ORDER BY day, model",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![provider, start_day, end_day], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    TokenCounts {
                        input: row.get::<_, i64>(2)?.max(0) as u64,
                        output: row.get::<_, i64>(3)?.max(0) as u64,
                        cache_read: row.get::<_, i64>(4)?.max(0) as u64,
                        cache_create: row.get::<_, i64>(5)?.max(0) as u64,
                        requests: row.get::<_, i64>(6)?.max(0) as u64,
                    },
                ))
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }

    pub(crate) fn provider_has_rows(&self, provider: &str) -> Result<bool, String> {
        let conn = self.open()?;
        conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM usage_day_model WHERE provider = ?1)",
            params![provider],
            |row| row.get::<_, i64>(0),
        )
        .map(|value| value != 0)
        .map_err(|error| error.to_string())
    }

    pub(crate) fn provider_file_count(&self, provider: &str) -> Result<usize, String> {
        let conn = self.open()?;
        conn.query_row(
            "SELECT COUNT(*) FROM usage_files WHERE provider = ?1",
            params![provider],
            |row| row.get::<_, i64>(0),
        )
        .map(|value| value.max(0) as usize)
        .map_err(|error| error.to_string())
    }

    pub(crate) fn provider_request_total(&self, provider: &str) -> Result<u64, String> {
        let conn = self.open()?;
        conn.query_row(
            "SELECT COALESCE(SUM(requests), 0) FROM usage_day_model WHERE provider = ?1",
            params![provider],
            |row| row.get::<_, i64>(0),
        )
        .map(|value| value.max(0) as u64)
        .map_err(|error| error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store(label: &str) -> (UsageHistoryStore, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "vibeboard-usage-store-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time")
                .as_nanos()
        ));
        let store = UsageHistoryStore::at(root.join(USAGE_HISTORY_DB_FILE));
        (store, root)
    }

    fn parsed(rows: Vec<(&str, &str, TokenCounts)>) -> ParsedFile {
        ParsedFile {
            rows: rows
                .into_iter()
                .map(|(day, model, counts)| (day.to_string(), model.to_string(), counts))
                .collect(),
            offset: 10,
            tail_hash: "hash".to_string(),
            last_model: Some("gpt-5-codex".to_string()),
            cumulative: Some([1, 2, 3, 4]),
            oversized_lines: 0,
            events: 1,
        }
    }

    #[test]
    fn appending_rows_adds_to_the_daily_aggregate() {
        let (store, root) = temp_store("append");
        let path = root.join("rollout-a.jsonl");
        let first = parsed(vec![(
            "2026-09-22",
            "gpt-5-codex",
            TokenCounts {
                input: 10,
                output: 2,
                cache_read: 3,
                cache_create: 1,
                requests: 1,
            },
        )]);
        store
            .apply_file("codex", &path, 10, 1_000, &first, true)
            .expect("store first parse");
        let second = parsed(vec![(
            "2026-09-22",
            "gpt-5-codex",
            TokenCounts {
                input: 5,
                output: 1,
                cache_read: 0,
                cache_create: 0,
                requests: 1,
            },
        )]);
        store
            .apply_file("codex", &path, 20, 2_000, &second, false)
            .expect("store resumed parse");

        let rows = store
            .provider_rows("codex", "2026-09-01", "2026-09-30")
            .expect("query");
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].2.input, 15);
        assert_eq!(rows[0].2.output, 3);
        assert_eq!(rows[0].2.cache_read, 3);
        assert_eq!(rows[0].2.cache_create, 1);
        assert_eq!(rows[0].2.requests, 2);
        assert_eq!(store.provider_file_count("codex").unwrap(), 1);
        assert!(store.provider_has_rows("codex").unwrap());
        assert!(!store.provider_has_rows("claude-code").unwrap());

        let state = store
            .cached_file("codex", &path)
            .expect("read cache")
            .expect("cache row");
        assert_eq!(state.size, 20);
        assert_eq!(state.modified, 2_000);
        assert_eq!(state.offset, 10);
        assert_eq!(state.cumulative, Some([1, 2, 3, 4]));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn replacing_a_file_drops_its_previous_rows_only() {
        let (store, root) = temp_store("replace");
        let path_a = root.join("rollout-a.jsonl");
        let path_b = root.join("rollout-b.jsonl");
        let row = |input: u64| {
            parsed(vec![(
                "2026-09-22",
                "gpt-5-codex",
                TokenCounts {
                    input,
                    output: 0,
                    cache_read: 0,
                    cache_create: 0,
                    requests: 1,
                },
            )])
        };
        store
            .apply_file("codex", &path_a, 10, 1_000, &row(10), true)
            .expect("store a");
        store
            .apply_file("codex", &path_b, 10, 1_000, &row(7), true)
            .expect("store b");
        store
            .apply_file("codex", &path_a, 5, 3_000, &row(4), true)
            .expect("rewrite a");

        let rows = store
            .provider_rows("codex", "2026-09-01", "2026-09-30")
            .expect("query");
        let total: u64 = rows.iter().map(|(_, _, counts)| counts.input).sum();
        assert_eq!(total, 11, "rewritten file must not keep its old rows");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn provider_rows_are_filtered_by_local_day_range() {
        let (store, root) = temp_store("day-range");
        let path = root.join("rollout-range.jsonl");
        let row = |day: &str, input: u64| {
            (
                day.to_string(),
                "gpt-5-codex".to_string(),
                TokenCounts {
                    input,
                    ..TokenCounts::default()
                },
            )
        };
        let parsed_file = ParsedFile {
            rows: vec![
                row("2026-08-31", 1),
                row("2026-09-01", 2),
                row("2026-09-22", 4),
            ],
            ..ParsedFile::default()
        };
        store
            .apply_file("codex", &path, 10, 1_000, &parsed_file, true)
            .expect("store rows");

        let rows = store
            .provider_rows("codex", "2026-09-01", "2026-09-22")
            .expect("query");
        let total: u64 = rows.iter().map(|(_, _, counts)| counts.input).sum();
        assert_eq!(total, 6);
        assert_eq!(store.provider_request_total("codex").unwrap(), 0);
        let _ = std::fs::remove_dir_all(root);
    }
}
