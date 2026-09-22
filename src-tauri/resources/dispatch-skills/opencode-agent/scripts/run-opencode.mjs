#!/usr/bin/env node

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildPrompt,
  buildProviderArgs,
  executeProvider,
  isEntrypoint,
  loadProviders,
  normalizeResult,
  parseOpenCodeOutput,
  runMain,
} from '../../external-agent-core/scripts/run-agent.mjs';

const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

if (isEntrypoint(import.meta.url)) {
  runMain({ skillRoot, defaultProvider: 'opencode', allowedProviders: ['opencode'] }).catch(error => {
    process.stdout.write(JSON.stringify({ status: 'failed', provider: 'opencode', summary: error.message, exit_code: 1 }));
    process.exit(1);
  });
}

export {
  buildPrompt,
  buildProviderArgs,
  executeProvider,
  loadProviders,
  normalizeResult,
  parseOpenCodeOutput,
};
