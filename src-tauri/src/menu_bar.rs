use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder};
use tauri::{Manager, Wry};

pub const TRAY_ID: &str = "vibeboard-tray";

pub struct MenuBarLabels {
    pub open: &'static str,
    pub settings: &'static str,
    pub quit: &'static str,
}

pub fn labels(language: &str) -> MenuBarLabels {
    match language {
        "zh" => MenuBarLabels {
            open: "打开 Vibe Board",
            settings: "设置",
            quit: "退出",
        },
        _ => MenuBarLabels {
            open: "Open Vibe Board",
            settings: "Settings",
            quit: "Quit",
        },
    }
}

pub fn build_tray_menu<M: Manager<Wry>>(manager: &M, language: &str) -> tauri::Result<Menu<Wry>> {
    let labels = labels(language);
    let show_item = MenuItemBuilder::with_id("show", labels.open).build(manager)?;
    let settings_item = MenuItemBuilder::with_id("settings", labels.settings).build(manager)?;
    let quit_item = MenuItemBuilder::with_id("quit", labels.quit).build(manager)?;

    MenuBuilder::new(manager)
        .item(&show_item)
        .item(&settings_item)
        .separator()
        .item(&quit_item)
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tray_labels_follow_the_selected_language() {
        assert_eq!(labels("zh").open, "打开 Vibe Board");
        assert_eq!(labels("en").settings, "Settings");
    }
}
