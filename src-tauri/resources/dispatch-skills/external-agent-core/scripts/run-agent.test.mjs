import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  buildProviderArgs,
  buildStdinInput,
  buildPrompt,
  buildChildEnv,
  buildRecoveryPlan,
  classifyOpenCodeGoUsage,
  classifyPathErrorCode,
  normalizeResult,
  parseGenericOutput,
  redactSensitive,
  quotaTimeoutMs,
  shouldRetryLaunch,
  validateProfile,
} from './run-agent.mjs';

test('builds an argv profile without forcing prompt transport', () => {
  const args = buildProviderArgs({
    args: ['run'],
    permission_args: ['--safe'],
    cwd_flag: '--cwd',
    model_flag: '--model',
    effort_flag: '--effort',
    session_flag: '--resume',
    prompt_transport: 'stdin_text',
  }, {
    cwd: 'C:\\work folder',
    model: 'model-x',
    effort: 'high',
    session: 'session-1',
    prompt: 'task',
  });

  assert.deepEqual(args, [
    'run', '--safe', '--model', 'model-x', '--effort', 'high',
    '--resume', 'session-1', '--cwd', 'C:\\work folder',
  ]);
});

test('renders JSON stdin templates and advisory context', () => {
  const prompt = buildPrompt({
    goal: 'Inspect the cache path.',
    cwd: 'C:\\repo',
    context_hint: 'The cache invalidation path is the likely starting area.',
  });
  const input = buildStdinInput({
    prompt_transport: 'stdin_json',
    stdin_template: { event: 'user', message: { content: '$PROMPT', cwd: '$CWD' } },
  }, prompt, 'C:\\repo');
  const parsed = JSON.parse(input);

  assert.equal(parsed.event, 'user');
  assert.equal(parsed.message.cwd, 'C:\\repo');
  assert.match(parsed.message.content, /Parent context \(advisory\)/);
});

test('parses a generic JSONL result and normalizes the common envelope', () => {
  const parsed = parseGenericOutput([
    JSON.stringify({ type: 'progress', text: 'reading' }),
    JSON.stringify({ status: 'SUCCESS', response: 'Implemented and checked.', session_id: 's-1' }),
  ].join('\n'));
  const result = normalizeResult(parsed, 'sample', 'model-x', 'high', 0);

  assert.equal(result.status, 'success');
  assert.equal(result.backend, 'sample');
  assert.equal(result.session_id, 's-1');
  assert.equal(result.response, 'Implemented and checked.');
});

test('filters child environment and redacts common secret formats', () => {
  const uniqueName = 'EXTERNAL_AGENT_TEST_SECRET_9F2C';
  const original = process.env[uniqueName];
  process.env[uniqueName] = 'do-not-print';
  try {
    const withoutDeclaration = buildChildEnv({});
    const withDeclaration = buildChildEnv({ credential_env: [uniqueName] });
    assert.equal(withoutDeclaration[uniqueName], undefined);
    assert.equal(withDeclaration[uniqueName], 'do-not-print');
  } finally {
    if (original === undefined) delete process.env[uniqueName];
    else process.env[uniqueName] = original;
  }
  const redacted = redactSensitive('Authorization: Bearer abc.def.ghi api_key=example-secret-value');
  assert.match(redacted, /\[REDACTED\]/);
  assert.doesNotMatch(redacted, /example-secret-value|abc\.def\.ghi/);
});

test('passes standard proxy variables without passing unrelated environment variables', () => {
  const proxyNames = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'];
  const unrelatedName = 'EXTERNAL_AGENT_UNRELATED_ENV_9F2C';
  const original = Object.fromEntries([...proxyNames, unrelatedName].map(name => [name, process.env[name]]));
  try {
    for (const name of proxyNames) process.env[name] = `proxy-${name}`;
    process.env[unrelatedName] = 'must-not-pass';
    const childEnv = buildChildEnv({});
    for (const name of proxyNames) assert.match(String(childEnv[name]), /^proxy-/);
    assert.equal(childEnv[unrelatedName], undefined);
  } finally {
    for (const name of [...proxyNames, unrelatedName]) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
  }
});

