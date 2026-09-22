---
name: external-agent-core
description: Support runtime installed alongside a named external-agent Skill. Do not invoke directly; use external-agent-setup or a provider-specific Skill.
---

# External Agent Core

This is a support package, not a user-facing delegation route. Install it in
the same skills directory as a provider Skill so that the provider wrapper can
load `scripts/run-agent.mjs`.

Use `external-agent-setup` to create a named provider Skill. Do not put API
keys, tokens, passwords, `.env` contents, or secret values in `providers.json`.
