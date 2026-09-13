use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use chrono::Utc;
use tauri::{AppHandle, Emitter};

use super::conversation_parser::{
    all_projects_dirs, discover_session_file_in_dirs, ChatRole, ConversationParser,
    IncrementalParseResult, MessageBlock, ParsedMessage,
};
use super::file_watcher::{ConversationUpdatePayload, CONVERSATION_UPDATE_EVENT};
use super::session_store::{SessionPhase, SessionStore};

const ACTIVE_WINDOW_SECS: i64 = 4 * 60 * 60;
const DISCOVERY_INTERVAL: Duration = Duration::from_secs(2);
const TRANSCRIPT_TAIL_BYTES: u64 = 256 * 1024;

/// Last known activity for a Claude Code transcript. `Finished` means the last
/// recorded turn ended; `Active` means a prompt or tool result is still waiting
/// for the assistant. `WaitingApproval`/`WaitingInput` are inferred when the
/// transcript stops on an interactive tool call.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TranscriptActivity {
    Active,
    WaitingApproval,
    WaitingInput,
    Finished,
    Interrupted,
}

#[derive(Debug, Clone)]
struct ClaudeDesktopSessionMetadata {
    local_session_id: String,
    cli_session_id: String,
    cwd: String,
    title: Option<String>,
    is_archived: bool,
    created_at: i64,
    last_activity_at: i64,
}

#[derive(Debug, Clone)]
struct WatchedDesktopSession {
    metadata_path: PathBuf,
    audit_path: PathBuf,
    cli_session_id: String,
    file_size: u64,
    result_scan_offset: u64,
}

#[derive(Default)]
struct WatchState {
    known_local_session_ids: HashSet<String>,
    sessions: HashMap<String, WatchedDesktopSession>,
    parsers: HashMap<String, ConversationParser>,
}

pub fn start(session_store: Arc<SessionStore>, app_handle: AppHandle) {
    tauri::async_runtime::spawn(async move {
        run_loop(session_store, app_handle).await;
    });
}

pub fn find_audit_file_for_cli_session(session_id: &str) -> Option<PathBuf> {
    for root in sessions_roots() {
        for metadata_path in metadata_files(&root) {
            let Some(metadata) = read_metadata(&metadata_path) else {
                continue;
            };
            if metadata.cli_session_id == session_id {
                if let Some(audit_path) = transcript_path_for_metadata(&metadata_path, &metadata) {
                    return Some(audit_path);
                }
            }
        }
    }
    None
}

async fn run_loop(session_store: Arc<SessionStore>, app_handle: AppHandle) {
    let mut state = WatchState::default();
    loop {
        // Re-resolve every tick so roots that appear after Vibe Board starts
        // (or a second Claude install) are picked up without a restart.
        for root in sessions_roots() {
            scan_for_sessions(&root, &mut state, &session_store);
        }
        poll_sessions(&mut state, &session_store, &app_handle);
        tokio::time::sleep(DISCOVERY_INTERVAL).await;
    }
}

fn scan_for_sessions(root: &Path, state: &mut WatchState, session_store: &SessionStore) {
    if !root.is_dir() {
        return;
    }

    for metadata_path in metadata_files(root) {
        let Some(local_session_id) = metadata_path.file_stem().and_then(|value| value.to_str())
        else {
            continue;
        };
        if state.known_local_session_ids.contains(local_session_id) {
            continue;
        }

        let Some(metadata) = read_metadata(&metadata_path) else {
            continue;
        };
        if metadata.is_archived {
            state
                .known_local_session_ids
                .insert(metadata.local_session_id);
            continue;
        }
        // Stale sessions stay eligible for later scans: resuming one keeps the
        // same metadata file and bumps `lastActivityAt`, so permanently
        // remembering the id here would hide the resumed transcript.
        if is_stale(&metadata) {
            continue;
        }

        let Some(audit_path) = transcript_path_for_metadata(&metadata_path, &metadata) else {
            continue;
        };

        register_session(state, session_store, metadata_path, audit_path, metadata);
    }
}

