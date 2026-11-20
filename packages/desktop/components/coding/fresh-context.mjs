/** Same-ticket preparation, not a new session, executor, sandbox or dispatch authority. */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { buildDiagnosisInput, readDiagnosisSource } from './diagnosis-input.mjs';
import { validateDiagnosisProposal } from './diagnosis-transport.mjs';
import { parseDiagnosisJson } from './diagnosis-json.mjs';
import { cumulativeArtifact, diagnosisAttempt, diagnosisHold, implementationAttempt, spentTokens } from './attempts.mjs';
import { readWriterEvidence, writerBinding, writerHold } from './writer-authority.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{8,80}$/.test(value);
export const FRESH_CONTEXT_MAX_TICKET_BYTES = 256 * 1024;
export function readFreshContextTicket(stateDir, ticketId) {
  if (!id(ticketId)) throw new Error('fresh-context-arguments-invalid');
  const source = readDiagnosisSource(join(stateDir, 'tickets', ticketId + '.json'), FRESH_CONTEXT_MAX_TICKET_BYTES);
  return { source, record: parseDiagnosisJson(source.text) };
}

/** O(bounded input bytes + attempts). Caller must own the original ticket lock. */
export function buildFreshContext({ stateDir, ticketId, attemptId, diagnosisAttemptId,
  expectedProposalSha256, maxRunsPerTicket, maxInputBytes = 128 * 1024 }) {
  if (![ticketId, attemptId, diagnosisAttemptId].every(id)
    || typeof expectedProposalSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(expectedProposalSha256)
    || !Number.isSafeInteger(maxRunsPerTicket) || maxRunsPerTicket < 1
    || !Number.isSafeInteger(maxInputBytes) || maxInputBytes < 1 || maxInputBytes > 128 * 1024)
    throw new Error('fresh-context-arguments-invalid');
  // The existing bounded builder reopens exact file bytes and native check logs;
  // it never trusts a caller's transcript, summary or supplied source objects.
  const current = buildDiagnosisInput({ stateDir, ticketId, maxTicketBytes: FRESH_CONTEXT_MAX_TICKET_BYTES });
  const { source, record } = readFreshContextTicket(stateDir, ticketId);
  if (source.sha256 !== current.manifest[0].sha256)
    throw new Error('fresh-context-ticket-changed-during-assembly');
  const last = implementationAttempt(record), diagnosis = diagnosisAttempt(record);
  if (record.writerPolicy !== 1) throw new Error('fresh-context-native-writer-required');
  const held = writerHold(record) || diagnosisHold(record);
  if (held) throw new Error(held);
  const native = readWriterEvidence(stateDir, record.writerAuthority);
  if (native.receipt.receiptSha256 !== record.writerAuthority.terminal.sha256
    || native.receipt.reason !== 'completed' || native.result?.response?.outcome?.status !== 'completed'
    || !same(record.verification.writer, writerBinding(record)))
    throw new Error('fresh-context-native-binding-mismatch');
  const checkReceipt = readDiagnosisSource(current.manifest[2].path, 64 * 1024);
  if (checkReceipt.sha256 !== current.manifest[2].sha256
    || parseDiagnosisJson(checkReceipt.text).assignedBeforeResume !== true
    || record.verification.processReceipt.assignedBeforeResume !== true)
    throw new Error('fresh-context-check-atomic-assignment-required');
  if (record.provider !== 'codex' || !diagnosis || diagnosis.attemptId !== diagnosisAttemptId
    || diagnosis.status !== 'proposal' || diagnosis.outcomeKnown !== true || diagnosis.scopeUnchanged !== true
    || diagnosis.cancellationRequested || diagnosis.requestCount !== 1
    || diagnosis.sourceImplementationAttemptId !== last.attemptId
    || diagnosis.sourceCheckId !== record.verification.checkId || record.runs.at(-1) !== diagnosis)
    throw new Error('fresh-context-current-diagnosis-required');
  if (record.runs.some(run => run.attemptId === attemptId)) throw new Error('fresh-context-attempt-already-recorded');
  const limit = Math.min(record.effectiveMaxRuns ?? 2, maxRunsPerTicket), used = spentTokens(record);
  if (!Number.isSafeInteger(limit) || record.runs.length >= limit) throw new Error('fresh-context-run-limit-reached');
  if (used === null) throw new Error('fresh-context-token-usage-unknown');
  if (record.tokenBudget != null && (!Number.isSafeInteger(record.tokenBudget) || record.tokenBudget < 1
    || used >= record.tokenBudget)) throw new Error('fresh-context-token-budget-reached');
  if (sha(JSON.stringify(diagnosis.proposal)) !== expectedProposalSha256)
    throw new Error('fresh-context-proposal-selection-mismatch');

  // Diagnosis added a row to the ticket, so its old ticket-only hash must differ.
  // Reconstruct EXACT old input, not a new binding substituted into old advice.
  const original = structuredClone(current), data = parseDiagnosisJson(current.text);
  if (!Array.isArray(diagnosis.inputManifest) || diagnosis.inputManifest.length !== current.manifest.length
    || !same(diagnosis.inputManifest.slice(1), current.manifest.slice(1))
    || diagnosis.inputManifest[0]?.path !== current.manifest[0].path
    || diagnosis.inputManifest[0]?.role !== 'ticket-binding-only')
    throw new Error('fresh-context-diagnosis-sources-changed');
  data.sources = structuredClone(diagnosis.inputManifest);
  original.manifest = data.sources;
  original.text = JSON.stringify(data); original.bytes = Buffer.byteLength(original.text); original.sha256 = sha(original.text);
  if (original.sha256 !== diagnosis.inputSha256 || original.bytes !== diagnosis.inputBytes)
    throw new Error('fresh-context-original-input-mismatch');
  const proposal = validateDiagnosisProposal(original, diagnosis.proposal);
  if (proposal.assessment !== 'hypothesis' || !proposal.experiment)
    throw new Error('fresh-context-experiment-required');
  const artifact = cumulativeArtifact(record);
  if (!same(record.verification.artifact, artifact)) throw new Error('fresh-context-artifact-binding-mismatch');
  const payload = {
    schema: 1, purpose: 'prepare-one-experiment; no-execution-authority',
    binding: { ticketId, attemptId, diagnosisAttemptId, contractHash: record.contractHash,
      sourceImplementationAttemptId: last.attemptId, sourceCheckId: record.verification.checkId,
      diagnosisInputSha256: original.sha256, proposalSha256: expectedProposalSha256,
      writerGeneration: record.writerAuthority.generation, writerReceiptSha256: native.receipt.receiptSha256 },
    contract: data.contract, files: data.files, artifact,
    independentCheck: data.independentCheck,
    diagnosisSources: original.manifest.map((row, index) => ({ sourceId: 'S' + index, ...row })),
    candidate: { authority: 'untrusted-hypothesis-and-predictions; not facts, commands, patches or authorization',
      hypothesis: proposal.hypotheses.find(row => row.id === proposal.experiment.hypothesisId),
      experiment: proposal.experiment },
    boundary: { executionEnabled: false, modelCalls: 0, automaticAction: 'none',
      acceptanceAuthority: 'unchanged-frozen-contract-and-independent-verification',
      futureUse: 'revalidate-current-ticket-writer-scope-evidence-budget-and-selection-under-original-lock',
      contextIsolation: 'material-selection-only; no-CLI-home-session-or-filesystem-isolation-proven' },
  };
  const text = JSON.stringify(payload), bytes = Buffer.byteLength(text);
  if (bytes > maxInputBytes) throw new Error('fresh-context-input-byte-budget-exceeded');
  // Recheck after construction, including logs/target files. No silently trimmed data.
  if (!same(buildDiagnosisInput({ stateDir, ticketId, maxTicketBytes: FRESH_CONTEXT_MAX_TICKET_BYTES }), current))
    throw new Error('fresh-context-source-changed-during-assembly');
  return { schema: 1, status: 'prepared', attemptId, diagnosisAttemptId,
    proposalSha256: expectedProposalSha256, packet: { text, bytes, sha256: sha(text) } };
}
