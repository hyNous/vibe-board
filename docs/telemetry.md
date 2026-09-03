# Anonymous usage telemetry

Agent Island can send one anonymous daily usage snapshot to an operator-provided
Alibaba Cloud Simple Log Service (SLS) endpoint. Telemetry is disabled unless a
complete target is supplied at build time and the user has enabled analytics.

## Release configuration

Set these build environment variables together:

- `AGENT_ISLAND_TELEMETRY_SLS_HOST`
- `AGENT_ISLAND_TELEMETRY_SLS_PROJECT`
- `AGENT_ISLAND_TELEMETRY_SLS_LOGSTORE`

The payload uses the fixed topic `product-telemetry` and source
`agent-island`. It never includes prompts, responses, code, diffs, terminal
output, project paths, repository names, hostnames, raw Hook payloads, secrets,
tokens, API keys, or session identifiers. See [privacy-policy.md](privacy-policy.md)
for the user-facing policy.
