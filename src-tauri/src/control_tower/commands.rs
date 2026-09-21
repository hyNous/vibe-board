use tauri::State;

use super::models::TaskRecord;
use crate::commands::AppState;

#[tauri::command]
pub async fn get_task_traces(state: State<'_, AppState>) -> Result<Vec<TaskRecord>, String> {
    state
        .task_db
        .get_all_tasks()
        .map_err(|e| format!("Failed to get task traces: {e}"))
}
