// Tauri IPC Commands — Bridge between frontend and Rust backend

pub mod buddy;
pub mod dispatch;
pub mod monitor;
pub mod persistence;

use crate::agents::{AdapterInfo, AgentAdapter};
use crate::config::{AppConfig, ConfigStore};
use crate::energy::{self, EnergyMode};
use crate::hook_endpoint;
use crate::hooks::conversation_parser::{
    all_projects_dirs, discover_codex_session_file, discover_session_file_in_dirs,
    extract_latest_assistant_text, extract_session_title, extract_subagents_from_transcript,
    ChatRole, MessageBlock, ParsedMessage, TranscriptSubagentInfo,
};
use crate::hooks::diagnostics::DiagnosticRingBuffer;
use crate::hooks::file_watcher::ConversationWatcher;
use crate::hooks::server::{HookServer, RawHookEvent};
use crate::hooks::session_store::{
    AgentStatusSnapshot, RateLimitInfo, SessionPhase, SessionState, SessionStore, SubagentInfo,
    TokenUsage,
};
use crate::platform::display_controller::DisplayController;
use crate::sound::SoundEngine;
use crate::telemetry::TelemetryService;
use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io::{BufRead, BufReader as StdBufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use tauri::{Manager, State};
use tokio::net::TcpStream;
use tokio::process::Child;
use tokio::sync::{mpsc, oneshot, Mutex as TokioMutex};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

type CodexWsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;
type CodexWsSink = SplitSink<CodexWsStream, Message>;
type CodexWsSource = SplitStream<CodexWsStream>;

/// Shared app state accessible from Tauri commands
pub struct AppState {
    pub session_store: Arc<SessionStore>,
    pub hook_server: Arc<HookServer>,
    pub codex_app_server: Arc<CodexAppServerBridge>,
    pub config_store: ConfigStore,
    pub adapters: Vec<Arc<dyn AgentAdapter>>,
    pub sound_engine: Option<Arc<SoundEngine>>,
    /// Conversation file watcher — watches JSONL files for real-time chat updates.
    /// Wrapped in Mutex because RecommendedWatcher is not Sync on all platforms.
    pub conversation_watcher: Arc<Mutex<Option<ConversationWatcher>>>,
    pub display_controller: Arc<DisplayController>,
    pub diagnostic_buffer: Arc<DiagnosticRingBuffer>,
    pub task_db: Arc<crate::control_tower::ControlTowerDatabase>,
    pub telemetry: Arc<TelemetryService>,
    #[allow(dead_code)]
    pub tray_icon: tauri::tray::TrayIcon,
}

#[derive(Clone)]
pub struct CodexAppServerBridge {
    tx: Arc<TokioMutex<Option<mpsc::UnboundedSender<CodexAppServerCommand>>>>,
}

/// Global handle to the live Codex app-server bridge. Set once during app
/// setup so utility paths (rate-limit fetch, future ad-hoc RPC calls) can
/// reuse the persistent WebSocket connection without threading the bridge
/// through every caller.
static CODEX_APP_SERVER_BRIDGE_HANDLE: OnceLock<Arc<CodexAppServerBridge>> = OnceLock::new();

pub fn register_codex_app_server_bridge(bridge: Arc<CodexAppServerBridge>) {
    let _ = CODEX_APP_SERVER_BRIDGE_HANDLE.set(bridge);
}

pub(crate) fn global_codex_app_server_bridge() -> Option<Arc<CodexAppServerBridge>> {
    CODEX_APP_SERVER_BRIDGE_HANDLE.get().cloned()
}

impl Default for CodexAppServerBridge {
    fn default() -> Self {
        Self::new()
    }
}

impl CodexAppServerBridge {
    pub fn new() -> Self {
        Self {
            tx: Arc::new(TokioMutex::new(None)),
        }
    }

    async fn attach(&self, tx: mpsc::UnboundedSender<CodexAppServerCommand>) {
        *self.tx.lock().await = Some(tx);
    }

    async fn detach(&self) {
        *self.tx.lock().await = None;
    }

    /// Ask the live app-server for the latest account rate limits. Returns
    /// `Ok(None)` when the bridge isn't attached so the caller can fall back
    /// to a one-off stdio spawn.
    pub async fn fetch_rate_limits(&self) -> Result<Option<serde_json::Value>, String> {
        let (reply_tx, reply_rx) = oneshot::channel();
        let command = CodexAppServerCommand::RateLimits { reply: reply_tx };
        let Some(tx) = self.tx.lock().await.clone() else {
            return Ok(None);
        };
        if tx.send(command).is_err() {
            self.detach().await;
            return Ok(None);
        }
        let value = reply_rx
            .await
            .map_err(|_| "Codex app-server monitor stopped before responding".to_string())??;
        Ok(Some(value))
    }

    /// Returns true when an app-server monitor is currently connected.
    /// Cheap read surfaced to the task board so it can show live sync state.
    pub fn is_attached(&self) -> bool {
        self.tx
            .try_lock()
            .map(|guard| guard.is_some())
            .unwrap_or(false)
    }
}

enum CodexAppServerCommand {
    RateLimits {
        reply: oneshot::Sender<Result<serde_json::Value, String>>,
    },
}

enum CodexAppServerOutgoingRequest {
    ThreadList,
    RateLimits {
        reply: oneshot::Sender<Result<serde_json::Value, String>>,
    },
}

// ── Session Commands ──────────────────────────────────────────────

#[tauri::command]
pub async fn get_sessions(state: State<'_, AppState>) -> Result<Vec<SessionState>, String> {
    // Codex Desktop writes its live rollout directly to ~/.codex/sessions but
    // does not reliably invoke Vibe Board's CLI hook. Refresh that local
    // source before returning the snapshot used by the panel.
    sync_local_codex_rollouts_to_store(&state.session_store);
    let sessions = state.session_store.get_all_sessions();
    for session in &sessions {
        hydrate_subagents_for_session(&state.session_store, session);
    }
    Ok(state.session_store.get_all_sessions())
}

#[tauri::command]
pub async fn get_usage_rate_limits(
    state: State<'_, AppState>,
) -> Result<Option<RateLimitInfo>, String> {
    if !state.config_store.get().usage_query_enabled {
        return Ok(None);
    }
    let mut latest = crate::usage::load_latest_usage_rate_limits().await;
    for snapshot in state.session_store.get_agent_status_snapshots() {
        let Some(rate_limits) = snapshot.rate_limits else {
            continue;
        };
        let is_newer = latest
            .as_ref()
            .map(|current| {
                rate_limits.updated_at.unwrap_or_default() > current.updated_at.unwrap_or_default()
            })
            .unwrap_or(true);
        if is_newer {
            latest = Some(rate_limits);
        }
    }
    Ok(latest)
}

#[tauri::command]
pub async fn get_usage_snapshots(state: State<'_, AppState>) -> Result<Vec<RateLimitInfo>, String> {
    if !state.config_store.get().usage_query_enabled {
        return Ok(Vec::new());
    }
    let mut snapshots = crate::usage::load_usage_snapshots().await;
    for snapshot in state.session_store.get_agent_status_snapshots() {
        let Some(rate_limits) = snapshot.rate_limits else {
            continue;
        };
        let Some(provider) = rate_limits.provider.as_deref() else {
            continue;
        };
        if let Some(current) = snapshots
            .iter_mut()
            .find(|current| current.provider.as_deref() == Some(provider))
        {
            if rate_limits.updated_at.unwrap_or_default() > current.updated_at.unwrap_or_default() {
                *current = rate_limits;
            }
        } else {
            snapshots.push(rate_limits);
        }
    }
    Ok(snapshots)
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStateFlags {
    /// True when an active Codex app-server WebSocket bridge is attached
    /// (i.e. background sync is running and connected). Frontend uses this
    /// to decide whether Codex.app sessions expose a sendable composer.
    pub codex_app_server_live: bool,
}

#[tauri::command]
pub fn get_app_state_flags(state: State<'_, AppState>) -> AppStateFlags {
    AppStateFlags {
        codex_app_server_live: state.codex_app_server.is_attached(),
    }
}

pub fn start_codex_app_server_background_sync(
    config_store: ConfigStore,
    session_store: Arc<SessionStore>,
    bridge: Arc<CodexAppServerBridge>,
) {
    tauri::async_runtime::spawn(async move {
        if resolve_codex_binary().is_none() {
            log::info!("Codex CLI not found; app-server monitor disabled");
            return;
        }

        let mut backoff = Duration::ZERO;
        let mut last_error: Option<String> = None;
        loop {
            let config = config_store.get();
            if !config.codex_app_server_sync_enabled {
                bridge.detach().await;
                tokio::time::sleep(Duration::from_secs(30)).await;
                continue;
            }

            match run_codex_app_server_monitor_once(
                config_store.clone(),
                session_store.clone(),
                bridge.clone(),
            )
            .await
            {
                Ok(()) => {
                    if last_error.is_some() {
                        log::info!("Codex app-server background sync recovered");
                    }
                    last_error = None;
                    backoff = Duration::ZERO;
                }
                Err(err) => {
                    if last_error.as_deref() != Some(err.as_str()) {
                        log::warn!("Codex app-server monitor failed: {}", err);
                        last_error = Some(err.clone());
                    }
                    bridge.detach().await;
                    backoff = crate::agents::codex_app_server::next_backoff(backoff);
                    tokio::time::sleep(backoff).await;
                }
            }
        }
    });
}

fn codex_app_server_refresh_interval_seconds(
    store: &SessionStore,
    configured_seconds: u32,
) -> (EnergyMode, u64) {
    let mode = energy::mode_for_sessions(&store.get_all_sessions());
    let interval = energy::interval_seconds(mode, configured_seconds, 5, 60, 300);
    (mode, interval)
}

/// Return live presence for the main CLI integrations together with the last
/// persisted token/quota snapshot. A hook session is the authoritative signal
/// when available; the process tree covers an invoked CLI that has not emitted
/// its first hook yet.
#[tauri::command]
pub async fn get_agent_statuses(
    state: State<'_, AppState>,
) -> Result<Vec<AgentStatusSnapshot>, String> {
    const TRACKED_AGENTS: [(&str, &str); 4] = [
        ("codex", "Codex"),
        ("claude-code", "Claude Code"),
        ("opencode", "OpenCode"),
        ("antigravity", "Antigravity"),
    ];

    let opencode_rate_limits = if state.config_store.get().usage_query_enabled {
        crate::usage::opencode::load_rate_limits().await
    } else {
        None
    };
    let antigravity_rate_limits = if state.config_store.get().usage_query_enabled {
        crate::usage::antigravity::load_rate_limits().await
    } else {
        None
    };
    let mut statuses = state
        .session_store
        .get_agent_status_snapshots()
        .into_iter()
        .map(|snapshot| (snapshot.agent.clone(), snapshot))
        .collect::<HashMap<_, _>>();
    // `online` is runtime state, not durable history. A snapshot loaded after
    // restart must start offline until a live session or process confirms it.
    for snapshot in statuses.values_mut() {
        snapshot.online = false;
    }
    let now = chrono::Utc::now().timestamp_millis();
    for (agent, label) in TRACKED_AGENTS {
        statuses
            .entry(agent.to_string())
            .or_insert_with(|| AgentStatusSnapshot {
                agent: agent.to_string(),
                label: label.to_string(),
                online: false,
                last_seen_at: 0,
                last_completed_at: None,
                tokens: TokenUsage::default(),
                rate_limits: None,
                detail: None,
            });
    }

    for session in state.session_store.get_all_sessions() {
        let Some(snapshot) = statuses.get_mut(&session.agent_type) else {
            continue;
        };
        snapshot.online = !matches!(
            session.phase,
            SessionPhase::Done | SessionPhase::Error | SessionPhase::Interrupted
        );
        if snapshot.last_seen_at == 0 {
            snapshot.last_seen_at = now;
        }
        snapshot.tokens = session.tokens;
        if session.rate_limits.is_some() {
            snapshot.rate_limits = session.rate_limits;
        }
        if let Some(label) = session.engine_label {
            snapshot.label = label;
        }
    }

    let process_tree = crate::terminal::process_tree::build_tree();
    for (agent, snapshot) in &mut statuses {
        if process_tree
            .values()
            .any(|process| process_matches_agent(&process.command, agent))
        {
            snapshot.online = true;
        }
    }

    if let Some(rate_limits) = opencode_rate_limits {
        if let Some(status) = statuses.get_mut("opencode") {
            status.rate_limits = Some(rate_limits);
            status.detail = Some("OpenCode Go account quota synced".to_string());
        }
    }

    if let Some(rate_limits) = antigravity_rate_limits {
        if let Some(status) = statuses.get_mut("antigravity") {
            status.rate_limits = Some(rate_limits);
            status.detail = Some("Antigravity /usage quota synced".to_string());
        }
    }

    let mut result = statuses.into_values().collect::<Vec<_>>();
    result.sort_by_key(|snapshot| tracked_agent_rank(&snapshot.agent));
    state.session_store.persist_agent_status_snapshots(&result);
    Ok(result)
}

fn tracked_agent_rank(agent: &str) -> usize {
    match agent {
        "codex" => 0,
        "claude-code" => 1,
        "opencode" => 2,
        "antigravity" => 3,
        _ => 99,
    }
}

fn process_matches_agent(command: &str, agent: &str) -> bool {
    let command = command.to_ascii_lowercase();
    match agent {
        "codex" => {
            command.contains("codex.exe") || command == "codex" || command.ends_with("/codex")
        }
        "claude-code" => {
            command.contains("claude.exe") || command == "claude" || command.ends_with("/claude")
        }
        "opencode" => {
            command.contains("opencode.exe")
                || command == "opencode"
                || command.ends_with("/opencode")
        }
        "antigravity" => {
            command.contains("agy.exe")
                || command.contains("antigravity.exe")
                || command == "agy"
                || command.ends_with("/agy")
        }
        _ => false,
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAppServerThreadSummary {
    id: String,
    name: Option<String>,
    preview: Option<String>,
    cwd: Option<String>,
    status: Option<String>,
    phase: String,
    updated_at: Option<i64>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexAppServerSyncReport {
    total: usize,
    synced: usize,
    read: usize,
    errors: Vec<String>,
    threads: Vec<CodexAppServerThreadSummary>,
}

async fn shutdown_codex_app_server_child(child: &mut Child) {
    if child.try_wait().ok().flatten().is_none() {
        let _ = child.start_kill();
        let _ = child.wait().await;
    }
}

async fn write_ws_json(sink: &mut CodexWsSink, payload: serde_json::Value) -> Result<(), String> {
    let message = crate::agents::codex_app_server::json_message(&payload)?;
    sink.send(message)
        .await
        .map_err(|err| format!("Failed to write to codex app-server WebSocket: {err}"))
}

async fn read_ws_until_id(
    stream: &mut CodexWsSource,
    expected_id: i64,
) -> Result<serde_json::Value, String> {
    while let Some(message) = stream.next().await {
        let message = message.map_err(|err| format!("codex app-server WebSocket error: {err}"))?;
        let text = match message {
            Message::Text(text) => text,
            Message::Binary(_) | Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => {
                continue
            }
            Message::Close(_) => {
                return Err("codex app-server closed the WebSocket".to_string());
            }
        };
        let value: serde_json::Value = serde_json::from_str(&text)
            .map_err(|err| format!("Invalid codex app-server JSON: {err}"))?;
        if value.get("id").and_then(|id| id.as_i64()) != Some(expected_id) {
            continue;
        }
        if let Some(error) = value.get("error") {
            let message = error
                .get("message")
                .and_then(|message| message.as_str())
                .unwrap_or("Codex app-server request failed");
            return Err(message.to_string());
        }
        return Ok(value);
    }
    Err("codex app-server closed before responding".to_string())
}

async fn initialize_codex_app_server_ws(
    sink: &mut CodexWsSink,
    stream: &mut CodexWsSource,
) -> Result<(), String> {
    write_ws_json(
        sink,
        serde_json::json!({
            "id": 1,
            "method": "initialize",
            "params": {
                "clientInfo": {
                    "name": "Vibe Board",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }
        }),
    )
    .await?;
    read_ws_until_id(stream, 1).await?;

    write_ws_json(
        sink,
        serde_json::json!({
            "method": "initialized",
            "params": {}
        }),
    )
    .await
}

async fn run_codex_app_server_monitor_once(
    config_store: ConfigStore,
    store: Arc<SessionStore>,
    bridge: Arc<CodexAppServerBridge>,
) -> Result<(), String> {
    let binary = resolve_codex_binary()
        .ok_or_else(|| "Could not find codex CLI for app-server".to_string())?;
    let mut connection = crate::agents::codex_app_server::spawn_and_connect_app_server(
        &binary,
        Duration::from_secs(10),
    )
    .await?;
    log::info!(
        "Codex app-server listening on ws://127.0.0.1:{}",
        connection.listen_port
    );
    let (mut sink, mut stream) = connection.socket.split();
    let result = async {
        initialize_codex_app_server_ws(&mut sink, &mut stream).await?;

        let (tx, mut rx) = mpsc::unbounded_channel();
        bridge.attach(tx).await;

        let mut next_request_id = 2_i64;
        let mut outgoing: HashMap<i64, CodexAppServerOutgoingRequest> = HashMap::new();
        let mut last_energy_mode: Option<EnergyMode> = None;

        send_codex_app_server_thread_list_request(&mut sink, &mut outgoing, &mut next_request_id)
            .await?;

        loop {
            if !config_store.get().codex_app_server_sync_enabled {
                break Ok(());
            }

            let (energy_mode, interval) = codex_app_server_refresh_interval_seconds(
                &store,
                config_store.get().codex_app_server_sync_interval_seconds,
            );
            if last_energy_mode != Some(energy_mode) {
                log::debug!(
                    "Codex app-server energy mode: {:?}, thread/list interval={}s",
                    energy_mode,
                    interval
                );
                last_energy_mode = Some(energy_mode);
            }

            tokio::select! {
                incoming = stream.next() => {
                    let message = incoming
                        .ok_or_else(|| "Codex app-server WebSocket stream ended".to_string())?
                        .map_err(|err| format!("codex app-server WebSocket error: {err}"))?;
                    let text = match message {
                        Message::Text(text) => text,
                        Message::Binary(_) | Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => continue,
                        Message::Close(_) => break Err("codex app-server closed the WebSocket".to_string()),
                    };
                    let value: serde_json::Value = serde_json::from_str(&text)
                        .map_err(|err| format!("Invalid codex app-server JSON message: {err}"))?;
                    handle_codex_app_server_message(&store, &mut outgoing, &value).await?;
                }
                Some(command) = rx.recv() => {
                    handle_codex_app_server_command(
                        &mut sink,
                        &mut outgoing,
                        &mut next_request_id,
                        command,
                    )
                    .await;
                }
                _ = tokio::time::sleep(Duration::from_secs(interval)) => {
                    send_codex_app_server_thread_list_request(
                        &mut sink,
                        &mut outgoing,
                        &mut next_request_id,
                    )
                    .await?;
                }
            }
        }
    }
    .await;

    bridge.detach().await;
    let _ = sink.close().await;
    shutdown_codex_app_server_child(&mut connection.child).await;
    result
}

async fn send_codex_app_server_thread_list_request(
    sink: &mut CodexWsSink,
    outgoing: &mut HashMap<i64, CodexAppServerOutgoingRequest>,
    next_request_id: &mut i64,
) -> Result<(), String> {
    let request_id = *next_request_id;
    *next_request_id += 1;
    write_ws_json(
        sink,
        serde_json::json!({
            "id": request_id,
            "method": "thread/list",
            "params": {
                "archived": false,
                "limit": 30,
                "sortKey": "updated_at",
                "sourceKinds": [
                    "cli",
                    "vscode",
                    "appServer",
                    "subAgent",
                    "subAgentReview",
                    "subAgentCompact",
                    "subAgentThreadSpawn",
                    "subAgentOther",
                    "exec",
                    "unknown"
                ]
            }
        }),
    )
    .await?;
    outgoing.insert(request_id, CodexAppServerOutgoingRequest::ThreadList);
    Ok(())
}

async fn handle_codex_app_server_message(
    store: &SessionStore,
    outgoing: &mut HashMap<i64, CodexAppServerOutgoingRequest>,
    message: &serde_json::Value,
) -> Result<(), String> {
    if let Some(method) = message.get("method").and_then(|value| value.as_str()) {
        let params = message
            .get("params")
            .cloned()
            .unwrap_or_else(|| serde_json::json!({}));
        if message.get("id").is_some() {
            // Vibe Board only observes agent sessions. Approval and user-input
            // requests from the app-server are ignored and never answered.
            log::debug!(
                "Ignoring Codex app-server request {} because Vibe Board does not answer approvals",
                method
            );
        } else {
            handle_codex_app_server_notification(store, method, &params).await?;
        }
        return Ok(());
    }

    let Some(id) = message.get("id").and_then(|value| value.as_i64()) else {
        return Ok(());
    };
    let Some(kind) = outgoing.remove(&id) else {
        return Ok(());
    };
    if let Some(error) = message.get("error") {
        let err_message = error
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("Codex app-server request failed")
            .to_string();
        log::warn!("Codex app-server request {} failed: {}", id, err_message);
        match kind {
            CodexAppServerOutgoingRequest::RateLimits { reply } => {
                let _ = reply.send(Err(err_message));
            }
            CodexAppServerOutgoingRequest::ThreadList => {}
        }
        return Ok(());
    }
    match kind {
        CodexAppServerOutgoingRequest::ThreadList => {
            if let Some(threads) = codex_thread_list_from_response(message) {
                for thread in threads {
                    sync_codex_app_server_thread_to_store(store, &thread);
                }
            }
        }
        CodexAppServerOutgoingRequest::RateLimits { reply } => {
            let _ = reply.send(Ok(message.clone()));
        }
    }
    Ok(())
}

async fn handle_codex_app_server_notification(
    store: &SessionStore,
    method: &str,
    params: &serde_json::Value,
) -> Result<(), String> {
    match method {
        "thread/status/changed" => {
            let Some(thread_id) = codex_string(params, "threadId") else {
                return Ok(());
            };
            if store.get_session(&thread_id).is_none() {
                return Ok(());
            }
            let phase = codex_phase_from_status(params.get("status"));
            store.get_or_create_session(&thread_id, "codex", "Codex", "/", "Codex");
            store.update_session(&thread_id, |session| {
                session.agent_type = "codex".to_string();
                session.engine_label = Some("Codex App".to_string());
                session.terminal = "Codex".to_string();
                session.term_bundle_id = Some("com.openai.codex".to_string());
                session.phase = phase;
            });
        }
        "thread/started" => {
            if let Some(thread) = params.get("thread") {
                sync_codex_app_server_thread_to_store(store, thread);
            }
        }
        "thread/name/updated" => {
            let Some(thread_id) = codex_string(params, "threadId") else {
                return Ok(());
            };
            let name = codex_string(params, "threadName");
            store.update_session(&thread_id, |session| {
                if let Some(name) = name.clone() {
                    session.project = name.clone();
                    session.session_title = Some(name);
                }
            });
        }
        "thread/archived" => {
            let Some(thread_id) = codex_string(params, "threadId") else {
                return Ok(());
            };
            store.remove_session(&thread_id);
        }
        _ => {}
    }
    Ok(())
}

async fn handle_codex_app_server_command(
    sink: &mut CodexWsSink,
    outgoing: &mut HashMap<i64, CodexAppServerOutgoingRequest>,
    next_request_id: &mut i64,
    command: CodexAppServerCommand,
) {
    match command {
        CodexAppServerCommand::RateLimits { reply } => {
            let request_id = *next_request_id;
            *next_request_id += 1;
            let write_result = write_ws_json(
                sink,
                serde_json::json!({
                    "id": request_id,
                    "method": "account/rateLimits/read",
                    "params": {}
                }),
            )
            .await;
            match write_result {
                Ok(()) => {
                    outgoing.insert(
                        request_id,
                        CodexAppServerOutgoingRequest::RateLimits { reply },
                    );
                }
                Err(err) => {
                    let _ = reply.send(Err(err));
                }
            }
        }
    }
}

fn codex_thread_list_from_response(response: &serde_json::Value) -> Option<Vec<serde_json::Value>> {
    let result = response.get("result")?;
    let threads = result
        .get("data")
        .or_else(|| result.get("threads"))
        .or_else(|| result.get("items"))?
        .as_array()?;
    Some(threads.clone())
}

fn sync_codex_app_server_thread_to_store(
    store: &SessionStore,
    thread: &serde_json::Value,
) -> Option<CodexAppServerThreadSummary> {
    let thread_id = codex_string(thread, "id")?;
    if codex_thread_is_closed(thread) {
        store.remove_session(&thread_id);
        return None;
    }
    let name = codex_string(thread, "name");
    let preview = codex_string(thread, "preview");
    let cwd = codex_string(thread, "cwd")
        .or_else(|| codex_string(thread, "path"))
        .unwrap_or_else(|| "/".to_string());
    let phase = codex_phase_from_thread(thread);
    let status = thread
        .get("status")
        .and_then(|status| status.get("type"))
        .and_then(|value| value.as_str())
        .map(str::to_string);
    let updated_at = codex_timestamp(thread.get("updatedAt").or_else(|| thread.get("updated_at")));
    let created_at = codex_timestamp(thread.get("createdAt").or_else(|| thread.get("created_at")));

    // Once local rollout sync has claimed a thread, its lifecycle is the
    // ground truth for that thread. The app-server can only list a Desktop
    // thread as a `notLoaded`/idle placeholder because the Desktop runs its
    // own app-server; a placeholder must not downgrade or evict an in-flight
    // local task.
    let existing = store.get_session(&thread_id);
    let local_owns_lifecycle = existing
        .as_ref()
        .is_some_and(|session| session.engine_label.as_deref() == Some("Codex Desktop"));
    if codex_app_server_idle_thread_is_stale(&phase, updated_at)
        && !(local_owns_lifecycle
            && existing
                .as_ref()
                .is_some_and(|session| session.phase.is_active()))
    {
        store.remove_session(&thread_id);
        return None;
    }
    let (last_user_message, last_response) = codex_latest_messages_from_thread(thread);
    let project = name
        .clone()
        .or_else(|| preview.clone())
        .or_else(|| {
            Path::new(&cwd)
                .file_name()
                .and_then(|value| value.to_str())
                .map(str::to_string)
        })
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "Codex".to_string());

    let latest_turn_started_at = codex_latest_turn_started_at(thread);
    let trace_started_at = latest_turn_started_at
        .or(updated_at)
        .or(created_at)
        .unwrap_or_else(|| chrono::Utc::now().timestamp());

    store.get_or_create_session(&thread_id, "codex", &project, &cwd, "Codex");
    store.update_session(&thread_id, |session| {
        session.agent_type = "codex".to_string();
        if !local_owns_lifecycle {
            session.engine_label = Some("Codex App".to_string());
        }
        session.codex_app_server_thread_id = Some(thread_id.clone());
        session.project = project.clone();
        session.cwd = cwd.clone();
        session.terminal = "Codex".to_string();
        session.term_bundle_id = Some("com.openai.codex".to_string());
        session.phase = if !matches!(phase, SessionPhase::Idle) || !local_owns_lifecycle {
            phase.clone()
        } else {
            session.phase.clone()
        };
        session.session_title = name.clone().or_else(|| preview.clone());
        session.description = preview.clone();
        if !local_owns_lifecycle {
            session.started_at = trace_started_at;
        }
        if let Some(updated_at) = updated_at {
            if !local_owns_lifecycle {
                session.last_main_agent_at = Some(updated_at);
            }
        }
        if last_user_message.is_some() {
            session.last_user_message = last_user_message.clone();
        }
        if last_response.is_some() {
            session.last_response = last_response.clone();
        }
    });

    Some(CodexAppServerThreadSummary {
        id: thread_id,
        name,
        preview,
        cwd: Some(cwd),
        status,
        phase: format!("{:?}", phase),
        updated_at,
    })
}

fn codex_phase_from_thread(thread: &serde_json::Value) -> SessionPhase {
    codex_phase_from_status(thread.get("status"))
}

fn codex_thread_is_closed(thread: &serde_json::Value) -> bool {
    for key in ["archived", "deleted", "closed", "ended"] {
        if thread.get(key).and_then(|value| value.as_bool()) == Some(true) {
            return true;
        }
        if thread
            .get("status")
            .and_then(|status| status.get(key))
            .and_then(|value| value.as_bool())
            == Some(true)
        {
            return true;
        }
    }

    let closed_states = ["archived", "deleted", "closed", "ended"];
    let status_text = thread
        .get("status")
        .and_then(|status| {
            status
                .as_str()
                .or_else(|| status.get("type").and_then(|value| value.as_str()))
        })
        .or_else(|| thread.get("state").and_then(|value| value.as_str()))
        .or_else(|| thread.get("lifecycle").and_then(|value| value.as_str()))
        .map(|value| value.trim().to_ascii_lowercase());

    status_text
        .as_deref()
        .is_some_and(|value| closed_states.contains(&value))
}

fn codex_app_server_idle_thread_is_stale(phase: &SessionPhase, updated_at: Option<i64>) -> bool {
    const IDLE_THREAD_RETENTION_SECONDS: i64 = 30 * 60;
    if !matches!(phase, SessionPhase::Idle | SessionPhase::Done) {
        return false;
    }
    let Some(updated_at) = updated_at else {
        return false;
    };
    chrono::Utc::now().timestamp() - updated_at > IDLE_THREAD_RETENTION_SECONDS
}

fn codex_phase_from_status(status: Option<&serde_json::Value>) -> SessionPhase {
    let status_type = status
        .and_then(|status| status.get("type"))
        .and_then(|value| value.as_str());
    match status_type {
        Some("active") | Some("running") | Some("processing") => SessionPhase::Processing,
        Some("error") | Some("failed") => SessionPhase::Error,
        _ => SessionPhase::Idle,
    }
}

fn codex_latest_messages_from_thread(
    thread: &serde_json::Value,
) -> (Option<String>, Option<String>) {
    let mut latest_user = None;
    let mut latest_agent = None;
    let Some(turns) = thread.get("turns").and_then(|value| value.as_array()) else {
        return (latest_user, latest_agent);
    };

    for item in turns
        .iter()
        .filter_map(|turn| turn.get("items").and_then(|items| items.as_array()))
        .flatten()
    {
        match item.get("type").and_then(|value| value.as_str()) {
            Some("userMessage") => {
                if let Some(text) = codex_user_message_text(item) {
                    latest_user = Some(text);
                }
            }
            Some("agentMessage") => {
                if let Some(text) = codex_string(item, "text") {
                    latest_agent = Some(text);
                }
            }
            _ => {}
        }
    }

    (latest_user, latest_agent)
}

fn codex_user_message_text(item: &serde_json::Value) -> Option<String> {
    if let Some(text) = codex_string(item, "text") {
        return Some(text);
    }
    let content = item.get("content")?.as_array()?;
    let text = content
        .iter()
        .filter_map(|part| {
            part.as_str()
                .map(str::to_string)
                .or_else(|| codex_string(part, "text"))
        })
        .collect::<Vec<_>>()
        .join("\n");
    let text = text.trim();
    if text.is_empty() {
        None
    } else {
        Some(text.to_string())
    }
}

fn codex_latest_turn_started_at(thread: &serde_json::Value) -> Option<i64> {
    let turns = thread.get("turns").and_then(|value| value.as_array())?;
    let latest_turn = turns.last()?;

    if let Some(ts) = codex_timestamp(
        latest_turn
            .get("startedAt")
            .or_else(|| latest_turn.get("started_at"))
            .or_else(|| latest_turn.get("createdAt"))
            .or_else(|| latest_turn.get("created_at")),
    ) {
        return Some(ts);
    }

    if let Some(items) = latest_turn.get("items").and_then(|v| v.as_array()) {
        for item in items {
            if let Some(ts) = codex_timestamp(
                item.get("startedAt")
                    .or_else(|| item.get("started_at"))
                    .or_else(|| item.get("createdAt"))
                    .or_else(|| item.get("created_at"))
                    .or_else(|| item.get("timestamp")),
            ) {
                return Some(ts);
            }
        }
    }

    None
}

fn codex_string(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn codex_timestamp(value: Option<&serde_json::Value>) -> Option<i64> {
    match value? {
        serde_json::Value::Number(number) => number
            .as_i64()
            .or_else(|| number.as_f64().map(|value| value.round() as i64)),
        serde_json::Value::String(value) => chrono::DateTime::parse_from_rfc3339(value)
            .ok()
            .map(|value| value.timestamp())
            .or_else(|| value.parse::<i64>().ok()),
        _ => None,
    }
}

const CODEX_LOCAL_ROLLOUT_MAX_FILES: usize = 40;
const CODEX_LOCAL_ROLLOUT_MAX_AGE_SECONDS: i64 = 30 * 60;

#[derive(Debug, Default, PartialEq, Eq)]
struct LocalCodexRolloutState {
    session_id: Option<String>,
    cwd: Option<String>,
    active: bool,
    saw_task_event: bool,
    started_at: Option<i64>,
    updated_at: Option<i64>,
    last_response: Option<String>,
}

/// Recover the host Codex Desktop turn state from its rollout file.
///
/// Codex Desktop currently writes these lifecycle events even when it does not
/// execute the configured Vibe Board hook. The app-server bridge remains the
/// richer source when it can see the same Codex home; this is the local fallback
/// that makes the host's active turn visible in either case.
fn read_local_codex_rollout_state(
    path: &Path,
    fallback_updated_at: i64,
) -> Option<LocalCodexRolloutState> {
    let file = fs::File::open(path).ok()?;
    let mut state = LocalCodexRolloutState::default();

    for line in StdBufReader::new(file).lines().map_while(Result::ok) {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(json) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let timestamp = codex_timestamp(json.get("timestamp"));
        if let Some(timestamp) = timestamp {
            state.updated_at = Some(timestamp);
        }

        match json.get("type").and_then(|value| value.as_str()) {
            Some("session_meta") => {
                let Some(payload) = json.get("payload") else {
                    continue;
                };
                state.session_id =
                    codex_string(payload, "session_id").or_else(|| codex_string(payload, "id"));
                state.cwd = codex_string(payload, "cwd");
            }
            Some("event_msg") => {
                let Some(payload) = json.get("payload") else {
                    continue;
                };
                match codex_string(payload, "type").as_deref() {
                    Some("task_started") => {
                        state.active = true;
                        state.saw_task_event = true;
                        state.started_at = codex_timestamp(payload.get("started_at"))
                            .or(timestamp)
                            .or(state.started_at);
                    }
                    Some("task_complete") => {
                        state.active = false;
                        state.saw_task_event = true;
                        if let Some(response) = codex_string(payload, "last_agent_message") {
                            state.last_response = Some(response);
                        }
                    }
                    Some("turn_aborted") | Some("turn_failed") => {
                        state.active = false;
                        state.saw_task_event = true;
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }

    state.updated_at = state.updated_at.or(Some(fallback_updated_at));
    state
        .session_id
        .as_ref()
        .filter(|value| !value.is_empty())?;
    Some(state)
}

fn sync_local_codex_rollouts_to_store(store: &SessionStore) {
    let Some(home) = dirs::home_dir() else {
        return;
    };
    sync_local_codex_rollouts_from_root(store, &home.join(".codex").join("sessions"));
}

fn sync_local_codex_rollouts_from_root(store: &SessionStore, root: &Path) {
    let mut candidates = Vec::new();
    crate::usage::codex::collect_codex_rollout_files(root, &mut candidates);
    candidates.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| b.0.cmp(&a.0)));

    let cutoff = chrono::Utc::now().timestamp() - CODEX_LOCAL_ROLLOUT_MAX_AGE_SECONDS;
    for (path, modified_at) in candidates.into_iter().take(CODEX_LOCAL_ROLLOUT_MAX_FILES) {
        let fallback_updated_at = modified_at
            .duration_since(std::time::UNIX_EPOCH)
            .ok()
            .map(|value| value.as_secs() as i64)
            .unwrap_or_default();
        let Some(snapshot) = read_local_codex_rollout_state(&path, fallback_updated_at) else {
            continue;
        };
        if !snapshot.saw_task_event || snapshot.updated_at.unwrap_or(fallback_updated_at) < cutoff {
            continue;
        }

        let Some(session_id) = snapshot.session_id.clone() else {
            continue;
        };
        let cwd = snapshot.cwd.clone().unwrap_or_else(|| "/".to_string());
        let title = extract_session_title(&path);
        let project = title
            .clone()
            .or_else(|| {
                Path::new(&cwd)
                    .file_name()
                    .and_then(|value| value.to_str())
                    .map(str::to_string)
            })
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "Codex".to_string());
        let phase = if snapshot.active {
            SessionPhase::Processing
        } else {
            SessionPhase::Idle
        };
        let existing = store.get_session(&session_id);

        // The app-server only knows a Desktop-owned thread as a `notLoaded`
        // placeholder and reports it idle. The local rollout is written by the
        // process that actually runs the turn, so it owns the lifecycle; the
        // app-server still contributes live status.
        let updated_at = snapshot.updated_at.or(Some(fallback_updated_at));
        let last_response = snapshot.last_response.clone().or_else(|| {
            (!snapshot.active)
                .then(|| extract_latest_assistant_text(&path))
                .flatten()
        });
        let next_phase = phase.clone();
        let changed = existing
            .as_ref()
            .map(|session| {
                session.phase != next_phase
                    || session.engine_label.as_deref() != Some("Codex Desktop")
                    || session.cwd != cwd
                    || session.project != project
                    || session.session_title != title
                    || session.last_main_agent_at != updated_at
                    || last_response
                        .as_ref()
                        .is_some_and(|response| session.last_response.as_ref() != Some(response))
            })
            .unwrap_or(true);
        if !changed {
            continue;
        }

        store.get_or_create_session(&session_id, "codex", &project, &cwd, "Codex");
        store.update_session(&session_id, |session| {
            session.agent_type = "codex".to_string();
            session.engine_label = Some("Codex Desktop".to_string());
            session.codex_app_server_thread_id = Some(session_id.clone());
            session.project = project.clone();
            session.cwd = cwd.clone();
            session.terminal = "Codex".to_string();
            session.term_bundle_id = Some("com.openai.codex".to_string());
            session.phase = phase.clone();
            session.session_title = title.clone();
            session.description = title.clone();
            if let Some(started_at) = snapshot.started_at {
                session.started_at = started_at;
            }
            session.last_main_agent_at = updated_at;
            if let Some(title) = title.clone() {
                session.last_user_message = Some(title);
            }
            if let Some(response) = last_response.clone() {
                session.last_response = Some(response);
            }
        });
    }
}

fn is_codex_desktop_session(session: &SessionState) -> bool {
    let terminal = session.terminal.trim();

    if session.agent_type != "codex" {
        return false;
    }

    if session
        .term_bundle_id
        .as_deref()
        .is_some_and(is_codex_app_bundle)
    {
        return true;
    }

    if let Some(meta) = read_codex_session_meta(&session.id) {
        let originator = meta.originator.unwrap_or_default().to_ascii_lowercase();
        if originator.contains("desktop") {
            return true;
        }
        if originator.contains("tui") || originator.contains("cli") {
            return false;
        }

        let source = meta.source.unwrap_or_default().to_ascii_lowercase();
        if source == "cli" {
            return false;
        }
        if source == "vscode" || source == "desktop" {
            return true;
        }
    }

    let missing_tty = session
        .tty
        .as_deref()
        .is_none_or(|tty| tty.trim().is_empty());
    missing_tty
        && !terminal.starts_with("/dev/")
        && (terminal.is_empty() || terminal.to_ascii_lowercase().contains("codex"))
}

fn is_codex_app_bundle(bundle_id: &str) -> bool {
    bundle_id.to_ascii_lowercase().contains("openai.codex")
}

fn native_app_bundle_matches_session(session: &SessionState, bundle_id: &str) -> bool {
    let lower = bundle_id.to_ascii_lowercase();
    matches!(
        (session.agent_type.as_str(), lower.as_str()),
        ("codex", "com.openai.codex")
            | ("cursor", "com.todesktop.230313mzl4w4u92")
            | ("cursor-cli", "com.todesktop.230313mzl4w4u92")
            | ("qoder", "com.qoder.ide")
            | ("qoder-cli", "com.qoder.ide")
            | ("droid", "com.factory.app")
            | ("codebuddy", "com.tencent.codebuddy")
            | ("codebuddycn", "com.tencent.codebuddy.cn")
            | ("codybuddycn", "com.tencent.codebuddy.cn")
            | ("stepfun", "com.stepfun.app")
            | ("opencode", "ai.opencode.desktop")
            | ("workbuddy", "com.workbuddy.workbuddy")
    )
}

fn is_known_ide_or_agent_host_bundle(bundle_id: &str) -> bool {
    let lower = bundle_id.to_ascii_lowercase();
    lower.contains("vscode")
        || lower.contains("vscodium")
        || lower.contains("todesktop.230313mzl4w4u92")
        || lower.contains("cursor")
        || lower.contains("windsurf")
        || lower.contains("codeium")
        || lower.contains("zed")
        || lower.contains("jetbrains")
        || lower.contains("xcode")
        || lower == "com.apple.dt.xcode"
        || lower.contains("panic.nova")
        || lower.contains("android.studio")
        || lower.contains("antigravity")
        || lower == "com.qoder.ide"
        || lower == "com.qoder.ide.helper"
        || lower == "com.factory.app"
        || lower == "com.tencent.codebuddy"
        || lower == "com.tencent.codebuddy.cn"
        || lower == "com.stepfun.app"
        || lower == "ai.opencode.desktop"
        || lower == "com.workbuddy.workbuddy"
}

fn is_ide_terminal_session(session: &SessionState) -> bool {
    let Some(bundle_id) = session
        .term_bundle_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return false;
    };

    if crate::terminal::registry::is_terminal_bundle(bundle_id)
        && !is_known_ide_or_agent_host_bundle(bundle_id)
    {
        return false;
    }

    is_known_ide_or_agent_host_bundle(bundle_id)
        && !native_app_bundle_matches_session(session, bundle_id)
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct CodexSessionMeta {
    originator: Option<String>,
    source: Option<String>,
}

fn read_codex_session_meta(session_id: &str) -> Option<CodexSessionMeta> {
    let path = discover_codex_session_file(session_id)?;
    read_codex_session_meta_from_path(&path)
}

fn read_codex_session_meta_from_path(path: &Path) -> Option<CodexSessionMeta> {
    let file = fs::File::open(path).ok()?;
    let reader = StdBufReader::new(file);

    for line in reader.lines().map_while(Result::ok) {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let Some(payload) = codex_session_meta_payload(&entry) else {
            continue;
        };

        return Some(CodexSessionMeta {
            originator: payload
                .get("originator")
                .or_else(|| entry.get("originator"))
                .and_then(|value| value.as_str())
                .map(ToString::to_string),
            source: payload
                .get("source")
                .or_else(|| entry.get("source"))
                .and_then(|value| value.as_str())
                .map(ToString::to_string),
        });
    }

    None
}

fn codex_session_meta_payload(entry: &serde_json::Value) -> Option<&serde_json::Value> {
    if entry.get("type").and_then(|value| value.as_str()) == Some("session_meta") {
        return entry.get("payload").or(Some(entry));
    }

    let payload = entry.get("payload")?;
    if payload.get("type").and_then(|value| value.as_str()) == Some("session_meta") {
        return payload.get("payload").or(Some(payload));
    }

    None
}

fn app_host_bundle_id(session: &SessionState) -> Option<&str> {
    let bundle_id = session.term_bundle_id.as_deref()?.trim();
    if bundle_id.is_empty() || crate::terminal::registry::is_terminal_bundle(bundle_id) {
        return None;
    }
    if is_known_ide_or_agent_host_bundle(bundle_id)
        && !native_app_bundle_matches_session(session, bundle_id)
    {
        return None;
    }
    Some(bundle_id)
}

fn open_app_host_session(session: &SessionState) -> Result<(), String> {
    if is_codex_desktop_session(session) {
        return open_codex_desktop_session(session);
    }

    let bundle_id = app_host_bundle_id(session)
        .ok_or_else(|| "Session has no app bundle metadata to jump to".to_string())?;
    open_bundle_id(bundle_id)
}

fn resolve_session_tty(session: &SessionState) -> Option<String> {
    session
        .tty
        .as_deref()
        .filter(|tty| !tty.trim().is_empty())
        .map(normalize_tty_path)
        .or_else(|| {
            session
                .terminal
                .starts_with("/dev/tty")
                .then(|| session.terminal.clone())
        })
        .or_else(|| {
            let pid = session.pid?;
            let tree = crate::terminal::process_tree::build_tree();
            crate::terminal::process_tree::get_tty(pid, &tree)
                .as_deref()
                .map(normalize_tty_path)
        })
}

fn normalize_tty_path(tty: &str) -> String {
    if tty.starts_with("/dev/") {
        tty.to_string()
    } else {
        format!("/dev/{}", tty)
    }
}

fn open_codex_desktop_session(session: &SessionState) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        open_codex_desktop_session_macos(session)
    }

    #[cfg(target_os = "windows")]
    {
        open_codex_desktop_session_windows(session)
    }

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        let _ = session;
        Err("Codex Desktop session jumping is only supported on macOS and Windows".to_string())
    }
}

#[cfg(target_os = "macos")]
fn open_codex_desktop_session_macos(session: &SessionState) -> Result<(), String> {
    let opened_thread = is_uuid_like(&session.id)
        && std::process::Command::new("/usr/bin/open")
            .arg(format!("codex://threads/{}", session.id))
            .output()
            .map(|output| output.status.success())
            .unwrap_or(false);

    if opened_thread {
        let _ = activate_codex_desktop_app(session.pid);
        return Ok(());
    }

    if activate_codex_desktop_app(session.pid) {
        Ok(())
    } else {
        Err("Failed to activate Codex Desktop".to_string())
    }
}

#[cfg(target_os = "windows")]
fn open_codex_desktop_session_windows(session: &SessionState) -> Result<(), String> {
    let mut errors = Vec::new();

    if is_uuid_like(&session.id) {
        let target = format!("codex://threads/{}", session.id);
        match open_windows_shell_target(&target) {
            Ok(()) => return Ok(()),
            Err(err) => errors.push(format!("{target}: {err}")),
        }
    }

    for app_id in crate::agents::executable::codex_desktop_app_user_model_ids() {
        match open_windows_app_user_model_id(&app_id) {
            Ok(()) => return Ok(()),
            Err(err) => errors.push(format!("{app_id}: {err}")),
        }
    }

    for path in crate::agents::executable::codex_desktop_app_candidates()
        .into_iter()
        .filter(|path| path.exists())
    {
        let target = path.to_string_lossy().to_string();
        match open_windows_shell_target(&target) {
            Ok(()) => return Ok(()),
            Err(err) => errors.push(format!("{target}: {err}")),
        }
    }

    Err(if errors.is_empty() {
        "Codex Desktop was not found. Install or launch Codex Desktop, then try again.".to_string()
    } else {
        format!("Failed to open Codex Desktop: {}", errors.join("; "))
    })
}

#[cfg(target_os = "windows")]
fn open_windows_app_user_model_id(app_id: &str) -> Result<(), String> {
    let app_id = clean_windows_app_user_model_id(app_id)
        .ok_or_else(|| format!("Invalid Windows app id: {app_id}"))?;
    let script = format!(
        r#"$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject Shell.Application
$folder = $shell.Namespace('shell:AppsFolder')
if ($null -eq $folder) {{ throw 'AppsFolder is unavailable' }}
$item = $folder.ParseName({})
if ($null -eq $item) {{ throw 'App is not installed' }}
$item.InvokeVerb('open')
"#,
        powershell_string_literal(&app_id)
    );

    match run_windows_powershell(&script) {
        Ok(()) => Ok(()),
        Err(primary) => {
            let target = format!("shell:AppsFolder\\{app_id}");
            open_windows_explorer_target(&target)
                .map_err(|fallback| format!("{primary}; explorer fallback failed: {fallback}"))
        }
    }
}

#[cfg(target_os = "windows")]
fn clean_windows_app_user_model_id(value: &str) -> Option<String> {
    let trimmed = value
        .split(['?', '&', '#'])
        .next()
        .unwrap_or(value)
        .trim()
        .trim_matches('"')
        .trim_matches('\'');
    if trimmed.is_empty()
        || trimmed.contains('\\')
        || trimmed.contains('/')
        || !trimmed.contains('!')
    {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[cfg(target_os = "windows")]
fn run_windows_powershell(script: &str) -> Result<(), String> {
    let output = crate::platform::process::background_command(
        crate::agents::executable::command_path("powershell"),
    )
    .args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
    ])
    .output()
    .map_err(|err| format!("Failed to run PowerShell app activation: {err}"))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Err(if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("powershell exited with status {}", output.status)
        })
    }
}

#[cfg(target_os = "windows")]
fn powershell_string_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(target_os = "windows")]
fn open_windows_explorer_target(target: &str) -> Result<(), String> {
    let output = crate::platform::process::background_command(
        crate::agents::executable::command_path("explorer"),
    )
    .arg(target)
    .output()
    .map_err(|err| format!("Failed to open {target}: {err}"))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Err(if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("explorer exited with status {}", output.status)
        })
    }
}

