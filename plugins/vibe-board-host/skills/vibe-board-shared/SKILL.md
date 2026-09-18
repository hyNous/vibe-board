---
name: vibe-board-shared
description: Use Vibe Board as the canonical local Skill center when a Skill must be installed, updated, inspected, or shared across multiple coding Agents.
---

# Vibe Board shared Skills

Treat Vibe Board's Skill center as the source of truth for cross-Agent Skills.

- Keep one canonical copy in the center library instead of making unrelated per-Agent copies.
- Use the Vibe Board Skill manager to inspect provenance, capabilities, update time, and sync status.
- When a Skill is enabled for more than one Agent, update the center copy first and then apply the shared projection.
- Preserve the distinction between user-authored Skills and imported Skills (for example, a GitHub source).
- Do not copy credentials, `.env` files, or personal data into a Skill package.
