use tauri::State;

use super::models::TaskRecord;
use crate::commands::AppState;

#[tauri::command]
pub async fn create_demo_task_trace(state: State<'_, AppState>) -> Result<TaskRecord, String> {
    state
        .task_db
        .create_demo_task_trace()
        .map_err(|e| format!("Failed to create demo task trace: {e}"))
}

#[tauri::command]
pub async fn get_task_traces(state: State<'_, AppState>) -> Result<Vec<TaskRecord>, String> {
    state
        .task_db
        .get_all_tasks()
        .map_err(|e| format!("Failed to get task traces: {e}"))
}
