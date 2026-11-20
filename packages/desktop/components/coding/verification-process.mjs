/** Windows verification containment; receipts remain under the existing coding state. */
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = new URL('./verification-job.cs', import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const digest = path => hash(readFileSync(path));
const inside = (root, path) => { const r = relative(root, path); return r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r); };
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));

export function ensureVerificationSupervisor(stateDir) {
  if (process.platform !== 'win32') throw new Error('verification-job-platform-not-supported');
  const sourceSha256 = hash(readFileSync(SOURCE));
  const cache = resolve(stateDir, 'verification-tools'), destination = join(cache, sourceSha256);
  const executable = join(destination, 'supervisor.exe');
  const validate = () => {
    const meta = readJson(join(destination, 'build.json'));
    if (meta.sourceSha256 !== sourceSha256 || digest(executable) !== meta.supervisorSha256)
      throw new Error('verification-supervisor-integrity-mismatch');
    return { executable, sourceSha256, supervisorSha256: meta.supervisorSha256 };
  };
  if (existsSync(destination)) return validate();
  const compiler = join(process.env.SystemRoot || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  if (!existsSync(compiler)) throw new Error('verification-supervisor-compiler-missing');
  mkdirSync(cache, { recursive: true });
  const temporary = join(cache, sourceSha256 + '.building-' + randomUUID());
  mkdirSync(temporary);
  try {
    const target = join(temporary, 'supervisor.exe');
    execFileSync(compiler, ['/nologo', '/target:exe', '/optimize+', '/platform:x64',
      '/reference:System.Web.Extensions.dll', '/out:' + target, fileURLToPath(SOURCE)],
    { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
    writeFileSync(join(temporary, 'build.json'), JSON.stringify({ sourceSha256, supervisorSha256: digest(target) }) + '\n', { flag: 'wx' });
    try { renameSync(temporary, destination); }
    catch (error) { if (!existsSync(destination)) throw error; }
    return validate();
  } finally {
    if (existsSync(temporary) && inside(cache, resolve(temporary))) rmSync(temporary, { recursive: true, force: true });
  }
}

export function prepareVerification({ stateDir, checkId, program, args, cwd, timeoutMs, maxOutputBytes = 1024 * 1024, rootExitGraceMs = 250, environmentPolicy }) {
  if (!/^[0-9a-f-]{36}$/.test(checkId)) throw new TypeError('invalid verification checkId');
  // CreateProcess consumes a NUL-terminated UTF-16 command, unlike JS strings.
  // Reject truncation rather than pass a different command than the frozen argv.
  if (typeof program !== 'string' || !program.length || program.includes('\0')
    || typeof cwd !== 'string' || !cwd.length || cwd.includes('\0')
    || !Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0')))
    throw new TypeError('verification program, cwd and args must be strings without NUL');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0)
    throw new TypeError('verification limits must be positive safe integers');
  if (!Number.isSafeInteger(rootExitGraceMs) || rootExitGraceMs < 0 || rootExitGraceMs > 2000)
    throw new TypeError('rootExitGraceMs must be 0..2000');
  if(environmentPolicy!==undefined&&environmentPolicy!=='fresh-no-injection-v1')throw new Error('verification-environment-policy-invalid');
  const tool = ensureVerificationSupervisor(stateDir);
  const directory = resolve(stateDir, 'verification-checks', checkId);
  mkdirSync(directory, { recursive: true });
  const nonce = randomUUID(), jobName = 'Local\\YunshuVerify-' + checkId + '-' + nonce;
  const request = { protocol: 1, checkId, nonce, jobName, program, args, cwd, timeoutMs, maxOutputBytes, rootExitGraceMs };
  if(environmentPolicy)request.environmentPolicy=environmentPolicy;
  const requestPath = join(directory, 'request.json');
  writeFileSync(requestPath, JSON.stringify(request) + '\n', { flag: 'wx' });
  return { kind: 'windows-job-v1', checkId, directory, nonce, jobName, requestSha256: digest(requestPath),
    supervisorPath: tool.executable, supervisorSha256: tool.supervisorSha256, sourceSha256: tool.sourceSha256 };
}

function tail(path) {
  if (!existsSync(path)) return '';
  const fd = openSync(path, 'r');
  try {
    const size = statSync(path).size, bytes = Buffer.alloc(Math.min(8192, size));
    readSync(fd, bytes, 0, bytes.length, Math.max(0, size - bytes.length));
    return bytes.toString('utf8').slice(-2000);
  } finally { closeSync(fd); }
}

export function readVerificationReceipt(stateDir, container) {
  if (container?.kind !== 'windows-job-v1' || !/^[0-9a-f-]{36}$/.test(container.checkId ?? ''))
    throw new Error('legacy-verification-no-container-evidence');
  const directory = resolve(stateDir, 'verification-checks', container.checkId);
  if (resolve(container.directory) !== directory) throw new Error('verification-evidence-path-mismatch');
  const requestPath = join(directory, 'request.json'), receiptPath = join(directory, 'receipt.json');
  if (digest(requestPath) !== container.requestSha256) throw new Error('verification-request-hash-mismatch');
  if (!inside(resolve(stateDir, 'verification-tools'), resolve(container.supervisorPath))
    || digest(container.supervisorPath) !== container.supervisorSha256)
    throw new Error('verification-supervisor-hash-mismatch');
  const request = readJson(requestPath), receipt = readJson(receiptPath);
  for (const key of ['checkId', 'nonce', 'jobName']) {
    if (request[key] !== container[key] || receipt[key] !== container[key]) throw new Error('verification-receipt-binding-mismatch');
  }
  if (receipt.protocol !== 1 || receipt.requestSha256 !== container.requestSha256
    || receipt.supervisorSha256 !== container.supervisorSha256)
    throw new Error('verification-receipt-integrity-mismatch');
  if (receipt.terminalVerified !== true || receipt.activeProcesses !== 0)
    throw new Error('verification-job-terminal-unconfirmed');
  if(request.environmentPolicy && receipt.environmentPolicy!==request.environmentPolicy)
    throw new Error('verification-environment-policy-unconfirmed');
  // Old receipts can still prove their Job terminal boundary. New receipts also
  // bind output bytes; input-only diagnosis separately requires this field.
  if (receipt.outputFiles) for (const name of ['stdout.log', 'stderr.log']) {
    const row = receipt.outputFiles[name], path = join(directory, name);
    if (!row || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || !/^[0-9a-f]{64}$/.test(row.sha256)
      || statSync(path).size !== row.bytes || digest(path) !== row.sha256)
      throw new Error('verification-output-hash-mismatch');
  }
  return { ...receipt, receiptPath, receiptSha256: digest(receiptPath),
    stdoutTail: tail(join(directory, 'stdout.log')), stderrTail: tail(join(directory, 'stderr.log')) };
}

export async function runVerification(stateDir, container, signal) {
  if (signal?.aborted) return { terminalVerified: false, reason: 'cancelled-before-supervisor-launch' };
  const request = readJson(join(container.directory, 'request.json'));
  const env=request.environmentPolicy==='fresh-no-injection-v1'
    ? Object.fromEntries(Object.entries(process.env).filter(([key])=>['SYSTEMROOT','WINDIR','COMSPEC','TEMP','TMP','PATH','PATHEXT','OS'].includes(key.toUpperCase())))
    : process.env;
  // No AbortSignal on spawn: Node must not kill only this supervisor and then
  // mistake its callback for proof of an empty Job. Cancellation is a message.
  return await new Promise(resolveResult => {
    const child = spawn(container.supervisorPath, [join(container.directory, 'request.json'), container.requestSha256],
      { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'], env });
    let errorTail = '', settled = false;
    const abort = () => { if (!child.stdin.destroyed) child.stdin.write('cancel\n'); };
    child.stdin.on('error', () => {});
    child.stderr.on('data', bytes => { errorTail = (errorTail + bytes.toString('utf8')).slice(-2000); });
    const finish = error => {
      if (settled) return; settled = true;
      clearTimeout(deadline); signal?.removeEventListener('abort', abort);
      child.stdin.destroy();
      try { resolveResult(readVerificationReceipt(stateDir, container)); }
      catch (failure) { resolveResult({ terminalVerified: false, reason: 'supervisor-terminal-unconfirmed',
        error: String(error?.message ?? failure.message), stderrTail: errorTail }); }
    };
    const deadline = setTimeout(() => {
      // Job kill-on-close still applies, but lack of a receipt remains unknown.
      child.kill(); finish(new Error('verification-supervisor-deadline'));
    }, request.timeoutMs + 20000);
    child.once('error', finish); child.once('close', () => finish());
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
