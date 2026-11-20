/** Yunshu delegates coding; the selected agent owns the code changes. */
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, readdirSync, readSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createLedger } from './vendor/dsh-codex-peer/lib/ledger.js';
import { locateCodex } from './vendor/dsh-codex-peer/lib/locate.js';
import { runPeerRequest } from './vendor/dsh-codex-peer/lib/execute.js';
import { createStageWorktree, requireCleanGitRoot, requireGitHead } from './stage.mjs';
import { probeRelay } from './relay-auth.mjs';
import { claudeHome, locateClaude, probeClaudeRelay } from './claude-relay.mjs';
import { runClaudeRequest } from './claude-runner.mjs';
import * as handoff from './handoff-release.mjs';
import * as wire from './handoff-wire.mjs';
import { UnitedCodingBridge } from './united-bridge.mjs';
import { candidatePublication, observeProgress, progressView, progressFingerprint, PROGRESS_CAPABILITIES } from './progress.mjs';
import { prepareVerification, runVerification, readVerificationReceipt } from './verification-process.mjs';
import { implementationAttempt, artifactAttempt, bindImplementation, bindVerifiedArtifact, spentTokens, diagnosisAttempt, diagnosisHold, cumulativeArtifact } from './attempts.mjs';
import { hasWriterRecord, writerHold, writerBinding, prepareWriter, runWriter, readWriterEvidence, terminalBinding, recordFencedResult, freshImplementationHashes } from './writer-authority.mjs';


const PREAMBLE = [
  'You are the selected coding executor for Yunshu Bot. Yunshu coordinates and verifies; it does not write code.',
  'Work only in the named workspace and file scope. Do not treat your final message as proof of completion.',
  'Report exact changed files, checks run, native session and remaining issues. Never invent test results.',
  'Do not read Yunshu memory, DSH profiles or credentials unless the task explicitly requires them.',
].join('\n');
const FRESH_DISPATCH = Symbol('fresh-dispatch-validated-under-original-lock');

function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function fileHash(path) {
  if (!existsSync(path)) return null;
  if (!statSync(path).isFile()) throw new TypeError('expected file is not regular: ' + path);
  return hash(readFileSync(path));
}
function atomicJson(path, value) {
  const temporary = path + '.' + process.pid + '.' + Math.random().toString(16).slice(2) + '.new';
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8');
  renameSync(temporary, path);
}
// Call only with readWriterEvidence's bound native result. These are observed
// facts, not a terminal attempt status or permission to verify/promote/replay.
function settledWriterObservation(evidence, attempt) {
  const response = evidence.result?.response, outcome = response?.outcome;
  if (response?.kind !== 'run' || !outcome
    || !['completed', 'failed', 'aborted', 'timeout'].includes(outcome.status)) return null;
  const known = !attempt.fresh || outcome.fresh?.providerOutcomeKnown === true;
  const observation = { runId: outcome.runId ?? null,
    nativeSessionId: attempt.fresh ? null : outcome.threadId ?? null,
    resumedNativeSessionId: attempt.fresh ? null : outcome.resumedThreadId ?? null,
    runnerStatus: outcome.status, outcomeKnown: known,
    usage: outcome.usage ?? null, costUsd: outcome.costUsd ?? null };
  if (attempt.fresh) {
    observation.fresh = { ...attempt.fresh, ...outcome.fresh, providerOutcomeKnown: known };
    if (!known) observation.fresh.reason ??= 'fresh-provider-outcome-unknown';
    else if (!Object.hasOwn(outcome.fresh, 'reason')) delete observation.fresh.reason;
  }
  return observation;
}
function copyAtomically(source, target) {
  mkdirSync(dirname(target), { recursive: true });
  const temporary = join(dirname(target), '.' + basename(target) + '.yunshu-' + randomUUID() + '.new');
  try {
    copyFileSync(source, temporary);
    renameSync(temporary, target);
  } finally {
    if (existsSync(temporary)) rmSync(temporary);
  }
}
function requiredText(value, field, limit = 8000) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit)
    throw new TypeError(field + ' must be nonempty text of at most ' + limit + ' characters');
  return value.trim();
}
function inside(parent, target) {
  const part = relative(parent, target);
  return part === '' || (part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part));
}
function canonicalPath(path) {
  let current = resolve(path);
  const pending = [];
  for (;;) {
    try { lstatSync(current); return resolve(realpathSync(current), ...pending); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = dirname(current);
    if (parent === current) throw new Error('cannot resolve state directory');
    pending.unshift(basename(current));
    current = parent;
  }
}
function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(name + ' must be a positive integer');
  return value;
}
function expectedFiles(cwd, value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32)
    throw new TypeError('expectedFiles must contain 1–32 relative file paths');
  const files = [...new Set(value.map(item => requiredText(item, 'expected file', 240)))];
  for (const name of files) {
    const path = resolve(cwd, name);
    if (isAbsolute(name) || name.split(/[\\/]/).some(part => part === '..' || part === '.git')
      || name.includes('\0') || name.includes(':') || !inside(cwd, path))
      throw new TypeError('expected file escapes workspace: ' + name);
    if (existsSync(path) && !inside(cwd, realpathSync(path)))
      throw new TypeError('expected file symlink escapes workspace: ' + name);
  }
  assertTargetPaths(cwd, files);
  return files;
}
function assertTargetPaths(cwd, files) {
  for (const name of files) {
    let part = cwd;
    for (const component of relative(cwd, resolve(cwd, name)).split(sep)) {
      part = join(part, component);
      let stat;
      try { stat = lstatSync(part); }
      catch (error) { if (error.code === 'ENOENT') break; throw error; }
      if (stat.isSymbolicLink()) throw new TypeError('expected file traverses symlink: ' + name);
    }
  }
}
function snapshot(cwd, files) {
  assertTargetPaths(cwd, files);
  return Object.fromEntries(files.map(name => [name, fileHash(resolve(cwd, name))]));
}

// Scan every workspace entry, including ignored files. Hash ordinary source-sized files;
// metadata-fingerprint large assets so a repository of models/media is still auditable.
export function workspaceSnapshot(cwd, maxFiles, maxHashBytes, hashFileLimit, skipRootGit = false) {
  const entries = new Map();
  const stack = [cwd];
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let files = 0, bytes = 0;
  while (stack.length) {
    const dir = stack.pop();
    for (const child of readdirSync(dir, { withFileTypes: true })) {
      if (skipRootGit && dir === cwd && child.name === '.git') continue;
      const path = join(dir, child.name);
      const name = relative(cwd, path).split(sep).join('/');
      const stat = lstatSync(path, { bigint: true });
      if (stat.isDirectory()) { entries.set(name, 'dir'); stack.push(path); continue; }
      if (++files > maxFiles) throw new Error('scope audit file limit exceeded');
      if (stat.isSymbolicLink()) { entries.set(name, 'link:' + readlinkSync(path)); continue; }
      if (!stat.isFile()) { entries.set(name, 'special:' + stat.mode); continue; }
      if (stat.size > BigInt(hashFileLimit)) {
        entries.set(name, `large:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.ino}`);
        continue;
      }
      bytes += Number(stat.size);
      if (bytes > maxHashBytes) throw new Error('scope audit hash byte limit exceeded');
      const digest = createHash('sha256');
      const fd = openSync(path, 'r');
      try {
        for (let count; (count = readSync(fd, buffer, 0, buffer.length, null)) > 0;)
          digest.update(buffer.subarray(0, count));
      } finally { closeSync(fd); }
      entries.set(name, 'file:' + digest.digest('hex'));
    }
  }
  return entries;
}

export function scopeFingerprint(entries) {
  return hash(JSON.stringify([...entries].sort(([a], [b]) => a.localeCompare(b))));
}

function scopeChanges(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])].filter(name => before.get(name) !== after.get(name)).sort();
}

function allowedPaths(cwd, files) {
  const allowed = new Set();
  for (const file of files) {
    const parts = relative(cwd, resolve(cwd, file)).split(sep);
    for (let n = 1; n <= parts.length; n++) allowed.add(parts.slice(0, n).join('/'));
  }
  return allowed;
}
function probeLogin(executable, context = {}) {
  let output = '';
  try {
    output = execFileSync(executable, ['login', 'status'], {
      encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CODEX_HOME: context.codexHome },
    });
  } catch (error) {
    output = String(error.stdout ?? '') + '\n' + String(error.stderr ?? '');
    if (!/not logged in/i.test(output)) return { ready: false, reason: 'login-probe-failed' };
  }
  if (/not logged in/i.test(output)) return { ready: false, reason: 'not-logged-in' };
  if (/logged in/i.test(output)) return { ready: true, reason: 'logged-in' };
  return { ready: false, reason: 'login-status-unknown' };
}
function summary(record, mode = record.recoveryMode ?? 'observe') {
  const last = implementationAttempt(record), active = artifactAttempt(record);
  const diagnosis = diagnosisAttempt(record);
  const used = spentTokens(record);
  const rankPhase=record.rankDelivery?.phase;
  const rankStatus={failed:'verification-failed',verified:'verified-awaiting-promotion',applying:'promotion-needs-reconciliation',promoted:'promoted'}[rankPhase];
  return {
    ticketId: record.ticketId, provider: record.provider, status: rankStatus ?? record.status,
    united: record.united ?? null,
    cwd: record.cwd, workspaceMode: record.workspaceMode ?? 'direct',
    stagePath: record.stage?.path ?? null, runCount: record.runs.length, runId: last?.runId ?? null,
    writerAuthority: record.writerAuthority ? { generation: record.writerAuthority.generation,
      attemptId: record.writerAuthority.attemptId, status: record.writerAuthority.status,
      terminal: record.writerAuthority.terminal ?? null } : null,
    lastImplementationAttemptId: last?.attemptId ?? null, activeArtifactAttemptId: active?.attemptId ?? null,
    ...(record.initialProbe ? {initialProbe:{phase:record.initialProbe.phase,requestSha256:record.initialProbe.binding.requestSha256,
      providerOutcomeKnown:record.initialProbe.providerOutcomeKnown===true,publication:candidatePublication(record.initialProbe),automaticReplay:false}} : {}),
    ...(record.rankDelivery ? {rankDelivery:{phase:record.rankDelivery.phase,checkId:record.rankDelivery.receipt?.checkId,
      lastCheckPassed:record.rankDelivery.receipt?.result==='passed',promotionRecorded:record.rankDelivery.phase==='promoted',liveRechecked:false}} : {}),
    ...(last?.fresh ? {freshExecution:structuredClone(last.fresh)} : {}),
    diagnosis: diagnosis ? { attemptId: diagnosis.attemptId, status: diagnosis.status,
      sourceImplementationAttemptId: diagnosis.sourceImplementationAttemptId, sourceCheckId: diagnosis.sourceCheckId,
      responseId: diagnosis.responseId ?? null, inputSha256: diagnosis.inputSha256, requestSha256: diagnosis.requestSha256,
      requestCount: diagnosis.requestCount, requestedModel: diagnosis.requestedModel, reportedModel: diagnosis.reportedModel ?? null,
      outcomeKnown: diagnosis.outcomeKnown, usage: diagnosis.usage, reason: diagnosis.reason,
      scopeUnchanged: diagnosis.scopeUnchanged, proposal: diagnosis.proposal ?? null,
      proposalSha256: diagnosis.proposal ? hash(JSON.stringify(diagnosis.proposal)) : null, automaticAction: 'none' } : null,
    nativeSessionId: last?.nativeSessionId ?? null, usage: last?.usage ?? null,
    costUsd: last?.costUsd ?? null,
    changedFiles: last?.changedFiles ?? [],
    artifactFiles: last?.artifactFiles ?? null, verification: handoff.marked(record) && record.verification ? {
      status:record.verification.status, checkId:record.verification.checkId??null,
      exitCode:record.verification.exitCode??null, reason:record.verification.reason??null,
      passedChecks:record.verification.handoff?.checks??null, liveRechecked:false,
    } : record.verification ?? null,
    scopeAudit: record.scopeAudit ?? 'not-run', outOfScope: record.outOfScope ?? [],
    scopeAuditCoverage: { entries: 'all', sha256UpToBytes: record.auditHashFileLimit ?? null,
      largerFiles: 'size, mtime, ctime and inode' },
    promotion: record.promotion ?? null, reason: rankStatus ? 'rank-recorded-'+rankPhase : record.reason ?? null,
    reconciliation: record.reconciliation ?? (['running', 'outcome-unknown'].includes(record.verification?.status)
      ? { required: true, reason: 'verification-process-tree-unconfirmed' } : null),
    recovery: progressView(record, { mode }),
    tokenBudget: { limit: record.tokenBudget ?? null, used,
      remaining: used === null || record.tokenBudget == null ? null
        : Math.max(0, record.tokenBudget - used), enforcement: 'before-next-run-only' },
  };
}

