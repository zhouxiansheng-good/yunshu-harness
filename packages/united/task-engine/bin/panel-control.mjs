// The board and the locked engine command read the same ticket and accepted receipts.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { LedgerV2 } from './ledger-v2.mjs'
import { reduce, diffState } from './reducer.mjs'
import { readPanelPlan } from './panel-plan.mjs'
import { completionBasis, readReceived, reviewRefs } from './verdict-evidence.mjs'
import { dispatchRestriction, readPart } from './dispatch-policy.mjs'

const paths = {
  start: ['explorer', '可以派出第一步探索。', '围绕原始目标先完成一次只读探索：核对现状、候选方案、关键约束和可验证验收路径，输出带证据的下一步建议。'],
  implement: ['builder', '探索已交回，可以派给执行。', '根据最近的探索结果和原始目标，完成下一步可验证实现；只处理任务单范围内的产物，并留下文件与测试证据。'],
  review: ['guardian', '执行已交回，可以派给复核。', '独立验收最近的执行交付。以只读方式逐项核对原始验收标准、产物和测试证据，记录每项结论及其依据。'],
  repair: ['builder', '复核提出了问题，可以派给执行修订。', '根据最近 Guardian 的问题证据修复任务产物，逐项回应指出的验收缺口，并提交新的可复核测试证据。'],
  inspect: ['guardian', '任务长时间没有进展，可以派给复核检查。', '对当前任务进行一次独立状态核对：检查最近任务单、已有产物和账本，确认是否仍可继续推进，并给出可复核证据。'],
}

export function closedTaskReason(status) {
  switch (status) {
    case 'done': return '任务已完成。'
    case 'blocked': return '任务受阻，等待处理阻塞原因。'
    case 'disputed': return '复核提出了异议，等待人工裁决。'
    case 'closed': case 'cancelled': case 'canceled': case 'archived': return '任务已关闭。'
    case 'failed': return '任务执行失败，等待人工处理。'
    default: return null
  }
}

const read = file => { try { return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) } catch { return null } }
const hold = (code, reason, canEdit = false) => ({code, reason, canEdit, canContinue:false, nextRole:null})
const missing = () => hold('missing-evidence', '原任务的记录不完整，请先核对派单和回执。')

export function readSentTask(dir, state, mid, part, expectedObjective) {
  if (!/^m-[\w-]+$/.test(mid) || !/^[\w-]+$/.test(part)) return null
  const name = part + '-' + mid + '.json'
  const file = ['in','claimed'].map(sub => join(dir, sub, name)).find(existsSync)
  const sent = file && read(file)
  return sent?.id === mid && sent.run_id === state?.run_id && sent.goal_id === state.goal_id &&
    sent.goal_rev === state.goal_rev && sent.kind === 'task' && sent.to === part && sent.task?.objective &&
    (expectedObjective == null || sent.task.objective === expectedObjective) ? sent : null
}

export function readPanelLedger(engineDir) {
  const file = join(engineDir, 'ledger-v2.ndjson')
  if (!existsSync(file)) return { framesOf:() => [] }
  try { return new LedgerV2(file) } catch { return null }
}

