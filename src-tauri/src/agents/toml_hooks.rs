// Segment-aware TOML hook parser for `[[hooks]]` array-of-tables format.
//
// Parses a TOML file into Segment::Text and Segment::Hook fragments so we can
// safely merge AgentBro-managed hooks with user-defined hooks and surrounding
// configuration without losing anything. Strict text-only parser (no toml
// crate) — preserves formatting and comments outside of `[[hooks]]` blocks.

use super::profiles::{LEGACY_MARKER_PREFIX, MARKER_PREFIX};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TomlHookEntry {
    pub event: String,
    pub command: String,
    pub matcher: Option<String>,
    pub timeout: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Segment {
    Text(String),
    Hook(TomlHookEntry),
}

pub fn is_managed(entry: &TomlHookEntry) -> bool {
    entry.command.contains("agentbro-bridge") || entry.command.contains("agent-island-bridge")
}

fn is_legacy_vibe_island(entry: &TomlHookEntry) -> bool {
    entry.command.contains("vibe-island-bridge") || entry.command.contains(".vibe-island/bin/")
}

pub fn contains_managed(content: &str) -> bool {
    parse_segments(content).iter().any(|seg| match seg {
        Segment::Hook(entry) => is_managed(entry),
        _ => false,
    })
}

/// Returns (1-based line number, trigger text) of a `hooks` key declaration
/// that would conflict with the `[[hooks]]` array-of-tables form. TOML treats
/// `[hooks]` (table) / `hooks = ...` (scalar/inline-table) as mutually exclusive
/// with `[[hooks]]`, so installing managed hooks into a file containing either
/// will produce "Key already exists" at load time.
pub fn detect_conflicting_hooks_key(content: &str) -> Option<(usize, String)> {
    for (idx, raw_line) in content.split('\n').enumerate() {
        let line = raw_line.trim_start_matches('\u{feff}').trim();
        // `[hooks]` exact table header, or `[hooks.something]` dotted subtable.
        if line.starts_with("[hooks]") {
            return Some((idx + 1, "[hooks]".to_string()));
        }
        if line.starts_with("[hooks.") {
            return Some((idx + 1, "[hooks.".to_string()));
        }
        // `hooks = ...` scalar or inline table (must not be inside a string).
        // We don't fully parse TOML here — these patterns are unambiguous at
        // top level since `[[hooks]]` always appears on its own line.
        if let Some(rest) = line.strip_prefix("hooks") {
            let rest = rest.trim_start();
            if rest.starts_with('=') {
                return Some((idx + 1, "hooks =".to_string()));
            }
        }
    }
    None
}

pub fn parse_segments(content: &str) -> Vec<Segment> {
    let mut segments: Vec<Segment> = Vec::new();
    let mut text_buffer: Vec<String> = Vec::new();
    let mut current_hook: Vec<(String, String)> = Vec::new();
    let mut in_hook = false;

    let flush_text = |buf: &mut Vec<String>, out: &mut Vec<Segment>| {
        if !buf.is_empty() {
            out.push(Segment::Text(buf.join("\n")));
            buf.clear();
        }
    };

    let flush_hook = |fields: &mut Vec<(String, String)>, out: &mut Vec<Segment>| {
        if let Some(entry) = make_entry(fields) {
            out.push(Segment::Hook(entry));
        }
        fields.clear();
    };

    for raw_line in content.split('\n') {
        // Tolerate CRLF: strip a trailing \r for parsing decisions while keeping
        // original line in text segments (rebuilt files re-emit with LF only).
        let line_for_parse = raw_line.strip_suffix('\r').unwrap_or(raw_line);
        let trimmed = line_for_parse.trim();

        if trimmed == "[[hooks]]" {
            if in_hook {
                flush_hook(&mut current_hook, &mut segments);
            }
            flush_text(&mut text_buffer, &mut segments);
            in_hook = true;
            current_hook.clear();
            continue;
        }

        // A new table header inside a hook block ends the hook.
        if in_hook && trimmed.starts_with('[') && !trimmed.starts_with("[[") {
            flush_hook(&mut current_hook, &mut segments);
            in_hook = false;
            text_buffer.push(raw_line.to_string());
            continue;
        }
        if in_hook && trimmed.starts_with("[[") && trimmed != "[[hooks]]" {
            flush_hook(&mut current_hook, &mut segments);
            in_hook = false;
            text_buffer.push(raw_line.to_string());
            continue;
        }

        if in_hook {
            if let Some((key, value)) = parse_key_value(line_for_parse) {
                current_hook.push((key, value));
            }
            // blank / unrecognized lines inside a hook block are ignored
        } else {
            text_buffer.push(raw_line.to_string());
        }
    }

    if in_hook {
        flush_hook(&mut current_hook, &mut segments);
    }
    flush_text(&mut text_buffer, &mut segments);

    segments
}

/// Rebuild TOML content. Drops AgentBro-managed `[[hooks]]` entries, known
/// legacy managed entries, and orphan marker comments from the input, then
/// appends the supplied managed hooks under a single marker comment.
pub fn rebuild(segments: &[Segment], managed: &[TomlHookEntry], marker: &str) -> String {
    let mut output = String::new();

    let append_text = |output: &mut String, text: &str| {
        if !output.is_empty() && !output.ends_with('\n') {
            output.push('\n');
        }
        output.push_str(text);
    };

    for segment in segments {
        match segment {
            Segment::Text(text) => {
                let cleaned = strip_marker_lines(text);
                if cleaned.is_empty() {
                    continue;
                }
                append_text(&mut output, &cleaned);
            }
            Segment::Hook(entry) => {
                if is_managed(entry) || is_legacy_vibe_island(entry) {
                    continue;
                }
                if !output.is_empty() && !output.ends_with('\n') {
                    output.push('\n');
                }
                if !output.is_empty() && !output.ends_with("\n\n") {
                    output.push('\n');
                }
                output.push_str(&render_hook(entry));
            }
        }
    }

    if !managed.is_empty() {
        if !output.is_empty() {
            if !output.ends_with('\n') {
                output.push('\n');
            }
            if !output.ends_with("\n\n") {
                output.push('\n');
            }
        }
        output.push_str(&format!("# {}\n", marker));
        for entry in managed {
            output.push_str(&render_hook(entry));
        }
    }

    // Normalize: single trailing newline.
    while output.ends_with("\n\n") {
        output.pop();
    }
    if !output.is_empty() && !output.ends_with('\n') {
        output.push('\n');
    }
    output
}

pub fn render_hook(entry: &TomlHookEntry) -> String {
    let mut lines = vec!["[[hooks]]".to_string()];
    lines.push(format!("event = \"{}\"", escape_toml_string(&entry.event)));
    if let Some(matcher) = &entry.matcher {
        lines.push(format!("matcher = \"{}\"", escape_toml_string(matcher)));
    }
    lines.push(format!(
        "command = \"{}\"",
        escape_toml_string(&entry.command)
    ));
    if let Some(timeout) = entry.timeout {
        lines.push(format!("timeout = {}", timeout));
    }
    let mut out = lines.join("\n");
    out.push('\n');
    out
}

fn escape_toml_string(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn make_entry(fields: &[(String, String)]) -> Option<TomlHookEntry> {
    let mut event: Option<String> = None;
    let mut command: Option<String> = None;
    let mut matcher: Option<String> = None;
    let mut timeout: Option<u64> = None;
    for (key, value) in fields {
        match key.as_str() {
            "event" => event = Some(value.clone()),
            "command" => command = Some(value.clone()),
            "matcher" => matcher = Some(value.clone()),
            "timeout" => timeout = value.parse::<u64>().ok(),
            _ => {}
        }
    }
    let event = event?;
    let command = command.unwrap_or_default();
    Some(TomlHookEntry {
        event,
        command,
        matcher,
        timeout,
    })
}

fn parse_key_value(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim();
    let eq_idx = trimmed.find('=')?;
    let key = trimmed[..eq_idx].trim().to_string();
    if key.is_empty() {
        return None;
    }
    let raw_value = trimmed[eq_idx + 1..].trim();
    let without_comment = strip_inline_comment(raw_value);
    let value = strip_toml_quotes(without_comment.trim());
    Some((key, value.to_string()))
}

fn strip_inline_comment(value: &str) -> &str {
    let bytes = value.as_bytes();
    let mut in_string = false;
    let mut string_char: u8 = 0;
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if in_string {
            if c == string_char {
                in_string = false;
            }
        } else if c == b'"' || c == b'\'' {
            in_string = true;
            string_char = c;
        } else if c == b'#' {
            return &value[..i];
        }
        i += 1;
    }
    value
}

fn strip_toml_quotes(value: &str) -> &str {
    if value.len() >= 2
        && ((value.starts_with('"') && value.ends_with('"'))
            || (value.starts_with('\'') && value.ends_with('\'')))
    {
        &value[1..value.len() - 1]
    } else {
        value
    }
}

fn strip_marker_lines(text: &str) -> String {
    let mut result_lines: Vec<&str> = Vec::new();
    let mut prev_was_marker = false;
    for line in text.split('\n') {
        let trimmed = line.trim();
        let is_marker = trimmed.starts_with('#') && {
            let text = trimmed.trim_start_matches('#').trim_start();
            text.starts_with(MARKER_PREFIX)
                || text.starts_with(LEGACY_MARKER_PREFIX)
                || text.starts_with("--- vibe-island Kimi hooks START")
                || text.starts_with("--- vibe-island Kimi hooks END")
                || text.starts_with("--- vibe-island Kimi hooks removed")
        };
        if is_marker {
            prev_was_marker = true;
            continue;
        }
        if prev_was_marker && trimmed.is_empty() {
            // Drop the single blank line that typically follows the marker
            // to avoid blank-line accumulation across reinstalls.
            prev_was_marker = false;
            continue;
        }
        prev_was_marker = false;
        result_lines.push(line);
    }
    let joined = result_lines.join("\n");
    // Trim only trailing blank-only lines, but keep at most one trailing newline.
    let trimmed_end = joined.trim_end_matches('\n');
    trimmed_end.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn managed_command() -> String {
        "/usr/bin/env /home/me/.agentbro/bin/agentbro-bridge --source kimi".to_string()
    }

    #[test]
    fn parse_extracts_hooks_and_text() {
        let toml = r#"default_model = "kimi-for-coding"
theme = "dark"

[[hooks]]
event = "SessionStart"
command = "/Users/test/.agentbro/bin/agentbro-bridge --source kimi"
matcher = ""
timeout = 30

[[hooks]]
event = "PreToolUse"
command = "/usr/local/bin/safety-check.sh"
matcher = "Shell"
timeout = 10
"#;
        let segments = parse_segments(toml);
        assert_eq!(segments.len(), 3);

        match &segments[0] {
            Segment::Text(t) => assert!(t.contains("default_model")),
            _ => panic!("expected text segment"),
        }
        match &segments[1] {
            Segment::Hook(entry) => {
                assert_eq!(entry.event, "SessionStart");
                assert!(entry.command.contains("agentbro-bridge"));
                assert!(is_managed(entry));
                assert_eq!(entry.timeout, Some(30));
            }
            _ => panic!("expected hook segment"),
        }
        match &segments[2] {
            Segment::Hook(entry) => {
                assert_eq!(entry.event, "PreToolUse");
                assert_eq!(entry.command, "/usr/local/bin/safety-check.sh");
                assert!(!is_managed(entry));
                assert_eq!(entry.matcher.as_deref(), Some("Shell"));
            }
            _ => panic!("expected hook segment"),
        }
    }

    #[test]
    fn parse_handles_empty_file() {
        let segments = parse_segments("");
        // Empty input → at most one (empty) text segment.
        assert!(segments.len() <= 1);
        if let Some(Segment::Text(t)) = segments.first() {
            assert!(t.is_empty());
        }
    }

    #[test]
    fn parse_handles_file_with_only_marker_no_hooks() {
        let toml = "# AgentBro managed integration: kimi\n";
        let segments = parse_segments(toml);
        // Whole content is a single text segment containing the marker.
        assert_eq!(segments.len(), 1);
        match &segments[0] {
            Segment::Text(t) => assert!(t.contains(MARKER_PREFIX)),
            _ => panic!("expected text"),
        }
    }

    #[test]
    fn parse_strips_inline_comments() {
        let toml = r#"[[hooks]]
event = "SessionStart" # start hook
command = "/Users/test/.agentbro/bin/agentbro-bridge"
timeout = 30 # seconds
"#;
        let segments = parse_segments(toml);
        let hook = segments
            .iter()
            .find_map(|s| match s {
                Segment::Hook(e) => Some(e),
                _ => None,
            })
            .expect("hook segment");
        assert_eq!(hook.event, "SessionStart");
        assert_eq!(hook.command, "/Users/test/.agentbro/bin/agentbro-bridge");
        assert_eq!(hook.timeout, Some(30));
    }

    #[test]
    fn parse_handles_crlf_line_endings() {
        let toml = "default_model = \"x\"\r\n\r\n[[hooks]]\r\nevent = \"Stop\"\r\ncommand = \"/bin/true\"\r\n";
        let segments = parse_segments(toml);
        let hook = segments
            .iter()
            .find_map(|s| match s {
                Segment::Hook(e) => Some(e),
                _ => None,
            })
            .expect("hook segment");
        assert_eq!(hook.event, "Stop");
        assert_eq!(hook.command, "/bin/true");
    }

    #[test]
    fn rebuild_preserves_user_defined_hooks() {
        let toml = r#"[[hooks]]
event = "Stop"
command = "/usr/local/bin/my-hook.sh"
matcher = ""
"#;
        let segments = parse_segments(toml);
        let new_managed = vec![TomlHookEntry {
            event: "SessionStart".to_string(),
            command: managed_command(),
            matcher: None,
            timeout: None,
        }];
        let out = rebuild(
            &segments,
            &new_managed,
            "AgentBro managed integration: kimi",
        );
        assert!(out.contains("my-hook.sh"));
        assert!(out.contains("agentbro-bridge"));
        assert!(out.contains("# AgentBro managed integration: kimi"));
    }

    #[test]
    fn rebuild_preserves_other_tables() {
        let toml = r#"# header
default_model = "x"

[providers.kimi]
base_url = "https://api.kimi.com"

[[hooks]]
event = "Stop"
command = "/usr/bin/agentbro-bridge --source kimi"
"#;
        let segments = parse_segments(toml);
        let new_managed = vec![TomlHookEntry {
            event: "Stop".to_string(),
            command: managed_command(),
            matcher: None,
            timeout: None,
        }];
        let out = rebuild(
            &segments,
            &new_managed,
            "AgentBro managed integration: kimi",
        );
        assert!(out.contains("[providers.kimi]"));
        assert!(out.contains("base_url"));
        assert!(out.contains("default_model"));
        assert!(out.contains("agentbro-bridge --source kimi"));
        // Only one managed Stop hook should remain.
        let stop_count = out.matches("event = \"Stop\"").count();
        assert_eq!(stop_count, 1);
    }

    #[test]
    fn rebuild_replaces_managed_on_reinstall() {
        // Simulate a previous install that left managed hooks + a marker comment.
        let toml = r#"# AgentBro managed integration: kimi
[[hooks]]
event = "SessionStart"
command = "/old/path/agentbro-bridge --source kimi"
timeout = 30
"#;
        let segments = parse_segments(toml);
        let new_managed = vec![TomlHookEntry {
            event: "SessionStart".to_string(),
            command: "/new/path/agentbro-bridge --source kimi".to_string(),
            matcher: None,
            timeout: Some(86_400),
        }];
        let out = rebuild(
            &segments,
            &new_managed,
            "AgentBro managed integration: kimi",
        );
        assert_eq!(out.matches("event = \"SessionStart\"").count(), 1);
        assert!(out.contains("/new/path/agentbro-bridge"));
        assert!(!out.contains("/old/path/agentbro-bridge"));
        assert!(out.contains("timeout = 86400"));
        // Marker appears once.
        assert_eq!(
            out.matches("# AgentBro managed integration: kimi").count(),
            1
        );
    }

    #[test]
    fn rebuild_strips_orphan_marker_comments() {
        // Three orphan markers (e.g. from buggy previous installs) → rebuild
        // produces a single one alongside the new managed hooks.
        let toml = r#"default_model = "x"
# AgentBro managed integration: kimi
# AgentBro managed integration: kimi
# AgentBro managed integration: kimi
"#;
        let segments = parse_segments(toml);
        let new_managed = vec![TomlHookEntry {
            event: "Stop".to_string(),
            command: managed_command(),
            matcher: None,
            timeout: None,
        }];
        let out = rebuild(
            &segments,
            &new_managed,
            "AgentBro managed integration: kimi",
        );
        assert_eq!(
            out.matches("# AgentBro managed integration: kimi").count(),
            1
        );
        assert!(out.contains("default_model"));
    }

    #[test]
    fn rebuild_with_no_managed_strips_markers() {
        let toml = "default_model = \"x\"\n# AgentBro managed integration: kimi\n";
        let segments = parse_segments(toml);
        let out = rebuild(&segments, &[], "AgentBro managed integration: kimi");
        assert!(out.contains("default_model"));
        assert!(!out.contains("AgentBro managed integration"));
    }

    #[test]
    fn rebuild_with_no_managed_strips_legacy_vibe_island_hooks() {
        let toml = r#"default_model = "x"

# --- vibe-island Kimi hooks START (managed, do not edit) ---
[[hooks]]
event = "UserPromptSubmit"
command = "/Users/me/.vibe-island/bin/vibe-island-bridge --source kimi"
timeout = 30

[[hooks]]
event = "Stop"
command = "/Users/me/.vibe-island/bin/vibe-island-bridge --source kimi"
timeout = 30
# --- vibe-island Kimi hooks END ---

[[hooks]]
event = "PostToolUse"
command = "/usr/local/bin/user-hook.sh"
matcher = "Shell"
"#;
        let segments = parse_segments(toml);
        let out = rebuild(&segments, &[], "AgentBro managed integration: kimi");
        assert!(out.contains("default_model"));
        assert!(out.contains("/usr/local/bin/user-hook.sh"));
        assert!(!out.contains("vibe-island"));
        assert!(!out.contains(".vibe-island"));
        assert!(!out.contains("vibe-island-bridge"));
    }

    #[test]
    fn rebuild_on_reinstall_strips_legacy_vibe_island_and_appends_agentbro_once() {
        let toml = r#"# --- vibe-island Kimi hooks START (managed, do not edit) ---
[[hooks]]
event = "UserPromptSubmit"
command = "/Users/me/.vibe-island/bin/vibe-island-bridge --source kimi"
timeout = 30
# --- vibe-island Kimi hooks END ---

# AgentBro managed integration: kimi
[[hooks]]
event = "Stop"
command = "/old/path/agentbro-bridge --source kimi"

[[hooks]]
event = "PostToolUse"
command = "/usr/local/bin/user-hook.sh"
"#;
        let segments = parse_segments(toml);
        let new_managed = vec![
            TomlHookEntry {
                event: "UserPromptSubmit".to_string(),
                command: "/new/path/agentbro-bridge --source kimi".to_string(),
                matcher: None,
                timeout: None,
            },
            TomlHookEntry {
                event: "Stop".to_string(),
                command: "/new/path/agentbro-bridge --source kimi".to_string(),
                matcher: None,
                timeout: None,
            },
        ];
        let out = rebuild(
            &segments,
            &new_managed,
            "AgentBro managed integration: kimi",
        );
        assert!(out.contains("/usr/local/bin/user-hook.sh"));
        assert!(out.contains("/new/path/agentbro-bridge"));
        assert!(!out.contains("/old/path/agentbro-bridge"));
        assert!(!out.contains("vibe-island-bridge"));
        assert_eq!(
            out.matches("# AgentBro managed integration: kimi").count(),
            1
        );
        assert_eq!(out.matches("event = \"UserPromptSubmit\"").count(), 1);
        assert_eq!(out.matches("event = \"Stop\"").count(), 1);
    }

    #[test]
    fn detect_conflict_table_form() {
        let toml = "default_model = \"x\"\n[hooks]\nfoo = \"bar\"\n";
        let result = detect_conflicting_hooks_key(toml);
        assert_eq!(result, Some((2, "[hooks]".to_string())));
    }

    #[test]
    fn detect_conflict_table_dotted_form() {
        let toml = "[hooks.SessionStart]\ncommand = \"x\"\n";
        let result = detect_conflicting_hooks_key(toml);
        assert_eq!(result, Some((1, "[hooks.".to_string())));
    }

    #[test]
    fn detect_conflict_scalar_form() {
        let toml = "hooks = { SessionStart = \"x\" }\n";
        let result = detect_conflicting_hooks_key(toml);
        assert_eq!(result, Some((1, "hooks =".to_string())));
    }

    #[test]
    fn detect_conflict_returns_none_for_array_of_tables() {
        let toml = "[[hooks]]\nevent = \"Stop\"\ncommand = \"/bin/true\"\n";
        assert_eq!(detect_conflicting_hooks_key(toml), None);
    }

    #[test]
    fn detect_conflict_ignores_substring_keys() {
        let toml = "hooks_enabled = true\nhook_config = \"x\"\n";
        assert_eq!(detect_conflicting_hooks_key(toml), None);
    }

    #[test]
    fn contains_managed_detects_agentbro_bridge() {
        let toml = r#"[[hooks]]
event = "Stop"
command = "/path/to/agentbro-bridge --source kimi"
"#;
        assert!(contains_managed(toml));
    }

    #[test]
    fn contains_managed_returns_false_for_user_hooks() {
        let toml = r#"[[hooks]]
event = "Stop"
command = "/usr/bin/my-script.sh"
"#;
        assert!(!contains_managed(toml));
    }

    #[test]
    fn render_hook_emits_all_fields() {
        let entry = TomlHookEntry {
            event: "PreToolUse".to_string(),
            command: "/x/agentbro-bridge".to_string(),
            matcher: Some("*".to_string()),
            timeout: Some(86_400),
        };
        let out = render_hook(&entry);
        assert!(out.contains("[[hooks]]"));
        assert!(out.contains("event = \"PreToolUse\""));
        assert!(out.contains("matcher = \"*\""));
        assert!(out.contains("command = \"/x/agentbro-bridge\""));
        assert!(out.contains("timeout = 86400"));
        assert!(out.ends_with('\n'));
    }

    #[test]
    fn render_hook_escapes_quotes_in_command() {
        let entry = TomlHookEntry {
            event: "Stop".to_string(),
            command: "/usr/bin/env \"agentbro-bridge\"".to_string(),
            matcher: None,
            timeout: None,
        };
        let out = render_hook(&entry);
        assert!(out.contains(r#"command = "/usr/bin/env \"agentbro-bridge\"""#));
    }
}
