// Shared parsing and normalization helpers for the usage providers. Provider
// payloads differ (percentages, fractions, reset timestamps, remaining labels),
// so every provider funnels its raw JSON through these functions before the
// snapshot is built. No network access happens here.

use crate::hooks::session_store::{RateLimitInfo, UsageRateWindow};
use std::path::PathBuf;

#[derive(Clone)]
pub(crate) struct UsageRateLimitSnapshot {
    pub rate_limits: RateLimitInfo,
    pub captured_at: Option<chrono::DateTime<chrono::Utc>>,
}

pub(crate) fn provider_rate_limits(
    provider: &str,
    provider_label: &str,
    source: &str,
    captured_at: Option<chrono::DateTime<chrono::Utc>>,
    five_hour: &serde_json::Value,
    seven_day: &serde_json::Value,
) -> Option<RateLimitInfo> {
    let five_hour_usage = used_percentage(five_hour)?;
    let seven_day_usage = used_percentage(seven_day)?;
    Some(RateLimitInfo {
        five_hour_usage,
        five_hour_remaining: remaining_label(five_hour),
        seven_day_usage,
        seven_day_remaining: remaining_label(seven_day),
        provider: Some(provider.to_string()),
        provider_label: Some(provider_label.to_string()),
        source: Some(source.to_string()),
        updated_at: captured_at.map(|date| date.timestamp_millis()),
        windows: vec![
            usage_window("five_hour", "5h", five_hour, Some(300))?,
            usage_window("seven_day", "7d", seven_day, Some(10_080))?,
        ],
    })
}

pub(crate) fn usage_window(
    id: &str,
    title: &str,
    value: &serde_json::Value,
    fallback_minutes: Option<i64>,
) -> Option<UsageRateWindow> {
    let used_percent = used_percentage(value)?;
    Some(UsageRateWindow {
        id: id.to_string(),
        title: title.to_string(),
        used_percent,
        remaining_percent: Some((100.0 - used_percent).clamp(0.0, 100.0)),
        remaining_label: Some(remaining_label(value)).filter(|text| !text.is_empty()),
        resets_at: reset_at_iso(value),
        window_minutes: window_minutes(value).or(fallback_minutes),
    })
}

/// Snapshots may carry only the legacy `five_hour`/`seven_day` percentages.
/// The UI renders windows, so synthesize the two standard windows when needed.
pub(crate) fn windows_from_rate_limits(rate_limits: &RateLimitInfo) -> Vec<UsageRateWindow> {
    if !rate_limits.windows.is_empty() {
        return rate_limits.windows.clone();
    }

    [
        (
            "five_hour",
            "5h",
            rate_limits.five_hour_usage,
            &rate_limits.five_hour_remaining,
            300,
        ),
        (
            "seven_day",
            "7d",
            rate_limits.seven_day_usage,
            &rate_limits.seven_day_remaining,
            10_080,
        ),
    ]
    .into_iter()
    .map(
        |(id, title, used_percent, remaining_label, window_minutes)| UsageRateWindow {
            id: id.to_string(),
            title: title.to_string(),
            used_percent,
            remaining_percent: Some((100.0 - used_percent).clamp(0.0, 100.0)),
            remaining_label: Some(remaining_label.clone()).filter(|text| !text.is_empty()),
            resets_at: None,
            window_minutes: Some(window_minutes),
        },
    )
    .collect()
}

pub(crate) fn usage_percentage(value: &serde_json::Value) -> Option<f64> {
    number_field(value, "used_percentage")
        .or_else(|| number_field(value, "usedPercentage"))
        .or_else(|| number_field(value, "utilization"))
}

pub(crate) fn used_percentage(value: &serde_json::Value) -> Option<f64> {
    usage_percentage(value)
        .or_else(|| number_field(value, "percent"))
        .or_else(|| number_field(value, "usagePercent"))
        .or_else(|| number_field(value, "used_percent"))
        .or_else(|| number_field(value, "usedPercent"))
}

