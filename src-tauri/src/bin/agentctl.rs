// Keep the standalone helper from opening a transient console when launched
// by the desktop app or an installer. When invoked from an existing terminal,
// inherited standard handles still receive its output.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::env;
use std::sync::Arc;

use vibe_board_lib::control_tower::agentctl::{self, DispatchRequest};
use vibe_board_lib::control_tower::ControlTowerDatabase;

const USAGE: &str = r#"Usage:
  agentctl dispatch --agent <claude|opencode|antigravity> --task <text>
                    [--role <role>] [--task-id <id>]
                    [--parent-run-id <id>] [--cwd <path>]
"#;

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("agentctl: {error}");
        std::process::exit(1);
    }
}

async fn run() -> anyhow::Result<()> {
    let mut args = env::args().skip(1);
    match args.next().as_deref() {
        Some("dispatch") => {}
        Some("--help") | Some("-h") | None => {
            print!("{USAGE}");
            return Ok(());
        }
        Some(command) => anyhow::bail!("unknown command '{command}'\n\n{USAGE}"),
    }

    let mut agent = None;
    let mut role = "worker".to_string();
    let mut task = None;
    let mut task_id = None;
    let mut parent_run_id = None;
    let mut cwd = None;

    while let Some(flag) = args.next() {
        match flag.as_str() {
            "--agent" => agent = Some(required_value(&mut args, "--agent")?),
            "--role" => role = required_value(&mut args, "--role")?,
            "--task" => task = Some(required_value(&mut args, "--task")?),
            "--task-id" => task_id = Some(required_value(&mut args, "--task-id")?),
            "--parent-run-id" => {
                parent_run_id = Some(required_value(&mut args, "--parent-run-id")?)
            }
            "--cwd" => cwd = Some(required_value(&mut args, "--cwd")?),
            "--help" | "-h" => {
                print!("{USAGE}");
                return Ok(());
            }
            other => anyhow::bail!("unknown option '{other}'\n\n{USAGE}"),
        }
    }

    let request = DispatchRequest {
        agent: agent.ok_or_else(|| anyhow::anyhow!("--agent is required"))?,
        role,
        task: task.ok_or_else(|| anyhow::anyhow!("--task is required"))?,
        task_id,
        parent_run_id,
        cwd,
    };
    let db = Arc::new(ControlTowerDatabase::open()?);
    let result = agentctl::dispatch(db, request, true).await?;
    println!("{}", serde_json::to_string_pretty(&result)?);
    if result.status == "completed" {
        Ok(())
    } else {
        anyhow::bail!("child agent finished with status {}", result.status)
    }
}

fn required_value(args: &mut impl Iterator<Item = String>, flag: &str) -> anyhow::Result<String> {
    args.next()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow::anyhow!("{flag} requires a value"))
}
