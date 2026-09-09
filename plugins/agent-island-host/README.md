# Vibe Board Host Plugin

This is the host-side plugin package for Vibe Board. It connects the existing cross-Agent Skill center to a host Agent without changing the child-Agent readers.

The package contains both supported host manifests:

- Codex: `.codex-plugin/plugin.json` and the default `hooks/hooks.json`
- Claude Code: `.claude-plugin/plugin.json` and `hooks/claude-hooks.json`

## Behavior

On `SessionStart`, the plugin asynchronously runs the bundled Node launcher. The launcher invokes the Vibe Board bridge from `~/.agent-island/bin/`, which:

1. records the active host (`codex` or `claude-code`);
2. connects to the existing Vibe Board hook server; or
3. starts the last Vibe Board executable remembered by the desktop app when the server is not running.

The Usage page then marks that host as `宿主` / `Plugin Host`. OpenCode, Antigravity, and other child-Agent rows retain their existing readers, snapshots, and online state.
If both host manifests are enabled, the most recently started host session is the active `Plugin Host`.

## Install locally

Start Vibe Board once before installing the plugin. This deploys the bridge and writes the executable marker used for automatic startup.

For development, point each host at this directory:

```text
Codex: enable the local plugin directory and review/trust its hooks with /hooks.
Claude Code: claude --plugin-dir ./plugins/agent-island-host
```

The Codex manifest is validated against the current plugin schema. The bundled
`hooks/hooks.json` uses Codex's `${PLUGIN_ROOT}` path and is discovered by the
default plugin layout; review and trust it with `/hooks` before relying on
automatic SessionStart bridge startup. `hooks/codex-hooks.json` is retained as
an explicit-copy variant for hosts that require a named hook file. The Skill
guide itself is usable without hooks.

After enabling the plugin, start a new host session. If the host requires hook trust, approve the plugin hook definition first. If Vibe Board has never been started, the plugin exits quietly until the first manual app launch creates the bridge marker.

The plugin contains no credentials, API keys, or environment files.
