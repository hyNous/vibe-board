import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertNoSecrets,
  generatedFiles,
  sanitizeSkillName,
  validateProfile,
} from './setup-agent.mjs';

test('skill names are safe directory names', () => {
  assert.equal(sanitizeSkillName('My-Kimi-Agent'), 'my-kimi-agent');
  assert.throws(() => sanitizeSkillName('../outside'), /skill name/);
});

test('profiles accept common transports and reject unsupported ones', () => {
  const profile = { command: 'my-agent', prompt_transport: 'stdin_json', output_parser: 'generic-jsonl', credential_env: ['MY_AGENT_KEY'] };
  assert.equal(validateProfile(profile), null);
  assert.equal(validateProfile({
    command: 'my-agent',
    quota_check: {
      safe: true,
      kind: 'http_json',
      url: 'https://example.test/usage',
      credential_file_candidates: ['${USERPROFILE}/auth.json'],
      credential_keys: ['provider'],
    },
  }), null);
  assert.match(validateProfile({ command: 'my-agent', prompt_transport: 'shell' }), /unsupported/);
});

test('secret values are rejected while credential environment names are allowed', () => {
  assert.doesNotThrow(() => assertNoSecrets({ command: 'agent', credential_env: ['AGENT_TOKEN'] }));
  assert.throws(() => assertNoSecrets({ command: 'agent', headers: { authorization: 'Bearer secret' } }), /not allowed/);
});

test('generated adapter is named and uses the sibling support runtime', () => {
  const files = generatedFiles('kimi', 'kimi-agent', { command: 'kimi', default_model: 'kimi-model' });
  assert.match(files['SKILL.md'], /name: kimi-agent/);
  assert.match(files['scripts/run-agent.mjs'], /external-agent-core/);
  assert.match(files['providers.json'], /kimi-model/);
  assert.match(files['SKILL.md'], /trusted Windows user-process/);
  assert.match(files['SKILL.md'], /retry_in_trusted_windows_user_process/);
});
