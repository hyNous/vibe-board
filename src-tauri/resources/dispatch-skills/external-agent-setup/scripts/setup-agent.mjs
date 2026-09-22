#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const isWindows = process.platform === 'win32';
const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultCatalog = resolve(skillRoot, 'providers.json');
const defaultSkillsRoot = resolve(process.env.EXTERNAL_AGENT_SKILLS || join(process.env.USERPROFILE || os.homedir(), '.agents', 'skills'));
const baseEnvNames = ['PATH', 'Path', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'SystemRoot', 'TEMP', 'TMP', 'ComSpec', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'];
const validTransports = new Set(['argv_end', 'stdin_text', 'stdin_json', 'stdin_none', 'legacy_stream_json']);
const validParsers = new Set(['opencode-jsonl', 'result-event', 'generic-jsonl', 'text']);
const validQuotaKinds = new Set(['command', 'http_json']);
const maxQuotaTimeoutMs = 30_000;

function expandEnv(value) {
  return String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => process.env[name] || '')
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_, name) => process.env[name] || '');
}

function redact(value) {
  let text = String(value || '');
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]');
  text = text.replace(/((?:api[_-]?key|token|secret|password|authorization|credential)[\w-]*\s*[:=]\s*)([^\s,;]+)/gi, '$1[REDACTED]');
  text = text.replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,})\b/g, '[REDACTED]');
  return text;
}

function safeEnv(profile) {
  const names = new Set(baseEnvNames);
  for (const name of [profile.command_env, profile.credential_env].flat()) {
    if (typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) names.add(name);
  }
  for (const name of profile.env_allowlist || []) {
    if (typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) names.add(name);
  }
  return Object.fromEntries([...names].filter(name => typeof process.env[name] === 'string').map(name => [name, process.env[name]]));
}

function commandCandidates(profile) {
  const configured = expandEnv(process.env[profile.command_env] || profile.command).trim();
  if (!configured) return [];
  return [configured, ...(profile.command_candidates || [])].filter(Boolean).flatMap(value => {
    const candidate = expandEnv(value);
    if (!isWindows || /\.(?:cmd|exe|bat|com)$/i.test(candidate)) return [candidate];
    return [candidate, `${candidate}.cmd`, `${candidate}.exe`, `${candidate}.bat`];
  });
}

function resolveCommand(profile) {
  for (const candidate of commandCandidates(profile)) {
    if (/^[A-Za-z]:[\\/]/.test(candidate) || /^\\\\/.test(candidate) || candidate.startsWith('/')) {
      if (existsSync(candidate)) return candidate;
      continue;
    }
    const pathValue = process.env.Path || process.env.PATH || '';
    for (const directory of pathValue.split(isWindows ? ';' : ':').filter(Boolean)) {
      const path = join(directory, candidate);
      if (existsSync(path)) return path;
      if (isWindows && !/\.(?:cmd|exe|bat|com)$/i.test(path)) {
        for (const suffix of ['.cmd', '.exe', '.bat']) if (existsSync(`${path}${suffix}`)) return `${path}${suffix}`;
      }
    }
  }
  return null;
}

