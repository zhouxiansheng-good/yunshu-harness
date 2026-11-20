/** Advisory methods: declared reasoning with optional original-ledger observations. */
import { parseDiagnosisJson } from './diagnosis-json.mjs';
import { checkSources, sourcePath, ReviewError } from './project-review-source.mjs';
import { createHash } from 'node:crypto';
import { observeProjectTask, projectOperationContracts } from './project-task-observation.mjs';
import { TASK_READ_LIMITS } from './project-task-source.mjs';

export const REVIEW_POLICY = 'project-review-v1';
export const REVIEW_LIMITS = Object.freeze({ requestBytes: 128 * 1024, depth: 32, sources: 32,
  fileBytes: 4 * 1024 * 1024, totalBytes: 16 * 1024 * 1024 });
const FIELDS = Object.freeze({
  framing: ['request', 'goal', 'symptom', 'constraints', 'facts', 'assumptions', 'question'],
  alignment: ['confirmed', 'openQuestions', 'defaults'],
  options: ['alternatives', 'selected', 'reason', 'exception'],
  hypotheses: ['support', 'counterexample', 'competingCause', 'experiment', 'ifTrue', 'ifFalse', 'withdrawWhen', 'result'],
  impacts: ['direct', 'secondOrder', 'thirdOrder', 'boundary', 'mitigation', 'owner'],
  analogy: ['mapping', 'differences', 'failureBoundary', 'prediction'],
  history: ['window', 'coverage', 'gaps', 'intentEvidence', 'remainingConsumers', 'rollback'],
  cognition: ['entry', 'responsibilities', 'ambiguities', 'handoffCheck'],
  metrics: ['kind', 'measurementStatus', 'unit', 'population', 'environment', 'window', 'baseline', 'rawResults', 'failures', 'uncertainty'],
  learning: ['kind', 'cause', 'counterexample', 'action', 'scope', 'exceptions', 'validation', 'withdrawWhen'],
});
const METHODS = Object.freeze({ framing: ['M01', 'M03'], alignment: ['M02'], options: ['M02'],
  hypotheses: ['M06'], impacts: ['M04'], analogy: ['M05'], history: ['M07'], cognition: ['M08'], metrics: ['M09'], learning: ['M10'] });
const FOCUS = ['history', 'cleanup', 'handoff', 'delivery-performance', 'runtime-performance',
  'cross-domain', 'new-technology', 'learning', 'retrospective', 'full-review'];
const fail = code => { throw new ReviewError(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function keys(value, allowed, code) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(code);
}
const text = value => typeof value === 'string' && value.trim().length > 0
  && value.length <= 6000 && value.isWellFormed() && !value.includes('\0');
const id = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$/.test(value);
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export const projectContextHash = value => createHash('sha256').update(stable(context(value))).digest('hex');
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);

