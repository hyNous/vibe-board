---
name: opencode-agent
description: Delegate autonomous repository development work to the local OpenCode CLI when the user selects OpenCode. Do not use for Antigravity, ordinary local implementation, or provider setup.
---

# OpenCode Agent

## Installation

Install this Skill together with the sibling `external-agent-core` support
package, or use `$external-agent-setup` to generate the named Skill. A
provider-only copy is intentionally not self-contained.

## Invocation

- Invoke when the user explicitly names OpenCode or calls `$opencode-agent`, or after the global external-agent routing has asked the user to choose and the user selects OpenCode.
- Do not select OpenCode implicitly before the user chooses between OpenCode and Antigravity unless a separate routing rule already selected OpenCode.
- Once OpenCode is selected, sending the current workspace/repository content needed for the task is already authorized; do not ask for a second chat confirmation before launching.
- The orchestrating agent keeps the user goal, high-level decomposition, final diff review, validation, integration, and final response.
- Do not make the orchestrating agent repeat repository exploration or implementation work that the worker can own.

## Failure-time quota diagnosis

- Start the selected OpenCode task directly. Do not require a quota preflight before the first attempt.
- `--check-provider` is a diagnostic for executable/provider wiring, not a launch gate. `opencode providers`/`auth`, `opencode models`, and `opencode stats` do not prove remaining OpenCode Go quota.
- If the real task launch or execution fails and quota exhaustion is plausible, run `--check-quota` after the failed attempt. This uses the official OpenCode Go usage endpoint with the existing OpenCode credential file and does not send a model task or use an environment API key.
- A timeout, network error, authentication error, malformed response, or missing credential is `unknown`. Do not rerun the unchanged task as a quota probe and do not silently switch to Antigravity.

## Automatic launch recovery

- The shared runner first uses the configured command and then tries later existing `command_candidates` only when startup fails before a provider process starts with a local path error such as `ENOENT`, `EINVAL`, `EACCES`, `EPERM`, `ENOTDIR`, `EISDIR`, or `ENOEXEC`.
- A successful fallback is reported as `launch-retry`. The runner never retries after the provider has started, emitted output, or returned a task/API error, so a task is not duplicated.
- If all safe local candidates fail, continue with the concrete diagnostics and the failure-time quota check. Do not install software, change credentials, edit PATH, or switch providers automatically.

## Orchestrated recovery

- On Windows, use the Runner's `recovery.action` as the control signal. For `retry_in_trusted_windows_user_process` during `task-launch`, run `--check-provider` and then retry the same packet once through the trusted Windows user-process tool mode; the first process did not start, so this cannot duplicate provider work.
- For `repair_provider_installation`, request authorization before installing or changing OpenCode. For `inspect_diff_then_decide`, inspect the actual diff, run the bounded quota check only when plausible, and continue only the remaining bounded work.
- Always return `recovery.phase`, `cause`, `action`, `error_code`, `automatic_actions`, and `next_steps` to the parent orchestrator. Never collapse the result to `not found`.

## Task sizing

- Give OpenCode one meaningful work package that it can explore, implement, and verify end to end, normally estimated at about 5–15 minutes. Use that estimate only to size the work; it is not a deadline or execution limit.
- Keep only work that cannot be delegated, such as planning or final integration, in the orchestrating agent.
- Do not split solely because a task is complex, reasoning-heavy, or touches many files. Split when it contains independent outcomes or subsystems, unrelated verification paths, or is too broad to finish reliably as one coherent pass.
- Split oversized work into two to four outcome-based packages. Do not prescribe files or implementation steps inside a package.
- After a stall, interruption, or provider failure, inspect the actual diff and progress, keep completed work, and delegate only the remaining bounded outcome. Never rerun the same oversized packet unchanged.

## Workflow

Write a temporary `.json` packet:

```json
{
  "goal": "<self-contained desired outcome>",
  "cwd": "<absolute workspace path>",
  "context_hint": {
    "summary": "<optional parent observation; advisory only>",
    "area": "<optional likely area>",
    "conventions": ["<optional repository convention>"]
  },
  "model": "<optional override>",
  "effort": "<optional override>"
}
```

