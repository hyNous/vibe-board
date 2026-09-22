# Privacy Policy

Last updated: September 22, 2026

Vibe Board is a local-first desktop utility for surfacing AI coding-agent
events in a floating island. Coding session data and local configuration stay
on your device unless you enable the optional telemetry build.

## Data collection

Vibe Board does not sell personal information or use advertising tracking.

Optional anonymous usage telemetry is disabled unless the build provides a
complete SLS target and analytics is enabled in the app. When active, it sends
at most one daily aggregate containing app version, operating system,
architecture, language bucket, display mode, install channel, launch count,
and coarse Hook install/uninstall totals. See [telemetry.md](telemetry.md).

Telemetry does not include prompts, responses, code, diffs, terminal output,
project paths, file paths, repository names, usernames, hostnames, SSH targets,
IP addresses, raw Hook payloads, diagnostic contents, secrets, tokens, or API
keys.

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

If you enable the optional telemetry build, the configured SLS endpoint stores
the anonymous usage events. GitHub is contacted only for release checks or
GitHub-backed Skill synchronization that you explicitly use.

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
