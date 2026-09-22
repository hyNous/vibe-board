# Vibe Board — Claude Code project guidance

Read this file together with [`AGENTS.md`](../AGENTS.md) before editing.

## Project map

- `src/`: React 19 + TypeScript + Vite UI.
- `src/components/notch/`: floating island, session list, approvals, and chat.
- `src/components/settings/`: settings and Agent/Skill management.
- `src/stores/`: Zustand state stores.
- `src/services/tauriApi.ts`: frontend-to-Tauri IPC wrappers.
- `src-tauri/src/agents/`: Agent adapters and hook profiles.
- `src-tauri/src/hooks/`: local Hook server and recovery.
- `src-tauri/src/skills/v2/`: shared Skill library and GitHub sync.
- `src-tauri/tauri.conf.json`: packaging, permissions, and app identity.

## Development checks

```bash
pnpm lint
pnpm test:run
pnpm build
cargo check --manifest-path src-tauri/Cargo.toml
```

Use existing stores, IPC wrappers, and adapter/profile helpers before adding
new abstractions or dependencies. Keep translations in both locale files (`en`, `zh`); Vibe Board ships
Chinese and English only.

## Compatibility boundary

The runtime keeps Vibe Board state under `.vibeboard` and still recognizes the
retired `.agent-island` and `.agentbro` data directories, Hook markers, and
bridge commands so existing installations can migrate safely. Do not remove
those compatibility reads while changing the Vibe Board UI or release identity.

## Publishing boundary

Keep [LICENSE](../LICENSE), [NOTICE](../NOTICE), [TRADEMARKS.md](../TRADEMARKS.md),
and [UPSTREAM.md](../UPSTREAM.md) with any public distribution. Do not add
credentials, `.env` files, signing keys, or private diagnostic data.

Versioning, release steps, distribution channels and the current signing and
auto-update limits are defined in [RELEASING.md](../RELEASING.md); what the
project plans to do next is in [ROADMAP.md](../ROADMAP.md). Vibe Board does not
follow the upstream release line, and it ships no package-manager channel — do
not add an update path that points at an upstream cask, tap or repository.