function validateProfile(profile, name = 'provider') {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return `${name} must be an object`;
  if (typeof profile.command !== 'string' || !profile.command.trim()) return `${name}.command must be a non-empty string`;
  for (const field of ['args', 'permission_args', 'command_candidates', 'env_allowlist', 'check_args']) {
    if (profile[field] !== undefined && (!Array.isArray(profile[field]) || profile[field].some(item => typeof item !== 'string'))) return `${name}.${field} must be an array of strings`;
  }
  for (const field of ['command_env', 'credential_env']) {
    if (profile[field] === undefined) continue;
    const values = Array.isArray(profile[field]) ? profile[field] : [profile[field]];
    if (values.some(value => typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value))) return `${name}.${field} must contain environment variable names only`;
  }
  const transport = profile.prompt_transport || (profile.prompt_at_end ? 'argv_end' : 'stdin_none');
  if (!validTransports.has(transport)) return `${name}.prompt_transport is unsupported: ${transport}`;
  if (profile.output_parser !== undefined && !validParsers.has(profile.output_parser)) return `${name}.output_parser is unsupported: ${profile.output_parser}`;
  if (profile.quota_check !== undefined && profile.quota_check !== null) {
    const check = profile.quota_check;
    if (!check || typeof check !== 'object' || check.safe !== true) return `${name}.quota_check must declare safe:true`;
    const kind = check.kind || 'command';
    if (!validQuotaKinds.has(kind)) return `${name}.quota_check.kind is unsupported: ${kind}`;
    if (kind === 'command' && (!Array.isArray(check.args) || check.args.some(item => typeof item !== 'string'))) return `${name}.quota_check.args must be an array of strings`;
    if (kind === 'http_json') {
      if (typeof check.url !== 'string' || !/^https:\/\//i.test(check.url)) return `${name}.quota_check.url must be an HTTPS URL`;
      if (!Array.isArray(check.credential_file_candidates) || check.credential_file_candidates.some(item => typeof item !== 'string')) return `${name}.quota_check.credential_file_candidates must be an array of strings`;
      if (!Array.isArray(check.credential_keys) || check.credential_keys.some(item => typeof item !== 'string')) return `${name}.quota_check.credential_keys must be an array of strings`;
    }
    if (check.timeout_ms !== undefined && (!Number.isInteger(check.timeout_ms) || check.timeout_ms < 1_000 || check.timeout_ms > maxQuotaTimeoutMs)) return `${name}.quota_check.timeout_ms must be an integer from 1000 to ${maxQuotaTimeoutMs}`;
    for (const field of ['available_patterns', 'unavailable_patterns']) {
      if (check[field] !== undefined && (!Array.isArray(check[field]) || check[field].some(item => typeof item !== 'string'))) return `${name}.quota_check.${field} must be an array of strings`;
    }
  }
  return null;
}

function assertNoSecrets(value, path = 'profile') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecrets(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string' && (/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,})\b/.test(value) || /^Bearer\s+/i.test(value))) throw new Error(`${path} looks like a secret value; use credential_env names instead`);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (/(?:api[_-]?key|secret|password|token|authorization|private[_-]?key)/i.test(key)) throw new Error(`${path}.${key} is not allowed; use credential_env names instead`);
    assertNoSecrets(item, `${path}.${key}`);
  }
}

function sanitizeSkillName(value) {
  const name = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(name)) throw new Error('skill name must use 1-64 lowercase letters, numbers, and internal hyphens');
  return name;
}

function sanitizeProviderName(value) {
  const name = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/.test(name)) throw new Error('provider name must use 1-64 lowercase letters, numbers, hyphens, or underscores');
  return name;
}

function loadJson(path, label) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw new Error(`failed to parse ${label} ${path}: ${error.message}`); }
}

function loadCatalog(path) {
  const catalog = loadJson(path, 'catalog');
  if (!catalog.providers || typeof catalog.providers !== 'object') throw new Error('catalog must contain a providers object');
  for (const [name, profile] of Object.entries(catalog.providers)) {
    const issue = validateProfile(profile, `provider '${name}'`);
    if (issue) throw new Error(issue);
    assertNoSecrets(profile, `provider '${name}'`);
  }
  return catalog;
}

function profileFromFile(path, providerName) {
  const raw = loadJson(path, 'profile');
  const profile = raw?.providers?.[providerName] || raw?.profile || raw;
  const issue = validateProfile(profile, `provider '${providerName}'`);
  if (issue) throw new Error(issue);
  assertNoSecrets(profile);
  return profile;
}

function checkProvider(profile) {
  const command = resolveCommand(profile);
  if (!command) return { status: 'unavailable', command: null, version: null, error: 'CLI executable was not found; install it or set its command environment variable' };
  const result = spawnSync(command, profile.check_args || ['--version'], { env: safeEnv(profile), encoding: 'utf8', timeout: 30_000, windowsHide: true, shell: false });
  const exitCode = result.status ?? (result.error ? 1 : 0);
  const output = redact((result.stdout || result.stderr || '').trim()).replace(/\s+/g, ' ').slice(0, 200);
  return { status: !result.error && exitCode === 0 ? 'available' : 'unavailable', command, version: output || null, error: result.error ? redact(result.error.message) : (exitCode === 0 ? null : output || `CLI check exited with code ${exitCode}`) };
}

