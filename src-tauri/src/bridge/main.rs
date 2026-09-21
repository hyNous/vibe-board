#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Vibe Board Hook Bridge
//!
//! A lightweight compiled binary that Claude Code hooks call.
//! Reads JSON from stdin, forwards events to Vibe Board via Unix socket or TCP,
//! then exits. The bridge never waits for a response and never writes a
//! permission decision to stdout.

use std::fs::OpenOptions;
use std::io::{self, Read, Write};
use std::net::TcpStream;
#[cfg(unix)]
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::Stdio;
use std::thread;
use std::time::Duration;

/// Polymorphic stream: Unix socket or TCP
enum Stream {
    #[cfg(unix)]
    Unix(UnixStream),
    Tcp(TcpStream),
}

impl Write for Stream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match self {
            #[cfg(unix)]
            Stream::Unix(s) => s.write(buf),
            Stream::Tcp(s) => s.write(buf),
        }
    }
    fn flush(&mut self) -> io::Result<()> {
        match self {
            #[cfg(unix)]
            Stream::Unix(s) => s.flush(),
            Stream::Tcp(s) => s.flush(),
        }
    }
}

fn normalize_tty(raw: &str) -> Option<String> {
    let tty = raw.trim();
    if tty.is_empty() || tty == "??" || tty == "?" || tty == "-" {
        return None;
    }
    Some(if tty.starts_with("/dev/") {
        tty.to_string()
    } else {
        format!("/dev/{}", tty)
    })
}

fn is_antigravity_source(source: &str) -> bool {
    source == "antigravity"
}

fn antigravity_hook_output(event: &str) -> serde_json::Value {
    if event == "Stop" {
        serde_json::json!({ "decision": "stop" })
    } else {
        serde_json::json!({})
    }
}

#[cfg(unix)]
fn ps_tty_and_ppid(pid: u32) -> Option<(Option<String>, Option<u32>)> {
    if let Ok(output) = std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "tty=,ppid="])
        .output()
    {
        let output = String::from_utf8_lossy(&output.stdout);
        let mut parts = output.split_whitespace();
        let tty = parts.next().and_then(normalize_tty);
        let ppid = parts.next().and_then(|value| value.parse::<u32>().ok());
        if tty.is_some() || ppid.is_some() {
            return Some((tty, ppid));
        }
    }
    None
}

#[cfg(not(unix))]
fn ps_tty_and_ppid(_pid: u32) -> Option<(Option<String>, Option<u32>)> {
    None
}

/// Get the TTY of the invoking agent process.
fn get_tty() -> Option<String> {
    let mut pid = std::process::id();
    for _ in 0..8 {
        let Some((tty, ppid)) = ps_tty_and_ppid(pid) else {
            break;
        };
        if tty.is_some() {
            return tty;
        }
        let Some(parent) = ppid else {
            break;
        };
        if parent <= 1 || parent == pid {
            break;
        }
        pid = parent;
    }

    if let Ok(tty) = std::env::var("TTY") {
        if let Some(normalized) = normalize_tty(&tty) {
            return Some(normalized);
        }
    }

    None
}

fn parent_process_id() -> u32 {
    #[cfg(unix)]
    {
        std::os::unix::process::parent_id()
    }
    #[cfg(all(not(unix), target_os = "windows"))]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
        use windows_sys::Win32::System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        };

        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snapshot == INVALID_HANDLE_VALUE {
                return 0;
            }

            let current_pid = std::process::id();
            let mut entry = PROCESSENTRY32W::default();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            let mut parent_pid = 0;

            if Process32FirstW(snapshot, &mut entry) != 0 {
                loop {
                    if entry.th32ProcessID == current_pid {
                        parent_pid = entry.th32ParentProcessID;
                        break;
                    }
                    if Process32NextW(snapshot, &mut entry) == 0 {
                        break;
                    }
                }
            }

            let _ = CloseHandle(snapshot);
            parent_pid
        }
    }
    #[cfg(all(not(unix), not(target_os = "windows")))]
    {
        0
    }
}

/// Connect to Vibe Board: try Unix socket first, fall back to TCP
fn connect() -> Option<Stream> {
    let endpoint = vibe_board_lib::hook_endpoint::current();
    #[cfg(unix)]
    {
        if let Ok(s) = UnixStream::connect(&endpoint.socket_path) {
            return Some(Stream::Unix(s));
        }
        for legacy_socket in vibe_board_lib::hook_endpoint::legacy_socket_paths() {
            if let Ok(s) = UnixStream::connect(legacy_socket) {
                return Some(Stream::Unix(s));
            }
        }
    }
    if let Ok(s) = TcpStream::connect(endpoint.tcp_addr()) {
        return Some(Stream::Tcp(s));
    }
    None
}