export function readPanelTicket(dir, runId, frames, {
  state = read(join(dir, 'state.json')), goal = read(join(dir, 'goal.json')), stepText = '',
} = {}) {
  const disposition = read(join(dir, 'disposition.json'))
  const receipts = new Map((frames || []).filter(f => f.op === 'recv').map(f => [f.payload.parent_id, f]))
  const objectives = new Map((frames || []).filter(f => f.op === 'dispatch').map(f => [f.payload.message_id, f.payload.objective]))
  const accepted = new Map()
  function receiptFor(mid) {
    if (!accepted.has(mid)) {
      const frame = receipts.get(mid)
      let receipt = null
      if (frame) { try { receipt = readReceived(dir, state, frame) } catch { /* Missing or mismatched original. */ } }
      accepted.set(mid, receipt)
    }
    return accepted.get(mid)
  }
  let plan, response = null, objective = null
  try { plan = readPanelPlan(dir, frames) } catch { /* An incomplete revision cannot supply dispatch instructions. */ }
  function ready(code) {
    const [nextRole, reason, standard] = paths[code]
    const instruction = stepText ? '按用户修改后的步骤执行：' + stepText : standard
    const bound = response ? instruction + '\n本次依据：' + response.id : instruction
    let part
    try { part = readPart(dirname(dirname(dir)), nextRole) } catch { return missing() }
    if (part?.part_id !== nextRole || !Array.isArray(part.forbidden_actions ?? [])) return hold('missing-role', '下一步所需的角色配置缺失，请先检查配置。')
    const restricted = dispatchRestriction(state, part, bound)
    if (restricted) return hold(restricted.code, restricted.reason, true)
    objective = bound
    return {code, reason, canEdit:true, canContinue:true, nextRole}
  }
  function decide() {
    const closed = closedTaskReason(state?.status)
    if (closed) return hold('closed', closed)
    const initial = frames?.find(f => f.op === 'new')?.payload
    if (!state || !goal || !initial || !plan || !Array.isArray(disposition?.fanout) || !Array.isArray(disposition.filtered)) return missing()
    const replay = reduce(frames).state
    const committedClosed = closedTaskReason(replay.status)
    if (committedClosed) return hold('closed', committedClosed)
    if (state.run_id !== runId || goal.goal_id !== state.goal_id || goal.revision !== state.goal_rev ||
        typeof goal.goal !== 'string' || !goal.goal.trim() || (initial.goal != null && initial.goal !== goal.goal) ||
        (initial.acceptance != null && !isDeepStrictEqual(initial.acceptance, goal.acceptance)) ||
        !['open','running'].includes(state.status) || diffState(replay, state).length) return missing()
    const pending = Object.entries(state.pending || {})
    if (pending.some(([,p]) => p.status === 'outcome_unknown')) return hold('outcome_unknown', '派单结果待核实，请先核对这一步的回执。')
    const active = pending.filter(([,p]) => p.status === 'pending')
    if (active.some(([mid,p]) => !readSentTask(dir, state, mid, p.part, objectives.get(mid)))) return missing()
    if (active.length) return hold('pending', '已派单，等待交回。', true)

    const lastId = state.last_message_id
    const part = state.pending?.[lastId]?.part
    if (lastId) {
      const receipt = frames.findLast(f => f.op === 'recv')
      if (receipt?.payload.parent_id !== lastId || state.pending[lastId]?.status !== 'settled' || !readSentTask(dir, state, lastId, part, objectives.get(lastId))) return missing()
      response = receiptFor(lastId)
      if (!response) return missing()
      if (part === 'guardian' && ['finding','ack'].includes(response.kind)) {
        try { completionBasis(frames, dir, state, response.id) } catch { return hold('missing-evidence', '复核已交回，终裁所需的证据还需核对。', true) }
        return hold('awaiting-verdict', '复核已交回，等待人工终裁。', true)
      }
      if (response.kind === 'decline') return hold('declined', '这一步已退回，请先确认后续安排。', true)
      const repair = part === 'guardian' && response.kind === 'objection'
      if ((!repair && response.kind !== 'finding') || !receipt.payload.evidence_count || typeof response.claim?.statement !== 'string' || !response.claim.statement.trim()) return missing()
      if (part === 'builder' && !reviewRefs(frames, dir, state).length) return missing()
    }
    const limit = state.budget?.turns_max, used = state.watermark?.turn
    if (!Number.isInteger(limit) || !Number.isInteger(used) || used < 0 || limit < 0) return missing()
    if (state._watch?.verdict === 'STALE') return ready('inspect')
    if (!lastId) return ready('start')
    if (part === 'explorer') return ready('implement')
    if (part === 'builder') return ready('review')
    if (part === 'guardian') return ready('repair')
    return missing()
  }
  const continuation = decide()
  return {continuation, objective, response, goal, plan, state, receiptFor}
}

export function panelDispatchSummary(ticket) {
  const steps = [...ticket.plan.steps].map(([id, value]) => id + '：' + value)
  const lines = ['当前目标：' + (ticket.plan.goal || ticket.goal.goal), ...steps]
  const finding = ticket.response?.claim?.statement || ticket.response?.statement
  if (finding) lines.push('最近回执（' + ticket.response.id + '）：' + finding)
  return lines.join('\n')
}
