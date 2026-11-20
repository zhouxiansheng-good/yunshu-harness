/** Model-call history is not the artifact/session pointer. O(number of attempts). */
import { writerHold, writerBinding } from './writer-authority.mjs';
const own = (value, name) => Object.hasOwn(value, name);
export function attemptKind(attempt) {
  const kind = own(attempt, 'kind') ? attempt.kind : 'implement'; // Only an absent field is legacy.
  if (!['implement', 'diagnose'].includes(kind)) throw new Error('attempt-kind-invalid');
  return kind;
}
export function implementationAttempt(record) {
  let last = null;
  const ids = new Set();
  for (const attempt of record.runs ?? []) {
    if (typeof attempt.attemptId !== 'string' || ids.has(attempt.attemptId)) throw new Error('attempt-id-invalid');
    ids.add(attempt.attemptId);
    if (attemptKind(attempt) === 'implement') last = attempt;
  }
  if (own(record, 'lastImplementationAttemptId') && record.lastImplementationAttemptId !== (last?.attemptId ?? null))
    throw new Error('implementation-reference-mismatch');
  return last;
}
export function artifactAttempt(record) {
  if (writerHold(record)) return null;
  if (record.writerPolicy === 1 && JSON.stringify(record.verification?.writer) !== JSON.stringify(writerBinding(record))) return null;
  const last = implementationAttempt(record), check = record.verification;
  if (!last || check?.status !== 'target-files-and-test-passed' || record.scopeAudit !== 'passed') return null;
  if (last.status !== 'completed' || last.outcomeKnown === false
    || (own(last, 'kind') && last.outcomeKnown !== true) || last.cancellationRequested) return null;
  if (own(record, 'activeArtifactAttemptId')) {
    if (record.activeArtifactAttemptId === null) return null;
    if (record.activeArtifactAttemptId !== last.attemptId || check.attemptId !== last.attemptId)
      throw new Error('artifact-reference-mismatch');
    if (!check.observedTargets || !last.after || Object.keys(check.observedTargets).length !== record.files?.length
      || record.files.some(file => check.observedTargets[file] !== last.after[file])) throw new Error('artifact-target-binding-mismatch');
    if (own(record, 'artifactPolicy')) {
      if (record.artifactPolicy !== 1) throw new Error('artifact-policy-invalid');
      if (JSON.stringify(check.artifact) !== JSON.stringify(cumulativeArtifact(record)))
        throw new Error('cumulative-artifact-binding-mismatch');
    }
    return last;
  }
  // Only untouched legacy records may infer the old positional binding. A new
  // typed attempt without an explicit verify binding must not recover an old pass.
  return (record.runs ?? []).every(attempt => !own(attempt, 'kind'))
    && (!own(check, 'attemptId') || check.attemptId === last.attemptId) ? last : null;
}
export function bindImplementation(record, attempt) {
  if (implementationAttempt({ ...record, lastImplementationAttemptId: attempt.attemptId }) !== attempt)
    throw new Error('implementation-reference-mismatch');
  record.lastImplementationAttemptId = attempt.attemptId;
  record.activeArtifactAttemptId = null;
}
export function bindVerifiedArtifact(record) {
  if (writerHold(record)) throw new Error(writerHold(record));
  if (record.writerPolicy === 1 && JSON.stringify(record.verification?.writer) !== JSON.stringify(writerBinding(record)))
    throw new Error('verified-writer-binding-required');
  const attempt = implementationAttempt(record);
  if (!attempt || attempt.status !== 'completed' || attempt.outcomeKnown === false
    || (own(attempt, 'kind') && attempt.outcomeKnown !== true) || attempt.cancellationRequested
    || record.verification?.status !== 'target-files-and-test-passed' || record.scopeAudit !== 'passed')
    throw new Error('verified-implementation-required');
  if (own(record, 'artifactPolicy') && (record.artifactPolicy !== 1
    || JSON.stringify(record.verification.artifact) !== JSON.stringify(cumulativeArtifact(record))))
    throw new Error('cumulative-artifact-binding-mismatch');
  record.verification.attemptId = attempt.attemptId;
  record.lastImplementationAttemptId = attempt.attemptId;
  record.activeArtifactAttemptId = attempt.attemptId;
}
/** The final net result, not a union of per-call deltas. O(attempts + scoped files). */
export function cumulativeArtifact(record) {
  const last = implementationAttempt(record), files = record.files;
  if (!last || !Array.isArray(files) || !files.length || new Set(files).size !== files.length)
    throw new Error('cumulative-artifact-scope-invalid');
  const first = record.runs.find(attempt => attemptKind(attempt) === 'implement');
  const source = record.stage ? record.stage.sourceTargets : first.before;
  for (const targets of [source, last.after]) {
    if (!targets || typeof targets !== 'object' || Array.isArray(targets)
      || Object.keys(targets).length !== files.length || files.some(file => !own(targets, file)
        || (targets[file] !== null && (typeof targets[file] !== 'string' || !/^[a-f0-9]{64}$/.test(targets[file])))))
      throw new Error('cumulative-artifact-target-snapshot-invalid');
  }
  return { schema: 1, implementationAttemptId: last.attemptId,
    baseline: record.stage ? 'frozen-stage-source' : 'first-implementation-before',
    baselineTargets: Object.fromEntries(files.map(file => [file, source[file]])),
    targets: Object.fromEntries(files.map(file => [file, last.after[file]])),
    files: files.filter(file => source[file] !== last.after[file]) };
}
export function spentTokens(record) {
  let total = 0;
  for (const attempt of record.runs ?? []) {
    const count = attempt.usage?.totalTokens;
    if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(total + count)) return null;
    total += count;
  }
  return total;
}
export function diagnosisAttempt(record) {
  implementationAttempt(record); // Validate every kind/ID and the implementation pointer first.
  return (record.runs ?? []).findLast(attempt => attemptKind(attempt) === 'diagnose') ?? null;
}
export function diagnosisHold(record) {
  const attempt = diagnosisAttempt(record);
  if (!attempt) return null;
  return attempt.cancellationRequested ? 'diagnosis-cancelled-no-automatic-resume'
    : attempt.status === 'running' || attempt.outcomeKnown !== true ? 'diagnosis-outcome-unknown'
    : attempt.scopeUnchanged !== true ? 'diagnosis-scope-reconciliation-required' : null;
}
