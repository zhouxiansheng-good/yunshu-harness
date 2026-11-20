/** Read-only projection of original ticket observations, never execution authority. */
import { openSync, closeSync, readSync, fstatSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const MAX_BYTES = 256 * 1024;
const MAX_ROWS = 8;
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(value);
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const cost = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
// Error text may contain paths, output or secrets. Only expose identifier-like codes.
const code = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,120}$/.test(value) ? value : null;
// A syntactically identifier-like string can still be a secret. Expose only
// fixed implementation reason codes, never arbitrary exception/model content.
const reasonCodes = new Set([
  'fresh-candidate-received', 'fresh-provider-outcome-unknown', 'fresh-network-outcome-unknown',
  'fresh-timeout-outcome-unknown', 'fresh-provider-http-error', 'fresh-provider-json-invalid',
  'fresh-output-invalid', 'fresh-candidate-invalid', 'fresh-binding-mismatch', 'fresh-insufficient-evidence',
  'fresh-credential-reflection-rejected', 'fresh-response-incomplete', 'fresh-response-byte-budget',
  'fresh-apply-failed', 'fresh-apply-version-conflict', 'fresh-ticket-version-changed',
  'fresh-source-workspace-changed', 'fresh-target-changed', 'fresh-scope-changed',
  'fresh-replacement-base-changed', 'fresh-empty-candidate', 'fresh-schema-invalid',
  'diagnosis-proposal-only', 'diagnosis-network-outcome-unknown', 'diagnosis-timeout-outcome-unknown',
  'diagnosis-cancelled-outcome-unknown', 'diagnosis-cancelled-before-request',
  'diagnosis-provider-http-error', 'diagnosis-provider-json-invalid', 'diagnosis-response-incomplete',
  'diagnosis-credential-reflection-rejected', 'diagnosis-scope-reconciliation-required',
  'cancellation-requested', 'runner-failed', 'runner-timeout',
]);
const reasonCode = value => reasonCodes.has(value) ? value : null;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const file = value => {
  if (typeof value !== 'string' || value.length > 512 || !value.length || /[\x00-\x1f:]/.test(value)) return null;
  // The coordinator accepts native Windows separators. Normalize both sides of
  // the allow-list comparison, not just the applied list, without resolving paths.
  const normalized = value.replaceAll('\\', '/');
  return normalized.split('/').every(part => part && part !== '.' && part !== '..') ? normalized : null;
};

function unavailable(reason) {
  return { state: 'unavailable', label: '编码记录不可用', tone: 'warn', reason,
    basis: '未取得匹配当前派单的完整记录。', next: '核对编码目录和原票据；不自动重发。',
    coverage: 'ticket-observations-only', automaticAction: 'none', rows: [] };
}

