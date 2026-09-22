//! Incremental, streaming readers for the Agent session logs (M8b).
//!
//! Logs can be hundreds of megabytes, so every file is read line by line into a
//! bounded buffer: lines longer than [`MAX_LOG_LINE_BYTES`] are counted and
//! skipped without being kept in memory, and at most one line is held at a
//! time. Files whose `(path, size, modified)` cache entry is unchanged are not
//! reparsed at all; append-only files resume from the previous byte offset
//! after the bytes before that offset are re-hashed to prove the prefix is
//! still the one that was counted.

use super::store::{FileState, TokenCounts};
use crate::usage::codex::{codex_token_counts_from_line, codex_token_delta, CodexTokenCounts};
use crate::usage::normalize::{date_from_value, number_field};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File};
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// Longest single log line the scanner will buffer. Real usage events are a few
/// kilobytes; a line at or above this cap is almost certainly a tool payload
/// and is skipped with a warning instead of being loaded.
pub(crate) const MAX_LOG_LINE_BYTES: usize = 2 * 1024 * 1024;
const OVERSIZED_WARN_LIMIT: usize = 10;
const READ_BUFFER_BYTES: usize = 64 * 1024;
/// Bytes hashed at the previous end offset to detect in-place rewrites.
const TAIL_HASH_BYTES: u64 = 256;
pub(crate) const UNKNOWN_MODEL: &str = "unknown";

#[derive(Debug, Clone)]
pub(crate) struct SourceRoot {
    pub provider: &'static str,
    pub root: PathBuf,
}

#[derive(Debug, Clone)]
pub(crate) struct SourceFile {
    pub provider: &'static str,
    pub path: PathBuf,
    pub size: u64,
    pub modified: i64,
}

#[derive(Debug, Clone)]
pub(crate) struct ParsedSource {
    pub parsed: ParsedFile,
    /// True when the file was parsed from the start and its previous daily rows
    /// must be dropped before the new ones are stored.
    pub replace_existing: bool,
}

/// One file's parsed contribution: per-(local day, model) token counts plus the
/// state needed to resume the file on the next scan.
#[derive(Debug, Clone, Default)]
pub(crate) struct ParsedFile {
    pub rows: Vec<(String, String, TokenCounts)>,
    pub offset: u64,
    pub tail_hash: String,
    pub last_model: Option<String>,
    pub cumulative: Option<[i64; 4]>,
    pub oversized_lines: usize,
    pub events: usize,
}

/// Discovers every `*.jsonl` file under the configured roots. Directory
/// symlinks are not followed so a link cycle cannot hang the scan.
pub(crate) fn discover_source_files(roots: &[SourceRoot]) -> Vec<SourceFile> {
    let mut files = Vec::new();
    for source in roots {
        let mut stack = vec![source.root.clone()];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let Ok(file_type) = entry.file_type() else {
                    continue;
                };
                let path = entry.path();
                if file_type.is_dir() {
                    stack.push(path);
                    continue;
                }
                if !file_type.is_file()
                    || path.extension().and_then(|value| value.to_str()) != Some("jsonl")
                {
                    continue;
                }
                let Ok(metadata) = entry.metadata() else {
                    continue;
                };
                files.push(SourceFile {
                    provider: source.provider,
                    path,
                    size: metadata.len(),
                    modified: modified_millis(&metadata),
                });
            }
        }
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    files
}

fn modified_millis(metadata: &fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

pub(crate) fn parse_source_file(
    provider: &str,
    file: &SourceFile,
    resume: Option<&FileState>,
) -> io::Result<ParsedSource> {
    match provider {
        "codex" => parse_codex(file, resume),
        "claude-code" => parse_claude(file, resume),
        other => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("no local usage parser for provider {other}"),
        )),
    }
}