export class CodingCoordinator {
  // Operator configuration, never a ticket/tool argument. The ordinary writer has no
  // attested filesystem role. A blind trial must not fall through to that transport.
  #dispatchProfile;
  #initialLoopback;
  #rankDelivery;
  #handoff;
  #wire;
  #blindHold(ticketId) {
    return { ticketId, reason: 'blind-trial-not-admitted', missing: ['writer-role-attestation',
      'model-input-attestation', 'unknown-code-grader-isolation'] };
  }
  constructor(options = {}) {
    this.#dispatchProfile = Object.hasOwn(options, 'dispatchProfile') ? options.dispatchProfile : 'standard';
    if (!['standard', 'blind-trial'].includes(this.#dispatchProfile)) throw new TypeError('invalid dispatchProfile');
    this.enabled = options.enabled === true;
    // Isolated host only. This configuration must never turn normal tool dispatch into a probe.
    this.#initialLoopback = options.initialTicketLoopback == null ? null : structuredClone(options.initialTicketLoopback);
    this.#rankDelivery = options.rankDelivery === 'rank-list-v1';
    if (options.rankDelivery != null && (!this.#rankDelivery || !this.#initialLoopback || !this.enabled || !options.unitedRoot))
      throw new TypeError('rank delivery requires an enabled, explicitly configured isolated host');
    this.stateDir = resolve(options.stateDir ?? join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'yunshu', 'coding'));
    this.united = options.unitedRoot ? new UnitedCodingBridge({ root: options.unitedRoot, cli: options.unitedCli,
      auditHandoff: record => handoff.requireQualification(this,this.#handoff,record),
      auditWriter: record => {
        try {
          this.assertMutationOwner(record.ticketId);
          if (JSON.stringify(this.readTicket(record.ticketId)) !== JSON.stringify(record)) return false;
          return readWriterEvidence(this.stateDir, record.writerAuthority).receipt.receiptSha256 === record.writerAuthority.terminal.sha256;
        }
        catch { return false; }
      }, auditSource: record => {
        if (!record.promotion?.sourceScopeFingerprint || !record.stage) return false;
        requireGitHead(record.cwd, record.stage.head);
        const now = workspaceSnapshot(record.cwd, this.maxAuditFiles, this.maxAuditBytes, this.auditHashFileLimit, true);
        return scopeFingerprint(now) === record.promotion.sourceScopeFingerprint;
      } }) : null;
    this.allowedRoots = (options.allowedRoots ?? []).map(root => realpathSync(root));
    const localDefault=options.handoffRelease && !options.runner && !options.claudeRunner && options.handoffWire===undefined;
    if(localDefault){
      // Validate the controller, including its interpreter, before using its profile reader.
      handoff.hostPolicy(options.handoffRelease,this);
      this.#wire=wire.localCodexProfile(options.handoffRelease.python);
    } else this.#wire=options.handoffWire ? wire.configure(options.handoffWire) : null;
    this.#handoff = handoff.hostPolicy(options.handoffRelease, this, this.#wire);
    if(this.#wire && (!this.#handoff || options.runner || options.claudeRunner || this.#dispatchProfile !== 'standard' || this.#initialLoopback)) throw Error('wire-requires-exclusive-enrolled-host');
    if (this.#handoff && !this.#wire && (this.#dispatchProfile !== 'standard' || this.#initialLoopback || !options.runner || options.runner === runPeerRequest))
      throw new TypeError('handoff isolated rehearsal requires its scripted writer');
    this.maxRunsPerTicket = positiveInteger(options.maxRunsPerTicket ?? 2, 'maxRunsPerTicket');
    this.maxTaskTextChars = positiveInteger(options.maxTaskTextChars ?? 6000, 'maxTaskTextChars');
    this.defaultTokenBudget = options.defaultTokenBudget == null ? null
      : positiveInteger(options.defaultTokenBudget, 'defaultTokenBudget');
    this.maxAuditFiles = positiveInteger(options.maxAuditFiles ?? 100000, 'maxAuditFiles');
    this.maxAuditBytes = positiveInteger(options.maxAuditBytes ?? 2 * 1024 * 1024 * 1024, 'maxAuditBytes');
    this.auditHashFileLimit = positiveInteger(options.auditHashFileLimit ?? 64 * 1024, 'auditHashFileLimit');
    this.runner = options.runner ?? runPeerRequest;
    this.locate = options.locate ?? locateCodex;
    this.authMode = options.authMode ?? 'relay';
    if (!['relay', 'login'].includes(this.authMode))
      throw new TypeError('authMode must be relay or login');
    this.authProbe = options.authProbe ?? (this.authMode === 'relay'
      ? (_executable, context) => probeRelay(context.codexHome) : probeLogin);
    const claudeMaxBudgetUsd = options.claudeMaxBudgetUsd ?? null;
    if (claudeMaxBudgetUsd !== null && (typeof claudeMaxBudgetUsd !== 'number' || !Number.isFinite(claudeMaxBudgetUsd)
      || claudeMaxBudgetUsd <= 0))
      throw new TypeError('claudeMaxBudgetUsd must be a positive finite number');
    this.claude = { path: options.claudePath ?? '', claudePath: options.claudePath ?? '', home: claudeHome(options.claudeHome),
      model: options.claudeModel ?? '', maxBudgetUsd: claudeMaxBudgetUsd,
      runTimeoutMs: options.runTimeoutMs ?? 900000 };
    this.claudeLocate = options.claudeLocate ?? locateClaude;
    this.claudeProbe = options.claudeProbe ?? probeClaudeRelay;
    this.claudeRunner = options.claudeRunner ?? runClaudeRequest;
    this.checkTimeoutMs = positiveInteger(options.checkTimeoutMs ?? 120000, 'checkTimeoutMs');
    this.recoveryMode = options.recoveryMode ?? 'observe';
    if (!['off', 'observe'].includes(this.recoveryMode))
      throw new TypeError('recoveryMode must be off or observe; enforce is not implemented');
    this.busy = new Map();
    this.mutationOwners = new Map();
    this.checksBusy = new Map();
    this.verificationRunner = options.verificationRunner ?? runVerification;
    this.writerRunner = options.writerRunner ?? runWriter;
    // Explicit source-level API only; the six DSH tools do not expose diagnose.
    // Never discover provider credentials from HOME, process.env or ticket data.
    this.diagnosisSettings = options.diagnosisSettings ? structuredClone(options.diagnosisSettings) : null;
    this.diagnosisOptions = options.diagnosisOptions ? structuredClone(options.diagnosisOptions) : {};
    this.freshSettingsFile = options.freshSettingsFile ?? null;
    this.freshOptions = structuredClone(options.freshOptions ?? {});
    this.peer = {
      config: {
        codexPath: options.codexPath ?? '',
        codexHome: resolve(options.codexHome || process.env.CODEX_HOME || join(homedir(), '.codex')),
        stateDir: join(this.stateDir, 'codex-peer'), model: options.model ?? '',
        defaultMode: 'implement', defaultSandbox: 'workspace-write',
        runTimeoutMs: options.runTimeoutMs ?? 900000, callTimeoutMs: options.runTimeoutMs ?? 900000,
        maxAnswerBytes: 12000, progressKeepLines: 200, terminateGraceMs: 5000,
        extraArgs: [], promptPreamble: PREAMBLE, workspaceDir: '',
      },
      ledger: createLedger({ dir: join(this.stateDir, 'codex-peer') }),
    };
  }

  status(probe = true) {
    if (this.#dispatchProfile === 'blind-trial') {
      const held = this.#blindHold(null);
      // Being stopped by policy says nothing about installation or account readiness.
      const provider = { available: null, ready: false, reason: held.reason };
      return { enabled: this.enabled, dispatchProfile: 'blind-trial', admitted: false, reason: held.reason,
        missing: held.missing, providers: { codex: { ...provider }, claude: { ...provider },
          deepseek: { available: false, reason: 'coding-session-adapter-not-integrated' } },
        activeTickets: [...this.busy.keys()], unitedConfigured: Boolean(this.united) };
    }
    const codex = this.locate(this.peer.config);
    const login = probe && codex.available
      ? this.authProbe(codex.path, { codexHome: this.peer.config.codexHome }) : null;
    const claude = this.claudeLocate(this.claude);
    const claudeAuth = probe && claude.available ? this.claudeProbe(this.claude.home) : null;
    return {
      enabled: this.enabled,
      providers: {
        codex: { available: codex.available, executable: codex.path ?? null,
          authMode: this.authMode,
          ready: login?.ready ?? false,
          reason: !codex.available ? 'cli-not-found' : login?.reason ?? 'cli-found; auth-not-probed' },
        deepseek: { available: false, reason: 'coding-session-adapter-not-integrated' },
        claude: { available: claude.available, executable: claude.path,
          authMode: 'relay', ready: claudeAuth?.ready ?? false,
          reason: !claude.available ? 'cli-not-found' : claudeAuth?.reason ?? 'cli-found; auth-not-probed',
          cliBudgetUsd: this.claude.maxBudgetUsd },
      },
      activeTickets: [...this.busy.keys()], unitedConfigured: Boolean(this.united),
      maxRunsPerTicket: this.maxRunsPerTicket,
      recovery: { ...PROGRESS_CAPABILITIES, mode: this.recoveryMode },
      maxTaskTextChars: this.maxTaskTextChars, defaultTokenBudget: this.defaultTokenBudget,
      tokenBudgetEnforcement: 'before-next-run-only',
    };
  }

  ticketPath(ticketId) {
    if (typeof ticketId !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(ticketId))
      throw new TypeError('ticketId must be 8–80 letters, digits, _ or -');
    return join(this.stateDir, 'tickets', ticketId + '.json');
  }
  readTicket(ticketId) {
    const path = this.ticketPath(ticketId);
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  }
  ticketStatus(ticketId) {
    const record = this.readTicket(ticketId);
    return record ? { ...summary(record, this.recoveryMode), recovery: progressView(record,
      { mode: this.recoveryMode, locallyRunning: this.busy.has(ticketId) }),
      mutationLocked: existsSync(this.ticketPath(ticketId) + '.lock') || existsSync(this.ticketPath(ticketId) + '.reconcile.lock') }
      : { ticketId, status: 'not-found', mutationLocked: existsSync(this.ticketPath(ticketId) + '.lock')
        || existsSync(this.ticketPath(ticketId) + '.reconcile.lock') };
  }
  saveTicket(record) {
    mkdirSync(join(this.stateDir, 'tickets'), { recursive: true });
    const path = this.ticketPath(record.ticketId), tx = this.mutationOwners.get(record.ticketId);
    const current = existsSync(path) ? readFileSync(path) : null;
    const priorRecord = current && JSON.parse(current.toString('utf8'));
    const protectedRecord = hasWriterRecord(record) || (priorRecord && hasWriterRecord(priorRecord));
    if (Object.hasOwn(record,'initialProbe') || (priorRecord && Object.hasOwn(priorRecord,'initialProbe'))) {
      this.assertMutationOwner(record.ticketId);
      const prior = priorRecord;
      if (tx.owner.operation !== 'initial-loopback' || protectedRecord || !record.initialProbe ||
          (!prior ? record.initialProbe.phase !== 'intent' : prior.initialProbe?.phase !== 'intent' ||
           !['observed','unknown','stale'].includes(record.initialProbe.phase) ||
           JSON.stringify(prior.initialProbe.binding) !== JSON.stringify(record.initialProbe.binding)))
        throw Error('initial-ticket-publication-fenced');
      atomicJson(path, record);
      tx.expectedHash = hash(Buffer.from(JSON.stringify(record,null,2)+'\n'));
      return;
    }
    if (!protectedRecord) { atomicJson(path, record); return; }
    // The wx mutation claim serializes cooperating processes; comparison and
    // atomic publication occur under that same owner. Not an OS CAS against an
    // arbitrary same-user editor writing outside this protocol.
    try {
      if (!tx || record.writerPolicy !== 1) throw new Error('writer-owner-or-policy-required');
      const owner = JSON.parse(readFileSync(tx.ownerPath, 'utf8'));
      if (owner.token !== tx.owner.token || owner.pid !== process.pid)
        throw new Error('writer-owner-fenced');
      if ((current ? hash(current) : null) !== tx.expectedHash) throw new Error('writer-ticket-version-conflict');
      const previous = priorRecord;
      const a = record.writerAuthority, prior = previous?.writerAuthority;
      const held = writerHold(record);
      if (held && held !== 'writer-process-tree-unconfirmed') throw new Error(held);
      if (prior) {
        const sameGeneration = a.generation === prior.generation && JSON.stringify(a.identity) === JSON.stringify(prior.identity);
        const successor = a.generation === prior.generation + 1 && a.token !== prior.token && a.status === 'running'
          && a.attemptId !== prior.attemptId && !writerHold(previous);
        if ((!sameGeneration && !successor) || (sameGeneration && prior.status === 'stopped' && a.status !== 'stopped'))
          throw new Error('writer-generation-fenced');
        if (record.runs.length < previous.runs.length || previous.runs.some((run, i) => record.runs[i]?.attemptId !== run.attemptId))
          throw new Error('writer-attempt-history-truncation-refused');
      } else if (previous || a.generation !== 1 || a.status !== 'running') throw new Error('writer-initial-generation-required');
      const bytes = Buffer.from(JSON.stringify(record, null, 2) + '\n');
      atomicJson(path, record);
      tx.expectedHash = hash(bytes);
    } catch (error) { if (tx) tx.retain = true; throw error; }
  }
  assertMutationOwner(ticketId) {
    const tx = this.mutationOwners.get(ticketId), path = this.ticketPath(ticketId);
    try {
      if (!tx || JSON.parse(readFileSync(tx.ownerPath, 'utf8')).token !== tx.owner.token)
        throw new Error('writer-owner-fenced');
      if ((existsSync(path) ? hash(readFileSync(path)) : null) !== tx.expectedHash)
        throw new Error('writer-ticket-version-conflict');
    } catch (error) { if (tx) tx.retain = true; throw error; }
  }
  resolveWorkspace(requested, exec) {
    const sessionCwd = exec?.agent?.session?.header?.cwd;
    const raw = requested ?? sessionCwd;
    if (!raw || !isAbsolute(raw)) throw new TypeError('an absolute workspace is required');
    const cwd = realpathSync(raw);
    if (!statSync(cwd).isDirectory()) throw new TypeError('workspace is not a directory');
    const stateDir = canonicalPath(this.stateDir);
    if (inside(cwd, stateDir) || inside(stateDir, cwd))
      throw new TypeError('state directory overlaps workspace');
    const roots = this.allowedRoots.length ? this.allowedRoots : sessionCwd ? [realpathSync(sessionCwd)] : [];
    if (!roots.some(root => inside(root, cwd))) throw new TypeError('workspace is outside the configured/session root');
    return cwd;
  }

  // Exclusive mutation for the whole attempt, including independent verify.
  // A crash leaves a lock for reconciliation; PID disappearance is not proof
  // that a worker or external operation did not happen. Never steal by age.
  acquireTicketLock(ticketId, operation = 'mutation') {
    const path = this.ticketPath(ticketId) + '.lock';
    const guard = this.ticketPath(ticketId) + '.reconcile.lock';
    if (existsSync(guard)) return null;
    mkdirSync(dirname(path), { recursive: true });
    const token = randomUUID();
    let fd;
    try { fd = openSync(path, 'wx'); }
    catch (error) { if (error.code === 'EEXIST') return null; throw error; }
    const owner = { token, pid: process.pid, operation, at: new Date().toISOString() };
    try { writeFileSync(fd, JSON.stringify(owner)); }
    finally { closeSync(fd); }
    const tx = { owner, ownerPath: path, expectedHash: fileHash(this.ticketPath(ticketId)), retain: false };
    this.mutationOwners.set(ticketId, tx);
    const release = () => {
      if (this.mutationOwners.get(ticketId) !== tx) return;
      this.mutationOwners.delete(ticketId);
      if (tx.retain) return;
      // Do not remove a lock replaced by a different owner.
      if (existsSync(path)) {
        let current;try { current = JSON.parse(readFileSync(path, 'utf8')); } catch { return; }
        if (current.token === token) rmSync(path);
      }
    };
    release.owner = owner;
    // A reconciler may have claimed its guard between our first check and wx.
    // Release only our own lock, before any operation or ticket read can run.
    if (existsSync(guard)) { release(); return null; }
    return release;
  }
  locked(ticketId) {
    return { ticketId, accepted: false, reason: 'ticket-mutation-locked; reconcile-owner-before-retry' };
  }
  reconciliationHold(ticketId) {
    const record = this.readTicket(ticketId);
    if(record && Object.hasOwn(record,'initialProbe')) return {ticketId,accepted:false,reason:'initial-ticket-consumed; no-replay'};
    if(record && implementationAttempt(record)?.fresh?.providerOutcomeKnown===false)
      return {...summary(record,this.recoveryMode),accepted:false,reason:'fresh-provider-outcome-unknown; no-replay'};
    if (record && diagnosisHold(record))
      return { ...summary(record, this.recoveryMode), accepted: false, reason: diagnosisHold(record) };
    if (record && hasWriterRecord(record)) {
      const held = writerHold(record);
      if (held) return { ...summary(record, this.recoveryMode), accepted: false, reason: held };
      try {
        const evidence = readWriterEvidence(this.stateDir, record.writerAuthority);
        if (evidence.receipt.receiptSha256 !== record.writerAuthority.terminal.sha256)
          throw new Error('writer-terminal-receipt-changed');
      } catch (error) { return { ...summary(record, this.recoveryMode), accepted: false, reason: error.message }; }
    }
    if (record && (record.reconciliation?.required
      || ['running', 'outcome-unknown'].includes(record.verification?.status)))
      return { ...summary(record, this.recoveryMode), accepted: false, reason: 'reconciliation-required' };
    return null;
  }
  // Not registered as a DSH tool. The operator provides only pre-approved local fixtures.
  async inspectInitialTicket(ticketId) {
    if (this.#dispatchProfile === 'blind-trial') return {accepted:false,...this.#blindHold(ticketId)};
    if (!this.enabled || !this.#initialLoopback || !this.united)
      return {accepted:false,ticketId,reason:'initial-ticket-not-configured'};
    this.ticketPath(ticketId);
    const {inspectOriginalTicket} = await import('./initial-ticket.mjs');
    return inspectOriginalTicket(this,this.#initialLoopback,ticketId);
  }
  async recoverInitialCandidate(ticketId) {
    if (arguments.length!==1) throw new TypeError('initial-recovery-ticket-id-only');
    if (this.#dispatchProfile==='blind-trial') return {recovered:false,...this.#blindHold(ticketId)};
    if (!this.enabled || !this.#initialLoopback || !this.united) return {ticketId,recovered:false,reason:'initial-ticket-not-configured'};
    this.ticketPath(ticketId);
    const {recoverOriginalCandidate}=await import('./initial-ticket.mjs');
    try {return recoverOriginalCandidate(this,this.#initialLoopback,ticketId);}
    catch(error) {return {ticketId,recovered:false,reason:/^initial-[a-z0-9-]+$/.test(error.message)?error.message:'initial-candidate-read-failed'};}
  }
  // Dedicated offline host only. Reading after grading must not reconstruct a missing tree.
  async initialTextStage(ticketId,mode='prepare') {
    if(!['prepare','read'].includes(mode) || arguments.length>2) throw Error('initial-stage-arguments-invalid');
    if(this.#dispatchProfile==='blind-trial')return {ready:false,...this.#blindHold(ticketId)};
    if(!this.enabled || !this.#initialLoopback || !this.united)return {ready:false,ticketId,reason:'initial-ticket-not-configured'};
    this.ticketPath(ticketId);
    const {originalTextStage}=await import('./initial-text-stage.mjs');
    try{return originalTextStage(this,this.#initialLoopback,ticketId,mode==='read');}
    catch(e){return {ready:false,ticketId,reason:/^initial-[a-z0-9-]+$/.test(e.message)?e.message:'initial-stage-unavailable'};}
  }
  /** Explicit one-candidate repair, without a CLI or previous conversation. */
  async executeFreshContext(args, exec = {}) {
    exec.signal?.throwIfAborted();
    if (this.#dispatchProfile === 'blind-trial') return { accepted: false, ...this.#blindHold(args?.ticketId) };
    if(!args||Object.keys(args).length!==3||['ticketId','attemptId','inputSha256'].some(k=>!Object.hasOwn(args,k))
      ||typeof args.inputSha256!=='string'||!/^[a-f0-9]{64}$/.test(args.inputSha256))throw new Error('fresh-execute-arguments-invalid');
    this.ticketPath(args.ticketId);this.ticketPath(args.attemptId);
    if(!this.enabled||this.recoveryMode==='off'||!this.freshSettingsFile)
      return {ticketId:args.ticketId,accepted:false,reason:'fresh-execution-not-configured'};
    const {buildFreshContext}=await import('./fresh-context.mjs');
    const {readFreshSettings}=await import('./fresh-executor.mjs');
    const {planFreshRequest,freshLimits}=await import('./fresh-transport.mjs');
    const release=this.acquireTicketLock(args.ticketId,'implement');
    if(!release)return this.locked(args.ticketId);
    try{
      const record=this.readTicket(args.ticketId),prepared=record?.freshContext;
      if(!prepared||prepared.status!=='prepared'||prepared.attemptId!==args.attemptId||prepared.packet.sha256!==args.inputSha256)
        return {ticketId:args.ticketId,accepted:false,reason:'fresh-prepared-selection-required'};
      const held=this.reconciliationHold(args.ticketId);if(held)return held;
      const rebuilt=buildFreshContext({stateDir:this.stateDir,ticketId:args.ticketId,attemptId:args.attemptId,
        diagnosisAttemptId:prepared.diagnosisAttemptId,expectedProposalSha256:prepared.proposalSha256,maxRunsPerTicket:this.maxRunsPerTicket});
      if(JSON.stringify(rebuilt)!==JSON.stringify(prepared))throw new Error('fresh-prepared-packet-changed');
      const source=readFreshSettings(this.freshSettingsFile),limits=freshLimits(this.freshOptions);
      const plan=planFreshRequest(prepared.packet,source.settings,limits);
      exec.signal?.throwIfAborted();this.assertMutationOwner(args.ticketId);
      const c=record.contractSnapshot;
      return await this.dispatchLocked({ticketId:args.ticketId,attemptId:args.attemptId,provider:'codex',resume:true,
        cwd:c.cwd,expectedFiles:c.files,goal:c.goal,deliverable:c.deliverable,acceptance:c.acceptance,
        checkProgram:c.checkProgram,checkArgs:c.checkArgs,workspaceMode:c.workspaceMode,
        ...(record.united?{unitedRunId:record.united.runId,unitedMessageId:record.united.messageId}:{}),followup:'Frozen fresh candidate'},exec,
        {[FRESH_DISPATCH]:true,prepared,settingsFile:resolve(this.freshSettingsFile),settingsSha256:source.sha256,
          limits,plan:{requestSha256:plan.requestSha256,requestBytes:plan.requestBytes,binding:plan.binding,model:plan.body.model}});
    }finally{release();}
  }

  /** Freeze one selection on the same ticket. Does not launch/resume or spend a run. */
  async prepareFreshContext(args, exec = {}) {
    exec.signal?.throwIfAborted();
    if (!args || Object.keys(args).length !== 4
      || ['ticketId', 'attemptId', 'diagnosisAttemptId', 'expectedProposalSha256'].some(key => !Object.hasOwn(args, key)))
      throw new Error('fresh-context-arguments-invalid');
    const { ticketId } = args;
    this.ticketPath(ticketId); this.ticketPath(args.attemptId); this.ticketPath(args.diagnosisAttemptId);
    if (!this.enabled || this.recoveryMode === 'off') return { ticketId, accepted: false, reason: 'fresh-context-disabled' };
    // Load before claiming/reading, so no awaited gap occurs in the preparation transaction.
    const { buildFreshContext, readFreshContextTicket, FRESH_CONTEXT_MAX_TICKET_BYTES } = await import('./fresh-context.mjs');
    // Preflight before the existing owner/CAS code reads the raw ticket version.
    if (!existsSync(this.ticketPath(ticketId))) return { ticketId, accepted: false, reason: 'ticket-not-found' };
    readFreshContextTicket(this.stateDir, ticketId);
    const release = this.acquireTicketLock(ticketId, 'prepare-fresh-context');
    if (!release) return this.locked(ticketId);
    try {
      const { record } = readFreshContextTicket(this.stateDir, ticketId);
      const held = this.reconciliationHold(ticketId); if (held) return held;
      this.resolveWorkspace(record.cwd, exec);
      const audit = () => {
        this.assertMutationOwner(ticketId);
        if (record.stage) this.assertStageSource(record);
        if (record.united) {
          if (!this.united) throw new Error('fresh-context-united-not-configured');
          const link = this.united.link({ ...record.united, ticketId,
            goal: record.contractSnapshot.goal, acceptance: record.contractSnapshot.acceptance });
          if (JSON.stringify(link) !== JSON.stringify(record.united)) throw new Error('fresh-context-united-link-changed');
        }
        const scope = workspaceSnapshot(record.stage?.path ?? record.cwd,
          this.maxAuditFiles, this.maxAuditBytes, this.auditHashFileLimit);
        const fingerprint = scopeFingerprint(scope), last = implementationAttempt(record);
        if (!fingerprint || fingerprint !== record.verification?.beforeScopeFingerprint
          || fingerprint !== (last?.workspaceScopeFingerprint ?? last?.stageScopeFingerprint)
          || fingerprint !== diagnosisAttempt(record)?.beforeScopeFingerprint)
          throw new Error('fresh-context-workspace-changed');
      };
      audit();
      const prepared = buildFreshContext({ ...args, stateDir: this.stateDir, maxRunsPerTicket: this.maxRunsPerTicket });
      if (record.freshContext && JSON.stringify(record.freshContext) !== JSON.stringify(prepared))
        throw new Error('fresh-context-already-prepared-or-changed');
      exec.signal?.throwIfAborted(); audit();
      const replayed = Boolean(record.freshContext);
      if (!replayed) {
        record.freshContext = prepared;
        if (Buffer.byteLength(JSON.stringify(record, null, 2) + '\n') > FRESH_CONTEXT_MAX_TICKET_BYTES)
          throw new Error('fresh-context-ticket-byte-budget-exceeded');
        this.saveTicket(record);
      }
      return { ticketId, accepted: true, status: 'prepared-only', attemptId: prepared.attemptId,
        diagnosisAttemptId: prepared.diagnosisAttemptId, inputSha256: prepared.packet.sha256,
        inputBytes: prepared.packet.bytes, replayed, executionEnabled: false, modelCalls: 0, automaticAction: 'none' };
    } finally { release(); }
  }

  /** One explicit diagnostic call, counted in the original runs; never dispatch an experiment. */
  async diagnose({ ticketId, attemptId }, exec = {}) {
    exec.signal?.throwIfAborted();
    if (this.#dispatchProfile === 'blind-trial') return { accepted: false, ...this.#blindHold(ticketId) };
    this.ticketPath(ticketId); this.ticketPath(attemptId);
    if (!this.enabled || !this.diagnosisSettings || this.recoveryMode === 'off')
      return { ticketId, accepted: false, reason: 'diagnosis-not-configured' };
    const release = this.acquireTicketLock(ticketId, 'diagnose');
    if (!release) return this.locked(ticketId);
    let retainLock = false;
    try { return await this.diagnoseLocked(ticketId, attemptId, exec, () => { retainLock = true; }); }
    finally { if (!retainLock) release(); }
  }
  async diagnoseLocked(ticketId, attemptId, exec, retainLock) {
    // Resolve modules before reading the ticket. There must be no awaited gap
    // between the authoritative snapshot and durable diagnostic intent.
    const { buildDiagnosisInput } = await import('./diagnosis-input.mjs');
    const { planDiagnosisRequest, requestDiagnosis } = await import('./diagnosis-transport.mjs');
    const path = this.ticketPath(ticketId);
    if (!existsSync(path)) return { ticketId, accepted: false, reason: 'ticket-not-found' };
    const originalBytes = readFileSync(path), originalHash = hash(originalBytes);
    const record = JSON.parse(originalBytes.toString('utf8'));
    const ticketMatches = expected => { try { return hash(readFileSync(path)) === expected; } catch { return false; } };
    const prior = record.runs.find(run => run.attemptId === attemptId);
    if (prior) return { ...summary(record, this.recoveryMode), accepted: false,
      reason: 'attempt-already-recorded', replayed: false };
    const held = this.reconciliationHold(ticketId);
    if (held) return held;
    if (diagnosisAttempt(record)) return { ...summary(record, this.recoveryMode), accepted: false, reason: 'diagnosis-already-recorded' };
    if (record.provider !== 'codex') return { ticketId, accepted: false, reason: 'diagnosis-provider-not-supported' };
    const limit = Math.min(record.effectiveMaxRuns ?? 2, this.maxRunsPerTicket);
    // Reserve the final implementation slot before diagnosis. Old two-run
    // tickets cannot inherit a new instance's three-run experiment policy.
    if (!Number.isSafeInteger(limit) || limit < 3 || record.runs.length + 1 >= limit)
      return { ticketId, accepted: false, reason: 'diagnosis-repair-slot-unavailable' };
    const used = spentTokens(record);
    if (used === null) return { ticketId, accepted: false, reason: 'token-usage-unknown' };
    if (record.tokenBudget != null && used >= record.tokenBudget)
      return { ticketId, accepted: false, reason: 'token-budget-reached' };
    this.resolveWorkspace(record.cwd, exec);
    if (record.stage) this.assertStageSource(record);
    if (record.united) {
      if (!this.united) return { ticketId, accepted: false, reason: 'united-not-configured' };
      const link = this.united.link({ ...record.united, ticketId,
        goal: record.contractSnapshot?.goal, acceptance: record.contractSnapshot?.acceptance });
      if (JSON.stringify(link) !== JSON.stringify(record.united)) throw new Error('diagnosis-united-link-changed');
    }
    const input = buildDiagnosisInput({ stateDir: this.stateDir, ticketId });
    if (input.manifest[0]?.sha256 !== originalHash) throw new Error('diagnosis-ticket-changed-during-assembly');
    const settings = structuredClone(this.diagnosisSettings), options = { ...this.diagnosisOptions };
    if (Object.keys(options).some(key => !['timeoutMs', 'maxResponseBytes', 'maxInputBytes', 'maxRequestBytes', 'maxOutputTokens'].includes(key)))
      throw new Error('diagnosis-options-invalid');
    for (const [key, maximum] of [['timeoutMs', 300000], ['maxResponseBytes', 4 * 1024 * 1024]]) {
      if (Object.hasOwn(options, key) && (!Number.isSafeInteger(options[key]) || options[key] < 1 || options[key] > maximum))
        throw new Error('diagnosis-options-invalid');
    }
    const plan = planDiagnosisRequest(input, settings, options);
    const last = implementationAttempt(record), workCwd = record.stage?.path ?? record.cwd;
    const beforeScope = workspaceSnapshot(workCwd, this.maxAuditFiles, this.maxAuditBytes, this.auditHashFileLimit);
    const beforeFingerprint = scopeFingerprint(beforeScope);
    if (beforeFingerprint !== record.verification.beforeScopeFingerprint)
      throw new Error('diagnosis-workspace-changed-after-check');
    exec.signal?.throwIfAborted();
    // Material binding.attemptId remains the *implementation* being diagnosed.
    // This new call has its own attempt ID and consumes the same original quota.
    const attempt = { kind: 'diagnose', attemptId, sourceImplementationAttemptId: last.attemptId,
      sourceCheckId: record.verification.checkId, inputSha256: input.sha256, inputBytes: input.bytes,
      inputManifest: input.manifest, requestSha256: plan.requestSha256, requestBytes: plan.requestBytes,
      requestedModel: plan.body.model, endpointSha256: hash(plan.url),
      status: 'running', outcomeKnown: false, requestCount: null, usage: null, costUsd: null,
      cancellationRequested: false, scopeUnchanged: null, proposal: null,
      beforeScopeFingerprint: beforeFingerprint, startedAt: new Date().toISOString(), endedAt: null };
    record.lastImplementationAttemptId = last.attemptId;
    record.activeArtifactAttemptId = artifactAttempt(record)?.attemptId ?? null;
    record.runs.push(attempt); record.updatedAt = attempt.startedAt;
    if (!ticketMatches(originalHash)) throw new Error('diagnosis-ticket-changed-before-intent');
    this.saveTicket(record); // Durable intent BEFORE any network call. Lost owner stays held.
    const intentHash = hash(JSON.stringify(record, null, 2) + '\n');
    if (!ticketMatches(intentHash)) { retainLock(); throw new Error('diagnosis-ticket-changed-after-intent; lock-retained'); }
    const controller = new AbortController(), abort = () => controller.abort(exec.signal.reason);
    exec.signal?.addEventListener('abort', abort, { once: true }); this.busy.set(ticketId, controller);
    if (exec.signal?.aborted) abort();
    let ticketConflict = false;
    try {
      const result = await requestDiagnosis(input, settings, { ...options, signal: controller.signal });
      Object.assign(attempt, { status: result.accepted ? 'proposal' : result.lifecycle === 'not-started' ? 'not-started'
        : result.providerOutcomeKnown ? 'rejected' : 'outcome-unknown',
        outcomeKnown: result.providerOutcomeKnown === true || result.lifecycle === 'not-started',
        requestCount: result.requestCount, usage: result.usage, costUsd: result.costUsd,
        responseId: result.responseId, reportedModel: result.reportedModel, responseSha256: result.responseSha256 ?? null,
        reason: result.reason, proposal: result.diagnosis, endedAt: result.endedAt });
    } catch {
      // Never persist exception prose: it may contain credentials. The durable
      // intent is conservatively unknown even if setup failed before network IO.
      Object.assign(attempt, { status: 'outcome-unknown', reason: 'diagnosis-call-outcome-unknown', endedAt: new Date().toISOString() });
    } finally {
      attempt.cancellationRequested = controller.signal.aborted;
      if (attempt.cancellationRequested) { attempt.status = 'aborted'; attempt.proposal = null; }
      try {
        const afterScope = workspaceSnapshot(workCwd, this.maxAuditFiles, this.maxAuditBytes, this.auditHashFileLimit);
        if (record.stage) this.assertStageSource(record);
        if (record.united) {
          const link = this.united.link({ ...record.united, ticketId,
            goal: record.contractSnapshot.goal, acceptance: record.contractSnapshot.acceptance });
          if (JSON.stringify(link) !== JSON.stringify(record.united)) throw new Error('diagnosis-united-link-changed');
        }
        attempt.scopeUnchanged = scopeFingerprint(afterScope) === beforeFingerprint;
      } catch { attempt.scopeUnchanged = false; }
      if (!attempt.scopeUnchanged) {
        attempt.proposal = null; record.activeArtifactAttemptId = null;
        attempt.reason = 'diagnosis-scope-reconciliation-required';
      }
      record.updatedAt = new Date().toISOString();
      try {
        // Cooperative mutators share this lock; external edits still must never
        // be silently overwritten after a network wait. Keep the original lock
        // on conflict, even if the other writer removed the diagnostic row.
        if (!ticketMatches(intentHash)) {
          ticketConflict = true; attempt.proposal = null; retainLock();
        } else this.saveTicket(record);
      }
      finally { exec.signal?.removeEventListener('abort', abort); this.busy.delete(ticketId); }
    }
    if (ticketConflict) return { ticketId, accepted: false, reason: 'diagnosis-ticket-changed; lock-retained',
      usage: attempt.usage, costUsd: attempt.costUsd, outcomeKnown: attempt.outcomeKnown,
      mutationLocked: true, automaticAction: 'none', replayed: false };
    return { ...summary(record, this.recoveryMode), accepted: attempt.status === 'proposal'
      && attempt.scopeUnchanged && !attempt.cancellationRequested, automaticAction: 'none', replayed: false };
  }
  // The write capability is private. Generic saveTicket still cannot rewrite an observed probe.
  async #rankStep(op,id,signal) {
    const flag={verify:'verified',promote:'promoted',submit:'submitted'}[op];
    const release=this.acquireTicketLock(id,'rank-'+op);
    if(!release)return {...this.locked(id),[flag]:false};
    try {
      const {rankStep}=await import('./rank-delivery.mjs');
      const save=next=>{
        this.assertMutationOwner(id);
        const record=this.readTicket(id);record.rankDelivery=next;
        atomicJson(this.ticketPath(id),record);
        this.mutationOwners.get(id).expectedHash=hash(Buffer.from(JSON.stringify(record,null,2)+'\n'));
      };
      return await rankStep(this,this.#initialLoopback,id,op,save,signal);
    } catch(e){return {ticketId:id,[flag]:false,reason:e.message};} finally {release();}
  }
  async dispatch(args, exec = {}) {
    exec.signal?.throwIfAborted();
    if (this.#dispatchProfile === 'blind-trial') return { accepted: false, ...this.#blindHold(args?.ticketId) };
    if(this.#rankDelivery){
      const {dispatchRank}=await import('./rank-delivery.mjs');
      try{return await dispatchRank(this,this.#initialLoopback,args);}catch(e){return {accepted:false,ticketId:args?.ticketId,reason:e.message};}
    }
    if (this.#initialLoopback) return {accepted:false,ticketId:args?.ticketId,reason:'initial-loopback-host-only'};
    if (Object.hasOwn(args, 'dispatchProfile')) return { accepted: false, reason: 'dispatch-profile-is-host-only' };
    if (!this.enabled || !['codex', 'claude'].includes(args.provider ?? 'codex')) return this.dispatchLocked(args, exec);
    if (this.busy.has(args.ticketId)) return { accepted: false, ticketId: args.ticketId, reason: 'ticket-already-running' };
    const release = this.acquireTicketLock(args.ticketId, 'implement');
    if (!release) return this.locked(args.ticketId);
    try { return this.reconciliationHold(args.ticketId) ?? await this.dispatchLocked(args, exec); }
    finally { release(); }
  }
  async dispatchLocked(args, exec = {}, fresh = null) {
    exec.signal?.throwIfAborted();
    if (this.#dispatchProfile === 'blind-trial') return { accepted: false, ...this.#blindHold(args?.ticketId) };
    if (this.#initialLoopback) return {accepted:false,ticketId:args?.ticketId,reason:'initial-loopback-host-only'};
    if(fresh&&fresh[FRESH_DISPATCH]!==true)throw new Error('fresh-internal-authority-required');
    const provider = args.provider ?? 'codex';
    if (!['codex', 'claude'].includes(provider))
      return { accepted: false, provider, reason: provider + '-adapter-not-integrated' };
    if (!this.enabled) return { accepted: false, provider, reason: 'coding-dispatch-disabled' };
    if (this.#handoff || args.deliverable===handoff.kind || args.acceptance===handoff.acceptance) {
      try { if(fresh || !this.#handoff)throw Error('handoff-host-required');handoff.admit(this,this.#handoff,args); }
      catch(e){return {accepted:false,ticketId:args.ticketId,reason:e.message};}
    }
    const located = fresh || this.#wire ? {available:true,path:process.execPath}
      : provider === 'codex' ? this.locate(this.peer.config) : this.claudeLocate(this.claude);
    if (!located.available) return { accepted: false, provider, reason: provider + '-cli-not-found' };
    const auth = fresh || this.#wire ? {ready:true} : provider === 'codex'
      ? this.authProbe(located.path, { codexHome: this.peer.config.codexHome })
      : this.claudeProbe(this.claude.home);
    if (!auth.ready) return { accepted: false, provider, reason: provider + '-' + auth.reason };
    const ticketId = requiredText(args.ticketId, 'ticketId', 80);
    this.ticketPath(ticketId);
    if (this.busy.has(ticketId)) return { accepted: false, ticketId, reason: 'ticket-already-running' };
    const cwd = this.resolveWorkspace(args.cwd, exec);
    const files = expectedFiles(cwd, args.expectedFiles);
    const goal = requiredText(args.goal, 'goal');
    const deliverable = requiredText(args.deliverable, 'deliverable');
    const acceptance = requiredText(args.acceptance, 'acceptance');
    let united = null;
    if (args.unitedRunId !== undefined || args.unitedMessageId !== undefined) {
      if (!args.unitedRunId || !args.unitedMessageId)
        return { accepted: false, ticketId, reason: 'united-link-incomplete' };
      if (!this.united) return { accepted: false, ticketId, reason: 'united-not-configured' };
      try {
        united = this.united.link({ runId: args.unitedRunId, messageId: args.unitedMessageId,
          ticketId, goal, acceptance });
      } catch (error) {
        return { accepted: false, ticketId, reason: 'united-link-invalid', detail: error.message };
      }
    }
    const checkProgram = this.#handoff ? this.#handoff.python : args.checkProgram === undefined ? null : requiredText(args.checkProgram, 'checkProgram', 500);
    if (checkProgram?.includes('\0')) throw new TypeError('checkProgram must not contain NUL');
    const checkArgs = this.#handoff ? handoff.argv(this.#handoff) : args.checkArgs ?? [];
    if (!Array.isArray(checkArgs) || checkArgs.length > 32 || checkArgs.some(value => typeof value !== 'string' || value.length > 500 || value.includes('\0')))
      throw new TypeError('checkArgs must be at most 32 short strings without NUL');
    const workspaceMode = args.workspaceMode ?? 'direct';
    if (!['direct', 'git-worktree'].includes(workspaceMode))
      throw new TypeError('workspaceMode must be direct or git-worktree');
    if (united && workspaceMode !== 'git-worktree')
      return { accepted: false, ticketId, reason: 'united-link-requires-staged-workspace' };
    if (united && !checkProgram)
      return { accepted: false, ticketId, reason: 'united-link-requires-independent-check' };
    const old = this.readTicket(ticketId);
    if(fresh && (!old || JSON.stringify(old.freshContext)!==JSON.stringify(fresh.prepared)))
      return {accepted:false,ticketId,reason:'fresh-prepared-selection-changed'};
    const nativeWriter = this.#wire ? false : fresh ? true : provider === 'codex' ? this.runner === runPeerRequest : this.claudeRunner === runClaudeRequest;
    if (old && nativeWriter && old.writerPolicy !== 1)
      return { accepted: false, ticketId, reason: 'legacy-writer-terminal-evidence-required' };
    if (old?.writerPolicy === 1 && !nativeWriter)
      return { accepted: false, ticketId, reason: 'writer-transport-downgrade-refused' };
    if (old?.contractSnapshot && hash(JSON.stringify(old.contractSnapshot)) !== old.contractHash)
      return { accepted: false, ticketId, reason: 'stored-contract-snapshot-mismatch' };
    const tokenBudget = args.tokenBudget === undefined ? old?.tokenBudget ?? this.defaultTokenBudget
      : positiveInteger(args.tokenBudget, 'tokenBudget');
    const contract = { cwd, files, goal, deliverable, acceptance,
      checkProgram, checkArgs, workspaceMode, ...(united ? { united } : {}) };
    const contractHash = hash(JSON.stringify(contract));
    // Legacy tickets included the initial token budget in their immutable contract.
    const legacyHash = old ? hash(JSON.stringify({ cwd, files, goal, deliverable, acceptance,
      checkProgram, checkArgs, workspaceMode, tokenBudget: old.tokenBudget,
      ...(united ? { united } : {}) })) : null;
    if (old && !args.resume) return { accepted: false, ...summary(old, this.recoveryMode), reason: 'ticket-already-exists; use resume for another run' };
    if (args.resume && !old) return { accepted: false, ticketId, reason: 'ticket-not-found' };
    const attemptId = args.resume ? requiredText(args.attemptId, 'attemptId', 80) : ticketId;
    this.ticketPath(attemptId);
    const followup = args.resume ? requiredText(args.followup, 'followup') : null;
    const taskTextChars = goal.length + deliverable.length + acceptance.length + (followup?.length ?? 0);
    if (taskTextChars > this.maxTaskTextChars)
      return { accepted: false, ticketId, reason: 'task-text-budget-exceeded',
        taskTextChars, maxTaskTextChars: this.maxTaskTextChars };
    if (old?.runs.some(run => run.attemptId === attemptId))
      return { accepted: false, ...summary(old, this.recoveryMode), reason: 'attempt-already-recorded' };
    if (old && (![contractHash, legacyHash].includes(old.contractHash) || old.provider !== provider))
      return { accepted: false, ticketId, reason: 'ticket-contract-changed' };
    if (old && tokenBudget !== null && old.tokenBudget != null && tokenBudget < old.tokenBudget)
      return { accepted: false, ticketId, reason: 'token-budget-decrease-refused' };
    // Freeze new ticket limits. A new instance cannot silently grant legacy
    // preview.22 tickets more than their known default of two attempts.
    const effectiveMaxRuns = old?.effectiveMaxRuns ?? (old ? Math.min(2, this.maxRunsPerTicket) : this.maxRunsPerTicket);
    positiveInteger(effectiveMaxRuns, 'effectiveMaxRuns');
    if (old && old.runs.length >= Math.min(effectiveMaxRuns, this.maxRunsPerTicket))
      return { accepted: false, ticketId, reason: 'run-limit-reached' };
    if (old && diagnosisAttempt(old) && spentTokens(old) === null)
      return { accepted: false, ticketId, reason: 'token-usage-unknown' };
    if (old && tokenBudget !== null) {
      const used = spentTokens(old);
      if (used === null) return { accepted: false, ticketId, reason: 'token-usage-unknown' };
      if (used >= tokenBudget) return { accepted: false, ticketId, reason: 'token-budget-reached',
        used, tokenBudget };
    }
    const nativeSessionId = fresh ? undefined : old ? implementationAttempt(old)?.nativeSessionId : undefined;
    if (nativeWriter && old && implementationAttempt(old)?.cancellationRequested)
      return { accepted: false, ticketId, reason: 'writer-cancelled-no-resume' };
    if(this.#wire && old && (old.runs.length!==1 || old.runs[0].wire?.route!==this.#wire.tag || old.runs[0].status!=='completed' || old.runs[0].outcomeKnown!==true))return {accepted:false,ticketId,reason:'wire-prior-requires-readback'};
    if (old && ((!fresh && !this.#wire && !nativeSessionId) || old.status === 'running'))
      return { accepted: false, ticketId, reason: 'prior-native-session-unavailable-or-running' };

    let stage = old?.stage ?? null;
    if (workspaceMode === 'git-worktree') {
      if (old) {
        if (!stage || realpathSync(stage.path) !== realpathSync(join(this.stateDir, 'stages', ticketId)))
          throw new Error('ticket-stage-path-invalid');
        requireCleanGitRoot(cwd, stage.head);
        requireGitHead(stage.path, stage.head);
        const sourceNow = workspaceSnapshot(cwd, this.maxAuditFiles, this.maxAuditBytes,
          this.auditHashFileLimit, true);
        if (scopeFingerprint(sourceNow) !== stage.sourceFingerprint)
          throw new Error('source-workspace-changed');
      } else {
        const sourceBefore = workspaceSnapshot(cwd, this.maxAuditFiles, this.maxAuditBytes,
          this.auditHashFileLimit, true);
        const head = requireCleanGitRoot(cwd);
        const sourceTargets = snapshot(cwd, files);
        const path = createStageWorktree(cwd, this.stateDir, ticketId, head);
        requireCleanGitRoot(cwd, head);
        const sourceAfter = workspaceSnapshot(cwd, this.maxAuditFiles, this.maxAuditBytes,
          this.auditHashFileLimit, true);
        if (scopeFingerprint(sourceBefore) !== scopeFingerprint(sourceAfter))
          throw new Error('source-workspace-changed-during-stage-creation');
        stage = { path, head, sourceFingerprint: scopeFingerprint(sourceAfter), sourceTargets,
          sourceDirectories: [...sourceAfter].filter(([, value]) => value === 'dir').map(([file]) => file) };
      }
    }
    const workCwd = stage?.path ?? cwd;
    const allowed = allowedPaths(workCwd, files);
    const beforeScope = workspaceSnapshot(workCwd, this.maxAuditFiles, this.maxAuditBytes, this.auditHashFileLimit);
    const before = snapshot(workCwd, files);
    if (old) {
      const prior = implementationAttempt(old);
      cumulativeArtifact(old); // Never spend another implementation call with a missing/invalid frozen baseline.
      if (old.scopeAudit !== 'passed') return { accepted: false, ticketId, reason: 'prior-scope-audit-required' };
      if (!prior?.after || files.some(file => prior.after[file] !== before[file]))
        return { accepted: false, ticketId, reason: 'workspace-target-changed-before-resume' };
      const fingerprint = prior.workspaceScopeFingerprint ?? prior.stageScopeFingerprint;
      if (fingerprint && fingerprint !== scopeFingerprint(beforeScope))
        return { accepted: false, ticketId, reason: 'workspace-scope-changed-before-resume' };
    }
    if (stage && !old) stage.nonTargetFingerprint = scopeFingerprint(new Map([...beforeScope]
      .filter(([file]) => file !== '.git' && !allowed.has(file))));
    let assignment;
    if (united) {
      assignment = this.united.task(united.runId, united.messageId);
      if (assignment.pending.status !== 'pending' || !['open','running'].includes(assignment.state.status) ||
        assignment.envelope.goal_rev !== united.goalRev || assignment.envelope.task?.objective !== goal ||
        assignment.envelope.task?.acceptance !== acceptance)
        return { accepted: false, ticketId, reason: 'united-assignment-changed-before-attempt' };
    }
    const ticketContext = assignment?.envelope.context?.summary;
    if (ticketContext != null && typeof ticketContext !== 'string')
      return { accepted: false, ticketId, reason: 'united-assignment-context-invalid' };
    const prompt = fresh ? fresh.prepared.packet.text : [
      ...(followup ? [(this.#wire?'Continue the same original ticket ':'Continue the same native session and unchanged ticket ') + ticketId
        + '. Apply this correction: ' + followup]
        : ['Goal: ' + goal, 'Observable deliverable: ' + deliverable]),
      ...(ticketContext?.trim() ? ['Original ticket context (revision and previous findings within this assignment):\n' + ticketContext] : []),
      'Allowed files (relative to workspace):\n' + files.map(file => '- ' + file).join('\n'),
      'Acceptance: ' + acceptance,
      // Independent verifier commands and arguments belong to verify(), not to the writer.
      'The coordinator runs independent verification. Use the public acceptance criteria above.',
      'Do not change files outside the allowed list. Report any unmet condition.',
      ...(stage ? ['Work only in this disposable Git worktree. Only the separate promote action can copy verified files back.'] : []),
    ].join('\n\n');
    const request = { mode: 'implement', sandbox: 'workspace-write', cwd: workCwd,
      resumeThreadId: nativeSessionId, label: 'Yunshu ticket ' + ticketId, prompt };
    if(fresh)request.freshPacket=fresh.prepared.packet;
    // Observe the business revision before handing the request to its adapter. Reading today's
    // revision after the response cannot establish what an old attempt was asked to do.
    // This is local provenance, not a provider wire receipt or permission to release.
    let businessInput;
    if(assignment){
      businessInput={schema:1,goalRev:united.goalRev,planRev:assignment.state.plan_rev??null,
        envelopeSha256:hash(JSON.stringify(assignment.envelope)),promptSha256:hash(prompt),followupSha256:followup?hash(followup):null};
    }
    if(this.#handoff){
      try {handoff.admit(this,this.#handoff,args);if(old && old.handoffPolicy!==this.#handoff.policyHash)throw Error('handoff-policy-changed');}
      catch(e){return {accepted:false,ticketId,reason:e.message};}
      businessInput.adapterText=prompt;
    }
    const record = old ?? { ticketId, provider, cwd, files, contractHash,
      ...(this.#handoff?{handoffPolicy:this.#handoff.policyHash}:{}),
      contractSnapshot: structuredClone(contract), effectiveMaxRuns, recoveryPolicy: 1,
      checkProgram, checkArgs, workspaceMode, tokenBudget, stage,
      ...(united ? { united } : {}), runs: [], status: 'created',
      createdAt: new Date().toISOString() };
    // A raise is explicit on resume; keep scope/acceptance fixed and migrate the hash.
    record.contractHash = contractHash;
    record.artifactPolicy = 1;
    record.tokenBudget = tokenBudget;
    record.auditHashFileLimit = this.auditHashFileLimit;
    record.status = 'running';
    record.recoveryMode = this.recoveryMode;
    record.reason = null;
    record.verification = null;
    record.promotion = null;
    record.scopeAudit = 'not-run';
    record.updatedAt = new Date().toISOString();
    // Persist the attempt before calling a transport. A lost response must not
    // disappear from run limits/usage or let resume select an older session.
    const attempt = { attemptId, kind: 'implement', runId: null, nativeSessionId: null, ...(businessInput?{businessInput}:{}),
      observedInputsHash: progressFingerprint({ contractHash, scope: scopeFingerprint(beforeScope),
        provider, executable: located.path, model: provider === 'codex' ? this.peer.config.model : this.claude.model }),
      outcomeKnown: false,
      requestedNativeSessionId: nativeSessionId ?? null, resumedNativeSessionId: null,
      status: 'running', runnerStatus: null, cancellationRequested: false,
      changedFiles: [], before, after: null, usage: null, costUsd: null,
      outOfScope: [], stageScopeFingerprint: null, workspaceScopeFingerprint: null, artifactFiles: null, answer: '',
      startedAt: new Date().toISOString(), endedAt: null };
    if(fresh){
      attempt.fresh={transport:'responses-scoped-v1',inputSha256:fresh.prepared.packet.sha256,
        diagnosisAttemptId:fresh.prepared.diagnosisAttemptId,requestSha256:fresh.plan.requestSha256,
        requestedModel:fresh.plan.model,providerOutcomeKnown:false,requestCount:null,applyStatus:'not-started'};
      record.freshContext={...fresh.prepared,status:'consumed'};
    }
    record.runs.push(attempt);
    bindImplementation(record, attempt);
    if (nativeWriter) {
      const generation = (old?.writerAuthority?.generation ?? 0) + 1;
      positiveInteger(generation, 'writer generation');
      const tx = this.mutationOwners.get(ticketId);
      if (!tx) throw new Error('writer-owner-required-before-intent');
      const identity = { ticketId, attemptId, generation, token: randomUUID(), lockToken: tx.owner.token,
        ownerPid: process.pid, provider, contractHash, cwd: workCwd, files: [...files], scopeHash: scopeFingerprint(beforeScope) };
      // Preparing a request is not launching it. Persist this exact request and
      // authority before any workload can start. Never wrap a background job.
      const container = prepareWriter({ stateDir: this.stateDir, identity,
        config: fresh ? {transport:'responses-scoped-v1',settingsFile:fresh.settingsFile,settingsSha256:fresh.settingsSha256,
          requestSha256:fresh.plan.requestSha256,binding:fresh.plan.binding,limits:fresh.limits,
          inputPath:join(this.stateDir,'writer-runs',ticketId,identity.token,'input.json'),
          implementationHashes:freshImplementationHashes(),
          auditLimits:{maxFiles:this.maxAuditFiles,maxHashBytes:this.maxAuditBytes,hashFileLimit:this.auditHashFileLimit},
          source:stage?{cwd,fingerprint:stage.sourceFingerprint}:null}
          : provider === 'codex' ? { ...this.peer.config, codexPath: located.path }
          : { ...this.claude, path: located.path }, request, scopeEntries: [...beforeScope],
        timeoutMs: fresh ? fresh.limits.timeoutMs+10000 : (provider === 'codex' ? this.peer.config.runTimeoutMs : this.claude.runTimeoutMs) + 1000 });
      record.writerPolicy = 1;
      attempt.writer = identity;
      record.writerAuthority = { schema: 1, generation, token: identity.token, attemptId,
        contractHash, identity, status: 'running', container, terminal: null };
    }
    observeProgress(record, 'attempt-started', this.recoveryMode);
    if (provider === 'codex') this.peer.ledger.ensure();
    this.saveTicket(record);
    const controller = new AbortController();
    const abort = () => controller.abort(exec.signal.reason);
    exec.signal?.addEventListener('abort', abort, { once: true });
    this.busy.set(ticketId, controller);
    if (exec.signal?.aborted) abort();
    try {
      let response;
      if (nativeWriter) {
        this.mutationOwners.get(ticketId).retain = true;
        this.assertMutationOwner(ticketId);
        // An injected runner may delay/interrupt the supervisor, but cannot mint
        // proof: the original native receipt and output are always read again.
        await this.writerRunner(this.stateDir, record.writerAuthority, controller.signal);
        this.assertMutationOwner(ticketId);
        const evidence = readWriterEvidence(this.stateDir, record.writerAuthority);
        record.writerAuthority.status = 'stopped';
        record.writerAuthority.terminal = terminalBinding(evidence.receipt);
        response = evidence.result?.response;
        if (evidence.receipt.reason !== 'completed') {
          const stopped = evidence.receipt.reason;
          if (stopped === 'cancelled') controller.abort('writer-cancelled');
          if (!response?.outcome) throw new Error('writer-stopped-without-settled-result: ' + stopped);
          response.outcome.status = controller.signal.aborted ? 'aborted' : stopped === 'timeout' ? 'timeout' : 'failed';
        }
        if (!response) throw new Error(evidence.result?.error ?? 'writer-result-unavailable');
      } else {
        // Existing source-level transport injection is a legacy test/adapter
        // seam, not native writer containment. It cannot downgrade a policy-1 ticket.
        response = this.#wire ? await wire.exchange(this.#wire,{id:ticketId,stage:workCwd,state:this.stateDir,goal,change:old?followup:undefined,signal:controller.signal}) : provider === 'codex'
          ? await this.runner(this.peer, request, { ...exec, signal: controller.signal })
          : await this.claudeRunner({ ...this.claude, path: located.path }, request,
            { ...exec, signal: controller.signal });
      }
      if (response.kind !== 'run' || !response.outcome) throw new Error('runner did not return a settled run');
      const outcome = response.outcome;
      if (!['completed', 'failed', 'aborted', 'timeout'].includes(outcome.status))
        throw new Error('runner returned an unknown terminal status');
      // Cancellation wins over a late success, while the raw runner status and
      // observed usage/session remain evidence, not permission to promote.
      const terminalStatus = controller.signal.aborted ? 'aborted' : outcome.status;
      Object.assign(attempt, { runId: outcome.runId ?? null,
        nativeSessionId: outcome.threadId ?? null,
        resumedNativeSessionId: outcome.resumedThreadId ?? null,
        status: terminalStatus, runnerStatus: outcome.status, outcomeKnown: true,
        cancellationRequested: controller.signal.aborted,
        usage: outcome.usage ?? null, costUsd: outcome.costUsd ?? null,
        answer: outcome.answer ?? '',
        startedAt: outcome.startedAt ?? attempt.startedAt,
        endedAt: outcome.endedAt ?? new Date().toISOString() });
      if(this.#wire)attempt.wire=outcome.wire;
      if(fresh){
        attempt.fresh={...attempt.fresh,...outcome.fresh};
        attempt.outcomeKnown=outcome.fresh?.providerOutcomeKnown===true;
        if(!attempt.outcomeKnown)attempt.fresh.reason=outcome.fresh?.reason??'fresh-provider-outcome-unknown';
      }
      const afterScope = workspaceSnapshot(workCwd, this.maxAuditFiles, this.maxAuditBytes, this.auditHashFileLimit);
      const outOfScope = scopeChanges(beforeScope, afterScope).filter(name => !allowed.has(name));
      const after = snapshot(workCwd, files);
      const changedFiles = files.filter(file => before[file] !== after[file]);
      Object.assign(attempt, { changedFiles, after, outOfScope,
        stageScopeFingerprint: stage ? scopeFingerprint(afterScope) : null,
        workspaceScopeFingerprint: scopeFingerprint(afterScope) });
      const netFiles = cumulativeArtifact(record).files;
      attempt.artifactFiles = netFiles;
      record.scopeAudit = outOfScope.length ? 'failed' : 'passed';
      record.outOfScope = outOfScope;
      record.status = outOfScope.length ? 'scope-violation' : terminalStatus === 'completed'
        ? netFiles.length ? 'needs-verification' : 'needs-review' : terminalStatus;
      record.reason = outOfScope.length ? 'out-of-scope-changes'
        : controller.signal.aborted ? 'cancellation-requested'
        : terminalStatus !== 'completed' ? 'runner-' + terminalStatus
        : netFiles.length ? null : 'no-expected-file-change-observed';
      if (stage) {
        try {
          requireCleanGitRoot(cwd, stage.head);
          requireGitHead(workCwd, stage.head);
          const sourceNow = workspaceSnapshot(cwd, this.maxAuditFiles, this.maxAuditBytes,
            this.auditHashFileLimit, true);
          if (scopeFingerprint(sourceNow) !== stage.sourceFingerprint)
            throw new Error('source-workspace-changed');
        } catch (error) {
          record.status = 'source-drift';
          record.reason = error.message;
        }
      }
      record.updatedAt = new Date().toISOString();
      observeProgress(record, 'attempt-settled', this.recoveryMode);
      this.saveTicket(record);
      if (nativeWriter) this.mutationOwners.get(ticketId).retain = false;
      return { accepted: true, ...summary(record, this.recoveryMode), answer: outcome.answer ?? '',
        cost: outcome.costUsd === null || outcome.costUsd === undefined
          ? 'unknown; token usage is not a currency amount'
          : { amount: outcome.costUsd, currency: 'USD', reportedBy: 'claude-cli' },
        verified: false };
    } catch (error) {
      if (nativeWriter) {
        try { this.assertMutationOwner(ticketId); }
        catch (fenced) {
          let nativeEvidence = null;
          try {
            const observed = readWriterEvidence(this.stateDir, record.writerAuthority);
            nativeEvidence = { terminal: terminalBinding(observed.receipt), result: observed.result };
          } catch {}
          const path = recordFencedResult(record.writerAuthority, { reason: fenced.message,
            attempt, nativeEvidence, terminal: record.writerAuthority.terminal, error: error.message });
          return { ticketId, accepted: false, verified: false, reason: fenced.message,
            generation: record.writerAuthority.generation, historyPath: path };
        }
        // Receipt may exist even if the host callback threw or was interrupted.
        try {
          const evidence = readWriterEvidence(this.stateDir, record.writerAuthority);
          const observation = settledWriterObservation(evidence, attempt);
          if (observation) Object.assign(attempt, observation);
          record.writerAuthority.status = 'stopped';
          record.writerAuthority.terminal = terminalBinding(evidence.receipt);
        } catch {
          record.writerAuthority.status = 'unknown';
          record.reconciliation = { required: true, operation: 'implementation',
            token: record.writerAuthority.token, reason: 'writer-process-tree-unconfirmed' };
          this.mutationOwners.get(ticketId).retain = true;
        }
      }
      let auditError = null;
      try {
        const afterScope = workspaceSnapshot(workCwd, this.maxAuditFiles, this.maxAuditBytes, this.auditHashFileLimit);
        record.outOfScope = scopeChanges(beforeScope, afterScope).filter(name => !allowed.has(name));
        record.scopeAudit = record.outOfScope.length ? 'failed' : 'passed';
        attempt.after = snapshot(workCwd, files);
        attempt.changedFiles = files.filter(file => before[file] !== attempt.after[file]);
        attempt.stageScopeFingerprint = stage ? scopeFingerprint(afterScope) : null;
        attempt.workspaceScopeFingerprint = scopeFingerprint(afterScope);
        attempt.artifactFiles = cumulativeArtifact(record).files;
      } catch (failure) {
        record.scopeAudit = 'unavailable';
        record.outOfScope = [];
        auditError = failure?.message ?? String(failure);
      }
      const stopReason = record.writerAuthority?.terminal?.reason;
      const interrupted = controller.signal.aborted || ['cancelled', 'owner-disconnected'].includes(stopReason);
      record.status = record.scopeAudit === 'failed' ? 'scope-violation'
        : interrupted ? 'aborted' : stopReason === 'timeout' ? 'timeout' : 'failed';
      record.reason = auditError ? 'scope audit unavailable: ' + auditError : error?.message ?? String(error);
      Object.assign(attempt, { status: interrupted ? 'aborted' : stopReason === 'timeout' ? 'timeout' : 'failed',
        cancellationRequested: interrupted, outOfScope: record.outOfScope,
        error: record.reason, endedAt: new Date().toISOString() });
      record.updatedAt = new Date().toISOString();
      observeProgress(record, 'attempt-settled', this.recoveryMode);
      try { this.saveTicket(record); }
      catch (failure) {
        if (!nativeWriter) throw failure;
        const path = recordFencedResult(record.writerAuthority, { reason: failure.message, attempt,
          terminal: record.writerAuthority.terminal, error: error.message });
        return { ticketId, accepted: false, verified: false, reason: failure.message, historyPath: path };
      }
      if (nativeWriter && record.writerAuthority.status === 'stopped') this.mutationOwners.get(ticketId).retain = false;
      return { accepted: true, ...summary(record, this.recoveryMode), verified: false };
    } finally {
      exec.signal?.removeEventListener('abort', abort);
      this.busy.delete(ticketId);
    }
  }

  cancel(ticketId) {
    const controller = this.busy.get(ticketId) ?? this.checksBusy.get(ticketId);
    if (!controller) return { ticketId, cancelled: false, reason: 'no-active-run' };
    controller.abort('cancelled by Yunshu');
    return { ticketId, cancelled: true, reason: 'cancellation-requested; await final run status' };
  }

  assertStageSource(record) {
    const stage = record.stage;
    if (!stage || realpathSync(stage.path) !== realpathSync(join(this.stateDir, 'stages', record.ticketId)))
      throw new Error('ticket-stage-path-invalid');
    requireCleanGitRoot(record.cwd, stage.head);
    requireGitHead(stage.path, stage.head);
    const sourceNow = workspaceSnapshot(record.cwd, this.maxAuditFiles, this.maxAuditBytes,
      this.auditHashFileLimit, true);
    if (scopeFingerprint(sourceNow) !== stage.sourceFingerprint)
      throw new Error('source-workspace-changed');
    const targets = snapshot(record.cwd, record.files);
    if (record.files.some(file => targets[file] !== stage.sourceTargets[file]))
      throw new Error('source-target-changed');
    const staged = workspaceSnapshot(stage.path, this.maxAuditFiles, this.maxAuditBytes,
      this.auditHashFileLimit, true);
    const allowed = allowedPaths(stage.path, record.files);
    if (stage.nonTargetFingerprint && scopeFingerprint(new Map([...staged]
      .filter(([file]) => !allowed.has(file)))) !== stage.nonTargetFingerprint)
      throw new Error('stage-cumulative-out-of-scope');
  }

  async verify(ticketId, signal) {
    signal?.throwIfAborted();
    if (this.#dispatchProfile === 'blind-trial') return { verified: false, ...this.#blindHold(ticketId) };
    if(this.#rankDelivery)return this.#rankStep('verify',ticketId,signal);
    const release = this.acquireTicketLock(ticketId, 'verify');
    if (!release) return { ...this.locked(ticketId), verified: false };
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    this.checksBusy.set(ticketId, controller);
    try {
      const held = this.reconciliationHold(ticketId);
      return held ? { ...held, verified: false } : await this.verifyLocked(ticketId, controller.signal, release.owner);
    } finally {
      signal?.removeEventListener('abort', abort);this.checksBusy.delete(ticketId);release();
    }
  }
  async verifyLocked(ticketId, signal, owner) {
    signal?.throwIfAborted();
    const record = this.readTicket(ticketId);
    if (!record) return { ticketId, status: 'not-found' };
    if (record.writerPolicy === 1) this.assertMutationOwner(ticketId);
    if (!['needs-verification', 'needs-review'].includes(record.status))
      return { ...summary(record, this.recoveryMode), verified: false };
    if (record.scopeAudit !== 'passed') return { ...summary(record, this.recoveryMode), verified: false };
    record.activeArtifactAttemptId = null;
    const workCwd = record.stage?.path ?? record.cwd;
    if (record.stage) {
      try { this.assertStageSource(record); }
      catch (error) {
        record.verification = { status: 'failed', reason: error.message };
        record.updatedAt = new Date().toISOString();
        observeProgress(record, 'verification', this.recoveryMode);
          this.saveTicket(record);
        return { ...summary(record, this.recoveryMode), verified: false };
      }
    }
    const last = implementationAttempt(record);
    if (!last || last.status !== 'completed' || last.outcomeKnown === false
      || (Object.hasOwn(last, 'kind') && last.outcomeKnown !== true) || last.cancellationRequested)
      return { ...summary(record, this.recoveryMode), verified: false, reason: 'settled-implementation-required' };
    let artifact;
    try { artifact = cumulativeArtifact(record); }
    catch (error) {
      record.verification = { status: 'failed', reason: error.message };
      record.updatedAt = new Date().toISOString(); this.saveTicket(record);
      return { ...summary(record, this.recoveryMode), verified: false };
    }
    const current = snapshot(workCwd, record.files);
    const stale = record.files.filter(file => current[file] !== last.after[file]);
    const missing = record.files.filter(file => current[file] === null);
    if (stale.length || missing.length || !artifact.files.length) {
      record.verification = { status: 'failed', stale, missing,
        reason: !artifact.files.length ? 'no-expected-file-change-observed' : 'file-state-changed-or-missing' };
    } else if (!record.checkProgram) {
      record.verification = { status: 'not-configured', reason: 'independent-test-command-required' };
    } else {
      let beforeCheckScope;
      try {
        beforeCheckScope = workspaceSnapshot(workCwd, this.maxAuditFiles, this.maxAuditBytes, this.auditHashFileLimit);
      } catch (error) {
        record.scopeAudit = 'unavailable';
        record.verification = { status: 'failed', reason: 'scope audit unavailable: ' + error.message };
      }
      if (beforeCheckScope) {
        const expectedScope = last.workspaceScopeFingerprint ?? (record.stage ? last.stageScopeFingerprint : null);
        if (!expectedScope
          || (expectedScope && scopeFingerprint(beforeCheckScope) !== expectedScope)) {
          record.verification = { status: 'failed', reason: record.stage ? 'stage-changed-after-dispatch' : 'workspace-changed-after-dispatch' };
          record.updatedAt = new Date().toISOString();
          observeProgress(record, 'verification', this.recoveryMode);
          this.saveTicket(record);
          return { ...summary(record, this.recoveryMode), verified: false };
        }
        const checkMeta = { checkId: randomUUID(), attemptId: last.attemptId, startedAt: new Date().toISOString(),
          ...(record.writerPolicy === 1 ? { writer: writerBinding(record) } : {}),
          command: [record.checkProgram, ...record.checkArgs], observedTargets: current, artifact,
          beforeScopeFingerprint: scopeFingerprint(beforeCheckScope), lockToken: owner?.token ?? null,
          processTree: 'windows-job-v1; local CreateProcess descendants; not external brokers' };
        try {
          let args=record.checkArgs;
          if(handoff.marked(record)||this.#handoff){
            const key=handoff.keyFor(this,this.#handoff,record);
            args=[...args,'--witness',handoff.witness(key,checkMeta.checkId)];
            checkMeta.command=[record.checkProgram,...args];
          }
          checkMeta.container = prepareVerification({ stateDir: this.stateDir, checkId: checkMeta.checkId,
            program: record.checkProgram, args, cwd: workCwd, timeoutMs: this.checkTimeoutMs,
            ...(this.#handoff?{environmentPolicy:'fresh-no-injection-v1',maxOutputBytes:32768}:{}) });
        } catch (error) {
          // Compilation/platform setup failed before any workload was started.
          record.verification = { ...checkMeta, status: 'failed', reason: 'verification-container-unavailable: ' + error.message };
          record.updatedAt = new Date().toISOString();
          observeProgress(record, 'verification', this.recoveryMode);this.saveTicket(record);
          return { ...summary(record, this.recoveryMode), verified: false };
        }
        // Persist the bound request and lock identity before starting the helper.
        record.artifactPolicy = 1;
        record.verification = { ...checkMeta, status: 'running' };
        record.updatedAt = new Date().toISOString();this.saveTicket(record);
        let result;
        try { result = await this.verificationRunner(this.stateDir, checkMeta.container, signal); }
        catch (error) { result = { terminalVerified: false, reason: 'verification-runner-error', error: error.message }; }
        if (record.writerPolicy === 1) this.assertMutationOwner(ticketId);
        // Re-read the bound native receipt; never trust a provider's prose or a
        // returned terminalVerified boolean without the actual local evidence.
        let receipt;
        if (result.terminalVerified === true) {
          try { receipt = readVerificationReceipt(this.stateDir, checkMeta.container); }
          catch (error) { result = { terminalVerified: false, reason: error.message }; }
        }
        if (!receipt) {
          record.verification = { ...checkMeta, status: 'outcome-unknown', reason: result.reason,
            cancellationRequested: signal.aborted, endedAt: new Date().toISOString() };
          record.reconciliation = { required: true, operation: 'verification', checkId: checkMeta.checkId,
            reason: 'verification-process-tree-unconfirmed', at: new Date().toISOString() };
          record.updatedAt = new Date().toISOString();
          observeProgress(record, 'verification', this.recoveryMode);this.saveTicket(record);
          return { ...summary(record, this.recoveryMode), verified: false };
        }
        const cancelled = signal.aborted || ['cancelled', 'owner-disconnected'].includes(receipt.reason);
        record.verification = { ...checkMeta,
          status: cancelled ? 'aborted' : receipt.reason === 'completed' && receipt.rootExitCode === 0
            ? 'target-files-and-test-passed' : receipt.reason === 'timeout' ? 'timeout' : 'failed',
          exitCode: receipt.rootExitCode, reason: cancelled ? 'cancellation-requested' : receipt.reason,
          processReceipt: { path: receipt.receiptPath, sha256: receipt.receiptSha256,
            terminalVerified: true, activeProcesses: 0, assignedBeforeResume: receipt.assignedBeforeResume,
            reason: receipt.reason },
          cancellationRequested: cancelled, interrupted: cancelled || ['timeout', 'output-limit'].includes(receipt.reason), endedAt: receipt.endedAt,
          stdoutTail: receipt.stdoutTail, stderrTail: receipt.stderrTail };

        try {
          const afterCheckScope = workspaceSnapshot(workCwd, this.maxAuditFiles, this.maxAuditBytes, this.auditHashFileLimit);
          const outOfScope = scopeChanges(beforeCheckScope, afterCheckScope)
            .filter(name => !allowedPaths(workCwd, record.files).has(name));
          const targetsAfterCheck = snapshot(workCwd, record.files);
          const changedTargets = record.files.filter(file => targetsAfterCheck[file] !== last.after[file]);
          if (outOfScope.length || changedTargets.length) {
            record.scopeAudit = outOfScope.length ? 'failed' : 'passed';
            record.outOfScope = outOfScope;
            const auditFailure = outOfScope.length ? 'verification-changed-out-of-scope-files' : 'verification-changed-target-files';
            record.verification = { ...record.verification,
              status: record.verification.interrupted ? record.verification.status : 'failed',
              reason: record.verification.interrupted ? record.verification.reason : auditFailure,
              auditFailure, outOfScope, changedTargets };
          } else if (record.stage && record.verification.status === 'target-files-and-test-passed') {
            this.assertStageSource(record);
            if(handoff.marked(record)||this.#handoff)record.verification.handoff=handoff.qualify(this,this.#handoff,record,record.verification);
            record.verification.stageScopeFingerprint = scopeFingerprint(afterCheckScope);
          }
        } catch (error) {
          record.scopeAudit = 'unavailable';
          record.verification = { ...record.verification,
            status: record.verification.interrupted ? record.verification.status : 'failed',
            reason: record.verification.interrupted ? record.verification.reason : 'scope audit unavailable: ' + error.message,
            auditFailure: 'scope audit unavailable: ' + error.message };
        }
      }
    }
    record.updatedAt = new Date().toISOString();
    if (record.scopeAudit === 'passed' && record.verification.status === 'target-files-and-test-passed')
      bindVerifiedArtifact(record);
    observeProgress(record, 'verification', this.recoveryMode);
    this.saveTicket(record);
    return { ...summary(record, this.recoveryMode), verified: record.scopeAudit === 'passed'
      && record.verification.status === 'target-files-and-test-passed' };
  }

  /** Explicit local stop reconciliation; never launches, retries or grants a pass. */
  reconcileWriter(ticketId, signal) {
    signal?.throwIfAborted();
    const path = this.ticketPath(ticketId), lock = path + '.lock', guard = path + '.reconcile.lock';
    if (!existsSync(path)) return { ticketId, reconciled: false, reason: 'ticket-not-found' };
    const originalBytes = readFileSync(path), original = JSON.parse(originalBytes.toString('utf8'));
    const a = original.writerAuthority;
    if (original.writerPolicy !== 1 || !a) return { ticketId, reconciled: false, reason: 'writer-native-evidence-required' };
    const writerHeld = writerHold(original);
    if (writerHeld && writerHeld !== 'writer-process-tree-unconfirmed') return { ticketId, reconciled: false, reason: writerHeld };
    if (diagnosisHold(original)) return { ticketId, reconciled: false, reason: diagnosisHold(original) };
    if (original.reconciliation?.required && original.reconciliation.operation !== 'implementation')
      return { ticketId, reconciled: false, reason: 'other-operation-awaiting-reconciliation' };
    let evidence;
    try { evidence = readWriterEvidence(this.stateDir, a); }
    catch (error) { return { ticketId, reconciled: false, reason: error.message }; }
    const binding = { ticketId, operation: 'reconcile-writer', generation: a.generation,
      writerToken: a.token, requestSha256: a.container.requestSha256 };
    const retire = owner => renameSync(guard, guard + '.retired-' + owner.token);
    if (existsSync(guard)) {
      let owner;
      try { owner = JSON.parse(readFileSync(join(guard, 'owner.json'), 'utf8')); }
      catch { return { ticketId, reconciled: false, reason: 'reconciliation-guard-owner-unknown' }; }
      if (!/^[0-9a-f-]{36}$/.test(owner.token ?? '') || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
        || Object.keys(binding).some(key => binding[key] !== owner[key]))
        return { ticketId, reconciled: false, reason: 'reconciliation-guard-binding-mismatch' };
      try { process.kill(owner.pid, 0); return { ticketId, reconciled: false, reason: 'reconciliation-already-running' }; }
      catch (error) { if (error.code !== 'ESRCH') return { ticketId, reconciled: false, reason: 'reconciliation-guard-owner-unknown' }; }
      try { retire(owner); }
      catch { return { ticketId, reconciled: false, reason: 'reconciliation-guard-retirement-raced' }; }
    }
    const owner = { ...binding, token: randomUUID(), pid: process.pid, at: new Date().toISOString() };
    const claim = guard + '.claim-' + owner.token;
    mkdirSync(claim);writeFileSync(join(claim, 'owner.json'), JSON.stringify(owner) + '\n', { flag: 'wx' });
    try { renameSync(claim, guard); }
    catch (error) {
      if (existsSync(guard)) return { ticketId, reconciled: false, reason: 'reconciliation-already-running' };
      throw error;
    }
    try {
      if (hash(readFileSync(path)) !== hash(originalBytes)) return { ticketId, reconciled: false, reason: 'writer-ticket-version-conflict' };
      if (!Number.isSafeInteger(a.identity.ownerPid) || a.identity.ownerPid <= 0)
        return { ticketId, reconciled: false, reason: 'writer-owner-unknown' };
      try { process.kill(a.identity.ownerPid, 0); return { ticketId, reconciled: false, reason: 'writer-owner-still-alive' }; }
      catch (error) { if (error.code !== 'ESRCH') return { ticketId, reconciled: false, reason: 'writer-owner-unknown' }; }
      let lockOwner = null;
      if (existsSync(lock)) {
        lockOwner = JSON.parse(readFileSync(lock, 'utf8'));
        if (lockOwner.token !== a.identity.lockToken || lockOwner.pid !== a.identity.ownerPid || lockOwner.operation !== 'implement')
          return { ticketId, reconciled: false, reason: 'lock-owner-does-not-match-writer' };
      }
      this.mutationOwners.set(ticketId, { owner, ownerPath: join(guard, 'owner.json'), expectedHash: hash(originalBytes) });
      const record = original;
      const last = implementationAttempt(record);
      if (last?.attemptId !== a.attemptId || JSON.stringify(last.writer) !== JSON.stringify(a.identity))
        return { ticketId, reconciled: false, reason: 'writer-authority-binding-mismatch' };
      const observation = settledWriterObservation(evidence, last);
      // Older exception handlers may have saved stopped while losing facts.
      // Repair only a failed fresh attempt, never demote a successful/verified
      // ticket. Unchanged repeats do not rewrite the ticket or refresh progress.
      const repairStopped = a.status === 'stopped' && last.fresh && observation
        && ['failed', 'aborted', 'timeout'].includes(last.status)
        && ['failed', 'aborted', 'timeout', 'scope-violation'].includes(record.status)
        && Object.entries(observation).some(([key, value]) => JSON.stringify(last[key]) !== JSON.stringify(value));
      if (repairStopped) {
        Object.assign(last, observation);
        a.terminal = terminalBinding(evidence.receipt);
        record.activeArtifactAttemptId = null;
        record.reconciliation = { required: false, operation: 'implementation', token: a.token,
          reason: 'writer-observations-explicitly-reconciled; no-success-credit-or-replay', resolvedAt: new Date().toISOString() };
        record.updatedAt = new Date().toISOString();
        // Metadata repair is not a new attempt or workspace observation: keep
        // the original failure/cancellation, after/scope audit and progress.
        this.saveTicket(record);
      } else if (a.status !== 'stopped') {
        const cwd = record.stage?.path ?? record.cwd;
        const before = new Map(evidence.input.scopeEntries);
        if (scopeFingerprint(before) !== a.identity.scopeHash) throw new Error('writer-scope-baseline-mismatch');
        const now = workspaceSnapshot(cwd, this.maxAuditFiles, this.maxAuditBytes, this.auditHashFileLimit);
        const after = snapshot(cwd, record.files), allowed = allowedPaths(cwd, record.files);
        const outOfScope = scopeChanges(before, now).filter(file => !allowed.has(file));
        const cancelled = ['cancelled', 'owner-disconnected'].includes(evidence.receipt.reason) || last.cancellationRequested;
        Object.assign(last, { after, changedFiles: record.files.filter(file => last.before[file] !== after[file]),
          workspaceScopeFingerprint: scopeFingerprint(now), stageScopeFingerprint: record.stage ? scopeFingerprint(now) : null,
          ...(observation ?? { outcomeKnown: false, runnerStatus: null, nativeSessionId: null,
            resumedNativeSessionId: null, runId: null, usage: null, costUsd: null }),
          status: cancelled ? 'aborted' : 'failed', cancellationRequested: cancelled,
          endedAt: evidence.receipt.endedAt, outOfScope });
        last.artifactFiles = cumulativeArtifact(record).files;
        a.status = 'stopped';a.terminal = terminalBinding(evidence.receipt);
        record.scopeAudit = outOfScope.length ? 'failed' : 'passed';record.outOfScope = outOfScope;
        record.activeArtifactAttemptId = null;
        record.status = outOfScope.length ? 'scope-violation' : cancelled ? 'aborted' : 'failed';
        record.reason = 'writer-explicitly-reconciled; no-success-credit-or-replay';
        record.reconciliation = { required: false, operation: 'implementation', token: a.token,
          reason: record.reason, resolvedAt: new Date().toISOString() };
        record.updatedAt = new Date().toISOString();observeProgress(record, 'attempt-settled', this.recoveryMode);
        this.saveTicket(record);
      }
      // Save before retirement: crashes on either side can retry the SAME bound
      // receipt, never invoke the worker or clear an unrelated owner's lock.
      if (lockOwner) renameSync(lock, lock + '.retired-' + lockOwner.token);
      return { ...summary(record, this.recoveryMode), reconciled: true, verified: false, replayed: false };
    } finally { this.mutationOwners.delete(ticketId);retire(owner); }
  }

  reconcileVerification(ticketId, signal) {
    signal?.throwIfAborted();
    const diagnosisHeld = this.readTicket(ticketId);
    if (diagnosisHeld && diagnosisHold(diagnosisHeld))
      return { ...summary(diagnosisHeld, this.recoveryMode), reconciled: false, verified: false, reason: diagnosisHold(diagnosisHeld) };
    const original = this.readTicket(ticketId);
    if (!original) return { ticketId, reconciled: false, verified: false, reason: 'ticket-not-found' };
    if (writerHold(original)) return { ticketId, reconciled: false, verified: false, reason: writerHold(original) };
    const guard = this.ticketPath(ticketId) + '.reconcile.lock';
    if (!existsSync(guard) && !original.reconciliation?.required && !['running', 'outcome-unknown'].includes(original.verification?.status))
      return { ...summary(original, this.recoveryMode), reconciled: false, verified: false, reason: 'verification-not-awaiting-reconciliation' };
    let receipt;
    try { receipt = readVerificationReceipt(this.stateDir, original.verification?.container); }
    catch (error) { return { ...summary(original, this.recoveryMode), reconciled: false, verified: false, reason: error.message }; }
    const binding = { ticketId, checkId: original.verification.checkId,
      requestSha256: original.verification.container.requestSha256 };
    // Publish a fully populated, nonempty directory in one rename. A crash
    // cannot expose an ownerless guard. Retired directories are never removed:
    // two reclaimers of the same old token must target the SAME nonempty name,
    // so the loser cannot accidentally rename a replacement owner's guard (ABA).
    const retireGuard = owner => renameSync(guard, guard + '.retired-' + owner.token);
    if (existsSync(guard)) {
      let owner;
      try {
        if (!lstatSync(guard).isDirectory() || lstatSync(guard).isSymbolicLink()) throw new Error('legacy guard');
        owner = JSON.parse(readFileSync(join(guard, 'owner.json'), 'utf8'));
      } catch { return { ticketId, reconciled: false, verified: false, reason: 'reconciliation-guard-owner-unknown' }; }
      if (!/^[0-9a-f-]{36}$/.test(owner.token ?? '') || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
        || Object.keys(binding).some(key => binding[key] !== owner[key]))
        return { ticketId, reconciled: false, verified: false, reason: 'reconciliation-guard-binding-mismatch' };
      try { process.kill(owner.pid, 0); return { ticketId, reconciled: false, verified: false, reason: 'reconciliation-already-running' }; }
      catch (error) { if (error.code !== 'ESRCH') return { ticketId, reconciled: false, verified: false, reason: 'reconciliation-guard-owner-unknown' }; }
      // Native bound Job-empty proof was read above; PID absence alone never
      // clears a verification hold or an unbound/legacy guard.
      try { retireGuard(owner); }
      catch { return { ticketId, reconciled: false, verified: false, reason: 'reconciliation-guard-retirement-raced' }; }
    }
    const guardOwner = { ...binding, token: randomUUID(), pid: process.pid, at: new Date().toISOString() };
    const claim = guard + '.claim-' + guardOwner.token;
    mkdirSync(claim);
    writeFileSync(join(claim, 'owner.json'), JSON.stringify(guardOwner) + '\n', { flag: 'wx' });
    try { renameSync(claim, guard); }
    catch (error) {
      // The unpublished claim is not a lock; leave its owner record as evidence.
      if (existsSync(guard)) return { ticketId, reconciled: false, verified: false, reason: 'reconciliation-already-running' };
      throw error;
    }
    try {
      const path = this.ticketPath(ticketId) + '.lock';
      if (existsSync(path)) {
        const owner = JSON.parse(readFileSync(path, 'utf8'));
        if (!/^[0-9a-f-]{36}$/.test(owner.token ?? '') || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
          || owner.operation !== 'verify' || owner.token !== original.verification.lockToken)
          return { ticketId, reconciled: false, verified: false, reason: 'lock-owner-does-not-match-verification' };
        try { process.kill(owner.pid, 0); return { ticketId, reconciled: false, verified: false, reason: 'verification-owner-still-alive' }; }
        catch (error) { if (error.code !== 'ESRCH') return { ticketId, reconciled: false, verified: false, reason: 'verification-owner-unknown' }; }
        // PID absence only retires a matching lock AFTER native Job-empty proof.
        const retired = resolve(path + '.retired-' + owner.token);
        if (dirname(retired) !== dirname(resolve(path))) throw new Error('retired-lock-path-invalid');
        renameSync(path, retired);
      }
      // The guard, rather than a second durable lock, fences ordinary mutators.
      // Re-read only after claiming it; owner death before/after save is retryable.
      const record = this.readTicket(ticketId);
      if (record.writerPolicy === 1) this.mutationOwners.set(ticketId, { owner: guardOwner,
        ownerPath: join(guard, 'owner.json'), expectedHash: hash(readFileSync(this.ticketPath(ticketId))) });
      if (diagnosisHold(record)) return { ...summary(record, this.recoveryMode), reconciled: false, verified: false, reason: diagnosisHold(record) };
      if (!record.reconciliation?.required && !['running', 'outcome-unknown'].includes(record.verification?.status))
        return { ...summary(record, this.recoveryMode), reconciled: false, verified: false, reason: 'verification-not-awaiting-reconciliation' };
      if (record.verification?.checkId !== original.verification.checkId)
        return { ticketId, reconciled: false, verified: false, reason: 'verification-changed-during-reconciliation' };
      const current = workspaceSnapshot(record.stage?.path ?? record.cwd,
        this.maxAuditFiles, this.maxAuditBytes, this.auditHashFileLimit);
      if (scopeFingerprint(current) !== record.verification.beforeScopeFingerprint)
        return { ...summary(record, this.recoveryMode), reconciled: false, verified: false, reason: 'workspace-changed; inspect-before-reconciliation' };
      if (record.stage) {
        try { this.assertStageSource(record); }
        catch (error) { return { ...summary(record, this.recoveryMode), reconciled: false, verified: false, reason: error.message }; }
      }
      record.verification = { ...record.verification, status: 'aborted', reason: 'explicitly-reconciled; independent-recheck-required',
        processReceipt: { path: receipt.receiptPath, sha256: receipt.receiptSha256, terminalVerified: true,
          activeProcesses: 0, reason: receipt.reason }, endedAt: receipt.endedAt };
      record.reconciliation = { required: false, checkId: record.verification.checkId,
        reason: 'job-empty-confirmed; no-operation-replayed', resolvedAt: new Date().toISOString() };
      record.updatedAt = new Date().toISOString();
      observeProgress(record, 'verification', this.recoveryMode);this.saveTicket(record);
      return { ...summary(record, this.recoveryMode), reconciled: true, verified: false };
    } finally { this.mutationOwners.delete(ticketId);retireGuard(guardOwner); }
  }

  submit(ticketId, signal) {
    signal?.throwIfAborted();
    if (this.#dispatchProfile === 'blind-trial') return { submitted: false, ...this.#blindHold(ticketId) };
    if(this.#rankDelivery)return this.#rankStep('submit',ticketId,signal);
    if (this.busy.has(ticketId)) return { ticketId, submitted: false, reason: 'ticket-still-running' };
    const release = this.acquireTicketLock(ticketId);
    if (!release) return { ...this.locked(ticketId), submitted: false };
    try {
      const held = this.reconciliationHold(ticketId);
      return held ? { ...held, submitted: false } : this.submitLocked(ticketId, signal);
    }
    finally { release(); }
  }
  submitLocked(ticketId, signal) {
    signal?.throwIfAborted();
    const record = this.readTicket(ticketId);
    if (!record) return { ticketId, submitted: false, reason: 'ticket-not-found' };
    if (record.writerPolicy === 1) this.assertMutationOwner(ticketId);
    if (!this.united) return { ticketId, submitted: false, reason: 'united-not-configured' };
    if (this.busy.has(ticketId)) return { ticketId, submitted: false, reason: 'ticket-still-running' };
    return { ticketId, ...this.united.submit(record) };
  }

  promote(ticketId, signal) {
    signal?.throwIfAborted();
    if (this.#dispatchProfile === 'blind-trial') return { promoted: false, ...this.#blindHold(ticketId) };
    if(this.#rankDelivery)return this.#rankStep('promote',ticketId,signal);
    if (this.busy.has(ticketId)) return { ticketId, promoted: false, reason: 'ticket-still-running' };
    const release = this.acquireTicketLock(ticketId);
    if (!release) return { ...this.locked(ticketId), promoted: false };
    try {
      const held = this.reconciliationHold(ticketId);
      return held ? { ...held, promoted: false } : this.promoteLocked(ticketId, signal);
    }
    finally { release(); }
  }
  promoteLocked(ticketId, signal) {
    signal?.throwIfAborted();
    const record = this.readTicket(ticketId);
    if (!record) return { ticketId, promoted: false, reason: 'ticket-not-found' };
    if (record.writerPolicy === 1) this.assertMutationOwner(ticketId);
    if (!record.stage) return { ...summary(record, this.recoveryMode), promoted: false, reason: 'ticket-is-not-staged' };
    if (this.busy.has(ticketId)) return { ...summary(record, this.recoveryMode), promoted: false, reason: 'ticket-still-running' };
    if (record.status === 'promoted') return { ...summary(record, this.recoveryMode), promoted: false, reason: 'already-promoted' };
    if (record.status !== 'needs-verification' || record.scopeAudit !== 'passed'
      || record.verification?.status !== 'target-files-and-test-passed'
      || !record.verification.stageScopeFingerprint)
      return { ...summary(record, this.recoveryMode), promoted: false, reason: 'verified-stage-required' };

    const last = artifactAttempt(record);
    if (record.artifactPolicy !== 1) return { ...summary(record, this.recoveryMode), promoted: false, reason: 'cumulative-verification-required' };
    const artifact = record.verification.artifact;
    const recheckHandoff=()=>{if(handoff.marked(record)||this.#handoff)handoff.requireQualification(this,this.#handoff,record);};
    let sourceBefore;
    if (!last) return { ...summary(record, this.recoveryMode), promoted: false, reason: 'verified-artifact-reference-required' };
    try {
      recheckHandoff();
      this.assertStageSource(record);
      sourceBefore = workspaceSnapshot(record.cwd, this.maxAuditFiles, this.maxAuditBytes, this.auditHashFileLimit, true);
      if (scopeFingerprint(sourceBefore) !== record.stage.sourceFingerprint) throw new Error('source-workspace-changed');
      const stageNow = workspaceSnapshot(record.stage.path, this.maxAuditFiles,
        this.maxAuditBytes, this.auditHashFileLimit);
      if (scopeFingerprint(stageNow) !== record.verification.stageScopeFingerprint)
        throw new Error('stage-changed-after-verification');
      const targets = snapshot(record.stage.path, record.files);
      if (record.files.some(file => targets[file] !== last.after[file]))
        throw new Error('stage-target-changed-after-verification');
      if (!artifact.files.length) throw new Error('no-expected-file-change-observed');
      assertTargetPaths(record.cwd, artifact.files);
      if (artifact.files.some(file => targets[file] === null))
        throw new Error('stage-target-missing');
    } catch (error) {
      return { ...summary(record, this.recoveryMode), promoted: false, reason: error.message };
    }

    const backupDir = join(this.stateDir, 'rollback', ticketId);
    if (existsSync(backupDir))
      return { ...summary(record, this.recoveryMode), promoted: false, reason: 'rollback-directory-already-exists' };
    const changed = artifact.files;
    const applied = [], attempted = [], createdDirectories = [...new Set(changed.flatMap(file => {
      const parents = []; let path = dirname(resolve(record.cwd, file));
      while (path !== record.cwd && inside(record.cwd, path)) {
        if (!existsSync(path)) parents.push(relative(record.cwd, path).split(sep).join('/'));
        path = dirname(path);
      }
      return parents;
    }))].sort((a, b) => b.split('/').length - a.split('/').length);
    try {
      mkdirSync(join(backupDir, 'files'), { recursive: true });
      for (const file of changed) {
        signal?.throwIfAborted();
        if (record.writerPolicy === 1) this.assertMutationOwner(ticketId);
        const source = resolve(record.cwd, file);
        if (record.stage.sourceTargets[file] !== null) {
          const backup = resolve(backupDir, 'files', file);
          mkdirSync(dirname(backup), { recursive: true });
          copyFileSync(source, backup);
          if (fileHash(backup) !== record.stage.sourceTargets[file])
            throw new Error('rollback-copy-mismatch: ' + file);
        }
      }
      atomicJson(join(backupDir, 'manifest.json'), {
        ticketId, source: record.cwd, stage: record.stage.path, head: record.stage.head,
        ...(record.writerPolicy === 1 ? { writer: writerBinding(record) } : {}),
        checkId: record.verification.checkId, artifact, createdDirectories,
        files: changed.map(file => ({ file, originalSha256: record.stage.sourceTargets[file],
          promotedSha256: last.after[file] })), createdAt: new Date().toISOString(),
      });
      for (const file of changed) {
        signal?.throwIfAborted();
        assertTargetPaths(record.cwd, [file]);
        if (fileHash(resolve(record.cwd, file)) !== record.stage.sourceTargets[file])
          throw new Error('source-target-changed-during-promotion: ' + file);
        attempted.push(file); // A throw after rename must still trigger a hash-checked restore.
        copyAtomically(resolve(record.stage.path, file), resolve(record.cwd, file));
        applied.push(file);
        if (fileHash(resolve(record.cwd, file)) !== last.after[file])
          throw new Error('promoted-copy-mismatch: ' + file);
      }
      const promotedTargets = snapshot(record.cwd, record.files);
      if (record.files.some(file => promotedTargets[file] !== artifact.targets[file]))
        throw new Error('promotion-complete-target-mismatch');
      const sourceAfter = workspaceSnapshot(record.cwd, this.maxAuditFiles, this.maxAuditBytes,
        this.auditHashFileLimit, true);
      const sourceAllowed = allowedPaths(record.cwd, changed);
      if (scopeChanges(sourceBefore, sourceAfter).some(file => !sourceAllowed.has(file)))
        throw new Error('source-scope-changed-during-promotion');
      recheckHandoff(); // Revisions during the copy enter the existing rollback path.
      record.status = 'promoted';
      record.promotion = { status: 'promoted', attemptId: last.attemptId, checkId: record.verification.checkId,
        ...(record.writerPolicy === 1 ? { writer: writerBinding(record) } : {}), artifact, files: changed, backupDir, sourceScopeFingerprint: scopeFingerprint(sourceAfter),
        promotedAt: new Date().toISOString() };
      record.updatedAt = new Date().toISOString();
      this.saveTicket(record);
      return { ...summary(record, this.recoveryMode), promoted: true };
    } catch (error) {
      const restoreErrors = [], restored = [];
      for (const file of [...attempted].reverse()) {
        try {
          assertTargetPaths(record.cwd, [file]);
          const target = resolve(record.cwd, file);
          // Never overwrite a third party's later edit during failure recovery.
          const original = record.stage.sourceTargets[file], actual = fileHash(target);
          if (actual !== original) {
            if (actual !== artifact.targets[file]) throw new Error('rollback-target-changed');
            if (original === null) rmSync(target, { force: true });
            else {
              const backup = resolve(backupDir, 'files', file);
              if (fileHash(backup) !== original) throw new Error('rollback-backup-changed');
              copyAtomically(backup, target);
            }
          }
          if (fileHash(target) !== original) throw new Error('rollback-restore-mismatch');
          restored.push(file);
        } catch (failure) { restoreErrors.push(file + ': ' + failure.message); }
      }
      for (const dir of createdDirectories) {
        try {
          assertTargetPaths(record.cwd, [dir]);
          const path = resolve(record.cwd, dir);
          if (existsSync(path)) rmdirSync(path); // Empty only; never recursively remove external data.
        } catch (failure) { restoreErrors.push(dir + ': ' + failure.message); }
      }
      record.status = restoreErrors.length ? 'promotion-partial' : 'promotion-failed';
      record.promotion = { status: record.status, attemptId: last.attemptId, checkId: record.verification.checkId,
        artifact, files: changed, attempted, applied, restored, createdDirectories, backupDir, reason: error.message, restoreErrors };
      record.activeArtifactAttemptId = null;
      record.updatedAt = new Date().toISOString();
      this.saveTicket(record);
      return { ...summary(record, this.recoveryMode), promoted: false, reason: error.message };
    }
  }
}