- State the desired outcome and relevant user-observed problem. Include a required compatibility or product constraint only when it is part of the user's request.
- `context_hint` is optional navigation context, not an instruction. The worker must verify it and may ignore it.
- Do not turn the hint into a mandatory file list, provide an implementation recipe, construct an acceptance checklist, or prescribe validation commands.
- The worker reads repository instructions, explores the codebase, chooses the implementation, edits whatever is needed, and selects its own tests.
- Do not add `hard_timeout_minutes` or any other execution deadline to the packet.

Execute with the dedicated runner. It uses the shared `external-agent-core` runner and this Skill's provider profile:

```powershell
node <opencode-agent-skill>/scripts/run-opencode.mjs --packet <absolute-packet.json>
```

- Launch the task with `node <opencode-agent-skill>/scripts/run-opencode.mjs --packet <absolute-packet.json>`.
- If that task fails and quota exhaustion is plausible, run
  `node <opencode-agent-skill>/scripts/run-opencode.mjs --check-quota` after the
  failed attempt. The quota probe is bounded to 10 seconds; a missing or
  ambiguous check returns `unknown` and releases control.
- The profile supports `OPENCODE_BIN` and environment-variable-based command candidates; do not hardcode a user's executable path into a Skill.
- OpenCode is the only backend for this skill after launch. It never silently falls back or switches after a failed call.
- The global `codex-worker` uses `opencode-go/deepseek-v4-flash`.
- On Windows, launch this Runner through the tool's trusted Windows user-process execution context by default because the CLI normally lives under `%APPDATA%`. The Skill cannot elevate itself; use the tool-level permission flow, never `runas` passwords or credentials in packets.
- The script runs the provider command in `packet.cwd` and captures OpenCode's JSON transport events. The worker's final response is natural language, not a required JSON schema.
- The runner reports progress every minute and marks 15 minutes without provider events as stalled without terminating the task.
- The runner has no hard runtime timeout. A stalled report is informational and never terminates the task.
- For long work, the caller may pass `--status-file <absolute-path>` and can
  request explicit cancellation by creating the file passed to
  `--cancel-file <absolute-path>`; neither option is an automatic deadline.
- If checking, launch, execution, or output parsing fails, consume the Runner's `recovery` object. Apply safe `automatic_actions` first; return its phase, cause, error code, and `next_steps` to the parent orchestrator. Never reduce a permission, missing-installation, quota, or parse failure to only `not found`.

After execution:
- Run `git diff` / `git status` to inspect actual file changes.
- Select and run proportional final validation based on the actual diff.
- Judge the result against the user's outcome, not a parent-prescribed implementation.
- Trust actual files, diffs, commands, and exit codes over the worker's summary.

## Guardrails

- Change only what the task requires; avoid unrelated refactors, formatting, renames, or dependencies.
- Follow existing repository conventions and run relevant tests, builds, or linters when available.
- Never commit, push, rewrite Git history, overwrite local work, or delete tags or branches unless the task explicitly authorizes it.
- Never delete files outside the workspace or remove a path the worker did not create unless the task explicitly authorizes it.
- Do not make side-effectful network calls, deployments, or mutating API requests unless the task explicitly authorizes them.
- Do not run commands that consume paid API quota or tokens unless the task explicitly authorizes them.
- Do not intentionally send credentials, API keys, secret material, `.env` files, unrelated personal data, or paths outside the current workspace to OpenCode. Preserve provider data-boundary rules and any platform-enforced security prompt.
- Put scratch scripts, logs, and downloads in a temporary directory. Keep workspace changes Git-revertible.
- When the task explicitly authorizes an otherwise default-closed action, do exactly what was authorized, nothing wider, and report it.
- Do not use Devspace.

## Scheduling

- Give one coherent feature or bug fix to one worker end to end.
- For independent tasks, use up to three workers by default and four at most.
- Use separate worktrees for parallel writing workers; otherwise run them serially.
- Serialize work that shares lockfiles, database migrations, generated artifacts, or common configuration.
- More than four OpenCode workers requires explicit user approval.
