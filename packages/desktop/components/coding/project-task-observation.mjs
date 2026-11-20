/** P2 observation of the existing ledger. No new ledger, native audit or admission gate. */
import { attemptKind, implementationAttempt, artifactAttempt, diagnosisAttempt, diagnosisHold, spentTokens } from './attempts.mjs';
import { writerHold } from './writer-authority.mjs';
import { progressFingerprint } from './progress.mjs';
import { linkedTicketId, unitedTaskFiles, assertUnitedTask } from './united-task.mjs';
import { taskReadSession, taskHash, allowedTaskWorkspace } from './project-task-source.mjs';
import { ReviewError, sourcePath } from './project-review-source.mjs';

const fail = code => { throw new ReviewError(code); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const hash = x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const id = x => typeof x === 'string' && /^[a-zA-Z0-9_-]{8,80}$/.test(x);
const safeStatus = (value, allowed) => allowed.includes(value) ? value : 'unknown';
const safeInteger = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

// Existence in a ledger is separate from exposure, validation and live truth.
const ownState = (object, key) => !Object.hasOwn(object, key) ? 'not-recorded'
  : object[key] === null ? 'explicit-null' : 'recorded';
const ATTEMPT_VIEW_ROWS = 8;

/** Static documentation of OTHER tools, never their admission predicate.
 * Keep coordinator as the sole live authority. Returning this does no recovery.
 */
export function projectOperationContracts() {
  return { version: 'coding-operation-semantics-v1', kind: 'description-not-admission',
    executionPermission: 'none', admission: 'not-evaluated-use-original-coordinator',
    verify: { tool: 'yunshu_code_verify', reconcile: false, purpose: 'independent-target-and-test-verification',
      effects: { mayRunTestCommand: true, mayWriteTicketAndProgress: true, mayWriteLocksAndReceipts: true },
      notFor: ['read-only-information-query', 'implementation-failure-stage-diagnosis'] },
    reconcileVerification: { tool: 'yunshu_code_verify', reconcile: true,
      purpose: 'settle-existing-independent-verification-job', pureReadOnly: false,
      effects: { callsModel: false, replaysOperation: false, runsTestCommand: false,
        mayWriteTicketAndProgress: true, mayCreateOrRetireLocksAndGuards: true },
      prerequisitesToRecheck: ['original-verification-awaits-reconciliation', 'bound-native-verification-receipt',
        'original-owner-lock-and-workspace-checks'],
      notFor: ['generic-implementation-runner-or-relay-investigation', 'prove-implementation-failure-stage',
        'guarantee-native-receipt-availability', 'guarantee-coverage-gaps-closed'],
      applicability: 'not-evaluated; verification-presence-is-a-fact-not-permission' } };
}
function contractProjection(record) {
  const contract = record.contractSnapshot;
  const field = (name, validation) => ({ recordState: ownState(contract, name),
    exposure: 'not-expanded', validation });
  return { source: 'ticket.contractSnapshot', hashMatched: true, semanticJudgment: 'unverified',
    omissionMeaning: 'not-expanded-does-not-mean-not-recorded-or-nonexistent', fields: {
      goal: field('goal', 'required-nonempty-text'),
      deliverable: field('deliverable', 'required-nonempty-text'),
      acceptance: field('acceptance', 'required-nonempty-text'),
      files: { ...field('files', 'record-match-and-target-path-shape'), count: record.files.length },
      checkProgram: field('checkProgram', 'record-equality-only-not-executable-validation'),
      checkArgs: field('checkArgs', 'record-match-and-string-array'),
    }, liveFileExistence: 'not-observed', commandExecutability: 'not-observed' };
}
function attemptProjection(record, current) {
  // O(runs), bounded by TASK_READ_LIMITS.attempts. Only eight recent rows are
  // returned; omitted rows remain recorded, not missing. IDs never get renumbered.
  return { source: 'ticket.runs', total: record.runs.length, maxRows: ATTEMPT_VIEW_ROWS,
    omittedRows: Math.max(0, record.runs.length - ATTEMPT_VIEW_ROWS), order: 'original-ledger-order',
    firstImplementationAttemptId: record.runs.find(r => attemptKind(r) === 'implement').attemptId,
    lastImplementationAttemptId: current.attemptId,
    recent: record.runs.slice(-ATTEMPT_VIEW_ROWS).map(r => ({ attemptId: r.attemptId, kind: attemptKind(r),
      status: safeStatus(r.status, ['running', 'completed', 'failed', 'aborted', 'timeout']) })),
    interpretation: 'use-recorded-ids-only-no-sequence-inference' };
}
function observationProvenance(config) {
  // A server declaration can restrict a result to synthetic use, never certify
  // production readiness. No guessing from a path, ticket or model declaration.
  return { source: 'original-ledger-records',
    environment: config.projectReviewSourceKind === 'synthetic-fixture' ? 'synthetic-fixture' : 'unknown',
    environmentBasis: config.projectReviewSourceKind === 'synthetic-fixture' ? 'server-declaration' : 'not-established',
    localMachineExistenceObserved: false, providerReadinessObserved: false,
    productionReadiness: 'not-established', inferenceBoundary: 'ledger-or-fixture-not-live-production-proof' };
}

// Reuse original settlement signatures. Do not mutate observeProgress or increment
// anything on polls. Only a supported suffix can corroborate the retained counter.
function repeatedFailure(record, current) {
  const recovery = record.recovery, runs = record.runs.filter(r => !Object.hasOwn(r, 'kind') || r.kind === 'implement');
  if (!Number.isSafeInteger(recovery?.repeatedFailures) || recovery.repeatedFailures < 2 || runs.length < 2
    || !Array.isArray(recovery.events) || recovery.events.length > 32 || !hash(current.observedInputsHash)) return false;
  const pair = runs.slice(-2), indices = [];
  for (const run of pair) {
    if (run.outcomeKnown !== true || run.cancellationRequested || run.status === 'aborted'
      || run.observedInputsHash !== current.observedInputsHash || run.status !== current.status
      || !same(run.after, current.after) || !Array.isArray(run.changedFiles)
      || (run.status === 'completed' && run.changedFiles.length)) return false;
    const signature = progressFingerprint(['attempt-settled', run.attemptId, record.status, run.after, record.reason]);
    if (run.progressSettlementSignature !== signature) return false;
    const index = recovery.events.findIndex(e => e.signature === signature && e.kind === 'attempt-settled'
      && e.attemptId === run.attemptId && e.evidence?.source === 'ticket.runs'
      && e.evidence.attemptId === run.attemptId
      && ['attempt-ended-without-verified-progress', 'repeated-outcome-without-progress'].includes(e.reason));
    if (index < 0) return false;
    indices.push(index);
  }
  const expected = progressFingerprint([current.observedInputsHash, current.status, record.reason, current.after]);
  return indices[0] < indices[1] && recovery.lastFailure === expected
    && !recovery.events.slice(indices[0] + 1).some(e => {
      if (e.kind !== 'verification') return false;
      const check = e.evidence?.snapshot;
      // Match original progress.information, not mere presence of a check event.
      // Missing evidence conservatively interrupts corroboration; unavailable,
      // interrupted or still unknown checks did not add independent information.
      return !check || !(check.interrupted === true
        || ['running', 'outcome-unknown', 'aborted', 'timeout', 'not-configured'].includes(check.status));
    });
}

function negativePrecheckBinding(record, current, check) {
  // Original verify preflight can fail before a process/check ID exists. Recover
  // only its negative observation, from the original bound verification event.
  // Never use this fallback for a pass or a conflicting explicit attempt/check ID.
  if (!check || !['failed', 'not-configured'].includes(check.status)
    || Object.hasOwn(check, 'attemptId') || Object.hasOwn(check, 'checkId')) return false;
  const state = record.recovery;
  if (!Array.isArray(state?.events) || state.events.length > 32 || !Array.isArray(state.checkKeys)) return false;
  const { checkId, startedAt, endedAt, pid, container, processReceipt, lockToken, ...result } = check;
  const key = progressFingerprint([record.contractHash, current.after, result]);
  if (!state.checkKeys.includes(key)) return false;
  return state.events.some(event => event.kind === 'verification' && event.attemptId === current.attemptId
    && event.signature === progressFingerprint(['verification', key]) && event.evidence?.source === 'ticket.verification'
    && event.evidence.contractHash === record.contractHash && same(event.evidence.attemptAfter, current.after)
    && same(event.evidence.snapshot, check));
}

function recordFacts(record, limits, config) {
  if (!Array.isArray(record.runs) || !record.runs.length || record.runs.length > limits.attempts
    || record.runs.some(r => !object(r) || !id(r.attemptId))) fail('task-attempt-shape');
  const current = implementationAttempt(record), diagnostic = diagnosisAttempt(record), check = record.verification;
  if (!current) fail('task-implementation-missing');
  const holds = [], gaps = ['native-receipts-not-reaudited', 'live-workspace-not-audited'];
  const hold = reason => { if (reason && !holds.includes(reason)) holds.push(reason); };
  const targetSnapshot = value => object(value) && Object.keys(value).length === record.files.length
    && record.files.every(f => Object.hasOwn(value, f) && (value[f] === null || hash(value[f])));
  const currentStatus = safeStatus(current.status, ['running', 'completed', 'failed', 'aborted', 'timeout']);
  const checkStatus = check ? safeStatus(check.status, ['running', 'outcome-unknown', 'aborted', 'timeout', 'failed',
    'not-configured', 'target-files-and-test-passed']) : 'absent';
  if (!['created', 'running', 'needs-verification', 'needs-review', 'failed', 'aborted', 'timeout', 'scope-violation',
    'source-drift', 'promoted', 'verified', 'completed'].includes(record.status)) hold('task-status-unknown');
  if (current.cancellationRequested || currentStatus === 'aborted' || record.status === 'aborted'
    || check?.cancellationRequested || checkStatus === 'aborted' || diagnostic?.cancellationRequested) hold('cancelled');
  if (record.status === 'running' || currentStatus === 'running' || checkStatus === 'running') hold('running');
  if (current.outcomeKnown !== true || currentStatus === 'unknown' || checkStatus === 'outcome-unknown'
    || current.fresh && current.fresh.providerOutcomeKnown !== true) hold('outcome-unknown');
  if (record.reconciliation?.required) hold('reconciliation-required');
  const writer = writerHold(record), diagnosis = diagnosisHold(record);
  if (writer) hold('writer-unsettled');
  if (diagnosis) hold('diagnosis-unsettled');
  if (record.scopeAudit !== 'passed' || ['source-drift', 'scope-violation'].includes(record.status)
    || record.outOfScope?.length || current.outOfScope?.length) hold('scope-reconciliation-required');
  if (!targetSnapshot(current.after)) hold('attempt-target-snapshot-missing');
  if (checkStatus === 'unknown') hold('verification-status-unknown');
  if (check?.interrupted || checkStatus === 'timeout') hold('verification-interrupted');
  const explicitCheckBound = !!check && check.attemptId === current.attemptId && typeof check.checkId === 'string'
    && /^[a-zA-Z0-9_-]{1,80}$/.test(check.checkId)
    && targetSnapshot(check.observedTargets) && same(check.observedTargets, current.after);
  const precheckBound = negativePrecheckBinding(record, current, check);
  const checkBound = explicitCheckBound || precheckBound;
  if (check && !checkBound) { gaps.push('verification-not-bound-to-current-attempt'); hold('verification-binding-unresolved'); }
  let artifactBound = false;
  if (checkStatus === 'target-files-and-test-passed' && checkBound) {
    try { artifactBound = artifactAttempt(record)?.attemptId === current.attemptId; }
    catch { hold('artifact-binding-unresolved'); }
    if (!artifactBound) hold('artifact-binding-unresolved');
  }
  const used = spentTokens(record), tokenBudget = record.tokenBudget === null ? null : safeInteger(record.tokenBudget);
  const maxRuns = Number.isSafeInteger(record.effectiveMaxRuns) && record.effectiveMaxRuns > 0
    ? Math.min(record.effectiveMaxRuns, config.maxRunsPerTicket ?? record.effectiveMaxRuns) : null;
  if (maxRuns === null) gaps.push('effective-run-limit-unknown');
  if (used === null) gaps.push('token-usage-unknown');
  if (record.tokenBudget !== null && (tokenBudget === null || tokenBudget === 0)) gaps.push('token-budget-unknown');
  const repeated = repeatedFailure(record, current);
  const failed = currentStatus !== 'completed' || (Array.isArray(current.changedFiles) && !current.changedFiles.length)
    || checkBound && checkStatus === 'failed';
  // A current verified cumulative artifact can include earlier useful changes;
  // a no-op final attempt does not invalidate that original verification.
  const failure = artifactBound ? 'none' : repeated ? 'repeated' : failed ? 'first' : 'unknown';
  if (record.recovery?.repeatedFailures >= 2 && !repeated) gaps.push('repeated-counter-not-corroborated');
  return {
    holds, gaps, failure,
    executionState: holds.includes('cancelled') ? 'cancelled' : holds.includes('outcome-unknown') ? 'outcome-unknown'
      : holds.includes('running') ? 'running' : holds.length ? 'reconciliation' : 'idle',
    facts: {
      contract: contractProjection(record), attempts: attemptProjection(record, current),
      implementation: { attemptId: current.attemptId, status: currentStatus, outcomeKnown: current.outcomeKnown === true },
      verification: { recordState: ownState(record, 'verification'), status: checkStatus, checkId: explicitCheckBound ? check.checkId : null,
        currentBinding: checkBound, bindingBasis: explicitCheckBound ? 'attempt-and-targets' : precheckBound ? 'original-negative-precheck-event' : 'unresolved',
        recordedArtifactBinding: artifactBound, independentlyReaudited: false,
        nativeReceipt: { referenceState: check && object(check) ? ownState(check, 'container') : 'not-recorded',
          readByThisTool: false, existence: 'not-observed' } },
      writer: { present: Object.hasOwn(record, 'writerPolicy'), held: !!writer,
        generation: safeInteger(record.writerAuthority?.generation), independentlyReaudited: false },
      progress: { failure, repeatedCorroborated: repeated, countIncremented: false,
        basis: 'original-attempts-and-retained-events; observed-inputs-only-not-causality' },
      budget: { enforcement: 'before-next-run-only', historicalCauseEstablished: false, usedTokens: used, tokenBudget, effectiveMaxRuns: maxRuns, attempts: record.runs.length,
        remainingAttempts: maxRuns === null ? null : Math.max(0, maxRuns - record.runs.length), cost: 'unknown',
        runLimitReached: maxRuns === null ? null : record.runs.length >= maxRuns,
        tokenLimitReached: tokenBudget === null || used === null ? null : used >= tokenBudget },
      // Preserve original accounting, but name the two scopes explicitly. A
      // later diagnose run belongs in cumulative usage, not latest implement.
      usage: { lastImplementation: { attemptId: current.attemptId,
        reportedTotalTokens: safeInteger(current.usage?.totalTokens) },
        cumulative: { scope: 'all-ledger-runs', reportedTotalTokens: used,
          completeInOriginalLedger: used !== null },
        comparison: 'last-implementation-and-cumulative-are-different-scopes',
        statusFieldMeaning: 'ticket-status.usage-is-last-implementation; tokenBudget.used-is-all-runs',
        billingVerified: false, cost: 'unknown' },
      causality: { established: false, failureStage: 'unknown',
        codeSemanticCauseExcluded: false, transportCauseEstablished: false,
        basis: 'outcome-labels-and-observed-deltas-do-not-establish-cause' },
    },
  };
}

/** Returns a short-lived dependency-bound view. The caller MUST recheck after
 * reading decision attachments, before returning; no stale cache is accepted.
 */
export async function observeProjectTask(ticketId, config, signal) {
  if (!id(ticketId)) fail('task-id-invalid');
  const read = taskReadSession({ limits: config.taskLimits }, signal);
  const ticketFile = 'tickets/' + ticketId + '.json';
  const lock = await read.marker(config.stateDir, ticketFile + '.lock');
  const guard = await read.marker(config.stateDir, ticketFile + '.reconcile.lock');
  const mutationLocked = lock || guard;
  const record = await read.json(config.stateDir, ticketFile);
  if (!object(record) || record.ticketId !== ticketId) fail('task-id-mismatch');
  const contract = record.contractSnapshot;
  if (!object(contract) || !hash(record.contractHash) || taskHash(JSON.stringify(contract)) !== record.contractHash)
    fail('task-contract-missing-or-mismatched');
  for (const key of ['cwd', 'files', 'checkProgram', 'checkArgs', 'workspaceMode', 'united']) {
    if (!same(record[key], contract[key])) fail('task-contract-field-mismatch');
  }
  if (!Array.isArray(record.files) || !record.files.length || record.files.length > read.limits.files
    || new Set(record.files).size !== record.files.length) fail('task-file-scope-invalid');
  // Original Windows contracts preserve separators in snapshot keys. Validate
  // components without rewriting contract/after keys or rejecting valid spelling.
  for (const file of record.files) sourcePath(file);
  if (!['codex', 'claude'].includes(record.provider) || !['direct', 'git-worktree'].includes(record.workspaceMode)
    || !Array.isArray(record.checkArgs) || record.checkArgs.some(a => typeof a !== 'string')
    || !['goal', 'deliverable', 'acceptance'].every(k => typeof contract[k] === 'string' && contract[k].trim())) fail('task-contract-invalid');
  const workspace = await allowedTaskWorkspace(record.cwd, config.allowedRoots);
  const view = recordFacts(record, read.limits, config);
  if (mutationLocked) { view.holds.unshift('mutation-locked'); view.executionState = 'reconciliation'; }
  let united = null, deadlineAt = null;
  if (record.united) {
    const link = record.united;
    if (typeof link.phase !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(link.phase)
      || typeof link.goalId !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(link.goalId)
      || !Number.isSafeInteger(link.goalRev) || link.goalRev < 1) fail('task-united-link-invalid');
    if (linkedTicketId(link.runId, link.messageId) !== ticketId) fail('task-united-id-mismatch');
    const dir = 'runs/' + link.runId;
    const state = await read.json(config.unitedRoot, dir + '/state.json');
    const pending = state?.pending?.[link.messageId];
    if (!pending) fail('task-united-pending-missing');
    const files = unitedTaskFiles(dir, link.messageId, pending);
    // Canonical in -> claimed precedence is shared with the existing bridge.
    const incoming = await read.json(config.unitedRoot, files[0], true);
    // Only absence allows fallback. A present JSON null is a corrupt canonical file.
    const envelope = incoming === undefined ? await read.json(config.unitedRoot, files[1]) : incoming;
    if (!object(envelope)) fail('task-united-envelope-invalid');
    assertUnitedTask(link.runId, link.messageId, state, pending, envelope);
    if (envelope.goal_id !== link.goalId || envelope.goal_rev !== link.goalRev || envelope.phase !== link.phase
      || envelope.to !== link.part || link.part !== 'builder' || envelope.execution_mode !== 'manual'
      || envelope.task?.objective !== contract.goal || envelope.task?.acceptance !== contract.acceptance)
      fail('task-united-contract-mismatch');
    if (!['open', 'running'].includes(state.status) || pending.status !== 'pending') view.holds.push('united-not-active-pending');
    const deadline = pending.deadline_at;
    deadlineAt = deadline ? Date.parse(deadline) : null;
    if (deadline && (!Number.isFinite(Date.parse(deadline)) || Date.now() > Date.parse(deadline))) view.holds.push('united-deadline-unresolved');
    united = { runId: link.runId, messageId: link.messageId, goalRevision: link.goalRev, phase: link.phase,
      runStatus: safeStatus(state.status, ['open', 'running', 'done', 'failed', 'cancelled']),
      assignmentStatus: safeStatus(pending.status, ['pending', 'settled', 'expired', 'cancelled']) };
  }
  if (view.holds.length && view.executionState === 'idle') view.executionState = 'reconciliation';
  // Bind the entire returned semantic view, not selected config keys: an effective
  // server budget or future projected fact can change with identical ledger bytes.
  // Read accounting is added after recheck and deliberately has no decision credit.
  const projectionVersion = 'project-task-view-v2', provenance = observationProvenance(config);
  const ledgerDependenciesSha256 = read.digest();
  const projectedView = {
    ticketId, contractSha256: record.contractHash,
    workspace, provider: record.provider, executionState: view.executionState, failure: view.failure,
    holds: view.holds, coverageGaps: view.gaps, facts: view.facts, united,
    projectionVersion, provenance,
    authority: 'original-ledger-records', binding: 'authoritative', consistency: 'optimistic-reread-not-lease',
    executionPermission: 'none', semanticJudgment: 'unverified',
  };
  const viewSemanticsSha256 = taskHash(JSON.stringify(projectedView));
  const snapshotSha256 = taskHash(JSON.stringify({ ledgerDependenciesSha256, viewSemanticsSha256,
    operationContractsSha256: taskHash(JSON.stringify(projectOperationContracts())) }));
  const snapshot = { ...projectedView, ledgerDependenciesSha256, viewSemanticsSha256, snapshotSha256 };
  return { snapshot, recheck: async () => {
    await read.recheck();
    if (await allowedTaskWorkspace(record.cwd, config.allowedRoots) !== workspace) fail('task-workspace-changed');
    if (deadlineAt !== null && Date.now() > deadlineAt && !view.holds.includes('united-deadline-unresolved'))
      fail('task-deadline-changed');
    snapshot.readBytes = read.readBytes;
  } };
}