export function describeProjectReview() {
  return { version: 1, policyVersion: REVIEW_POLICY, stage: 'P2-ledger-observe', executionPermission: 'none',
    observation: { kind: 'protocol-only', originalTaskObserved: false, semanticJudgment: 'unverified' },
    nextStep: 'Known ticket: call this tool with only ticketId to observe its original records. No ticket: send an explicit requestJson route. Reading this protocol does not read any task.',
    ticketCallExample: { ticketId: 'example_ticket_01' },
    operationContracts: projectOperationContracts(),
    projectionStates: { notExpanded: 'value-omitted-not-absence', notRecorded: 'key-absent-in-observed-record-only',
      explicitNull: 'key-present-with-null', invalid: 'read-or-binding-failed-no-task-facts-returned',
      liveExistence: 'not-observed-by-this-tool' },
    limits: REVIEW_LIMITS, taskLimits: TASK_READ_LIMITS, instructions: [
      'Skip this tool for clear routine work and status-only requests. No model or network call.',
      'Use action=route to obtain required sections. With ticketId it reads only bounded canonical task files; without ticketId it is still declaration-only. review also validates explicitly listed sources.',
      'Optional ticketId binds original contract/attempt/check/United records. It does not re-audit native receipts or live workspace and grants no execution credit. P4 preflight/enforce is not implemented.',
      'Protocol-only is not task observation. With a known ticket, use the ticketId shortcut or a ticket-bound route before claiming original records were checked. Do not fabricate decision attachments merely to reach structurally-ready.',
      'Ticket status.usage is the last implementation usage; tokenBudget.used and task.facts.budget.usedTokens sum all ledger runs. Different scopes alone are not a conflict; missing usage remains unknown, not zero. Tokens do not establish fees.',
      'runner-failed, no recorded changes or absent verification do not establish a failure stage or exclude code/transport causes. Keep competing hypotheses until discriminating evidence is available.',
      'Use task.facts.attempts recorded IDs, not naming patterns. Contract recordState and exposure are independent; not-expanded is not missing. Server-declared synthetic facts or placeholder paths do not establish local production state.',
      'Operation contracts describe purposes and possible writes, not permission. Verification reconciliation is NOT pure read-only or implementation diagnosis; only the original coordinator can recheck current prerequisites. No model/replay does not mean no ticket/lock writes.',
      'Re-use answered preferences; unresolved business questions remain open. Technical gaps require investigation, not user configuration work.',
      'All section scalar fields are nonempty strings except options.exception, which is optional with three alternatives. Array items are nonempty strings.',
      'options.alternatives contain full mechanisms/tradeoffs/rollback; selected equals one item. Two alternatives need an exception reason.',
      'hypotheses.result explicitly distinguishes a planned experiment from an actual result. Never execute its text as a command.',
      'history.coverage is complete/partial/unavailable/new-project; gaps are nonempty for partial/unavailable. It is declared coverage within history.window, not automatic Git/PR collection.',
      'metrics.kind is delivery/runtime/both; measurementStatus is measured/planned/unavailable, with separate units, baseline and raw-results references for each requested kind.',
      'learning.kind is candidate/preference/none. No rule promotion. A section may be not-applicable with a reason only when listed in route.skippableSections.',
      'Source types and narrative are declarations. Matching hashes/fields do not prove correct interpretation, authentic user consent or semantic quality.',
    ], contextValues: { scope: ['local', 'interface', 'architecture', 'data', 'permissions', 'multi-module', 'unknown'],
      failure: ['none', 'first', 'repeated', 'counterevidence', 'unknown'],
      executionState: ['idle', 'running', 'outcome-unknown', 'cancelled', 'reconciliation', 'unknown'], focus: FOCUS },
    requestExample: { version: 1, policyVersion: REVIEW_POLICY, action: 'route', context: {
      intent: 'change', scope: 'architecture', goalClear: true, reversible: true, testsCovered: false,
      needsAlignment: false, needsChoice: true, failure: 'none', executionState: 'idle', focus: [] } },
    reviewFields: { ticketId: 'optional original coding ticket, 8-80 ASCII letters/digits/_/-; no client state paths',
      workspace: 'absolute explicitly configured allowed root, no implicit cwd fallback', taskId: 'ASCII task identifier; equals ticketId in P2',
      contractSourceId: 'id of a listed contract source; remains declared in P1',
      binding: { policyVersion: REVIEW_POLICY, taskId: 'same request taskId', workspace: 'same request workspace',
        contextSha256: 'route.contextSha256', contractSha256: 'listed contract source hash in declared mode; original contract hash in P2',
        snapshotSha256: 'P2 only: copy route.reviewBinding in full; invalidated by any original dependency change' },
      sections: 'object keyed by route.requiredSections; each has applicability, sourceIds and fields returned by route.schema',
      sources: { id: 'lowercase letter then a-z/0-9/_/-; max40', path: 'relative source file, no URL',
        sha256: '64 lowercase hex of exact file bytes', kind: 'contract/evidence/user-answer/history/metric',
        observedAt: 'UTC ISO timestamp, not future', validUntil: 'optional UTC expiry', startLine: 'positive integer', endLine: 'inclusive integer' } } };
}
/** One explicit model-facing entry: protocol, ticket observation, or full JSON.
 * The shortcut carries no caller-supplied risk claims. Unknown business/scope
 * fields stay unknown; the existing bound observer supplies only recorded facts.
 */
