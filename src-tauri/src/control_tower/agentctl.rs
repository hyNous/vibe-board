use std::path::PathBuf;
use std::sync::Arc;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::db::ControlTowerDatabase;
use super::models::{AgentRunRecord, TaskEventRecord};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchRequest {
    pub agent: String,
    #[serde(default = "default_role")]
    pub role: String,
    pub task: String,
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub parent_run_id: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchResult {
    pub run_id: String,
    pub session_id: String,
    pub agent: String,
    pub pid: Option<u32>,
    pub status: String,
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone)]
struct CommandSpec {
    program: PathBuf,
    args: Vec<String>,
}

fn default_role() -> String {
    "worker".to_string()
}

fn canonical_agent(agent: &str) -> anyhow::Result<&'static str> {
    match agent.trim().to_ascii_lowercase().as_str() {
        "claude" | "claude-code" => Ok("claude"),
        "opencode" | "open-code" => Ok("opencode"),
        "antigravity" | "agy" => Ok("antigravity"),
        other => Err(anyhow::anyhow!(
            "Unsupported agent '{other}'. Supported agents: claude, opencode, antigravity"
        )),
    }
}

fn command_spec(agent: &str, task: &str) -> anyhow::Result<CommandSpec> {
    let agent = canonical_agent(agent)?;
    let (program, args) = match agent {
        "claude" => ("claude", vec!["-p", task]),
        "opencode" => ("opencode", vec!["run", task]),
        "antigravity" => ("agy", vec!["--print", task]),
        _ => unreachable!(),
    };
    Ok(CommandSpec {
        program: crate::agents::executable::command_path(program),
        args: args.into_iter().map(ToString::to_string).collect(),
    })
}

pub async fn dispatch(
    db: Arc<ControlTowerDatabase>,
    request: DispatchRequest,
    wait_for_exit: bool,
) -> anyhow::Result<DispatchResult> {
    if request.task.trim().is_empty() {
        anyhow::bail!("task must not be empty");
    }
    if request.role.trim().is_empty() {
        anyhow::bail!("role must not be empty");
    }
    let spec = command_spec(&request.agent, &request.task)?;
    dispatch_with_spec(db, request, spec, wait_for_exit).await
}

async fn dispatch_with_spec(
    db: Arc<ControlTowerDatabase>,
    request: DispatchRequest,
    spec: CommandSpec,
    wait_for_exit: bool,
) -> anyhow::Result<DispatchResult> {
    let parent = db
        .find_parent_run(request.task_id.as_deref(), request.parent_run_id.as_deref())?
        .ok_or_else(|| {
            anyhow::anyhow!(
                "No Codex parent run found; create a task trace first or pass a valid task/parent run id"
            )
        })?;
    let agent = canonical_agent(&request.agent)?.to_string();
    let now = Utc::now();
    let now_sec = now.timestamp();
    let now_iso = now.to_rfc3339();
    let run_id = format!("run-{}", Uuid::new_v4().simple());
    let session_id = format!("session-{}", Uuid::new_v4().simple());
    let cwd = request
        .cwd
        .clone()
        .map(PathBuf::from)
        .unwrap_or(std::env::current_dir()?);
    let title = format!("{} Child Run", display_agent(&agent));

    let run = AgentRunRecord {
        id: run_id.clone(),
        task_id: parent.task_id.clone(),
        session_id: session_id.clone(),
        parent_run_id: Some(parent.parent_run_id.clone()),
        agent: agent.clone(),
        role: request.role.clone(),
        dispatched_task: Some(request.task.clone()),
        title,
        status: "starting".to_string(),
        started_at: now_sec,
        completed_at: None,
        pid: None,
        exit_code: None,
        children: Vec::new(),
        events: Vec::new(),
        created_at: now_iso.clone(),
        updated_at: now_iso.clone(),
    };
    let starting_event = event(
        &run,
        "process",
        "process.starting",
        "Child Run Starting",
        Some(format!("Preparing {} CLI", display_agent(&agent))),
        "starting",
        serde_json::json!({
            "agent": agent,
            "role": request.role,
            "cwd": cwd,
        }),
    );
    db.insert_child_run(&run, &starting_event)?;

    let mut command = crate::platform::process::background_tokio_command(&spec.program);
    command
        .args(&spec.args)
        .current_dir(&cwd)
        .env("AGENT_TRACE_ID", &parent.trace_id)
        .env("AGENT_TASK_ID", &parent.task_id)
        .env("AGENT_PARENT_RUN_ID", &parent.parent_run_id)
        .env("AGENT_RUN_ID", &run_id)
        .env("AGENT_ROLE", &request.role)
        .env("AGENT_PROJECT", &parent.project)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    if let Some(path) = crate::agents::executable::augmented_path_env() {
        command.env("PATH", path);
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let finished_at = Utc::now();
            let failed_event = event(
                &run,
                "process",
                "process.error",
                "Child Run Failed to Start",
                Some(error.to_string()),
                "error",
                serde_json::json!({ "error": error.to_string() }),
            );
            db.mark_run_finished(
                &run_id,
                "error",
                None,
                finished_at.timestamp(),
                &failed_event,
            )?;
            return Err(anyhow::anyhow!(
                "Failed to start {}: {error}",
                display_agent(&agent)
            ));
        }
    };

    let pid = child.id();
    let started_event = event(
        &run,
        "process",
        "process.started",
        "Child Run Started",
        Some(format!("{} process is running", display_agent(&agent))),
        "running",
        serde_json::json!({ "pid": pid }),
    );
    if let Err(error) = db.mark_run_started(&run_id, pid, &started_event) {
        let _ = child.start_kill();
        return Err(error);
    }

    let mut result = DispatchResult {
        run_id: run_id.clone(),
        session_id,
        agent: agent.clone(),
        pid,
        status: "running".to_string(),
        exit_code: None,
    };

    let wait_for_child = async move {
        let wait_result = child.wait().await;
        let finished_at = Utc::now();
        let (status, exit_code, detail, payload) = match wait_result {
            Ok(exit) if exit.success() => (
                "completed",
                exit.code(),
                Some(format!("{} process completed", display_agent(&agent))),
                serde_json::json!({ "exitCode": exit.code() }),
            ),
            Ok(exit) => (
                "error",
                exit.code(),
                Some(format!(
                    "{} process exited with an error",
                    display_agent(&agent)
                )),
                serde_json::json!({ "exitCode": exit.code() }),
            ),
            Err(error) => (
                "error",
                None,
                Some(error.to_string()),
                serde_json::json!({ "error": error.to_string() }),
            ),
        };
        let finished_run = AgentRunRecord {
            status: status.to_string(),
            ..run
        };
        let finished_event = event(
            &finished_run,
            "process",
            if status == "completed" {
                "process.completed"
            } else {
                "process.error"
            },
            if status == "completed" {
                "Child Run Completed"
            } else {
                "Child Run Failed"
            },
            detail,
            status,
            payload,
        );
        db.mark_run_finished(
            &run_id,
            status,
            exit_code,
            finished_at.timestamp(),
            &finished_event,
        )?;
        Ok::<_, anyhow::Error>((status.to_string(), exit_code))
    };

    if wait_for_exit {
        let (status, exit_code) = wait_for_child.await?;
        result.status = status;
        result.exit_code = exit_code;
    } else {
        tauri::async_runtime::spawn(async move {
            if let Err(error) = wait_for_child.await {
                log::error!("agentctl child monitor failed: {error}");
            }
        });
    }

    Ok(result)
}