fn open_cursor<'a>(
    file: &SourceFile,
    resume: Option<&'a FileState>,
) -> io::Result<(LineCursor<BufReader<File>>, Option<&'a FileState>)> {
    let handle = File::open(&file.path)?;
    let mut reader = BufReader::with_capacity(READ_BUFFER_BYTES, handle);
    let mut start_offset = 0u64;
    let mut accepted = None;
    if let Some(state) = resume {
        if state.offset > 0
            && state.offset <= file.size
            && tail_hash(&file.path, state.offset)? == state.tail_hash
        {
            start_offset = state.offset;
            accepted = Some(state);
        }
    }
    if start_offset > 0 {
        reader.seek(SeekFrom::Start(start_offset))?;
    }
    Ok((
        LineCursor {
            reader,
            buffer: Vec::new(),
            path: file.path.clone(),
            offset: start_offset,
            oversized_lines: 0,
            oversized_warned: 0,
        },
        accepted,
    ))
}

fn parse_codex(file: &SourceFile, resume: Option<&FileState>) -> io::Result<ParsedSource> {
    let (mut cursor, resume) = open_cursor(file, resume)?;
    let fallback = fallback_time(file.modified);
    let mut rows: BTreeMap<(String, String), TokenCounts> = BTreeMap::new();
    let mut model = resume.and_then(|state| state.last_model.clone());
    let mut cumulative = resume
        .and_then(|state| state.cumulative)
        .map(|values| CodexTokenCounts {
            input: values[0].max(0) as u64,
            output: values[1].max(0) as u64,
            cache_read: values[2].max(0) as u64,
            cache_create: values[3].max(0) as u64,
        });
    let mut events = 0usize;

    while let Some(line) = cursor.next_line()? {
        let Ok(object) = serde_json::from_slice::<serde_json::Value>(line) else {
            continue;
        };
        if let Some(found) = codex_model_from_line(&object) {
            model = Some(found);
            continue;
        }
        let Some(event) = codex_token_counts_from_line(&object) else {
            continue;
        };
        events += 1;
        let Some(delta) = codex_token_delta(&event, &mut cumulative) else {
            continue;
        };
        if delta.is_zero() {
            continue;
        }
        let timestamp = object
            .get("timestamp")
            .and_then(date_from_value)
            .unwrap_or(fallback);
        let counts = rows
            .entry((
                local_day_key(timestamp),
                model.clone().unwrap_or_else(|| UNKNOWN_MODEL.to_string()),
            ))
            .or_default();
        counts.input += delta.input;
        counts.output += delta.output;
        counts.cache_read += delta.cache_read;
        counts.cache_create += delta.cache_create;
        counts.requests += 1;
    }

    let replace_existing = resume.is_none();
    let offset = cursor.offset;
    let oversized_lines = cursor.oversized_lines;
    let parsed = ParsedFile {
        rows: rows
            .into_iter()
            .map(|((day, model), counts)| (day, model, counts))
            .collect(),
        offset,
        tail_hash: tail_hash(&file.path, offset)?,
        last_model: model,
        cumulative: cumulative.map(|counts| {
            [
                counts.input as i64,
                counts.output as i64,
                counts.cache_read as i64,
                counts.cache_create as i64,
            ]
        }),
        oversized_lines,
        events,
    };
    Ok(ParsedSource {
        parsed,
        replace_existing,
    })
}