#[cfg(target_os = "windows")]
fn open_windows_shell_target(target: &str) -> Result<(), String> {
    let target = target.trim();
    if target.is_empty() {
        return Err("Target is empty".to_string());
    }

    let path = Path::new(target);
    let mut command = if is_windows_protocol_target(target) {
        let mut command = crate::platform::process::background_command(
            crate::agents::executable::command_path("rundll32"),
        );
        command.args(["url.dll,FileProtocolHandler", target]);
        command
    } else if path.exists() && path.is_file() {
        crate::platform::process::background_command(path)
    } else {
        let mut command = crate::platform::process::background_command(
            crate::agents::executable::command_path("explorer"),
        );
        command.arg(target);
        command
    };

    let output = command
        .output()
        .map_err(|err| format!("Failed to open {target}: {err}"))?;

    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Err(if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("open target exited with status {}", output.status)
        })
    }
}

#[cfg(target_os = "windows")]
fn is_windows_protocol_target(target: &str) -> bool {
    if target.starts_with("\\\\") {
        return false;
    }
    let Some((scheme, rest)) = target.split_once(':') else {
        return false;
    };
    if scheme.len() == 1 && (rest.starts_with('\\') || rest.starts_with('/')) {
        return false;
    }
    !scheme.is_empty()
        && scheme
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '-' | '.'))
}

