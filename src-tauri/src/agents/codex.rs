// CodexAdapter — Agent adapter for OpenAI Codex CLI

use super::{profiles, AdapterStatus, AgentAdapter, AgentEvent, QuestionItem, QuestionOption};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(test)]
const AGENTBRO_MARKER: &str = "agentbro";
const CODEX_PERMISSION_TIMEOUT_SECONDS: u64 = 21_600;
const CODEX_APP_SERVER_PORT: u16 = 41241;

const HOOK_EVENTS: &[(&str, &str, u64)] = &[
    ("SessionStart", "session_start", 5),
    ("UserPromptSubmit", "user_prompt_submit", 5),
    ("PreToolUse", "pre_tool_use", 5),
    ("PostToolUse", "post_tool_use", 5),
    ("PostToolUseFailure", "post_tool_use_failure", 5),
    (
        "PermissionRequest",
        "permission_request",
        CODEX_PERMISSION_TIMEOUT_SECONDS,
    ),
    ("PermissionDenied", "permission_denied", 5),
    ("Notification", "notification", 5),
    ("Stop", "stop", 5),
    ("SessionEnd", "session_end", 5),
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAppServerProbe {
    pub port: u16,
    pub cli_path: Option<String>,
    pub cli_version: Option<String>,
    pub desktop_path: Option<String>,
    pub cli_available: bool,
    pub app_server_command_available: bool,
    pub server_listening: bool,
    pub codex_app_installed: bool,
    pub auth_configured: bool,
    pub sessions_dir_exists: bool,
    pub checks: Vec<CodexAppServerProbeCheck>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAppServerProbeCheck {
    pub id: String,
    pub label: String,
    pub status: String,
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggestion: Option<String>,
}

pub struct CodexAdapter {
    config_root: PathBuf,
    status: AdapterStatus,
}

pub fn probe_app_server_readiness() -> CodexAppServerProbe {
    let cli_path = super::executable::find_codex_cli_binary();
    let cli_path_text = cli_path
        .as_ref()
        .map(|path| path.to_string_lossy().to_string());
    let cli_version = cli_path
        .as_ref()
        .and_then(|path| run_command_with_timeout(path, &["--version"], Duration::from_secs(2)))
        .and_then(|output| output_line(&output));
    let app_server_output = cli_path.as_ref().and_then(|path| {
        run_command_with_timeout(path, &["app-server", "--help"], Duration::from_secs(3))
    });
    let app_server_command_available = app_server_output
        .as_ref()
        .map(|output| output.status.success())
        .unwrap_or(false);
    let app_server_detail = app_server_output
        .as_ref()
        .and_then(output_line)
        .unwrap_or_else(|| {
            if cli_path.is_some() {
                "codex app-server --help did not complete".to_string()
            } else {
                "codex CLI not found".to_string()
            }
        });
    let server_listening = is_local_port_listening(CODEX_APP_SERVER_PORT);
    let desktop_path = codex_desktop_app_path();
    let desktop_app_ids = super::executable::codex_desktop_app_user_model_ids();
    let desktop_path_text = desktop_path
        .as_ref()
        .map(|path| path.to_string_lossy().to_string())
        .or_else(|| {
            desktop_app_ids
                .first()
                .map(|app_id| format!("Windows App: {app_id}"))
        });
    let codex_app_installed = desktop_path.is_some() || !desktop_app_ids.is_empty();
    let codex_root = dirs::home_dir().map(|home| home.join(".codex"));
    let auth_path = codex_root.as_ref().map(|root| root.join("auth.json"));
    let sessions_path = codex_root.as_ref().map(|root| root.join("sessions"));
    let auth_configured = auth_path
        .as_ref()
        .map(|path| path.exists())
        .unwrap_or(false);
    let sessions_dir_exists = sessions_path
        .as_ref()
        .map(|path| path.is_dir())
        .unwrap_or(false);

    let mut checks = Vec::new();
    checks.push(CodexAppServerProbeCheck {
        id: "cli".to_string(),
        label: "Codex CLI".to_string(),
        status: if cli_path.is_some() { "ok" } else { "error" }.to_string(),
        detail: cli_path_text
            .as_deref()
            .map(|path| match cli_version.as_deref() {
                Some(version) if !version.is_empty() => format!("{path} ({version})"),
                _ => path.to_string(),
            })
            .unwrap_or_else(|| {
                if codex_app_installed {
                    "Codex Desktop was found, but no spawnable Codex CLI was found. The WindowsApps/Desktop launcher is not used for hooks or app-server.".to_string()
                } else {
                    "codex was not found in PATH or common install directories".to_string()
                }
            }),
        suggestion: if cli_path.is_some() {
            None
        } else {
            Some("Install or expose the Codex CLI before using hooks or app-server sync.".to_string())
        },
    });
    checks.push(CodexAppServerProbeCheck {
        id: "app-server-command".to_string(),
        label: "app-server command".to_string(),
        status: if app_server_command_available {
            "ok"
        } else {
            "error"
        }
        .to_string(),
        detail: app_server_detail,
        suggestion: if app_server_command_available {
            None
        } else {
            Some("Update Codex to a build that supports `codex app-server`.".to_string())
        },
    });
    checks.push(CodexAppServerProbeCheck {
        id: "server-port".to_string(),
        label: "Local app-server port".to_string(),
        status: if server_listening { "ok" } else { "warn" }.to_string(),
        detail: if server_listening {
            format!("127.0.0.1:{CODEX_APP_SERVER_PORT} is accepting TCP connections")
        } else {
            format!("127.0.0.1:{CODEX_APP_SERVER_PORT} is not listening")
        },
        suggestion: if server_listening {
            None
        } else {
            Some("Optional: Vibe Board background sync uses stdio and does not require this local WebSocket port.".to_string())
        },
    });
    checks.push(CodexAppServerProbeCheck {
        id: "codex-app".to_string(),
        label: "Codex Desktop".to_string(),
        status: if codex_app_installed { "ok" } else { "warn" }.to_string(),
        detail: if codex_app_installed {
            desktop_path_text
                .as_deref()
                .unwrap_or("Codex Desktop is installed")
                .to_string()
        } else {
            "Codex Desktop was not found in the standard app locations".to_string()
        },
        suggestion: None,
    });
    checks.push(CodexAppServerProbeCheck {
        id: "auth".to_string(),
        label: "Codex auth".to_string(),
        status: if auth_configured { "ok" } else { "warn" }.to_string(),
        detail: auth_path
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_else(|| "~/.codex/auth.json".to_string()),
        suggestion: if auth_configured {
            None
        } else {
            Some("Run `codex login` if account-backed data is needed.".to_string())
        },
    });
    checks.push(CodexAppServerProbeCheck {
        id: "transcripts".to_string(),
        label: "Local transcripts".to_string(),
        status: if sessions_dir_exists { "ok" } else { "warn" }.to_string(),
        detail: sessions_path
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_else(|| "~/.codex/sessions".to_string()),
        suggestion: None,
    });
    checks.push(CodexAppServerProbeCheck {
        id: "live-sync".to_string(),
        label: "Vibe Board live sync".to_string(),
        status: if app_server_command_available { "ok" } else { "warn" }.to_string(),
        detail: "Vibe Board can keep a persistent Codex stdio app-server listener for thread sync and realtime prompts, with energy-aware thread/list refresh, when background sync is enabled.".to_string(),
        suggestion: Some("Enable background thread sync in Island settings for app-server prompt routing.".to_string()),
    });

    CodexAppServerProbe {
        port: CODEX_APP_SERVER_PORT,
        cli_path: cli_path_text,
        cli_version,
        desktop_path: desktop_path_text,
        cli_available: cli_path.is_some(),
        app_server_command_available,
        server_listening,
        codex_app_installed,
        auth_configured,
        sessions_dir_exists,
        checks,
    }
}

fn run_command_with_timeout(binary: &Path, args: &[&str], timeout: Duration) -> Option<Output> {
    let mut child = crate::platform::process::background_command(binary)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return child.wait_with_output().ok(),
            Ok(None) if started.elapsed() < timeout => thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

fn output_line(output: &Output) -> Option<String> {
    let combined = format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    combined
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(|line| {
            const MAX_LEN: usize = 180;
            if line.chars().count() > MAX_LEN {
                format!("{}...", line.chars().take(MAX_LEN).collect::<String>())
            } else {
                line.to_string()
            }
        })
}

fn is_local_port_listening(port: u16) -> bool {
    let Ok(addr) = format!("127.0.0.1:{port}").parse::<SocketAddr>() else {
        return false;
    };
    TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok()
}

fn codex_desktop_app_path() -> Option<PathBuf> {
    codex_app_paths().into_iter().find(|path| path.exists())
}

fn codex_app_paths() -> Vec<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        super::executable::codex_desktop_app_candidates()
    }

    #[cfg(not(target_os = "windows"))]
    {
        let mut paths = vec![PathBuf::from("/Applications/Codex.app")];
        if let Some(home) = dirs::home_dir() {
            paths.push(home.join("Applications").join("Codex.app"));
        }
        paths
    }
}

impl CodexAdapter {
    pub fn new() -> Self {
        let home = dirs::home_dir().unwrap_or_else(std::env::temp_dir);
        let config_root = home.join(".codex");
        let status = if Self::is_installed() {
            AdapterStatus::Available
        } else {
            AdapterStatus::Unavailable
        };
        Self {
            config_root,
            status,
        }
    }

    fn is_installed() -> bool {
        super::executable::command_exists("codex")
    }

    fn hooks_path(&self) -> PathBuf {
        self.config_root.join("hooks.json")
    }

    fn config_toml_path(&self) -> PathBuf {
        self.config_root.join("config.toml")
    }

    fn hook_command() -> Result<String, Box<dyn std::error::Error>> {
        profiles::managed_bridge_command(&profiles::codex_profile())
    }

    #[cfg(test)]
    fn inject_hooks_json(settings: &mut serde_json::Value, hook_command: &str) {
        if !settings.get("hooks").is_some_and(|hooks| hooks.is_object()) {
            settings["hooks"] = serde_json::json!({});
        }
        let hooks = settings["hooks"].as_object_mut().expect("hooks is object");

        for (event, _, timeout) in HOOK_EVENTS {
            let entry = hooks
                .entry(event.to_string())
                .or_insert_with(|| serde_json::json!([]));
            if !entry.is_array() {
                *entry = serde_json::json!([]);
            }
            let groups = entry.as_array_mut().expect("event hooks is array");
            groups.retain(|group| !group_contains_agentbro(group));
            groups.push(serde_json::json!({
                "hooks": [{
                    "type": "command",
                    "command": hook_command,
                    "timeout": timeout
                }]
            }));
        }
    }

    fn trust_codex_hooks(
        hooks_path: &Path,
        config_toml_path: &Path,
        settings: &serde_json::Value,
        hook_command: &str,
        backup_root: &Path,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let source_path = hooks_path
            .canonicalize()
            .unwrap_or_else(|_| hooks_path.to_path_buf());
        let source_path = source_path.to_string_lossy().to_string();
        let mut states = BTreeMap::new();

        let Some(hooks) = settings.get("hooks").and_then(|hooks| hooks.as_object()) else {
            return Ok(());
        };

        for (event_name, event_key, event_timeout) in HOOK_EVENTS {
            let Some(groups) = hooks.get(*event_name).and_then(|value| value.as_array()) else {
                continue;
            };

            for (group_index, group) in groups.iter().enumerate() {
                let Some(handlers) = group.get("hooks").and_then(|value| value.as_array()) else {
                    continue;
                };
                for (handler_index, handler) in handlers.iter().enumerate() {
                    if handler.get("type").and_then(|value| value.as_str()) != Some("command") {
                        continue;
                    }
                    if handler.get("command").and_then(|value| value.as_str()) != Some(hook_command)
                    {
                        continue;
                    }

                    let timeout = handler
                        .get("timeout")
                        .and_then(|value| value.as_u64())
                        .unwrap_or(*event_timeout)
                        .max(1);
                    let mut normalized_group = serde_json::json!({
                        "hooks": [{
                            "type": "command",
                            "command": hook_command,
                            "timeout": timeout,
                            "async": handler
                                .get("async")
                                .and_then(|value| value.as_bool())
                                .unwrap_or(false)
                        }]
                    });
                    if let Some(matcher) = group.get("matcher").and_then(|value| value.as_str()) {
                        normalized_group["matcher"] =
                            serde_json::Value::String(matcher.to_string());
                    }

                    let identity = serde_json::json!({
                        "event_name": event_key,
                        "hooks": normalized_group["hooks"],
                        "matcher": normalized_group.get("matcher"),
                    });
                    let identity = if normalized_group.get("matcher").is_some() {
                        identity
                    } else {
                        serde_json::json!({
                            "event_name": event_key,
                            "hooks": normalized_group["hooks"],
                        })
                    };
                    let trusted_hash = codex_hook_hash(&identity);
                    let key = format!("{source_path}:{event_key}:{group_index}:{handler_index}");
                    states.insert(key, trusted_hash);
                }
            }
        }

        if states.is_empty() {
            return Ok(());
        }
        upsert_codex_trust_state(config_toml_path, &states, backup_root)?;
        Ok(())
    }
}

impl AgentAdapter for CodexAdapter {
    fn name(&self) -> &str {
        "codex"
    }
    fn display_name(&self) -> &str {
        "OpenAI Codex"
    }
    fn icon(&self) -> &str {
        "codex"
    }

    fn install_hooks(&self) -> Result<(), Box<dyn std::error::Error>> {
        let hooks_path = self.hooks_path();
        let hook_command = Self::hook_command()?;
        let settings = profiles::install_nested_json_hooks_at(
            &profiles::codex_profile(),
            &hooks_path,
            &hook_command,
        )?;
        Self::trust_codex_hooks(
            &hooks_path,
            &self.config_toml_path(),
            &settings,
            &hook_command,
            &codex_trust_backup_root(),
        )?;
        log::info!("Codex hooks installed");
        Ok(())
    }

    fn remove_hooks(&self) -> Result<(), Box<dyn std::error::Error>> {
        profiles::uninstall_at(&profiles::codex_profile(), &self.hooks_path())?;
        log::info!("Codex hooks removed");
        Ok(())
    }

    fn status(&self) -> AdapterStatus {
        self.status.clone()
    }

    fn detect_status_now(&self) -> AdapterStatus {
        if Self::is_installed() {
            AdapterStatus::Available
        } else {
            AdapterStatus::Unavailable
        }
    }

    fn parse_event(
        &self,
        raw: &serde_json::Value,
    ) -> Result<AgentEvent, Box<dyn std::error::Error>> {
        let agent = raw.get("agent").and_then(|v| v.as_str()).unwrap_or("");
        if !agent.is_empty() && !matches!(agent, "codex" | "openai.codex") {
            return Err("not a codex event".into());
        }

        let session_id = raw
            .get("session_id")
            .or_else(|| raw.get("sessionId"))
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();
        let event = normalize_event_name(raw.get("event").and_then(|v| v.as_str()).unwrap_or(""));
        let status = raw.get("status").and_then(|v| v.as_str()).unwrap_or("");
        let cwd = raw
            .get("cwd")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let project = super::project_name_from_path(&cwd);
        let terminal = raw
            .get("tty")
            .or_else(|| raw.get("terminal"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let raw_tool_name = raw
            .get("tool")
            .or_else(|| raw.get("tool_name"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let tool_input_value = raw.get("tool_input").or_else(|| raw.get("toolInput"));
        let tool_input = raw
            .get("tool_input")
            .or_else(|| raw.get("toolInput"))
            .map(|v| v.to_string())
            .unwrap_or_default();
        let tool_name = normalize_codex_tool_name(&raw_tool_name);
        let tool_target = extract_codex_tool_target(&tool_name, tool_input_value);

        match event.as_str() {
            "SessionStart" => Ok(AgentEvent::SessionStart {
                session_id,
                project,
                cwd,
                terminal,
                agent_type: "codex".to_string(),
            }),
            "SessionEnd" => Ok(AgentEvent::SessionEnd { session_id }),
            "UserPromptSubmit" => Ok(AgentEvent::Processing {
                session_id,
                description: "Processing user input".to_string(),
            }),
            "PreToolUse" => Ok(AgentEvent::ToolUse {
                session_id,
                tool_name,
                tool_input,
                tool_target,
                status: "running".to_string(),
            }),
            "PostToolUse" => Ok(AgentEvent::ToolUse {
                session_id,
                tool_name,
                tool_input,
                tool_target,
                status: codex_post_tool_status(raw),
            }),
            "PostToolUseFailure" | "PermissionDenied" => Ok(AgentEvent::ToolUse {
                session_id,
                tool_name,
                tool_input,
                tool_target,
                status: "error".to_string(),
            }),
            "PermissionRequest" => Ok(AgentEvent::PermissionRequest {
                session_id,
                tool_name,
                diff: None,
                options: None,
            }),
            "AskQuestion" => parse_question_event(raw, session_id),
            "PlanApproval" => parse_plan_event(raw, session_id),
            "Stop" => Ok(AgentEvent::AssistantResponseComplete {
                session_id,
                text: raw
                    .get("summary")
                    .or_else(|| raw.get("last_assistant_message"))
                    .or_else(|| raw.get("lastAssistantMessage"))
                    .or_else(|| raw.get("message"))
                    .and_then(|v| v.as_str())
                    .filter(|v| !v.trim().is_empty())
                    .unwrap_or("Task completed")
                    .to_string(),
            }),
            "StopFailure" => Ok(AgentEvent::Error {
                session_id,
                message: raw
                    .get("error")
                    .or_else(|| raw.get("message"))
                    .and_then(|v| v.as_str())
                    .filter(|v| !v.trim().is_empty())
                    .unwrap_or("Task failed")
                    .to_string(),
            }),
            "Notification" => Ok(AgentEvent::Notification {
                session_id,
                message: raw
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                status: if status.is_empty() {
                    None
                } else {
                    Some(status.to_string())
                },
            }),
            _ => Ok(AgentEvent::Processing {
                session_id,
                description: format!("Event: {}", event),
            }),
        }
    }

    fn hook_config_paths(&self) -> Vec<PathBuf> {
        vec![self.hooks_path(), self.config_toml_path()]
    }
}

#[cfg(test)]
fn group_contains_agentbro(group: &serde_json::Value) -> bool {
    if group
        .get("command")
        .and_then(|command| command.as_str())
        .is_some_and(|command| command.contains(AGENTBRO_MARKER))
    {
        return true;
    }
    group
        .get("hooks")
        .and_then(|hooks| hooks.as_array())
        .is_some_and(|hooks| {
            hooks.iter().any(|hook| {
                hook.get("command")
                    .and_then(|command| command.as_str())
                    .is_some_and(|command| command.contains(AGENTBRO_MARKER))
            })
        })
}

fn normalize_event_name(event: &str) -> String {
    match event {
        "session_start" => "SessionStart",
        "session_end" => "SessionEnd",
        "user_prompt_submit" => "UserPromptSubmit",
        "pre_tool_use" => "PreToolUse",
        "post_tool_use" => "PostToolUse",
        "post_tool_use_failure" => "PostToolUseFailure",
        "permission_request" => "PermissionRequest",
        "permission_denied" => "PermissionDenied",
        "stop" => "Stop",
        "stop_failure" => "StopFailure",
        other => other,
    }
    .to_string()
}

fn normalize_codex_tool_name(tool_name: &str) -> String {
    let trimmed = tool_name.trim();
    if trimmed.starts_with("mcp__") {
        return trimmed.to_string();
    }
    let normalized = trimmed
        .trim_start_matches("functions.")
        .trim_start_matches("multi_agent_v1.")
        .replace(['-', ' '], "_")
        .to_lowercase();

    match normalized.as_str() {
        "read" | "read_file" | "readfile" | "open_file" | "view_file" | "sed" | "cat" => {
            "Read".to_string()
        }
        "write" | "write_file" | "writefile" | "create_file" => "Write".to_string(),
        "edit" | "edit_file" | "editfile" | "apply_patch" | "patch" | "str_replace"
        | "update_file" | "notebook_edit" => "Edit".to_string(),
        "grep" | "rg" | "search" | "find" | "glob" | "list_files" | "ls" => "Grep".to_string(),
        "bash" | "shell" | "exec" | "exec_command" | "terminal" | "run_command" | "command" => {
            "Bash".to_string()
        }
        "web_search" | "search_query" => "WebSearch".to_string(),
        "web_fetch" | "open" | "fetch" => "WebFetch".to_string(),
        "update_plan" | "todo_write" => "TodoWrite".to_string(),
        "spawn_agent" | "send_input" | "wait_agent" | "close_agent" | "resume_agent" => {
            "Agent".to_string()
        }
        _ if trimmed.is_empty() => "Tool".to_string(),
        _ => trimmed.to_string(),
    }
}

fn extract_codex_tool_target(
    normalized_tool_name: &str,
    tool_input: Option<&serde_json::Value>,
) -> Option<String> {
    let input = parse_embedded_json(tool_input);

    if matches!(normalized_tool_name, "Edit" | "Write") {
        if let Some(patch) = string_field(&input, &["patch", "command", "input", "diff"]) {
            if let Some(target) = patch_target_with_stats(&patch) {
                return Some(target);
            }
        }
    }

    match normalized_tool_name {
        "Read" | "Edit" | "Write" | "Grep" | "Glob" | "NotebookEdit" => {
            let path = string_field(
                &input,
                &[
                    "file_path",
                    "filePath",
                    "path",
                    "filepath",
                    "filename",
                    "target",
                    "relative_path",
                ],
            )?;
            Some(display_path_name(&path))
        }
        "Bash" => string_field(&input, &["command", "cmd"])
            .map(|command| truncate_display_text(command.trim(), 50)),
        "WebSearch" | "WebFetch" => string_field(&input, &["query", "url"])
            .map(|value| truncate_display_text(value.trim(), 50)),
        "TodoWrite" => Some("tasks".to_string()),
        "Agent" => string_field(&input, &["message", "prompt", "task", "description"])
            .map(|value| truncate_display_text(value.trim(), 50)),
        _ => string_field(&input, &["target", "path", "file_path"])
            .map(|value| truncate_display_text(value.trim(), 50)),
    }
}

fn parse_embedded_json(tool_input: Option<&serde_json::Value>) -> serde_json::Value {
    let Some(value) = tool_input else {
        return serde_json::Value::Null;
    };
    if let Some(text) = value.as_str() {
        serde_json::from_str(text).unwrap_or_else(|_| serde_json::Value::String(text.to_string()))
    } else {
        value.clone()
    }
}

fn string_field(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
    match value {
        serde_json::Value::Object(map) => {
            for key in keys {
                if let Some(text) = map
                    .get(*key)
                    .and_then(|value| value.as_str())
                    .map(str::trim)
                    .filter(|text| !text.is_empty())
                {
                    return Some(text.to_string());
                }
            }
            for nested_key in ["args", "arguments", "params", "input"] {
                if let Some(nested) = map.get(nested_key) {
                    if let Some(value) = string_field(nested, keys) {
                        return Some(value);
                    }
                }
            }
            None
        }
        serde_json::Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        _ => None,
    }
}

fn patch_target_with_stats(patch: &str) -> Option<String> {
    let mut path: Option<String> = None;
    let mut additions = 0usize;
    let mut deletions = 0usize;

    for line in patch.lines() {
        if path.is_none() {
            path = line
                .strip_prefix("*** Update File: ")
                .or_else(|| line.strip_prefix("*** Add File: "))
                .or_else(|| line.strip_prefix("*** Delete File: "))
                .map(|value| value.trim().to_string())
                .or_else(|| parse_diff_path_marker(line));
        }

        if line.starts_with('+') && !line.starts_with("+++") {
            additions += 1;
        } else if line.starts_with('-') && !line.starts_with("---") {
            deletions += 1;
        }
    }

    let path = path?;
    let name = display_path_name(&path);
    if additions == 0 && deletions == 0 {
        Some(name)
    } else {
        Some(format!("{name} +{additions} -{deletions}"))
    }
}

fn parse_diff_path_marker(line: &str) -> Option<String> {
    let value = line
        .strip_prefix("+++ ")
        .or_else(|| line.strip_prefix("--- "))?
        .trim();
    if value == "/dev/null" {
        return None;
    }
    Some(
        value
            .trim_start_matches("a/")
            .trim_start_matches("b/")
            .to_string(),
    )
}

fn display_path_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or(path)
        .to_string()
}

fn truncate_display_text(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }

    let take_chars = max_chars.saturating_sub(3);
    format!("{}...", text.chars().take(take_chars).collect::<String>())
}

fn codex_post_tool_status(raw: &serde_json::Value) -> String {
    if raw.get("tool_error").is_some()
        || raw.get("denial_reason").is_some()
        || raw
            .get("tool_response")
            .or_else(|| raw.get("toolResponse"))
            .is_some_and(tool_response_looks_failed)
    {
        "error".to_string()
    } else {
        "success".to_string()
    }
}

fn tool_response_looks_failed(response: &serde_json::Value) -> bool {
    response
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
        || response.get("error").is_some()
}

fn parse_question_event(
    raw: &serde_json::Value,
    session_id: String,
) -> Result<AgentEvent, Box<dyn std::error::Error>> {
    let question = raw
        .get("question")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let options = raw
        .get("options")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let descriptions = raw
        .get("descriptions")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let header = raw
        .get("header")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let multi_select = raw
        .get("multi_select")
        .or_else(|| raw.get("multiSelect"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let questions = raw
        .get("questions")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|question| {
                    let text = question.get("question")?.as_str()?.to_string();
                    let options = question
                        .get("options")
                        .and_then(|v| v.as_array())
                        .map(|options| {
                            options
                                .iter()
                                .filter_map(|option| {
                                    let label = option.get("label")?.as_str()?.to_string();
                                    let description = option
                                        .get("description")
                                        .and_then(|v| v.as_str())
                                        .map(|s| s.to_string());
                                    Some(QuestionOption { label, description })
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    let header = question
                        .get("header")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string());
                    let multi_select = question
                        .get("multiSelect")
                        .or_else(|| question.get("multi_select"))
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    Some(QuestionItem {
                        question: text,
                        header,
                        options,
                        multi_select,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(AgentEvent::AskQuestion {
        session_id,
        question,
        options,
        descriptions,
        header,
        multi_select,
        questions,
    })
}

fn parse_plan_event(
    raw: &serde_json::Value,
    session_id: String,
) -> Result<AgentEvent, Box<dyn std::error::Error>> {
    let title = raw
        .get("plan_title")
        .or_else(|| raw.get("planTitle"))
        .and_then(|v| v.as_str())
        .unwrap_or("Plan")
        .to_string();
    let content = raw
        .get("plan_content")
        .or_else(|| raw.get("planContent"))
        .or_else(|| raw.get("plan"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let permissions = raw
        .get("requested_permissions")
        .or_else(|| raw.get("allowedPrompts"))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .map(|item| {
                    if let Some(s) = item.as_str() {
                        s.to_string()
                    } else if let (Some(tool), Some(prompt)) = (
                        item.get("tool").and_then(|v| v.as_str()),
                        item.get("prompt").and_then(|v| v.as_str()),
                    ) {
                        format!("{tool}: {prompt}")
                    } else {
                        item.to_string()
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(AgentEvent::PlanApproval {
        session_id,
        title,
        content,
        permissions,
    })
}

fn codex_hook_hash(value: &serde_json::Value) -> String {
    let serialized = canonical_json(value);
    let mut hasher = Sha256::new();
    hasher.update(serialized.as_bytes());
    format!("sha256:{:x}", hasher.finalize())
}

fn canonical_json(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => "null".to_string(),
        serde_json::Value::Bool(value) => value.to_string(),
        serde_json::Value::Number(value) => value.to_string(),
        serde_json::Value::String(value) => serde_json::to_string(value).unwrap_or_default(),
        serde_json::Value::Array(values) => {
            let inner = values
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",");
            format!("[{inner}]")
        }
        serde_json::Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort();
            let inner = keys
                .into_iter()
                .map(|key| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap_or_default(),
                        canonical_json(&values[key])
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{inner}}}")
        }
    }
}

fn codex_trust_backup_root() -> PathBuf {
    crate::data_dir::agent_island_home()
        .join("hooks")
        .join("backups")
}

/// Add or refresh the `hooks.state.<key>` entries in the Codex `config.toml`.
///
/// The candidate is written only after a standard TOML parser accepts it, a
/// backup of the previous revision exists, and the file still matches what was
/// read. Conflicting duplicate states abort the write and keep the original.
fn upsert_codex_trust_state(
    config_path: &Path,
    states: &BTreeMap<String, String>,
    backup_root: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let original = match std::fs::read(config_path) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            return Err(format!(
                "Failed to read Codex config {}: {error}",
                config_path.display()
            )
            .into())
        }
    };
    let original_text = original
        .as_deref()
        .map(std::str::from_utf8)
        .transpose()
        .map_err(|error| {
            format!(
                "Refusing to rewrite Codex config {}: it is not valid UTF-8: {error}",
                config_path.display()
            )
        })?;

    let candidate = build_codex_trust_candidate(original_text.unwrap_or_default(), states)?;

    // The standard parser rejects both malformed TOML and duplicate keys, so a
    // candidate it accepts cannot leave Codex with an unreadable config.
    if let Err(error) = candidate.parse::<toml_edit::DocumentMut>() {
        return Err(format!("Refusing to write invalid Codex config: {error}").into());
    }

    if original_text == Some(candidate.as_str()) {
        return Ok(());
    }

    if let Some(bytes) = original.as_deref() {
        write_codex_config_backup(config_path, bytes, backup_root)?;
    }
    write_codex_config_file(config_path, original.as_deref(), candidate.as_bytes())
}

fn build_codex_trust_candidate(
    content: &str,
    states: &BTreeMap<String, String>,
) -> Result<String, Box<dyn std::error::Error>> {
    match content.parse::<toml_edit::DocumentMut>() {
        Ok(mut document) => {
            apply_codex_trust_states(&mut document, states)?;
            Ok(document.to_string())
        }
        // A config that already contains two spellings of the same state cannot
        // be parsed as a whole. Repair it only when every copy of the state
        // agrees on the trusted hash and no field would be dropped; otherwise
        // the original file is kept.
        Err(_) => merge_codex_trust_duplicates(content, states),
    }
}

fn apply_codex_trust_states(
    document: &mut toml_edit::DocumentMut,
    states: &BTreeMap<String, String>,
) -> Result<(), Box<dyn std::error::Error>> {
    ensure_codex_hooks_feature(document)?;
    let state = codex_trust_state_table(document, true)?;
    for (key, trusted_hash) in states {
        match state.entry(key) {
            toml_edit::Entry::Occupied(mut entry) => {
                let table = entry
                    .get_mut()
                    .as_table_like_mut()
                    .ok_or_else(|| format!("Codex trust state for {key} is not a table"))?;
                let current = table
                    .get("trusted_hash")
                    .and_then(|item| item.as_str())
                    .ok_or_else(|| {
                        format!("Codex trust state for {key} has no string trusted_hash")
                    })?;
                if current != trusted_hash {
                    table.insert("trusted_hash", toml_edit::value(trusted_hash));
                }
            }
            toml_edit::Entry::Vacant(entry) => {
                let mut table = toml_edit::Table::new();
                table.insert("trusted_hash", toml_edit::value(trusted_hash));
                entry.insert(toml_edit::Item::Table(table));
            }
        }
    }
    Ok(())
}

fn codex_trust_state_table(
    document: &mut toml_edit::DocumentMut,
    create: bool,
) -> Result<&mut dyn toml_edit::TableLike, Box<dyn std::error::Error>> {
    let hooks = match document.as_table_mut().entry("hooks") {
        toml_edit::Entry::Occupied(entry) => entry.into_mut(),
        toml_edit::Entry::Vacant(_) if !create => {
            return Err("Codex config has no hooks table".to_string().into())
        }
        toml_edit::Entry::Vacant(entry) => entry.insert({
            let mut table = toml_edit::Table::new();
            table.set_implicit(true);
            toml_edit::Item::Table(table)
        }),
    };
    let hooks = hooks
        .as_table_like_mut()
        .ok_or_else(|| "Codex config key `hooks` is not a table".to_string())?;
    let state = match hooks.entry("state") {
        toml_edit::Entry::Occupied(entry) => entry.into_mut(),
        toml_edit::Entry::Vacant(_) if !create => {
            return Err("Codex config has no hooks.state table".to_string().into())
        }
        toml_edit::Entry::Vacant(entry) => entry.insert({
            let mut table = toml_edit::Table::new();
            table.set_implicit(true);
            toml_edit::Item::Table(table)
        }),
    };
    state.as_table_like_mut().ok_or_else(|| {
        "Codex config key `hooks.state` is not a table"
            .to_string()
            .into()
    })
}

struct CodexTrustSection {
    index: usize,
    key: String,
    trusted_hash: String,
    literal_key: bool,
    extras: BTreeMap<String, String>,
}

fn merge_codex_trust_duplicates(
    content: &str,
    states: &BTreeMap<String, String>,
) -> Result<String, Box<dyn std::error::Error>> {
    let sections = split_codex_config_sections(content);
    let mut documents = Vec::with_capacity(sections.len());
    for section in &sections {
        let document = section.parse::<toml_edit::DocumentMut>().map_err(|error| {
            format!("Refusing to rewrite Codex config: cannot parse a section: {error}")
        })?;
        documents.push(document);
    }

    let keys = states.keys().cloned().collect::<BTreeSet<_>>();
    let mut features_section = None;
    let mut trust_sections = Vec::new();
    for (index, document) in documents.iter().enumerate() {
        if document.len() == 1
            && document
                .get("features")
                .is_some_and(|item| item.is_table_like())
        {
            features_section.get_or_insert(index);
            continue;
        }
        let Some(state) = document
            .get("hooks")
            .and_then(|item| item.as_table())
            .and_then(|table| table.get("state"))
            .and_then(|item| item.as_table())
        else {
            continue;
        };
        let mut entries = state.iter();
        let Some((key, value)) = entries.next() else {
            continue;
        };
        if entries.next().is_some() {
            continue;
        }
        let key_value = key.to_string();
        if !keys.contains(&key_value) {
            continue;
        }
        let Some(table) = value.as_table_like() else {
            continue;
        };
        let Some(trusted_hash) = table.get("trusted_hash").and_then(|item| item.as_str()) else {
            return Err(format!(
                "Refusing to rewrite Codex config: hooks.state.{key_value} has no string trusted_hash"
            )
            .into());
        };
        let mut extras = BTreeMap::new();
        for (extra_key, extra_item) in table.iter() {
            if extra_key == "trusted_hash" || extra_item.is_none() {
                continue;
            }
            extras.insert(
                extra_key.to_string(),
                extra_item.to_string().trim().to_string(),
            );
        }
        trust_sections.push(CodexTrustSection {
            index,
            key: key_value,
            trusted_hash: trusted_hash.to_string(),
            literal_key: state
                .key(key)
                .is_some_and(|state_key| state_key.display_repr().starts_with('\'')),
            extras,
        });
    }

    let mut removed = BTreeSet::new();
    let mut rewritten = BTreeSet::new();
    for (key, trusted_hash) in states {
        let matching = trust_sections
            .iter()
            .filter(|section| &section.key == key)
            .collect::<Vec<_>>();
        if matching.is_empty() {
            continue;
        }
        let distinct = matching
            .iter()
            .map(|section| section.trusted_hash.as_str())
            .collect::<BTreeSet<_>>();
        if distinct.len() > 1 {
            return Err(format!(
                "Refusing to rewrite Codex config: duplicate hooks.state.{key} tables disagree on trusted_hash ({})",
                distinct.into_iter().collect::<Vec<_>>().join(", ")
            )
            .into());
        }
        // Prefer the spelling the user already had, keeping literal keys.
        let keeper = matching
            .iter()
            .find(|section| section.literal_key)
            .copied()
            .unwrap_or(matching[0]);
        for section in &matching {
            if section.index == keeper.index {
                continue;
            }
            // A duplicate may only be dropped when every field it carries also
            // survives in the keeper; unknown fields are never discarded.
            for (extra_key, extra_value) in &section.extras {
                if keeper.extras.get(extra_key) != Some(extra_value) {
                    return Err(format!(
                        "Refusing to rewrite Codex config: duplicate hooks.state.{key} tables contain different fields ({extra_key})"
                    )
                    .into());
                }
            }
            removed.insert(section.index);
        }
        if keeper.trusted_hash != *trusted_hash {
            set_codex_trust_hash(&mut documents[keeper.index], key, trusted_hash)?;
            rewritten.insert(keeper.index);
        }
    }

    if let Some(index) = features_section {
        set_codex_hooks_feature(&mut documents[index])?;
        rewritten.insert(index);
    }

    let mut output = String::with_capacity(content.len() + 256);
    for (index, section) in sections.iter().enumerate() {
        if removed.contains(&index) {
            continue;
        }
        if rewritten.contains(&index) {
            output.push_str(&documents[index].to_string());
        } else {
            output.push_str(section);
        }
    }

    if features_section.is_none() {
        output.push_str("\n[features]\nhooks = true\n");
    }
    for (key, trusted_hash) in states {
        if trust_sections.iter().any(|section| &section.key == key) {
            continue;
        }
        output.push_str("\n[hooks.state.\"");
        output.push_str(&toml_basic_string(key));
        output.push_str("\"]\ntrusted_hash = \"");
        output.push_str(&toml_basic_string(trusted_hash));
        output.push_str("\"\n");
    }
    Ok(output)
}

fn set_codex_trust_hash(
    document: &mut toml_edit::DocumentMut,
    key: &str,
    trusted_hash: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let state = codex_trust_state_table(document, false)?;
    let table = state
        .get_mut(key)
        .and_then(|item| item.as_table_like_mut())
        .ok_or_else(|| {
            format!("Refusing to rewrite Codex config: hooks.state.{key} is not a table")
        })?;
    table.insert("trusted_hash", toml_edit::value(trusted_hash));
    Ok(())
}

fn set_codex_hooks_feature(
    document: &mut toml_edit::DocumentMut,
) -> Result<(), Box<dyn std::error::Error>> {
    let features = document
        .get_mut("features")
        .and_then(|item| item.as_table_like_mut())
        .ok_or_else(|| "Refusing to rewrite Codex config: features is not a table".to_string())?;
    features.insert("hooks", toml_edit::value(true));
    Ok(())
}

/// Split a config into sections that each start at a table header. This only
/// locates section boundaries; every section is validated with the real parser
/// and the assembled file is re-validated before it is written.
fn split_codex_config_sections(content: &str) -> Vec<&str> {
    let mut sections = Vec::new();
    let mut section_start = 0;
    let mut line_start = 0;
    while line_start < content.len() {
        let line_end = content[line_start..]
            .find('\n')
            .map(|offset| line_start + offset + 1)
            .unwrap_or(content.len());
        if content[line_start..line_end].trim_start().starts_with('[') && section_start < line_start
        {
            sections.push(&content[section_start..line_start]);
            section_start = line_start;
        }
        line_start = line_end;
    }
    sections.push(&content[section_start..]);
    sections
}

fn ensure_codex_hooks_feature(
    document: &mut toml_edit::DocumentMut,
) -> Result<(), Box<dyn std::error::Error>> {
    let features = document
        .as_table_mut()
        .entry("features")
        .or_insert_with(|| toml_edit::Item::Table(toml_edit::Table::new()));
    let features = features
        .as_table_like_mut()
        .ok_or_else(|| "Codex config key `features` is not a table".to_string())?;
    features.insert("hooks", toml_edit::value(true));
    Ok(())
}

fn write_codex_config_backup(
    config_path: &Path,
    content: &[u8],
    backup_root: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    let dir = backup_root.join("codex");
    std::fs::create_dir_all(&dir)?;
    let timestamp = chrono::Utc::now().format("%Y%m%dT%H%M%S%.3fZ");
    let filename = config_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("config.toml");
    let path = dir.join(format!("{timestamp}-{}-{filename}", uuid::Uuid::new_v4()));
    // `create_new` keeps an earlier backup from ever being overwritten.
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)?;
    std::io::Write::write_all(&mut file, content)?;
    file.sync_all()?;
    Ok(())
}

fn write_codex_config_file(
    config_path: &Path,
    original: Option<&[u8]>,
    candidate: &[u8],
) -> Result<(), Box<dyn std::error::Error>> {
    let parent = config_path
        .parent()
        .ok_or_else(|| format!("Invalid Codex config path: {}", config_path.display()))?;
    let temp = parent.join(format!(
        ".{}.agent-island-{}.tmp",
        config_path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("config"),
        uuid::Uuid::new_v4()
    ));
    let write = (|| -> std::io::Result<()> {
        let mut file = std::fs::File::create(&temp)?;
        std::io::Write::write_all(&mut file, candidate)?;
        file.sync_all()
    })();
    if let Err(error) = write {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("Failed to write temporary Codex config: {error}").into());
    }

    // An external edit between the initial read and this point would otherwise
    // be silently replaced, so re-read before renaming over the original.
    let current = match std::fs::read(config_path) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            let _ = std::fs::remove_file(&temp);
            return Err(format!(
                "Failed to re-read Codex config {}: {error}",
                config_path.display()
            )
            .into());
        }
    };
    if current.as_deref() != original {
        let _ = std::fs::remove_file(&temp);
        return Err(format!(
            "Refusing to overwrite Codex config {}: it changed while the update was prepared",
            config_path.display()
        )
        .into());
    }

    if let Err(error) = std::fs::rename(&temp, config_path) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!(
            "Failed to replace Codex config {}: {error}",
            config_path.display()
        )
        .into());
    }
    Ok(())
}

fn toml_basic_string(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::process::ExitStatusExt;
    #[cfg(windows)]
    use std::os::windows::process::ExitStatusExt;

    fn adapter() -> CodexAdapter {
        CodexAdapter {
            config_root: PathBuf::from("/tmp/codex-test"),
            status: AdapterStatus::Available,
        }
    }

    fn success_status() -> std::process::ExitStatus {
        std::process::ExitStatus::from_raw(0)
    }

    fn trust_test_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "agent-island-codex-{label}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn trust_test_settings(hooks_path: &Path, command: &str) -> serde_json::Value {
        let mut settings = serde_json::json!({});
        CodexAdapter::inject_hooks_json(&mut settings, command);
        std::fs::write(hooks_path, serde_json::to_string_pretty(&settings).unwrap()).unwrap();
        settings
    }

    fn trust_key(hooks_path: &Path, event_key: &str) -> String {
        let source = hooks_path
            .canonicalize()
            .unwrap_or_else(|_| hooks_path.to_path_buf());
        format!("{}:{event_key}:0:0", source.to_string_lossy())
    }

    fn trust_state_hash(content: &str, key: &str) -> Option<String> {
        let document = content.parse::<toml_edit::DocumentMut>().ok()?;
        document
            .get("hooks")?
            .as_table_like()?
            .get("state")?
            .as_table_like()?
            .get(key)?
            .as_table_like()?
            .get("trusted_hash")?
            .as_str()
            .map(str::to_string)
    }

    fn run_codex_trust(
        hooks_path: &Path,
        config_path: &Path,
        settings: &serde_json::Value,
        command: &str,
        backup_root: &Path,
    ) {
        CodexAdapter::trust_codex_hooks(hooks_path, config_path, settings, command, backup_root)
            .unwrap();
    }

    #[test]
    fn codex_app_server_output_line_prefers_first_non_empty_line() {
        let output = std::process::Output {
            status: success_status(),
            stdout: b"\n  codex-cli 1.2.3\nignored".to_vec(),
            stderr: b"stderr".to_vec(),
        };

        assert_eq!(output_line(&output).as_deref(), Some("codex-cli 1.2.3"));
    }

    #[test]
    fn injects_codex_nested_hooks_json_format() {
        let mut settings = serde_json::json!({
            "hooks": {
                "SessionStart": [
                    { "hooks": [{ "type": "command", "command": "/bin/other" }] },
                    { "hooks": [{ "type": "command", "command": "/Users/me/.agentbro/bin/agentbro-bridge --source codex" }] }
                ]
            }
        });

        CodexAdapter::inject_hooks_json(
            &mut settings,
            "/Users/me/.agentbro/bin/agentbro-bridge --source codex",
        );

        let session_start = settings["hooks"]["SessionStart"].as_array().unwrap();
        assert_eq!(session_start.len(), 2);
        assert_eq!(
            session_start[1]["hooks"][0]["command"],
            "/Users/me/.agentbro/bin/agentbro-bridge --source codex"
        );
        assert_eq!(
            settings["hooks"]["PermissionRequest"][0]["hooks"][0]["timeout"],
            CODEX_PERMISSION_TIMEOUT_SECONDS
        );
        assert!(settings["hooks"]["UserPromptSubmit"].is_array());
        assert!(settings["hooks"]["SessionEnd"].is_array());
        assert!(settings["hooks"]["PostToolUseFailure"].is_array());
        assert!(settings["hooks"]["PermissionDenied"].is_array());
        assert!(settings["hooks"]["Notification"].is_array());
        assert!(settings["hooks"].get("StopFailure").is_none());
    }

    #[test]
    fn enables_codex_hooks_feature_without_dropping_existing_config() {
        let content = r#"model = "gpt-5"

[features]
goals = true

[projects."/tmp/example"]
trust_level = "trusted"
"#;
        let mut document = content.parse::<toml_edit::DocumentMut>().unwrap();

        apply_codex_trust_states(&mut document, &BTreeMap::new()).unwrap();
        let updated = document.to_string();

        assert!(updated.contains("[features]"));
        assert!(updated.contains("goals = true"));
        assert!(updated.contains("hooks = true"));
        assert!(updated.contains("[projects.\"/tmp/example\"]"));
    }

    #[test]
    fn parses_codex_pascal_session_start_as_codex_session() {
        let event = adapter()
            .parse_event(&serde_json::json!({
                "agent": "codex",
                "event": "SessionStart",
                "session_id": "s1",
                "cwd": "/tmp/agentbro",
                "tty": "/dev/ttys001"
            }))
            .unwrap();

        match event {
            AgentEvent::SessionStart {
                agent_type,
                project,
                ..
            } => {
                assert_eq!(agent_type, "codex");
                assert_eq!(project, "agentbro");
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[test]
    fn parses_openai_codex_alias_as_codex_session() {
        let event = adapter()
            .parse_event(&serde_json::json!({
                "agent": "openai.codex",
                "event": "SessionStart",
                "session_id": "s1",
                "cwd": "/tmp/agentbro"
            }))
            .unwrap();

        match event {
            AgentEvent::SessionStart { agent_type, .. } => {
                assert_eq!(agent_type, "codex");
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[test]
    fn parses_codex_tool_lifecycle() {
        let event = adapter()
            .parse_event(&serde_json::json!({
                "agent": "codex",
                "event": "PreToolUse",
                "session_id": "s1",
                "tool": "Bash",
                "tool_input": { "command": "pnpm test" }
            }))
            .unwrap();

        match event {
            AgentEvent::ToolUse {
                tool_name,
                tool_target,
                status,
                ..
            } => {
                assert_eq!(tool_name, "Bash");
                assert_eq!(tool_target.as_deref(), Some("pnpm test"));
                assert_eq!(status, "running");
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[test]
    fn marks_codex_failed_post_tool_use_from_tool_response() {
        let event = adapter()
            .parse_event(&serde_json::json!({
                "agent": "codex",
                "event": "PostToolUse",
                "session_id": "s1",
                "tool_name": "Bash",
                "tool_input": { "command": "pnpm test" },
                "tool_response": { "exit_code": 1, "stderr": "failed" }
            }))
            .unwrap();

        match event {
            AgentEvent::ToolUse { status, .. } => {
                assert_eq!(status, "error");
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[test]
    fn normalizes_codex_file_tools_with_targets() {
        let event = adapter()
            .parse_event(&serde_json::json!({
                "agent": "codex",
                "event": "PreToolUse",
                "session_id": "s1",
                "tool_name": "read_file",
                "tool_input": { "path": "src/components/notch/HoverList.tsx" }
            }))
            .unwrap();

        match event {
            AgentEvent::ToolUse {
                tool_name,
                tool_target,
                status,
                ..
            } => {
                assert_eq!(tool_name, "Read");
                assert_eq!(tool_target.as_deref(), Some("HoverList.tsx"));
                assert_eq!(status, "running");
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[test]
    fn normalizes_codex_namespaced_subagent_tools() {
        let event = adapter()
            .parse_event(&serde_json::json!({
                "agent": "codex",
                "event": "PreToolUse",
                "session_id": "s1",
                "tool_name": "multi_agent_v1.spawn_agent",
                "tool_input": { "message": "请只计算 1+1" }
            }))
            .unwrap();

        match event {
            AgentEvent::ToolUse {
                tool_name,
                tool_target,
                status,
                ..
            } => {
                assert_eq!(tool_name, "Agent");
                assert_eq!(tool_target.as_deref(), Some("请只计算 1+1"));
                assert_eq!(status, "running");
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[test]
    fn extracts_codex_patch_target_and_change_counts() {
        let event = adapter()
            .parse_event(&serde_json::json!({
                "agent": "codex",
                "event": "PreToolUse",
                "session_id": "s1",
                "tool_name": "apply_patch",
                "tool_input": {
                    "command": "*** Begin Patch\n*** Update File: src/components/overlay/OverlayFeedbackPanel.tsx\n@@\n-old\n+new\n+again\n*** End Patch\n"
                }
            }))
            .unwrap();

        match event {
            AgentEvent::ToolUse {
                tool_name,
                tool_target,
                ..
            } => {
                assert_eq!(tool_name, "Edit");
                assert_eq!(
                    tool_target.as_deref(),
                    Some("OverlayFeedbackPanel.tsx +2 -1")
                );
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[test]
    fn parses_codex_stop_last_assistant_message() {
        let event = adapter()
            .parse_event(&serde_json::json!({
                "agent": "codex",
                "event": "Stop",
                "session_id": "s1",
                "last_assistant_message": "Fixed the layout."
            }))
            .unwrap();

        match event {
            AgentEvent::AssistantResponseComplete { text, .. } => {
                assert_eq!(text, "Fixed the layout.");
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[test]
    fn keeps_literal_quoted_trust_state_and_updates_only_the_hash() {
        let dir = trust_test_dir("trust-literal");
        let hooks_path = dir.join("hooks.json");
        let config_path = dir.join("config.toml");
        let backup_root = dir.join("backups");
        let command = "C:\\Users\\me\\.agent-island\\bin\\agent-island-bridge.exe --source codex";
        let settings = trust_test_settings(&hooks_path, command);
        let key = trust_key(&hooks_path, "session_start");
        let third_party = "C:\\Other\\hooks.json:stop:0:0";
        std::fs::write(
            &config_path,
            format!(
                "model = \"gpt-5\"\n\n[hooks.state.'{key}']\ntrusted_hash = \"sha256:stale\"\n\n[hooks.state.'{third_party}']\ntrusted_hash = \"sha256:third-party\"\n"
            ),
        )
        .unwrap();

        run_codex_trust(&hooks_path, &config_path, &settings, command, &backup_root);

        let content = std::fs::read_to_string(&config_path).unwrap();
        assert!(
            content.contains(&format!("[hooks.state.'{key}']")),
            "{content}"
        );
        assert!(
            !content.contains(&format!("[hooks.state.\"{}\"]", toml_basic_string(&key))),
            "{content}"
        );
        let hash = trust_state_hash(&content, &key).expect("state must be present exactly once");
        assert_ne!(hash, "sha256:stale");
        assert!(content.contains(&format!(
            "[hooks.state.'{third_party}']\ntrusted_hash = \"sha256:third-party\""
        )));
        assert!(content.contains("model = \"gpt-5\""));
        assert!(content.contains("[features]\nhooks = true"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn codex_trust_state_dedupes_duplicate_quote_styles_and_stays_idempotent() {
        let dir = trust_test_dir("trust-idempotent");
        let hooks_path = dir.join("hooks.json");
        let config_path = dir.join("config.toml");
        let backup_root = dir.join("backups");
        let command = "C:\\Users\\me\\.agent-island\\bin\\agent-island-bridge.exe --source codex";
        let settings = trust_test_settings(&hooks_path, command);
        let key = trust_key(&hooks_path, "session_start");
        std::fs::write(
            &config_path,
            format!(
                "[features]\nhooks = true\n\n[hooks.state.'{key}']\ntrusted_hash = \"sha256:same\"\n\n[hooks.state.\"{}\"]\ntrusted_hash = \"sha256:same\"\n",
                toml_basic_string(&key)
            ),
        )
        .unwrap();

        run_codex_trust(&hooks_path, &config_path, &settings, command, &backup_root);
        let first = std::fs::read_to_string(&config_path).unwrap();
        assert!(first.contains(&format!("[hooks.state.'{key}']")), "{first}");
        assert!(
            !first.contains(&format!("[hooks.state.\"{}\"]", toml_basic_string(&key))),
            "{first}"
        );
        assert!(trust_state_hash(&first, &key).is_some(), "{first}");
        let backups_after_first = std::fs::read_dir(backup_root.join("codex"))
            .unwrap()
            .count();
        assert_eq!(backups_after_first, 1);

        run_codex_trust(&hooks_path, &config_path, &settings, command, &backup_root);
        let second = std::fs::read_to_string(&config_path).unwrap();
        assert_eq!(first, second);
        assert_eq!(
            std::fs::read_dir(backup_root.join("codex"))
                .unwrap()
                .count(),
            backups_after_first
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn codex_trust_state_prefers_literal_key_when_the_basic_spelling_comes_first() {
        let dir = trust_test_dir("trust-literal-second");
        let hooks_path = dir.join("hooks.json");
        let config_path = dir.join("config.toml");
        let backup_root = dir.join("backups");
        let command = "C:\\Users\\me\\.agent-island\\bin\\agent-island-bridge.exe --source codex";
        let settings = trust_test_settings(&hooks_path, command);
        let key = trust_key(&hooks_path, "session_start");
        std::fs::write(
            &config_path,
            format!(
                "[features]\nhooks = true\n\n[hooks.state.\"{}\"]\ntrusted_hash = \"sha256:same\"\nnote = \"keep-me\"\n\n[hooks.state.'{key}']\ntrusted_hash = \"sha256:same\"\nnote = \"keep-me\"\n",
                toml_basic_string(&key)
            ),
        )
        .unwrap();

        run_codex_trust(&hooks_path, &config_path, &settings, command, &backup_root);

        let first = std::fs::read_to_string(&config_path).unwrap();
        first
            .parse::<toml_edit::DocumentMut>()
            .expect("merged config must parse");
        assert!(first.contains(&format!("[hooks.state.'{key}']")), "{first}");
        assert!(
            !first.contains(&format!("[hooks.state.\"{}\"]", toml_basic_string(&key))),
            "{first}"
        );
        assert_eq!(
            first.matches("note = \"keep-me\"").count(),
            1,
            "the unknown field must survive exactly once:\n{first}"
        );
        assert_ne!(trust_state_hash(&first, &key).unwrap(), "sha256:same");

        run_codex_trust(&hooks_path, &config_path, &settings, command, &backup_root);
        let second = std::fs::read_to_string(&config_path).unwrap();
        assert_eq!(first, second);
        assert_eq!(
            std::fs::read_dir(backup_root.join("codex"))
                .unwrap()
                .count(),
            1
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn codex_trust_state_conflicting_duplicate_hashes_abort_without_writing() {
        let dir = trust_test_dir("trust-conflict");
        let hooks_path = dir.join("hooks.json");
        let config_path = dir.join("config.toml");
        let backup_root = dir.join("backups");
        let command = "C:\\Users\\me\\.agent-island\\bin\\agent-island-bridge.exe --source codex";
        let settings = trust_test_settings(&hooks_path, command);
        let key = trust_key(&hooks_path, "session_start");
        let original = format!(
            "[hooks.state.'{key}']\ntrusted_hash = \"sha256:first\"\n\n[hooks.state.\"{}\"]\ntrusted_hash = \"sha256:second\"\n",
            toml_basic_string(&key)
        );
        std::fs::write(&config_path, &original).unwrap();

        let error = CodexAdapter::trust_codex_hooks(
            &hooks_path,
            &config_path,
            &settings,
            command,
            &backup_root,
        )
        .unwrap_err();

        assert!(error.to_string().contains("trusted_hash"), "{error}");
        assert_eq!(std::fs::read_to_string(&config_path).unwrap(), original);
        assert!(
            !backup_root.exists(),
            "a rejected write must not leave a backup behind"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn codex_trust_state_refuses_duplicates_that_carry_unmergeable_fields() {
        let dir = trust_test_dir("trust-extra-refuse");
        let hooks_path = dir.join("hooks.json");
        let config_path = dir.join("config.toml");
        let backup_root = dir.join("backups");
        let command = "C:\\Users\\me\\.agent-island\\bin\\agent-island-bridge.exe --source codex";
        let settings = trust_test_settings(&hooks_path, command);
        let key = trust_key(&hooks_path, "session_start");
        let original = format!(
            "[hooks.state.'{key}']\ntrusted_hash = \"sha256:same\"\nnote = \"literal\"\n\n[hooks.state.\"{}\"]\ntrusted_hash = \"sha256:same\"\nnote = \"basic\"\n",
            toml_basic_string(&key)
        );
        std::fs::write(&config_path, &original).unwrap();

        let error = CodexAdapter::trust_codex_hooks(
            &hooks_path,
            &config_path,
            &settings,
            command,
            &backup_root,
        )
        .unwrap_err();

        assert!(error.to_string().contains("different fields"), "{error}");
        assert_eq!(std::fs::read_to_string(&config_path).unwrap(), original);
        assert!(!backup_root.exists());

        let removed_field_only = format!(
            "[hooks.state.'{key}']\ntrusted_hash = \"sha256:same\"\n\n[hooks.state.\"{}\"]\ntrusted_hash = \"sha256:same\"\nnote = \"keep-me\"\n",
            toml_basic_string(&key)
        );
        std::fs::write(&config_path, &removed_field_only).unwrap();

        let error = CodexAdapter::trust_codex_hooks(
            &hooks_path,
            &config_path,
            &settings,
            command,
            &backup_root,
        )
        .unwrap_err();

        assert!(error.to_string().contains("different fields"), "{error}");
        assert_eq!(
            std::fs::read_to_string(&config_path).unwrap(),
            removed_field_only
        );
        assert!(!backup_root.exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn codex_trust_state_preserves_unknown_fields_while_deduping() {
        let dir = trust_test_dir("trust-extra-keep");
        let hooks_path = dir.join("hooks.json");
        let config_path = dir.join("config.toml");
        let backup_root = dir.join("backups");
        let command = "C:\\Users\\me\\.agent-island\\bin\\agent-island-bridge.exe --source codex";
        let settings = trust_test_settings(&hooks_path, command);
        let first = trust_key(&hooks_path, "session_start");
        let second = trust_key(&hooks_path, "stop");
        std::fs::write(
            &config_path,
            format!(
                "[hooks.state.'{first}']\ntrusted_hash = \"sha256:same\"\nnote = \"keep-me\"\n\n[hooks.state.\"{}\"]\ntrusted_hash = \"sha256:same\"\nnote = \"keep-me\"\n\n[hooks.state.'{second}']\ntrusted_hash = \"sha256:same\"\nnote = \"keeper-only\"\n\n[hooks.state.\"{}\"]\ntrusted_hash = \"sha256:same\"\n",
                toml_basic_string(&first),
                toml_basic_string(&second),
            ),
        )
        .unwrap();

        run_codex_trust(&hooks_path, &config_path, &settings, command, &backup_root);

        let content = std::fs::read_to_string(&config_path).unwrap();
        content
            .parse::<toml_edit::DocumentMut>()
            .expect("merged config must parse");
        for key in [&first, &second] {
            assert_eq!(
                content.matches(&format!("[hooks.state.'{key}']")).count(),
                1,
                "key {key} was not deduped:\n{content}"
            );
            assert!(
                !content.contains(&format!("[hooks.state.\"{}\"]", toml_basic_string(key))),
                "key {key} kept a basic duplicate:\n{content}"
            );
        }
        assert_eq!(
            content.matches("note = \"keep-me\"").count(),
            1,
            "{content}"
        );
        assert!(content.contains("note = \"keeper-only\""), "{content}");
        assert_ne!(trust_state_hash(&content, &first).unwrap(), "sha256:same");
        assert_ne!(trust_state_hash(&content, &second).unwrap(), "sha256:same");

        run_codex_trust(&hooks_path, &config_path, &settings, command, &backup_root);
        assert_eq!(std::fs::read_to_string(&config_path).unwrap(), content);
        assert_eq!(
            std::fs::read_dir(backup_root.join("codex"))
                .unwrap()
                .count(),
            1
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn codex_trust_state_repairs_duplicates_for_every_managed_event() {
        let dir = trust_test_dir("trust-all-events");
        let hooks_path = dir.join("hooks.json");
        let config_path = dir.join("config.toml");
        let backup_root = dir.join("backups");
        let command = "C:\\Users\\me\\.agent-island\\bin\\agent-island-bridge.exe --source codex";
        let settings = trust_test_settings(&hooks_path, command);
        let keys = HOOK_EVENTS
            .iter()
            .map(|(_, event_key, _)| trust_key(&hooks_path, event_key))
            .collect::<Vec<_>>();
        let mut seeded = String::from("[features]\nhooks = true\n");
        for key in &keys {
            seeded.push_str(&format!(
                "\n[hooks.state.'{key}']\ntrusted_hash = \"sha256:same\"\n\n[hooks.state.\"{}\"]\ntrusted_hash = \"sha256:same\"\n",
                toml_basic_string(key)
            ));
        }
        std::fs::write(&config_path, &seeded).unwrap();

        run_codex_trust(&hooks_path, &config_path, &settings, command, &backup_root);

        let content = std::fs::read_to_string(&config_path).unwrap();
        content
            .parse::<toml_edit::DocumentMut>()
            .expect("repaired config must parse");
        for key in &keys {
            assert!(
                trust_state_hash(&content, key).is_some(),
                "key {key} was not kept:\n{content}"
            );
            assert_eq!(
                content.matches(&format!("[hooks.state.'{key}']")).count(),
                1,
                "key {key} was not deduped:\n{content}"
            );
            assert!(
                !content.contains(&format!("[hooks.state.\"{}\"]", toml_basic_string(key))),
                "key {key} kept a basic duplicate:\n{content}"
            );
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn keeps_array_of_tables_after_a_repaired_trust_state() {
        let dir = trust_test_dir("trust-aot");
        let hooks_path = dir.join("hooks.json");
        let config_path = dir.join("config.toml");
        let backup_root = dir.join("backups");
        let command = "C:\\Users\\me\\.agent-island\\bin\\agent-island-bridge.exe --source codex";
        let settings = trust_test_settings(&hooks_path, command);
        let key = trust_key(&hooks_path, "session_start");
        std::fs::write(
            &config_path,
            format!(
                "[hooks.state.'{key}']\ntrusted_hash = \"sha256:same\"\n\n[hooks.state.\"{}\"]\ntrusted_hash = \"sha256:same\"\n\n[[projects]]\nname = \"one\"\n\n[[projects]]\nname = \"two\"\n",
                toml_basic_string(&key)
            ),
        )
        .unwrap();

        run_codex_trust(&hooks_path, &config_path, &settings, command, &backup_root);

        let content = std::fs::read_to_string(&config_path).unwrap();
        let document = content
            .parse::<toml_edit::DocumentMut>()
            .expect("config must parse after merge");
        let projects = document
            .get("projects")
            .and_then(|item| item.as_array_of_tables())
            .expect("[[projects]] must survive the rewrite");
        assert_eq!(projects.iter().count(), 2);
        assert!(content.contains("name = \"one\""), "{content}");
        assert!(content.contains("name = \"two\""), "{content}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn refuses_to_write_when_the_candidate_stays_invalid() {
        let dir = trust_test_dir("trust-invalid");
        let hooks_path = dir.join("hooks.json");
        let config_path = dir.join("config.toml");
        let backup_root = dir.join("backups");
        let command = "C:\\Users\\me\\.agent-island\\bin\\agent-island-bridge.exe --source codex";
        let settings = trust_test_settings(&hooks_path, command);
        let original = "root.value = 1\n\n[root]\nother = 2\n";
        std::fs::write(&config_path, original).unwrap();

        let error = CodexAdapter::trust_codex_hooks(
            &hooks_path,
            &config_path,
            &settings,
            command,
            &backup_root,
        )
        .unwrap_err();

        assert!(
            error.to_string().contains("invalid Codex config"),
            "{error}"
        );
        assert_eq!(std::fs::read_to_string(&config_path).unwrap(), original);
        assert!(!backup_root.exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn read_failure_is_not_treated_as_an_empty_config() {
        let dir = trust_test_dir("trust-read-failure");
        let hooks_path = dir.join("hooks.json");
        let config_path = dir.join("config.toml");
        let backup_root = dir.join("backups");
        let command = "C:\\Users\\me\\.agent-island\\bin\\agent-island-bridge.exe --source codex";
        let settings = trust_test_settings(&hooks_path, command);
        std::fs::create_dir_all(&config_path).unwrap();

        let error = CodexAdapter::trust_codex_hooks(
            &hooks_path,
            &config_path,
            &settings,
            command,
            &backup_root,
        )
        .unwrap_err();

        assert!(
            error.to_string().contains("Failed to read Codex config"),
            "{error}"
        );
        assert!(
            config_path.is_dir(),
            "the unreadable path must be untouched"
        );
        assert!(!backup_root.exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn codex_config_write_aborts_when_the_file_changed_underneath() {
        let dir = trust_test_dir("trust-concurrent");
        let config_path = dir.join("config.toml");
        std::fs::write(&config_path, "external = true\n").unwrap();

        let error = write_codex_config_file(
            &config_path,
            Some(b"stale revision\n"),
            b"candidate = true\n",
        )
        .unwrap_err();

        assert!(
            error.to_string().contains("changed while the update"),
            "{error}"
        );
        assert_eq!(
            std::fs::read_to_string(&config_path).unwrap(),
            "external = true\n"
        );
        assert!(
            std::fs::read_dir(&dir).unwrap().all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".tmp")),
            "temporary file must be cleaned up"
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn codex_trust_backups_never_overwrite_an_existing_backup() {
        let dir = trust_test_dir("trust-backup");
        let config_path = dir.join("config.toml");
        let backup_root = dir.join("backups");

        write_codex_config_backup(&config_path, b"first revision", &backup_root).unwrap();
        write_codex_config_backup(&config_path, b"second revision", &backup_root).unwrap();

        let mut backups = std::fs::read_dir(backup_root.join("codex"))
            .unwrap()
            .map(|entry| std::fs::read_to_string(entry.unwrap().path()).unwrap())
            .collect::<Vec<_>>();
        backups.sort();
        assert_eq!(
            backups,
            vec!["first revision".to_string(), "second revision".to_string()]
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn creates_a_missing_codex_config_without_a_backup() {
        let dir = trust_test_dir("trust-missing");
        let hooks_path = dir.join("hooks.json");
        let config_path = dir.join("config.toml");
        let backup_root = dir.join("backups");
        let command = "C:\\Users\\me\\.agent-island\\bin\\agent-island-bridge.exe --source codex";
        let settings = trust_test_settings(&hooks_path, command);
        let key = trust_key(&hooks_path, "session_start");

        run_codex_trust(&hooks_path, &config_path, &settings, command, &backup_root);

        let content = std::fs::read_to_string(&config_path).unwrap();
        assert!(content.contains("[features]\nhooks = true"), "{content}");
        assert!(trust_state_hash(&content, &key).is_some(), "{content}");
        assert!(!backup_root.exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn parses_codex_notification_message() {
        let event = adapter()
            .parse_event(&serde_json::json!({
                "agent": "codex",
                "event": "Notification",
                "session_id": "s1",
                "message": "Waiting for input",
                "status": "waiting_for_input"
            }))
            .unwrap();

        match event {
            AgentEvent::Notification {
                message, status, ..
            } => {
                assert_eq!(message, "Waiting for input");
                assert_eq!(status.as_deref(), Some("waiting_for_input"));
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }
}