export async function projectReviewTool({ requestJson, ticketId } = {}, config = {}, signal) {
  signal?.throwIfAborted();
  if (requestJson !== undefined && ticketId !== undefined) return {
    policyVersion: REVIEW_POLICY, status: 'invalid', error: 'request-mode-conflict',
    executionPermission: 'none', semanticJudgment: 'unverified',
    observation: { kind: 'not-returned', originalTaskObserved: false },
    nextAction: 'use-ticketId-alone-or-put-ticketId-inside-requestJson' };
  if (ticketId !== undefined) return reviewProject(JSON.stringify({ version: 1, policyVersion: REVIEW_POLICY,
    action: 'route', ticketId, context: { intent: 'analysis' } }), config, signal);
  return requestJson === undefined ? describeProjectReview() : reviewProject(requestJson, config, signal);
}
function limits(config) {
  keys(config ?? {}, Object.keys(REVIEW_LIMITS), 'invalid-limits');
  return Object.fromEntries(Object.entries(REVIEW_LIMITS).map(([key, ceiling]) => {
    const value = config?.[key] ?? ceiling;
    if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) fail('invalid-limits');
    return [key, value];
  }));
}
function context(value) {
  keys(value, ['intent', 'scope', 'goalClear', 'reversible', 'testsCovered', 'needsAlignment',
    'needsChoice', 'failure', 'executionState', 'focus'], 'context-schema');
  if (!['status-only', 'change', 'analysis'].includes(value.intent)) fail('intent-invalid');
  const c = { intent: value.intent, scope: value.scope ?? 'unknown', failure: value.failure ?? 'unknown',
    executionState: value.executionState ?? 'unknown', focus: value.focus ?? [] };
  if (!['local', 'interface', 'architecture', 'data', 'permissions', 'multi-module', 'unknown'].includes(c.scope)
    || !['none', 'first', 'repeated', 'counterevidence', 'unknown'].includes(c.failure)
    || !['idle', 'running', 'outcome-unknown', 'cancelled', 'reconciliation', 'unknown'].includes(c.executionState)) fail('context-value');
  if (!Array.isArray(c.focus) || c.focus.length > FOCUS.length || new Set(c.focus).size !== c.focus.length
    || c.focus.some(item => !FOCUS.includes(item))) fail('focus-invalid');
  for (const key of ['goalClear', 'reversible', 'testsCovered', 'needsAlignment', 'needsChoice']) {
    c[key] = value[key] ?? null;
    if (c[key] !== null && typeof c[key] !== 'boolean') fail('context-boolean');
  }
  return c;
}