#[cfg(target_os = "macos")]
fn activate_codex_desktop_app(pid: Option<u32>) -> bool {
    if std::process::Command::new("/usr/bin/open")
        .args(["-a", "Codex"])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
    {
        return true;
    }

    if let Some(pid) = pid {
        let script = format!(
            r#"tell application "System Events"
  set matchingProcesses to application processes whose unix id is {pid}
  if (count of matchingProcesses) > 0 then
    set frontmost of item 1 of matchingProcesses to true
    return "ok"
  end if
end tell"#
        );
        if osascript_ok(&script) {
            return true;
        }
    }

    osascript_ok(
        r#"tell application "System Events"
  set matchingProcesses to application processes whose name is "Codex"
  if (count of matchingProcesses) is 0 then
    set matchingProcesses to application processes whose name contains "Codex"
  end if
  if (count of matchingProcesses) > 0 then
    set frontmost of item 1 of matchingProcesses to true
    return "ok"
  end if
end tell"#,
    ) || osascript_ok(r#"tell application "Codex" to activate"#)
}

#[cfg(any(target_os = "macos", target_os = "windows", test))]
fn is_uuid_like(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (index, byte) in bytes.iter().copied().enumerate() {
        if matches!(index, 8 | 13 | 18 | 23) {
            if byte != b'-' {
                return false;
            }
        } else if !byte.is_ascii_hexdigit() {
            return false;
        }
    }
    true
}

fn open_bundle_id(bundle_id: &str) -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err("App bundle jumping is only supported on macOS".to_string());
    }

    let output = std::process::Command::new("/usr/bin/open")
        .args(["-b", bundle_id])
        .output()
        .map_err(|e| format!("Failed to activate app bundle {bundle_id}: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if stderr.is_empty() {
            format!("Failed to activate app bundle {bundle_id}")
        } else {
            stderr
        })
    }
}

fn resolve_codex_binary() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("CODEX_BIN") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }

    if let Some(path) = crate::agents::executable::find_codex_cli_binary() {
        return Some(path);
    }

    codex_binary_candidates()
        .into_iter()
        .find(|path| path.is_file())
}

fn codex_binary_candidates() -> Vec<PathBuf> {
    let mut candidates = vec![
        PathBuf::from("/opt/homebrew/bin/codex"),
        PathBuf::from("/usr/local/bin/codex"),
        PathBuf::from("/usr/bin/codex"),
    ];

    if let Some(home) = dirs::home_dir() {
        candidates.extend([
            home.join(".npm-global/bin/codex"),
            home.join(".local/bin/codex"),
            home.join(".bun/bin/codex"),
            home.join(".yarn/bin/codex"),
            home.join(".volta/bin/codex"),
        ]);

        let nvm_versions = home.join(".nvm/versions/node");
        if let Ok(entries) = std::fs::read_dir(nvm_versions) {
            let mut nvm_candidates = entries
                .filter_map(Result::ok)
                .map(|entry| entry.path().join("bin/codex"))
                .collect::<Vec<_>>();
            nvm_candidates.sort();
            nvm_candidates.reverse();
            candidates.extend(nvm_candidates);
        }
    }

    candidates
}

// ── Hook Verification Commands ───────────────────────────────────

#[tauri::command]
pub async fn verify_hooks(
    state: State<'_, AppState>,
    agent: String,
) -> Result<crate::agents::claude_code::HookVerificationResult, String> {
    log::info!("Verifying hooks for agent: {}", agent);
    let _adapter = state
        .adapters
        .iter()
        .find(|a| a.name() == agent)
        .ok_or_else(|| format!("Unknown agent: {}", agent))?;

    // Currently only claude-code supports verification
    if agent == "claude-code" {
        // Downcast isn't possible through dyn AgentAdapter, but we know
        // only ClaudeCodeAdapter exists — construct one to verify.
        let cc = crate::agents::claude_code::ClaudeCodeAdapter::new();
        Ok(cc.verify_hooks())
    } else {
        Err(format!(
            "Hook verification not supported for agent: {}",
            agent
        ))
    }
}

// ── Hook Lifecycle Simulation ─────────────────────────────────────

#[tauri::command]
pub async fn simulate_hook_event(
    event_name: String,
    tool_name: Option<String>,
) -> Result<(), String> {
    use tokio::io::AsyncWriteExt;

    fn canonical_agent_id(agent: &str) -> &str {
        match agent {
            "gemini-cli" => "gemini",
            "codybuddycn" => "codebuddycn",
            other => other,
        }
    }

    fn canonical_event_name(event: &str) -> &str {
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
            "SubagentsStop" => "SubagentStop",
            "SubagentEnd" => "SubagentStop",
            other => other,
        }
    }

    fn session_start_event_name(event: &str) -> &'static str {
        if event.contains('_') {
            "session_start"
        } else {
            "SessionStart"
        }
    }

    async fn send_payload(payload: serde_json::Value) -> Result<(), String> {
        let line = format!("{payload}\n");
        let bytes = line.as_bytes();
        let endpoint = hook_endpoint::current();

        #[cfg(unix)]
        {
            if let Ok(mut stream) = tokio::net::UnixStream::connect(&endpoint.socket_path).await {
                return stream.write_all(bytes).await.map_err(|e| e.to_string());
            }
        }

        let mut stream = tokio::net::TcpStream::connect(endpoint.tcp_addr())
            .await
            .map_err(|e| e.to_string())?;
        stream.write_all(bytes).await.map_err(|e| e.to_string())
    }

    let sid = format!("simulate-{}", uuid::Uuid::new_v4());
    let agent = canonical_agent_id(
        tool_name
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("claude-code"),
    );
    let cwd = format!("/Users/demo/{}-hook-test", agent);
    let canonical_event = canonical_event_name(&event_name);
    let start_event = session_start_event_name(&event_name);
    let session_start = serde_json::json!({
        "agent": agent,
        "event": start_event,
        "session_id": sid,
        "cwd": cwd,
        "tty": "Vibe Board Hook Tester",
        "terminal": "Vibe Board Hook Tester",
    });

    let processing_payload = |event: &str, message: &str| {
        serde_json::json!({
            "agent": agent,
            "event": event,
            "session_id": sid,
            "cwd": cwd,
            "tty": "Vibe Board Hook Tester",
            "terminal": "Vibe Board Hook Tester",
            "prompt": message,
            "description": message,
        })
    };

    let tool_payload = |event: &str, message: &str, status_text: &str| {
        serde_json::json!({
            "agent": agent,
            "event": event,
            "session_id": sid,
            "cwd": cwd,
            "tty": "Vibe Board Hook Tester",
            "terminal": "Vibe Board Hook Tester",
            "description": message,
            "status": status_text,
            "tool": "Bash",
            "tool_name": "Bash",
            "tool_input": {
                "command": format!("echo '{}'", message.replace('\'', "'\\''"))
            },
            "toolInput": {
                "command": format!("echo '{}'", message.replace('\'', "'\\''"))
            },
        })
    };

    let permission_payload = |event: &str, message: &str| {
        serde_json::json!({
            "agent": agent,
            "event": event,
            "session_id": sid,
            "cwd": cwd,
            "tty": "Vibe Board Hook Tester",
            "terminal": "Vibe Board Hook Tester",
            "description": message,
            "tool": "Bash",
            "tool_name": "Bash",
            "tool_input": {
                "command": "cat ~/.ssh/id_rsa # AgentBro PermissionRequest 测试"
            },
            "toolInput": {
                "command": "cat ~/.ssh/id_rsa # AgentBro PermissionRequest 测试"
            },
            "diff": format!("[{}]\n\n{}", event, message),
        })
    };

    let notification_payload = |event: &str, message: &str| {
        serde_json::json!({
            "agent": agent,
            "event": event,
            "session_id": sid,
            "cwd": cwd,
            "tty": "Vibe Board Hook Tester",
            "terminal": "Vibe Board Hook Tester",
            "message": message,
        })
    };

    let completion_payload = |event: &str, message: &str| {
        serde_json::json!({
            "agent": agent,
            "event": event,
            "session_id": sid,
            "cwd": cwd,
            "tty": "Vibe Board Hook Tester",
            "terminal": "Vibe Board Hook Tester",
            "summary": message,
            "message": message,
            "last_assistant_message": message,
        })
    };

    let error_payload = |event: &str, message: &str| {
        serde_json::json!({
            "agent": agent,
            "event": event,
            "session_id": sid,
            "cwd": cwd,
            "tty": "Vibe Board Hook Tester",
            "terminal": "Vibe Board Hook Tester",
            "error": message,
            "message": message,
        })
    };

    let subagent_payload = |event: &str, message: &str, status_text: &str| {
        serde_json::json!({
            "agent": agent,
            "event": event,
            "session_id": sid,
            "cwd": cwd,
            "tty": "Vibe Board Hook Tester",
            "terminal": "Vibe Board Hook Tester",
            "description": message,
            "message": message,
            "last_assistant_message": message,
            "agent_id": "subagent-demo-001",
            "agent_status": status_text,
            "agent_type": "research",
        })
    };

    let test_message = format!(
        "正在测试 {} 的 {} 事件：这是 Vibe Board 生成的模拟 Hook payload。",
        agent, event_name
    );

    let mut payloads = match canonical_event {
        "SessionStart" => vec![serde_json::json!({
            "agent": agent,
            "event": event_name,
            "session_id": sid,
            "cwd": format!("/Users/demo/{}-SessionStart-Hook", agent),
            "tty": "Vibe Board Hook Tester",
            "terminal": "Vibe Board Hook Tester",
        })],
        "SessionEnd" => vec![
            session_start.clone(),
            notification_payload(
                if event_name.contains('_') {
                    "notification"
                } else {
                    "Notification"
                },
                &format!("正在测试 {}：模拟会话即将结束。", event_name),
            ),
            processing_payload(&event_name, &test_message),
        ],
        "UserPromptSubmit" => vec![
            session_start.clone(),
            processing_payload(
                &event_name,
                &format!("正在测试 {}：模拟用户刚刚提交了一条新需求。", event_name),
            ),
        ],
        "PreToolUse" => vec![
            session_start.clone(),
            tool_payload(&event_name, &test_message, "running"),
        ],
        "PostToolUse" => vec![
            session_start.clone(),
            tool_payload(&event_name, &test_message, "success"),
        ],
        "PostToolUseFailure" | "PermissionDenied" => vec![
            session_start.clone(),
            tool_payload(&event_name, &test_message, "error"),
        ],
        "Notification" => vec![
            session_start.clone(),
            notification_payload(
                &event_name,
                &format!("正在测试 {}：这是一条模拟通知消息。", event_name),
            ),
        ],
        "Stop" => vec![
            session_start.clone(),
            completion_payload(
                &event_name,
                &format!("正在测试 {}：模拟任务已完成。", event_name),
            ),
        ],
        "StopFailure" => vec![
            session_start.clone(),
            error_payload(
                &event_name,
                &format!("正在测试 {}：模拟任务失败。", event_name),
            ),
        ],
        "PreCompact" | "PostCompact" => vec![
            session_start.clone(),
            processing_payload(
                &event_name,
                &format!("正在测试 {}：模拟上下文压缩阶段。", event_name),
            ),
        ],
        "PermissionRequest" => vec![
            session_start.clone(),
            permission_payload(
                &event_name,
                &format!(
                    "正在测试 {}：模拟一次需要用户确认的 Bash 操作。",
                    event_name
                ),
            ),
        ],
        "SubagentStop" => vec![
            session_start.clone(),
            subagent_payload(
                "SubagentStart",
                &format!("正在测试 {}：子 Agent 正在分析代码依赖关系。", event_name),
                "running",
            ),
            subagent_payload(&event_name, &test_message, "completed"),
        ],
        "SubagentStart" => vec![
            session_start.clone(),
            subagent_payload(&event_name, &test_message, "running"),
        ],
        other => return Err(format!("No simulation payload for event: {other}")),
    };
    if payloads.is_empty() {
        payloads.push(session_start);
    }

    let payload_count = payloads.len();
    for (index, payload) in payloads.into_iter().enumerate() {
        send_payload(payload).await?;
        if index + 1 < payload_count {
            tokio::time::sleep(std::time::Duration::from_millis(180)).await;
        }
    }
    Ok(())
}

// ── Terminal Commands ─────────────────────────────────────────────

/// Process-wide lock to serialize jump_to_terminal executions.
/// A single jump may fork-exec `pgrep`, `lsof`, `osascript`, and `open` and
/// run AppleScript loops over every iTerm/Ghostty window — running multiple
/// concurrently (e.g. from a user rage-clicking a stale "jump" button) can
/// stack into a system-wide stall. We serialize and silently drop overlap.
static JUMP_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[tauri::command]
pub async fn jump_to_terminal(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    let lock = JUMP_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = match lock.try_lock() {
        Ok(guard) => guard,
        Err(_) => {
            log::info!(
                "Jump already in progress; ignoring duplicate click for session={}",
                session_id
            );
            return Ok(());
        }
    };

    log::info!("Jump to terminal: session={}", session_id);
    release_notch_keyboard_focus(&app);

    let session = state
        .session_store
        .get_session(&session_id)
        .ok_or_else(|| format!("Session {} not found", session_id))?;

    if is_codex_desktop_session(&session) {
        return open_app_host_session(&session);
    }
    if is_ide_terminal_session(&session) {
        let bundle_id = session
            .term_bundle_id
            .as_deref()
            .ok_or_else(|| "IDE terminal session has no app bundle metadata".to_string())?;
        return match crate::terminal::jump::jump_to_ide_window(
            bundle_id,
            Some(session.cwd.as_str()),
        ) {
            crate::terminal::jump::JumpResult::Success => Ok(()),
            crate::terminal::jump::JumpResult::SessionNotFound => {
                Err("Session not found".to_string())
            }
            crate::terminal::jump::JumpResult::TerminalNotFound => {
                Err("IDE host app not found".to_string())
            }
            crate::terminal::jump::JumpResult::Failed(msg) => Err(msg),
        };
    }
    if app_host_bundle_id(&session).is_some() {
        return open_app_host_session(&session);
    }

    let pid = session.pid.unwrap_or(0);
    let resolved_tty = resolve_session_tty(&session);
    if let Some(tty) = &resolved_tty {
        if session.tty.as_deref() != Some(tty.as_str()) {
            let resolved_tty = tty.clone();
            state.session_store.update_session(&session_id, |s| {
                s.tty = Some(resolved_tty);
            });
        }
    }

    let has_jump_metadata = pid != 0
        || resolved_tty.is_some()
        || !session.terminal.trim().is_empty()
        || session
            .term_program
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
        || session
            .term_bundle_id
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
        || session
            .wezterm_pane
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
        || session
            .zellij_pane_id
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
        || session
            .cmux_surface_id
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty());
    if !has_jump_metadata {
        return Err("Session has no terminal metadata to jump to".to_string());
    }

    let tree = crate::terminal::process_tree::build_tree();
    let terminal_env = if pid == 0 {
        Default::default()
    } else {
        crate::terminal::process_tree::read_terminal_env(pid, &tree)
    };
    let tmux_pane = if pid == 0 {
        None
    } else {
        crate::terminal::tmux::find_pane_for_pid(pid).map(|pane| pane.target_string())
    };
    let jump_context = crate::terminal::jump::JumpContext {
        pid,
        iterm_session_id: terminal_env.iterm_session_id,
        kitty_window_id: terminal_env.kitty_window_id,
        wezterm_pane: session.wezterm_pane.clone().or(terminal_env.wezterm_pane),
        waveterm_block_id: terminal_env.waveterm_block_id,
        waveterm_tab_id: terminal_env.waveterm_tab_id,
        waveterm_jwt: terminal_env.waveterm_jwt,
        zellij_pane_id: session
            .zellij_pane_id
            .clone()
            .or(terminal_env.zellij_pane_id),
        zellij_session_name: session
            .zellij_session_name
            .clone()
            .or(terminal_env.zellij_session_name),
        cmux_surface_id: session
            .cmux_surface_id
            .clone()
            .or(terminal_env.cmux_surface_id),
        cmux_workspace_id: session
            .cmux_workspace_id
            .clone()
            .or(terminal_env.cmux_workspace_id),
        tmux_pane,
        tmux_env: terminal_env.tmux,
        cwd: Some(session.cwd.clone()).filter(|cwd| !cwd.is_empty()),
        tty_path: resolved_tty,
        terminal_app: Some(session.terminal.clone()).filter(|terminal| !terminal.is_empty()),
        term_program: session.term_program.clone().or(terminal_env.term_program),
        term_bundle_id: session
            .term_bundle_id
            .clone()
            .or(terminal_env.cf_bundle_identifier),
        agent_type: Some(session.agent_type.clone()),
    };

    let fallback_terminal = terminal_hint_for_fallback(&session);
    match crate::terminal::jump::jump_to_terminal_with_context(&jump_context) {
        crate::terminal::jump::JumpResult::Success => Ok(()),
        crate::terminal::jump::JumpResult::SessionNotFound => Err("Session not found".to_string()),
        crate::terminal::jump::JumpResult::TerminalNotFound => {
            log::warn!(
                "Terminal not found in process tree for session {}. Falling back to app activation.",
                session_id
            );
            jump_to_terminal_fallback(&fallback_terminal, &session.cwd)
        }
        crate::terminal::jump::JumpResult::Failed(msg) => {
            log::warn!(
                "Precise terminal jump failed for session {}: {}. Falling back to app activation.",
                session_id,
                msg
            );
            jump_to_terminal_fallback(&fallback_terminal, &session.cwd)
        }
    }
}