fn register_session(
    state: &mut WatchState,
    session_store: &SessionStore,
    metadata_path: PathBuf,
    audit_path: PathBuf,
    metadata: ClaudeDesktopSessionMetadata,
) {
    let mut parser = ConversationParser::new(audit_path.clone());
    let initial = parser.parse_incremental().ok();
    let file_size = initial
        .as_ref()
        .map(|result| result.byte_offset)
        .unwrap_or_else(|| file_size(&audit_path));
    let project = project_name(&metadata.cwd);

    session_store.get_or_create_session(
        &metadata.cli_session_id,
        "claude-code",
        &project,
        &metadata.cwd,
        "Claude Desktop",
    );
    session_store.update_session(&metadata.cli_session_id, |session| {
        session.engine_label = Some("Claude Desktop".to_string());
        session.term_bundle_id = Some("com.anthropic.claudefordesktop".to_string());
        session.session_title = metadata.title.clone();
        session.started_at = metadata.created_at;
        session.duration = Utc::now().timestamp().saturating_sub(metadata.created_at);
    });

    // A session that is already mid-turn when the watcher starts must be
    // surfaced immediately instead of waiting for the next file append.
    if let Some(activity) = read_transcript_activity(&audit_path) {
        apply_activity(session_store, &metadata.cli_session_id, activity);
    }

    state
        .known_local_session_ids
        .insert(metadata.local_session_id.clone());
    state
        .parsers
        .insert(metadata.local_session_id.clone(), parser);
    state.sessions.insert(
        metadata.local_session_id,
        WatchedDesktopSession {
            metadata_path,
            audit_path,
            cli_session_id: metadata.cli_session_id,
            file_size,
            result_scan_offset: file_size,
        },
    );
}

fn poll_sessions(state: &mut WatchState, session_store: &SessionStore, app_handle: &AppHandle) {
    let keys = state.sessions.keys().cloned().collect::<Vec<_>>();
    let mut finished = Vec::new();

    for local_session_id in keys {
        let Some(session) = state.sessions.get_mut(&local_session_id) else {
            continue;
        };

        if read_metadata(&session.metadata_path).is_some_and(|metadata| metadata.is_archived) {
            session_store.update_session(&session.cli_session_id, |stored| {
                stored.phase = SessionPhase::Done;
                stored.last_response = Some("Claude Desktop session archived".to_string());
            });
            finished.push(local_session_id.clone());
            continue;
        }

        let current_size = file_size(&session.audit_path);
        if current_size == session.file_size {
            continue;
        }

        if current_size < session.file_size {
            if let Some(parser) = state.parsers.get_mut(&local_session_id) {
                parser.reset();
            }
            session.result_scan_offset = 0;
        }

        let completed = scan_for_result_entry(
            &session.audit_path,
            session.result_scan_offset,
            current_size,
        );
        session.result_scan_offset = current_size;

        let parsed = state
            .parsers
            .entry(local_session_id.clone())
            .or_insert_with(|| ConversationParser::new(session.audit_path.clone()))
            .parse_incremental()
            .ok();
        session.file_size = current_size;

        if let Some(result) = parsed {
            apply_parse_result(session_store, &session.cli_session_id, &result);
            emit_conversation_update(app_handle, &session.cli_session_id, result);
        }

        // The transcript tail is authoritative for turn completion: it knows
        // whether the last assistant turn ended while the incremental parser
        // only sees that lines were appended.
        if let Some(activity) = read_transcript_activity(&session.audit_path) {
            apply_activity(session_store, &session.cli_session_id, activity);
        }

        if let Some(result) = completed {
            apply_result_entry(session_store, &session.cli_session_id, result);
        }
    }

    for local_session_id in finished {
        state.sessions.remove(&local_session_id);
        state.parsers.remove(&local_session_id);
    }
}

fn apply_parse_result(
    session_store: &SessionStore,
    session_id: &str,
    result: &IncrementalParseResult,
) {
    if result.clear_detected {
        session_store.update_session(session_id, |session| {
            session.last_response = None;
            session.last_user_message = None;
        });
    }

    if result.new_messages.is_empty() {
        return;
    }

    let latest_user = latest_text_for_role(&result.new_messages, ChatRole::User);
    session_store.update_session(session_id, |session| {
        session.phase = if session.pending_permission.is_some() || session.pending_plan.is_some() {
            SessionPhase::WaitingApproval
        } else if session.pending_question.is_some() {
            SessionPhase::WaitingInput
        } else {
            SessionPhase::Processing
        };
        if let Some(text) = latest_user {
            session.last_user_message = Some(text);
        }
    });
}

