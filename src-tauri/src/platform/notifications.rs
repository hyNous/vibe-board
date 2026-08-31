use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

const NOTIFICATION_COOLDOWN: Duration = Duration::from_secs(5);

fn should_notify(kind: &str, body: &str) -> bool {
    static RECENT: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    let now = Instant::now();
    let key = format!("{kind}:{}", body.trim());
    let recent = RECENT.get_or_init(|| Mutex::new(HashMap::new()));
    let Ok(mut recent) = recent.lock() else {
        return true;
    };
    recent.retain(|_, timestamp| now.duration_since(*timestamp) < NOTIFICATION_COOLDOWN);
    if recent.contains_key(&key) {
        return false;
    }
    recent.insert(key, now);
    true
}

fn truncate_text(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let text: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{text}...")
    } else {
        text
    }
}

/// Send a native notification for a blocking event that was suppressed
/// (the user is looking at the terminal, so we degrade to notification instead of overlay).
pub fn send_permission_notification(app: &AppHandle, tool_name: &str) {
    if !should_notify("permission", tool_name) {
        return;
    }
    let _ = app
        .notification()
        .builder()
        .title("Permission Request")
        .body(format!("{} needs approval", tool_name))
        .show();
}

pub fn send_question_notification(app: &AppHandle, question: &str) {
    if !should_notify("question", question) {
        return;
    }
    let truncated = truncate_text(question, 77);
    let _ = app
        .notification()
        .builder()
        .title("Question")
        .body(truncated)
        .show();
}

pub fn send_plan_notification(app: &AppHandle, plan_title: &str) {
    if !should_notify("plan", plan_title) {
        return;
    }
    let _ = app
        .notification()
        .builder()
        .title("Plan Approval")
        .body(plan_title.to_string())
        .show();
}

pub fn send_completion_notification(app: &AppHandle, summary: &str) {
    if !should_notify("completion", summary) {
        return;
    }
    let truncated = truncate_text(summary, 77);
    let _ = app
        .notification()
        .builder()
        .title("Task Complete")
        .body(truncated)
        .show();
}

pub fn send_error_notification(app: &AppHandle, message: &str) {
    if !should_notify("error", message) {
        return;
    }
    let truncated = truncate_text(message, 77);
    let _ = app
        .notification()
        .builder()
        .title("Agent Error")
        .body(truncated)
        .show();
}

#[cfg(test)]
mod tests {
    #[test]
    fn deduplicates_same_notification_during_cooldown() {
        assert!(super::should_notify("test", "unique notification"));
        assert!(!super::should_notify("test", "unique notification"));
    }

    #[test]
    fn truncates_by_characters_without_splitting_utf8() {
        assert_eq!(super::truncate_text("权限请求", 2), "权限...");
    }
}