fn release_notch_keyboard_focus(app: &tauri::AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(window) = handle.get_webview_window("notch") else {
            return;
        };

        #[cfg(target_os = "macos")]
        {
            use objc2_app_kit::NSWindow;
            if let Ok(ptr) = window.ns_window() {
                unsafe {
                    let ns_window = ptr as *const NSWindow;
                    (*ns_window).resignKeyWindow();
                }
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = window;
        }
    });
}

fn terminal_hint_for_fallback(session: &SessionState) -> String {
    if !session.terminal.trim().is_empty() {
        return session.terminal.clone();
    }

    if let Some(program) = session
        .term_program
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        return fallback_terminal_app_name(program).to_string();
    }

    if let Some(bundle_id) = session
        .term_bundle_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        return fallback_terminal_app_name(bundle_id).to_string();
    }

    String::new()
}

fn jump_to_terminal_fallback(terminal: &str, cwd: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        match open_terminal_at_cwd(terminal, cwd) {
            Ok(()) => return Ok(()),
            Err(cwd_err) => {
                log::warn!(
                    "Windows terminal cwd fallback failed for {:?}: {}. Trying app activation.",
                    terminal,
                    cwd_err
                );
            }
        }
    }

    match jump_to_terminal_app_fallback(terminal) {
        Ok(()) => Ok(()),
        Err(app_err) => {
            log::warn!(
                "Terminal app fallback failed for {:?}: {}. Trying cwd fallback.",
                terminal,
                app_err
            );
            open_terminal_at_cwd(terminal, cwd).map_err(|cwd_err| {
                if cwd.trim().is_empty() {
                    app_err
                } else {
                    format!("{}; cwd fallback failed: {}", app_err, cwd_err)
                }
            })
        }
    }
}

fn jump_to_terminal_app_fallback(terminal: &str) -> Result<(), String> {
    if terminal.trim().is_empty() {
        return Err("Session has no PID, TTY, or terminal app".to_string());
    }
    if !can_fallback_to_terminal_app(terminal) {
        return Err(format!(
            "Session target {:?} is not a recognized terminal app",
            terminal
        ));
    }

    match crate::terminal::jump::jump_to_terminal_app(terminal) {
        crate::terminal::jump::JumpResult::Success => Ok(()),
        crate::terminal::jump::JumpResult::SessionNotFound => Err("Session not found".to_string()),
        crate::terminal::jump::JumpResult::TerminalNotFound => {
            Err("Terminal not found in process tree".to_string())
        }
        crate::terminal::jump::JumpResult::Failed(msg) => Err(format!("Jump failed: {}", msg)),
    }
}

fn can_fallback_to_terminal_app(terminal: &str) -> bool {
    crate::terminal::registry::is_terminal(terminal)
}

fn open_terminal_at_cwd(terminal: &str, cwd: &str) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    let _ = terminal;

    let cwd = cwd.trim();
    if cwd.is_empty() {
        return Err("Session has no working directory".to_string());
    }
    let path = std::path::Path::new(cwd);
    if !path.is_dir() {
        return Err(format!("Working directory {:?} does not exist", cwd));
    }

    #[cfg(target_os = "macos")]
    {
        let app = fallback_terminal_app_name(terminal);
        let output = std::process::Command::new("/usr/bin/open")
            .args(["-a", app, cwd])
            .output()
            .map_err(|e| format!("Failed to open terminal: {}", e))?;
        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        #[cfg(target_os = "windows")]
        {
            open_terminal_at_cwd_windows(terminal, cwd)
        }
        #[cfg(not(target_os = "windows"))]
        {
            Err("Opening a terminal at the session cwd is only supported on macOS".to_string())
        }
    }
}

#[cfg(target_os = "windows")]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum WindowsTerminalLauncher {
    WindowsTerminal,
    Cmd,
    PowerShell,
    Pwsh,
}

#[cfg(target_os = "windows")]
fn windows_terminal_launch_order(terminal: &str) -> Vec<WindowsTerminalLauncher> {
    let lower = terminal.to_ascii_lowercase();
    if lower.contains("pwsh") {
        return vec![
            WindowsTerminalLauncher::Pwsh,
            WindowsTerminalLauncher::PowerShell,
            WindowsTerminalLauncher::WindowsTerminal,
            WindowsTerminalLauncher::Cmd,
        ];
    }
    if lower.contains("powershell") {
        return vec![
            WindowsTerminalLauncher::PowerShell,
            WindowsTerminalLauncher::Pwsh,
            WindowsTerminalLauncher::WindowsTerminal,
            WindowsTerminalLauncher::Cmd,
        ];
    }
    if lower.contains("cmd") || lower.contains("command prompt") {
        return vec![
            WindowsTerminalLauncher::Cmd,
            WindowsTerminalLauncher::WindowsTerminal,
            WindowsTerminalLauncher::PowerShell,
            WindowsTerminalLauncher::Pwsh,
        ];
    }
    vec![
        WindowsTerminalLauncher::WindowsTerminal,
        WindowsTerminalLauncher::Cmd,
        WindowsTerminalLauncher::PowerShell,
        WindowsTerminalLauncher::Pwsh,
    ]
}

#[cfg(target_os = "windows")]
fn open_terminal_at_cwd_windows(terminal: &str, cwd: &str) -> Result<(), String> {
    let mut errors = Vec::new();
    for launcher in windows_terminal_launch_order(terminal) {
        match spawn_windows_terminal_launcher(launcher, cwd) {
            Ok(()) => return Ok(()),
            Err(err) => errors.push(err),
        }
    }
    Err(format!(
        "Failed to open Windows terminal at {:?}: {}",
        cwd,
        errors.join("; ")
    ))
}

#[cfg(target_os = "windows")]
fn spawn_windows_terminal_launcher(
    launcher: WindowsTerminalLauncher,
    cwd: &str,
) -> Result<(), String> {
    use std::os::windows::process::CommandExt;

    const CREATE_NEW_CONSOLE: u32 = 0x00000010;

    let mut command = match launcher {
        WindowsTerminalLauncher::WindowsTerminal => {
            let mut command =
                std::process::Command::new(crate::agents::executable::command_path("wt"));
            command.args(["-d", cwd]);
            command
        }
        WindowsTerminalLauncher::Cmd => {
            let mut command =
                std::process::Command::new(crate::agents::executable::command_path("cmd"));
            command.arg("/K");
            command.current_dir(cwd);
            command.creation_flags(CREATE_NEW_CONSOLE);
            command
        }
        WindowsTerminalLauncher::PowerShell => {
            let mut command =
                std::process::Command::new(crate::agents::executable::command_path("powershell"));
            command.args([
                "-NoExit",
                "-Command",
                &format!(
                    "Set-Location -LiteralPath {}",
                    powershell_string_literal(cwd)
                ),
            ]);
            command
        }
        WindowsTerminalLauncher::Pwsh => {
            let mut command =
                std::process::Command::new(crate::agents::executable::command_path("pwsh"));
            command.args([
                "-NoExit",
                "-Command",
                &format!(
                    "Set-Location -LiteralPath {}",
                    powershell_string_literal(cwd)
                ),
            ]);
            command
        }
    };

    command
        .spawn()
        .map(|_| ())
        .map_err(|err| format!("{launcher:?}: {err}"))
}

fn fallback_terminal_app_name(terminal: &str) -> &'static str {
    let lower = terminal.to_ascii_lowercase();
    if lower.contains("iterm") {
        "iTerm"
    } else if lower.contains("ghostty") {
        "Ghostty"
    } else if lower.contains("wave") {
        "Wave"
    } else if lower.contains("wezterm") || lower.contains("wez") {
        "WezTerm"
    } else if lower.contains("kitty") {
        "kitty"
    } else {
        "Terminal"
    }
}

fn osascript_ok(script: &str) -> bool {
    std::process::Command::new("osascript")
        .args(["-e", script])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

pub(crate) fn find_binary(name: &str) -> Option<String> {
    if let Some(path) = crate::agents::executable::find_binary(name) {
        return Some(path.display().to_string());
    }

    let home = dirs::home_dir()
        .map(|path| path.display().to_string())
        .unwrap_or_default();
    [
        format!("/opt/homebrew/bin/{name}"),
        format!("/usr/local/bin/{name}"),
        format!("/usr/bin/{name}"),
        format!("{home}/.local/bin/{name}"),
        format!("/Applications/cmux.app/Contents/Resources/bin/{name}"),
        format!("{home}/Applications/cmux.app/Contents/Resources/bin/{name}"),
        format!("/Applications/Kaku.app/Contents/MacOS/{name}"),
        format!("{home}/Applications/Kaku.app/Contents/MacOS/{name}"),
    ]
    .into_iter()
    .find(|path| std::path::Path::new(path).exists())
    .or_else(|| {
        #[cfg(not(target_os = "windows"))]
        {
            std::process::Command::new("which")
                .arg(name)
                .output()
                .ok()
                .filter(|output| output.status.success())
                .and_then(|output| String::from_utf8(output.stdout).ok())
                .map(|path| path.trim().to_string())
                .filter(|path| !path.is_empty())
        }
        #[cfg(target_os = "windows")]
        {
            None
        }
    })
}

pub(crate) fn launch_in_terminal(terminal: &str, cwd: &str, command: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let _ = terminal;
        return launch_in_windows_terminal(cwd, command);
    }

    #[cfg(target_os = "macos")]
    {
        let shell_command = format!("cd {} && {}", shell_quote(cwd), command);
        let lower = terminal.to_ascii_lowercase();

        let script = if lower.contains("iterm") {
            format!(
                r#"tell application "iTerm2"
    activate
    create window with default profile command "{}"
end tell"#,
                applescript_escape(&shell_command)
            )
        } else {
            format!(
                r#"tell application "Terminal"
    activate
    do script "{}"
end tell"#,
                applescript_escape(&shell_command)
            )
        };

        let output = std::process::Command::new("osascript")
            .args(["-e", &script])
            .output()
            .map_err(|e| format!("Failed to run osascript: {e}"))?;

        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
        }
    }

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        let _ = terminal;
        let _ = cwd;
        let _ = command;
        Err("Opening an authorization terminal is not supported on this platform yet.".to_string())
    }
}

#[cfg(target_os = "windows")]
fn launch_in_windows_terminal(cwd: &str, command: &str) -> Result<(), String> {
    if std::process::Command::new(crate::agents::executable::command_path("wt"))
        .args(windows_terminal_command_args(cwd, command))
        .spawn()
        .is_ok()
    {
        return Ok(());
    }

    use std::os::windows::process::CommandExt;
    const CREATE_NEW_CONSOLE: u32 = 0x00000010;

    std::process::Command::new(crate::agents::executable::command_path("cmd"))
        .args(["/K", command])
        .current_dir(cwd)
        .creation_flags(CREATE_NEW_CONSOLE)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Failed to open Windows terminal: {e}"))
}

#[cfg(target_os = "windows")]
fn windows_terminal_command_args(cwd: &str, command: &str) -> Vec<String> {
    vec![
        "-d".to_string(),
        cwd.to_string(),
        "cmd.exe".to_string(),
        "/K".to_string(),
        command.to_string(),
    ]
}