/// Start Vibe Board on the first session of an Agent whose per-Agent launch
/// switch is enabled. The executable marker is written by the app itself, so
/// no credentials or machine-specific paths need to be embedded.
fn ensure_agent_island_running() {
    for _ in 0..3 {
        if connect().is_some() {
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }

    let Some(raw_path) = vibe_board_lib::data_dir::read_executable_marker() else {
        return;
    };
    let executable = PathBuf::from(raw_path.trim());
    if !executable.is_file() {
        return;
    }

    let mut command = vibe_board_lib::platform::process::background_command(&executable);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if command.spawn().is_err() {
        return;
    }

    // Give the Tauri process a short head start so the triggering SessionStart
    // event can still be forwarded. Later hooks naturally retry through their
    // normal lifecycle.
    for _ in 0..20 {
        if connect().is_some() {
            return;
        }
        thread::sleep(Duration::from_millis(100));
    }
}

/// Whether `source`'s SessionStart should start Vibe Board under `config`.
fn agent_should_launch_board(
    config: &vibe_board_lib::config::AppConfig,
    source: &str,
    event: &str,
) -> bool {
    if event != "SessionStart" {
        return false;
    }
    let source = source.trim();
    config
        .auto_launch_agents
        .iter()
        .any(|agent| agent.eq_ignore_ascii_case(source))
}

/// Honor the per-Agent "start Vibe Board on session start" switches. The
/// launcher is injected so tests can substitute a stub for the real spawn.
fn maybe_start_configured_agent(
    config: &vibe_board_lib::config::AppConfig,
    source: &str,
    event: &str,
    start: impl FnOnce(),
) {
    if agent_should_launch_board(config, source, event) {
        start();
    }
}

/// Forward one event to Vibe Board and return immediately. The board never
/// sends anything back, so the connection is closed right after the write.
fn forward_event(state: &serde_json::Value) {
    let Some(mut stream) = connect() else {
        record_invocation(state, false);
        return;
    };
    let payload = format!("{}\n", state);
    if stream.write_all(payload.as_bytes()).is_err() {
        record_invocation(state, false);
        return;
    }
    let _ = stream.flush();
    record_invocation(state, true);
}

fn invocation_log_path() -> PathBuf {
    let new_path = vibe_board_lib::data_dir::vibeboard_home()
        .join("hooks")
        .join("invocations.jsonl");
    if !new_path.exists() {
        for legacy_root in vibe_board_lib::data_dir::legacy_homes() {
            for old_path in [
                legacy_root.join("hooks").join("invocations.jsonl"),
                legacy_root.join("hook-invocations.jsonl"),
            ] {
                let _ = vibe_board_lib::data_dir::migrate_file(&old_path, &new_path);
                if new_path.exists() {
                    return new_path;
                }
            }
        }
    }
    new_path
}

fn invocation_log_line(state: &serde_json::Value, forwarded: bool) -> String {
    let source = state
        .get("agent")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let event = state
        .get("event")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let session_id = state
        .get("session_id")
        .and_then(|value| value.as_str())
        .unwrap_or("");

    serde_json::json!({
        "ts": chrono::Utc::now().timestamp_millis(),
        "source": source,
        "event": event,
        "session_id": session_id,
        "forwarded": forwarded,
    })
    .to_string()
}

fn record_invocation(state: &serde_json::Value, forwarded: bool) {
    let path = invocation_log_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{}", invocation_log_line(state, forwarded));
    }
}

fn copy_optional_field(
    obj: &mut serde_json::Map<String, serde_json::Value>,
    data: &serde_json::Value,
    target_key: &str,
    source_keys: &[&str],
) {
    if let Some(value) = source_keys.iter().find_map(|key| data.get(key)) {
        obj.insert(target_key.into(), value.clone());
    }
}

fn copy_agent_trace_context(obj: &mut serde_json::Map<String, serde_json::Value>) {
    for (env_key, json_key) in [
        ("AGENT_TRACE_ID", "agent_trace_id"),
        ("AGENT_TASK_ID", "agent_task_id"),
        ("AGENT_PARENT_RUN_ID", "agent_parent_run_id"),
        ("AGENT_RUN_ID", "agent_run_id"),
        ("AGENT_ROLE", "agent_role"),
        ("AGENT_PROJECT", "agent_project"),
    ] {
        if let Ok(value) = std::env::var(env_key) {
            if !value.trim().is_empty() {
                obj.insert(json_key.into(), value.into());
            }
        }
    }
}

fn tool_response_error(response: &serde_json::Value) -> Option<String> {
    let failed = response
        .get("exit_code")
        .or_else(|| response.get("exitCode"))
        .and_then(|value| value.as_i64())
        .is_some_and(|code| code != 0)
        || response
            .get("isError")
            .and_then(|value| value.as_bool())
            .unwrap_or(false)
        || response
            .get("status")
            .and_then(|value| value.as_str())
            .is_some_and(|status| matches!(status, "error" | "failed" | "failure"))
        || response.get("error").is_some();

    if !failed {
        return None;
    }

    response
        .get("stderr")
        .or_else(|| response.get("error"))
        .or_else(|| response.get("message"))
        .or_else(|| response.get("stdout"))
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(500).collect::<String>())
        .or_else(|| {
            response
                .get("exit_code")
                .or_else(|| response.get("exitCode"))
                .and_then(|value| value.as_i64())
                .map(|code| format!("Tool exited with status {code}"))
        })
        .or_else(|| Some("Tool result reported an error".to_string()))
}

