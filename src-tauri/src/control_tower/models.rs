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
