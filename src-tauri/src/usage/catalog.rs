// Catalog-only usage providers. They have no reader yet, but they implement
// the same pipeline and produce the same snapshot type, so the settings list
// and the Usage page never need provider-specific handling.

use super::normalize::expand_home_path;
use super::{
    build_snapshot, resolve_state, unknown_history, UsageAuthStatus, UsageCredential, UsageFetch,
    UsageProvider, UsageSnapshot,
};
use futures_util::future::BoxFuture;
use futures_util::FutureExt;

pub struct CatalogUsageProvider {
    id: &'static str,
    label: &'static str,
    /// Human-readable name used in the "known usage strategy" detail line.
    source_name: &'static str,
    /// Known usage strategy (for example `api/key`) shown as the source.
    strategy: Option<&'static str>,
    auth_path: Option<&'static str>,
    binary: Option<&'static str>,
    unsupported: bool,
    settings_order: Option<u32>,
}

impl UsageProvider for CatalogUsageProvider {
    fn id(&self) -> &'static str {
        self.id
    }

    fn label(&self) -> &'static str {
        self.label
    }

    fn catalog_supported(&self) -> bool {
        !self.unsupported
    }

    fn aliases(&self) -> &'static [&'static str] {
        match self.id {
            "gemini-cli" => &["gemini"],
            _ => &[],
        }
    }

    fn authorize_command(&self) -> Option<(&'static str, &'static [&'static str])> {
        match self.id {
            "gemini-cli" => Some(("gemini", &["auth"])),
            "copilot" => Some(("gh", &["auth", "login"])),
            "kiro" => Some(("kiro-cli", &["login"])),
            _ => None,
        }
    }

    fn settings_order(&self) -> Option<u32> {
        self.settings_order
    }

    fn read_credentials(&self) -> UsageCredential {
        UsageCredential {
            status: UsageAuthStatus::Unknown,
            path: self
                .auth_path
                .and_then(expand_home_path)
                .map(|path| path.display().to_string()),
            can_authorize: self
                .binary
                .is_some_and(|binary| crate::commands::find_binary(binary).is_some()),
        }
    }

    fn fetch_local<'a>(&'a self) -> BoxFuture<'a, UsageFetch> {
        async move {
            let detail = if self.unsupported {
                "No usage reader is available for this Agent yet.".to_string()
            } else {
                format!(
                    "{} has a known usage strategy; Vibe Board usage reader is not wired yet.",
                    self.source_name
                )
            };
            UsageFetch {
                source: self.strategy.map(str::to_string),
                history: unknown_history("No usage reader is wired for this Agent yet"),
                detail,
                ..UsageFetch::default()
            }
        }
        .boxed()
    }

    fn normalize(
        &self,
        enabled: bool,
        credentials: UsageCredential,
        fetched: UsageFetch,
    ) -> UsageSnapshot {
        let state = resolve_state(self, enabled, &credentials, &fetched);
        let detail = fetched.detail.clone();
        build_snapshot(self, enabled, &credentials, &fetched, state, detail)
    }
}

pub fn supported_providers() -> Vec<Box<dyn UsageProvider>> {
    [
        ("z-ai", "Z.ai", "Z.ai", "api/key", None, None, 2),
        (
            "kimi",
            "Kimi Code",
            "Kimi Code",
            "web/token",
            Some("~/.kimi-code"),
            None,
            3,
        ),
        (
            "gemini-cli",
            "Gemini CLI",
            "Gemini",
            "api/oauth",
            Some("~/.gemini"),
            Some("gemini"),
            4,
        ),
        (
            "copilot",
            "GitHub Copilot",
            "Copilot",
            "api/device-flow",
            None,
            Some("gh"),
            5,
        ),
        (
            "cursor",
            "Cursor",
            "Cursor",
            "web/cookies",
            Some("~/.cursor"),
            None,
            6,
        ),
        (
            "cursor-cli",
            "Cursor CLI",
            "Cursor",
            "web/cookies",
            Some("~/.cursor"),
            None,
            7,
        ),
        (
            "deepseek",
            "DeepSeek",
            "DeepSeek",
            "api/key",
            Some("~/.deepseek"),
            None,
            8,
        ),
        (
            "droid",
            "Factory / Droid",
            "Droid/Factory",
            "web/local-storage",
            Some("~/.factory"),
            None,
            10,
        ),
        ("stepfun", "StepFun", "StepFun", "web/token", None, None, 11),
        (
            "kiro",
            "Kiro",
            "Kiro",
            "cli",
            Some("~/.kiro"),
            Some("kiro-cli"),
            13,
        ),
    ]
    .into_iter()
    .map(
        |(id, label, source_name, strategy, auth_path, binary, settings_order)| {
            Box::new(CatalogUsageProvider {
                id,
                label,
                source_name,
                strategy: Some(strategy),
                auth_path,
                binary,
                unsupported: false,
                settings_order: Some(settings_order),
            }) as Box<dyn UsageProvider>
        },
    )
    .collect()
}

pub fn unsupported_providers() -> Vec<Box<dyn UsageProvider>> {
    [
        ("qoder", "Qoder"),
        ("qoder-cli", "Qoder CLI"),
        ("codebuddy", "CodeBuddy"),
        ("codebuddycn", "CodeBuddy CN"),
        ("qwen", "Qwen"),
        ("workbuddy", "WorkBuddy"),
        ("hermes", "Hermes"),
        ("pi", "Pi"),
        ("other", "Other"),
    ]
    .into_iter()
    .map(|(id, label)| {
        Box::new(CatalogUsageProvider {
            id,
            label,
            source_name: label,
            strategy: None,
            auth_path: None,
            binary: None,
            unsupported: true,
            settings_order: None,
        }) as Box<dyn UsageProvider>
    })
    .collect()
}