fn parse_claude(file: &SourceFile, resume: Option<&FileState>) -> io::Result<ParsedSource> {
    let (mut cursor, resume) = open_cursor(file, resume)?;
    let fallback = fallback_time(file.modified);
    let mut rows: BTreeMap<(String, String), TokenCounts> = BTreeMap::new();
    // One API response can appear more than once in a transcript; a repeated
    // message id inside this read is the same request, not a second one.
    let mut seen_message_ids: HashSet<String> = HashSet::new();
    let mut events = 0usize;

    while let Some(line) = cursor.next_line()? {
        let Ok(object) = serde_json::from_slice::<serde_json::Value>(line) else {
            continue;
        };
        if object.get("type").and_then(|value| value.as_str()) != Some("assistant") {
            continue;
        }
        let message = object.get("message");
        let Some(usage) = message
            .and_then(|value| value.get("usage"))
            .or_else(|| object.get("usage"))
        else {
            continue;
        };
        if let Some(message_id) = message
            .and_then(|value| value.get("id"))
            .and_then(|value| value.as_str())
        {
            if !seen_message_ids.insert(message_id.to_string()) {
                continue;
            }
        }
        let input = positive_tokens(usage, "input_tokens");
        let output = positive_tokens(usage, "output_tokens");
        let cache_read = positive_tokens(usage, "cache_read_input_tokens");
        let cache_write = number_field(usage, "cache_creation_input_tokens")
            .map(|value| value.max(0.0) as u64)
            .unwrap_or_else(|| {
                usage
                    .get("cache_creation")
                    .map(|creation| {
                        positive_tokens(creation, "ephemeral_5m_input_tokens")
                            + positive_tokens(creation, "ephemeral_1h_input_tokens")
                    })
                    .unwrap_or(0)
            });
        events += 1;
        let model = message
            .and_then(|value| value.get("model"))
            .or_else(|| object.get("model"))
            .and_then(|value| value.as_str())
            .filter(|value| !value.trim().is_empty())
            .map(ToString::to_string)
            .unwrap_or_else(|| UNKNOWN_MODEL.to_string());
        let timestamp = object
            .get("timestamp")
            .and_then(date_from_value)
            .unwrap_or(fallback);
        let counts = rows.entry((local_day_key(timestamp), model)).or_default();
        counts.input += input;
        counts.output += output;
        counts.cache_read += cache_read;
        counts.cache_create += cache_write;
        counts.requests += 1;
    }

    let replace_existing = resume.is_none();
    let offset = cursor.offset;
    let oversized_lines = cursor.oversized_lines;
    Ok(ParsedSource {
        parsed: ParsedFile {
            rows: rows
                .into_iter()
                .map(|((day, model), counts)| (day, model, counts))
                .collect(),
            offset,
            tail_hash: tail_hash(&file.path, offset)?,
            last_model: None,
            cumulative: None,
            oversized_lines,
            events,
        },
        replace_existing,
    })
}

fn codex_model_from_line(object: &serde_json::Value) -> Option<String> {
    let kind = object.get("type").and_then(|value| value.as_str())?;
    if kind != "session_meta" && kind != "turn_context" {
        return None;
    }
    object
        .get("payload")
        .and_then(|payload| {
            payload
                .get("model")
                .or_else(|| payload.get("model_name"))
                .or_else(|| payload.get("model_slug"))
        })
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .map(ToString::to_string)
}

fn positive_tokens(value: &serde_json::Value, key: &str) -> u64 {
    number_field(value, key)
        .unwrap_or(0.0)
        .max(0.0)
        .min(u64::MAX as f64) as u64
}

/// Local (user timezone) calendar day used for the daily aggregate buckets.
pub(crate) fn local_day_key(timestamp: chrono::DateTime<chrono::Utc>) -> String {
    timestamp
        .with_timezone(&chrono::Local)
        .format("%Y-%m-%d")
        .to_string()
}

fn fallback_time(modified_millis: i64) -> chrono::DateTime<chrono::Utc> {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(modified_millis)
        .unwrap_or_else(chrono::Utc::now)
}

fn tail_hash(path: &Path, offset: u64) -> io::Result<String> {
    if offset == 0 {
        return Ok(String::new());
    }
    let mut handle = File::open(path)?;
    let start = offset.saturating_sub(TAIL_HASH_BYTES);
    handle.seek(SeekFrom::Start(start))?;
    let mut window = Vec::with_capacity((offset - start) as usize);
    handle.take(offset - start).read_to_end(&mut window)?;
    let mut hasher = Sha256::new();
    hasher.update(&window);
    let mut hex = String::with_capacity(64);
    for byte in hasher.finalize() {
        use std::fmt::Write;
        let _ = write!(hex, "{byte:02x}");
    }
    Ok(hex)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LineRead {
    Eof,
    /// Line at or above the cap; dropped without buffering it.
    TooLong {
        consumed: u64,
        terminated: bool,
    },
    /// Complete line ending in a newline.
    Line {
        consumed: u64,
    },
    /// Tail fragment without a trailing newline. Left unconsumed so the next
    /// scan can read it once the writer finishes the line.
    Partial,
}

/// Reads one line into `buffer` while keeping at most `max` bytes. Oversized
/// lines are consumed from the reader but never stored.
fn read_line_capped<R: BufRead>(
    reader: &mut R,
    buffer: &mut Vec<u8>,
    max: usize,
) -> io::Result<LineRead> {
    buffer.clear();
    let mut total = 0u64;
    let mut truncated = false;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok(if total == 0 {
                LineRead::Eof
            } else {
                LineRead::Partial
            });
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let chunk = newline.map_or(available.len(), |position| position + 1);
        if buffer.len() < max {
            let keep = (max - buffer.len()).min(chunk);
            buffer.extend_from_slice(&available[..keep]);
            if keep < chunk {
                truncated = true;
            }
        } else {
            truncated = true;
        }
        total += chunk as u64;
        reader.consume(chunk);
        if newline.is_some() {
            return Ok(if truncated {
                LineRead::TooLong {
                    consumed: total,
                    terminated: true,
                }
            } else {
                LineRead::Line { consumed: total }
            });
        }
    }
}

