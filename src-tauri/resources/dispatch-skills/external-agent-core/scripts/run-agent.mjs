#!/usr/bin/env node

/**
 * Shared external-agent runner.
 *
 * Provider profiles describe CLI-specific transport and flags. The task
 * contract, advisory context, progress reporting, and normalized result stay
 * provider-neutral so a new CLI can usually be added without copying a runner.
 */

import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const STREAM_DIAGNOSTIC_BYTES = 1 * 1024 * 1024;
const isWindows = process.platform === 'win32';
const PROGRESS_INTERVAL_MS = 60_000;

/**
 * Entry-point test that survives symlinked or junctioned skill directories.
 *
 * `process.argv[1]` keeps the path as it was typed on the command line, while
 * `import.meta.url` is already resolved to the real file. Comparing them
 * directly makes a runner reached through a link silently do nothing, so both
 * sides are resolved to their real path before comparison.
 */
function isEntrypoint(importMetaUrl) {
  if (!process.argv[1]) {
    return false;
  }
  const modulePath = fileURLToPath(importMetaUrl);
  const toReal = value => {
    try {
      return realpathSync(value);
    } catch {
      return resolve(value);
    }
  };
  const argvReal = toReal(process.argv[1]);
  const moduleReal = toReal(modulePath);
  if (argvReal === moduleReal) {
    return true;
  }
  return isWindows && argvReal.toLowerCase() === moduleReal.toLowerCase();
}
const STALL_AFTER_MS = 900_000;
const CONTEXT_HINT_MAX_CHARS = 6_000;
const DEFAULT_QUOTA_TIMEOUT_MS = 10_000;
const MAX_QUOTA_TIMEOUT_MS = 30_000;
const LAUNCH_RETRY_CODES = new Set(['ENOENT', 'EINVAL', 'EACCES', 'EPERM', 'ENOTDIR', 'EISDIR', 'ENOEXEC']);
const VALID_STATUSES = new Set(['success', 'blocked', 'failed']);
const VALID_TRANSPORTS = new Set(['argv_end', 'stdin_text', 'stdin_json', 'stdin_none', 'legacy_stream_json']);
const VALID_PARSERS = new Set(['opencode-jsonl', 'result-event', 'generic-jsonl', 'text']);
const VALID_QUOTA_CHECK_KINDS = new Set(['command', 'http_json']);
const SAFE_ENV_NAMES = new Set([
  'PATH', 'Path', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'SystemRoot',
  'TEMP', 'TMP', 'ComSpec', 'HOME', 'LANG', 'LC_ALL', 'TERM',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
]);

function redactSensitive(value) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]');
  text = text.replace(/((?:api[_-]?key|token|secret|password|authorization|credential)[\w-]*\s*[:=]\s*)([^\s,;]+)/gi, '$1[REDACTED]');
  text = text.replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,})\b/g, '[REDACTED]');
  return text;
}

function isAbs(value) {
  return /^[a-zA-Z]:[\\/]/.test(value) || /^[\\/]{2}/.test(value) || /^\//.test(value);
}

function isDirectory(value) {
  try {
    return existsSync(value) && statSync(value).isDirectory();
  } catch {
    return false;
  }
}

function compact(value, limit = 500) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, limit) : null;
}

function fail(reason, exitCode = 1) {
  process.stdout.write(JSON.stringify({
    status: 'failed',
    backend: null,
    provider: null,
    model: null,
    effort: null,
    session_id: null,
    changed_files: [],
    validation: null,
    summary: `Configuration/parse error: ${reason}`,
    response: null,
    risks: ['execution aborted before provider launch'],
    diagnostics: null,
    exit_code: exitCode,
  }));
  process.exit(exitCode);
}

function expandEnv(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => process.env[name] || '')
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_, name) => process.env[name] || '');
}

function quotaTimeoutMs(check = {}) {
  const value = Number.isInteger(check.timeout_ms) ? check.timeout_ms : DEFAULT_QUOTA_TIMEOUT_MS;
  return Math.min(Math.max(value, 1_000), MAX_QUOTA_TIMEOUT_MS);
}

function credentialValue(entry) {
  if (typeof entry === 'string' && entry.trim()) return entry.trim();
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  for (const field of ['key', 'apiKey']) {
    if (typeof entry[field] === 'string' && entry[field].trim()) return entry[field].trim();
  }
  return null;
}

function loadQuotaCredential(check) {
  const paths = Array.isArray(check.credential_file_candidates) ? check.credential_file_candidates : [];
  const keys = Array.isArray(check.credential_keys) ? check.credential_keys : [];
  for (const candidate of paths) {
    const path = expandEnv(candidate);
    if (!path || !existsSync(path)) continue;
    try {
      const auth = JSON.parse(readFileSync(path, 'utf8'));
      for (const key of keys) {
        const value = credentialValue(auth?.[key]);
        if (value) return value;
      }
      const matchingEntry = Object.entries(auth || {}).find(([name, entry]) =>
        keys.some(key => name.toLowerCase() === String(key).toLowerCase()) && credentialValue(entry),
      );
      const fallback = matchingEntry ? credentialValue(matchingEntry[1]) : null;
      if (fallback) return fallback;
    } catch {
      // A missing or malformed auth file is an unknown quota state.
    }
  }
  return null;
}

function classifyOpenCodeGoUsage(statusCode, payload) {
  if (statusCode === 403 && /subscription required/i.test(String(payload?.error?.message || ''))) {
    return { status: 'unavailable', reason: 'OpenCode Go subscription is not active' };
  }
  if (statusCode !== 200) return { status: 'unknown', reason: `Quota endpoint returned HTTP ${statusCode || 'no response'}` };
  const windows = ['rolling', 'weekly', 'monthly'].map(name => payload?.usage?.[name]);
  if (windows.some(window => window?.status === 'rate-limited')) return { status: 'unavailable', reason: 'OpenCode Go usage limit reached' };
  if (windows.length === 3 && windows.every(window => window?.status === 'ok')) return { status: 'available', reason: 'OpenCode Go usage windows are available' };
  return { status: 'unknown', reason: 'Quota response did not contain explicit usage states' };
}