function credentialPresence(profile) {
  const names = [profile.credential_env].flat().filter(name => typeof name === 'string');
  return Object.fromEntries(names.map(name => [name, Boolean(process.env[name])]));
}

function detect(catalog) {
  return Object.entries(catalog.providers).map(([name, profile]) => ({
    provider: name,
    model: profile.default_model || null,
    credential_env_present: credentialPresence(profile),
    quota: profile.quota_check?.safe === true ? 'declared-check-available-to-run' : 'unknown',
    ...checkProvider(profile),
  }));
}

function generatedFiles(providerName, skillName, profile) {
  const providerLiteral = JSON.stringify(providerName);
  const wrapper = `#!/usr/bin/env node\n\nimport { dirname, resolve } from 'node:path';\nimport { fileURLToPath } from 'node:url';\nimport { isEntrypoint, runMain } from '../../external-agent-core/scripts/run-agent.mjs';\n\nconst skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');\nif (isEntrypoint(import.meta.url)) {\n  runMain({ skillRoot, defaultProvider: ${providerLiteral}, allowedProviders: [${providerLiteral}] }).catch(error => {\n    process.stdout.write(JSON.stringify({ status: 'failed', provider: ${providerLiteral}, summary: error.message, exit_code: 1 }));\n    process.exit(1);\n  });\n}\n`;
  const skill = `---\nname: ${skillName}\ndescription: Delegate autonomous repository work to the configured ${providerName} CLI when the user explicitly selects this Skill. Do not use for provider setup.\n---\n\n# ${skillName}\n\nUse this Skill only after the user selects ${providerName}. Start the selected task directly, then let the worker explore, implement, and verify autonomously. If the task fails and quota exhaustion is plausible, run the provider's safe no-model-call quota check after the failure; an unavailable or ambiguous check is unknown. Do not rerun the unchanged task merely to probe quota. Keep credentials, .env files, secrets, unrelated personal data, and paths outside the selected workspace out of the task.\n\nThe runner has no hard runtime timeout. It supports advisory context, a status file, and an explicit cancel file. The parent Agent reviews the actual diff and performs final validation.\n`;
  const generatedSkill = skill.replace(
    'Start the selected task directly, then let the worker explore, implement, and verify autonomously.',
    'Start the selected task directly, then let the worker explore, implement, and verify autonomously. On Windows, use the host tool trusted Windows user-process execution context for user-local CLI installations. Follow the Runner recovery object: when it requests retry_in_trusted_windows_user_process during task launch, rerun the provider check and the same packet once in that context; otherwise preserve progress and return its concrete next steps. Never report only not found when diagnostics identify a permission or launch-context failure.'
  );
  const readme = `# ${skillName}\n\nThis named Skill delegates to the configured **${providerName}** CLI. It was generated by external-agent-setup.\n\nInstall it beside external-agent-core under the same skills root. Do not put credentials in providers.json; use the existing CLI login or the declared credential environment variable names.\n\nDefault model: ${profile.default_model || 'provider default'}\n\nThe parent Agent remains responsible for decomposition, final diff review, key validation, integration, and the final response.\n`;
  const yaml = `interface:\n  display_name: "${skillName}"\n  short_description: "Delegate work to ${providerName}"\n  default_prompt: "Use $${skillName} to delegate the selected outcome to ${providerName}."\npolicy:\n  allow_implicit_invocation: false\n`;
  return {
    'SKILL.md': generatedSkill,
    'README.md': readme,
    'providers.json': JSON.stringify({ schema_version: 1, default: providerName, providers: { [providerName]: profile } }, null, 2) + '\n',
    'agents/openai.yaml': yaml,
    'scripts/run-agent.mjs': wrapper,
  };
}

function applyFiles(target, files, force) {
  mkdirSync(target, { recursive: true });
  const changed = [];
  for (const [relative, content] of Object.entries(files)) {
    const path = join(target, relative);
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path) && !force) throw new Error(`target file already exists: ${path}`);
    writeFileSync(path, content, 'utf8');
    changed.push(path);
  }
  return changed;
}