#[cfg(target_os = "windows")]
pub(crate) fn shell_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn applescript_escape(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn applescript_string_literal(value: &str) -> String {
    let normalized = value.replace("\r\n", "\n").replace('\r', "\n");
    let parts = normalized
        .split('\n')
        .map(|part| format!("\"{}\"", applescript_escape(part)))
        .collect::<Vec<_>>();
    if parts.is_empty() {
        "\"\"".to_string()
    } else {
        parts.join(" & linefeed & ")
    }
}

#[tauri::command]
pub async fn is_terminal_focused(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<bool, String> {
    let session = state
        .session_store
        .get_session(&session_id)
        .ok_or_else(|| format!("Session {} not found", session_id))?;

    let pid = session.pid.unwrap_or(0);
    if pid == 0 {
        return Ok(false);
    }

    Ok(
        crate::terminal::suppression::is_terminal_focused_with_session(
            pid,
            session.term_bundle_id.as_deref(),
            session.wezterm_pane.as_deref(),
            session.zellij_pane_id.as_deref(),
            session.cmux_surface_id.as_deref(),
            session.tty.as_deref(),
        ),
    )
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookDoctorCheck {
    pub id: String,
    pub label: String,
    pub status: String,
    pub detail: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookDoctorReport {
    pub generated_at: i64,
    pub checks: Vec<HookDoctorCheck>,
}

fn installed_hooks_check(installed_names: &[String], needing_repair: &[String]) -> HookDoctorCheck {
    let status = if installed_names.is_empty() || !needing_repair.is_empty() {
        "warn"
    } else {
        "ok"
    };
    let detail = if installed_names.is_empty() {
        "No adapter configs contain Vibe Board hooks".to_string()
    } else if needing_repair.is_empty() {
        format!(
            "{} adapter configs contain Vibe Board hooks: {}",
            installed_names.len(),
            installed_names.join(", ")
        )
    } else {
        format!(
            "{} adapter configs contain Vibe Board hooks; {} need reinstall: {}",
            installed_names.len(),
            needing_repair.len(),
            needing_repair.join(", ")
        )
    };
    HookDoctorCheck {
        id: "installed-hooks".to_string(),
        label: "Installed hooks".to_string(),
        status: status.to_string(),
        detail,
    }
}

#[tauri::command]
pub async fn run_hook_doctor(state: State<'_, AppState>) -> Result<HookDoctorReport, String> {
    let mut checks = Vec::new();
    let bridge = crate::agents::hook_manager::bridge_binary_path();
    checks.push(HookDoctorCheck {
        id: "bridge-binary".to_string(),
        label: "Bridge binary".to_string(),
        status: if bridge.exists() { "ok" } else { "error" }.to_string(),
        detail: bridge.display().to_string(),
    });
    checks.push(HookDoctorCheck {
        id: "bridge-current".to_string(),
        label: "Bridge version".to_string(),
        status: if crate::agents::hook_manager::bridge_binary_is_current() {
            "ok"
        } else {
            "warn"
        }
        .to_string(),
        detail: "Installed hook bridge matches bundled bridge".to_string(),
    });

    let endpoint = hook_endpoint::current();
    #[cfg(unix)]
    {
        let socket_status = tokio::time::timeout(
            Duration::from_millis(300),
            tokio::net::UnixStream::connect(&endpoint.socket_path),
        )
        .await
        .is_ok_and(|result| result.is_ok());
        checks.push(HookDoctorCheck {
            id: "hook-server".to_string(),
            label: "Hook server socket".to_string(),
            status: if socket_status { "ok" } else { "warn" }.to_string(),
            detail: endpoint.socket_path.clone(),
        });
    }

    let tcp_status = tokio::time::timeout(
        Duration::from_millis(300),
        tokio::net::TcpStream::connect(endpoint.tcp_addr()),
    )
    .await
    .is_ok_and(|result| result.is_ok());
    checks.push(HookDoctorCheck {
        id: "hook-server-tcp".to_string(),
        label: "Hook server TCP".to_string(),
        status: if tcp_status { "ok" } else { "warn" }.to_string(),
        detail: endpoint.tcp_addr(),
    });

    let mut installed_hook_names = Vec::new();
    let mut hooks_needing_repair = Vec::new();
    for adapter in &state.adapters {
        if !adapter.hooks_installed() {
            continue;
        }
        installed_hook_names.push(adapter.display_name().to_string());
        let Some(profile) = crate::agents::profiles::profile_for_agent(adapter.name()) else {
            continue;
        };
        let health = crate::agents::profiles::install_health_for_profile(&profile);
        if health.is_present() && health != crate::agents::profiles::HookInstallHealth::Installed {
            hooks_needing_repair.push(format!(
                "{} ({})",
                adapter.display_name(),
                health.as_status_str()
            ));
        }
    }
    checks.push(installed_hooks_check(
        &installed_hook_names,
        &hooks_needing_repair,
    ));

    let bridge_invocations = recent_bridge_invocations(50);
    checks.push(HookDoctorCheck {
        id: "bridge-invocations".to_string(),
        label: "Bridge invocation trace".to_string(),
        status: if bridge_invocations.is_empty() {
            "info"
        } else {
            "ok"
        }
        .to_string(),
        detail: bridge_invocations
            .last()
            .cloned()
            .unwrap_or_else(|| "No bridge invocations recorded yet".to_string()),
    });

    let mut present_profiles = 0usize;
    let mut unhealthy_profiles = Vec::new();
    for adapter in &state.adapters {
        let Some(profile) = crate::agents::profiles::profile_for_agent(adapter.name()) else {
            continue;
        };
        let health = crate::agents::profiles::install_health_for_profile(&profile);
        if !health.is_present() {
            continue;
        }
        present_profiles += 1;
        checks.push(HookDoctorCheck {
            id: format!("hook-profile-{}", profile.id),
            label: format!("{} hook profile", adapter.display_name()),
            status: doctor_status_for_hook_health(health).to_string(),
            detail: format!(
                "{} ({})",
                health.as_status_str(),
                profile.configuration_path
            ),
        });
        if health != crate::agents::profiles::HookInstallHealth::Installed {
            unhealthy_profiles.push(format!("{}={}", profile.id, health.as_status_str()));
        }
    }
    checks.push(HookDoctorCheck {
        id: "hook-profile-health".to_string(),
        label: "Hook event coverage".to_string(),
        status: if unhealthy_profiles.is_empty() {
            if present_profiles > 0 {
                "ok"
            } else {
                "warn"
            }
        } else {
            "warn"
        }
        .to_string(),
        detail: if unhealthy_profiles.is_empty() {
            format!("{present_profiles} installed profiles checked")
        } else {
            unhealthy_profiles.join(", ")
        },
    });

    append_codex_doctor_checks(&mut checks);

    #[cfg(target_os = "macos")]
    checks.push(HookDoctorCheck {
        id: "automation-permission".to_string(),
        label: "macOS automation".to_string(),
        status: if osascript_ok(r#"tell application "System Events" to get name of first application process whose frontmost is true"#) {
            "ok"
        } else {
            "warn"
        }
        .to_string(),
        detail: "Required for terminal focus".to_string(),
    });

    #[cfg(target_os = "windows")]
    checks.push(HookDoctorCheck {
        id: "platform-integration".to_string(),
        label: "Windows hook transport".to_string(),
        status: "info".to_string(),
        detail: "Windows uses TCP hook delivery and CLI config files; macOS automation permission is not required.".to_string(),
    });

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    checks.push(HookDoctorCheck {
        id: "platform-integration".to_string(),
        label: "Platform hook transport".to_string(),
        status: "info".to_string(),
        detail: "This platform uses TCP hook delivery and CLI config files; macOS automation permission is not required.".to_string(),
    });

    #[cfg(target_os = "macos")]
    let required_binaries: &[&str] = &["tmux", "sqlite3"];
    #[cfg(not(target_os = "macos"))]
    let required_binaries: &[&str] = &[];

    for binary in required_binaries {
        checks.push(HookDoctorCheck {
            id: format!("binary-{binary}"),
            label: format!("{binary} binary"),
            status: if find_binary(binary).is_some() {
                "ok"
            } else {
                "warn"
            }
            .to_string(),
            detail: find_binary(binary).unwrap_or_else(|| "not found in common paths".to_string()),
        });
    }

    // Check optional terminal multiplexers — only report found ones as OK,
    // and add a single info-level note if none are found
    let optional_terminals = ["zellij", "cmux", "wezterm", "kaku", "kitten"];
    let mut found_any_terminal = false;

    for binary in optional_terminals {
        if let Some(path) = find_binary(binary) {
            found_any_terminal = true;
            checks.push(HookDoctorCheck {
                id: format!("binary-{binary}"),
                label: format!("{binary} binary"),
                status: "ok".to_string(),
                detail: path,
            });
        }
    }

    if !found_any_terminal {
        checks.push(HookDoctorCheck {
            id: "optional-terminals".to_string(),
            label: "Optional terminal multiplexers".to_string(),
            status: "info".to_string(),
            detail: "No optional terminals found (zellij, cmux, wezterm, kaku, kitten). Only install if you use them.".to_string(),
        });
    }

    if let Some(warning) = check_bare_mode() {
        checks.push(HookDoctorCheck {
            id: "claude-bare-mode".to_string(),
            label: "Claude Code bare mode".to_string(),
            status: "error".to_string(),
            detail: warning,
        });
    } else {
        checks.push(HookDoctorCheck {
            id: "claude-bare-mode".to_string(),
            label: "Claude Code bare mode".to_string(),
            status: "ok".to_string(),
            detail: "CLAUDE_CODE_SIMPLE is not set".to_string(),
        });
    }

    {
        let home = dirs::home_dir();
        let trust_path = home
            .as_ref()
            .map(|h| h.join(".gemini").join("trustedFolders.json"));
        let cwd = std::env::current_dir().ok();
        let mut trust_ok = true;
        let mut trust_detail = "Gemini folder trust: no working directory".to_string();

        if let (Some(trust_path), Some(cwd)) = (&trust_path, &cwd) {
            if let Ok(content) = std::fs::read_to_string(trust_path) {
                if let Ok(trust) = serde_json::from_str::<serde_json::Value>(&content) {
                    if let Some(obj) = trust.as_object() {
                        for (_path, level) in obj {
                            if level.as_str() == Some("TRUST_PARENT") {
                                let parent = std::path::PathBuf::from(_path);
                                if cwd.starts_with(&parent) {
                                    trust_detail =
                                        format!("{} is trusted via {}", cwd.display(), _path);
                                    trust_ok = true;
                                    break;
                                }
                                trust_ok = false;
                                trust_detail = format!(
                                    "{} is NOT in any trusted folder. Add it via: gemini trust",
                                    cwd.display()
                                );
                            } else if level.as_str() == Some("TRUST_FOLDER") {
                                if _path == &cwd.display().to_string() {
                                    trust_detail = format!("{} is trusted", cwd.display());
                                    trust_ok = true;
                                    break;
                                }
                                trust_ok = false;
                                trust_detail = format!(
                                    "{} is NOT in any trusted folder. Add it via: gemini trust",
                                    cwd.display()
                                );
                            }
                        }
                    }
                }
            }
        }

        checks.push(HookDoctorCheck {
            id: "gemini-folder-trust".to_string(),
            label: "Gemini folder trust".to_string(),
            status: if trust_ok { "ok" } else { "warn" }.to_string(),
            detail: trust_detail,
        });
    }

    Ok(HookDoctorReport {
        generated_at: chrono::Utc::now().timestamp(),
        checks,
    })
}

fn append_codex_doctor_checks(checks: &mut Vec<HookDoctorCheck>) {
    let probe = crate::agents::codex::probe_app_server_readiness();
    for check in probe.checks {
        if matches!(check.id.as_str(), "server-port" | "live-sync") {
            continue;
        }
        checks.push(HookDoctorCheck {
            id: format!("codex-{}", check.id),
            label: format!("Codex {}", check.label),
            status: check.status,
            detail: check.detail,
        });
    }
}

fn doctor_status_for_hook_health(
    health: crate::agents::profiles::HookInstallHealth,
) -> &'static str {
    match health {
        crate::agents::profiles::HookInstallHealth::Installed => "ok",
        crate::agents::profiles::HookInstallHealth::SettingsCorrupted
        | crate::agents::profiles::HookInstallHealth::Error => "error",
        crate::agents::profiles::HookInstallHealth::NotInstalled
        | crate::agents::profiles::HookInstallHealth::NeedsReinstall => "warn",
    }
}

// ── Config Commands ───────────────────────────────────────────────

#[tauri::command]
pub async fn get_config(state: State<'_, AppState>) -> Result<AppConfig, String> {
    let mut config = state.config_store.get();
    config.launch_at_login = get_launch_at_login_state();
    Ok(config)
}

#[tauri::command]
pub async fn update_config(
    state: State<'_, AppState>,
    mut config: AppConfig,
) -> Result<(), String> {
    // Keep a bad/old value from turning the fallback poll into a busy loop.
    config.session_refresh_interval_seconds = config.session_refresh_interval_seconds.clamp(1, 30);
    if config.window_close_behavior != "exit" {
        config.window_close_behavior = "tray".to_string();
    }
    if config.host_visibility_mode != "follow" {
        config.host_visibility_mode = "independent".to_string();
    }
    if config.notch_position_mode == "custom" {
        config.notch_position_mode = "top".to_string();
        config.notch_vertical_offset = 0.0;
    } else if !matches!(
        config.notch_position_mode.as_str(),
        "top" | "left" | "right"
    ) {
        config.notch_position_mode = "top".to_string();
    }
    if !config.notch_vertical_offset.is_finite() {
        config.notch_vertical_offset = 0.0;
    }
    config.auto_launch_agents = config
        .auto_launch_agents
        .into_iter()
        .map(|agent| agent.trim().to_string())
        .filter(|agent| !agent.is_empty() && agent.len() <= 64)
        .take(32)
        .collect();
    let mut seen_launch_agents = std::collections::HashSet::new();
    config
        .auto_launch_agents
        .retain(|agent| seen_launch_agents.insert(agent.clone()));
    config.codex_app_server_sync_configured = true;
    let previous = state.config_store.get();
    state.config_store.update(config.clone())?;
    if previous.analytics_enabled != config.analytics_enabled {
        state.telemetry.handle_consent_changed(&config).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn set_language(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    language: String,
) -> Result<(), String> {
    let language = match language.as_str() {
        "en" | "zh" => language,
        other => return Err(format!("Unsupported language: {}", other)),
    };
    let mut config = state.config_store.get();
    config.language = language;
    state.config_store.update(config)?;
    if let Err(error) = crate::refresh_tray_menu(&app) {
        log::warn!("Failed to refresh tray menu language: {error}");
    }
    Ok(())
}

#[tauri::command]
pub async fn set_analytics_enabled(
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<(), String> {
    let mut config = state.config_store.get();
    config.analytics_enabled = enabled;
    config.analytics_consent_prompt_completed = true;
    state.config_store.update(config.clone())?;
    state.telemetry.handle_consent_changed(&config).await;
    Ok(())
}

#[tauri::command]
pub async fn set_launch_at_login(state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
    set_launch_at_login_state(enabled)?;
    let mut config = state.config_store.get();
    config.launch_at_login = enabled;
    state.config_store.update(config)
}

#[cfg(target_os = "macos")]
fn launch_agent_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "Unable to resolve home directory".to_string())?;
    Ok(home
        .join("Library")
        .join("LaunchAgents")
        .join("com.vibeboard.desktop.login.plist"))
}

#[cfg(target_os = "macos")]
fn legacy_launch_agent_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "Unable to resolve home directory".to_string())?;
    Ok(home
        .join("Library")
        .join("LaunchAgents")
        .join("com.agentisland.desktop.login.plist"))
}

#[cfg(target_os = "macos")]
const APP_BUNDLE_IDENTIFIER: &str = "com.vibeboard.desktop";

#[cfg(target_os = "macos")]
fn remove_launch_agent(plist_path: &Path) -> Result<(), String> {
    if plist_path.exists() {
        let domain = format!("gui/{}", unsafe { libc::getuid() });
        let _ = std::process::Command::new("launchctl")
            .arg("bootout")
            .arg(domain)
            .arg(plist_path)
            .output();
        std::fs::remove_file(plist_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn set_launch_at_login_state(enabled: bool) -> Result<(), String> {
    let plist_path = launch_agent_path()?;
    if enabled {
        // Remove the Agent Island revision so startup does not double-launch.
        remove_launch_agent(&legacy_launch_agent_path()?)?;
        if let Some(parent) = plist_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let plist = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.vibeboard.desktop.login</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/open</string>
    <string>-b</string>
    <string>{APP_BUNDLE_IDENTIFIER}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
"#
        );
        std::fs::write(plist_path, plist).map_err(|e| e.to_string())?;
    } else {
        remove_launch_agent(&plist_path)?;
        remove_launch_agent(&legacy_launch_agent_path()?)?;
    }
    Ok(())
}

#[cfg(target_os = "windows")]
const WINDOWS_RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";

#[cfg(target_os = "windows")]
const WINDOWS_RUN_VALUE: &str = "Vibe Board";

#[cfg(target_os = "windows")]
const LEGACY_WINDOWS_RUN_VALUE: &str = "Agent Island";

#[cfg(target_os = "windows")]
fn remove_legacy_windows_run_value() {
    let _ = crate::platform::process::background_command(crate::agents::executable::command_path(
        "reg",
    ))
    .args([
        "delete",
        WINDOWS_RUN_KEY,
        "/v",
        LEGACY_WINDOWS_RUN_VALUE,
        "/f",
    ])
    .output();
}

#[cfg(target_os = "windows")]
fn set_launch_at_login_state(enabled: bool) -> Result<(), String> {
    if enabled {
        remove_legacy_windows_run_value();
        let exe = std::env::current_exe()
            .map_err(|err| format!("Unable to resolve current executable: {err}"))?;
        let command = format!("\"{}\"", exe.display());
        let output = crate::platform::process::background_command(
            crate::agents::executable::command_path("reg"),
        )
        .args([
            "add",
            WINDOWS_RUN_KEY,
            "/v",
            WINDOWS_RUN_VALUE,
            "/t",
            "REG_SZ",
            "/d",
            &command,
            "/f",
        ])
        .output()
        .map_err(|err| format!("Failed to update Windows startup registry: {err}"))?;
        return reg_output_result(output, "Failed to enable Windows launch at login");
    }

    let output = crate::platform::process::background_command(
        crate::agents::executable::command_path("reg"),
    )
    .args(["delete", WINDOWS_RUN_KEY, "/v", WINDOWS_RUN_VALUE, "/f"])
    .output()
    .map_err(|err| format!("Failed to update Windows startup registry: {err}"))?;
    remove_legacy_windows_run_value();
    if output.status.success() || !get_launch_at_login_state() {
        Ok(())
    } else {
        reg_output_result(output, "Failed to disable Windows launch at login")
    }
}

#[cfg(target_os = "windows")]
fn reg_output_result(output: std::process::Output, fallback: &str) -> Result<(), String> {
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Err(if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        fallback.to_string()
    })
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn set_launch_at_login_state(_enabled: bool) -> Result<(), String> {
    Err("Launch at login is not supported on this platform yet".to_string())
}

#[cfg(target_os = "macos")]
fn get_launch_at_login_state() -> bool {
    launch_agent_path()
        .map(|path| path.exists())
        .unwrap_or(false)
}

#[cfg(target_os = "windows")]
fn get_launch_at_login_state() -> bool {
    crate::platform::process::background_command(crate::agents::executable::command_path("reg"))
        .args(["query", WINDOWS_RUN_KEY, "/v", WINDOWS_RUN_VALUE])
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn get_launch_at_login_state() -> bool {
    false
}

#[tauri::command]
pub async fn set_island_feature_flags(
    state: State<'_, AppState>,
    tips_enabled: bool,
    pixel_cursor_enabled: bool,
    confetti_enabled: bool,
    follow_focus: bool,
) -> Result<(), String> {
    let mut config = state.config_store.get();
    config.tips_enabled = tips_enabled;
    config.pixel_cursor_enabled = pixel_cursor_enabled;
    config.confetti_enabled = confetti_enabled;
    config.follow_focus = follow_focus;
    state.config_store.update(config)
}

// ── Hook Management Commands ──────────────────────────────────────

pub fn check_bare_mode() -> Option<String> {
    if std::env::var("CLAUDE_CODE_SIMPLE").ok().as_deref() == Some("1") {
        return Some("CLAUDE_CODE_SIMPLE=1 is set in the process environment.".to_string());
    }
    if let Some(val) = crate::agents::executable::login_shell_var("CLAUDE_CODE_SIMPLE") {
        if val == "1" {
            let shell = std::env::var("SHELL")
                .ok()
                .unwrap_or_else(|| "/bin/zsh".to_string());
            return Some(format!(
                "CLAUDE_CODE_SIMPLE=1 is set in {} config (bare mode skips all hooks).",
                shell.rsplit('/').next().unwrap_or("shell")
            ));
        }
    }
    None
}

pub fn ensure_gemini_folder_trust() {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return,
    };
    let trust_path = home.join(".gemini").join("trustedFolders.json");
    let cwd = match std::env::current_dir() {
        Ok(d) => d,
        Err(_) => return,
    };
    let cwd_str = cwd.display().to_string();

    let mut trust: serde_json::Value = match std::fs::read_to_string(&trust_path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or(serde_json::json!({})),
        Err(_) => serde_json::json!({}),
    };

    if let Some(obj) = trust.as_object() {
        for (_path, level) in obj {
            if level.as_str() == Some("TRUST_PARENT") {
                let parent = std::path::PathBuf::from(_path);
                if cwd.starts_with(&parent) {
                    return;
                }
            }
            if level.as_str() == Some("TRUST_FOLDER") && _path == &cwd_str {
                return;
            }
        }
    }

    if let Some(obj) = trust.as_object_mut() {
        obj.insert(cwd_str.clone(), serde_json::json!("TRUST_PARENT"));
    }
    if let Some(parent) = trust_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(formatted) = serde_json::to_string_pretty(&trust) {
        let _ = std::fs::write(&trust_path, formatted);
        log::info!("Added {} to Gemini trusted folders", cwd_str);
    }
}

#[tauri::command]
pub async fn install_hooks(state: State<'_, AppState>, agent: String) -> Result<(), String> {
    log::info!("Installing hooks for agent: {}", agent);
    let adapter = state
        .adapters
        .iter()
        .find(|a| a.name() == agent)
        .ok_or_else(|| format!("Unknown agent: {}", agent))?;
    if matches!(
        adapter.detect_status_now(),
        crate::agents::AdapterStatus::Unavailable
    ) {
        #[cfg(target_os = "windows")]
        if agent == "cline" {
            return Err(
                "Cline Hooks are not available on Windows yet; Cline currently supports hooks on macOS/Linux only."
                    .to_string(),
            );
        }
        return Err(format!(
            "{} CLI not found. Searched process PATH, login shell PATH, \
             and common directories (homebrew, nvm, volta, mise, cargo). \
             Confirm it is installed and try restarting Vibe Board.",
            adapter.display_name()
        ));
    }
    adapter.install_hooks().map_err(|e| e.to_string())?;

    if agent == "claude-code" {
        if let Some(warning) = check_bare_mode() {
            log::warn!("Claude Code bare mode detected: {}", warning);
        }
    }
    if agent == "gemini" {
        ensure_gemini_folder_trust();
    }

    if let Err(e) = state.config_store.mark_agent_enabled(&agent) {
        log::warn!(
            "Failed to persist enabled-agent intent for {}: {}",
            agent,
            e
        );
    }
    let config = state.config_store.get();
    state.telemetry.record_hook_install(&config, &agent).await;
    Ok(())
}

#[tauri::command]
pub async fn remove_hooks(state: State<'_, AppState>, agent: String) -> Result<(), String> {
    log::info!("Removing hooks for agent: {}", agent);
    let adapter = state
        .adapters
        .iter()
        .find(|a| a.name() == agent)
        .ok_or_else(|| format!("Unknown agent: {}", agent))?;
    adapter.remove_hooks().map_err(|e| e.to_string())?;
    if let Err(e) = state.config_store.mark_agent_disabled(&agent) {
        log::warn!("Failed to clear enabled-agent intent for {}: {}", agent, e);
    }
    let config = state.config_store.get();
    state.telemetry.record_hook_uninstall(&config, &agent).await;
    Ok(())
}

#[tauri::command]
pub async fn get_adapter_status(state: State<'_, AppState>) -> Result<Vec<AdapterInfo>, String> {
    let infos: Vec<AdapterInfo> = state
        .adapters
        .iter()
        .map(|a| AdapterInfo {
            name: a.name().to_string(),
            display_name: a.display_name().to_string(),
            icon: a.icon().to_string(),
            status: a.status(),
        })
        .collect();
    Ok(infos)
}

// ── Chat History Commands ────────────────────────────────────────

#[tauri::command]
pub async fn get_chat_history(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<ParsedMessage>, String> {
    parse_session_messages_for_command(&state, &session_id).map(|either| match either {
        SessionMessagesResult::Local(messages) => messages,
        SessionMessagesResult::Remote(messages) => messages,
    })
}

/// Paginated slice of a session's chat history. Used by the frontend to load
/// only the tail of a transcript on first open (typical 50 messages instead
/// of the full file, which can be 100MB+ for long Codex sessions).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatHistorySlice {
    pub messages: Vec<ParsedMessage>,
    pub has_more: bool,
    pub first_message_id: Option<String>,
    pub total_count: usize,
    pub transcript_path: Option<String>,
}

const DEFAULT_TAIL_LIMIT: usize = 50;
const MAX_TAIL_LIMIT: usize = 500;

#[tauri::command]
pub async fn get_chat_history_tail(
    state: State<'_, AppState>,
    session_id: String,
    limit: Option<usize>,
    before_id: Option<String>,
) -> Result<ChatHistorySlice, String> {
    let limit = limit.unwrap_or(DEFAULT_TAIL_LIMIT).clamp(1, MAX_TAIL_LIMIT);
    let (messages, transcript_path) = match parse_session_messages_for_command(&state, &session_id)?
    {
        SessionMessagesResult::Local(messages) => {
            let path = resolve_transcript_path_for_session(&state, &session_id);
            (messages, path)
        }
        SessionMessagesResult::Remote(messages) => (messages, None),
    };

    let total_count = messages.len();
    let end = match before_id.as_deref() {
        Some(id) => messages
            .iter()
            .position(|m| m.id == id)
            .unwrap_or(total_count),
        None => total_count,
    };
    let start = end.saturating_sub(limit);

    let slice = messages[start..end].to_vec();
    let first_message_id = slice.first().map(|m| m.id.clone());

    Ok(ChatHistorySlice {
        messages: slice,
        has_more: start > 0,
        first_message_id,
        total_count,
        transcript_path: transcript_path.map(|p| p.to_string_lossy().into_owned()),
    })
}

enum SessionMessagesResult {
    Local(Vec<ParsedMessage>),
    Remote(Vec<ParsedMessage>),
}

fn resolve_transcript_path_for_session(
    state: &State<'_, AppState>,
    session_id: &str,
) -> Option<PathBuf> {
    let session = state.session_store.get_session(session_id)?;
    let cwd = session.cwd.clone();
    let mut projects_dirs = all_projects_dirs();
    if let Some(root) = session
        .engine_config_root
        .as_ref()
        .filter(|root| !root.is_empty())
    {
        let custom_projects = crate::agents::claude_code::expand_tilde(root).join("projects");
        if custom_projects.is_dir() && !projects_dirs.iter().any(|d| d == &custom_projects) {
            projects_dirs.push(custom_projects);
        }
    }
    if session.engine_label.as_deref() == Some("Claude Desktop") {
        crate::hooks::claude_desktop_watcher::find_audit_file_for_cli_session(session_id)
    } else if session.agent_type == "codex" {
        discover_codex_session_file(session_id)
            .or_else(|| discover_session_file_in_dirs(session_id, &cwd, &projects_dirs))
    } else {
        discover_session_file_in_dirs(session_id, &cwd, &projects_dirs)
    }
}

fn parse_session_messages_for_command(
    state: &State<'_, AppState>,
    session_id: &str,
) -> Result<SessionMessagesResult, String> {
    let session = state.session_store.get_session(session_id);
    let file_path = resolve_transcript_path_for_session(state, session_id);

    let Some(file_path) = file_path else {
        // No JSONL file — build chat history from raw hook events.
        // This covers agents like OpenCode that don't write transcript files.
        let raw_events = state.hook_server.raw_events_for_session(session_id);
        if !raw_events.is_empty() {
            let fallback_session = session.unwrap_or_else(|| {
                crate::hooks::session_store::SessionState::new(
                    session_id.to_string(),
                    "unknown".to_string(),
                    String::new(),
                    String::new(),
                    String::new(),
                )
            });
            return Ok(SessionMessagesResult::Remote(remote_session_chat_history(
                &fallback_session,
                raw_events,
            )));
        }
        return Err(format!("No JSONL file found for session {}", session_id));
    };

    hydrate_subagents_from_file(&state.session_store, session_id, &file_path);

    if let Ok(watcher_guard) = state.conversation_watcher.lock() {
        if let Some(ref watcher) = *watcher_guard {
            if let Some(result) = watcher.parse_session_full(session_id, file_path.clone()) {
                return Ok(SessionMessagesResult::Local(result.all_messages));
            }
        }
    }

    let mut parser = crate::hooks::conversation_parser::ConversationParser::new(file_path);
    parser
        .parse_full()
        .map(SessionMessagesResult::Local)
        .map_err(|e| format!("Failed to parse conversation: {}", e))
}

fn remote_session_chat_history(
    session: &SessionState,
    raw_events: Vec<RawHookEvent>,
) -> Vec<ParsedMessage> {
    let mut messages = Vec::new();

    for event in raw_events {
        let raw = event.raw;
        let timestamp =
            chrono::DateTime::<chrono::Utc>::from_timestamp_millis(event.timestamp_ms as i64)
                .map(|date| date.to_rfc3339());

        match event.event_name.as_str() {
            "UserPromptSubmit" => {
                if let Some(text) = first_nonempty_string(&raw, &["prompt", "user_prompt"]) {
                    messages.push(parsed_text_message(
                        format!("remote-user-{}", event.seq),
                        ChatRole::User,
                        timestamp,
                        text,
                    ));
                }
            }
            "PreToolUse" => {
                let name = first_nonempty_string(&raw, &["tool", "tool_name"])
                    .unwrap_or("Tool")
                    .to_string();
                let id = first_nonempty_string(&raw, &["tool_use_id", "toolUseId"])
                    .map(ToString::to_string)
                    .unwrap_or_else(|| format!("remote-tool-{}", event.seq));
                messages.push(ParsedMessage {
                    id: format!("remote-tool-use-{}", event.seq),
                    role: ChatRole::Assistant,
                    timestamp,
                    blocks: vec![MessageBlock::ToolUse {
                        id,
                        name,
                        input: remote_tool_input_map(raw.get("tool_input")),
                    }],
                });
            }
            "PostToolUse" | "PostToolUseFailure" | "PermissionDenied" => {
                let id = first_nonempty_string(&raw, &["tool_use_id", "toolUseId"])
                    .map(ToString::to_string)
                    .unwrap_or_else(|| format!("remote-tool-{}", event.seq));
                let content = first_nonempty_string(
                    &raw,
                    &[
                        "tool_response",
                        "toolResponse",
                        "result",
                        "output",
                        "message",
                        "tool_error",
                    ],
                )
                .map(ToString::to_string);
                messages.push(ParsedMessage {
                    id: format!("remote-tool-result-{}", event.seq),
                    role: ChatRole::User,
                    timestamp,
                    blocks: vec![MessageBlock::ToolResult {
                        tool_use_id: id,
                        content,
                        is_error: event.event_name != "PostToolUse",
                    }],
                });
            }
            "PermissionRequest" => {
                let name = first_nonempty_string(&raw, &["tool", "tool_name"])
                    .unwrap_or("Tool")
                    .to_string();
                let input = remote_tool_input_map(raw.get("tool_input"));
                messages.push(ParsedMessage {
                    id: format!("remote-perm-{}", event.seq),
                    role: ChatRole::Assistant,
                    timestamp,
                    blocks: vec![MessageBlock::ToolUse {
                        id: format!("remote-perm-{}", event.seq),
                        name,
                        input,
                    }],
                });
            }
            "Notification" => {
                if let Some(text) = first_nonempty_string(&raw, &["message"]) {
                    messages.push(parsed_text_message(
                        format!("remote-notification-{}", event.seq),
                        ChatRole::Assistant,
                        timestamp,
                        text,
                    ));
                }
            }
            "Stop" | "StopFailure" => {
                if let Some(text) = first_nonempty_string(&raw, &["summary", "message", "error"]) {
                    messages.push(parsed_text_message(
                        format!("remote-stop-{}", event.seq),
                        ChatRole::Assistant,
                        timestamp,
                        text,
                    ));
                }
            }
            "BeforeAgent" => {
                if let Some(text) = first_nonempty_string(&raw, &["prompt", "message"]) {
                    messages.push(parsed_text_message(
                        format!("remote-user-{}", event.seq),
                        ChatRole::User,
                        timestamp,
                        text,
                    ));
                }
            }
            "AfterAgent" => {
                if let Some(text) = first_nonempty_string(
                    &raw,
                    &[
                        "prompt_response",
                        "summary",
                        "last_assistant_message",
                        "message",
                    ],
                ) {
                    messages.push(parsed_text_message(
                        format!("remote-assistant-{}", event.seq),
                        ChatRole::Assistant,
                        timestamp,
                        text,
                    ));
                }
            }
            _ => {}
        }
    }

    let has_user = messages
        .iter()
        .any(|message| matches!(message.role, ChatRole::User));
    let has_assistant = messages
        .iter()
        .any(|message| matches!(message.role, ChatRole::Assistant));

    if !has_user {
        if let Some(text) = session
            .last_user_message
            .as_deref()
            .filter(|text| !text.trim().is_empty())
        {
            messages.push(parsed_text_message(
                format!("remote-user-{}", session.id),
                ChatRole::User,
                None,
                text,
            ));
        }
    }
    if !has_assistant {
        if let Some(text) = session
            .last_response
            .as_deref()
            .or(session.description.as_deref())
            .filter(|text| !text.trim().is_empty())
        {
            messages.push(parsed_text_message(
                format!("remote-assistant-{}", session.id),
                ChatRole::Assistant,
                None,
                text,
            ));
        }
    }

    messages
}

fn parsed_text_message(
    id: String,
    role: ChatRole,
    timestamp: Option<String>,
    text: &str,
) -> ParsedMessage {
    ParsedMessage {
        id,
        role,
        timestamp,
        blocks: vec![MessageBlock::Text {
            text: text.to_string(),
        }],
    }
}

fn first_nonempty_string<'a>(raw: &'a serde_json::Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| raw.get(*key).and_then(|value| value.as_str()))
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn remote_tool_input_map(value: Option<&serde_json::Value>) -> HashMap<String, String> {
    let mut input = HashMap::new();
    if let Some(serde_json::Value::Object(map)) = value {
        for (key, value) in map {
            let text = value
                .as_str()
                .map(ToString::to_string)
                .unwrap_or_else(|| value.to_string());
            input.insert(key.clone(), text);
        }
    }
    input
}

fn hydrate_subagents_for_session(store: &SessionStore, session: &SessionState) {
    if session
        .subagents
        .iter()
        .any(|subagent| subagent.agent_transcript_path.is_some())
    {
        return;
    }
    if let Some(path) = discover_transcript_for_session(session) {
        hydrate_subagents_from_file(store, &session.id, &path);
    }
}

fn discover_transcript_for_session(session: &SessionState) -> Option<PathBuf> {
    let mut projects_dirs = all_projects_dirs();
    if let Some(root) = session
        .engine_config_root
        .as_ref()
        .filter(|root| !root.is_empty())
    {
        let custom_projects = crate::agents::claude_code::expand_tilde(root).join("projects");
        if custom_projects.is_dir() && !projects_dirs.iter().any(|d| d == &custom_projects) {
            projects_dirs.push(custom_projects);
        }
    }

    if session.agent_type == "codex" {
        discover_codex_session_file(&session.id)
            .or_else(|| discover_session_file_in_dirs(&session.id, &session.cwd, &projects_dirs))
    } else {
        discover_session_file_in_dirs(&session.id, &session.cwd, &projects_dirs)
    }
}

fn hydrate_subagents_from_file(store: &SessionStore, session_id: &str, file_path: &Path) {
    let recovered = extract_subagents_from_transcript(file_path);
    if recovered.is_empty() {
        return;
    }

    store.update_session(session_id, |session| {
        for subagent in recovered {
            merge_subagent(session, subagent);
        }
        session.subagents.sort_by(|a, b| {
            a.started_at
                .cmp(&b.started_at)
                .then_with(|| a.agent_id.cmp(&b.agent_id))
        });
    });
}

fn merge_subagent(session: &mut SessionState, recovered: TranscriptSubagentInfo) {
    let launch_tool_use_id = recovered.launch_tool_use_id.clone();
    let incoming = SubagentInfo {
        agent_id: recovered.agent_id,
        name: recovered.name,
        agent_type: recovered.agent_type,
        description: recovered.description,
        transcript_path: recovered.transcript_path,
        agent_transcript_path: recovered.agent_transcript_path,
        last_assistant_message: recovered.last_assistant_message,
        started_at: recovered.started_at,
        completed_at: recovered.completed_at,
        status: recovered.status,
        tools: recovered.tools,
    };

    if let Some(existing) = session.subagents.iter_mut().find(|item| {
        item.agent_id == incoming.agent_id
            || launch_tool_use_id
                .as_deref()
                .is_some_and(|tool_use_id| item.agent_id == tool_use_id)
    }) {
        *existing = incoming;
    } else {
        session.subagents.push(incoming);
    }
}

#[tauri::command]
pub async fn get_subagent_chat_history(
    state: State<'_, AppState>,
    session_id: String,
    transcript_path: String,
) -> Result<Vec<ParsedMessage>, String> {
    let session = state
        .session_store
        .get_session(&session_id)
        .ok_or_else(|| format!("Session not found: {}", session_id))?;

    parse_subagent_chat_history_for_session(&session, &transcript_path)
}

fn parse_subagent_chat_history_for_session(
    session: &SessionState,
    transcript_path: &str,
) -> Result<Vec<ParsedMessage>, String> {
    let (transcript_path, requested_agent_id) = split_subagent_history_request(transcript_path);
    let requested_path = crate::agents::claude_code::expand_tilde(transcript_path);
    let requested_path = requested_path
        .canonicalize()
        .map_err(|e| format!("Subagent transcript not found: {}", e))?;

    let allowed = session.subagents.iter().any(|subagent| {
        subagent
            .agent_transcript_path
            .as_ref()
            .or(subagent.transcript_path.as_ref())
            .map(|path| crate::agents::claude_code::expand_tilde(path))
            .and_then(|path| path.canonicalize().ok())
            .map(|path| path == requested_path)
            .unwrap_or(false)
    });

    if !allowed {
        return Err("Subagent transcript is not registered on this session".to_string());
    }

    if let Some(subagent) = session.subagents.iter().find(|subagent| {
        requested_agent_id
            .as_deref()
            .map(|agent_id| subagent.agent_id == agent_id)
            .unwrap_or(true)
            && subagent.agent_transcript_path.is_none()
            && subagent
                .transcript_path
                .as_ref()
                .map(|path| crate::agents::claude_code::expand_tilde(path))
                .and_then(|path| path.canonicalize().ok())
                .map(|path| path == requested_path)
                .unwrap_or(false)
    }) {
        return Ok(synthetic_subagent_chat_history(subagent));
    }

    if requested_agent_id.is_some() {
        return Err("Subagent transcript is not registered on this session".to_string());
    }

    let mut parser = crate::hooks::conversation_parser::ConversationParser::new(requested_path);
    parser
        .parse_full()
        .map_err(|e| format!("Failed to parse subagent conversation: {}", e))
}

fn split_subagent_history_request(transcript_path: &str) -> (&str, Option<String>) {
    if let Some((path, agent_id)) = transcript_path.split_once("#agentbro-subagent=") {
        (path, Some(agent_id.to_string()))
    } else {
        (transcript_path, None)
    }
}

fn synthetic_subagent_chat_history(subagent: &SubagentInfo) -> Vec<ParsedMessage> {
    let mut messages = Vec::new();
    if !subagent.description.trim().is_empty() {
        messages.push(ParsedMessage {
            id: format!("{}-prompt", subagent.agent_id),
            role: ChatRole::User,
            timestamp: timestamp_to_rfc3339(subagent.started_at),
            blocks: vec![MessageBlock::Text {
                text: subagent.description.clone(),
            }],
        });
    }
    if let Some(text) = subagent
        .last_assistant_message
        .as_ref()
        .map(|text| text.trim())
        .filter(|text| !text.is_empty())
    {
        messages.push(ParsedMessage {
            id: format!("{}-response", subagent.agent_id),
            role: ChatRole::Assistant,
            timestamp: subagent.completed_at.and_then(timestamp_to_rfc3339),
            blocks: vec![MessageBlock::Text {
                text: text.to_string(),
            }],
        });
    }
    messages
}

fn timestamp_to_rfc3339(timestamp: i64) -> Option<String> {
    chrono::DateTime::<chrono::Utc>::from_timestamp(timestamp, 0).map(|dt| dt.to_rfc3339())
}

// ── Diagnostics Commands ────────────────────────────────────────

/// Redact user home directory paths across macOS, Linux, and Windows.
fn redact_paths(text: &str) -> String {
    if let Some(home) = dirs::home_dir() {
        let full = home.to_string_lossy().to_string();
        let redacted = "<HOME>";
        let mut result = text.replace(&full, redacted);
        #[cfg(target_os = "windows")]
        {
            result = result.replace(&full.replace('\\', "/"), redacted);
        }
        if let Some(user_name) = home.file_name().and_then(|value| value.to_str()) {
            result = result
                .replace(&format!("/Users/{user_name}"), redacted)
                .replace(&format!("C:\\Users\\{user_name}"), redacted)
                .replace(&format!("C:/Users/{user_name}"), redacted);
        }
        return result;
    }
    text.to_string()
}

fn redact_remote_urls(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = match (rest.find("http://"), rest.find("https://")) {
        (Some(http), Some(https)) => Some(http.min(https)),
        (Some(http), None) => Some(http),
        (None, Some(https)) => Some(https),
        (None, None) => None,
    } {
        output.push_str(&rest[..start]);
        let url_rest = &rest[start..];
        let end = url_rest
            .char_indices()
            .find_map(|(idx, ch)| {
                if ch.is_whitespace() || matches!(ch, '"' | '\'' | ')' | ']' | '}' | '<' | '`') {
                    Some(idx)
                } else {
                    None
                }
            })
            .unwrap_or(url_rest.len());
        let url = &url_rest[..end];
        if url.starts_with("http://localhost")
            || url.starts_with("http://127.")
            || url.starts_with("http://[::1]")
        {
            output.push_str(url);
        } else {
            output.push_str("[REDACTED_URL]");
        }
        rest = &url_rest[end..];
    }
    output.push_str(rest);
    output
}

fn redact_sensitive_hook_config(text: &str) -> String {
    let text = redact_remote_urls(&redact_paths(text));
    // The privacy notice promises env var *values* are never included. A
    // line-by-line keyword blocklist can't guarantee that (a custom secret in
    // an env var with an innocuous name would slip through), so when the file
    // parses as JSON we structurally strip every value under an `env` object,
    // keeping the key names for diagnostic value.
    let text = match serde_json::from_str::<serde_json::Value>(&text) {
        Ok(mut value) => {
            redact_env_values(&mut value);
            serde_json::to_string_pretty(&value).unwrap_or(text)
        }
        Err(_) => text,
    };
    text.lines()
        .map(|line| {
            let lower = line.to_ascii_lowercase();
            let sensitive = [
                "api_key",
                "apikey",
                "authorization",
                "bearer ",
                "password",
                "secret",
                "token",
                "webhook",
            ]
            .iter()
            .any(|needle| lower.contains(needle));
            if sensitive {
                let indent = line
                    .chars()
                    .take_while(|ch| ch.is_whitespace())
                    .collect::<String>();
                format!("{indent}[REDACTED sensitive hook config line]")
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Recursively replace every string value inside any `env` object with
/// `[REDACTED]`, leaving the variable names intact. Numeric/bool env values are
/// also redacted since the notice promises no env *values* are included.
fn redact_env_values(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(map) => {
            for (key, child) in map.iter_mut() {
                if key.eq_ignore_ascii_case("env") {
                    if let serde_json::Value::Object(env_map) = child {
                        for env_val in env_map.values_mut() {
                            if !env_val.is_null() {
                                *env_val = serde_json::Value::String("[REDACTED]".to_string());
                            }
                        }
                        continue;
                    }
                }
                redact_env_values(child);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items.iter_mut() {
                redact_env_values(item);
            }
        }
        _ => {}
    }
}

/// Generate or retrieve an anonymous install ID stored in the config directory.
fn get_or_create_install_id() -> String {
    let base = dirs::config_dir().unwrap_or_else(std::env::temp_dir);
    let id_path = base.join("vibeboard").join("install_id");
    if !id_path.exists() {
        for legacy_path in [
            base.join("agent-island").join("install_id"),
            base.join("agentbro").join("install_id"),
        ] {
            let _ = crate::data_dir::migrate_file(&legacy_path, &id_path);
            if id_path.exists() {
                break;
            }
        }
    }
    if let Ok(id) = std::fs::read_to_string(&id_path) {
        let trimmed = id.trim().to_string();
        if !trimmed.is_empty() {
            return trimmed;
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    let _ = std::fs::create_dir_all(id_path.parent().unwrap());
    let _ = std::fs::write(&id_path, &id);
    id
}

/// Build sanitized config JSON — redacts secrets, SSH targets, webhook URLs.
fn sanitized_config_json(config: &AppConfig) -> serde_json::Value {
    let mut val = serde_json::to_value(config).unwrap_or_default();

    // Redact webhook configs
    if let Some(webhooks) = val.get_mut("webhookConfigs").and_then(|v| v.as_array_mut()) {
        for wh in webhooks.iter_mut() {
            if let Some(url) = wh.get_mut("url") {
                *url = serde_json::Value::String("[REDACTED]".to_string());
            }
            if let Some(secret) = wh.get_mut("secret") {
                if !secret.is_null() {
                    *secret = serde_json::Value::String("[REDACTED]".to_string());
                }
            }
        }
    }

    // Redact buddy device shared secret
    if let Some(secret) = val.pointer_mut("/buddyDevice/sharedSecret") {
        if secret.is_string() && !secret.as_str().unwrap_or("").is_empty() {
            *secret = serde_json::Value::String("[REDACTED]".to_string());
        }
    }

    // Redact custom hooks install paths
    if let Some(installs) = val
        .get_mut("customHookInstalls")
        .and_then(|v| v.as_array_mut())
    {
        for inst in installs.iter_mut() {
            if let Some(dir) = inst.get_mut("installDirectory") {
                let s = dir.as_str().unwrap_or("");
                *dir = serde_json::Value::String(redact_paths(s));
            }
        }
    }

    // Redact engine instance config roots
    if let Some(instances) = val
        .get_mut("engineInstances")
        .and_then(|v| v.as_array_mut())
    {
        for inst in instances.iter_mut() {
            if let Some(root) = inst.get_mut("configRoot") {
                let s = root.as_str().unwrap_or("");
                *root = serde_json::Value::String(redact_paths(s));
            }
        }
    }

    // Redact custom sounds data URLs (may contain embedded file paths)
    if let Some(sounds) = val.get_mut("customSounds").and_then(|v| v.as_array_mut()) {
        for sound in sounds.iter_mut() {
            if let Some(data_url) = sound.get_mut("dataUrl") {
                if data_url.is_string() {
                    *data_url = serde_json::Value::String("[REDACTED]".to_string());
                }
            }
            if let Some(path) = sound.get_mut("path") {
                let s = path.as_str().unwrap_or("");
                *path = serde_json::Value::String(redact_paths(s));
            }
        }
    }

    if let Some(value) = val.get_mut("excludedHookCwdSubstrings") {
        let s = value.as_str().unwrap_or("");
        *value = serde_json::Value::String(redact_paths(s));
    }
    if let Some(rules) = val
        .get_mut("sessionSilenceRules")
        .and_then(|v| v.as_array_mut())
    {
        for rule in rules.iter_mut() {
            let kind = rule
                .get("kind")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if let Some(pattern) = rule.get_mut("pattern") {
                let s = pattern.as_str().unwrap_or("");
                *pattern = serde_json::Value::String(if kind == "cwd" {
                    redact_paths(s)
                } else {
                    "[REDACTED]".to_string()
                });
            }
        }
    }

    val
}

/// Collect hook config file contents from all adapters, with path redaction.
fn collect_hooks_sections(adapters: &[Arc<dyn AgentAdapter>]) -> Vec<String> {
    let mut sections = Vec::new();
    for adapter in adapters {
        let paths = adapter.hook_config_paths();
        if paths.is_empty() {
            continue;
        }
        let mut block = format!(
            "### {}\n\n> ID: `{}`\n\n",
            adapter.display_name(),
            adapter.name()
        );
        for path in &paths {
            let display_path = redact_paths(&path.to_string_lossy());
            if path.is_dir() {
                for name in ["plugin.yaml", "__init__.py", "settings.json", "hooks.json"] {
                    let candidate = path.join(name);
                    if candidate.exists() {
                        let cp = redact_paths(&candidate.to_string_lossy());
                        match std::fs::read_to_string(&candidate) {
                            Ok(content) => {
                                block.push_str(&format!(
                                    "**{}**\n```json\n{}\n```\n\n",
                                    cp,
                                    redact_sensitive_hook_config(&content)
                                ));
                            }
                            Err(e) => {
                                block.push_str(&format!("**{}** — _read error: {}_\n\n", cp, e));
                            }
                        }
                    }
                }
            } else if path.exists() {
                match std::fs::read_to_string(path) {
                    Ok(content) => {
                        block.push_str(&format!(
                            "**{}**\n```json\n{}\n```\n\n",
                            display_path,
                            redact_sensitive_hook_config(&content)
                        ));
                    }
                    Err(e) => {
                        block.push_str(&format!("**{}** — _read error: {}_\n\n", display_path, e));
                    }
                }
            } else {
                block.push_str(&format!("**{}** — _not found_\n\n", display_path));
            }
        }
        sections.push(block);
    }
    sections
}

/// Read recent log files from tauri-plugin-log's log directory.
fn collect_log_files() -> Vec<(String, Vec<u8>)> {
    let base = dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join("vibeboard");
    let log_dir = [base.join("logs")]
        .into_iter()
        .chain(["agent-island", "agentbro"].map(|dir| {
            base.parent()
                .unwrap_or_else(|| Path::new("/tmp"))
                .join(dir)
                .join("logs")
        }))
        .find(|dir| dir.is_dir())
        .unwrap_or_else(|| base.join("logs"));
    let mut files = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&log_dir) {
        let mut entries: Vec<_> = entries.filter_map(|e| e.ok()).collect();
        entries.sort_by_key(|e| e.metadata().ok().and_then(|m| m.modified().ok()));
        for entry in entries.into_iter().rev().take(3) {
            let path = entry.path();
            if path.is_file() {
                let name = path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();
                match std::fs::read(&path) {
                    Ok(data) => {
                        let redacted = redact_paths(&String::from_utf8_lossy(&data));
                        files.push((format!("logs/{}", name), redacted.into_bytes()));
                    }
                    Err(_) => continue,
                }
            }
        }
    }
    files
}

fn bridge_invocations_path() -> PathBuf {
    let new_path = crate::data_dir::vibeboard_home()
        .join("hooks")
        .join("invocations.jsonl");
    if new_path.exists() {
        return new_path;
    }
    // Fall back to legacy paths for reading
    for legacy_root in crate::data_dir::legacy_homes() {
        for old_path in [
            legacy_root.join("hooks").join("invocations.jsonl"),
            legacy_root.join("hook-invocations.jsonl"),
        ] {
            if old_path.exists() {
                return old_path;
            }
        }
    }
    new_path
}

fn recent_bridge_invocations(limit: usize) -> Vec<String> {
    let path = bridge_invocations_path();
    let Ok(content) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut lines = content
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    if lines.len() > limit {
        lines.drain(0..lines.len() - limit);
    }
    lines
}

/// Collect crash reports matching Vibe Board or legacy AgentBro from the system DiagnosticReports dir.
fn collect_crash_reports() -> Vec<(String, Vec<u8>)> {
    let crash_dir = PathBuf::from("/Library/Logs/DiagnosticReports");
    let user_crash_dir = dirs::home_dir()
        .map(|h| h.join("Library/Logs/DiagnosticReports"))
        .unwrap_or_else(|| PathBuf::from("/tmp/none"));
    let mut files = Vec::new();
    for dir in &[crash_dir, user_crash_dir] {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.filter_map(|e| e.ok()) {
                let path = entry.path();
                let name = path.file_name().unwrap_or_default().to_string_lossy();
                if name.contains("Vibe Board")
                    || name.contains("AgentBro")
                    || name.contains("agentbro")
                {
                    if let Ok(data) = std::fs::read(&path) {
                        let redacted = redact_paths(&String::from_utf8_lossy(&data));
                        files.push((format!("crashes/{}", name), redacted.into_bytes()));
                    }
                }
            }
        }
    }
    files
}

#[tauri::command]
pub async fn export_diagnostics(
    state: State<'_, AppState>,
    target_path: String,
) -> Result<(), String> {
    let config = state.config_store.get();
    let sessions = state.session_store.get_all_sessions();
    let diagnostic_events = state.diagnostic_buffer.all();
    let raw_event_summaries = state.hook_server.recent_raw_event_summaries(500);
    let bridge_invocations = recent_bridge_invocations(500);
    let install_id = get_or_create_install_id();
    let now = chrono::Local::now();
    let timestamp = now.format("%Y-%m-%d %H:%M:%S %Z").to_string();

    // ── Build Markdown report ──
    let mut md = String::new();

    // Header
    md.push_str("# Vibe Board Diagnostic Report\n\n");
    md.push_str("| Field | Value |\n|---|---|\n");
    md.push_str(&format!("| Generated | {} |\n", timestamp));
    md.push_str(&format!("| Version | {} |\n", env!("CARGO_PKG_VERSION")));
    md.push_str(&format!("| Install ID | {} |\n", install_id));
    md.push_str(&format!(
        "| Platform | {} / {} |\n",
        std::env::consts::OS,
        std::env::consts::ARCH
    ));
    md.push_str("\n---\n\n");

    // Privacy notice
    md.push_str("> **Privacy:** Home paths are masked as `<HOME>`. Webhook URLs, secrets, SSH targets, and credentials are replaced with `[REDACTED]`. Session content and environment variable values are never included.\n\n---\n\n");

    // Adapter status table
    md.push_str("## Supported Agents\n\n");
    md.push_str("| Agent | ID | Status | Hooks |\n|---|---|---|---|\n");
    for adapter in state.adapters.iter() {
        let status_str = match adapter.status() {
            crate::agents::AdapterStatus::Active => "✅ Active",
            crate::agents::AdapterStatus::Installed => "📦 Installed",
            crate::agents::AdapterStatus::Available => "⚡ Available",
            crate::agents::AdapterStatus::Unavailable => "— Unavailable",
        };
        let hooks_str = if adapter.hooks_installed() {
            "✓"
        } else {
            "—"
        };
        md.push_str(&format!(
            "| {} | `{}` | {} | {} |\n",
            adapter.display_name(),
            adapter.name(),
            status_str,
            hooks_str
        ));
    }
    md.push('\n');

    // CLI tool versions
    md.push_str("## CLI Tools\n\n");
    md.push_str("| Tool | Version |\n|---|---|\n");
    for tool in &["claude", "cursor", "codex", "aider", "gemini"] {
        let version = std::process::Command::new(tool)
            .arg("--version")
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_else(|| "—".to_string());
        md.push_str(&format!("| `{}` | {} |\n", tool, version));
    }
    md.push_str("\n---\n\n");

    // Sessions overview
    md.push_str("## Sessions\n\n");
    md.push_str(&format!("**Total:** {}\n\n", sessions.len()));
    let mut by_agent: BTreeMap<String, usize> = BTreeMap::new();
    let mut by_phase: BTreeMap<String, usize> = BTreeMap::new();
    for s in &sessions {
        *by_agent.entry(s.agent_type.clone()).or_insert(0) += 1;
        *by_phase.entry(format!("{:?}", s.phase)).or_insert(0) += 1;
    }
    if !by_agent.is_empty() {
        md.push_str("| Agent | Count |\n|---|---|\n");
        for (agent, count) in &by_agent {
            md.push_str(&format!("| {} | {} |\n", agent, count));
        }
        md.push('\n');
    }
    if !by_phase.is_empty() {
        md.push_str("| Phase | Count |\n|---|---|\n");
        for (phase, count) in &by_phase {
            md.push_str(&format!("| {} | {} |\n", phase, count));
        }
        md.push('\n');
    }
    md.push_str("---\n\n");

    // Hook configurations
    md.push_str("## Hook Configurations\n\n");
    let hooks_sections = collect_hooks_sections(&state.adapters);
    if hooks_sections.is_empty() {
        md.push_str("_No hook configurations found._\n\n");
    } else {
        for section in &hooks_sections {
            md.push_str(section);
        }
    }
    md.push_str("---\n\n");

    // Raw hook event summaries
    md.push_str("## Recent Hook Events\n\n");
    if raw_event_summaries.is_empty() {
        md.push_str("_No raw hook events recorded._\n\n");
    } else {
        md.push_str(
            "| Seq | Agent | Event | Session | CWD | Payload keys |\n|---|---|---|---|---|---|\n",
        );
        for event in &raw_event_summaries {
            let cwd = event
                .cwd
                .as_deref()
                .map(redact_paths)
                .unwrap_or_else(|| "—".to_string());
            md.push_str(&format!(
                "| {} | {} | {} | `{}` | {} | {} |\n",
                event.seq,
                event.agent.as_deref().unwrap_or("—"),
                event.event_name,
                event.session_id,
                cwd,
                event.payload_keys.join(", ")
            ));
        }
        md.push('\n');
    }
    md.push_str("---\n\n");

    // Bridge invocation summaries
    md.push_str("## Recent Bridge Invocations\n\n");
    if bridge_invocations.is_empty() {
        md.push_str("_No bridge invocations recorded._\n\n");
    } else {
        md.push_str("```jsonl\n");
        for line in &bridge_invocations {
            md.push_str(&redact_paths(line));
            md.push('\n');
        }
        md.push_str("```\n\n");
    }
    md.push_str("---\n\n");

    // Diagnostic events
    md.push_str("## Recent Events\n\n");
    if diagnostic_events.is_empty() {
        md.push_str("_No diagnostic events recorded._\n\n");
    } else {
        md.push_str("```json\n");
        let events_json = serde_json::to_string_pretty(&diagnostic_events)
            .unwrap_or_else(|e| format!("{{\"error\": \"{}\"}}", e));
        md.push_str(&redact_paths(&events_json));
        md.push_str("\n```\n\n");
    }
    md.push_str("---\n\n");

    // Archive contents
    md.push_str("## Archive Contents\n\n");
    md.push_str("| File | Description |\n|---|---|\n");
    md.push_str("| `Diagnostic-Report.md` | This report |\n");
    md.push_str("| `config.json` | Sanitized app configuration (JSON) |\n");
    md.push_str(
        "| `recent-hook-events.json` | Recent hook event summaries without raw payload content |\n",
    );
    md.push_str(
        "| `bridge-invocations.jsonl` | Recent hook bridge invocations without prompt or payload content |\n",
    );
    md.push_str("| `logs/` | Recent application logs |\n");
    md.push_str("| `crashes/` | System crash reports (if any) |\n");

    // ── Sanitized config as standalone JSON ──
    let config_json = serde_json::to_string_pretty(&sanitized_config_json(&config))
        .unwrap_or_else(|e| format!("{{\"error\": \"{}\"}}", e));

    // ── Build the zip ──
    let file = std::fs::File::create(&target_path)
        .map_err(|e| format!("Failed to create zip file: {}", e))?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    let write_text = |zip: &mut zip::ZipWriter<std::fs::File>,
                      name: &str,
                      content: &str|
     -> Result<(), String> {
        zip.start_file(name, options).map_err(|e| e.to_string())?;
        zip.write_all(content.as_bytes()).map_err(|e| e.to_string())
    };

    write_text(&mut zip, "Diagnostic-Report.md", &md)?;
    write_text(&mut zip, "config.json", &redact_paths(&config_json))?;
    let hook_events_json = serde_json::to_string_pretty(&raw_event_summaries)
        .unwrap_or_else(|e| format!("{{\"error\": \"{}\"}}", e));
    write_text(
        &mut zip,
        "recent-hook-events.json",
        &redact_paths(&hook_events_json),
    )?;
    write_text(
        &mut zip,
        "bridge-invocations.jsonl",
        &redact_paths(&bridge_invocations.join("\n")),
    )?;

    // Logs
    for (name, data) in collect_log_files() {
        zip.start_file(&name, options).map_err(|e| e.to_string())?;
        zip.write_all(&data).map_err(|e| e.to_string())?;
    }

    // Crash reports
    for (name, data) in collect_crash_reports() {
        zip.start_file(&name, options).map_err(|e| e.to_string())?;
        zip.write_all(&data).map_err(|e| e.to_string())?;
    }

    zip.finish()
        .map_err(|e| format!("Failed to finalize zip: {}", e))?;

    log::info!("Diagnostics exported to {}", redact_paths(&target_path));
    Ok(())
}

// ── Engine Instance Commands ────────────────────────────────────

#[tauri::command]
pub async fn add_engine_instance(
    state: State<'_, AppState>,
    label: String,
    config_root: String,
) -> Result<crate::config::EngineInstance, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let instance = crate::config::EngineInstance {
        id: id.clone(),
        label: label.clone(),
        config_root: config_root.clone(),
        enabled: true,
    };

    let mut config = state.config_store.get();
    config.engine_instances.push(instance.clone());
    state.config_store.update(config)?;

    // Install hooks for the new instance
    let root = crate::agents::claude_code::expand_tilde(&config_root);
    let adapter = crate::agents::claude_code::ClaudeCodeAdapter::with_config_root(root, label);
    if let Err(e) = adapter.install_hooks() {
        log::warn!("Failed to install hooks for new engine instance: {}", e);
    }

    Ok(instance)
}

#[tauri::command]
pub async fn remove_engine_instance(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let config = state.config_store.get();

    // Find the instance to remove hooks before deleting
    if let Some(inst) = config.engine_instances.iter().find(|i| i.id == id) {
        let root = crate::agents::claude_code::expand_tilde(&inst.config_root);
        let adapter = crate::agents::claude_code::ClaudeCodeAdapter::with_config_root(
            root,
            inst.label.clone(),
        );
        if let Err(e) = adapter.remove_hooks() {
            log::warn!("Failed to remove hooks for engine instance {}: {}", id, e);
        }
    }

    let mut config = config;
    config.engine_instances.retain(|i| i.id != id);
    state.config_store.update(config)
}

#[tauri::command]
pub async fn set_engine_instance_enabled(
    state: State<'_, AppState>,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    let mut config = state.config_store.get();
    let Some(instance) = config.engine_instances.iter_mut().find(|i| i.id == id) else {
        return Err(format!("Engine instance {} not found", id));
    };
    let instance_snapshot = instance.clone();
    instance.enabled = enabled;
    state.config_store.update(config)?;

    let root = crate::agents::claude_code::expand_tilde(&instance_snapshot.config_root);
    let adapter = crate::agents::claude_code::ClaudeCodeAdapter::with_config_root(
        root,
        instance_snapshot.label,
    );
    let result = if enabled {
        adapter.install_hooks()
    } else {
        adapter.remove_hooks()
    };
    result.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn verify_engine_path(path: String) -> Result<bool, String> {
    let expanded = crate::agents::claude_code::expand_tilde(&path);
    Ok(expanded.is_dir())
}

#[cfg(target_os = "windows")]
fn activate_codex_desktop_windows() -> Result<(), String> {
    let mut errors = Vec::new();
    for app_id in crate::agents::executable::codex_desktop_app_user_model_ids() {
        match open_windows_app_user_model_id(&app_id) {
            Ok(()) => return Ok(()),
            Err(err) => errors.push(format!("{app_id}: {err}")),
        }
    }
    for path in crate::agents::executable::codex_desktop_app_candidates()
        .into_iter()
        .filter(|path| path.exists())
    {
        let target = path.to_string_lossy().to_string();
        match open_windows_shell_target(&target) {
            Ok(()) => return Ok(()),
            Err(err) => errors.push(format!("{target}: {err}")),
        }
    }
    Err(if errors.is_empty() {
        "Codex Desktop was not found. Install or launch Codex Desktop, then try again.".to_string()
    } else {
        format!("Failed to activate Codex Desktop: {}", errors.join("; "))
    })
}

fn session_has_desktop_host(session: &SessionState) -> bool {
    is_codex_desktop_session(session) || app_host_bundle_id(session).is_some()
}

#[cfg(target_os = "windows")]
fn activate_session_process_window(process_id: u32) -> bool {
    let tree = crate::terminal::process_tree::build_tree();
    let mut current = process_id;
    while current != 0 {
        if crate::platform::host_visibility::activate_process_window(current) {
            return true;
        }
        let Some(parent) = tree.get(&current).map(|process| process.ppid) else {
            break;
        };
        if parent == current {
            break;
        }
        current = parent;
    }
    false
}

/// Bring the desktop app window that hosts this session to the front (for example
/// Codex Desktop). "Host" here means the app window running the session; it is
/// unrelated to the retired "host agent" concept removed in M4. Returns `false`
/// for CLI-only sessions so the task board can tell the user to open the CLI.
#[tauri::command]
pub async fn activate_session_host(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<bool, String> {
    release_notch_keyboard_focus(&app);
    let session = state
        .session_store
        .get_session(&session_id)
        .ok_or_else(|| format!("Session {} not found", session_id))?;

    if !session_has_desktop_host(&session) {
        return Ok(false);
    }

    #[cfg(target_os = "windows")]
    {
        if is_codex_desktop_session(&session) {
            activate_codex_desktop_windows()?;
            return Ok(true);
        }
        if session.pid.is_some_and(activate_session_process_window) {
            return Ok(true);
        }
        return Err(format!(
            "Failed to activate the desktop window for {}",
            session.agent_type
        ));
    }

    #[cfg(target_os = "macos")]
    {
        if is_codex_desktop_session(&session) {
            return if activate_codex_desktop_app(session.pid) {
                Ok(true)
            } else {
                Err("Failed to activate Codex Desktop".to_string())
            };
        }
        let bundle_id = app_host_bundle_id(&session)
            .ok_or_else(|| "Session has no desktop app metadata".to_string())?;
        open_bundle_id(bundle_id)?;
        return Ok(true);
    }

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        let _ = session;
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        can_fallback_to_terminal_app, codex_app_server_refresh_interval_seconds,
        codex_phase_from_thread, fallback_terminal_app_name, installed_hooks_check,
        is_codex_desktop_session, is_ide_terminal_session, is_uuid_like,
        parse_subagent_chat_history_for_session, read_codex_session_meta_from_path,
        read_local_codex_rollout_state, redact_sensitive_hook_config, remote_session_chat_history,
        resolve_session_tty, session_has_desktop_host, sync_codex_app_server_thread_to_store,
        sync_local_codex_rollouts_from_root, terminal_hint_for_fallback,
    };
    #[cfg(target_os = "windows")]
    use super::{
        clean_windows_app_user_model_id, is_windows_protocol_target, powershell_string_literal,
        windows_terminal_command_args, windows_terminal_launch_order, WindowsTerminalLauncher,
    };
    use crate::energy::EnergyMode;
    use crate::hooks::conversation_parser::{ChatRole, MessageBlock};
    use crate::hooks::server::RawHookEvent;
    use crate::hooks::session_store::{SessionPhase, SessionState, SessionStore, SubagentInfo};
    use std::{fs, path::PathBuf};

    fn session(agent_type: &str, terminal: &str, tty: Option<&str>) -> SessionState {
        let mut session = SessionState::new(
            "s1".to_string(),
            agent_type.to_string(),
            "project".to_string(),
            "/tmp/project".to_string(),
            terminal.to_string(),
        );
        session.tty = tty.map(ToString::to_string);
        session
    }

    #[test]
    fn installed_hooks_check_flags_adapter_entries_that_need_repair() {
        let check = installed_hooks_check(
            &["Claude Code".to_string()],
            &["Claude Code (needs_reinstall)".to_string()],
        );

        assert_eq!(check.id, "installed-hooks");
        assert_eq!(check.status, "warn");
        assert!(
            check.detail.contains("need reinstall"),
            "detail must call out the repair: {}",
            check.detail
        );
        assert!(check.detail.contains("Claude Code (needs_reinstall)"));

        let healthy = installed_hooks_check(&["Claude Code".to_string()], &[]);
        assert_eq!(healthy.status, "ok");

        let none_installed = installed_hooks_check(&[], &[]);
        assert_eq!(none_installed.status, "warn");
        assert!(none_installed.detail.contains("No adapter configs"));
    }

    #[test]
    fn codex_app_server_status_maps_to_processing() {
        let thread = serde_json::json!({
            "status": {
                "type": "active",
                "activeFlags": ["waitingOnUserInput"]
            }
        });

        assert_eq!(codex_phase_from_thread(&thread), SessionPhase::Processing);
    }

    #[test]
    fn local_codex_rollout_state_tracks_latest_task_lifecycle() {
        let path = std::env::temp_dir().join(format!(
            "vibe-board-codex-rollout-{}-{}.jsonl",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        fs::write(
            &path,
            r#"{"type":"session_meta","payload":{"session_id":"desktop-thread","cwd":"C:\\work"}}
{"timestamp":"2026-09-08T00:00:00Z","type":"event_msg","payload":{"type":"task_started","started_at":1788825600}}
{"timestamp":"2026-09-08T00:00:01Z","type":"event_msg","payload":{"type":"task_complete","last_agent_message":"done"}}
{"timestamp":"2026-09-08T00:01:00Z","type":"event_msg","payload":{"type":"task_started","started_at":1788825660}}
"#,
        )
        .expect("write rollout fixture");

        let state = read_local_codex_rollout_state(&path, 0).expect("parse rollout fixture");
        assert_eq!(state.session_id.as_deref(), Some("desktop-thread"));
        assert_eq!(state.cwd.as_deref(), Some("C:\\work"));
        assert!(state.active);
        assert!(state.saw_task_event);
        assert_eq!(state.started_at, Some(1788825660));
        assert_eq!(state.updated_at, Some(1788825660));

        let _ = fs::remove_file(path);
    }

    fn write_active_codex_rollout(root: &std::path::Path, session_id: &str) -> PathBuf {
        let started_at = chrono::Utc::now().timestamp();
        let path = root.join(format!("rollout-{session_id}.jsonl"));
        fs::write(
            &path,
            format!(
                r#"{{"type":"session_meta","payload":{{"session_id":"{session_id}","cwd":"C:\\work"}}}}
{{"timestamp":"{}","type":"event_msg","payload":{{"type":"task_started","started_at":{started_at}}}}}
"#,
                chrono::Utc::now().to_rfc3339(),
            ),
        )
        .expect("write rollout fixture");
        path
    }

    fn temp_codex_rollout_root(tag: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("vibe-board-codex-{tag}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create rollout root");
        root
    }

    #[test]
    fn local_codex_rollout_sync_recovers_app_server_idle_session() {
        let store = SessionStore::new();
        store.get_or_create_session("desktop-thread", "codex", "Codex", "/", "Codex");
        store.update_session("desktop-thread", |session| {
            session.engine_label = Some("Codex App".to_string());
            session.phase = SessionPhase::Idle;
            session.last_main_agent_at = Some(1);
        });

        let root = temp_codex_rollout_root("takeover");
        write_active_codex_rollout(&root, "desktop-thread");
        sync_local_codex_rollouts_from_root(&store, &root);

        let session = store.get_session("desktop-thread").expect("session");
        assert_eq!(session.phase, SessionPhase::Processing);
        assert_eq!(session.engine_label.as_deref(), Some("Codex Desktop"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn local_codex_rollout_sync_discovers_running_task_on_empty_store() {
        let store = SessionStore::new();
        let root = temp_codex_rollout_root("discover");
        write_active_codex_rollout(&root, "desktop-thread");
        sync_local_codex_rollouts_from_root(&store, &root);

        let session = store.get_session("desktop-thread").expect("session");
        assert_eq!(session.phase, SessionPhase::Processing);
        assert_eq!(session.agent_type, "codex");
        assert_eq!(session.engine_label.as_deref(), Some("Codex Desktop"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn local_codex_rollout_sync_restores_ownership_label() {
        let store = SessionStore::new();
        let root = temp_codex_rollout_root("relabel");
        let path = write_active_codex_rollout(&root, "desktop-thread");
        let snapshot = read_local_codex_rollout_state(&path, 0).expect("rollout state");

        store.get_or_create_session("desktop-thread", "codex", "work", "C:\\work", "Codex");
        store.update_session("desktop-thread", |session| {
            session.engine_label = Some("Codex App".to_string());
            session.phase = SessionPhase::Processing;
            session.last_main_agent_at = snapshot.updated_at;
            session.session_title = None;
            session.last_response = None;
        });

        sync_local_codex_rollouts_from_root(&store, &root);

        assert_eq!(
            store
                .get_session("desktop-thread")
                .expect("session")
                .engine_label
                .as_deref(),
            Some("Codex Desktop")
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn local_codex_rollout_sync_ignores_app_server_waiting_flags() {
        let store = SessionStore::new();
        let local_at = chrono::Utc::now().timestamp();
        store.get_or_create_session("desktop-thread", "codex", "work", "C:\\work", "Codex");
        store.update_session("desktop-thread", |session| {
            session.engine_label = Some("Codex Desktop".to_string());
            session.phase = SessionPhase::Processing;
            session.last_main_agent_at = Some(local_at);
        });

        let thread = serde_json::json!({
            "id": "desktop-thread",
            "name": "work",
            "cwd": "C:\\work",
            "updatedAt": local_at,
            "status": { "type": "active", "activeFlags": ["waitingOnApproval"] }
        });
        sync_codex_app_server_thread_to_store(&store, &thread).expect("thread sync");
        assert_eq!(
            store.get_session("desktop-thread").expect("session").phase,
            SessionPhase::Processing
        );

        let root = temp_codex_rollout_root("waiting");
        let path = write_active_codex_rollout(&root, "desktop-thread");
        sync_local_codex_rollouts_from_root(&store, &root);

        let session = store.get_session("desktop-thread").expect("session");
        assert_eq!(session.phase, SessionPhase::Processing);

        // The completed rollout finishes the task as usual.
        let mut content = fs::read_to_string(&path).expect("read rollout");
        content.push_str(&format!(
            "{{\"timestamp\":\"{}\",\"type\":\"event_msg\",\"payload\":{{\"type\":\"task_complete\"}}}}\n",
            chrono::Utc::now().to_rfc3339(),
        ));
        fs::write(&path, content).expect("append task_complete");
        sync_local_codex_rollouts_from_root(&store, &root);

        assert_eq!(
            store.get_session("desktop-thread").expect("session").phase,
            SessionPhase::Idle
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn consecutive_idle_codex_snapshots_keep_local_rollout_ownership() {
        let store = SessionStore::new();
        let local_at = chrono::Utc::now().timestamp();
        let stale_at = local_at - 31 * 60;
        store.get_or_create_session("thread-local", "codex", "Project", "/tmp/project", "Codex");
        store.update_session("thread-local", |session| {
            session.engine_label = Some("Codex Desktop".to_string());
            session.phase = SessionPhase::Processing;
            session.last_main_agent_at = Some(local_at);
        });

        let thread = serde_json::json!({
            "id": "thread-local",
            "name": "Project",
            "cwd": "/tmp/project",
            "updatedAt": stale_at,
            "status": { "type": "idle" }
        });

        assert!(sync_codex_app_server_thread_to_store(&store, &thread).is_some());
        let session = store.get_session("thread-local").expect("session");
        assert_eq!(session.engine_label.as_deref(), Some("Codex Desktop"));
        assert_eq!(session.phase, SessionPhase::Processing);

        assert!(sync_codex_app_server_thread_to_store(&store, &thread).is_some());
        let session = store.get_session("thread-local").expect("session");
        assert_eq!(session.engine_label.as_deref(), Some("Codex Desktop"));
        assert_eq!(session.phase, SessionPhase::Processing);
    }

    #[test]
    fn codex_app_server_idle_snapshot_keeps_local_rollout_task() {
        let store = SessionStore::new();
        let local_at = chrono::Utc::now().timestamp();
        store.get_or_create_session("thread-local", "codex", "Project", "/tmp/project", "Codex");
        store.update_session("thread-local", |session| {
            session.engine_label = Some("Codex Desktop".to_string());
            session.phase = SessionPhase::Processing;
            session.last_main_agent_at = Some(local_at);
        });

        let thread = serde_json::json!({
            "id": "thread-local",
            "name": "Project",
            "cwd": "/tmp/project",
            "updatedAt": local_at - 5,
            "status": { "type": "idle" }
        });
        let summary = sync_codex_app_server_thread_to_store(&store, &thread).expect("thread sync");

        assert_eq!(summary.phase, "Idle");
        assert_eq!(
            store.get_session("thread-local").expect("session").phase,
            SessionPhase::Processing
        );
    }

    #[test]
    fn codex_app_server_live_status_is_processing_without_approval_state() {
        let store = SessionStore::new();
        let local_at = chrono::Utc::now().timestamp();
        store.get_or_create_session("thread-local", "codex", "Project", "/tmp/project", "Codex");
        store.update_session("thread-local", |session| {
            session.engine_label = Some("Codex Desktop".to_string());
            session.phase = SessionPhase::Processing;
            session.last_main_agent_at = Some(local_at);
        });

        let thread = serde_json::json!({
            "id": "thread-local",
            "name": "Project",
            "cwd": "/tmp/project",
            "updatedAt": local_at,
            "status": { "type": "active", "activeFlags": ["waitingOnApproval"] }
        });
        sync_codex_app_server_thread_to_store(&store, &thread).expect("thread sync");

        assert_eq!(
            store.get_session("thread-local").expect("session").phase,
            SessionPhase::Processing
        );
    }

    #[test]
    fn codex_app_server_thread_sync_updates_session_store() {
        let store = SessionStore::new();
        let thread = serde_json::json!({
            "id": "thread-1",
            "name": "Fix flaky tests",
            "preview": "Investigate test timing",
            "cwd": "/tmp/agentbro",
            "createdAt": 1_700_000_000,
            "updatedAt": 1_700_000_120,
            "status": { "type": "active", "activeFlags": [] },
            "turns": [{
                "items": [
                    {
                        "type": "userMessage",
                        "content": [{ "type": "input_text", "text": "Please fix tests" }]
                    },
                    {
                        "type": "agentMessage",
                        "text": "I found the timing issue.",
                        "phase": "final"
                    }
                ]
            }]
        });

        let summary = sync_codex_app_server_thread_to_store(&store, &thread).unwrap();
        let session = store.get_session("thread-1").unwrap();

        assert_eq!(summary.phase, "Processing");
        assert_eq!(session.agent_type, "codex");
        assert_eq!(session.engine_label.as_deref(), Some("Codex App"));
        assert_eq!(session.project, "Fix flaky tests");
        assert_eq!(session.cwd, "/tmp/agentbro");
        assert_eq!(session.phase, SessionPhase::Processing);
        assert_eq!(
            session.last_user_message.as_deref(),
            Some("Please fix tests")
        );
        assert_eq!(
            session.last_response.as_deref(),
            Some("I found the timing issue.")
        );
        assert_eq!(session.term_bundle_id.as_deref(), Some("com.openai.codex"));
    }

    #[test]
    fn codex_app_server_thread_sync_removes_closed_threads() {
        let store = SessionStore::new();
        let active_thread = serde_json::json!({
            "id": "thread-closed",
            "name": "Old work",
            "cwd": "/tmp/agentbro",
            "status": { "type": "active", "activeFlags": [] }
        });
        let archived_thread = serde_json::json!({
            "id": "thread-closed",
            "name": "Old work",
            "cwd": "/tmp/agentbro",
            "archived": true,
            "status": { "type": "active", "activeFlags": [] }
        });
        let closed_status_thread = serde_json::json!({
            "id": "thread-status-closed",
            "name": "Closed work",
            "cwd": "/tmp/agentbro",
            "status": { "type": "closed" }
        });

        sync_codex_app_server_thread_to_store(&store, &active_thread).unwrap();
        assert!(store.get_session("thread-closed").is_some());

        assert!(sync_codex_app_server_thread_to_store(&store, &archived_thread).is_none());
        assert!(store.get_session("thread-closed").is_none());
        assert!(sync_codex_app_server_thread_to_store(&store, &closed_status_thread).is_none());
        assert!(store.get_session("thread-status-closed").is_none());
    }

    #[test]
    fn codex_app_server_thread_sync_drops_stale_idle_threads() {
        let store = SessionStore::new();
        let stale_updated_at = chrono::Utc::now().timestamp() - 31 * 60;
        let active_thread = serde_json::json!({
            "id": "thread-stale-idle",
            "name": "Old idle work",
            "cwd": "/tmp/agentbro",
            "updatedAt": stale_updated_at,
            "status": { "type": "active", "activeFlags": [] }
        });
        let stale_idle_thread = serde_json::json!({
            "id": "thread-stale-idle",
            "name": "Old idle work",
            "cwd": "/tmp/agentbro",
            "updatedAt": stale_updated_at,
            "status": { "type": "idle" }
        });
        let recent_idle_thread = serde_json::json!({
            "id": "thread-recent-idle",
            "name": "Recent idle work",
            "cwd": "/tmp/agentbro",
            "updatedAt": chrono::Utc::now().timestamp() - 60,
            "status": { "type": "idle" }
        });

        sync_codex_app_server_thread_to_store(&store, &active_thread).unwrap();
        assert!(store.get_session("thread-stale-idle").is_some());

        assert!(sync_codex_app_server_thread_to_store(&store, &stale_idle_thread).is_none());
        assert!(store.get_session("thread-stale-idle").is_none());
        assert!(sync_codex_app_server_thread_to_store(&store, &recent_idle_thread).is_some());
        assert!(store.get_session("thread-recent-idle").is_some());
    }

    #[test]
    fn codex_app_server_energy_policy_slows_down_when_quiet() {
        let store = SessionStore::new();

        assert_eq!(
            codex_app_server_refresh_interval_seconds(&store, 15),
            (EnergyMode::QuietBackground, 300)
        );

        store.get_or_create_session("idle-thread", "codex", "Codex", "/", "Codex");
        store.update_phase("idle-thread", SessionPhase::Idle);
        assert_eq!(
            codex_app_server_refresh_interval_seconds(&store, 15),
            (EnergyMode::IdleVisible, 60)
        );

        store.update_phase("idle-thread", SessionPhase::Processing);
        assert_eq!(
            codex_app_server_refresh_interval_seconds(&store, 15),
            (EnergyMode::Active, 15)
        );
    }

    #[test]
    fn remote_session_chat_history_uses_raw_hook_events() {
        let mut session = session("claude-code", "", None);
        session.id = "remote-session".to_string();
        session.last_response = Some("Fallback response".to_string());

        let messages = remote_session_chat_history(
            &session,
            vec![
                RawHookEvent {
                    seq: 1,
                    timestamp_ms: 1_700_000_000_000,
                    session_id: "remote-session".to_string(),
                    agent: Some("claude-code".to_string()),
                    event_name: "UserPromptSubmit".to_string(),
                    raw: serde_json::json!({
                        "prompt": "你好"
                    }),
                },
                RawHookEvent {
                    seq: 2,
                    timestamp_ms: 1_700_000_001_000,
                    session_id: "remote-session".to_string(),
                    agent: Some("claude-code".to_string()),
                    event_name: "Stop".to_string(),
                    raw: serde_json::json!({
                        "summary": "你好！有什么我可以帮你的吗？"
                    }),
                },
            ],
        );

        assert_eq!(messages.len(), 2);
        assert!(matches!(
            messages[0].role,
            crate::hooks::conversation_parser::ChatRole::User
        ));
        assert!(matches!(
            messages[1].role,
            crate::hooks::conversation_parser::ChatRole::Assistant
        ));
        assert!(matches!(
            &messages[1].blocks[0],
            crate::hooks::conversation_parser::MessageBlock::Text { text } if text.contains("帮你")
        ));
    }

    #[test]
    fn remote_session_chat_history_adds_session_completion_when_stop_is_generic() {
        let mut session = session("claude-code", "", None);
        session.id = "remote-session".to_string();
        session.last_response = Some("Task completed".to_string());

        let messages = remote_session_chat_history(
            &session,
            vec![RawHookEvent {
                seq: 1,
                timestamp_ms: 1_700_000_000_000,
                session_id: "remote-session".to_string(),
                agent: Some("claude-code".to_string()),
                event_name: "UserPromptSubmit".to_string(),
                raw: serde_json::json!({
                    "prompt": "hi"
                }),
            }],
        );

        assert_eq!(messages.len(), 2);
        assert!(matches!(
            messages[0].role,
            crate::hooks::conversation_parser::ChatRole::User
        ));
        assert!(matches!(
            messages[1].role,
            crate::hooks::conversation_parser::ChatRole::Assistant
        ));
        assert!(matches!(
            &messages[1].blocks[0],
            crate::hooks::conversation_parser::MessageBlock::Text { text } if text == "Task completed"
        ));
    }

    #[test]
    fn diagnostics_hook_config_redacts_inline_secrets_and_remote_urls() {
        let redacted = redact_sensitive_hook_config(
            r#"{
  "command": "curl -H 'Authorization: Bearer abc123' https://hooks.example.com/path?token=abc",
  "safe": "http://localhost:17894"
}"#,
        );

        assert!(!redacted.contains("abc123"));
        assert!(!redacted.contains("hooks.example.com"));
        assert!(redacted.contains("[REDACTED sensitive hook config line]"));
        assert!(redacted.contains("http://localhost:17894"));
    }

    #[test]
    fn diagnostics_hook_config_redacts_https_before_later_http_url() {
        let redacted = redact_sensitive_hook_config(
            r#"{"remote":"https://example.com/callback?id=abc","local":"http://localhost:17894"}"#,
        );

        assert!(!redacted.contains("example.com"));
        assert!(redacted.contains("[REDACTED_URL]"));
        assert!(redacted.contains("http://localhost:17894"));
    }

    #[test]
    fn diagnostics_hook_config_redacts_all_env_values() {
        let redacted = redact_sensitive_hook_config(
            r#"{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:20128/v1",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "h-combo",
    "CUSTOM_CREDENTIAL": "super-sensitive-value"
  }
}"#,
        );

        // Key names stay (useful for diagnostics), every value is gone — even
        // ones with innocuous names that the keyword blocklist would miss.
        assert!(redacted.contains("ANTHROPIC_BASE_URL"));
        assert!(redacted.contains("CUSTOM_CREDENTIAL"));
        assert!(!redacted.contains("super-sensitive-value"));
        assert!(!redacted.contains("h-combo"));
        assert!(!redacted.contains("20128"));
        assert!(redacted.contains("[REDACTED]"));
    }

    #[test]
    fn codex_desktop_detection_uses_bundle_or_missing_tty() {
        assert!(is_codex_desktop_session(&session("codex", "", None)));
        assert!(is_codex_desktop_session(&session("codex", "Codex", None)));
        assert!(!is_codex_desktop_session(&session(
            "codex",
            "Codex",
            Some("/dev/ttys001")
        )));
        let mut bundle_session = session("codex", "iTerm2", Some("/dev/ttys001"));
        bundle_session.term_bundle_id = Some("com.openai.codex".to_string());
        assert!(is_codex_desktop_session(&bundle_session));
        assert!(!is_codex_desktop_session(&session(
            "codex", "AgentBro", None
        )));
        // CLI: a tty without Codex app metadata should stay on the terminal path.
        assert!(!is_codex_desktop_session(&session(
            "codex",
            "",
            Some("/dev/ttys001")
        )));
        // CLI: terminal is a tty path — not desktop even if tty field is None
        assert!(!is_codex_desktop_session(&session(
            "codex",
            "/dev/ttys001",
            None
        )));
        // CLI: has explicit tty field set
        assert!(!is_codex_desktop_session(&session(
            "codex",
            "iTerm2",
            Some("/dev/ttys001")
        )));
        // Wrong agent type
        assert!(!is_codex_desktop_session(&session(
            "claude-code",
            "Codex",
            None
        )));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_app_user_model_id_strips_notification_query() {
        assert_eq!(
            clean_windows_app_user_model_id("OpenAI.Codex_2p2nqsd0c76g0!App?type=click&tag=123")
                .as_deref(),
            Some("OpenAI.Codex_2p2nqsd0c76g0!App")
        );
        assert_eq!(
            clean_windows_app_user_model_id(r"C:\Program Files\WindowsApps\OpenAI.Codex\App"),
            None
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn powershell_string_literal_escapes_single_quotes() {
        assert_eq!(
            powershell_string_literal("OpenAI.Codex_abc!App"),
            "'OpenAI.Codex_abc!App'"
        );
        assert_eq!(powershell_string_literal("A'B"), "'A''B'");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_shell_target_detects_protocols_without_treating_paths_as_urls() {
        assert!(is_windows_protocol_target(
            "codex://threads/123e4567-e89b-12d3-a456-426614174000"
        ));
        assert!(is_windows_protocol_target(
            "https://github.com/shirenchuang/agentbro"
        ));
        assert!(is_windows_protocol_target("ccswitch://provider"));
        assert!(!is_windows_protocol_target(
            r"C:\Users\admin\Documents\agentbro"
        ));
        assert!(!is_windows_protocol_target(r"\\server\share\agentbro"));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_terminal_launch_order_prefers_requested_shell() {
        assert_eq!(
            windows_terminal_launch_order("PowerShell").first().copied(),
            Some(WindowsTerminalLauncher::PowerShell)
        );
        assert_eq!(
            windows_terminal_launch_order("pwsh.exe").first().copied(),
            Some(WindowsTerminalLauncher::Pwsh)
        );
        assert_eq!(
            windows_terminal_launch_order("cmd.exe").first().copied(),
            Some(WindowsTerminalLauncher::Cmd)
        );
        assert_eq!(
            windows_terminal_launch_order("").first().copied(),
            Some(WindowsTerminalLauncher::WindowsTerminal)
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_authorization_terminal_uses_direct_wt_command() {
        assert_eq!(
            windows_terminal_command_args(r"C:\work\agentbro", "echo ok"),
            vec!["-d", r"C:\work\agentbro", "cmd.exe", "/K", "echo ok"]
        );
    }

    #[test]
    fn codex_session_meta_reads_originator_and_source() {
        let nonce = uuid::Uuid::new_v4();
        let path = std::env::temp_dir().join(format!("agentbro-codex-meta-{nonce}.jsonl"));
        fs::write(
            &path,
            r#"{"type":"session_meta","payload":{"originator":"codex_cli_rs","source":"cli"}}
{"type":"event_msg","payload":{"type":"token_count"}}"#,
        )
        .expect("write codex meta");

        let meta = read_codex_session_meta_from_path(&path).expect("read meta");
        assert_eq!(meta.originator.as_deref(), Some("codex_cli_rs"));
        assert_eq!(meta.source.as_deref(), Some("cli"));

        let _ = fs::remove_file(path);
    }

    #[test]
    fn codex_app_bundle_is_detected_as_desktop_session() {
        let mut session = session("codex", "", Some("/dev/ttys001"));
        session.term_bundle_id = Some("com.openai.codex".to_string());

        assert!(is_codex_desktop_session(&session));
    }

    #[test]
    fn ide_host_bundles_are_terminal_sessions_when_source_does_not_match() {
        let mut claude_in_cursor = session("claude-code", "Cursor", Some("/dev/ttys001"));
        claude_in_cursor.term_bundle_id = Some("com.todesktop.230313mzl4w4u92".to_string());

        assert!(is_ide_terminal_session(&claude_in_cursor));

        let mut cursor_app = session("cursor", "Cursor", None);
        cursor_app.term_bundle_id = Some("com.todesktop.230313mzl4w4u92".to_string());
        assert!(!is_ide_terminal_session(&cursor_app));

        let mut claude_in_qoder = session("claude-code", "Qoder", Some("/dev/ttys002"));
        claude_in_qoder.term_bundle_id = Some("com.qoder.ide".to_string());
        assert!(is_ide_terminal_session(&claude_in_qoder));
    }

    #[test]
    fn terminal_app_fallback_rejects_agent_app_labels() {
        assert!(can_fallback_to_terminal_app("iTerm2"));
        assert!(can_fallback_to_terminal_app("Terminal"));
        assert!(!can_fallback_to_terminal_app("Claude"));
        assert!(!can_fallback_to_terminal_app("AntCC"));
    }

    #[test]
    fn cwd_fallback_uses_real_terminal_app_names() {
        assert_eq!(fallback_terminal_app_name("iTerm·tmux"), "iTerm");
        assert_eq!(fallback_terminal_app_name("Ghostty"), "Ghostty");
        assert_eq!(
            fallback_terminal_app_name("dev.commandline.waveterm"),
            "Wave"
        );
        assert_eq!(fallback_terminal_app_name("AntCC"), "Terminal");
        assert_eq!(fallback_terminal_app_name(""), "Terminal");
    }

    #[test]
    fn jump_fallback_uses_terminal_environment_hint_when_terminal_is_empty() {
        let mut env_session = session("claude-code", "", None);
        env_session.term_program = Some("iTerm.app".to_string());
        assert_eq!(terminal_hint_for_fallback(&env_session), "iTerm");

        let mut bundle_session = session("claude-code", "", None);
        bundle_session.term_bundle_id = Some("com.mitchellh.ghostty".to_string());
        assert_eq!(terminal_hint_for_fallback(&bundle_session), "Ghostty");

        let mut wave_session = session("claude-code", "", None);
        wave_session.term_bundle_id = Some("dev.commandline.waveterm".to_string());
        assert_eq!(terminal_hint_for_fallback(&wave_session), "Wave");
    }

    #[test]
    fn codex_thread_jump_requires_uuid_like_ids() {
        assert!(is_uuid_like("123e4567-e89b-12d3-a456-426614174000"));
        assert!(!is_uuid_like("not-a-thread-id"));
        assert!(!is_uuid_like("123e4567e89b12d3a456426614174000"));
    }

    #[test]
    fn send_message_resolves_tty_from_stored_tty_or_terminal_path() {
        assert_eq!(
            resolve_session_tty(&session("claude-code", "iTerm2", Some("ttys001"))),
            Some("/dev/ttys001".to_string())
        );
        assert_eq!(
            resolve_session_tty(&session("claude-code", "/dev/ttys002", None)),
            Some("/dev/ttys002".to_string())
        );
    }

    #[test]
    fn subagent_chat_history_requires_registered_transcript_path() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let transcript_path =
            std::env::temp_dir().join(format!("agentbro-subagent-history-{nonce}.jsonl"));
        let other_path =
            std::env::temp_dir().join(format!("agentbro-subagent-history-other-{nonce}.jsonl"));
        fs::write(
            &transcript_path,
            format!(
                "{}\n",
                serde_json::json!({
                    "type": "assistant",
                    "uuid": "assistant-1",
                    "timestamp": "2026-01-01T00:00:00.000Z",
                    "message": {
                        "role": "assistant",
                        "content": "Subagent result"
                    }
                })
            ),
        )
        .expect("write transcript");
        fs::write(&other_path, "").expect("write other transcript");

        let transcript_path = transcript_path.to_string_lossy().to_string();
        let mut session = session("claude-code", "iTerm", Some("/dev/ttys001"));
        session.subagents.push(SubagentInfo {
            agent_id: "agent-1".to_string(),
            name: Some("audit-agent".to_string()),
            agent_type: Some("research".to_string()),
            description: "Audit".to_string(),
            transcript_path: None,
            agent_transcript_path: Some(transcript_path.clone()),
            last_assistant_message: None,
            started_at: 1,
            completed_at: Some(2),
            status: "completed".to_string(),
            tools: Vec::new(),
        });

        let messages =
            parse_subagent_chat_history_for_session(&session, &transcript_path).expect("parse");
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].id, "assistant-1");

        let err = parse_subagent_chat_history_for_session(&session, &other_path.to_string_lossy())
            .expect_err("unregistered transcript should be rejected");
        assert!(err.contains("not registered"));

        let _ = fs::remove_file(transcript_path);
        let _ = fs::remove_file(other_path);
    }

    #[test]
    fn subagent_chat_history_synthesizes_codex_main_transcript_rows() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let transcript_path =
            std::env::temp_dir().join(format!("agentbro-codex-subagent-history-{nonce}.jsonl"));
        fs::write(&transcript_path, "").expect("write transcript");

        let transcript_path = transcript_path.to_string_lossy().to_string();
        let mut session = session("codex", "Codex App", None);
        session.subagents.push(SubagentInfo {
            agent_id: "019e73f1-5808-7a91-bfd4-2aadc13d2c77".to_string(),
            name: Some("Laplace".to_string()),
            agent_type: None,
            description: "请只计算这个表达式并返回最终结果：1+1。".to_string(),
            transcript_path: Some(transcript_path.clone()),
            agent_transcript_path: None,
            last_assistant_message: Some("2".to_string()),
            started_at: 1_780_061_657,
            completed_at: Some(1_780_061_664),
            status: "completed".to_string(),
            tools: Vec::new(),
        });
        session.subagents.push(SubagentInfo {
            agent_id: "019e73f1-5899-7342-9013-b3ffa5404cac".to_string(),
            name: Some("Newton".to_string()),
            agent_type: None,
            description: "请只计算这个表达式并返回最终结果：2+2。".to_string(),
            transcript_path: Some(transcript_path.clone()),
            agent_transcript_path: None,
            last_assistant_message: Some("4".to_string()),
            started_at: 1_780_061_657,
            completed_at: Some(1_780_061_668),
            status: "completed".to_string(),
            tools: Vec::new(),
        });

        let request_path =
            format!("{transcript_path}#agentbro-subagent=019e73f1-5899-7342-9013-b3ffa5404cac");
        let messages =
            parse_subagent_chat_history_for_session(&session, &request_path).expect("parse");
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, ChatRole::User);
        assert_eq!(messages[1].role, ChatRole::Assistant);
        match &messages[1].blocks[0] {
            MessageBlock::Text { text } => assert_eq!(text, "4"),
            other => panic!("expected text block, got {other:?}"),
        }

        let _ = fs::remove_file(transcript_path);
    }

    #[test]
    fn task_activation_distinguishes_desktop_hosts_from_cli_sessions() {
        let mut desktop = session("opencode", "OpenCode", None);
        desktop.term_bundle_id = Some("ai.opencode.desktop".to_string());
        assert!(session_has_desktop_host(&desktop));

        assert!(!session_has_desktop_host(&session(
            "antigravity",
            "Windows Terminal",
            Some("CONPTY")
        )));
    }
}