fn apply_activity(session_store: &SessionStore, session_id: &str, activity: TranscriptActivity) {
    session_store.update_session(session_id, |session| {
        session.phase = if session.pending_permission.is_some() || session.pending_plan.is_some() {
            SessionPhase::WaitingApproval
        } else if session.pending_question.is_some() {
            SessionPhase::WaitingInput
        } else {
            match activity {
                TranscriptActivity::Active => SessionPhase::Processing,
                TranscriptActivity::WaitingApproval => SessionPhase::WaitingApproval,
                TranscriptActivity::WaitingInput => SessionPhase::WaitingInput,
                TranscriptActivity::Finished => SessionPhase::Done,
                TranscriptActivity::Interrupted => SessionPhase::Interrupted,
            }
        };
    });
}

fn read_transcript_activity(path: &Path) -> Option<TranscriptActivity> {
    let mut file = File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    file.seek(SeekFrom::Start(size.saturating_sub(TRANSCRIPT_TAIL_BYTES)))
        .ok()?;
    let mut data = Vec::new();
    file.read_to_end(&mut data).ok()?;
    let text = String::from_utf8_lossy(&data);

    let mut activity = None;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(json) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if let Some(next) = transcript_activity_for_line(&json) {
            activity = Some(next);
        }
    }
    activity
}

fn transcript_activity_for_line(json: &serde_json::Value) -> Option<TranscriptActivity> {
    match json.get("type").and_then(|value| value.as_str())? {
        "result" => Some(TranscriptActivity::Finished),
        "assistant" => {
            if json
                .get("isSidechain")
                .and_then(|value| value.as_bool())
                .unwrap_or(false)
            {
                return None;
            }
            let message = json.get("message")?;
            if let Some(tool) = interactive_tool_name(message) {
                return Some(if tool == "ExitPlanMode" {
                    TranscriptActivity::WaitingApproval
                } else {
                    TranscriptActivity::WaitingInput
                });
            }
            match message.get("stop_reason").and_then(|value| value.as_str()) {
                Some("end_turn") | Some("max_tokens") | Some("stop_sequence") => {
                    Some(TranscriptActivity::Finished)
                }
                _ => Some(TranscriptActivity::Active),
            }
        }
        "user" => {
            if json
                .get("isSidechain")
                .and_then(|value| value.as_bool())
                .unwrap_or(false)
                || json
                    .get("isMeta")
                    .and_then(|value| value.as_bool())
                    .unwrap_or(false)
            {
                return None;
            }
            let content = json
                .get("message")
                .and_then(|message| message.get("content"));
            if content
                .and_then(|value| value.as_str())
                .is_some_and(|text| text.starts_with("[Request interrupted by user"))
            {
                Some(TranscriptActivity::Interrupted)
            } else {
                Some(TranscriptActivity::Active)
            }
        }
        _ => None,
    }
}

fn interactive_tool_name(message: &serde_json::Value) -> Option<String> {
    let blocks = message.get("content")?.as_array()?;
    blocks.iter().find_map(|block| {
        let block_type = block.get("type").and_then(|value| value.as_str())?;
        if block_type != "tool_use" {
            return None;
        }
        let name = block.get("name").and_then(|value| value.as_str())?;
        matches!(name, "AskUserQuestion" | "ExitPlanMode").then(|| name.to_string())
    })
}

