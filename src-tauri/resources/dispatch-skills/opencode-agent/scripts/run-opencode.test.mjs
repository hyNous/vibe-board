import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildPrompt,
  buildProviderArgs,
  executeProvider,
  parseOpenCodeOutput,
} from './run-opencode.mjs';

const runnerPath = fileURLToPath(new URL('./run-opencode.mjs', import.meta.url));
const skillRoot = resolve(dirname(runnerPath), '..');

test('provider configuration contains only OpenCode', () => {
  const config = JSON.parse(readFileSync(resolve(skillRoot, 'providers.json'), 'utf8'));
  assert.equal(config.default, 'opencode');
  assert.deepEqual(Object.keys(config.providers), ['opencode']);
});

test('unsupported provider fails with a concrete reason', () => {
  const result = spawnSync(
    process.execPath,
    [runnerPath, '--check-provider', '--provider', 'claude-code'],
    { encoding: 'utf8', windowsHide: true },
  );
  const output = JSON.parse(result.stdout);
  assert.equal(result.status, 1);
  assert.equal(output.status, 'failed');
  assert.match(output.summary, /Only provider 'opencode' is supported/);
});

test('OpenCode arguments keep cwd and task as separate argv values', () => {
  const prompt = 'quoted "text"\n中文 task';
  const argv = buildProviderArgs(
    {
      args: ['run', '--format', 'json', '--agent', 'codex-worker'],
      prompt_at_end: true,
      cwd_flag: '--dir',
      model_flag: '--model',
    },
    {
      cwd: 'C:\\work folder',
      model: 'opencode-go/deepseek-v4-flash',
      effort: null,
      prompt,
    },
  );

  assert.deepEqual(argv, [
    'run',
    '--format',
    'json',
    '--agent',
    'codex-worker',
    '--model',
    'opencode-go/deepseek-v4-flash',
    '--dir',
    'C:\\work folder',
    prompt,
  ]);
});

test('task prompt gives the worker autonomous repository ownership', () => {
  const prompt = buildPrompt({
    goal: 'Fix the refresh bug.',
    cwd: 'C:\\work',
  });

  assert.match(prompt, /Explore the repository yourself/);
  assert.match(prompt, /choose\s+the\s+implementation/);
  assert.match(prompt, /run relevant\s+tests/);
  assert.doesNotMatch(prompt, /allowed_files|context_files|do_not_touch/i);
  assert.doesNotMatch(prompt, /Acceptance criteria|validation commands/i);
  assert.doesNotMatch(prompt, /final response must be ONLY.*JSON/is);
});

test('advisory context is included without becoming a mandatory plan', () => {
  const prompt = buildPrompt({
    goal: 'Trace the refresh bug.',
    cwd: 'C:\\work',
    context_hint: {
      summary: 'The bug appears after token renewal.',
      area: 'authentication flow',
      conventions: ['Keep service and repository responsibilities separate.'],
      candidate_paths: ['src/auth', 'src/session'],
    },
  });

  assert.match(prompt, /Parent context \(advisory\)/);
  assert.match(prompt, /authentication flow/);
  assert.match(prompt, /must verify it against the repository/);
  assert.match(prompt, /may ignore it|navigation hint only/);
});

test('OpenCode free-form text is accepted as the final response', () => {
  const response = '## What I changed\nFixed the refresh flow.\n\n## How I verified it\nTests pass.';
  const output = [
    JSON.stringify({ type: 'step_start' }),
    JSON.stringify({ type: 'text', part: { text: response } }),
    JSON.stringify({ type: 'step_finish', part: { type: 'step-finish', reason: 'stop' } }),
  ].join('\n');

  const parsed = parseOpenCodeOutput(output);
  assert.equal(parsed.status, 'success');
  assert.equal(parsed.response, response);
  assert.match(parsed.summary, /Fixed the refresh flow/);
});

test('legacy structured text remains accepted without being required', () => {
  const taskResult = JSON.stringify({
    status: 'success',
    changed_files: [],
    validation: {},
    summary: 'done',
    risks: [],
  });
  const output = JSON.stringify({ type: 'text', part: { text: taskResult } });
  const parsed = parseOpenCodeOutput(output);

  assert.equal(parsed.status, 'success');
  assert.equal(parsed.summary, 'done');
  assert.equal(parsed.response, taskResult);
});

test('OpenCode tool events without a final response fail once without format recovery', () => {
  const output = [
    JSON.stringify({ type: 'step_start' }),
    JSON.stringify({
      type: 'tool_use',
      part: { type: 'tool', tool: 'read', state: { status: 'completed' } },
    }),
    JSON.stringify({
      type: 'step_finish',
      part: { type: 'step-finish', reason: 'unknown' },
    }),
  ].join('\n');

  assert.deepEqual(parseOpenCodeOutput(output), {
    status: 'failed',
    summary: "OpenCode exited after 'unknown' without a final response",
    risks: ['OpenCode did not emit a final response'],
  });
});

test('non-zero provider exit is preserved for the caller', async () => {
  const fakeProvider = 'process.stderr.write("provider failed"); process.exit(7);';
  const result = await executeProvider(
    process.execPath,
    ['--input-type=module', '-e', fakeProvider],
    {
      cwd: process.cwd(),
      prompt: 'test prompt',
      streamJson: false,
      providerName: 'fake',
      progressInterval: 20,
      stallAfter: 1000,
      reporter: () => {},
    },
  );

  assert.equal(result.status, 7);
  assert.match(result.stderr, /provider failed/);
});

test('stream execution closes stdin after the first final result', async () => {
  const reports = [];
  const fakeProvider = `
    import readline from 'node:readline';
    const lines = readline.createInterface({ input: process.stdin });
    lines.once('line', () => {
      process.stdout.write(JSON.stringify({
        type: 'result',
        result: 'done'
      }) + '\\n');
    });
    process.stdin.on('end', () => process.exit(0));
  `;

  const result = await executeProvider(
    process.execPath,
    ['--input-type=module', '-e', fakeProvider],
    {
      cwd: process.cwd(),
      prompt: 'test prompt',
      streamJson: true,
      providerName: 'fake',
      progressInterval: 20,
      stallAfter: 1000,
      reporter: report => reports.push(report),
    },
  );

  assert.equal(result.status, 0);
  assert.equal(result.resultEvents.length, 1);
  assert.ok(reports.some(report => report.state === 'final-result-received'));
});

test('a slow provider can finish without an execution deadline', async () => {
  const result = await executeProvider(
    process.execPath,
    ['--input-type=module', '-e', 'setTimeout(() => process.exit(0), 80);'],
    {
      cwd: process.cwd(),
      prompt: 'test prompt',
      streamJson: false,
      providerName: 'fake',
      progressInterval: 20,
      stallAfter: 30,
      reporter: () => {},
    },
  );

  assert.equal(result.status, 0);
  assert.ok(!Object.hasOwn(result, 'timedOut'));
});