fn arg_value(flag: &str) -> Option<String> {
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == flag {
            return args.next();
        }
    }
    None
}

fn string_field<'a>(data: &'a serde_json::Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| data.get(key).and_then(|value| value.as_str()))
}

fn string_field_with_payload<'a>(
    data: &'a serde_json::Value,
    payload: Option<&'a serde_json::Value>,
    keys: &[&str],
) -> Option<&'a str> {
    string_field(data, keys).or_else(|| payload.and_then(|value| string_field(value, keys)))
}

fn value_field_with_payload<'a>(
    data: &'a serde_json::Value,
    payload: Option<&'a serde_json::Value>,
    keys: &[&str],
) -> Option<&'a serde_json::Value> {
    keys.iter()
        .find_map(|key| data.get(key))
        .or_else(|| payload.and_then(|value| keys.iter().find_map(|key| value.get(key))))
}

fn first_string_array_field<'a>(data: &'a serde_json::Value, key: &str) -> Option<&'a str> {
    data.get(key)
        .and_then(|value| value.as_array())
        .and_then(|values| values.iter().find_map(|value| value.as_str()))
}

fn cline_payload_key(event: &str) -> Option<&'static str> {
    match event {
        "UserPromptSubmit" => Some("userPromptSubmit"),
        "PreToolUse" => Some("preToolUse"),
        "PostToolUse" => Some("postToolUse"),
        "TaskStart" => Some("taskStart"),
        "TaskResume" => Some("taskResume"),
        "TaskCancel" => Some("taskCancel"),
        "TaskComplete" => Some("taskComplete"),
        "PreCompact" => Some("preCompact"),
        _ => None,
    }
}

fn cline_event_payload<'a>(
    source: &str,
    event: &str,
    data: &'a serde_json::Value,
) -> Option<&'a serde_json::Value> {
    if source != "cline" {
        return None;
    }
    cline_payload_key(event).and_then(|key| data.get(key))
}

fn normalize_hook_event(event: &str) -> &str {
    match event {
        "session_start" => "SessionStart",
        "sessionStart" => "SessionStart",
        "session_end" => "SessionEnd",
        "sessionEnd" => "SessionEnd",
        "user_prompt_submit" => "UserPromptSubmit",
        "userPromptSubmit" | "userPromptSubmitted" => "UserPromptSubmit",
        "pre_tool_use" => "PreToolUse",
        "preToolUse" | "BeforeTool" => "PreToolUse",
        "post_tool_use" => "PostToolUse",
        "postToolUse" | "AfterTool" => "PostToolUse",
        "post_tool_use_failure" => "PostToolUseFailure",
        "postToolUseFailure" | "errorOccurred" => "PostToolUseFailure",
        "permission_request" => "PermissionRequest",
        "permissionRequest" => "PermissionRequest",
        "permission_result" => "PermissionResult",
        "permissionResult" => "PermissionResult",
        "permission_denied" => "PermissionDenied",
        "permissionDenied" => "PermissionDenied",
        "notification" => "Notification",
        "stop" => "Stop",
        "agentStop" => "Stop",
        "ErrorOccurred" => "PostToolUseFailure",
        "pre_compact" => "PreCompact",
        "preCompact" => "PreCompact",
        "post_compact" => "PostCompact",
        "postCompact" => "PostCompact",
        "subagent_start" => "SubagentStart",
        "subagentStart" => "SubagentStart",
        "subagent_stop" => "SubagentStop",
        "subagentStop" => "SubagentStop",
        "agentSpawn" => "SessionStart",
        "stop_failure" => "StopFailure",
        "interrupt" => "Interrupt",
        other => other,
    }
}

fn hook_input_data(input: &str, forced_event: Option<&str>) -> Option<serde_json::Value> {
    match serde_json::from_str(input) {
        Ok(value) => Some(value),
        Err(_) if forced_event.is_some() => Some(serde_json::json!({})),
        Err(_) => None,
    }
}