/** Pure deterministic mapping of DECLARED signals. P2 will supply bound observations. */
export function routeProject(value) {
  const c = context(value), sections = new Set(), reasons = [], missing = [];
  const base = { policyVersion: REVIEW_POLICY, contextSha256: projectContextHash(value), binding: 'declared', authority: 'not-integrated',
    executionPermission: 'none', semanticJudgment: 'unverified' };
  if (c.intent === 'status-only') return { ...base, route: 'L0', status: 'not-applicable', held: false,
    reasons: ['status-only'], requiredSections: [], missing: [], nextAction: 'report-status-and-finish' };
  if (c.executionState !== 'idle') return { ...base, route: 'L1', status: 'needs-evidence', held: true,
    reasons: ['execution-' + c.executionState], requiredSections: [], missing: ['execution-state-settlement'], nextAction: 'inspect-original-state-no-replay' };
  let level = 0;
  const add = (n, reason, ...items) => { level = Math.max(level, n); reasons.push(reason); items.forEach(s => sections.add(s)); };
  for (const name of ['scope', 'failure', 'goalClear', 'reversible', 'testsCovered', 'needsAlignment', 'needsChoice']) {
    if (c[name] === null || c[name] === 'unknown') { missing.push('context.' + name); add(1, 'unknown-' + name, 'framing', 'hypotheses'); }
  }
  if (['architecture', 'data', 'permissions', 'multi-module'].includes(c.scope) || c.reversible === false)
    add(2, 'high-impact-change', 'framing', 'options', 'impacts', 'hypotheses', 'history', 'cognition');
  if (c.scope === 'interface' || c.testsCovered === false || c.failure === 'first')
    add(1, 'targeted-check', 'framing', 'hypotheses');
  if (c.goalClear === false || c.needsAlignment === true) add(1, 'alignment-needed', 'framing', 'alignment');
  if (c.needsChoice === true) add(1, 'design-choice', 'options');
  const reassessment = ['repeated', 'counterevidence'].includes(c.failure) || c.focus.includes('retrospective');
  if (reassessment)
    add(2, 'failure-reassessment', 'framing', 'hypotheses', 'learning');
  if (reassessment && c.scope === 'interface') add(2, 'interface-reassessment', 'impacts', 'cognition');
  if (c.focus.some(f => ['history', 'cleanup', 'handoff'].includes(f)))
    add(1, 'history-or-handoff', 'history', 'cognition', 'impacts', 'hypotheses');
  if (c.focus.some(f => f.endsWith('-performance'))) add(1, 'measurement', 'metrics', 'framing', 'hypotheses');
  if (c.focus.some(f => ['cross-domain', 'new-technology'].includes(f))) add(1, 'analogy-research', 'analogy', 'hypotheses');
  if (c.focus.includes('learning')) add(1, 'learning', 'learning');
  // Full review asks whether each method applies, not that every method must run.
  // Independent triggers are captured first; those requirements cannot be skipped.
  const triggered = new Set(sections);
  if (c.focus.includes('full-review')) add(2, 'full-review', ...Object.keys(FIELDS));
  if (level === 2) { sections.add('framing'); sections.add('hypotheses'); }
  const requiredSections = Object.keys(FIELDS).filter(s => sections.has(s));
  const alignmentRequired = c.needsAlignment !== false || c.goalClear !== true;
  const skippableSections = requiredSections.filter(s => s === 'analogy'
    || (s === 'alignment' && !alignmentRequired)
    || (c.focus.includes('full-review') && !triggered.has(s) && ['options', 'impacts', 'cognition', 'metrics'].includes(s)));
  return { ...base, route: 'L' + level, held: false, reasons, requiredSections, skippableSections, alignmentRequired, missing,
    status: reasons.includes('alignment-needed') ? 'needs-alignment' : level ? 'needs-evidence' : 'not-applicable',
    nextAction: reasons.includes('alignment-needed') ? 'collect-unanswered-business-preferences' : level ? 'collect-targeted-evidence' : 'use-existing-implementation-and-tests' };
}