pub(crate) fn window_minutes(value: &serde_json::Value) -> Option<i64> {
    value
        .get("window_minutes")
        .or_else(|| value.get("windowMinutes"))
        .or_else(|| value.get("windowDurationMins"))
        .and_then(number_from_value)
        .map(|value| value as i64)
        .or_else(|| {
            value
                .get("limit_window_seconds")
                .or_else(|| value.get("limitWindowSeconds"))
                .and_then(number_from_value)
                .map(|value| (value / 60.0).round() as i64)
        })
        .filter(|minutes| *minutes > 0)
}

pub(crate) fn positive_window_minutes(value: &serde_json::Value) -> Option<i64> {
    window_minutes(value).filter(|minutes| *minutes > 0)
}

pub(crate) fn reset_at_iso(value: &serde_json::Value) -> Option<String> {
    value
        .get("resets_at")
        .or_else(|| value.get("resetsAt"))
        .or_else(|| value.get("reset_at"))
        .or_else(|| value.get("resetAt"))
        .and_then(date_from_value)
        .map(|date| date.to_rfc3339())
}

pub(crate) fn number_field(value: &serde_json::Value, key: &str) -> Option<f64> {
    value.get(key).and_then(number_from_value)
}

pub(crate) fn number_from_value(value: &serde_json::Value) -> Option<f64> {
    value
        .as_f64()
        .or_else(|| value.as_str().and_then(|text| text.parse::<f64>().ok()))
}

pub(crate) fn remaining_label(value: &serde_json::Value) -> String {
    if let Some(text) = value
        .get("remaining")
        .or_else(|| value.get("remainingLabel"))
        .and_then(|value| value.as_str())
        .filter(|text| !text.trim().is_empty())
    {
        return text.to_string();
    }

    value
        .get("resets_at")
        .or_else(|| value.get("resetsAt"))
        .or_else(|| value.get("reset_at"))
        .or_else(|| value.get("resetAt"))
        .and_then(date_from_value)
        .and_then(|date| format_remaining_duration(date, chrono::Utc::now()))
        .unwrap_or_default()
}

pub(crate) fn date_from_value(value: &serde_json::Value) -> Option<chrono::DateTime<chrono::Utc>> {
    if let Some(seconds) = number_from_value(value) {
        return chrono::DateTime::<chrono::Utc>::from_timestamp(seconds as i64, 0);
    }

    let text = value.as_str()?.trim();
    if let Ok(seconds) = text.parse::<f64>() {
        return chrono::DateTime::<chrono::Utc>::from_timestamp(seconds as i64, 0);
    }

    chrono::DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|date| date.with_timezone(&chrono::Utc))
}

fn format_remaining_duration(
    reset_at: chrono::DateTime<chrono::Utc>,
    now: chrono::DateTime<chrono::Utc>,
) -> Option<String> {
    let seconds = reset_at.signed_duration_since(now).num_seconds();
    if seconds <= 0 {
        return None;
    }

    let total_minutes = seconds / 60;
    let days = total_minutes / 1_440;
    let hours = (total_minutes % 1_440) / 60;
    let minutes = total_minutes % 60;

    if days > 0 && hours > 0 {
        Some(format!("{days}d{hours}h"))
    } else if days > 0 {
        Some(format!("{days}d"))
    } else if hours > 0 && minutes > 0 {
        Some(format!("{hours}h{minutes}m"))
    } else if hours > 0 {
        Some(format!("{hours}h"))
    } else if minutes > 0 {
        Some(format!("{minutes}m"))
    } else {
        Some("<1m".to_string())
    }
}

pub(crate) fn usage_snapshot_within_age(
    snapshot: &UsageRateLimitSnapshot,
    max_age: chrono::Duration,
) -> bool {
    let Some(captured_at) = snapshot.captured_at else {
        return false;
    };
    let age = chrono::Utc::now().signed_duration_since(captured_at);
    age >= -chrono::Duration::minutes(5) && age <= max_age
}

pub(crate) fn expand_home_path(path: &str) -> Option<PathBuf> {
    if path == "~" {
        return dirs::home_dir();
    }
    if let Some(rest) = path.strip_prefix("~/") {
        return dirs::home_dir().map(|home| home.join(rest));
    }
    #[cfg(target_os = "windows")]
    if let Some(rest) = path.strip_prefix("~\\") {
        return dirs::home_dir().map(|home| home.join(rest));
    }
    Some(PathBuf::from(path))
}
