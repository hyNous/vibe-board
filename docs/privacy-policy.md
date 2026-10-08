# Privacy Policy

Last updated: October 8, 2026

Vibe Board is a local-first desktop utility for surfacing AI coding-agent
events in a floating island. Coding session data and local configuration stay
on your device — Vibe Board does not collect any usage statistics.

## Data collection

Vibe Board does not sell personal information or use advertising tracking.

Vibe Board does not collect or upload usage statistics. Prompts, responses,
code, diffs, terminal output, project paths, file paths, repository names,
usernames, hostnames, SSH targets, IP addresses, raw Hook payloads, diagnostic
contents, secrets, tokens, and API keys stay on your device and are never sent
to Vibe Board's maintainers.

## Local processing

To provide its core features, Vibe Board may process local session status,
approvals, questions, completion notifications, supported-tool configuration,
preferences, and integration state. This information is used to display state,
route notifications, install or remove integrations you request, and focus
related local windows.

## Diagnostics

Diagnostic exports are user-initiated and saved to a location you choose.
Review exported files before sharing them.

## Third-party services

GitHub is contacted only for release checks or GitHub-backed Skill
synchronization that you explicitly use.

Quota lookups that leave your machine are opt-in per provider and off by
default. Only after you authorize a provider on the Usage page does Vibe Board
query that provider's quota — either by calling the provider's usage endpoint
with the credential already stored locally for it, or by running the provider's
own local CLI and letting it contact the provider. The credential value is read
only for that request and never appears in logs, error messages, or the UI.
Revoking a provider's authorization stops further queries immediately. Local
sources (session-log history, locally written rate-limit files) need no
authorization and keep working.

For privacy questions, use the issue tracker for the repository that distributes
your Vibe Board build.