/** O(ticket bytes), bounded by the original ticket cap; no log/workspace reads. */
export function projectCodingActivity(record, binding) {
  if (!object(record) || !object(binding) || !Array.isArray(record.runs)) return unavailable('ticket-shape-invalid');
  const ticketId = binding.runId + '_' + binding.messageId;
  if (!id(ticketId) || record.ticketId !== ticketId || !object(record.united)
    || !binding.goalId || binding.goalRev == null || !binding.phase || binding.part !== 'builder'
    || ['runId', 'messageId', 'goalId', 'goalRev', 'part', 'phase'].some(key => record.united[key] !== binding[key]))
    return unavailable('ticket-united-binding-mismatch');
  const seen = new Set();
  let last = null, diagnostic = null;
  const history = [];
  const allowed = new Set(Array.isArray(record.files) ? record.files.map(file).filter(Boolean) : []);
  for (const [index, attempt] of record.runs.entries()) {
    if (!object(attempt) || !id(attempt.attemptId) || seen.has(attempt.attemptId)) return unavailable('attempt-id-invalid');
    seen.add(attempt.attemptId);
    const kind = Object.hasOwn(attempt, 'kind') ? attempt.kind : 'implement';
    if (!['implement', 'diagnose'].includes(kind)) return unavailable('attempt-kind-invalid');
    if (kind === 'implement') last = attempt;
    else diagnostic = attempt;
    if (kind !== 'diagnose' && !attempt.fresh) continue;
    const fresh = kind === 'implement' && object(attempt.fresh) ? attempt.fresh : null;
    const running = attempt.status === 'running';
    const known = attempt.outcomeKnown === true && (!fresh || fresh.providerOutcomeKnown === true);
    const applied = Array.isArray(fresh?.appliedFiles)
      ? [...new Set(fresh.appliedFiles.map(file).filter(f => f && allowed.has(f)))] : [];
    const omittedApplied = Array.isArray(fresh?.appliedFiles) ? fresh.appliedFiles.filter(f => !file(f) || !allowed.has(file(f))).length : 0;
    const row = { id: attempt.attemptId, kind, source: `ticket.runs[${index}]`, status: code(attempt.status),
      label: kind === 'diagnose' ? '诊断' : '新上下文候选',
      result: running ? '执行已登记，结果待确认'
        : attempt.cancellationRequested || attempt.status === 'aborted' ? '已取消'
        : !known ? '远程结果未知'
        : attempt.status === 'proposal' ? (attempt.scopeUnchanged === true && object(attempt.proposal)
          ? '建议已记录，未执行实验' : '诊断未收口，不能使用建议')
        : fresh?.applyStatus === 'failed-or-partial' ? (applied.length ? '部分应用，执行失败' : omittedApplied ? '应用记录待核对' : '应用失败')
        : fresh?.candidateAccepted === false ? '候选未接纳'
        : ['failed', 'timeout'].includes(attempt.status) ? (applied.length ? '文件已应用，执行未成功' : '执行未成功')
        : fresh?.applyStatus === 'applied' ? '文件已应用，不代表验收通过' : '记录已结束',
      outcomeKnown: known, reason: reasonCode(attempt.reason) ?? reasonCode(fresh?.reason),
      requestCount: count(fresh ? fresh.requestCount : attempt.requestCount),
      totalTokens: count(attempt.usage?.totalTokens), costUsd: cost(attempt.costUsd),
      startedAt: time(attempt.startedAt), endedAt: time(attempt.endedAt),
      appliedFiles: applied.slice(0, 16), hiddenAppliedFiles: Math.max(0, applied.length - 16),
      omittedAppliedFiles: omittedApplied, applyStatus: code(fresh?.applyStatus), cancellationRequested: attempt.cancellationRequested === true };
    history.push(row);
  }
  if (Object.hasOwn(record, 'lastImplementationAttemptId') && record.lastImplementationAttemptId !== (last?.attemptId ?? null))
    return unavailable('implementation-reference-mismatch');
  const prepared = record.freshContext;
  const currentDiagnostic = diagnostic && typeof diagnostic.sourceCheckId === 'string' && diagnostic.sourceCheckId.length > 0
    && diagnostic.sourceImplementationAttemptId === last?.attemptId
    && diagnostic.sourceCheckId === record.verification?.checkId
    && record.verification?.attemptId === last?.attemptId;
  const validPrepared = object(prepared) && prepared.status === 'prepared' && id(prepared.attemptId)
    && !seen.has(prepared.attemptId) && prepared.diagnosisAttemptId === diagnostic?.attemptId && currentDiagnostic
    && diagnostic.status === 'proposal' && diagnostic.outcomeKnown === true && !diagnostic.cancellationRequested
    && diagnostic.scopeUnchanged === true && object(diagnostic.proposal)
    && record.verification?.status === 'failed';
  if (validPrepared) history.push({ id: prepared.attemptId, kind: 'prepared', source: 'ticket.freshContext',
    label: '新上下文准备', result: '材料已冻结，尚未执行', startedAt: null, endedAt: null });
  const view = { state: 'none', label: '暂无本次纠偏结果', tone: 'neutral',
    basis: '仅投影原票据，不读取模型正文或推断语义进展。', next: '按原任务继续；历史记录不替代当前结果。',
    coverage: 'ticket-observations-only', automaticAction: 'none', ticketId,
    attemptId: last?.attemptId ?? null, updatedAt: time(record.updatedAt),
    rows: history.slice(-MAX_ROWS), hiddenRows: Math.max(0, history.length - MAX_ROWS) };
  const select = (state, label, tone, basis, next) => Object.assign(view, { state, label, tone, basis, next });
  const row = history.findLast(item => item.id === last?.attemptId);
  const fresh = object(last?.fresh) ? last.fresh : null;
  // All gates are displays of recorded facts, not independent receipt validation.
  const writerHeld = record.writerAuthority && record.writerAuthority.status !== 'stopped' && record.status !== 'running';
  const check = record.verification;
  const checkCurrent = check && check.attemptId === last?.attemptId;
  const hold = record.reconciliation?.required || writerHeld
    || (checkCurrent && ['running', 'outcome-unknown'].includes(check.status));
  if (hold) return select('hold', '待对账，未授成功', 'warn',
    '票据仍有未收口写权、检查或对账标记；本地停止不等于远程完成。', '核对绑定原生回执；不自动重发。');
  if (validPrepared) return select('prepared', '材料已准备，尚未执行', 'neutral',
    '准备绑定当前实现及失败检查；准备本身没有新模型调用。', '显式决定是否执行这一候选；不自动派单。');
  if (currentDiagnostic && (diagnostic.cancellationRequested || diagnostic.status === 'aborted'
    || diagnostic.outcomeKnown !== true || diagnostic.status === 'running' || diagnostic.scopeUnchanged !== true
    || (diagnostic.status === 'proposal' && !object(diagnostic.proposal)))) return select('diagnosis-unresolved',
    '诊断未收口，不能使用建议', 'warn',
    '当前诊断取消、范围已变或建议/结果未确认，不把旧建议当作当前结果。', '核对原诊断记录与范围；不自动重发或执行。');
  if (currentDiagnostic) return select('diagnosed', diagnostic.status === 'proposal' ? '诊断建议已记录，未执行实验' : '诊断未形成可用建议',
    diagnostic.status === 'proposal' ? 'neutral' : 'warn', '诊断不是实现成果，建议及正反预测仍待验证。', '核对建议和原失败证据，再决定是否准备新上下文。');
  if (fresh && (last.cancellationRequested || last.status === 'aborted')) return select('cancelled', '已取消，保留实际应用记录', 'warn',
    '当前实现记录为取消；已应用文件和未知用量仍保留。', '核对应用结果与远程状态；不自动续跑。');
  if (fresh && last.status === 'running') return select('registered', '执行已登记，结果待确认', 'neutral',
    '原票据已保存本次尝试；没有调用级证据，不推断远程正在运行。', '等待原执行链收口；不重复派单。');
  if (fresh && (fresh.providerOutcomeKnown !== true || last.outcomeKnown !== true)) return select('unknown', '远程结果未知', 'warn',
    '当前 fresh 没有已知远程终态；本地进程结束不能补成失败或零用量。', '核对绑定原生回执；不自动重发。');
  if (fresh?.candidateAccepted === false) return select('rejected', '候选未接纳', 'warn',
    '候选没有通过原输入/范围/输出检查，不代表可以自动重发。', '查看原拒绝原因，先修正输入或候选。');
  if (fresh && ['failed', 'timeout', 'scope-violation', 'source-drift'].includes(record.status)) return select(
    row?.applyStatus === 'failed-or-partial' && row.appliedFiles.length ? 'partial'
      : row?.applyStatus === 'failed-or-partial' && row.omittedAppliedFiles ? 'application-unresolved' : 'failed',
    row?.result ?? '执行未成功', 'warn', '外层执行未成功；即使文件已应用，也没有验收信用。', '检查原失败与实际应用文件，再决定下一步。');
  // Native preflight failures may omit attemptId/checkId. Never invent a
  // current binding, but also never erase the failure by saying "not checked".
  if (fresh && object(check) && !id(check.attemptId)) return select('check-unbound',
    '检查记录未绑定当前实现，待核对', 'warn',
    '原票据已有检查记录，但未保存有效实现关联；不能当作尚未检查或授予通过。',
    '核对原检查失败与文件状态，补齐来源后再按原流程验收。');
  const verified = checkCurrent && check.status === 'target-files-and-test-passed'
    && record.activeArtifactAttemptId === last?.attemptId && record.scopeAudit === 'passed'
    && last?.status === 'completed' && last.outcomeKnown === true && !last.cancellationRequested;
  if (fresh && verified && ['needs-verification', 'verified', 'promoted'].includes(record.status)) return select('verified',
    record.status === 'promoted' ? '独立验收已通过，已提升' : '独立验收已通过', 'ok',
    '原票据当前实现与独立检查绑定一致；这里只读记录，不重新验收。', '按原联合体交回与裁决流程继续；不自动提交。');
  if (fresh && checkCurrent && ['failed', 'timeout', 'aborted', 'not-configured'].includes(check.status))
    return select('check-not-passed', check.status === 'aborted' ? '独立验收已取消' : check.status === 'timeout' ? '独立验收超时'
      : check.status === 'not-configured' ? '未配置独立验收' : '独立验收未通过', 'warn',
      '当前实现已有检查记录，但没有通过信用；文件应用仍单独保留。', '核对当前检查及其收口状态，再决定下一步。');
  if (fresh && ['promotion-failed', 'promotion-partial'].includes(record.status)) return select('promotion-failed',
    record.status === 'promotion-partial' ? '提升未完全回退，待核对' : '提升失败，未交回', 'warn',
    '提升记录未成功，不能按任务完成处理。', '核对原提升清单、回退结果和源文件；不自动重试。');
  if (fresh && fresh.applyStatus === 'applied' && last.status === 'completed' && record.status === 'needs-verification') return select('awaiting-verification',
    '文件已应用，待独立验收', 'neutral', '候选应用不等于任务完成；尚未授当前验收信用。', '运行原独立验收，再决定是否提升和交回。');
  return view;
}