function schemaFor(section, skippable = false) {
  return { methods: METHODS[section], fields: FIELDS[section],
    arrayFields: section === 'alignment' ? ['confirmed', 'openQuestions', 'defaults']
      : section === 'options' ? ['alternatives'] : section === 'history' ? ['gaps'] : [],
    sourceIds: 'references to current sources; required for applicable sections',
    applicability: skippable ? 'applicable or not-applicable with reason' : 'applicable' };
}
function checkSection(section, row, references, result) {
  keys(row, ['applicability', 'reason', 'sourceIds', ...FIELDS[section]], 'section-schema');
  const refs = row.sourceIds ?? [];
  if (!Array.isArray(refs) || refs.length > 32 || new Set(refs).size !== refs.length
    || refs.some(ref => !id(ref) || !references.has(ref))) fail('section-source-reference');
  if (row.applicability === 'not-applicable') {
    if (!result.skippableSections?.includes(section) || !text(row.reason)) result.missing.push(section + '.cannot-skip');
    return;
  }
  if (row.applicability !== 'applicable') fail('section-applicability');
  if (!refs.length) result.missing.push(section + '.sourceIds');
  const arrays = schemaFor(section).arrayFields;
  for (const field of FIELDS[section]) {
    if (arrays.includes(field)) {
      if (!Array.isArray(row[field]) || row[field].length > 32 || row[field].some(v => !text(v))) result.missing.push(section + '.' + field);
    } else if (section === 'options' && field === 'exception') {
      if (row.exception !== undefined && typeof row.exception !== 'string') fail('option-exception');
    } else if (!text(row[field])) result.missing.push(section + '.' + field);
  }
  if (section === 'alignment') {
    const confirmed = Array.isArray(row.confirmed) ? row.confirmed.filter(text).map(s => s.trim()) : [];
    const open = Array.isArray(row.openQuestions) ? row.openQuestions.filter(text).map(s => s.trim()) : [];
    if (open.some(question => confirmed.includes(question))) result.conflicts.push('alignment.answered-question-repeated');
    if (new Set(open).size !== open.length) result.conflicts.push('alignment.duplicate-open-question');
    if (row.openQuestions?.length) result.alignmentOpen = true;
    if (row.confirmed?.length && !refs.some(ref => references.get(ref).kind === 'user-answer')) result.missing.push('alignment.user-answer-source');
    if (!row.openQuestions?.length && row.confirmed?.length && refs.some(ref => references.get(ref).kind === 'user-answer')) result.alignmentResolved = true;
    if (!row.openQuestions?.length && !row.confirmed?.length) {
      if (result.alignmentRequired) { result.missing.push('alignment.unanswered-or-confirmed'); result.alignmentOpen = true; }
      else if (!text(row.reason)) result.missing.push('alignment.no-questions-reason');
    }
  }
  if (section === 'options' && Array.isArray(row.alternatives)) {
    if (new Set(row.alternatives.map(s => s.trim())).size !== row.alternatives.length) result.conflicts.push('options.duplicate');
    if (row.alternatives.length < 3 && !text(row.exception)) result.missing.push('options.three-or-reason');
    if (row.alternatives.length < 2) result.missing.push('options.two-distinct-minimum');
    if (!row.alternatives.includes(row.selected)) result.conflicts.push('options.selected-not-listed');
  }
  if (section === 'history') {
    if (!['complete', 'partial', 'unavailable', 'new-project'].includes(row.coverage)) result.conflicts.push('history.coverage-value');
    if (Array.isArray(row.gaps) && row.gaps.length) { result.coverageGaps.push('history.partial'); result.missing.push('history.coverage'); }
    if (['partial', 'unavailable'].includes(row.coverage)) { result.coverageGaps.push('history.' + row.coverage); result.missing.push('history.coverage'); }
    if (['complete', 'new-project'].includes(row.coverage) && row.gaps?.length) result.conflicts.push('history.coverage-conflict');
    if (!refs.some(ref => references.get(ref).kind === 'history')) result.missing.push('history.source-kind');
  }
  if (section === 'metrics') {
    if (!['delivery', 'runtime', 'both'].includes(row.kind)) result.conflicts.push('metrics.kind');
    if (!['measured', 'planned', 'unavailable'].includes(row.measurementStatus)) result.conflicts.push('metrics.measurement-status');
    else if (row.measurementStatus !== 'measured') { result.missing.push('metrics.measurement'); result.coverageGaps.push('metrics.' + row.measurementStatus); }
    if (!refs.some(ref => references.get(ref).kind === 'metric')) result.missing.push('metrics.source-kind');
  }
  if (section === 'learning' && !['candidate', 'preference', 'none'].includes(row.kind)) result.conflicts.push('learning.kind');
}

