# AGENTS.md

> Project guidance for AI coding agents (Codex / Cursor / Aider / GitHub Copilot / Gemini CLI / …).
> Claude Code users should also read [`.claude/CLAUDE.md`](.claude/CLAUDE.md) for deeper detail.

## What this is

**Vibe Board** is a cross-platform Tauri app (Rust backend + React 19 / TypeScript frontend) that surfaces events from AI coding agents (Claude Code, Codex, Gemini CLI, Cursor, Copilot, etc.) into a floating "Dynamic Island" overlay.

## Local commands

```bash
pnpm install                                              # one-time
pnpm dev                                                  # browser UI only at http://localhost:1423
pnpm tauri:dev                                            # full native app
pnpm lint                                                 # ESLint
pnpm test:run                                             # vitest (one-shot)
pnpm build                                                # tsc + vite build
cargo check --manifest-path src-tauri/Cargo.toml          # Rust quick check
cargo test  --manifest-path src-tauri/Cargo.toml          # Rust tests
cargo fmt   --manifest-path src-tauri/Cargo.toml          # Rust format
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

Before any PR, all of these must be green: `pnpm lint`, `pnpm test:run`, `pnpm build`, `cargo check`.

## Repository workflow

Keep changes on the local branch until they have been reviewed and verified.
Use the issue and pull-request rules of the repository that distributes your
Vibe Board build; this fork does not require submitting changes upstream.

## Where to make changes

| Goal | Files |
| --- | --- |
| Add a new Agent adapter | `src-tauri/src/agents/<name>.rs` + register in `src-tauri/src/agents/mod.rs` (`all_adapters()`, `impl_default_adapter!`) + add profile in `src-tauri/src/agents/profiles.rs`. Simplest reference: `kimi.rs`. |
| Add a Tauri IPC command | `#[tauri::command]` in `src-tauri/src/commands/`, register in `src-tauri/src/lib.rs` `invoke_handler`, wrap in `src/services/tauriApi.ts`, listen via `src/hooks/useTauri.ts` if event-driven |
| Add a frontend component | `src/components/{notch|settings|shared|overlay}/`, plain `.css` + BEM, theme via `var(--*)` CSS variables, state via existing Zustand stores in `src/stores/` |
| Add a translation | `src/i18n/locales/{en,zh,ja,ko,tr}.json` — **all five must be updated together** |
| Add a theme | `src/themes/` + README theme table + i18n names |

Detailed extension recipes: see [`.claude/CLAUDE.md`](.claude/CLAUDE.md) and [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Branching & commits

- Use the repository's default branch unless the distributor specifies another target.
- [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`.
- Do NOT bump version numbers in PRs. Versions are kept in sync by maintainers across four files (`package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `Cargo.lock`); `pnpm release:check` validates this.

## Do NOT touch

- Brand assets: `public/agent-island-*.{png,jpg}`, `src-tauri/icons/`
- Legal / trademark: `LICENSE`, `NOTICE`, `TRADEMARKS.md`
- Signing / release: `src-tauri/Entitlements.plist`, any `*.key`/`*.p12`/`*.pem`/`*.mobileprovision`
- Generated: `src-tauri/target/`, `dist/`, `output/`, `node_modules/`

**Never commit secrets** (`.env`, signing keys, API tokens). `.gitignore` covers the common patterns; double-check before staging.

If you redistribute this fork, keep its Vibe Board identity and follow [`UPSTREAM.md`](UPSTREAM.md), [`NOTICE`](NOTICE), and [`TRADEMARKS.md`](TRADEMARKS.md).

## Code style

- Default to **no comments**. Only write one when the WHY is non-obvious (hidden constraint, prior bug, surprising behavior). Don't explain WHAT.
- Don't add features, refactor, or introduce abstractions beyond what the task requires.
- Frontend: hooks > class components; no `any`; reuse Zustand stores in `src/stores/`.
- Rust: errors as `Result<T, String>` at the Tauri boundary; `unwrap()` only in tests.
- No new dependencies without discussing in the issue/PR first — extra Tauri crates inflate the binary noticeably.

## Platform support

macOS and Windows are supported. Keep platform-specific behavior behind the
existing `cfg` boundaries instead of duplicating cross-platform logic.