async function requestHttpQuota(check) {
  const timeoutMs = quotaTimeoutMs(check);
  const credential = loadQuotaCredential(check);
  if (!credential) return { classification: { status: 'unknown', reason: 'No configured OpenCode Go credential was found' }, error: null, timeoutMs };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(check.url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${credential}`,
        'user-agent': 'external-agent-quota/1.0',
      },
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;
    try { payload = JSON.parse(text); } catch { /* classify as unknown below */ }
    return { classification: classifyOpenCodeGoUsage(response.status, payload), error: null, timeoutMs };
  } catch (error) {
    const reason = error?.name === 'AbortError' ? `Quota check timed out after ${timeoutMs} ms` : 'Quota endpoint request failed';
    return { classification: { status: 'unknown', reason }, error: reason, timeoutMs };
  } finally {
    clearTimeout(timer);
  }
}

function resolveCommandCandidates(profile, configPath) {
  const fromEnv = profile.command_env ? process.env[profile.command_env] : null;
  const configured = expandEnv(fromEnv || profile.command);
  if (!configured) fail(`Provider command is missing in ${configPath}`);

  const candidates = [...new Set([configured, ...(profile.command_candidates || [])]
    .map(expandEnv)
    .filter(Boolean)
    .flatMap((candidate) => {
      if (!isWindows || /\.(?:cmd|exe|bat|com)$/i.test(candidate)) return [candidate];
      return [candidate, `${candidate}.cmd`, `${candidate}.exe`, `${candidate}.bat`];
    }))];
  return { configured, candidates };
}

function classifyPathErrorCode(code) {
  return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'inaccessible';
}

function resolveCommandInfo(profile, configPath) {
  const { configured, candidates } = resolveCommandCandidates(profile, configPath);
  const failures = [];
  for (const candidate of candidates) {
    if (!isAbs(candidate)) continue;
    try {
      if (statSync(candidate).isDirectory()) {
        failures.push({ candidate, code: 'EISDIR', kind: 'inaccessible' });
        continue;
      }
      return { configured, candidates, command: candidate, failures };
    } catch (error) {
      const code = error?.code || 'UNKNOWN';
      failures.push({ candidate, code, kind: classifyPathErrorCode(code) });
    }
  }
  const inaccessible = failures.find(failure => failure.kind === 'inaccessible');
  if (inaccessible) return { configured, candidates, command: inaccessible.candidate, failures };
  if (isAbs(configured)) {
    fail(`Provider executable does not exist: ${configured}. Config: ${configPath}`);
  }
  return { configured, candidates, command: configured, failures };
}

function resolveCommand(profile, configPath) {
  return resolveCommandInfo(profile, configPath).command;
}

function shouldRetryLaunch(result) {
  return Boolean(
    result?.error
    && LAUNCH_RETRY_CODES.has(result.error.code)
    && !result.provider_pid
    && result.event_count === 0
    && !result.stdout
    && !result.stderr,
  );
}

function buildRecoveryPlan({
  phase,
  errorCode = null,
  candidateDiagnostics = [],
  providerStarted = false,
  exitCode = null,
}) {
  const inaccessible = candidateDiagnostics.filter(item => item.kind === 'inaccessible');
  const missing = candidateDiagnostics.filter(item => item.kind === 'missing');
  if (exitCode === 0) return { status: 'not_needed', phase, cause: null, action: null, retry_allowed: false, error_code: null, automatic_actions: [], next_steps: [] };
  if (!providerStarted && (['EPERM', 'EACCES'].includes(errorCode) || inaccessible.length > 0)) {
    return {
      status: 'blocked',
      phase,
      cause: 'execution_context_denied',
      action: 'retry_in_trusted_windows_user_process',
      retry_allowed: true,
      error_code: errorCode || inaccessible[0]?.code || 'EPERM',
      automatic_actions: ['inspected candidate paths', 'attempted safe existing candidates'],
      next_steps: [
        'Run the same Runner in a trusted Windows user process.',
        'Run --check-provider in that process before retrying the task.',
      ],
    };
  }
  if (!providerStarted && (errorCode === 'ENOENT' || missing.length > 0)) {
    return {
      status: 'blocked',
      phase,
      cause: 'provider_executable_missing',
      action: 'repair_provider_installation',
      retry_allowed: false,
      error_code: errorCode || 'ENOENT',
      automatic_actions: ['inspected candidate paths', 'attempted safe existing candidates'],
      next_steps: [
        'Verify or repair the provider CLI in the Windows user environment.',
        'Run --check-provider before retrying the task.',
      ],
    };
  }
  if (!providerStarted && errorCode && LAUNCH_RETRY_CODES.has(errorCode)) {
    return {
      status: 'blocked',
      phase,
      cause: 'provider_launch_failed',
      action: 'repair_provider_launch_configuration',
      retry_allowed: false,
      error_code: errorCode,
      automatic_actions: ['attempted safe existing candidates'],
      next_steps: ['Inspect candidate diagnostics and correct the provider launch configuration before retrying.'],
    };
  }
  if (providerStarted || (exitCode !== null && exitCode !== 0)) {
    return {
      status: 'manual',
      phase: 'provider-execution',
      cause: 'provider_execution_failed',
      action: 'inspect_diff_then_decide',
      retry_allowed: false,
      error_code: errorCode,
      automatic_actions: ['preserved provider output and partial progress'],
      next_steps: [
        'Inspect the actual diff and provider diagnostics.',
        'Run the bounded quota check only if quota exhaustion is plausible.',
        'Continue only the remaining bounded work; do not replay the unchanged task.',
      ],
    };
  }
  return { status: 'not_needed', phase, cause: null, action: null, retry_allowed: false, error_code: null, automatic_actions: [], next_steps: [] };
}

function profileEnvNames(profile) {
  const configured = [];
  if (typeof profile.command_env === 'string') configured.push(profile.command_env);
  if (typeof profile.credential_env === 'string') configured.push(profile.credential_env);
  if (Array.isArray(profile.credential_env)) configured.push(...profile.credential_env);
  if (Array.isArray(profile.env_allowlist)) configured.push(...profile.env_allowlist);
  return configured.filter(name => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
}

function buildChildEnv(profile = {}) {
  const names = new Set([...SAFE_ENV_NAMES, ...profileEnvNames(profile)]);
  return Object.fromEntries([...names]
    .filter(name => typeof process.env[name] === 'string')
    .map(name => [name, process.env[name]]));
}

function validateProfile(profile, name = 'provider') {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return `${name} must be an object`;
  if (typeof profile.command !== 'string' || !profile.command.trim()) return `${name}.command must be a non-empty string`;
  for (const field of ['args', 'permission_args', 'command_candidates', 'env_allowlist', 'check_args']) {
    if (profile[field] !== undefined && (!Array.isArray(profile[field]) || profile[field].some(item => typeof item !== 'string'))) {
      return `${name}.${field} must be an array of strings`;
    }
  }
  if (profile.command_env !== undefined && (typeof profile.command_env !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(profile.command_env))) {
    return `${name}.command_env must be an environment variable name`;
  }
  if (profile.credential_env !== undefined) {
    const names = typeof profile.credential_env === 'string' ? [profile.credential_env] : profile.credential_env;
    if (!Array.isArray(names) || names.some(item => typeof item !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(item))) {
      return `${name}.credential_env must contain environment variable names only`;
    }
  }
  const transport = profile.prompt_transport || (profile.prompt_at_end ? 'argv_end' : 'stdin_none');
  if (!VALID_TRANSPORTS.has(transport)) return `${name}.prompt_transport is unsupported: ${transport}`;
  if (profile.output_parser !== undefined && !VALID_PARSERS.has(profile.output_parser)) return `${name}.output_parser is unsupported: ${profile.output_parser}`;
  if (profile.stdin_template !== undefined && (!profile.stdin_template || typeof profile.stdin_template !== 'object' || Array.isArray(profile.stdin_template))) {
    return `${name}.stdin_template must be an object`;
  }
  if (profile.quota_check !== undefined && profile.quota_check !== null) {
    const check = profile.quota_check;
    if (!check || typeof check !== 'object' || Array.isArray(check)) return `${name}.quota_check must be an object`;
    if (check.safe !== true) return `${name}.quota_check.safe must be true to enable a no-model-call check`;
    const kind = check.kind || 'command';
    if (!VALID_QUOTA_CHECK_KINDS.has(kind)) return `${name}.quota_check.kind is unsupported: ${kind}`;
    if (kind === 'command' && (!Array.isArray(check.args) || check.args.some(item => typeof item !== 'string'))) return `${name}.quota_check.args must be an array of strings`;
    if (kind === 'http_json') {
      if (typeof check.url !== 'string' || !/^https:\/\//i.test(check.url)) return `${name}.quota_check.url must be an HTTPS URL`;
      if (!Array.isArray(check.credential_file_candidates) || check.credential_file_candidates.some(item => typeof item !== 'string')) return `${name}.quota_check.credential_file_candidates must be an array of strings`;
      if (!Array.isArray(check.credential_keys) || check.credential_keys.some(item => typeof item !== 'string')) return `${name}.quota_check.credential_keys must be an array of strings`;
    }
    if (check.timeout_ms !== undefined && (!Number.isInteger(check.timeout_ms) || check.timeout_ms < 1_000 || check.timeout_ms > MAX_QUOTA_TIMEOUT_MS)) return `${name}.quota_check.timeout_ms must be an integer from 1000 to ${MAX_QUOTA_TIMEOUT_MS}`;
    for (const field of ['available_patterns', 'unavailable_patterns']) {
      if (check[field] !== undefined && (!Array.isArray(check[field]) || check[field].some(item => typeof item !== 'string'))) {
        return `${name}.quota_check.${field} must be an array of strings`;
      }
    }
  }
  return null;
}

function loadProviders(skillRoot) {
  const configPath = resolve(skillRoot, 'providers.json');
  if (!existsSync(configPath)) fail(`providers.json not found at ${configPath}`);
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    if (!config || typeof config !== 'object' || !config.providers || typeof config.providers !== 'object') {
      fail(`providers.json must contain a providers object: ${configPath}`);
    }
    for (const [name, profile] of Object.entries(config.providers)) {
      const issue = validateProfile(profile, `provider '${name}'`);
      if (issue) fail(`Invalid providers.json: ${issue}`);
    }
    return { config, configPath };
  } catch (error) {
    fail(`Failed to parse providers.json: ${error.message}`);
  }
}

function resolveProvider(config, cliName, packetName, defaultProvider, allowedProviders) {
  const name = cliName || packetName || config.default || defaultProvider;
  if (!name) fail('No provider specified');
  if (allowedProviders && !allowedProviders.includes(name)) {
    fail(`Only provider '${allowedProviders.join("' or '")}' is supported; received '${name}'`);
  }
  const profile = config.providers?.[name];
  if (!profile) fail(`Provider '${name}' not found in providers.json`);
  if (!profile.command) fail(`Provider '${name}' missing required 'command' field`);
  return { name, profile };
}

function formatList(label, value) {
  if (!Array.isArray(value) || value.length === 0) return [];
  return value
    .filter(item => typeof item === 'string' && item.trim())
    .map(item => `- ${label}: ${item.trim()}`);
}

function formatContextHint(value) {
  if (typeof value === 'string') return value.trim().slice(0, CONTEXT_HINT_MAX_CHARS);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const lines = [];
  if (typeof value.summary === 'string' && value.summary.trim()) lines.push(`- Summary: ${value.summary.trim()}`);
  if (typeof value.area === 'string' && value.area.trim()) lines.push(`- Area: ${value.area.trim()}`);
  if (typeof value.observations === 'string' && value.observations.trim()) lines.push(`- Observations: ${value.observations.trim()}`);
  lines.push(...formatList('Convention', value.conventions));
  lines.push(...formatList('Possible starting point', value.candidate_paths));
  if (typeof value.continuity === 'string' && value.continuity.trim()) lines.push(`- Continuity: ${value.continuity.trim()}`);
  return lines.join('\n').slice(0, CONTEXT_HINT_MAX_CHARS) || null;
}

function buildPrompt(packet) {
  const hint = formatContextHint(packet.context_hint);
  const context = hint
    ? `## Parent context (advisory)\n\n${hint}\n\nTreat this as a navigation hint only. You must verify it against the repository before relying on it.`
    : '';
  return `## Task

${packet.goal || 'Complete the implementation task described below.'}

## Environment

Working directory: ${packet.cwd}

Explore the codebase. Explore the repository yourself. Read its instructions and documentation,
trace the real flow, identify the relevant files and symbols, choose the
implementation, make the complete change, and run relevant tests, builds, or
linters when they exist. Do not wait for the parent agent to enumerate files or
prescribe each step.

${context ? `${context}\n\n` : ''}## Progress

For long tasks, emit a brief progress message at meaningful milestones before
continuing with tool calls. Do not wait for a progress request.

## Rules

1. Change only what the task requires. No unrelated refactors, reformatting,
   preference-driven renames, or dependency additions.
2. Follow existing repository conventions.
3. Verify before finishing. If checks cannot run, say what remains unverified.
4. Do not commit. Leave changes uncommitted for the parent to review.
5. If ambiguity materially changes the work, implement the most conservative
   reasonable reading and flag the alternatives.

## Guardrails

Everything irreversible or costly is default-closed unless the task explicitly
authorizes it:

- Never commit, push, rewrite Git history, overwrite local work, or delete tags
  or branches.
- Never delete files outside the workspace or remove a path you did not create.
- Make no side-effectful network calls, deployments, or mutating API requests.
- Run no command that consumes paid API quota or tokens unless told to run it.
- Put scratch scripts, logs, and downloads in a temporary directory. Keep
  workspace changes Git-revertible.

If the task explicitly authorizes one of these actions, do exactly what was
authorized, nothing wider, and report it.

## Final response

Respond naturally and concisely with what changed, how it was verified, and any
assumptions or unfinished work.`;
}

function validatePacket(packet) {
  if (!packet || typeof packet !== 'object' || Array.isArray(packet)) fail('Packet must be a JSON object');
  if (typeof packet.goal !== 'string' || !packet.goal.trim()) fail('packet.goal (non-empty string) is required');
  if (typeof packet.cwd !== 'string' || !isAbs(packet.cwd)) fail('packet.cwd must be an absolute path');
  if (!existsSync(packet.cwd) || !isDirectory(packet.cwd)) fail(`packet.cwd is not a directory: ${packet.cwd}`);
  if (packet.context_hint !== undefined
    && typeof packet.context_hint !== 'string'
    && (!packet.context_hint || typeof packet.context_hint !== 'object' || Array.isArray(packet.context_hint))) {
    fail('packet.context_hint must be a string or advisory object');
  }
  if (packet.effort !== undefined && typeof packet.effort !== 'string') fail('packet.effort must be a string when provided');
  if (packet.model !== undefined && (typeof packet.model !== 'string' || !packet.model.trim())) fail('packet.model must be a non-empty string when provided');
  if (packet.hard_timeout_minutes !== undefined) fail('packet.hard_timeout_minutes is not supported; execution has no hard runtime timeout');
}

function substituteTemplate(value, replacements) {
  if (typeof value === 'string') return value.replace(/\$(PROMPT|CWD)/g, (_, key) => replacements[key]);
  if (Array.isArray(value)) return value.map(item => substituteTemplate(item, replacements));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substituteTemplate(item, replacements)]));
  }
  return value;
}

