use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskEventRecord {
    pub id: String,
    pub task_id: String,
    pub run_id: String,
    pub timestamp_ms: u64,
    pub kind: String,
    pub event_type: String,
    pub title: String,
    pub detail: Option<String>,
    pub status: Option<String>,
    pub payload_json: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunRecord {
    pub id: String,
    pub task_id: String,
    pub session_id: String,
    pub parent_run_id: Option<String>,
    pub agent: String,
    pub role: String,
    pub dispatched_task: Option<String>,
    pub title: String,
    pub status: String,
    pub started_at: i64,
    pub completed_at: Option<i64>,
    pub pid: Option<u32>,
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub children: Vec<AgentRunRecord>,
    #[serde(default)]
    pub events: Vec<TaskEventRecord>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskRecord {
    pub id: String,
    pub trace_id: String,
    pub project: String,
    pub title: String,
    pub status: String,
    #[serde(default)]
    pub runs: Vec<AgentRunRecord>,
    pub created_at: String,
    pub updated_at: String,
}
