/** Attempt-boundary observations in the existing ticket, not another task ledger. */
import { createHash } from 'node:crypto';
import { implementationAttempt, diagnosisAttempt, diagnosisHold } from './attempts.mjs';
import { writerHold } from './writer-authority.mjs';

function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])]));
  return value ?? null;
}
export function progressFingerprint(value) {
  return createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');
}

export const PROGRESS_CAPABILITIES = Object.freeze({
  verificationProcessTree: 'windows-job-v1; local-CreateProcess-descendants-only',
  coverage: 'attempt-and-independent-check', actionStream: 'not-connected',
  freshContext: 'not-implemented', readOnlyDiagnosis: 'not-verified',
  automaticAction: 'none', semanticProgress: 'not-automatically-determined',
});

export function observeProgress(record, kind, mode = 'observe', at = new Date().toISOString()) {
  if (mode === 'off') return;
  const run = implementationAttempt(record);
  const state = record.recovery ??= { schema: 1, eventCount: 0, events: [], checkKeys: [],
    lastInformationAt: null, lastVerifiedAt: null, repeatedFailures: 0, lastFailure: null };
  let phase = 'observing', reason = 'awaiting-independent-verification', information = false;
  let signature;
  if (kind === 'attempt-started') {
    signature = progressFingerprint([kind, run.attemptId]);
    if (state.events.some(event => event.signature === signature)) return;
    reason = 'attempt-running-no-progress-claim';
    state.lastVerifiedAt = null;
  } else if (kind === 'attempt-settled') {
    signature = progressFingerprint([kind, run.attemptId, record.status, run.after, record.reason]);
    // Deduplicate before changing any counters, not just before appending history.
    if (run.progressSettlementSignature === signature || state.events.some(event => event.signature === signature)) return;
    run.progressSettlementSignature = signature;
    if (run.outcomeKnown !== true) {
      phase = 'reconciling'; reason = 'transport-outcome-unknown';
    } else if (run.cancellationRequested || run.status === 'aborted') {
      phase = 'cancelled'; reason = 'cancellation-requested-no-automatic-resume';
    } else if (record.scopeAudit !== 'passed' || record.status === 'source-drift') {
      phase = 'hold'; reason = 'scope-or-source-reconciliation-required';
    } else if (run.status !== 'completed' || !run.changedFiles.length) {
      // Only observed inputs are compared. This is not a claim that the whole
      // machine environment stayed identical, or a semantic diagnosis.
      const failure = progressFingerprint([run.observedInputsHash, run.status, record.reason, run.after]);
      const same = state.lastFailure === failure;
      state.repeatedFailures = same ? state.repeatedFailures + 1 : 1;
      state.lastFailure = failure;
      phase = state.repeatedFailures >= 2 ? 'candidate' : 'observing';
      reason = phase === 'candidate' ? 'repeated-outcome-without-progress' : 'attempt-ended-without-verified-progress';
    } else {
      state.repeatedFailures = 0; state.lastFailure = null;
    }
  } else if (kind === 'verification') {
    const check = record.verification;
    if (!check) return;
    // Execution IDs/time/PIDs identify provenance, not distinct test information.
    const { checkId, startedAt, endedAt, pid, container, processReceipt, lockToken, ...result } = check;
    const key = progressFingerprint([record.contractHash, run?.after, result]);
    signature = progressFingerprint([kind, key]);
    const passed = check.status === 'target-files-and-test-passed' && record.scopeAudit === 'passed';
    const unknown = ['running', 'outcome-unknown'].includes(check.status);
    const cancelled = check.status === 'aborted';
    const interrupted = check.interrupted === true || check.status === 'timeout';
    phase = unknown ? 'reconciling' : cancelled ? 'cancelled' : interrupted ? 'hold' : passed ? 'verified' : check.status === 'not-configured' ? 'hold' : 'candidate';
    reason = unknown ? 'verification-process-tree-unconfirmed' : cancelled ? 'independent-check-cancelled' : interrupted ? 'independent-check-interrupted' : passed ? 'independent-check-passed' : check.status === 'not-configured'
      ? 'independent-check-unavailable' : 'independent-check-failed';
    if (state.checkKeys.includes(key)) {
      // Re-observing an old result can restore the current phase, but cannot
      // mint information, verified timestamps, or another history event.
      state.phase = phase; state.reason = reason;
      state.lastVerifiedAt = passed ? state.events.find(event => event.signature === signature)?.at ?? null : null;
      return;
    }
    state.checkKeys.push(key);
    state.checkKeys = state.checkKeys.slice(-32);
    // A distinct independent result is an observation. Whether it refutes a
    // useful hypothesis still needs reasoning; filenames and model prose do not.
    information = !unknown && !cancelled && !interrupted && check.status !== 'not-configured';
    if (!passed) state.lastVerifiedAt = null;
    if (passed) {
      state.lastVerifiedAt = at; state.repeatedFailures = 0; state.lastFailure = null;
    }
  } else throw new TypeError('unknown progress observation kind');
  if (state.events.at(-1)?.signature === signature) return;
  state.eventCount++;
  state.events.push({ seq: state.eventCount, kind, at, signature, phase, reason,
    attemptId: run?.attemptId ?? null, evidence: kind === 'verification'
      ? { source: 'ticket.verification', contractHash: record.contractHash,
        attemptAfter: structuredClone(run?.after ?? null), snapshot: structuredClone(record.verification) }
      : { source: 'ticket.runs', attemptId: run?.attemptId ?? null } });
  state.events = state.events.slice(-32); // O(32) memory; original attempts stay in runs.
  if (information) state.lastInformationAt = at;
  state.phase = phase; state.reason = reason;
}

