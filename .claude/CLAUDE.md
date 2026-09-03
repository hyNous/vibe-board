# Agent Island — Claude Code project guidance

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
new abstractions or dependencies. Keep translations in all five locale files.

## Compatibility boundary

The runtime still recognizes legacy `.agentbro` data directories, Hook markers,
and bridge commands so existing installations can migrate safely. Do not
remove those compatibility paths while changing the Agent Island UI or release
identity.

## Publishing boundary

Keep [LICENSE](../LICENSE), [NOTICE](../NOTICE), [TRADEMARKS.md](../TRADEMARKS.md),
and [UPSTREAM.md](../UPSTREAM.md) with any public distribution. Do not add
credentials, `.env` files, signing keys, or private diagnostic data.
