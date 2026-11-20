/**
 * reducer —— 从 V2 权威帧确定性重放 state（M4，按 codex 裁决第 4 节）
 *
 * 原则：
 *   - 只重算能从帧载荷确定的字段；无法确定的列入 unreconstructable，不猜成默认值
 *   - 重放不使用当前时钟，所有时间从帧载荷取
 *   - 输出与 state.json 同结构，便于逐字段比较
 */
import { createHash } from 'node:crypto'

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex')

export const REDUCER_REV = 4

/**
 * @param {object[]} frames 该 run 的 V2 帧（按 seq 升序）
 * @returns {{state:object, unreconstructable:string[], source_seq:number, source_hash:string}}
 */
export function reduce(frames) {
  const unreconstructable = []
  let st = null
  let pending = {}
  let activeParts = []
  let seenIds = []
  let seenObjectives = []
  let watermark = { turn: 0, step: 0, seq: 0 }
  let status = 'open'
  let lastMessageId = null
  let decisionSeq = 0
  let planRev = null
  let veto = null
  let budget = null
  let watch = null
  let goalId = null
  let goalRev = null

  for (const f of frames) {
    const p = f.payload || {}
    switch (f.op) {
      case 'new': {
        goalId = p.goal_id ?? null
        goalRev = p.goal_rev ?? null
        budget = p.budget ? { ...p.budget } : { turns_max: p.turns ?? 4, active_max: 3, parts_max: 5 }
        status = 'open'
        break
      }
      case 'dispatch': {
        lastMessageId = p.message_id || lastMessageId
        if (p.part && !activeParts.includes(p.part)) activeParts.push(p.part)
        if (p.seen_objective) seenObjectives.push(p.seen_objective)
        if (p.message_id) {
          pending[p.message_id] = {
            part: p.part,
            status: 'pending',
            dispatched_at: p.dispatched_at,
            deadline_at: p.deadline_at,
          }
        }
        if (status === 'open') status = 'running'
        watermark = { ...watermark, turn: (watermark.turn || 0) + 1, at: p.dispatched_at }
        break
      }
      case 'recv': {
        const mid = p.message_id
        if (mid) seenIds.push(mid)
        watermark = { ...watermark, step: (watermark.step || 0) + 1, seq: (watermark.seq || 0) + 1, at: p.settled_at }
        if (p.parent_id && pending[p.parent_id]?.status === 'pending')
          pending[p.parent_id] = { ...pending[p.parent_id], status: 'settled', settled_at: p.settled_at }
        activeParts = activeParts.filter(x => Object.values(pending).some(v => v.part === x && v.status === 'pending'))
        if (p.kind === 'objection' && (p.evidence_count || 0) > 0) {
          status = 'disputed'
          veto = { by: p.from, id: mid, at: p.settled_at, scope: p.veto || 'acceptance_violation' }
        }
        if (p.kind === 'blocked' || p.kind === 'incident') status = 'blocked'
        break
      }
      case 'recv_stale': {
        if (p.message_id) seenIds.push(p.message_id)
        break
      }
      case 'unknown_resolution': {
        if (p.message_id && p.pending) pending[p.message_id] = { ...p.pending }
        if (p.pending?.status?.startsWith('resolved_'))
          activeParts = activeParts.filter(x => Object.values(pending).some(v => v.part === x && v.status === 'pending'))
        if (p.dispatch) {
          const d = p.dispatch
          pending[d.message_id] = { part: d.part, status: 'pending', dispatched_at: d.dispatched_at, deadline_at: d.deadline_at }
          if (!activeParts.includes(d.part)) activeParts.push(d.part)
          lastMessageId = d.message_id
          watermark = { ...watermark, turn: (watermark.turn || 0) + 1, at: d.dispatched_at }
        }
        break
      }
      case 'verdict': {
        decisionSeq += 1
        status = p.status || 'done'
        if (p.cleared_veto && p.cleared_veto === veto?.id) veto = null
        watermark = { ...watermark, at: f.at }
        break
      }
      case 'revise': {
        planRev = p.rev ?? planRev
        break
      }
      case 'watch':
      case 'filtered':
      case 'rejected': {
        // 这些操作的影响若包含在 payload 里就重放，否则记入不可重建
        if (p.state_patch && typeof p.state_patch === 'object') {
          const patch = p.state_patch
          if (patch.pending) pending = { ...pending, ...patch.pending }
          if (patch._watch) watch = { ...patch._watch }
          if (patch.status) status = patch.status
        }
        else unreconstructable.push(`${f.op}@seq${f.seq}: 载荷不含 state_patch，其状态影响无法重放`)
        break
      }
      default:
        unreconstructable.push(`${f.op}@seq${f.seq}: 未知操作类型`)
    }
  }

  st = {
    run_id: frames.length ? frames[0].run_id : null,
    goal_id: goalId,
    goal_rev: goalRev,
    status,
    phase: 'run',
    active_parts: activeParts,
    pending,
    decision_seq: decisionSeq,
    seen_ids: seenIds,
    budget: budget || { turns_max: 4, active_max: 3, parts_max: 5 },
    watermark,
    last_message_id: lastMessageId,
    seen_objectives: seenObjectives,
    plan_rev: planRev,
    ...(veto ? { veto } : {}),
    ...(watch ? { _watch: watch } : {}),
    // 派生水位（裁决第 3 节第三节：事实代际 + 快照依据水位）
    source_seq: frames.length ? frames[frames.length - 1].seq : 0,
    source_hash: frames.length ? frames[frames.length - 1].hash : '',
    reducer_rev: REDUCER_REV,
  }
  return { state: st, unreconstructable, source_seq: st.source_seq, source_hash: st.source_hash }
}

/** 只比较能证明的字段；_watch 等运行时观测不参与（由载荷决定是否可证） */
export const COMPARABLE = [
  'run_id', 'goal_id', 'goal_rev', 'status', 'active_parts', 'pending',
  'decision_seq', 'seen_ids', 'budget', 'last_message_id', 'seen_objectives', 'plan_rev',
]

/** 逐字段比较，返回机器可读差异 */
export function diffState(replayed, actual) {
  const diffs = []
  for (const k of COMPARABLE) {
    const a = canonicalJson(replayed[k])
    const b = canonicalJson(actual[k])
    if (a !== b) diffs.push({ field: k, replayed: a.slice(0, 120), actual: b.slice(0, 120) })
  }
  // watermark 只比数值部分（at 是时间戳，属于载荷）
  const w1 = { turn: replayed.watermark?.turn, step: replayed.watermark?.step, seq: replayed.watermark?.seq }
  const w2 = { turn: actual.watermark?.turn, step: actual.watermark?.step, seq: actual.watermark?.seq }
  if (canonicalJson(w1) !== canonicalJson(w2)) diffs.push({ field: 'watermark(turn/step/seq)', replayed: canonicalJson(w1), actual: canonicalJson(w2) })
  return diffs
}

function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null)
  if (Array.isArray(v)) return '[' + v.map(canonicalJson).join(',') + ']'
  const keys = Object.keys(v).sort()
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(v[k])).join(',') + '}'
}
