// Agent Adapter Trait & Registry
pub mod antigravity;
pub mod claude_code;
pub mod cline;
pub mod codebuddy;
pub mod codebuddycn;
pub mod codex;
pub mod codex_app_server;
pub mod copilot;
pub mod cursor;
pub mod cursor_cli;
pub mod deepseek;
pub mod detection;
pub mod droid;
pub mod executable;
pub mod gemini;
pub mod hermes;
pub mod hook_manager;
pub mod kimi;
pub mod kiro;
pub mod opencode;
pub mod pi;
pub mod profiles;
pub mod programs;
pub mod qoder;
pub mod qoder_cli;
pub mod qwen;
pub mod stepfun;
pub mod toml_hooks;
pub mod traits;
pub mod workbuddy;
pub mod zcode;

pub use traits::AgentAdapter;

use serde::{Deserialize, Serialize};

pub fn project_name_from_path(path: &str) -> String {
    path.trim()
        .trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .find(|part| !part.is_empty())
        .unwrap_or(path)
        .to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum AdapterStatus {
    Active,
    Installed,
    Available,
    Unavailable,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AgentEvent {
    SessionStart {
        session_id: String,
        project: String,
        cwd: String,
        terminal: String,
        agent_type: String,
    },
    SessionEnd {
        session_id: String,
    },
    Processing {
        session_id: String,
        description: String,
    },
    ToolUse {
        session_id: String,
        tool_name: String,
        tool_input: String,
        tool_target: Option<String>,
        status: String,
    },
    PermissionRequest {
        session_id: String,
        tool_name: String,
        diff: Option<String>,
        options: Option<Vec<String>>,
    },
    AskQuestion {
        session_id: String,
        question: String,
        options: Vec<String>,
        descriptions: Vec<String>,
        header: Option<String>,
        multi_select: bool,
        questions: Vec<QuestionItem>,
    },
    PlanApproval {
        session_id: String,
        title: String,
        content: String,
        permissions: Vec<String>,
    },
    TaskComplete {
        session_id: String,
        summary: String,
    },
    AssistantResponseComplete {
        session_id: String,
        text: String,
    },
    Error {
        session_id: String,
        message: String,
    },
    Interrupt {
        session_id: String,
    },
    TokenUsage {
        session_id: String,
        input: u64,
        output: u64,
        cache_read: u64,
        cache_create: u64,
    },
    RateLimitUpdate {
        session_id: String,
        five_hour_usage: f64,
        five_hour_remaining: String,
        seven_day_usage: f64,
        seven_day_remaining: String,
        status_line_text: Option<String>,
        total_input_tokens: Option<u64>,
        total_output_tokens: Option<u64>,
        context_window_size: Option<u64>,
        context_used_percentage: Option<f64>,
        last_main_agent_at: Option<i64>,
        cache_ttl_ms: Option<i64>,
    },
    Notification {
        session_id: String,
        message: String,
        status: Option<String>,
    },
    SubagentStart {
        session_id: String,
        agent_id: String,
        name: Option<String>,
        description: String,
        agent_type: Option<String>,
        transcript_path: Option<String>,
    },
    SubagentStop {
        session_id: String,
        agent_id: String,
        status: String,
        name: Option<String>,
        agent_type: Option<String>,
        transcript_path: Option<String>,
        agent_transcript_path: Option<String>,
        last_assistant_message: Option<String>,
    },
    // Shell execution hooks
    ShellExecutionStart {
        session_id: String,
        command: String,
        cwd: String,
    },
    ShellExecutionEnd {
        session_id: String,
        command: String,
        exit_code: Option<i32>,
        stdout: Option<String>,
        stderr: Option<String>,
        duration_ms: u64,
    },
    // MCP execution hooks
    MCPExecutionStart {
        session_id: String,
        server_name: String,
        tool_name: String,
        arguments: String,
    },
    MCPExecutionEnd {
        session_id: String,
        server_name: String,
        tool_name: String,
        result: Option<String>,
        error: Option<String>,
        duration_ms: u64,
    },
    // Agent response hooks
    AgentResponse {
        session_id: String,
        content: String,
        content_type: String,
    },
    AgentThought {
        session_id: String,
        thought: String,
    },
}

/// Parse the normalized status-line payload emitted by the native bridge.
/// OpenCode and Antigravity use the same bridge shape as Claude, so keeping
/// this small parser here makes their quota/token events behave consistently.
pub fn rate_limit_event_from_raw(
    raw: &serde_json::Value,
    session_id: String,
) -> Result<AgentEvent, Box<dyn std::error::Error>> {
    let rate_limits = raw
        .get("rateLimits")
        .or_else(|| raw.get("rate_limits"))
        .ok_or("missing rate limits")?;
    let five_hour = rate_limits
        .get("fiveHour")
        .or_else(|| rate_limits.get("five_hour"))
        .ok_or("missing five-hour rate limit")?;
    let seven_day = rate_limits
        .get("sevenDay")
        .or_else(|| rate_limits.get("seven_day"))
        .ok_or("missing seven-day rate limit")?;

    let context_window = raw
        .get("contextWindow")
        .or_else(|| raw.get("context_window"));
    Ok(AgentEvent::RateLimitUpdate {
        session_id,
        five_hour_usage: rate_limit_percentage(five_hour),
        five_hour_remaining: rate_limit_remaining(five_hour),
        seven_day_usage: rate_limit_percentage(seven_day),
        seven_day_remaining: rate_limit_remaining(seven_day),
        status_line_text: raw
            .get("statusLineText")
            .or_else(|| raw.get("status_line_text"))
            .and_then(|value| value.as_str())
            .map(str::to_string),
        total_input_tokens: context_window.and_then(|value| {
            value
                .get("totalInputTokens")
                .or_else(|| value.get("total_input_tokens"))
                .and_then(|value| value.as_u64())
        }),
        total_output_tokens: context_window.and_then(|value| {
            value
                .get("totalOutputTokens")
                .or_else(|| value.get("total_output_tokens"))
                .and_then(|value| value.as_u64())
        }),
        context_window_size: context_window.and_then(|value| {
            value
                .get("contextWindowSize")
                .or_else(|| value.get("context_window_size"))
                .and_then(|value| value.as_u64())
        }),
        context_used_percentage: context_window.and_then(|value| {
            value
                .get("usedPercentage")
                .or_else(|| value.get("used_percentage"))
                .and_then(|value| value.as_f64())
        }),
        last_main_agent_at: raw
            .get("lastMainAgentAt")
            .or_else(|| raw.get("last_main_agent_at"))
            .and_then(|value| value.as_i64()),
        cache_ttl_ms: raw
            .get("cacheTTLMs")
            .or_else(|| raw.get("cache_ttl_ms"))
            .and_then(|value| value.as_i64()),
    })
}

fn rate_limit_percentage(value: &serde_json::Value) -> f64 {
    value
        .get("usedPercentage")
        .or_else(|| value.get("used_percentage"))
        .or_else(|| value.get("usage"))
        .and_then(|value| value.as_f64())
        .unwrap_or(0.0)
}

fn rate_limit_remaining(value: &serde_json::Value) -> String {
    if let Some(label) = value
        .get("remaining")
        .or_else(|| value.get("remainingLabel"))
        .or_else(|| value.get("remaining_label"))
        .and_then(|value| value.as_str())
    {
        return label.to_string();
    }

    let Some(reset) = value
        .get("resetsAt")
        .or_else(|| value.get("resets_at"))
        .and_then(|value| value.as_f64())
    else {
        return "--".to_string();
    };
    let reset_ms = if reset < 10_000_000_000.0 {
        reset * 1000.0
    } else {
        reset
    };
    let remaining_secs =
        ((reset_ms - chrono::Utc::now().timestamp_millis() as f64) / 1000.0).max(0.0) as i64;
    let hours = remaining_secs / 3600;
    let minutes = (remaining_secs % 3600) / 60;
    if hours >= 24 {
        format!("{}d{}h", hours / 24, hours % 24)
    } else if hours > 0 {
        format!("{}h{}m", hours, minutes)
    } else {
        format!("{}m", minutes)
    }
}

#[cfg(test)]
mod rate_limit_tests {
    use super::{rate_limit_event_from_raw, AgentEvent};

    #[test]
    fn parses_snake_case_status_line_for_cli_adapters() {
        let event = rate_limit_event_from_raw(
            &serde_json::json!({
                "rate_limits": {
                    "five_hour": { "used_percentage": 25.0, "remaining": "3h" },
                    "seven_day": { "used_percentage": 40.0, "remaining": "5d" }
                },
                "context_window": {
                    "total_input_tokens": 100,
                    "total_output_tokens": 20,
                    "context_window_size": 1000,
                    "used_percentage": 12.0
                }
            }),
            "session-1".to_string(),
        )
        .expect("status-line payload should parse");

        assert!(matches!(
            event,
            AgentEvent::RateLimitUpdate {
                session_id,
                five_hour_usage,
                five_hour_remaining,
                total_input_tokens: Some(100),
                ..
            } if session_id == "session-1"
                && five_hour_usage == 25.0
                && five_hour_remaining == "3h"
        ));
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuestionItem {
    pub question: String,
    pub header: Option<String>,
    pub options: Vec<QuestionOption>,
    pub multi_select: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuestionOption {
    pub label: String,
    pub description: Option<String>,
}

/// Adapter info returned to the frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterInfo {
    pub name: String,
    pub display_name: String,
    pub icon: String,
    pub status: AdapterStatus,
}

/// Build the default list of all supported adapters
pub fn all_adapters() -> Vec<Box<dyn AgentAdapter>> {
    vec![
        Box::new(claude_code::ClaudeCodeAdapter::new()),
        Box::new(cline::ClineAdapter::new()),
        Box::new(codex::CodexAdapter::new()),
        Box::new(gemini::GeminiAdapter::new()),
        Box::new(cursor::CursorAdapter::new()),
        Box::new(cursor_cli::CursorCliAdapter::new()),
        Box::new(copilot::CopilotAdapter::new()),
        Box::new(qoder::QoderAdapter::new()),
        Box::new(qoder_cli::QoderCliAdapter::new()),
        Box::new(codebuddy::CodeBuddyAdapter::new()),
        Box::new(codebuddycn::CodeBuddyCNAdapter::new()),
        Box::new(qwen::QwenAdapter::new()),
        Box::new(kimi::KimiAdapter::new()),
        Box::new(deepseek::DeepSeekAdapter::new()),
        Box::new(opencode::OpenCodeAdapter::new()),
        Box::new(droid::DroidAdapter::new()),
        Box::new(stepfun::StepFunAdapter::new()),
        Box::new(antigravity::AntiGravityAdapter::new()),
        Box::new(workbuddy::WorkBuddyAdapter::new()),
        Box::new(hermes::HermesAdapter::new()),
        Box::new(pi::PiAdapter::new()),
        Box::new(kiro::KiroAdapter::new()),
        Box::new(zcode::ZcodeAdapter::new()),
    ]
}

macro_rules! impl_default_adapter {
    ($($adapter:path),+ $(,)?) => {
        $(
            impl Default for $adapter {
                fn default() -> Self {
                    Self::new()
                }
            }
        )+
    };
}

impl_default_adapter!(
    antigravity::AntiGravityAdapter,
    claude_code::ClaudeCodeAdapter,
    cline::ClineAdapter,
    codebuddy::CodeBuddyAdapter,
    codebuddycn::CodeBuddyCNAdapter,
    codex::CodexAdapter,
    copilot::CopilotAdapter,
    cursor::CursorAdapter,
    cursor_cli::CursorCliAdapter,
    deepseek::DeepSeekAdapter,
    droid::DroidAdapter,
    gemini::GeminiAdapter,
    hermes::HermesAdapter,
    kimi::KimiAdapter,
    kiro::KiroAdapter,
    opencode::OpenCodeAdapter,
    pi::PiAdapter,
    qoder::QoderAdapter,
    qoder_cli::QoderCliAdapter,
    qwen::QwenAdapter,
    stepfun::StepFunAdapter,
    workbuddy::WorkBuddyAdapter,
    zcode::ZcodeAdapter,
);

#[cfg(test)]
mod tests {
    use super::project_name_from_path;

    #[test]
    fn project_name_from_path_handles_unix_and_windows_separators() {
        assert_eq!(
            project_name_from_path("/Users/me/code/agentbro"),
            "agentbro"
        );
        assert_eq!(
            project_name_from_path(r"C:\Users\me\code\agentbro"),
            "agentbro"
        );
        assert_eq!(
            project_name_from_path("/Users/me/code/agentbro/"),
            "agentbro"
        );
        assert_eq!(
            project_name_from_path(r"C:\Users\me\code\agentbro\"),
            "agentbro"
        );
        assert_eq!(project_name_from_path("agentbro"), "agentbro");
        assert_eq!(project_name_from_path(""), "");
    }
}