fn emit_conversation_update(
    app_handle: &AppHandle,
    session_id: &str,
    result: IncrementalParseResult,
) {
    if result.new_messages.is_empty() && !result.clear_detected {
        return;
    }

    let payload = ConversationUpdatePayload {
        session_id: session_id.to_string(),
        result,
    };
    if let Err(err) = app_handle.emit(CONVERSATION_UPDATE_EVENT, &payload) {
        log::debug!(
            "Failed to emit Claude Desktop conversation update for {}: {}",
            session_id,
            err
        );
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ResultEntry {
    is_error: bool,
    num_turns: i64,
    result: Option<String>,
}

fn apply_result_entry(session_store: &SessionStore, session_id: &str, result: ResultEntry) {
    session_store.update_session(session_id, |session| {
        session.phase = if result.is_error {
            SessionPhase::Error
        } else {
            SessionPhase::Done
        };
        session.last_response = result
            .result
            .filter(|text| !text.trim().is_empty())
            .or_else(|| {
                Some(format!(
                    "Claude Desktop turn completed ({} turn(s))",
                    result.num_turns
                ))
            });
    });
}

fn latest_text_for_role(messages: &[ParsedMessage], role: ChatRole) -> Option<String> {
    messages.iter().rev().find_map(|message| {
        if message.role != role {
            return None;
        }
        message.blocks.iter().find_map(|block| match block {
            MessageBlock::Text { text } => {
                let trimmed = text.trim();
                (!trimmed.is_empty()).then(|| trimmed.to_string())
            }
            _ => None,
        })
    })
}

fn scan_for_result_entry(path: &Path, from: u64, to: u64) -> Option<ResultEntry> {
    if to <= from {
        return None;
    }

    let mut file = File::open(path).ok()?;
    file.seek(SeekFrom::Start(from)).ok()?;
    let mut data = vec![0; (to - from) as usize];
    file.read_exact(&mut data).ok()?;
    let text = String::from_utf8_lossy(&data);

    for line in text.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line.trim()) else {
            continue;
        };
        if value.get("type").and_then(|value| value.as_str()) != Some("result") {
            continue;
        }
        return Some(ResultEntry {
            is_error: value
                .get("is_error")
                .or_else(|| value.get("isError"))
                .and_then(|value| value.as_bool())
                .unwrap_or(false),
            num_turns: value
                .get("num_turns")
                .or_else(|| value.get("numTurns"))
                .and_then(|value| value.as_i64())
                .unwrap_or(1),
            result: value
                .get("result")
                .or_else(|| value.get("message"))
                .and_then(|value| value.as_str())
                .map(ToString::to_string),
        });
    }

    None
}

/// Claude Desktop stores local-agent metadata under the Electron user-data
/// directory. On macOS that is `~/Library/Application Support/Claude`; on
/// Windows the store build redirects `%APPDATA%\Claude` into the MSIX package
/// `LocalCache\Roaming\Claude`, and recent builds renamed the metadata folder
/// from `local-agent-mode-sessions` to `claude-code-sessions`.
fn sessions_roots() -> Vec<PathBuf> {
    let mut bases = Vec::new();
    if let Some(config_dir) = dirs::config_dir() {
        bases.push(config_dir.join("Claude"));
    }
    if let Some(local_dir) = dirs::data_local_dir() {
        bases.push(local_dir.join("Claude"));
        #[cfg(target_os = "windows")]
        bases.extend(store_claude_dirs_from(&local_dir.join("Packages")));
    }
    roots_from_bases(&bases)
}

fn roots_from_bases(bases: &[PathBuf]) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for base in bases {
        for name in ["local-agent-mode-sessions", "claude-code-sessions"] {
            let candidate = base.join(name);
            if candidate.is_dir() && !roots.contains(&candidate) {
                roots.push(candidate);
            }
        }
    }
    roots
}

#[cfg(target_os = "windows")]
fn store_claude_dirs_from(packages_dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(packages_dir) else {
        return Vec::new();
    };

    entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("Claude_"))
        })
        .map(|path| path.join("LocalCache").join("Roaming").join("Claude"))
        .filter(|path| path.is_dir())
        .collect()
}

fn transcript_path_for_metadata(
    metadata_path: &Path,
    metadata: &ClaudeDesktopSessionMetadata,
) -> Option<PathBuf> {
    transcript_path_for_metadata_in_dirs(metadata_path, metadata, &all_projects_dirs())
}

fn transcript_path_for_metadata_in_dirs(
    metadata_path: &Path,
    metadata: &ClaudeDesktopSessionMetadata,
    projects_dirs: &[PathBuf],
) -> Option<PathBuf> {
    if let Some(audit_path) = audit_path_for_metadata(metadata_path) {
        if audit_path.is_file() {
            return Some(audit_path);
        }
    }

    // The macOS watcher used a per-session `audit.jsonl`. The Windows build
    // keeps the metadata in `claude-code-sessions` but writes the live
    // transcript to the regular Claude Code projects tree.
    discover_session_file_in_dirs(&metadata.cli_session_id, &metadata.cwd, projects_dirs)
}

fn metadata_files(root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let Ok(org_dirs) = fs::read_dir(root) else {
        return files;
    };

    for org_dir in org_dirs
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
    {
        let Ok(user_dirs) = fs::read_dir(org_dir) else {
            continue;
        };
        for user_dir in user_dirs
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.is_dir())
        {
            let Ok(entries) = fs::read_dir(user_dir) else {
                continue;
            };
            for path in entries.flatten().map(|entry| entry.path()) {
                let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                    continue;
                };
                if name.starts_with("local_") && name.ends_with(".json") {
                    files.push(path);
                }
            }
        }
    }

    files
}

