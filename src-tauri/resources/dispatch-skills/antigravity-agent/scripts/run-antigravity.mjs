#!/usr/bin/env node

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildPrompt,
  buildProviderArgs,
  buildStdinInput,
  executeProvider,
  isEntrypoint,
  loadProviders,
  normalizeResult,
  parseAgyOutput,
  runMain,
} from '../../external-agent-core/scripts/run-agent.mjs';

const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const profile = loadProviders(skillRoot).config.providers.antigravity;

function buildArgs(packet) {
  return buildProviderArgs(profile, {
    cwd: packet.cwd,
    model: packet.model || null,
    effort: packet.effort || null,
    session: packet.conversation || packet.session_id || null,
    prompt: buildPrompt(packet),
    addDirs: profile.add_dirs ? [packet.cwd] : [],
  });
}

function buildInput(prompt, cwd = '') {
  return buildStdinInput(profile, prompt, cwd);
}

function normalizeAntigravityResult(payload, exitCode, stderr, packet = {}) {
  return normalizeResult(payload, 'antigravity', packet.model || null, packet.effort || null, exitCode, profile);
}

if (isEntrypoint(import.meta.url)) {
  runMain({ skillRoot, defaultProvider: 'antigravity', allowedProviders: ['antigravity'] }).catch(error => {
    process.stdout.write(JSON.stringify({ status: 'failed', agent: 'antigravity', summary: error.message, exit_code: 1 }));
    process.exit(1);
  });
}

export {
  buildArgs,
  buildInput,
  buildPrompt,
  executeProvider,
  normalizeAntigravityResult as normalizeResult,
  parseAgyOutput,
};