/** Only the exact linked ticket in an explicitly configured directory is read. */
export function readCodingActivity(stateDir, binding) {
  if (stateDir === undefined || stateDir === null) return null;
  if (typeof stateDir !== 'string' || !isAbsolute(stateDir)) return unavailable('coding-state-dir-invalid');
  if (!object(binding)) return unavailable('ticket-id-invalid');
  const ticketId = binding.runId + '_' + binding.messageId;
  if (!id(ticketId)) return unavailable('ticket-id-invalid');
  const tickets = join(stateDir, 'tickets'), path = join(tickets, ticketId + '.json');
  let fd;
  try {
    for (const item of [stateDir, tickets, path]) {
      const stat = lstatSync(item);
      if (stat.isSymbolicLink()) throw new Error('ticket-link-rejected');
    }
    if (realpathSync(path) !== join(realpathSync(tickets), ticketId + '.json')) throw new Error('ticket-link-rejected');
    fd = openSync(path, 'r');
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > MAX_BYTES) throw new Error('ticket-byte-budget-exceeded');
    // Read at most cap+1 even if a noncooperating writer grows the file mid-read.
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let length = 0, n;
    while (length < bytes.length && (n = readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += n;
    if (length > MAX_BYTES) throw new Error('ticket-byte-budget-exceeded');
    const after = fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('ticket-changed-during-read');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
    return projectCodingActivity(JSON.parse(text), binding);
  } catch (error) {
    return unavailable(error.code === 'ENOENT' ? 'ticket-not-found' : code(error.message) ?? 'ticket-read-failed');
  } finally { if (fd !== undefined) closeSync(fd); }
}