function buildProviderArgs(def, { cwd, model, effort, prompt, session = null, addDirs = [] }) {
  const argv = [...(def.args || []), ...(def.permission_args || [])];
  if (model && def.model_flag) argv.push(def.model_flag, model);
  if (effort && def.effort_flag) argv.push(def.effort_flag, effort);
  if (session && def.session_flag) argv.push(def.session_flag, session);
  if (cwd && def.cwd_flag) argv.push(def.cwd_flag, cwd);
  if (def.add_dirs) {
    for (const dir of addDirs) argv.push(def.add_dir_flag || '--add-dir', dir);
  }
  const transport = def.prompt_transport || (def.prompt_at_end ? 'argv_end' : 'stdin_none');
  if (transport === 'argv_end') argv.push(prompt);
  return argv;
}

function buildStdinInput(def, prompt, cwd) {
  const transport = def.prompt_transport || (def.prompt_at_end ? 'argv_end' : 'stdin_none');
  if (transport === 'stdin_text') return prompt;
  if (transport === 'stdin_json') {
    const template = def.stdin_template || { event: 'user', message: { content: '$PROMPT' } };
    return `${JSON.stringify(substituteTemplate(template, { PROMPT: prompt, CWD: cwd }))}\n`;
  }
  return null;
}

function streamUserMessage(text) {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })}\n`;
}

function extractEventDetails(event) {
  const part = event?.part || event?.data?.part || event?.properties?.part;
  return {
    message: compact(event?.message || part?.text || event?.text, 500),
    tool: compact(part?.tool || part?.name || event?.tool, 100),
    file: compact(part?.file || part?.path || event?.file, 500),
  };
}

function executeProvider(command, argv, {
  cwd,
  prompt,
  stdinData = null,
  streamJson = false,
  parseJsonLines: shouldParseJsonLines = true,
  providerName = 'external-agent',
  progressInterval = PROGRESS_INTERVAL_MS,
  stallAfter = STALL_AFTER_MS,
  env = process.env,
  statusFile = null,
  cancelFile = null,
  reporter = payload => process.stderr.write(`${JSON.stringify(payload)}\n`),
}) {
  return new Promise(resolveExecution => {
    let child;
    try {
      child = spawn(command, argv, { cwd, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      resolveExecution({
        status: null,
        signal: null,
        error,
        provider_pid: null,
        cancel_requested: false,
        stdout: '',
        stderr: '',
        stdout_bytes: 0,
        stderr_bytes: 0,
        outputOverflow: false,
        event_count: 0,
        last_event_type: null,
        last_tool: null,
        last_message: null,
        resultEvents: [],
        touched_files: [],
      });
      return;
    }
    const startedAt = Date.now();
    let lastActivityAt = startedAt;
    let lastEventAt = startedAt;
    let settled = false;
    let spawnError = null;
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputOverflow = false;
    let eventCount = 0;
    let lastEventType = null;
    let lastTool = null;
    let lastMessage = null;
    let cancelRequested = false;
    const resultEvents = [];
    const touchedFiles = new Set();

    const append = (name, chunk) => {
      const bytes = Buffer.byteLength(chunk, 'utf8');
      if (name === 'stdout') { stdoutBytes += bytes; stdout += chunk; }
      else { stderrBytes += bytes; stderr += chunk; }
      lastActivityAt = Date.now();
      if (stdoutBytes + stderrBytes > MAX_OUTPUT_BYTES && !outputOverflow) {
        outputOverflow = true;
        reporter({ type: 'external-agent-progress', provider: providerName, state: 'failed', reason: 'output exceeded 10 MB' });
        child.kill();
      }
    };

    const report = (state, extra = {}) => {
      const payload = {
        type: 'external-agent-progress',
        provider: providerName,
        state,
        provider_pid: child.pid || null,
        elapsed_seconds: Math.round((Date.now() - startedAt) / 1000),
        last_activity_seconds_ago: Math.round((Date.now() - lastActivityAt) / 1000),
        last_event_seconds_ago: Math.round((Date.now() - lastEventAt) / 1000),
        event_count: eventCount,
        last_event_type: lastEventType,
        last_tool: redactSensitive(lastTool),
        last_message: redactSensitive(lastMessage),
        touched_files: [...touchedFiles].slice(0, 20).map(redactSensitive),
        ...extra,
      };
      if (statusFile) {
        try { writeFileSync(statusFile, JSON.stringify(payload, null, 2), 'utf8'); } catch { /* status is best effort */ }
      }
      reporter(payload);
    };

    report('started');

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => append('stdout', chunk));
    child.stderr.on('data', chunk => append('stderr', chunk));
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', line => {
      if (!shouldParseJsonLines || !line.trim()) return;
      try {
        const event = JSON.parse(line);
        eventCount += 1;
        lastEventAt = Date.now();
        lastEventType = compact(event.type || event.event || event.status, 100);
        const details = extractEventDetails(event);
        if (details.tool) lastTool = details.tool;
        if (details.message) lastMessage = details.message;
        if (details.file) touchedFiles.add(details.file);
        if (event.type === 'result' || event.event === 'result') {
          resultEvents.push(event);
          report('final-result-received', { has_response: Boolean(event.result || event.response) });
        }
      } catch {
        // Keep non-JSON progress lines in stdout diagnostics.
      }
    });
    child.on('error', error => { spawnError = error; });
    const progressTimer = setInterval(() => {
      if (settled) return;
      const stalled = Date.now() - lastEventAt >= stallAfter;
      report(stalled ? 'stalled' : 'running', {
        note: stalled
          ? 'no provider events within the stall threshold; the caller must decide whether to wait or stop'
          : 'provider remains active; no message was injected into its session',
      });
    }, progressInterval);
    const cancelTimer = cancelFile ? setInterval(() => {
      if (settled || cancelRequested || !existsSync(cancelFile)) return;
      cancelRequested = true;
      report('cancellation-requested', { note: 'cancellation requested by the caller' });
      child.kill('SIGINT');
    }, 1_000) : null;
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearInterval(progressTimer);
      if (cancelTimer) clearInterval(cancelTimer);
      lines.close();
      report(cancelRequested ? 'cancelled' : 'finished');
      resolveExecution({
        status: code,
        signal,
        error: spawnError,
        provider_pid: child.pid || null,
        cancel_requested: cancelRequested,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        stdout_bytes: stdoutBytes,
        stderr_bytes: stderrBytes,
        outputOverflow,
        event_count: eventCount,
        last_event_type: lastEventType,
        last_tool: lastTool,
        last_message: lastMessage,
        resultEvents,
        touched_files: [...touchedFiles].slice(0, 20),
      });
    });
    const input = stdinData ?? (streamJson ? streamUserMessage(prompt) : '');
    child.stdin.end(input);
  });
}

function parseJsonLines(text) {
  return String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).flatMap(line => {
    try {
      const parsed = JSON.parse(line);
      return parsed && typeof parsed === 'object' ? [parsed] : [];
    } catch { return []; }
  });
}

function taskResultFromText(text) {
  if (!text || !text.trim()) return null;
  try {
    const parsed = JSON.parse(text.trim());
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      && ['status', 'changed_files', 'validation', 'summary', 'risks', 'response'].some(key => key in parsed)) {
      return { ...parsed, response: parsed.response || text.trim() };
    }
  } catch {
    // Natural-language provider output is supported.
  }
  return { status: 'success', summary: compact(text), response: text.trim(), risks: [] };
}

function parseOpenCodeOutput(stdout) {
  const textParts = [];
  let providerError = null;
  let lastFinishReason = null;
  for (const event of parseJsonLines(stdout)) {
    const part = event.part || event.data?.part || event.properties?.part;
    if (event.type === 'text') {
      const text = typeof event.text === 'string' ? event.text : part?.text;
      if (text) textParts.push(text);
    }
    if (event.type === 'error' || part?.type === 'error') providerError = compact(event.error || event.message || part?.error || part?.message);
    if (event.type === 'step_finish' || part?.type === 'step-finish') lastFinishReason = compact(part?.reason || event.reason, 100);
  }
  if (textParts.length > 0) return taskResultFromText(textParts.join('').trim());
  if (providerError) return { status: 'failed', summary: providerError, risks: ['OpenCode did not emit a final response'] };
  return {
    status: 'failed',
    summary: lastFinishReason ? `OpenCode exited after '${lastFinishReason}' without a final response` : 'OpenCode exited without a final response',
    risks: ['OpenCode did not emit a final response'],
  };
}

function parseResultEventOutput(stdout) {
  const events = parseJsonLines(stdout);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.event === 'result' && event.result && typeof event.result === 'object') return event.result;
    if (event.result && typeof event.result === 'object' && !Array.isArray(event.result)) return event.result;
    if (typeof event.response === 'string' || typeof event.status === 'string') return event;
  }
  return null;
}

function parseGenericOutput(stdout) {
  const events = parseJsonLines(stdout);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.result && typeof event.result === 'object' && !Array.isArray(event.result)) return event.result;
    if (typeof event.response === 'string' || typeof event.status === 'string') return event;
    if (typeof event.text === 'string') return taskResultFromText(event.text);
  }
  return taskResultFromText(stdout);
}

function parseOutput(stdout, parser) {
  switch (parser) {
    case 'opencode-jsonl': return parseOpenCodeOutput(stdout);
    case 'result-event': return parseResultEventOutput(stdout);
    case 'generic-jsonl': return parseGenericOutput(stdout);
    case 'text': return taskResultFromText(stdout);
    default: return parseGenericOutput(stdout);
  }
}

function normalizeStatus(value) {
  if (typeof value !== 'string') return null;
  const status = value.trim().toLowerCase();
  if (VALID_STATUSES.has(status)) return status;
  if (['completed', 'complete', 'ok', 'done', 'success'].includes(status)) return 'success';
  if (['error', 'errored', 'failure', 'failed', 'cancelled', 'canceled'].includes(status)) return 'failed';
  if (['approval', 'needs_approval', 'needs-approval', 'needs_input', 'needs-input', 'waiting', 'blocked'].includes(status)) return 'blocked';
  return null;
}

function normalizeResult(parsed, providerName, model, effort, exitCode, profile = {}) {
  const response = typeof parsed?.response === 'string' ? parsed.response.trim() : '';
  const parsedStatus = normalizeStatus(parsed?.status);
  const preserveResponse = profile.preserve_response_on_nonzero === true && Boolean(response);
  const status = preserveResponse ? 'success' : (exitCode !== 0 ? 'failed' : (parsedStatus || 'success'));
  const sessionId = parsed?.session_id || parsed?.conversation_id || null;
  const result = {
    status,
    backend: providerName,
    provider: providerName,
    agent: providerName,
    model: parsed?.model || model || null,
    effort: parsed?.effort || effort || null,
    session_id: sessionId,
    changed_files: Array.isArray(parsed?.changed_files) ? parsed.changed_files : [],
    validation: parsed?.validation || null,
    summary: typeof parsed?.summary === 'string' ? parsed.summary.slice(0, 500) : (response ? compact(response) : 'Provider returned no structured task result'),
    response: response || null,
    risks: Array.isArray(parsed?.risks) ? parsed.risks : [],
    diagnostics: parsed?.diagnostics || null,
    exit_code: exitCode,
  };
  if (sessionId) result.conversation_id = sessionId;
  if (preserveResponse) result.warning = compact(parsed?.error || 'Provider exited non-zero after returning a response');
  return result;
}

function checkProvider(profile, configPath, providerName = null) {
  const commandInfo = resolveCommandInfo(profile, configPath);
  const command = commandInfo.command;
  const args = profile.check_args || ['--version'];
  const result = spawnSync(command, args, { env: buildChildEnv(profile), encoding: 'utf8', timeout: 30_000, windowsHide: true, shell: false });
  const exitCode = result.status ?? (result.error ? 1 : 0);
  const stdout = redactSensitive((result.stdout || '').trim());
  const stderr = redactSensitive((result.stderr || '').trim());
  const success = !result.error && exitCode === 0;
  process.stdout.write(JSON.stringify({
    status: success ? 'success' : 'failed',
    mode: 'provider-check',
    backend: null,
    provider: providerName,
    command,
    candidate_diagnostics: commandInfo.failures,
    recovery: buildRecoveryPlan({
      phase: 'provider-check',
      errorCode: result.error?.code || null,
      candidateDiagnostics: commandInfo.failures,
      exitCode,
    }),
    version: stdout || null,
    error: success ? null : (redactSensitive(result.error?.message) || stderr || `Provider check exited with code ${exitCode}`),
    exit_code: exitCode,
  }));
  process.exit(success ? 0 : 1);
}

function quotaStatus(profile, stdout, stderr, exitCode) {
  const check = profile.quota_check;
  if (!check || check.safe !== true) return { status: 'unknown', reason: 'No safe provider-specific quota check is configured' };
  if (exitCode !== 0) return { status: 'unknown', reason: 'Quota check command did not complete successfully' };
  const text = redactSensitive(`${stdout}\n${stderr}`);
  for (const pattern of check.unavailable_patterns || []) {
    try {
      if (new RegExp(pattern, 'i').test(text)) return { status: 'unavailable', reason: `Matched provider rule: ${pattern}` };
    } catch {
      return { status: 'unknown', reason: 'Invalid quota rule in provider profile' };
    }
  }
  for (const pattern of check.available_patterns || []) {
    try {
      if (new RegExp(pattern, 'i').test(text)) return { status: 'available', reason: `Matched provider rule: ${pattern}` };
    } catch {
      return { status: 'unknown', reason: 'Invalid quota rule in provider profile' };
    }
  }
  return { status: 'unknown', reason: 'Quota output did not match an explicit provider rule' };
}

async function checkQuota(profile, configPath, providerName = null) {
  const check = profile.quota_check;
  if (!check || check.safe !== true) {
    process.stdout.write(JSON.stringify({ status: 'unknown', mode: 'quota-diagnosis', provider: providerName, model: profile.default_model || null, no_model_call: true, command: null, reason: 'No safe provider-specific quota check is configured' }));
    process.exit(3);
  }
  const timeoutMs = quotaTimeoutMs(check);
  let command = null;
  let classification;
  let error = null;
  let exitCode = 0;
  if ((check.kind || 'command') === 'http_json') {
    command = check.url;
    const result = await requestHttpQuota(check);
    classification = result.classification;
    error = result.error;
  } else {
    command = resolveCommand(profile, configPath);
    const result = spawnSync(command, check.args, { env: buildChildEnv(profile), encoding: 'utf8', timeout: timeoutMs, windowsHide: true, shell: false });
    exitCode = result.status ?? (result.error ? 1 : 0);
    const stdout = (result.stdout || '').trim();
    const stderr = (result.stderr || '').trim();
    classification = quotaStatus(profile, stdout, stderr, exitCode);
    if (result.error?.code === 'ETIMEDOUT') {
      classification = { status: 'unknown', reason: `Quota check timed out after ${timeoutMs} ms` };
      error = classification.reason;
    } else if (result.error) {
      error = redactSensitive(result.error.message);
    } else if (classification.status === 'unknown') {
      error = redactSensitive(stderr) || null;
    }
  }
  process.stdout.write(JSON.stringify({
    status: classification.status,
    mode: 'quota-diagnosis',
    provider: providerName,
    model: profile.default_model || null,
    no_model_call: true,
    command,
    timeout_ms: timeoutMs,
    reason: classification.reason,
    error,
    exit_code: exitCode,
  }));
  process.exit(classification.status === 'available' ? 0 : classification.status === 'unavailable' ? 2 : 3);
}

function dryRun(provider, packetPath, args, { configPath, command, cwd }) {
  process.stdout.write(JSON.stringify({ status: 'dry-run', backend: provider.name, provider: provider.name, runner: fileURLToPath(import.meta.url), providers_config: configPath, command, args_count: args.length, arg_flags: args.filter(arg => typeof arg === 'string' && arg.startsWith('-')).slice(0, 30), packet: packetPath, cwd }));
  process.exit(0);
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = { packet: null, provider: null, backend: null, model: null, effort: null, dryRun: false, checkProvider: false, checkQuota: false, statusFile: null, cancelFile: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--packet') options.packet = argv[++index];
    else if (arg === '--provider') options.provider = argv[++index];
    else if (arg === '--backend') options.backend = argv[++index];
    else if (arg === '--model') options.model = argv[++index];
    else if (arg === '--effort') options.effort = argv[++index];
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--check-provider') options.checkProvider = true;
    else if (arg === '--check-quota') options.checkQuota = true;
    else if (arg === '--status-file') options.statusFile = argv[++index];
    else if (arg === '--cancel-file') options.cancelFile = argv[++index];
    else if (arg === '--help') { process.stdout.write('Usage: node run-agent.mjs --packet <absolute.json> [--provider name] [--dry-run] [--status-file path] [--cancel-file path] | --check-provider | --check-quota\n'); process.exit(0); }
    else fail(`Unknown argument: ${arg}`);
  }
  if (!options.packet && !options.checkProvider && !options.checkQuota) fail('--packet <absolute.json>, --check-provider, or --check-quota is required');
  return options;
}

async function runMain({ skillRoot, defaultProvider = null, allowedProviders = null } = {}) {
  const options = parseArgs();
  const { config, configPath } = loadProviders(skillRoot);
  const provider = resolveProvider(config, options.provider || options.backend, null, defaultProvider, allowedProviders);
  const commandInfo = options.checkQuota && provider.profile.quota_check?.kind === 'http_json'
    ? null
    : resolveCommandInfo(provider.profile, configPath);
  const command = commandInfo?.command || null;
  if (options.checkProvider) checkProvider(provider.profile, configPath, provider.name);
  if (options.checkQuota) await checkQuota(provider.profile, configPath, provider.name);
  if (!isAbs(options.packet)) fail(`Packet path must be absolute: ${options.packet}`);
  if (!existsSync(options.packet)) fail(`Packet file not found: ${options.packet}`);

  let packet;
  try { packet = JSON.parse(readFileSync(options.packet, 'utf8')); }
  catch (error) { fail(`Failed to parse packet JSON: ${error.message}`); }
  validatePacket(packet);
  for (const field of ['statusFile', 'cancelFile']) {
    if (options[field] !== null && (!isAbs(options[field]) || !options[field].trim())) {
      const flag = field.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`);
      fail(`--${flag} must be an absolute path`);
    }
  }

  const model = options.model || packet.model || provider.profile.default_model || null;
  const effort = options.effort || packet.effort || provider.profile.default_effort || null;
  const session = packet.session_id || packet.conversation || packet.session || null;
  const prompt = buildPrompt(packet);
  const args = buildProviderArgs(provider.profile, { cwd: packet.cwd, model, effort, session, prompt, addDirs: provider.profile.add_dirs ? [packet.cwd] : [] });
  if (options.dryRun) dryRun(provider, options.packet, args, { configPath, command, cwd: packet.cwd });

  const transport = provider.profile.prompt_transport || (provider.profile.prompt_at_end ? 'argv_end' : 'stdin_none');
  const executeOptions = {
    cwd: packet.cwd,
    prompt,
    stdinData: buildStdinInput(provider.profile, prompt, packet.cwd),
    streamJson: transport === 'legacy_stream_json',
    parseJsonLines: provider.profile.parse_json_lines !== false,
    providerName: provider.name,
    env: buildChildEnv(provider.profile),
    statusFile: options.statusFile,
    cancelFile: options.cancelFile,
  };
  const { candidates } = commandInfo || resolveCommandCandidates(provider.profile, configPath);
  const launchAttempts = [{ command, error: null }];
  let activeCommand = command;
  let result = await executeProvider(command, args, executeOptions);
  launchAttempts[0].error = result.error?.code || null;
  if (shouldRetryLaunch(result)) {
    const commandIndex = candidates.indexOf(command);
    const fallbackCandidates = candidates
      .slice(commandIndex + 1)
      .filter(candidate => isAbs(candidate) && existsSync(candidate));
    for (const fallbackCommand of fallbackCandidates) {
      process.stderr.write(`${JSON.stringify({
        type: 'external-agent-progress',
        provider: provider.name,
        state: 'launch-retry',
        reason: result.error.code,
        from: command,
        to: fallbackCommand,
      })}\n`);
      launchAttempts.push({ command: fallbackCommand, error: null });
      activeCommand = fallbackCommand;
      result = await executeProvider(fallbackCommand, args, executeOptions);
      launchAttempts[launchAttempts.length - 1].error = result.error?.code || null;
      if (!shouldRetryLaunch(result)) break;
    }
  }
  const exitCode = result.status ?? (result.error || result.signal ? 1 : 0);
  const parsed = result.outputOverflow ? null : parseOutput(result.stdout, provider.profile.output_parser || 'generic-jsonl');
  const normalized = parsed
    ? normalizeResult(parsed, provider.name, model, effort, exitCode, provider.profile)
    : normalizeResult({ status: 'failed', summary: result.error?.message || result.stderr || 'Provider returned no parseable response', risks: ['Provider output contained no usable final response'] }, provider.name, model, effort, exitCode || 1, provider.profile);

  normalized.diagnostics = {
    ...(normalized.diagnostics || {}),
    runner: fileURLToPath(import.meta.url),
    providers_config: configPath,
    command: activeCommand,
    candidate_diagnostics: commandInfo?.failures || [],
    launch_attempts: launchAttempts,
    args_count: args.length,
    arg_flags: args.filter(arg => typeof arg === 'string' && arg.startsWith('-')).slice(0, 30),
    prompt_transport: provider.profile.prompt_transport || (provider.profile.prompt_at_end ? 'argv_end' : 'stdin_none'),
    cwd: packet.cwd,
    stdout_preview: redactSensitive(result.stdout.slice(0, STREAM_DIAGNOSTIC_BYTES).slice(0, 2_000)),
    stderr_preview: redactSensitive(result.stderr.slice(0, 2_000)),
    stdout_bytes: result.stdout_bytes,
    stderr_bytes: result.stderr_bytes,
    event_count: result.event_count,
    last_event_type: result.last_event_type,
    last_tool: redactSensitive(result.last_tool),
    last_message: redactSensitive(result.last_message),
    touched_files: result.touched_files,
    provider_pid: result.provider_pid,
    cancel_requested: result.cancel_requested,
    status_file: options.statusFile,
    cancel_file: options.cancelFile,
  };
  normalized.recovery = buildRecoveryPlan({
    phase: result.provider_pid || result.event_count || result.stdout || result.stderr ? 'provider-execution' : 'task-launch',
    errorCode: result.error?.code || null,
    candidateDiagnostics: commandInfo?.failures || [],
    providerStarted: Boolean(result.provider_pid || result.event_count || result.stdout || result.stderr),
    exitCode,
  });
  if (result.outputOverflow) {
    normalized.status = 'failed';
    normalized.summary = 'Provider output exceeded the 10 MB safety limit';
    normalized.risks = ['Provider was terminated to prevent unbounded output'];
  }
  process.stdout.write(JSON.stringify(normalized));
  if (normalized.status === 'blocked') process.exit(10);
  if (normalized.status === 'failed') process.exit(1);
  process.exit(0);
}

export {
  isEntrypoint,
  buildPrompt,
  buildProviderArgs,
  buildStdinInput,
  checkProvider,
  checkQuota,
  classifyOpenCodeGoUsage,
  quotaTimeoutMs,
  buildChildEnv,
  executeProvider,
  formatContextHint,
  loadProviders,
  normalizeResult,
  parseResultEventOutput as parseAgyOutput,
  parseGenericOutput,
  parseOpenCodeOutput,
  resolveCommand,
  resolveCommandInfo,
  classifyPathErrorCode,
  buildRecoveryPlan,
  shouldRetryLaunch,
  resolveProvider,
  redactSensitive,
  runMain,
  validateProfile,
  validatePacket,
};