fn read_metadata(path: &Path) -> Option<ClaudeDesktopSessionMetadata> {
    let data = fs::read_to_string(path).ok()?;
    parse_metadata_json(&data)
}

fn parse_metadata_json(data: &str) -> Option<ClaudeDesktopSessionMetadata> {
    let json: serde_json::Value = serde_json::from_str(data).ok()?;
    let cli_session_id = json.get("cliSessionId")?.as_str()?.to_string();
    let local_session_id = json.get("sessionId")?.as_str()?.to_string();
    let cwd = json
        .get("cwd")
        .and_then(|value| value.as_str())
        .map(ToString::to_string)
        .or_else(|| dirs::home_dir().map(|path| path.display().to_string()))
        .unwrap_or_default();
    let created_at = millis_to_seconds(json.get("createdAt").and_then(|value| value.as_i64()));
    let last_activity_at = millis_to_seconds(
        json.get("lastActivityAt")
            .and_then(|value| value.as_i64())
            .or_else(|| json.get("createdAt").and_then(|value| value.as_i64())),
    );

    Some(ClaudeDesktopSessionMetadata {
        local_session_id,
        cli_session_id,
        cwd,
        title: json
            .get("title")
            .and_then(|value| value.as_str())
            .map(ToString::to_string),
        is_archived: json
            .get("isArchived")
            .and_then(|value| value.as_bool())
            .unwrap_or(false),
        created_at,
        last_activity_at,
    })
}

fn millis_to_seconds(value: Option<i64>) -> i64 {
    value
        .filter(|value| *value > 0)
        .map(|value| value / 1000)
        .unwrap_or_else(|| Utc::now().timestamp())
}

fn audit_path_for_metadata(metadata_path: &Path) -> Option<PathBuf> {
    let parent = metadata_path.parent()?;
    let stem = metadata_path.file_stem()?;
    Some(parent.join(stem).join("audit.jsonl"))
}

fn file_size(path: &Path) -> u64 {
    fs::metadata(path)
        .map(|metadata| metadata.len())
        .unwrap_or(0)
}

fn project_name(cwd: &str) -> String {
    Path::new(cwd)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("Claude Desktop")
        .to_string()
}

