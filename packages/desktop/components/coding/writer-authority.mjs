/** Generation fencing in the original ticket. Native evidence is not a model claim. */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareVerification, runVerification, readVerificationReceipt } from './verification-process.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = path => hash(readFileSync(path));
const workerPath = fileURLToPath(new URL('./writer-worker.mjs', import.meta.url));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const freshModules=['fresh-executor.mjs','fresh-transport.mjs','candidate-wire.mjs','fresh-context.mjs','diagnosis-input.mjs','diagnosis-json.mjs','diagnosis-transport.mjs',
  'writer-authority.mjs','coordinator.mjs','attempts.mjs','verification-process.mjs'];
export function freshImplementationHashes(){
  return Object.fromEntries(freshModules.map(name=>[name,digest(join(dirname(workerPath),name))]));
}
export function assertFreshImplementation(input){
  if(input.config?.transport!=='responses-scoped-v1')return;
  if(!same(input.config.implementationHashes,freshImplementationHashes()))throw new Error('fresh-implementation-changed');
}

export function hasWriterRecord(record) {
  return ['writerPolicy', 'writerAuthority'].some(key => Object.hasOwn(record, key))
    || (record.runs ?? []).some(run => Object.hasOwn(run, 'writer'))
    || Object.hasOwn(record.verification ?? {}, 'writer') || Object.hasOwn(record.promotion ?? {}, 'writer');
}

export function writerHold(record) {
  if (!hasWriterRecord(record)) return null;
  if (record.writerPolicy !== 1) return 'writer-policy-invalid';
  const a = record.writerAuthority;
  const last = (record.runs ?? []).findLast(run => !Object.hasOwn(run, 'kind') || run.kind === 'implement');
  if (!a || a.schema !== 1 || !Number.isSafeInteger(a.generation) || a.generation < 1
    || !/^[0-9a-f-]{36}$/.test(a.token ?? '') || a.attemptId !== last?.attemptId
    || a.contractHash !== record.contractHash || !same(a.identity, last?.writer)
    || a.identity.generation !== a.generation || a.identity.token !== a.token
    || a.identity.ticketId !== record.ticketId || a.identity.provider !== record.provider
    || a.identity.cwd !== (record.stage?.path ?? record.cwd) || !same(a.identity.files, record.files)) return 'writer-authority-binding-mismatch';
  if (a.status !== 'stopped' || a.terminal?.terminalVerified !== true || a.terminal?.activeProcesses !== 0)
    return 'writer-process-tree-unconfirmed';
  return null;
}

export function writerBinding(record) {
  const held = writerHold(record);
  if (held) throw new Error(held);
  if (!Object.hasOwn(record, 'writerPolicy')) return null;
  const a = record.writerAuthority;
  return { ...a.identity, receiptSha256: a.terminal.sha256, requestSha256: a.container.requestSha256 };
}

export function prepareWriter({ stateDir, identity, config, request, scopeEntries, timeoutMs }) {
  const directory = resolve(stateDir, 'writer-runs', identity.ticketId, identity.token);
  mkdirSync(directory, { recursive: true });
  const input = { schema: 1, stateDir: resolve(stateDir), identity, config, request, scopeEntries };
  const bytes = Buffer.from(JSON.stringify(input) + '\n');
  if (bytes.length > 16 * 1024 * 1024) throw new Error('writer-input-byte-budget-exceeded');
  const inputPath = join(directory, 'input.json');
  writeFileSync(inputPath, bytes, { flag: 'wx' });
  const inputSha256 = hash(bytes), workerSha256 = digest(workerPath);
  const container = prepareVerification({ stateDir, checkId: identity.token,
    program: process.execPath, args: [workerPath, inputPath, inputSha256, workerSha256], cwd: request.cwd,
    ...(config.transport==='responses-scoped-v1'?{environmentPolicy:'fresh-no-injection-v1'}:{}),
    timeoutMs, maxOutputBytes: 4 * 1024 * 1024 });
  return { ...container, writer: { inputPath, inputSha256, workerPath, workerSha256, identity } };
}

