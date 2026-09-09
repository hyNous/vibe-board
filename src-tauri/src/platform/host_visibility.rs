//! Host-window visibility tracking for the optional Codex-following mode.
//!
//! The overlay remains a desktop window; this small poller only mirrors the
//! minimized state of the Codex desktop window. It intentionally does not
//! inspect browser tabs or embed itself into Codex's WebView.

use crate::config::ConfigStore;
use std::time::Duration;
use tauri::{AppHandle, Manager};

const POLL_INTERVAL: Duration = Duration::from_millis(500);

/// Start the idempotent host visibility poller.
pub fn start(app: AppHandle, config_store: ConfigStore) {
    tauri::async_runtime::spawn(async move {
        let mut last_minimized: Option<bool> = None;
        loop {
            tokio::time::sleep(POLL_INTERVAL).await;
            let config = config_store.get();
            if config.host_visibility_mode != "follow" {
                if last_minimized.is_some() {
                    if let Some(window) = app.get_webview_window("notch") {
                        let _ = window.show();
                    }
                    last_minimized = None;
                }
                continue;
            }

            let Some(minimized) = codex_window_minimized() else {
                // No Codex window means there is no host state to mirror.
                // Keep the overlay visible so enabling the option never makes
                // Vibe Board disappear just because Codex is not running.
                continue;
            };
            if last_minimized == Some(minimized) {
                continue;
            }
            if let Some(window) = app.get_webview_window("notch") {
                if minimized {
                    let _ = window.hide();
                } else {
                    let _ = window.show();
                }
            }
            last_minimized = Some(minimized);
        }
    });
}

#[cfg(target_os = "windows")]
fn codex_window_minimized() -> Option<bool> {
    use std::collections::HashSet;
    use windows_sys::core::BOOL;
    use windows_sys::Win32::Foundation::{CloseHandle, HWND};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsIconic,
        IsWindowVisible,
    };

    type Hwnd = HWND;
    type Lparam = isize;
    const TRUE: BOOL = 1;

    struct WindowProbe {
        codex_pids: HashSet<u32>,
        found: bool,
        minimized: bool,
    }

    fn process_name(entry: &PROCESSENTRY32W) -> String {
        let len = entry
            .szExeFile
            .iter()
            .position(|ch| *ch == 0)
            .unwrap_or(entry.szExeFile.len());
        String::from_utf16_lossy(&entry.szExeFile[..len]).to_ascii_lowercase()
    }

    let mut codex_pids = HashSet::new();
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot != windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE {
            let mut entry = PROCESSENTRY32W::default();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            if Process32FirstW(snapshot, &mut entry) != 0 {
                loop {
                    let name = process_name(&entry);
                    if name == "codex.exe" || name == "codex" {
                        codex_pids.insert(entry.th32ProcessID);
                    }
                    if Process32NextW(snapshot, &mut entry) == 0 {
                        break;
                    }
                }
            }
            let _ = CloseHandle(snapshot);
        }
    }

    let mut probe = WindowProbe {
        codex_pids,
        found: false,
        minimized: false,
    };

    unsafe extern "system" fn visit(hwnd: Hwnd, lparam: Lparam) -> BOOL {
        let probe = &mut *(lparam as *mut WindowProbe);
        if IsWindowVisible(hwnd) == 0 {
            return TRUE;
        }
        let mut pid = 0;
        GetWindowThreadProcessId(hwnd, &mut pid);
        let title_len = GetWindowTextLengthW(hwnd);
        let mut title = vec![0u16; (title_len.max(0) + 1) as usize];
        if title_len > 0 {
            let _ = GetWindowTextW(hwnd, title.as_mut_ptr(), title.len() as i32);
        }
        let title = String::from_utf16_lossy(&title).trim().to_ascii_lowercase();
        // Match the desktop process first. The exact-title fallback covers
        // packaged builds whose executable name is not `codex.exe` without
        // accidentally treating a browser tab titled "Codex" as the host.
        if probe.codex_pids.contains(&pid) || title == "codex" {
            probe.found = true;
            probe.minimized |= IsIconic(hwnd) != 0;
        }
        TRUE
    }

    unsafe {
        let _ = EnumWindows(Some(visit), &mut probe as *mut WindowProbe as Lparam);
    }
    probe.found.then_some(probe.minimized)
}

#[cfg(not(target_os = "windows"))]
fn codex_window_minimized() -> Option<bool> {
    None
}
