<div align="center">
  <img src="./assets/readme/vibe-board-hero.svg" alt="Vibe Board: one desktop workspace for AI coding agent sessions, approvals, traces, and usage" width="100%" />

  <p>
    <strong>Your desktop control console for AI coding agents</strong><br />
    See sessions clearly, handle approvals, and inspect trace time and real usage without chasing terminals.
  </p>

  <p>
    <a href="./README.md">中文</a> ·
    <a href="./UPSTREAM.md">Upstream &amp; license</a> ·
    <a href="./docs/privacy-policy.md">Privacy</a>
  </p>

  <p>
    <img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-111820" />
    <img alt="Platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-f5b84b" />
    <img alt="Stack" src="https://img.shields.io/badge/Tauri-React%20%2B%20Rust-0c6b63" />
  </p>
</div>

## What it is

Vibe Board is a local-first Tauri desktop app that brings events from Claude Code, Codex, Gemini CLI, OpenCode, Antigravity, and other coding agents into one floating workspace.

It helps with three everyday problems:

- Approvals, questions, and plan confirmations no longer require a trip back to the terminal.
- Multiple sessions stay distinguishable through the current task, trace duration, tool activity, and completion state.
- When token data is available it is shown directly; otherwise the UI shows provider quota and reset time without inventing a price estimate.

## See the real interface

<table>
  <tr>
    <td width="50%">
      <img src="./docs/assets/screenshots/island-expanded.png" alt="Vibe Board expanded session list with approval states" width="100%" />
      <sub>Expand the island to inspect sessions, tools, approvals, and plans.</sub>
    </td>
    <td width="50%">
      <img src="./docs/assets/screenshots/island-detail.png" alt="Vibe Board session details with trace information" width="100%" />
      <sub>Details keep trace, token, rate-limit, and raw-event context together.</sub>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <img src="./docs/assets/screenshots/island-permission.png" alt="Handling an agent permission request in Vibe Board" width="100%" />
      <sub>Approve, deny, answer, or confirm directly from the floating UI.</sub>
    </td>
    <td width="50%">
      <img src="./docs/assets/screenshots/agent-management-skill-library.png" alt="Vibe Board shared Skill library" width="100%" />
      <sub>Adopt Skills into a center library and distribute them to agents.</sub>
    </td>
  </tr>
</table>

## Start in 30 seconds

### Windows installer

1. Download the latest package from [GitHub Releases](https://github.com/hyNous/agent-island/releases), or use the checked-in [Vibe Board-latest-setup.exe](./releases/Vibe%20Board-latest-setup.exe).
2. Install and launch Vibe Board. The app stays in the system tray while the island appears when needed.
3. Open **Island → Integration** in Settings, run **Hook Doctor**, and install hooks for the agents you use.
4. Restart the relevant CLI session and wait for events to appear in the island.

The Windows installer is currently unsigned, so SmartScreen may ask for confirmation. Automatic updates are disabled for now; releases are downloaded manually from GitHub.

### Run from source

Requirements: Node.js 20+, pnpm, Rust/Cargo, and the Tauri CLI. Windows also needs Microsoft C++ Build Tools and WebView2; macOS needs Xcode Command Line Tools.

```bash
git clone https://github.com/hyNous/agent-island.git
cd agent-island
pnpm install
pnpm tauri:dev
```

For browser-only UI work:

```bash
pnpm dev
```

## What you can do

| Need | How Vibe Board handles it |
| --- | --- |
| Run several agents at once | Aggregate sessions, phases, tools, subagents, and completion reminders in the island. |
| Wait for permission or input | Approve, deny, answer, or confirm plans without returning to the terminal. |
| Know how long the current task ran | Show duration for the active agent trace instead of the lifetime of the surrounding session. |
| Read usage | Prefer real tokens; otherwise show provider quota, window, and reset time. |
| Manage agent installations | Scan CLIs, desktop apps, versions, paths, hooks, and configuration state. |
| Share Skills across agents | Import from an agent, local folder, or GitHub; adopt into the center library and distribute by symlink or copy. |

## How it works

Vibe Board does not put session content through a hosted relay. The basic path is:

```text
Agent hooks / local app state
          ↓
Local bridge → hook server → agent adapter
          ↓
SessionStore / trace / usage snapshot
          ↓
Island · Agent Monitor · Skills manager
```

Hooks are the primary real-time path. Supported agents such as Codex can add thread, approval, and quota data through a local app-server or state files. When an external agent is offline, Vibe Board keeps its last successfully read state and shows the source and update time.

## Support scope

Runtime hook adapters and agent-management discovery are separate layers; event depth depends on the interfaces each agent exposes.

| Capability | Current coverage |
| --- | --- |
| Island / hooks | Claude Code, Codex, Gemini CLI, Cursor, Copilot, Cline, Qoder, CodeBuddy, Qwen, Kimi, DeepSeek, OpenCode, Factory Droid, StepFun, Antigravity, WorkBuddy, Hermes, Pi, Kiro, ZCode |
| Management discovery | The agents above, plus Doubao, the shared `.agents` directory, Junie, Windsurf, Augment, KiloCode, OB1, Amp, Aider, OpenClaw / QClaw / EasyClaw / AutoClaw, and custom agents |

## Repository map

- `src/`: React island, Settings, agent/Skill management, and themes.
- `src-tauri/src/`: Rust hook server, bridge, adapters, trace/usage, and local storage.
- `src-tauri/icons/`, `public/agent-island-*`: current Vibe Board icons and presentation assets.
- `releases/`: current Windows acceptance installer; older packages live only under `releases/archive/`.
- `UPSTREAM.md`, `LICENSE`, `NOTICE`, `TRADEMARKS.md`: provenance, license, and branding boundaries.

## Local checks

```bash
pnpm lint
pnpm test:run
pnpm build
cargo check --manifest-path src-tauri/Cargo.toml
pnpm release:check
```

## Contributing and releases

Issues and pull requests are welcome. Read [CONTRIBUTING.md](./CONTRIBUTING.md) first, include verification results, and attach screenshots for UI changes.

Releases are manual through GitHub Releases for now. Until signing keys and a release endpoint are configured, the repository will not enable automatic updates or automated publishing workflows.

## License and provenance

Vibe Board code is released under the [Apache License 2.0](./LICENSE), while the upstream [NOTICE](./NOTICE) and branding boundary in [TRADEMARKS.md](./TRADEMARKS.md) remain in the repository.

This is an independent modification based on [AgentBro](./UPSTREAM.md): the product name, icons, and release configuration have been replaced, and this repository is not an official upstream distribution.