/** All paths/argv/input/result bytes are bound to the original durable intent. */
export function validateWriterInput(stateDir, authority) {
  const c = authority.container, w = c?.writer, id = authority.identity;
  if (!w || !same(w.identity, id) || id.token !== c.checkId || id.token !== authority.token || id.generation !== authority.generation
    || id.attemptId !== authority.attemptId || id.contractHash !== authority.contractHash)
    throw new Error('writer-container-binding-mismatch');
  const expected = resolve(stateDir, 'writer-runs', id.ticketId, id.token, 'input.json');
  if (resolve(w.inputPath) !== expected || w.workerPath !== workerPath
    || digest(w.inputPath) !== w.inputSha256 || digest(workerPath) !== w.workerSha256)
    throw new Error('writer-input-or-worker-changed');
  const input = JSON.parse(readFileSync(w.inputPath, 'utf8'));
  assertFreshImplementation(input);
  if (input.schema !== 1 || input.stateDir !== resolve(stateDir) || !same(input.identity, id)) throw new Error('writer-input-binding-mismatch');
  const nativeRequest = JSON.parse(readFileSync(join(c.directory, 'request.json'), 'utf8'));
  if(input.config?.transport==='responses-scoped-v1'&&nativeRequest.environmentPolicy!=='fresh-no-injection-v1')
    throw new Error('fresh-environment-policy-required');
  if (nativeRequest.program !== process.execPath || !same(nativeRequest.args, [workerPath, expected, w.inputSha256, w.workerSha256])
    || nativeRequest.cwd !== input.request.cwd) throw new Error('writer-command-binding-mismatch');
  if (input.request.cwd !== id.cwd || input.identity.ticketId !== id.ticketId)
    throw new Error('writer-input-scope-binding-mismatch');
  if (digest(join(c.directory, 'request.json')) !== c.requestSha256) throw new Error('writer-request-hash-mismatch');
  return input;
}

export function readWriterEvidence(stateDir, authority) {
  const input = validateWriterInput(stateDir, authority), c = authority.container, id = authority.identity;
  const receipt = readVerificationReceipt(stateDir, c);
  if (!receipt.outputFiles) throw new Error('writer-output-binding-required');
  let result = null;
  // A killed worker may have no JSON result; empty Job still proves local stop,
  // never successful work, known usage, or a usable native session.
  try { result = JSON.parse(readFileSync(join(c.directory, 'stdout.log'), 'utf8')); } catch {}
  if (result && (result.schema !== 1 || !same(result.identity, id))) throw new Error('writer-result-binding-mismatch');
  if (result?.response && receipt.assignedBeforeResume !== true)
    throw new Error('writer-atomic-job-assignment-unconfirmed');
  return { receipt, result, input };
}

export async function runWriter(stateDir, authority, signal) {
  validateWriterInput(stateDir, authority);
  assertWriterLaunch(stateDir, authority.identity);
  writeFileSync(join(resolve(authority.container.writer.inputPath, '..'), 'launch.json'),
    JSON.stringify({ identity: authority.identity, ownerPid: process.pid, at: new Date().toISOString() }) + '\n', { flag: 'wx' });
  await runVerification(stateDir, authority.container, signal);
  return readWriterEvidence(stateDir, authority);
}

export function assertWriterLaunch(stateDir, identity) {
  const path = join(stateDir, 'tickets', identity.ticketId + '.json');
  const record = JSON.parse(readFileSync(path, 'utf8')), owner = JSON.parse(readFileSync(path + '.lock', 'utf8'));
  if (record.writerPolicy !== 1 || record.writerAuthority?.status !== 'running'
    || record.status !== 'running' || !same(record.writerAuthority.identity, identity)
    || record.writerAuthority.generation !== identity.generation || record.writerAuthority.token !== identity.token
    || owner.token !== identity.lockToken || owner.pid !== identity.ownerPid || owner.operation !== 'implement')
    throw new Error('writer-launch-authority-fenced');
}

export function terminalBinding(receipt) {
  return { path: receipt.receiptPath, sha256: receipt.receiptSha256,
    terminalVerified: true, activeProcesses: 0, reason: receipt.reason,
    assignedBeforeResume: receipt.assignedBeforeResume, endedAt: receipt.endedAt };
}

/** Separate wx evidence: a stale owner must never rewrite a newer ticket. */
export function recordFencedResult(authority, value) {
  const path = join(resolve(authority.container.writer.inputPath, '..'), 'fenced-result.json');
  writeFileSync(path, JSON.stringify({ schema: 1, identity: authority.identity,
    at: new Date().toISOString(), ...value }, null, 2) + '\n', { flag: 'wx' });
  return path;
}