// A ticket projection is not a disk read, a grade or permission to retry.
export function candidatePublication(p) {
  if(p?.phase!=='observed' || typeof p.candidateSha256!=='string')return 'not-published';
  const r=p.candidateRef;if(!r)return 'digest-only';
  if(r.schema!==1 || r.ticketId!==p.binding?.ticketId || r.attemptId!==p.binding?.attemptId ||
     r.requestSha256!==p.binding?.requestSha256 || r.sha256!==p.candidateSha256)return 'reference-inconsistent';
  return 'referenced';
}
export function progressView(record, { mode = 'observe', locallyRunning = false } = {}) {
  const state = record.recovery;
  const view = { ...PROGRESS_CAPABILITIES, mode, phase: state?.phase ?? 'unobserved',
    reason: state?.reason ?? 'legacy-ticket-no-observations',
    eventCount: state?.eventCount ?? 0, repeatedFailures: state?.repeatedFailures ?? 0,
    lastInformationAt: state?.lastInformationAt ?? null, lastVerifiedAt: state?.lastVerifiedAt ?? null,
    informationBasis: 'distinct-independent-check-result; relevance-not-automatically-proven' };
  if (Object.hasOwn(record,'initialProbe')) return {...view,phase:'hold',
    reason:record.initialProbe.phase==='intent' || record.initialProbe.phase==='unknown'
      ? 'initial-outcome-unknown; no-replay' : 'initial-'+candidatePublication(record.initialProbe)+'; no-replay'};
  const diagnostic = diagnosisAttempt(record), held = diagnosisHold(record);
  if (held) return { ...view, phase: 'hold', reason: held, observationEnabled: mode !== 'off' };
  if (writerHold(record)) return { ...view, phase: 'reconciling', reason: writerHold(record),
    observationEnabled: mode !== 'off' };
  if (record.reconciliation?.required || ['running', 'outcome-unknown'].includes(record.verification?.status))
    return { ...view, phase: 'reconciling', reason: 'verification-process-tree-unconfirmed',
      observationEnabled: mode !== 'off' };
  if (mode === 'off') return { ...view, phase: 'off', reason: 'observation-disabled' };
  if (record.status === 'running') return { ...view,
    phase: locallyRunning ? 'observing' : 'reconciling',
    reason: locallyRunning ? 'attempt-running-no-progress-claim' : 'unresolved-running-attempt' };
  if (diagnostic && diagnostic.sourceImplementationAttemptId === implementationAttempt(record)?.attemptId
    && diagnostic.sourceCheckId === record.verification?.checkId
    && record.verification?.status === 'failed') return { ...view, phase: 'candidate',
    reason: 'diagnosis-data-only; experiment-not-dispatched' };
  return view;
}