fn main() {
    let source = arg_value("--source")
        .or_else(|| std::env::var("AGENTBRO_AGENT").ok())
        .unwrap_or_else(|| "claude-code".to_string());
    let forced_event = arg_value("--event");

    // Read all stdin
    let mut input = String::new();
    if io::stdin().read_to_string(&mut input).is_err() {
        return;
    }

    let Some(data) = hook_input_data(&input, forced_event.as_deref()) else {
        return;
    };

    let session_id = string_field(
        &data,
        &[
            "session_id",
            "sessionId",
            "conversationId",
            "task_id",
            "taskId",
            "id",
        ],
    )
    .unwrap_or("unknown");
    let hook_event = forced_event
        .as_deref()
        .or_else(|| string_field(&data, &["hook_event_name", "event", "hookType"]))
        .map(normalize_hook_event)
        .unwrap_or("");
    if hook_event == "SessionStart" {
        let config = vibe_board_lib::config::ConfigStore::new().get();
        maybe_start_configured_agent(&config, &source, hook_event, ensure_agent_island_running);
    }
    let event_payload = cline_event_payload(&source, hook_event, &data);
    let cwd = string_field(&data, &["cwd"])
        .or_else(|| first_string_array_field(&data, "workspaceRoots"))
        .or_else(|| first_string_array_field(&data, "workspacePaths"))
        .unwrap_or("");
    let tool_call = data.get("toolCall");
    let tool_input = data
        .get("tool_input")
        .or_else(|| data.get("toolInput"))
        .or_else(|| data.get("toolArgs"))
        .or_else(|| data.get("arguments"))
        .or_else(|| data.get("args"))
        .or_else(|| event_payload.and_then(|payload| payload.get("parameters")))
        .or_else(|| event_payload.and_then(|payload| payload.get("toolArgs")))
        .or_else(|| event_payload.and_then(|payload| payload.get("input")))
        .or_else(|| event_payload.and_then(|payload| payload.get("arguments")))
        .or_else(|| event_payload.and_then(|payload| payload.get("args")))
        .or_else(|| tool_call.and_then(|call| call.get("args")))
        .cloned()
        .unwrap_or(serde_json::json!({}));
    let tool_name = string_field_with_payload(
        &data,
        event_payload,
        &["tool_name", "toolName", "tool", "name"],
    )
    .or_else(|| {
        tool_call
            .and_then(|call| call.get("name"))
            .and_then(|value| value.as_str())
    })
    .unwrap_or("");
    let claude_pid = parent_process_id();
    let tty = get_tty();
    let engine_label =
        arg_value("--engine-label").or_else(|| std::env::var("AGENTBRO_ENGINE_LABEL").ok());
    let engine_config_root =
        arg_value("--config-root").or_else(|| std::env::var("AGENTBRO_CONFIG_ROOT").ok());
    let term_program = std::env::var("TERM_PROGRAM").ok();
    let term_bundle_id = std::env::var("__CFBundleIdentifier").ok();
    let wezterm_pane = std::env::var("WEZTERM_PANE").ok();
    let zellij = std::env::var("ZELLIJ").ok();
    let zellij_pane_id = std::env::var("ZELLIJ_PANE_ID").ok();
    let zellij_session_name = std::env::var("ZELLIJ_SESSION_NAME").ok();
    let cmux_surface_id = std::env::var("CMUX_SURFACE_ID").ok();
    let cmux_workspace_id = std::env::var("CMUX_WORKSPACE_ID").ok();

    // Build event state matching what the Python script produced
    let mut state = serde_json::json!({
        "agent": source,
        "session_id": session_id,
        "cwd": cwd,
        "event": hook_event,
        "pid": claude_pid,
        "tty": tty,
    });

    let obj = state.as_object_mut().unwrap();
    copy_agent_trace_context(obj);
    if let Some(label) = engine_label {
        obj.insert("engine_label".into(), label.into());
    }
    if let Some(root) = engine_config_root {
        obj.insert("engine_config_root".into(), root.into());
    }
    if let Some(program) = term_program {
        obj.insert("_term_program".into(), program.into());
    }
    if let Some(bundle_id) = term_bundle_id {
        obj.insert("_term_bundle_id".into(), bundle_id.into());
    }
    if let Some(pane) = wezterm_pane {
        obj.insert("_wezterm_pane".into(), pane.into());
    }
    if let Some(value) = zellij {
        obj.insert("_zellij".into(), value.into());
    }
    if let Some(pane_id) = zellij_pane_id {
        obj.insert("_zellij_pane_id".into(), pane_id.into());
    }
    if let Some(session_name) = zellij_session_name {
        obj.insert("_zellij_session_name".into(), session_name.into());
    }
    if let Some(surface_id) = cmux_surface_id {
        obj.insert("_cmux_surface_id".into(), surface_id.into());
    }
    if let Some(workspace_id) = cmux_workspace_id {
        obj.insert("_cmux_workspace_id".into(), workspace_id.into());
    }
    if let Some(transcript_path) = data
        .get("transcript_path")
        .or_else(|| data.get("transcriptPath"))
    {
        obj.insert("transcript_path".into(), transcript_path.clone());
    }
    copy_optional_field(obj, &data, "model", &["model"]);
    copy_optional_field(obj, &data, "turn_id", &["turn_id", "turnId"]);
    copy_optional_field(
        obj,
        &data,
        "permission_mode",
        &["permission_mode", "permissionMode"],
    );
    copy_optional_field(obj, &data, "start_source", &["source"]);
    copy_optional_field(
        obj,
        &data,
        "artifact_directory_path",
        &["artifactDirectoryPath"],
    );
    copy_optional_field(obj, &data, "step_idx", &["stepIdx"]);
    copy_optional_field(obj, &data, "invocation_num", &["invocationNum"]);
    copy_optional_field(obj, &data, "initial_num_steps", &["initialNumSteps"]);
    copy_optional_field(obj, &data, "execution_num", &["executionNum"]);
    copy_optional_field(obj, &data, "termination_reason", &["terminationReason"]);
    copy_optional_field(obj, &data, "fully_idle", &["fullyIdle"]);
    copy_optional_field(obj, &data, "error", &["error"]);
    if is_antigravity_source(&source) {
        if let Some(step_idx) = data.get("stepIdx").and_then(|value| value.as_u64()) {
            obj.insert(
                "tool_use_id".into(),
                format!("antigravity-step-{step_idx}").into(),
            );
        }
    }

    if data.get("rate_limits").is_some() || data.get("context_window").is_some() {
        obj.insert("event".into(), "StatusLineUpdate".into());
        obj.insert("status".into(), "processing".into());

        if let Some(rl) = data.get("rate_limits") {
            obj.insert(
                "rateLimits".into(),
                serde_json::json!({
                    "fiveHour": {
                        "usedPercentage": rl
                            .get("five_hour")
                            .and_then(|v| v.get("used_percentage"))
                            .cloned()
                            .unwrap_or(serde_json::json!(0)),
                        "resetsAt": rl
                            .get("five_hour")
                            .and_then(|v| v.get("resets_at"))
                            .cloned()
                            .unwrap_or(serde_json::json!(0))
                    },
                    "sevenDay": {
                        "usedPercentage": rl
                            .get("seven_day")
                            .and_then(|v| v.get("used_percentage"))
                            .cloned()
                            .unwrap_or(serde_json::json!(0)),
                        "resetsAt": rl
                            .get("seven_day")
                            .and_then(|v| v.get("resets_at"))
                            .cloned()
                            .unwrap_or(serde_json::json!(0))
                    }
                }),
            );
        }
        if let Some(cw) = data.get("context_window") {
            obj.insert(
                "contextWindow".into(),
                serde_json::json!({
                    "totalInputTokens": cw
                        .get("total_input_tokens")
                        .cloned()
                        .unwrap_or(serde_json::json!(0)),
                    "totalOutputTokens": cw
                        .get("total_output_tokens")
                        .cloned()
                        .unwrap_or(serde_json::json!(0)),
                    "contextWindowSize": cw
                        .get("context_window_size")
                        .cloned()
                        .unwrap_or(serde_json::json!(0)),
                    "usedPercentage": cw.get("used_percentage").cloned().unwrap_or(serde_json::Value::Null)
                }),
            );
        }
        if let Some(text) = data
            .get("status_line_text")
            .or_else(|| data.get("statusLineText"))
        {
            obj.insert("statusLineText".into(), text.clone());
        }
        forward_event(&state);
        return;
    }

    match hook_event {
        "UserPromptSubmit" => {
            obj.insert("status".into(), "processing".into());
            // Forward user prompt text for session title extraction
            if let Some(prompt) = value_field_with_payload(
                &data,
                event_payload,
                &["user_prompt", "userPrompt", "prompt", "message"],
            ) {
                obj.insert("prompt".into(), prompt.clone());
            }
        }
        "PreToolUse" => {
            obj.insert("status".into(), "running_tool".into());
            if !tool_name.is_empty() {
                obj.insert("tool".into(), tool_name.into());
            } else if let Some(t) = data.get("tool_name").or_else(|| data.get("tool")) {
                obj.insert("tool".into(), t.clone());
            }
            obj.insert("tool_input".into(), tool_input);
            if let Some(id) = data
                .get("tool_use_id")
                .or_else(|| data.get("toolUseId"))
                .or_else(|| data.get("tool_call_id"))
            {
                obj.insert("tool_use_id".into(), id.clone());
            }
        }
        "PostToolUse" => {
            obj.insert("status".into(), "processing".into());
            if !tool_name.is_empty() {
                obj.insert("tool".into(), tool_name.into());
            } else if let Some(t) = data.get("tool_name").or_else(|| data.get("tool")) {
                obj.insert("tool".into(), t.clone());
            }
            obj.insert("tool_input".into(), tool_input);
            if let Some(id) = data
                .get("tool_use_id")
                .or_else(|| data.get("toolUseId"))
                .or_else(|| data.get("tool_call_id"))
            {
                obj.insert("tool_use_id".into(), id.clone());
            }
            if let Some(response) = value_field_with_payload(
                &data,
                event_payload,
                &[
                    "tool_response",
                    "toolResponse",
                    "tool_result",
                    "toolResult",
                    "toolResultPreview",
                    "result",
                ],
            ) {
                obj.insert("tool_response".into(), response.clone());
                if let Some(error) = tool_response_error(response) {
                    obj.insert("tool_error".into(), error.into());
                }
            }
            if event_payload
                .and_then(|payload| payload.get("success"))
                .and_then(|value| value.as_bool())
                .is_some_and(|success| !success)
            {
                obj.insert("tool_error".into(), "Tool reported failure".into());
            }
        }
        "PostToolUseFailure" => {
            obj.insert("status".into(), "processing".into());
            if !tool_name.is_empty() {
                obj.insert("tool".into(), tool_name.into());
            } else if let Some(t) = data.get("tool_name").or_else(|| data.get("tool")) {
                obj.insert("tool".into(), t.clone());
            }
            obj.insert("tool_input".into(), tool_input);
            if let Some(e) =
                value_field_with_payload(&data, event_payload, &["error", "message", "result"])
            {
                obj.insert("tool_error".into(), e.clone());
            }
            if let Some(id) = data
                .get("tool_use_id")
                .or_else(|| data.get("toolUseId"))
                .or_else(|| data.get("tool_call_id"))
            {
                obj.insert("tool_use_id".into(), id.clone());
            }
        }
        "PermissionDenied" => {
            obj.insert("status".into(), "processing".into());
            if !tool_name.is_empty() {
                obj.insert("tool".into(), tool_name.into());
            } else if let Some(t) = data.get("tool_name").or_else(|| data.get("tool")) {
                obj.insert("tool".into(), t.clone());
            }
            obj.insert("tool_input".into(), tool_input);
            if let Some(r) = data.get("reason").or_else(|| data.get("message")) {
                obj.insert("denial_reason".into(), r.clone());
            }
        }
        "PermissionRequest" => {
            obj.insert("status".into(), "processing".into());
            if !tool_name.is_empty() {
                obj.insert("tool".into(), tool_name.into());
            }
            obj.insert("tool_input".into(), tool_input);
            copy_optional_field(
                obj,
                &data,
                "tool_use_id",
                &["tool_call_id", "tool_use_id", "toolUseId"],
            );
            copy_optional_field(obj, &data, "action", &["action"]);
            copy_optional_field(obj, &data, "display", &["display"]);
        }
        "PermissionResult" => {
            obj.insert("status".into(), "processing".into());
            if !tool_name.is_empty() {
                obj.insert("tool".into(), tool_name.into());
            }
            obj.insert("tool_input".into(), tool_input);
            copy_optional_field(
                obj,
                &data,
                "tool_use_id",
                &["tool_call_id", "tool_use_id", "toolUseId"],
            );
            copy_optional_field(obj, &data, "decision", &["decision", "permission_decision"]);
            copy_optional_field(obj, &data, "selected_label", &["selected_label"]);
            copy_optional_field(obj, &data, "action", &["action"]);
        }
        "Notification" => {
            let notification_type = data["notification_type"].as_str().unwrap_or("");
            if notification_type == "permission_prompt" {
                return;
            } else if notification_type == "idle_prompt" {
                obj.insert("status".into(), "waiting_for_input".into());
            } else {
                obj.insert("status".into(), "notification".into());
            }
            obj.insert("notification_type".into(), notification_type.into());
            if let Some(msg) = data.get("message") {
                obj.insert("message".into(), msg.clone());
            }
            copy_optional_field(obj, &data, "title", &["title"]);
            copy_optional_field(obj, &data, "body", &["body", "message"]);
            copy_optional_field(obj, &data, "severity", &["severity"]);
            copy_optional_field(obj, &data, "source_kind", &["source_kind"]);
            copy_optional_field(obj, &data, "source_id", &["source_id"]);
        }
        "Stop" => {
            obj.insert("status".into(), "waiting_for_input".into());
            copy_optional_field(
                obj,
                &data,
                "summary",
                &[
                    "last_assistant_message",
                    "lastAssistantMessage",
                    "summary",
                    "responseText",
                    "responsePreview",
                    "message",
                    "result",
                ],
            );
        }
        "TaskComplete" => {
            obj.insert("status".into(), "waiting_for_input".into());
            if let Some(summary) = value_field_with_payload(
                &data,
                event_payload,
                &[
                    "last_assistant_message",
                    "lastAssistantMessage",
                    "summary",
                    "message",
                    "task",
                ],
            ) {
                obj.insert("summary".into(), summary.clone());
            }
        }
        "TaskStart" | "TaskResume" => {
            obj.insert("status".into(), "processing".into());
        }
        "TaskCancel" => {
            obj.insert("status".into(), "interrupted".into());
        }
        "StopFailure" => {
            obj.insert("status".into(), "waiting_for_input".into());
            if let Some(e) = data
                .get("error_message")
                .or_else(|| data.get("error"))
                .or_else(|| data.get("message"))
            {
                obj.insert("stop_error".into(), e.clone());
                obj.insert("error_message".into(), e.clone());
            }
            copy_optional_field(obj, &data, "error_type", &["error_type"]);
        }
        "SessionStart" => {
            obj.insert("status".into(), "waiting_for_input".into());
        }
        "SessionEnd" => {
            obj.insert("status".into(), "ended".into());
        }
        "BeforeAgent" => {
            obj.insert("status".into(), "processing".into());
            copy_optional_field(obj, &data, "prompt", &["prompt", "message", "description"]);
        }
        "AfterAgent" => {
            obj.insert("status".into(), "response_received".into());
            copy_optional_field(
                obj,
                &data,
                "prompt_response",
                &[
                    "prompt_response",
                    "summary",
                    "last_assistant_message",
                    "message",
                ],
            );
        }
        "PreCompact" => {
            obj.insert("status".into(), "compacting".into());
            copy_optional_field(obj, &data, "trigger", &["trigger"]);
        }
        "PostCompact" => {
            obj.insert("status".into(), "processing".into());
            copy_optional_field(obj, &data, "trigger", &["trigger"]);
        }
        "SubagentStart" => {
            obj.insert("status".into(), "processing".into());
            let agent_id = data
                .get("agent_id")
                .or_else(|| data.get("agentId"))
                .or_else(|| data.get("agent_name"))
                .or_else(|| data.get("tool_use_id"))
                .or_else(|| data.get("toolUseId"))
                .cloned()
                .unwrap_or_else(|| "unknown".into());
            obj.insert("agent_id".into(), agent_id.clone());
            obj.insert("agent_name".into(), agent_id);
            let desc = data
                .get("description")
                .or_else(|| data.get("prompt"))
                .or_else(|| data.get("message"))
                .cloned()
                .unwrap_or_else(|| "".into());
            obj.insert("description".into(), desc);
            copy_optional_field(obj, &data, "prompt", &["prompt"]);
            copy_optional_field(
                obj,
                &data,
                "agent_type",
                &["agent_type", "agentType", "type"],
            );
            copy_optional_field(
                obj,
                &data,
                "transcript_path",
                &["transcript_path", "transcriptPath"],
            );
        }
        "SubagentStop" => {
            obj.insert("status".into(), "processing".into());
            let agent_id = data
                .get("agent_id")
                .or_else(|| data.get("agentId"))
                .or_else(|| data.get("agent_name"))
                .or_else(|| data.get("tool_use_id"))
                .or_else(|| data.get("toolUseId"))
                .cloned()
                .unwrap_or_else(|| "unknown".into());
            obj.insert("agent_id".into(), agent_id.clone());
            obj.insert("agent_name".into(), agent_id);
            let agent_status = data
                .get("agent_status")
                .or_else(|| data.get("agentStatus"))
                .cloned()
                .unwrap_or_else(|| "completed".into());
            obj.insert("agent_status".into(), agent_status);
            copy_optional_field(
                obj,
                &data,
                "agent_type",
                &["agent_type", "agentType", "type"],
            );
            copy_optional_field(
                obj,
                &data,
                "transcript_path",
                &["transcript_path", "transcriptPath"],
            );
            copy_optional_field(
                obj,
                &data,
                "agent_transcript_path",
                &["agent_transcript_path", "agentTranscriptPath"],
            );
            copy_optional_field(
                obj,
                &data,
                "last_assistant_message",
                &[
                    "response",
                    "last_assistant_message",
                    "lastAssistantMessage",
                    "message",
                ],
            );
        }
        "Interrupt" => {
            obj.insert("status".into(), "interrupted".into());
            copy_optional_field(obj, &data, "reason", &["reason"]);
        }
        "beforeShellExecution" => {
            obj.insert("status".into(), "shell_starting".into());
            if let Some(cmd) = data.get("tool_input").and_then(|v| v.get("command")) {
                obj.insert("command".into(), cmd.clone());
            }
            if let Some(cwd_val) = data.get("cwd") {
                obj.insert("shell_cwd".into(), cwd_val.clone());
            }
        }
        "afterShellExecution" => {
            obj.insert("status".into(), "shell_completed".into());
            if let Some(cmd) = data.get("tool_input").and_then(|v| v.get("command")) {
                obj.insert("command".into(), cmd.clone());
            }
            if let Some(result) = data.get("tool_result") {
                obj.insert(
                    "stdout".into(),
                    result.get("stdout").cloned().unwrap_or_default(),
                );
                obj.insert(
                    "stderr".into(),
                    result.get("stderr").cloned().unwrap_or_default(),
                );
                obj.insert(
                    "exit_code".into(),
                    result.get("exit_code").cloned().unwrap_or_default(),
                );
            }
            if let Some(dur) = data.get("duration_ms") {
                obj.insert("duration_ms".into(), dur.clone());
            }
        }
        "beforeMCPExecution" => {
            obj.insert("status".into(), "mcp_starting".into());
            if let Some(tool) = data.get("tool_name") {
                obj.insert("mcp_tool".into(), tool.clone());
            }
            if let Some(server) = data.get("server_name") {
                obj.insert("mcp_server".into(), server.clone());
            }
            obj.insert("mcp_arguments".into(), tool_input.clone());
        }
        "afterMCPExecution" => {
            obj.insert("status".into(), "mcp_completed".into());
            if let Some(tool) = data.get("tool_name") {
                obj.insert("mcp_tool".into(), tool.clone());
            }
            if let Some(server) = data.get("server_name") {
                obj.insert("mcp_server".into(), server.clone());
            }
            if let Some(result) = data.get("tool_result") {
                obj.insert("mcp_result".into(), result.clone());
            }
            if let Some(err) = data.get("error") {
                obj.insert("mcp_error".into(), err.clone());
            }
            if let Some(dur) = data.get("duration_ms") {
                obj.insert("duration_ms".into(), dur.clone());
            }
        }
        "afterAgentResponse" => {
            obj.insert("status".into(), "response_received".into());
            if let Some(text) = data.get("text").or_else(|| data.get("content")) {
                obj.insert("response_content".into(), text.clone());
            }
            if let Some(content_type) = data.get("content_type") {
                obj.insert("content_type".into(), content_type.clone());
            }
        }
        "afterAgentThought" => {
            obj.insert("status".into(), "thought_processed".into());
            if let Some(thought) = data.get("thought").or_else(|| data.get("reasoning")) {
                obj.insert("thought_content".into(), thought.clone());
            }
        }
        _ => {
            obj.insert("status".into(), "unknown".into());
        }
    }

    forward_event(&state);
    if is_antigravity_source(&source) {
        println!("{}", antigravity_hook_output(hook_event));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_current_kimi_permission_events() {
        assert_eq!(
            normalize_hook_event("permission_request"),
            "PermissionRequest"
        );
        assert_eq!(
            normalize_hook_event("permission_result"),
            "PermissionResult"
        );
        assert_eq!(normalize_hook_event("interrupt"), "Interrupt");
    }

    #[test]
    fn antigravity_non_permission_hooks_always_return_json() {
        assert_eq!(
            antigravity_hook_output("PostToolUse"),
            serde_json::json!({})
        );
        assert_eq!(
            antigravity_hook_output("PreInvocation"),
            serde_json::json!({})
        );
        assert_eq!(
            antigravity_hook_output("PostInvocation"),
            serde_json::json!({})
        );
        assert_eq!(
            antigravity_hook_output("Stop"),
            serde_json::json!({ "decision": "stop" })
        );
    }

    #[test]
    fn antigravity_documented_fields_are_available_to_normalization() {
        let data = serde_json::json!({
            "conversationId": "conversation-1",
            "workspacePaths": ["/workspace/project"],
            "toolCall": {
                "name": "run_command",
                "args": {
                    "CommandLine": "pnpm test"
                }
            }
        });

        assert_eq!(
            string_field(&data, &["session_id", "conversationId"]),
            Some("conversation-1")
        );
        assert_eq!(
            first_string_array_field(&data, "workspacePaths"),
            Some("/workspace/project")
        );
        assert_eq!(data["toolCall"]["name"], "run_command");
        assert_eq!(data["toolCall"]["args"]["CommandLine"], "pnpm test");
    }

    #[test]
    fn tool_response_error_extracts_nonzero_stderr() {
        let error = tool_response_error(&serde_json::json!({
            "exit_code": 2,
            "stderr": "command failed"
        }));

        assert_eq!(error.as_deref(), Some("command failed"));
    }

    #[test]
    fn invocation_log_line_omits_prompt_and_cwd() {
        let state = serde_json::json!({
            "agent": "qoder",
            "event": "UserPromptSubmit",
            "session_id": "solo-session",
            "cwd": "/Users/me/secret-project",
            "prompt": "sensitive prompt"
        });

        let line = invocation_log_line(&state, true);
        let parsed: serde_json::Value = serde_json::from_str(&line).unwrap();

        assert_eq!(parsed["source"], "qoder");
        assert_eq!(parsed["event"], "UserPromptSubmit");
        assert_eq!(parsed["session_id"], "solo-session");
        assert_eq!(parsed["forwarded"], true);
        assert!(!line.contains("secret-project"));
        assert!(!line.contains("sensitive prompt"));
    }

    #[test]
    fn forced_event_allows_empty_input() {
        let data = hook_input_data("", Some("UserPromptSubmit")).unwrap();

        assert_eq!(data, serde_json::json!({}));
    }

    #[test]
    fn invalid_input_without_forced_event_is_ignored() {
        assert!(hook_input_data("", None).is_none());
        assert!(hook_input_data("not json", None).is_none());
    }

    fn launch_config(agents: &[&str]) -> vibe_board_lib::config::AppConfig {
        vibe_board_lib::config::AppConfig {
            auto_launch_agents: agents.iter().map(|agent| agent.to_string()).collect(),
            ..vibe_board_lib::config::AppConfig::default()
        }
    }

    #[test]
    fn session_start_starts_the_board_only_for_the_enabled_agent() {
        use std::cell::Cell;

        let config = launch_config(&["codex"]);
        let starts = Cell::new(0);
        maybe_start_configured_agent(&config, "codex", "SessionStart", || {
            starts.set(starts.get() + 1)
        });
        assert_eq!(starts.get(), 1, "the enabled Agent must start the board");

        maybe_start_configured_agent(&config, "claude-code", "SessionStart", || {
            starts.set(starts.get() + 1)
        });
        assert_eq!(starts.get(), 1, "a disabled Agent must not start the board");

        maybe_start_configured_agent(&config, "codex", "UserPromptSubmit", || {
            starts.set(starts.get() + 1)
        });
        assert_eq!(starts.get(), 1, "only SessionStart may start the board");
    }

    #[test]
    fn fresh_config_never_starts_the_board() {
        use std::cell::Cell;

        let config = vibe_board_lib::config::AppConfig::default();
        let started = Cell::new(false);
        maybe_start_configured_agent(&config, "codex", "SessionStart", || started.set(true));

        assert!(
            !started.get(),
            "every automatic launch must be opted into per Agent"
        );
    }
}