fn display_agent(agent: &str) -> &'static str {
    match agent {
        "claude" => "Claude",
        "opencode" => "OpenCode",
        "antigravity" => "Antigravity",
        _ => "Agent",
    }
}

fn event(
    run: &AgentRunRecord,
    kind: &str,
    event_type: &str,
    title: &str,
    detail: Option<String>,
    status: &str,
    payload: serde_json::Value,
) -> TaskEventRecord {
    let now = Utc::now();
    TaskEventRecord {
        id: format!("event-{}", Uuid::new_v4().simple()),
        task_id: run.task_id.clone(),
        run_id: run.id.clone(),
        timestamp_ms: now.timestamp_millis().max(0) as u64,
        kind: kind.to_string(),
        event_type: event_type.to_string(),
        title: title.to_string(),
        detail,
        status: Some(status.to_string()),
        payload_json: Some(payload.to_string()),
        created_at: now.to_rfc3339(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_specs_cover_supported_agents() {
        assert_eq!(canonical_agent("claude-code").unwrap(), "claude");
        assert_eq!(canonical_agent("opencode").unwrap(), "opencode");
        assert_eq!(canonical_agent("agy").unwrap(), "antigravity");
        assert!(canonical_agent("grok").is_err());
        assert_eq!(
            command_spec("agy", "inspect").unwrap().args,
            ["--print", "inspect"]
        );
    }

    #[tokio::test]
    async fn fake_child_updates_run_lifecycle() {
        let db = Arc::new(ControlTowerDatabase::open_in_memory().expect("db"));
        db.create_demo_task_trace().expect("demo task");
        let request = DispatchRequest {
            agent: "claude".to_string(),
            role: "worker".to_string(),
            task: "fake test task".to_string(),
            task_id: Some("task-demo-control-tower".to_string()),
            parent_run_id: Some("run-demo-codex-root".to_string()),
            cwd: None,
        };
        #[cfg(windows)]
        let spec = CommandSpec {
            program: crate::agents::executable::command_path("cmd"),
            args: vec!["/C".to_string(), "exit 0".to_string()],
        };
        #[cfg(not(windows))]
        let spec = CommandSpec {
            program: PathBuf::from("sh"),
            args: vec!["-c".to_string(), "exit 0".to_string()],
        };

        let result = dispatch_with_spec(db.clone(), request, spec, true)
            .await
            .expect("dispatch");
        assert_eq!(result.status, "completed");
        let task = db
            .get_all_tasks()
            .expect("tasks")
            .into_iter()
            .find(|task| task.id == "task-demo-control-tower")
            .expect("task");
        let child = &task.runs[0].children[0];
        assert_eq!(child.status, "completed");
        assert_eq!(child.parent_run_id.as_deref(), Some("run-demo-codex-root"));
        assert!(child
            .events
            .iter()
            .any(|event| event.event_type == "process.started"));
        assert!(child
            .events
            .iter()
            .any(|event| event.event_type == "process.completed"));
    }
}