test('profile validation permits an omitted quota check and rejects unsafe declarations', () => {
  assert.equal(validateProfile({ command: 'agent', quota_check: null }), null);
  assert.match(validateProfile({ command: 'agent', quota_check: { safe: false, args: [] } }), /safe.*true/);
  assert.equal(validateProfile({
    command: 'agent',
    quota_check: {
      safe: true,
      kind: 'http_json',
      url: 'https://example.test/usage',
      credential_file_candidates: ['${USERPROFILE}/auth.json'],
      credential_keys: ['provider'],
      timeout_ms: 10_000,
    },
  }), null);
});

test('quota diagnostics classify explicit OpenCode Go usage states', () => {
  assert.equal(classifyOpenCodeGoUsage(200, {
    usage: {
      rolling: { status: 'ok' },
      weekly: { status: 'ok' },
      monthly: { status: 'ok' },
    },
  }).status, 'available');
  assert.equal(classifyOpenCodeGoUsage(200, {
    usage: {
      rolling: { status: 'rate-limited' },
      weekly: { status: 'ok' },
      monthly: { status: 'ok' },
    },
  }).status, 'unavailable');
  assert.equal(classifyOpenCodeGoUsage(401, {}).status, 'unknown');
});

test('path diagnostics distinguish missing files from inaccessible files', () => {
  assert.equal(classifyPathErrorCode('ENOENT'), 'missing');
  assert.equal(classifyPathErrorCode('ENOTDIR'), 'missing');
  assert.equal(classifyPathErrorCode('EPERM'), 'inaccessible');
  assert.equal(classifyPathErrorCode('EACCES'), 'inaccessible');
});

test('recovery guidance explains permission and missing-provider failures', () => {
  const permission = buildRecoveryPlan({
    phase: 'provider-check',
    errorCode: 'EPERM',
    candidateDiagnostics: [{ candidate: 'C:\\blocked\\agent.exe', code: 'EPERM', kind: 'inaccessible' }],
    exitCode: 1,
  });
  assert.equal(permission.status, 'blocked');
  assert.equal(permission.cause, 'execution_context_denied');
  assert.equal(permission.action, 'retry_in_trusted_windows_user_process');
  assert.equal(permission.retry_allowed, true);
  assert.match(permission.next_steps[0], /trusted Windows user process/);

  const missing = buildRecoveryPlan({
    phase: 'provider-check',
    errorCode: 'ENOENT',
    candidateDiagnostics: [{ candidate: 'C:\\missing\\agent.exe', code: 'ENOENT', kind: 'missing' }],
    exitCode: 1,
  });
  assert.equal(missing.status, 'blocked');
  assert.equal(missing.cause, 'provider_executable_missing');
  assert.equal(missing.action, 'repair_provider_installation');
  assert.equal(missing.retry_allowed, false);
});

test('quota diagnostic timeout is bounded independently from task runtime', () => {
  assert.equal(quotaTimeoutMs({}), 10_000);
  assert.equal(quotaTimeoutMs({ timeout_ms: 1 }), 1_000);
  assert.equal(quotaTimeoutMs({ timeout_ms: 99_999 }), 30_000);
});

test('launch recovery only retries pre-start path errors', () => {
  assert.equal(shouldRetryLaunch({ error: { code: 'EINVAL' }, provider_pid: null, event_count: 0, stdout: '', stderr: '' }), true);
  assert.equal(shouldRetryLaunch({ error: { code: 'ENOENT' }, provider_pid: 42, event_count: 0, stdout: '', stderr: '' }), false);
  assert.equal(shouldRetryLaunch({ error: { code: 'ENOENT' }, provider_pid: null, event_count: 1, stdout: '', stderr: '' }), false);
  assert.equal(shouldRetryLaunch({ error: { code: 'ECONNREFUSED' }, provider_pid: null, event_count: 0, stdout: '', stderr: '' }), false);
});

