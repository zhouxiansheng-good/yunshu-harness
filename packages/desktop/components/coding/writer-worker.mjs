/** Runs inside an atomically assigned, non-breakaway Windows Job. No task dispatch. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createLedger } from './vendor/dsh-codex-peer/lib/ledger.js';
import { runPeerRequest } from './vendor/dsh-codex-peer/lib/execute.js';
import { runClaudeRequest } from './claude-runner.mjs';
import { assertWriterLaunch, assertFreshImplementation } from './writer-authority.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const bytes = readFileSync(process.argv[2]);
if (digest(bytes) !== process.argv[3] || digest(readFileSync(fileURLToPath(import.meta.url))) !== process.argv[4])
  throw new Error('writer-input-or-worker-changed-before-transport');
const input = JSON.parse(bytes.toString('utf8'));
if (input.schema !== 1 || !['codex', 'claude'].includes(input.identity?.provider)) throw new Error('invalid-writer-input');
assertWriterLaunch(input.stateDir, input.identity);
assertFreshImplementation(input);
let response = null, error = null;
try {
  response = input.config?.transport==='responses-scoped-v1'
    ? await (await import('./fresh-executor.mjs')).executeFreshWriter(input)
    : input.identity.provider === 'codex'
    ? await runPeerRequest({ config: input.config, ledger: createLedger({ dir: input.config.stateDir }) }, input.request, {})
    : await runClaudeRequest(input.config, input.request);
} catch (failure) { error = input.config?.transport==='responses-scoped-v1'
  ? 'fresh-worker-failed-before-settled-result' : failure?.message ?? String(failure); }
// Only settled JSON goes to stdout. Native output remains in the existing peer
// artifacts; its descendants are still inside the outer Job after root exit.
process.stdout.write(JSON.stringify({ schema: 1, identity: input.identity,
  response: response?.kind === 'run' ? { kind: 'run', outcome: response.outcome } : null, error }) + '\n');