function parseArgs(argv) {
  const options = { action: 'detect', provider: null, skillName: null, profileFile: null, catalog: defaultCatalog, skillsRoot: defaultSkillsRoot, confirm: false, force: false, allowMissing: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--detect') options.action = 'detect';
    else if (arg === '--plan') options.action = 'plan';
    else if (arg === '--apply') options.action = 'apply';
    else if (arg === '--provider') options.provider = argv[++index];
    else if (arg === '--skill-name') options.skillName = argv[++index];
    else if (arg === '--profile-file') options.profileFile = argv[++index];
    else if (arg === '--catalog') options.catalog = argv[++index];
    else if (arg === '--skills-root') options.skillsRoot = argv[++index];
    else if (arg === '--confirm') options.confirm = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--allow-missing') options.allowMissing = true;
    else if (arg === '--help') {
      process.stdout.write('Usage: node setup-agent.mjs --detect | --plan --provider name --skill-name name [--profile-file path] | --apply --confirm --provider name --skill-name name [--profile-file path] [--force] [--allow-missing]\n');
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const catalog = loadCatalog(resolve(options.catalog));
  if (options.action === 'detect') {
    process.stdout.write(JSON.stringify({ status: 'success', mode: 'detect', skills_root: options.skillsRoot, providers: detect(catalog) }, null, 2));
    return;
  }
  const providerName = sanitizeProviderName(options.provider);
  const skillName = sanitizeSkillName(options.skillName);
  const profile = options.profileFile ? profileFromFile(resolve(options.profileFile), providerName) : catalog.providers[providerName];
  if (!profile) throw new Error(`provider '${providerName}' is not in the catalog; supply --profile-file for a new CLI`);
  const issue = validateProfile(profile, `provider '${providerName}'`);
  if (issue) throw new Error(issue);
  assertNoSecrets(profile, `provider '${providerName}'`);
  const target = resolve(options.skillsRoot, skillName);
  const coreRunner = join(resolve(options.skillsRoot), 'external-agent-core', 'scripts', 'run-agent.mjs');
  const probe = checkProvider(profile);
  const files = generatedFiles(providerName, skillName, profile);
  const plan = {
    provider: providerName,
    skill_name: skillName,
    provider_check: probe,
    model: profile.default_model || null,
    target,
    core_runner: coreRunner,
    core_present: existsSync(coreRunner),
    target_exists: existsSync(target),
    files: Object.keys(files).map(relative => join(target, relative)),
    writes_required: true,
    confirmation_required: true,
  };
  if (options.action === 'plan') {
    process.stdout.write(JSON.stringify({ status: 'success', mode: 'plan', ...plan, ready: plan.core_present && !plan.target_exists && probe.status === 'available' }, null, 2));
    return;
  }
  if (!options.confirm) throw new Error('confirmation required: rerun with --confirm after showing the plan to the user');
  if (!plan.core_present) throw new Error(`CORE_MISSING: install external-agent-core beside the generated Skill at ${coreRunner}`);
  if (probe.status !== 'available' && !options.allowMissing) throw new Error(`CLI_NOT_FOUND: ${probe.error || 'provider check failed'}; install the CLI or use --allow-missing after user confirmation`);
  const changed = applyFiles(target, files, options.force);
  process.stdout.write(JSON.stringify({ status: 'success', mode: 'apply', ...plan, changed_files: changed, next_steps: [`Invoke $${skillName} only after selecting ${providerName}.`, 'Keep the generated Skill beside external-agent-core.', 'Start the selected task directly; diagnose quota only after a failed task when the provider exposes a safe no-model-call check.'] }, null, 2));
}

function isEntrypoint(importMetaUrl) {
  if (!process.argv[1]) {
    return false;
  }
  const toReal = value => {
    try {
      return realpathSync(value);
    } catch {
      return resolve(value);
    }
  };
  const argvReal = toReal(process.argv[1]);
  const moduleReal = toReal(fileURLToPath(importMetaUrl));
  if (argvReal === moduleReal) {
    return true;
  }
  return process.platform === 'win32' && argvReal.toLowerCase() === moduleReal.toLowerCase();
}

if (isEntrypoint(import.meta.url)) {
  try { main(); }
  catch (error) {
    process.stdout.write(JSON.stringify({ status: 'failed', mode: 'setup', error: redact(error.message), recovery: 'Review the plan, install or configure the selected CLI, and retry after user confirmation.' }));
    process.exit(1);
  }
}

export { assertNoSecrets, checkProvider, generatedFiles, main, sanitizeProviderName, sanitizeSkillName, validateProfile };