test('launch recovery uses the next existing candidate after a path error', () => {
  const directory = mkdtempSync(join(os.tmpdir(), 'external-agent-launch-retry-'));
  const brokenPath = join(directory, 'broken-provider.cmd');
  try {
    writeFileSync(brokenPath, '@echo off\r\n', 'utf8');
    const packet = join(directory, 'packet.json');
    writeFileSync(packet, JSON.stringify({ goal: 'test fallback', cwd: directory }), 'utf8');
    writeFileSync(join(directory, 'providers.json'), JSON.stringify({
      schema_version: 1,
      default: 'fake',
      providers: {
        fake: {
          command: brokenPath,
          command_candidates: [process.execPath],
          args: ['--input-type=module', '-e', "process.stdout.write(JSON.stringify({status:'success',response:'fallback'}))"],
          prompt_transport: 'stdin_none',
          output_parser: 'generic-jsonl',
        },
      },
    }), 'utf8');
    const wrapper = join(directory, 'wrapper.mjs');
    const runner = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'run-agent.mjs')).href;
    writeFileSync(wrapper, `import { runMain } from ${JSON.stringify(runner)}; process.argv = [process.argv[0], process.argv[1], '--packet', ${JSON.stringify(packet)}]; await runMain({ skillRoot: ${JSON.stringify(directory)}, defaultProvider: 'fake', allowedProviders: ['fake'] });\n`, 'utf8');
    const result = spawnSync(process.execPath, [wrapper], { encoding: 'utf8', timeout: 5_000, windowsHide: true });
    assert.equal(result.error, undefined);
    const output = JSON.parse(result.stdout);
    assert.equal(output.status, 'success');
    assert.equal(output.diagnostics.command, process.execPath);
    assert.equal(output.diagnostics.launch_attempts.length, 2);
    assert.match(output.diagnostics.launch_attempts[0].error, /^(EACCES|EISDIR|EINVAL|ENOENT|ENOEXEC|ENOTDIR|EPERM)$/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('hung command quota checks return unknown instead of blocking', () => {
  const directory = mkdtempSync(join(os.tmpdir(), 'external-agent-quota-timeout-'));
  try {
    writeFileSync(join(directory, 'providers.json'), JSON.stringify({
      schema_version: 1,
      default: 'hang',
      providers: {
        hang: {
          command: process.execPath,
          args: [],
          prompt_transport: 'stdin_none',
          quota_check: {
            safe: true,
            args: ['--input-type=module', '-e', 'setTimeout(() => {}, 60000)'],
            timeout_ms: 1_000,
          },
        },
      },
    }), 'utf8');
    const wrapper = join(directory, 'wrapper.mjs');
    const runner = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'run-agent.mjs')).href;
    writeFileSync(wrapper, `import { runMain } from ${JSON.stringify(runner)}; process.argv = [process.argv[0], process.argv[1], '--check-quota']; await runMain({ skillRoot: ${JSON.stringify(directory)}, defaultProvider: 'hang', allowedProviders: ['hang'] });\n`, 'utf8');
    const result = spawnSync(process.execPath, [wrapper], { encoding: 'utf8', timeout: 5_000, windowsHide: true });
    assert.equal(result.error, undefined);
    assert.equal(JSON.parse(result.stdout).status, 'unknown');
    assert.match(JSON.parse(result.stdout).reason, /timed out/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('status file records completion without storing the task prompt', async () => {
  const directory = mkdtempSync(join(os.tmpdir(), 'external-agent-status-'));
  const statusFile = join(directory, 'status.json');
  try {
    await (await import('./run-agent.mjs')).executeProvider(
      process.execPath,
      ['--input-type=module', '-e', 'process.exit(0)'],
      { cwd: process.cwd(), prompt: 'private prompt should not be written', providerName: 'fake', statusFile, reporter: () => {} },
    );
    const status = JSON.parse(readFileSync(statusFile, 'utf8'));
    assert.equal(status.state, 'finished');
    assert.equal(Object.hasOwn(status, 'prompt'), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