struct LineCursor<R: BufRead> {
    reader: R,
    buffer: Vec<u8>,
    path: PathBuf,
    offset: u64,
    oversized_lines: usize,
    oversized_warned: usize,
}

impl<R: BufRead> LineCursor<R> {
    fn next_line(&mut self) -> io::Result<Option<&[u8]>> {
        loop {
            match read_line_capped(&mut self.reader, &mut self.buffer, MAX_LOG_LINE_BYTES)? {
                LineRead::Eof | LineRead::Partial => return Ok(None),
                LineRead::TooLong {
                    consumed,
                    terminated,
                } => {
                    self.oversized_lines += 1;
                    if self.oversized_warned < OVERSIZED_WARN_LIMIT {
                        self.oversized_warned += 1;
                        log::warn!(
                            "Skipping oversized usage log line in {} ({} bytes, limit {} bytes)",
                            self.path.display(),
                            consumed,
                            MAX_LOG_LINE_BYTES
                        );
                    }
                    if !terminated {
                        return Ok(None);
                    }
                    self.offset += consumed;
                }
                LineRead::Line { consumed } => {
                    self.offset += consumed;
                    return Ok(Some(&self.buffer));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn source(path: &Path, size: u64, modified: i64) -> SourceFile {
        SourceFile {
            provider: "codex",
            path: path.to_path_buf(),
            size,
            modified,
        }
    }

    fn temp_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "vibeboard-usage-scan-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time")
                .as_nanos()
        ));
        fs::create_dir_all(&root).expect("create temp root");
        root
    }

    #[test]
    fn capped_reader_keeps_at_most_the_cap_for_oversized_lines() {
        let line = format!("{}\n", "x".repeat(4_096));
        let mut reader = Cursor::new(line.as_bytes());
        let mut buffer = Vec::new();

        let read = read_line_capped(&mut reader, &mut buffer, 1_024).expect("read");

        assert!(matches!(read, LineRead::TooLong { .. }));
        assert_eq!(
            buffer.len(),
            1_024,
            "oversized line must not be buffered whole"
        );
    }

    #[test]
    fn capped_reader_leaves_the_unterminated_tail_for_the_next_scan() {
        let mut reader = Cursor::new(b"{\"a\":1}\n{\"b\":");
        let mut buffer = Vec::new();

        let first = read_line_capped(&mut reader, &mut buffer, 1_024).expect("first line");
        assert!(matches!(first, LineRead::Line { .. }));
        let tail = read_line_capped(&mut reader, &mut buffer, 1_024).expect("tail");
        assert!(matches!(tail, LineRead::Partial));
    }

