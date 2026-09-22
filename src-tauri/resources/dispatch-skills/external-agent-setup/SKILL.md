---
name: external-agent-setup
description: Set up a named Skill for an external CLI agent through an interactive, confirmation-based configuration flow. Use when the user wants to connect, install, adapt, or troubleshoot an external coding agent.
---

# External Agent Setup

Use this Skill as the user-facing entry point for external-agent integration.
The setup conversation must identify the CLI, desired Skill name, model route,
prompt/output transport, and whether the user authorizes local writes. Ask the
user to choose when more than one provider is detected.

## Required flow

1. Detect candidate CLIs and show only executable path, version, model route,
   and boolean credential-environment presence. Never print credential values.
2. Explain the proposed named Skill and show the files that would be created.
3. Ask for confirmation immediately before writing to the user's skills
   directory. Do not install a CLI, log in, edit global `AGENTS.md`, or write a
   provider secret automatically.
4. Apply the profile, run a syntax/configuration check and the CLI's declared
   no-model-call provider check, then report exact changed files and next steps.
   The provider check is diagnostic; it is not a quota gate for the first task.
5. Start a selected task directly. On Windows, use the host tool's trusted
   Windows user-process execution context for user-local CLI installations;
   this Skill cannot elevate itself or handle `runas` passwords. If the Runner
   returns a structured `recovery` plan, follow safe actions automatically:
   retry the provider check and the same packet once when it says
   `retry_in_trusted_windows_user_process`, and otherwise preserve progress and
   return the stated next steps. Never collapse an execution-context failure
   into only `not found`. If the task fails and quota exhaustion is plausible,
   run the declared no-model-call quota check after the failure. The check has a
   bounded timeout and returns `unknown` on timeout, network, authentication,
   or parsing failure; it never blocks the task result. Do not rerun the task
   merely to probe quota. If setup fails, use the error code and recovery hint
   from the script output.

## Adapter contract

For a new CLI, collect a non-secret provider profile. Common CLIs need only a
command, argv flags, one of `argv_end`, `stdin_text`, or `stdin_json`, and an
output parser. Use `profiles/provider.template.json` as the form. Declare
`credential_env` as names only; values stay in the user's existing auth
mechanism. A quota check is allowed only when the provider documents that the
command does not consume a model call.

The generated Skill owns the selected provider by name and loads the sibling
`external-agent-core` support package. This keeps direct `$<skill-name>`
invocation while avoiding a second CLI, MCP proxy, daemon, wrapper service, or
direct API call.

## Safety boundaries

Keep host-tool permissions, user approval, hook trust, provider data boundaries,
unsupported modality limits, and final parent-agent validation intact. Do not
send credentials, `.env` files, secrets, unrelated personal data, or paths
outside the selected workspace to an external provider.

Task execution remains separate from setup: use the generated named Skill only
after the user selects it. The runner has no hard runtime timeout; it supports
an optional status file and an explicit cancel file for long-running work.
