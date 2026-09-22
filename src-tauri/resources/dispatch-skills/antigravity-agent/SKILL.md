---
name: antigravity-agent
description: Delegate autonomous repository development work to the local Google Antigravity CLI when the user selects Antigravity or a trivial task is routed there. Do not use for OpenCode, ordinary local implementation, or provider setup.
---

# Antigravity Agent

## Installation

Install this Skill together with the sibling `external-agent-core` support
package, or use `$external-agent-setup` to generate the named Skill. A
provider-only copy is intentionally not self-contained.

## Invocation

- Invoke when the user explicitly names Antigravity or calls `$antigravity-agent`, or after the global external-agent routing has selected Antigravity.
- Do not select Antigravity implicitly before the user chooses between Antigravity and OpenCode unless a separate routing rule already selected Antigravity.
- Once Antigravity is selected, sending the current workspace/repository content needed for the task is already authorized; do not ask for a second chat confirmation before launching.
- The orchestrating agent keeps the user goal, high-level decomposition, final diff review, validation, integration, and final response.
- Do not make the orchestrating agent repeat repository exploration or implementation work that Antigravity can own.

## Failure-time quota diagnosis

- Start the selected Antigravity task directly. Do not require a quota preflight before the first attempt.
- `--check-provider` is a diagnostic for CLI/login wiring, not a launch gate.
- If the real task launch or execution fails and quota exhaustion is plausible, run
  the standalone read-only `agy -p /usage` check (alias `/quota`) after the
  failed attempt. Do not combine it with task streaming. If it opens an
  interactive panel, hangs, or returns no clear quota state, classify it as
  `unknown`.
- Do not rerun the unchanged task as a quota probe and do not silently switch to
  OpenCode after a failed call.

## Automatic launch recovery

- The shared runner first uses the configured command and then tries later existing `command_candidates` only when startup fails before a provider process starts with a local path error such as `ENOENT`, `EINVAL`, `EACCES`, `EPERM`, `ENOTDIR`, `EISDIR`, or `ENOEXEC`.
- A successful fallback is reported as `launch-retry`. The runner never retries after the provider has started, emitted output, or returned a task/API error, so a task is not duplicated.
- If all safe local candidates fail, continue with the concrete diagnostics and the failure-time quota check. Do not install software, change credentials, edit PATH, or switch providers automatically.

## Orchestrated recovery

- On Windows, use the Runner's `recovery.action` as the control signal. For `retry_in_trusted_windows_user_process` during `task-launch`, run `--check-provider` and then retry the same packet once through the trusted Windows user-process tool mode; the first process did not start, so this cannot duplicate provider work.
- For `repair_provider_installation`, request authorization before installing or changing Antigravity. For `inspect_diff_then_decide`, inspect the actual diff, run the bounded quota check only when plausible, and continue only the remaining bounded work.
- Always return `recovery.phase`, `cause`, `action`, `error_code`, `automatic_actions`, and `next_steps` to the parent orchestrator. Never collapse the result to `not found`.

## Task sizing

