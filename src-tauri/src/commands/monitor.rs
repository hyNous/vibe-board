use super::AppState;
use crate::hooks::session_store::{SessionPhase, SessionState};
use serde::Serialize;
use tauri::State;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorSessionSummary {
    pub id: String,
    pub agent_type: String,
    pub engine_label: Option<String>,
    pub project: String,
    pub cwd: String,
    pub terminal: String,
    pub phase: String,
    pub started_at: i64,
    pub duration: i64,
    pub token_total: u64,
    pub last_tool_name: Option<String>,
    pub last_tool_target: Option<String>,
    pub last_tool_status: Option<String>,
    pub subagent_count: usize,
    pub active_tool_count: usize,
    pub title: Option<String>,
}

#[tauri::command]
pub async fn get_monitor_sessions(
    state: State<'_, AppState>,
) -> Result<Vec<MonitorSessionSummary>, String> {
    let mut sessions: Vec<MonitorSessionSummary> = state
        .session_store
        .get_all_sessions()
        .into_iter()
        .map(session_summary)
        .collect();

    sessions.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    Ok(sessions)
}

fn session_summary(session: SessionState) -> MonitorSessionSummary {
    let token_total = session.tokens.input
        + session.tokens.output
        + session.tokens.cache_read
        + session.tokens.cache_create;

    MonitorSessionSummary {
        id: session.id,
        agent_type: session.agent_type,
        engine_label: session.engine_label,
        project: session.project,
        cwd: session.cwd,
        terminal: session.terminal,
        phase: phase_label(&session.phase).to_string(),
        started_at: session.started_at,
        duration: session.duration,
        token_total,
        last_tool_name: session.last_tool_name,
        last_tool_target: session.last_tool_target,
        last_tool_status: session.last_tool_status,
        subagent_count: session.subagents.len(),
        active_tool_count: session
            .active_tools
            .iter()
            .filter(|tool| tool.status == "running")
            .count(),
        title: session.session_title,
    }
}

fn phase_label(phase: &SessionPhase) -> &'static str {
    match phase {
        SessionPhase::Ready => "ready",
        SessionPhase::Idle => "idle",
        SessionPhase::Processing => "processing",
        SessionPhase::WaitingInput => "waiting_input",
        SessionPhase::Compacting => "compacting",
        SessionPhase::Done => "done",
        SessionPhase::Error => "error",
        SessionPhase::Interrupted => "interrupted",
    }
}
