import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildArgs,
  buildInput,
  buildPrompt,
  normalizeResult,
  parseAgyOutput,
} from './run-antigravity.mjs';

test('builds an autonomous unrestricted Antigravity invocation', () => {
  const packet = {
    goal: 'Fix the refresh bug.',
    cwd: 'C:\\work folder',
    effort: 'high',
    conversation: 'conversation-123',
  };
  const prompt = buildPrompt(packet);
  const args = buildArgs(packet);

  assert.match(prompt, /Explore the codebase/);
  assert.doesNotMatch(prompt, /allowed_files|acceptance criteria|validation commands/i);
  assert.deepEqual(args.slice(0, 4), [
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
  ]);
  assert.ok(args.includes('--dangerously-skip-permissions'));
  assert.ok(!args.includes('-p'));
  assert.ok(!args.includes('--print-timeout'));
  assert.deepEqual(args.slice(-4), [
    '--effort',
    'high',
    '--conversation',
    'conversation-123',
  ]);
  assert.deepEqual(JSON.parse(buildInput(prompt)), {
    event: 'user',
    message: { content: prompt },
  });
});

test('parses Antigravity stream result with leading events', () => {
  const payload = parseAgyOutput([
    'notice',
    JSON.stringify({ event: 'init', init: { cwd: 'C:\\work' } }),
    JSON.stringify({
      event: 'result',
      result: {
        status: 'SUCCESS',
        response: 'Implemented and tested.',
        conversation_id: 'abc',
      },
    }),
  ].join('\n'));

  assert.equal(payload.status, 'SUCCESS');
  assert.equal(payload.response, 'Implemented and tested.');
});

test('preserves a completed response even when Antigravity exits with a warning', () => {
  const result = normalizeResult({
    status: 'ERROR',
    response: 'The requested change is complete.',
    error: 'A final cleanup tool returned a warning.',
  }, 1, '', {});

  assert.equal(result.status, 'success');
  assert.equal(result.response, 'The requested change is complete.');
  assert.match(result.warning, /warning/);
});