fn is_stale(metadata: &ClaudeDesktopSessionMetadata) -> bool {
    Utc::now()
        .timestamp()
        .saturating_sub(metadata.last_activity_at)
        > ACTIVE_WINDOW_SECS
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_claude_desktop_metadata() {
        let metadata = parse_metadata_json(
            r#"{
              "sessionId": "local_abc",
              "cliSessionId": "cli-123",
              "cwd": "/tmp/agentbro",
              "title": "Ship watcher",
              "isArchived": false,
              "createdAt": 10000,
              "lastActivityAt": 12000
            }"#,
        )
        .expect("metadata");

        assert_eq!(metadata.local_session_id, "local_abc");
        assert_eq!(metadata.cli_session_id, "cli-123");
        assert_eq!(metadata.cwd, "/tmp/agentbro");
        assert_eq!(metadata.title.as_deref(), Some("Ship watcher"));
        assert_eq!(metadata.created_at, 10);
        assert_eq!(metadata.last_activity_at, 12);
    }

    #[test]
    fn scans_result_entry() {
        let path = std::env::temp_dir().join(format!(
            "agentbro-claude-desktop-result-{}.jsonl",
            uuid::Uuid::new_v4()
        ));
        fs::write(
            &path,
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}
{"type":"result","is_error":false,"num_turns":3,"result":"Done"}
"#,
        )
        .expect("write fixture");

        let size = file_size(&path);
        let result = scan_for_result_entry(&path, 0, size).expect("result entry");
        let _ = fs::remove_file(&path);

        assert!(!result.is_error);
        assert_eq!(result.num_turns, 3);
        assert_eq!(result.result.as_deref(), Some("Done"));
    }

    #[test]
    fn metadata_path_resolves_audit_path() {
        let path = PathBuf::from("/tmp/root/org/user/local_abc.json");
        assert_eq!(
            audit_path_for_metadata(&path),
            Some(PathBuf::from("/tmp/root/org/user/local_abc/audit.jsonl"))
        );
    }

    fn temp_watcher_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("vibe-board-claude-{tag}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn metadata_for(cli_session_id: &str, cwd: &str) -> ClaudeDesktopSessionMetadata {
        let now = Utc::now().timestamp();
        ClaudeDesktopSessionMetadata {
            local_session_id: format!("local_{cli_session_id}"),
            cli_session_id: cli_session_id.to_string(),
            cwd: cwd.to_string(),
            title: Some("Fixture".to_string()),
            is_archived: false,
            created_at: now,
            last_activity_at: now,
        }
    }

    fn write_transcript(tag: &str, lines: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "vibe-board-transcript-{tag}-{}.jsonl",
            uuid::Uuid::new_v4()
        ));
        fs::write(&path, lines).expect("write transcript fixture");
        path
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn discovers_store_package_claude_data_dir() {
        let root = temp_watcher_dir("store");
        let packages = root.join("Packages");
        let package = packages
            .join("Claude_pzs8sxrjxfjjc")
            .join("LocalCache")
            .join("Roaming")
            .join("Claude");
        fs::create_dir_all(&package).expect("create package claude dir");
        fs::create_dir_all(packages.join("OtherApp").join("LocalCache"))
            .expect("create other package");

        let dirs = store_claude_dirs_from(&packages);

        assert_eq!(dirs, vec![package]);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn discovers_both_session_folder_names_per_base() {
        let root = temp_watcher_dir("roots");
        let app_base = root.join("Claude");
        fs::create_dir_all(app_base.join("claude-code-sessions")).expect("create app root");
        fs::create_dir_all(app_base.join("local-agent-mode-sessions")).expect("create app root");
        let package_base = root
            .join("Packages")
            .join("Claude_abc")
            .join("LocalCache")
            .join("Roaming")
            .join("Claude");
        fs::create_dir_all(package_base.join("claude-code-sessions")).expect("create package root");

        let roots = roots_from_bases(&[app_base.clone(), package_base.clone()]);

        assert!(roots.contains(&app_base.join("local-agent-mode-sessions")));
        assert!(roots.contains(&app_base.join("claude-code-sessions")));
        assert!(roots.contains(&package_base.join("claude-code-sessions")));
        assert!(!roots.contains(&package_base.join("local-agent-mode-sessions")));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn metadata_transcript_prefers_sibling_audit() {
        let root = temp_watcher_dir("audit");
        let metadata_path = root.join("local_abc.json");
        let audit_dir = root.join("local_abc");
        fs::create_dir_all(&audit_dir).expect("create audit dir");
        let audit = audit_dir.join("audit.jsonl");
        fs::write(&audit, "").expect("write audit fixture");

        let resolved = transcript_path_for_metadata_in_dirs(
            &metadata_path,
            &metadata_for("cli-123", "/tmp/project"),
            &[],
        );

        assert_eq!(resolved, Some(audit));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn metadata_transcript_falls_back_to_projects_tree() {
        let root = temp_watcher_dir("transcript");
        let projects = root.join("projects");
        let project_dir = projects.join("D--Sample-Warehouse");
        fs::create_dir_all(&project_dir).expect("create project dir");
        let transcript = project_dir.join("cli-123.jsonl");
        fs::write(&transcript, "{}").expect("write transcript fixture");
        let metadata_path = root
            .join("claude-code-sessions")
            .join("org")
            .join("user")
            .join("local_cli-123.json");

        let resolved = transcript_path_for_metadata_in_dirs(
            &metadata_path,
            &metadata_for("cli-123", "D:\\Sample\\Warehouse"),
            &[projects],
        );

        assert_eq!(resolved, Some(transcript));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn transcript_activity_tracks_turn_lifecycle() {
        let finished = write_transcript(
            "finished",
            r#"{"type":"user","message":{"role":"user","content":"do it"}}
{"type":"assistant","message":{"role":"assistant","stop_reason":"end_turn","content":[{"type":"text","text":"done"}]}}
"#,
        );
        let active = write_transcript(
            "active",
            r#"{"type":"user","message":{"role":"user","content":"do it"}}
{"type":"assistant","message":{"role":"assistant","stop_reason":"tool_use","content":[{"type":"tool_use","name":"Bash","id":"1","input":{}}]}}
"#,
        );
        let plan = write_transcript(
            "plan",
            r#"{"type":"assistant","message":{"role":"assistant","stop_reason":"tool_use","content":[{"type":"tool_use","name":"ExitPlanMode","id":"2","input":{}}]}}
"#,
        );
        let question = write_transcript(
            "question",
            r#"{"type":"assistant","message":{"role":"assistant","stop_reason":"tool_use","content":[{"type":"tool_use","name":"AskUserQuestion","id":"3","input":{}}]}}
"#,
        );

        assert_eq!(
            read_transcript_activity(&finished),
            Some(TranscriptActivity::Finished)
        );
        assert_eq!(
            read_transcript_activity(&active),
            Some(TranscriptActivity::Active)
        );
        assert_eq!(
            read_transcript_activity(&plan),
            Some(TranscriptActivity::WaitingApproval)
        );
        assert_eq!(
            read_transcript_activity(&question),
            Some(TranscriptActivity::WaitingInput)
        );

        let _ = fs::remove_file(finished);
        let _ = fs::remove_file(active);
        let _ = fs::remove_file(plan);
        let _ = fs::remove_file(question);
    }

    #[test]
    fn transcript_activity_ignores_subagent_lines() {
        let path = write_transcript(
            "sidechain",
            r#"{"type":"user","message":{"role":"user","content":"main prompt"}}
{"type":"assistant","isSidechain":true,"message":{"role":"assistant","stop_reason":"end_turn","content":[]}}
"#,
        );

        assert_eq!(
            read_transcript_activity(&path),
            Some(TranscriptActivity::Active)
        );

        let _ = fs::remove_file(path);
    }

    #[test]
    fn register_session_marks_existing_active_turn_processing() {
        let store = SessionStore::new();
        let root = temp_watcher_dir("register");
        let metadata_path = root.join("local_cli-123.json");
        let transcript_dir = root.join("local_cli-123");
        fs::create_dir_all(&transcript_dir).expect("create transcript dir");
        let transcript = transcript_dir.join("audit.jsonl");
        fs::write(
            &transcript,
            r#"{"type":"user","message":{"role":"user","content":"do it"}}
{"type":"assistant","message":{"role":"assistant","stop_reason":"tool_use","content":[{"type":"tool_use","name":"Bash","id":"1","input":{}}]}}
"#,
        )
        .expect("write transcript fixture");

        let mut state = WatchState::default();
        register_session(
            &mut state,
            &store,
            metadata_path,
            transcript,
            metadata_for("cli-123", "/tmp/project"),
        );

        let session = store.get_session("cli-123").expect("session");
        assert_eq!(session.phase, SessionPhase::Processing);
        assert_eq!(session.engine_label.as_deref(), Some("Claude Desktop"));

        let _ = fs::remove_dir_all(root);
    }

    fn write_metadata_fixture(path: &Path, last_activity_at: i64) {
        fs::write(
            path,
            serde_json::json!({
                "sessionId": "local_cli-123",
                "cliSessionId": "cli-123",
                "cwd": "/tmp/project",
                "title": "Fixture",
                "isArchived": false,
                "createdAt": (last_activity_at - 60) * 1000,
                "lastActivityAt": last_activity_at * 1000,
            })
            .to_string(),
        )
        .expect("write metadata fixture");
    }

    #[test]
    fn stale_session_is_rediscovered_after_resume() {
        let store = SessionStore::new();
        let root = temp_watcher_dir("resume");
        let user_dir = root.join("org").join("user");
        fs::create_dir_all(&user_dir).expect("create metadata dir");
        let metadata_path = user_dir.join("local_cli-123.json");
        let transcript_dir = user_dir.join("local_cli-123");
        fs::create_dir_all(&transcript_dir).expect("create transcript dir");
        fs::write(
            transcript_dir.join("audit.jsonl"),
            r#"{"type":"user","message":{"role":"user","content":"do it"}}
"#,
        )
        .expect("write transcript fixture");

        write_metadata_fixture(
            &metadata_path,
            Utc::now().timestamp() - ACTIVE_WINDOW_SECS - 60,
        );

        let mut state = WatchState::default();
        scan_for_sessions(&root, &mut state, &store);
        assert!(store.get_session("cli-123").is_none());
        assert!(state.sessions.is_empty());

        write_metadata_fixture(&metadata_path, Utc::now().timestamp());
        scan_for_sessions(&root, &mut state, &store);

        let session = store.get_session("cli-123").expect("resumed session");
        assert_eq!(session.engine_label.as_deref(), Some("Claude Desktop"));
        assert_eq!(state.sessions.len(), 1);

        let _ = fs::remove_dir_all(root);
    }
}