    #[test]
    fn discovery_collects_nested_jsonl_files_only() {
        let root = temp_root("discover");
        let nested = root.join("2026").join("09");
        fs::create_dir_all(&nested).expect("create nested");
        fs::write(root.join("rollout-a.jsonl"), "{}\n").expect("write a");
        fs::write(nested.join("rollout-b.jsonl"), "{}\n").expect("write b");
        fs::write(root.join("notes.txt"), "ignore\n").expect("write txt");

        let files = discover_source_files(&[SourceRoot {
            provider: "codex",
            root: root.clone(),
        }]);

        assert_eq!(files.len(), 2);
        assert!(files.iter().all(|file| file.provider == "codex"));
        assert!(files
            .iter()
            .all(|file| file.path.extension().and_then(|value| value.to_str()) == Some("jsonl")));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn codex_parser_attributes_token_events_to_the_current_model_and_local_day() {
        let root = temp_root("codex-model");
        let path = root.join("rollout-model.jsonl");
        let now = chrono::Utc::now();
        let stamp = |offset_hours: i64| {
            (now + chrono::Duration::hours(offset_hours))
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        };
        let line = |timestamp: String, model: &str, input: u64, cached: u64, output: u64| {
            let context = serde_json::json!({
                "type": "turn_context",
                "timestamp": timestamp,
                "payload": { "model": model },
            });
            let event = serde_json::json!({
                "type": "event_msg",
                "timestamp": timestamp,
                "payload": {
                    "type": "token_count",
                    "info": {
                        "total_token_usage": {
                            "input_tokens": input,
                            "cached_input_tokens": cached,
                            "output_tokens": output,
                        }
                    }
                }
            });
            format!("{context}\n{event}\n")
        };
        fs::write(
            &path,
            format!(
                "{}{}",
                line(stamp(-2), "gpt-5-codex", 1_000, 400, 100),
                line(stamp(-1), "gpt-5-mini", 1_200, 0, 120)
            ),
        )
        .expect("write rollout");
        let size = fs::metadata(&path).expect("metadata").len();

        let source = source(&path, size, 0);
        let parsed = parse_source_file("codex", &source, None)
            .expect("parse")
            .parsed;

        assert_eq!(parsed.events, 2);
        assert_eq!(parsed.rows.len(), 2);
        let models = parsed
            .rows
            .iter()
            .map(|(_, model, _)| model.as_str())
            .collect::<Vec<_>>();
        assert!(models.contains(&"gpt-5-codex"));
        assert!(models.contains(&"gpt-5-mini"));
        let codex_row = parsed
            .rows
            .iter()
            .find(|(_, model, _)| model == "gpt-5-codex")
            .expect("codex row");
        assert_eq!(codex_row.2.input, 600);
        assert_eq!(codex_row.2.cache_read, 400);
        assert_eq!(codex_row.2.output, 100);
        assert_eq!(codex_row.2.requests, 1);
        assert_eq!(codex_row.0, local_day_key(now - chrono::Duration::hours(2)));
        assert_eq!(parsed.oversized_lines, 0);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn claude_parser_splits_cache_creation_and_deduplicates_message_ids() {
        let root = temp_root("claude-usage");
        let path = root.join("session.jsonl");
        fs::write(
            &path,
            r#"{"type":"assistant","message":{"id":"msg-1","model":"claude-sonnet-4-5-20250929","usage":{"input_tokens":10,"output_tokens":2,"cache_read_input_tokens":30,"cache_creation":{"ephemeral_5m_input_tokens":4,"ephemeral_1h_input_tokens":6}}},"timestamp":"2026-09-22T03:00:00.000Z"}
{"type":"assistant","message":{"id":"msg-1","model":"claude-sonnet-4-5-20250929","usage":{"input_tokens":10,"output_tokens":2,"cache_read_input_tokens":30,"cache_creation_input_tokens":10}},"timestamp":"2026-09-22T03:00:00.000Z"}
{"type":"assistant","message":{"id":"msg-2","model":"claude-opus-4-8","usage":{"input_tokens":5,"output_tokens":1}},"timestamp":"2026-09-22T04:00:00.000Z"}
"#,
        )
        .expect("write transcript");
        let size = fs::metadata(&path).expect("metadata").len();

        let source = source(&path, size, 0);
        let parsed = parse_source_file("claude-code", &source, None)
            .expect("parse")
            .parsed;

        assert_eq!(
            parsed.events, 2,
            "duplicate message id must not double count"
        );
        assert_eq!(parsed.rows.len(), 2);
        let sonnet = parsed
            .rows
            .iter()
            .find(|(_, model, _)| model == "claude-sonnet-4-5-20250929")
            .expect("sonnet row");
        assert_eq!(sonnet.2.input, 10);
        assert_eq!(sonnet.2.output, 2);
        assert_eq!(sonnet.2.cache_read, 30);
        assert_eq!(sonnet.2.cache_create, 10);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn oversized_lines_are_counted_without_breaking_the_scan() {
        let root = temp_root("oversized");
        let path = root.join("rollout-big.jsonl");
        let huge = "y".repeat(MAX_LOG_LINE_BYTES + 16);
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let event = |input: u64, output: u64| {
            serde_json::json!({
                "type": "event_msg",
                "timestamp": now,
                "payload": {
                    "type": "token_count",
                    "info": { "total_token_usage": { "input_tokens": input, "output_tokens": output } }
                }
            })
            .to_string()
        };
        fs::write(
            &path,
            format!("{huge}\n{}\n{}\n", event(50, 5), event(80, 8)),
        )
        .expect("write oversized rollout");
        let size = fs::metadata(&path).expect("metadata").len();

        let source = source(&path, size, 0);
        let parsed = parse_source_file("codex", &source, None)
            .expect("parse")
            .parsed;

        assert_eq!(parsed.oversized_lines, 1);
        assert_eq!(parsed.events, 2);
        let total: u64 = parsed.rows.iter().map(|(_, _, counts)| counts.input).sum();
        assert_eq!(total, 30 + 50);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn resumed_parse_only_adds_the_appended_usage() {
        let root = temp_root("resume");
        let path = root.join("rollout-resume.jsonl");
        let now = chrono::Utc::now();
        let stamp = |offset_hours: i64| {
            (now + chrono::Duration::hours(offset_hours))
                .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
        };
        let event = |timestamp: String, input: u64| {
            serde_json::json!({
                "type": "event_msg",
                "timestamp": timestamp,
                "payload": {
                    "type": "token_count",
                    "info": { "total_token_usage": { "input_tokens": input, "output_tokens": input / 10 } }
                }
            })
            .to_string()
                + "\n"
        };
        fs::write(&path, event(stamp(-3), 1_000)).expect("write first chunk");
        let first_size = fs::metadata(&path).expect("metadata").len();
        let first = parse_source_file("codex", &source(&path, first_size, 0), None).expect("first");
        assert!(first.replace_existing);

        {
            use std::io::Write;
            let mut file = fs::OpenOptions::new()
                .append(true)
                .open(&path)
                .expect("open for append");
            file.write_all(event(stamp(-2), 1_500).as_bytes())
                .expect("append");
        }
        let second_size = fs::metadata(&path).expect("metadata").len();
        let state = FileState {
            size: first_size,
            modified: 0,
            offset: first.parsed.offset,
            tail_hash: first.parsed.tail_hash.clone(),
            last_model: None,
            cumulative: first.parsed.cumulative,
        };
        let resumed = parse_source_file("codex", &source(&path, second_size, 0), Some(&state))
            .expect("resume");
        assert!(!resumed.replace_existing, "append-only file must resume");
        let resumed_total: u64 = resumed
            .parsed
            .rows
            .iter()
            .map(|(_, _, counts)| counts.input)
            .sum();
        assert_eq!(resumed_total, 500, "only the delta is added");

        let full = parse_source_file("codex", &source(&path, second_size, 0), None)
            .expect("full")
            .parsed;
        let full_total: u64 = full.rows.iter().map(|(_, _, counts)| counts.input).sum();
        assert_eq!(full_total, 1_500);

        let state = FileState {
            size: second_size,
            modified: 0,
            offset: resumed.parsed.offset,
            tail_hash: "not-the-real-hash".to_string(),
            last_model: None,
            cumulative: resumed.parsed.cumulative,
        };
        let rewritten = parse_source_file("codex", &source(&path, second_size, 0), Some(&state))
            .expect("rewrite");
        assert!(
            rewritten.replace_existing,
            "a changed prefix must fall back to a full reparse"
        );
        let _ = fs::remove_dir_all(root);
    }
}