- Give Antigravity one meaningful work package that it can explore, implement, and verify end to end, normally estimated at about 5–15 minutes. Use that estimate only to size the work; it is not a deadline or execution limit.
- Keep only planning, final integration, and work that cannot be delegated in the orchestrating agent.
- Do not split solely because a task is complex, reasoning-heavy, or touches many files. Split when it contains independent outcomes or subsystems, unrelated verification paths, or is too broad to finish reliably as one coherent pass.
- Split oversized work into two to four outcome-based packages. Do not prescribe files or implementation steps inside a package.
- After a stall, interruption, or provider failure, inspect the actual diff and response, keep completed work, and continue only the remaining bounded outcome. Reuse the returned `conversation_id` when available instead of restarting the full task.

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
  "model": "<optional Antigravity model>",
  "effort": "<optional low|medium|high>",
  "conversation": "<optional conversation_id for a bounded continuation>"
}
```

- State the desired outcome and relevant user-observed problem.
- `context_hint` is optional navigation context, not an instruction. The worker must verify it and may ignore it.
- Do not turn the hint into a mandatory file list, provide an implementation recipe, construct an acceptance checklist, or prescribe validation commands.
- Antigravity reads repository instructions, explores the codebase, chooses the implementation, edits what is needed, and selects its own checks.
- Omit `conversation` for a new task. Use it only to continue unfinished work from the same Antigravity run, with `goal` narrowed to the remaining outcome.

Execute with the dedicated runner. It uses the shared `external-agent-core` runner and this Skill's provider profile:

```powershell
node <antigravity-agent-skill>/scripts/run-antigravity.mjs --packet <absolute-packet.json>
```

- Launch the task with `node <antigravity-agent-skill>/scripts/run-antigravity.mjs --packet <absolute-packet.json>`.
- If that task fails and quota exhaustion is plausible, run
  `node <antigravity-agent-skill>/scripts/run-antigravity.mjs --check-quota` after
  the failed attempt. A missing or ambiguous check is `unknown`.
- The profile supports `AGY_BIN` and environment-variable-based command candidates; do not hardcode a user's executable path into a Skill.
- Authentication comes from the existing Antigravity CLI login. Never request or write credentials in the task packet.
- This skill never silently falls back or switches after a failed call.
- On Windows, launch this Runner through the tool's trusted Windows user-process execution context by default because the CLI normally lives under `%LOCALAPPDATA%`. The Skill cannot elevate itself; use the tool-level permission flow, never `runas` passwords or credentials in packets.
- Headless execution uses Antigravity's official `stream-json` input/output mode and `--dangerously-skip-permissions`, matching its unrestricted tool-using mode. It does not use `-p` or `--print-timeout`.
- The runner has no hard runtime timeout. The task-size estimate is informational only.
- For long work, the caller may pass `--status-file <absolute-path>` and can
  request explicit cancellation by creating the file passed to
  `--cancel-file <absolute-path>`; neither option is an automatic deadline.
- If launch, authentication, execution, or output parsing fails, consume the Runner's `recovery` object. Apply safe `automatic_actions` first; return its phase, cause, error code, and `next_steps` to the parent orchestrator. Never reduce a permission, missing-installation, quota, or parse failure to only `not found`.

After execution:
- Run `git diff` / `git status` to inspect actual file changes.
- Select and run proportional final validation based on the actual diff.
- Trust actual files, diffs, commands, and exit codes over Antigravity's report.

## Guardrails

- Change only what the task requires; avoid unrelated refactors, formatting, renames, or dependencies.
- Follow existing repository conventions and run relevant tests, builds, or linters when available.
- Never commit, push, rewrite Git history, overwrite local work, or delete tags or branches unless the task explicitly authorizes it.
- Never delete files outside the workspace or remove a path the worker did not create unless the task explicitly authorizes it.
- Do not make side-effectful network calls, deployments, or mutating API requests unless the task explicitly authorizes them.
- Do not run commands that consume paid API quota or tokens beyond the selected Antigravity task unless explicitly authorized.
- Do not intentionally send credentials, API keys, secret material, `.env` files, unrelated personal data, or paths outside the current workspace to Antigravity. Preserve provider data-boundary rules and any platform-enforced security prompt.
- Put scratch scripts, logs, and downloads in a temporary directory. Keep workspace changes Git-revertible.
- When the task explicitly authorizes an otherwise default-closed action, do exactly what was authorized, nothing wider, and report it.
- Do not use Devspace.

## Scheduling

- Give one coherent feature or bug fix to one worker end to end.
- For independent tasks, use up to three workers by default and four at most.
- Use separate worktrees for parallel writing workers; otherwise run them serially.
- Serialize work that shares lockfiles, database migrations, generated artifacts, or common configuration.
- More than four Antigravity workers requires explicit user approval.
