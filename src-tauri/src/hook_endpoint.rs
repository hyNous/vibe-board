pub const HOOK_SOCKET_ENV: &str = "VIBEBOARD_HOOK_SOCKET";
pub const HOOK_PORT_ENV: &str = "VIBEBOARD_HOOK_PORT";
const LEGACY_HOOK_SOCKET_ENV: &str = "AGENTBRO_HOOK_SOCKET";
const LEGACY_HOOK_PORT_ENV: &str = "AGENTBRO_HOOK_PORT";

const RELEASE_TCP_PORT: u16 = 17894;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HookEndpoint {
    pub socket_path: String,
    pub tcp_port: u16,
}

impl HookEndpoint {
    pub fn tcp_addr(&self) -> String {
        format!("127.0.0.1:{}", self.tcp_port)
    }
}

fn env_value(primary: &str, legacy: &str) -> Option<String> {
    std::env::var(primary)
        .ok()
        .or_else(|| std::env::var(legacy).ok())
        .filter(|value| !value.trim().is_empty())
}

pub fn current() -> HookEndpoint {
    HookEndpoint {
        socket_path: env_value(HOOK_SOCKET_ENV, LEGACY_HOOK_SOCKET_ENV)
            .unwrap_or_else(default_socket_path),
        tcp_port: env_value(HOOK_PORT_ENV, LEGACY_HOOK_PORT_ENV)
            .and_then(|value| value.parse::<u16>().ok())
            .filter(|port| *port != 0)
            .unwrap_or_else(default_tcp_port),
    }
}

pub fn default_socket_path() -> String {
    #[cfg(unix)]
    {
        format!("/tmp/vibeboard-{}.sock", current_uid())
    }
    #[cfg(not(unix))]
    {
        std::env::temp_dir()
            .join("vibeboard.sock")
            .display()
            .to_string()
    }
}

/// Legacy socket locations consulted by the bridge when the current socket is
/// not listening, so hooks installed under the old namespace keep working.
pub fn legacy_socket_paths() -> Vec<String> {
    #[cfg(unix)]
    {
        vec![
            format!("/tmp/agent-island-{}.sock", current_uid()),
            format!("/tmp/agentbro-{}.sock", current_uid()),
        ]
    }
    #[cfg(not(unix))]
    {
        let temp = std::env::temp_dir();
        vec![
            temp.join("agent-island.sock").display().to_string(),
            temp.join("agentbro.sock").display().to_string(),
        ]
    }
}

pub fn default_tcp_port() -> u16 {
    RELEASE_TCP_PORT
}

#[cfg(unix)]
fn current_uid() -> u32 {
    unsafe { libc::getuid() as u32 }
}