/** No writes, credentials, network, model call or execution grant. */
export async function reviewProject(requestJson, config = {}, signal) {
  signal?.throwIfAborted();
  let taskRequested = false;
  try {
    const budget = limits(config.limits), nowMs = Date.now();
    if (typeof requestJson !== 'string' || requestJson.length > budget.requestBytes || !requestJson.isWellFormed()
      || Buffer.byteLength(requestJson, 'utf8') > budget.requestBytes) fail('request-byte-limit');
    let request;
    try { request = parseDiagnosisJson(requestJson, budget.depth); }
    catch { fail('request-invalid-json'); }
    keys(request, ['version', 'policyVersion', 'action', 'context', 'workspace', 'contractSourceId', 'taskId', 'binding', 'sections', 'sources', 'ticketId'], 'request-schema');
    if (request.version !== 1 || request.policyVersion !== REVIEW_POLICY) fail('request-version');
    if (!['route', 'review'].includes(request.action)) fail('action-invalid');
    const declared = context(request.context);
    taskRequested = request.ticketId !== undefined && declared.intent !== 'status-only';
    const observed = taskRequested ? await observeProjectTask(request.ticketId, config, signal) : null;
    const effective = { ...declared };
    if (observed) {
      const machine = observed.snapshot;
      // Observations can add holds/failure intensity, never erase declared concerns.
      if (machine.executionState !== 'idle' || effective.executionState === 'unknown') effective.executionState = machine.executionState;
      if (declared.executionState === 'cancelled') effective.executionState = 'cancelled';
      const rank = { unknown: 0, none: 0, first: 1, repeated: 2, counterevidence: 3 };
      if (rank[machine.failure] > rank[effective.failure]) effective.failure = machine.failure;
      else if (['none', 'unknown'].includes(effective.failure)) effective.failure = machine.failure;
      if (machine.facts.verification.currentBinding && ['failed', 'not-configured'].includes(machine.facts.verification.status)) effective.testsCovered = false;
    }
    const routed = routeProject(effective);
    routed.contextSha256 = projectContextHash(declared);
    if (observed) Object.assign(routed, { binding: 'authoritative', authority: 'original-ledger-records',
      effectiveContextSha256: projectContextHash(effective), task: observed.snapshot,
      reviewBinding: { policyVersion: REVIEW_POLICY, taskId: request.ticketId, workspace: observed.snapshot.workspace,
        contextSha256: routed.contextSha256, contractSha256: observed.snapshot.contractSha256, snapshotSha256: observed.snapshot.snapshotSha256 } });
    const result = { ...routed, declaredContext: declared, operationContracts: projectOperationContracts(), conflicts: [], staleSources: [], coverageGaps: [], checkedSources: [],
      observation: { kind: observed ? 'original-ledger-observed' : declared.intent === 'status-only' ? 'not-applicable' : 'declared-context-only',
        originalTaskObserved: !!observed, semanticJudgment: 'unverified' },
      readBytes: 0, sourceDependencies: {}, schema: Object.fromEntries(routed.requiredSections.map(s => [s, schemaFor(s, routed.skippableSections?.includes(s))])) };
    if (observed) result.coverageGaps.push(...observed.snapshot.coverageGaps);
    // Status-only and unsettled requests never touch supplied paths or decision records.
    if (request.action === 'route' || routed.held || routed.status === 'not-applicable') {
      await observed?.recheck();
      return result;
    }
    const sources = request.sources ?? [];
    if (!Array.isArray(sources) || sources.length > budget.sources) fail('sources-limit');
    const references = new Map();
    for (const source of sources) {
      keys(source, ['id', 'path', 'sha256', 'kind', 'observedAt', 'validUntil', 'startLine', 'endLine'], 'source-schema');
      if (!id(source.id) || references.has(source.id) || !hash(source.sha256)
        || !['contract', 'evidence', 'user-answer', 'history', 'metric'].includes(source.kind)) fail('source-identity');
      sourcePath(source.path);
      if (!timestamp(source.observedAt) || Date.parse(source.observedAt) > nowMs
        || (source.validUntil !== undefined && (!timestamp(source.validUntil) || Date.parse(source.validUntil) < Date.parse(source.observedAt)))) fail('source-time');
      if (!Number.isSafeInteger(source.startLine) || !Number.isSafeInteger(source.endLine)
        || source.startLine < 1 || source.endLine < source.startLine) fail('source-lines');
      references.set(source.id, source);
    }
    if (typeof request.taskId !== 'string' || !/^[a-zA-Z0-9_.-]{1,120}$/.test(request.taskId)) result.missing.push('declared-task-id');
    if (!observed && (!id(request.contractSourceId) || references.get(request.contractSourceId)?.kind !== 'contract')) result.missing.push('declared-contract-source');
    if (!request.binding) result.missing.push('declared-review-binding');
    else {
      keys(request.binding, ['policyVersion', 'taskId', 'workspace', 'contractSha256', 'contextSha256', ...(observed ? ['snapshotSha256'] : [])], 'binding-schema');
      const expected = observed ? routed.reviewBinding : { policyVersion: REVIEW_POLICY, taskId: request.taskId, workspace: request.workspace,
        contractSha256: references.get(request.contractSourceId)?.sha256, contextSha256: routed.contextSha256 };
      for (const field of Object.keys(expected)) {
        if (typeof expected[field] !== 'string' || request.binding[field] !== expected[field]) result.conflicts.push('binding.' + field);
      }
      if (observed && (request.taskId !== request.ticketId || request.workspace !== expected.workspace)) result.conflicts.push('binding.request-task-workspace');
    }
    keys(request.sections ?? {}, Object.keys(FIELDS), 'sections-schema');
    for (const section of result.requiredSections) {
      const row = request.sections?.[section];
      if (!row) { result.missing.push(section); continue; }
      checkSection(section, row, references, result);
      result.sourceDependencies[section] = row.sourceIds ?? [];
    }
    // Optional supplied sections must satisfy their schemas too; no hidden bypass fields.
    for (const [section, row] of Object.entries(request.sections ?? {})) {
      if (!result.requiredSections.includes(section)) {
        checkSection(section, row, references, result);
        result.sourceDependencies[section] = row.sourceIds ?? [];
      }
    }
    const metrics = request.sections?.metrics;
    if (metrics) {
      const focus = request.context.focus ?? [];
      for (const kind of ['delivery', 'runtime']) {
        if (focus.includes(kind + '-performance') && ![kind, 'both'].includes(metrics.kind)) result.conflicts.push('metrics.requested-' + kind);
      }
    }
    if (!sources.length) result.missing.push('sources');
    else {
      // The task adapter already resolved the server allowlist identity (including
      // Windows TEMP 8.3 aliases). Restrict attachments to that exact workspace.
      const checked = await checkSources(sources, request.workspace, { allowedRoots: observed ? [observed.snapshot.workspace] : config.allowedRoots,
        limits: budget, nowMs, signal });
      result.checkedSources = checked.sources;
      result.readBytes = checked.readBytes;
      result.staleSources = checked.sources.filter(s => s.issues.length).map(s => ({ id: s.id, reasons: s.issues,
        sections: Object.keys(result.sourceDependencies).filter(key => result.sourceDependencies[key].includes(s.id)),
        contract: s.id === request.contractSourceId }));
    }
    await observed?.recheck();
    result.missing = [...new Set(result.missing)];
    result.coverageGaps = [...new Set(result.coverageGaps)];
    const needsAlignment = result.alignmentOpen || (routed.status === 'needs-alignment' && !result.alignmentResolved);
    delete result.alignmentOpen;
    delete result.alignmentResolved;
    result.status = result.conflicts.length ? 'invalid' : result.staleSources.length ? 'stale'
      : needsAlignment ? 'needs-alignment' : result.missing.length ? 'needs-evidence' : 'structurally-ready';
    result.nextAction = result.status === 'structurally-ready' ? 'semantic-review-then-existing-verification'
      : result.status === 'needs-alignment' ? 'collect-unanswered-business-preferences' : 'resolve-listed-gaps-no-replay';
    return result;
  } catch (error) {
    if (signal?.aborted) throw error;
    return { policyVersion: REVIEW_POLICY, status: taskRequested ? 'needs-evidence' : 'invalid',
      binding: taskRequested ? 'unresolved' : 'declared', executionPermission: 'none',
      authority: taskRequested ? 'unavailable' : 'not-integrated', semanticJudgment: 'unverified',
      ...(taskRequested ? { held: true } : {}), error: error instanceof ReviewError ? error.code : 'review-failed',
      observation: { kind: 'not-returned', originalTaskObserved: false },
      nextAction: taskRequested ? 'reread-original-state-no-replay' : 'correct-input-or-read-boundary' };
  }
}
