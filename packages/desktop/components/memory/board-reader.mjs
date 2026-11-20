/**
 * 任务掌控台数据 —— 让 YG 看得见"谁在干什么、干到哪、交了什么"，
 * 不是"最终做成了什么"（那个云舒嘴上会讲）。
 *
 * 每个任务给出：
 *   - 要办的事（一句话）
 *   - 派给了谁、要求是什么、什么时候派的、还剩多久
 *   - 交回了什么（每份结果的内容摘要，不是"已交回 1 份"）
 *   - 谁还卡着、谁在等
 *   - 有没有需要 YG 拍板的
 *
 * 另外给出「手脚」清单：当前装了哪些能干活的工具，谁在用、谁空闲。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const rd = (p, d = null) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return d } }
const md = (p) => { try { return statSync(p).mtimeMs } catch { return 0 } }
const ago = (ms, nowMs = Date.now()) => {
  if (!ms) return ''
  const d = nowMs - ms
  if (d < 60000) return '刚刚'
  const m = Math.floor(d / 60000)
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  return `${Math.floor(h / 24)} 天前`
}
const left = (iso, nowMs = Date.now()) => {
  if (!iso) return ''
  const d = new Date(iso).getTime() - nowMs
  if (d <= 0) { const p = -d; return p < 3600000 ? `超时 ${Math.floor(p / 60000)} 分钟` : `超时 ${Math.floor(p / 3600000)} 小时` }
  return `还剩 ${Math.floor(d / 60000)} 分钟`
}

// 角色人话名
const ROLE = { explorer: '探路', builder: '动手', guardian: '把关', self: '拍板' }
const roleName = (id) => ROLE[id] || id || '未指派'

// Codex 会话由报告器独立跟踪，不计入联合体 run、派单和角色角标。
function readBackgroundTasks(unitedDir, nowMs) {
  const snapshot = rd(join(unitedDir, '_report', 'state.json'))
  const configured = rd(join(unitedDir, 'report-tasks.json'))?.tasks || []
  const titles = new Map(configured.map(task => [task.id, task.title]))
  const states = snapshot?.tasks && typeof snapshot.tasks === 'object' ? Object.values(snapshot.tasks) : []
  return states.filter(task => task && task.id && ['running', 'stalled', 'done', 'failed'].includes(task.state))
    .map(task => {
      const started = Date.parse(task.startedAt)
      const activity = Date.parse(task.lastActivityAt)
      const ended = Date.parse(task.terminal?.at)
      const seconds = Number.isFinite(started)
        ? Math.max(0, Math.floor(((Number.isFinite(ended) ? ended : nowMs) - started) / 1000)) : 0
      return {
        id: task.id, title: task.title || titles.get(task.id) || task.id, state: task.state,
        step: task.step || '未记录步骤', elapsedSeconds: seconds,
        elapsed: seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`,
        startedAtIso: task.startedAt || '', lastActivityAtIso: task.lastActivityAt || '',
        lastAt: Number.isFinite(activity) ? ago(activity, nowMs) : '未知',
      }
    }).sort((a, b) => {
      const active = state => state === 'running' || state === 'stalled' ? 0 : 1
      return active(a.state) - active(b.state) || Date.parse(b.lastActivityAtIso) - Date.parse(a.lastActivityAtIso)
    })
}

// 交回的每一份，先讲内容，不讲话术
function summarizeReply(env) {
  const c = env?.claim?.statement
  if (c) return String(c).slice(0, 90)
  if (env?.stuck?.tried) return '卡住了：' + String(env.stuck.tried).slice(0, 70)
  if (env?.decision?.rule) return '做了决定：' + String(env.decision.rule).slice(0, 70)
  return env?.kind ? `${env.kind}（没写内容摘要）` : '（空回执）'
}

// Ledger 的 recv.message_id 是回执 ID，不是派单 ID；必须通过 out/<id>.json 的 parent_id 关联。
function readTimelineEvents(unitedDir, runIds) {
  const file = join(unitedDir, 'ledger.ndjson')
  const byRun = new Map()
  if (!existsSync(file)) return byRun
  try {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue
      let event
      try { event = JSON.parse(line) } catch { continue }
      if (!runIds.has(event.run_id) || !Number.isFinite(Date.parse(event.ts))) continue
      if (!['run_created', 'dispatch', 'recv', 'decision'].includes(event.kind)) continue
      if (!byRun.has(event.run_id)) byRun.set(event.run_id, [])
      byRun.get(event.run_id).push(event)
    }
  } catch { return new Map() }
  for (const events of byRun.values()) events.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
  return byRun
}

function buildTimeline(assignments, outbox, events, nowMs) {
  if (!events?.some(e => e.kind === 'dispatch')) return null
  const dispatch = new Map(events.filter(e => e.kind === 'dispatch').map(e => [e.message_id, e.ts]))
  const replyParent = new Map(outbox.map(o => [o.env.id, o.env.parent_id]).filter(([id, parent]) => id && parent))
  const receipts = new Map()
  const seenReplies = new Set()
  let duplicateReceipts = 0
  let additionalReplies = 0
  for (const event of events) {
    if (event.kind !== 'recv') continue
    const parent = replyParent.get(event.message_id)
    if (!parent) continue
    if (dispatch.has(parent) && Date.parse(event.ts) < Date.parse(dispatch.get(parent))) continue
    if (seenReplies.has(event.message_id)) { duplicateReceipts++; continue }
    seenReplies.add(event.message_id)
    if (receipts.has(parent)) additionalReplies++
    else receipts.set(parent, event.ts)
  }
  const spans = assignments.map(a => {
    const dispatchedAtIso = dispatch.get(a.message) || a.dispatchedAtIso
    const firstRecvAtIso = receipts.get(a.message) || ''
    const endAtIso = a.state === 'open' || a.state === 'late'
      ? new Date(nowMs).toISOString()
      : (firstRecvAtIso || a.settledAtIso || dispatchedAtIso)
    return {
      message: a.message, role: a.role, state: a.state,
      dispatchedAtIso, firstRecvAtIso, settledAtIso: a.settledAtIso,
      deadlineAtIso: a.deadlineAtIso, endAtIso,
      ledgerDispatch: dispatch.has(a.message), ledgerReceipt: receipts.has(a.message),
    }
  }).filter(s => Number.isFinite(Date.parse(s.dispatchedAtIso)))
  const decisions = events.filter(e => e.kind === 'decision').map(e => ({ atIso: e.ts, kind: 'decision' }))
  const stamps = [
    ...events.filter(e => e.kind === 'run_created').map(e => e.ts),
    ...spans.flatMap(s => [s.dispatchedAtIso, s.endAtIso, s.firstRecvAtIso, s.settledAtIso]),
    ...decisions.map(e => e.atIso),
  ].map(s => Date.parse(s)).filter(Number.isFinite)
  if (!spans.length || !stamps.length) return null
  return {
    startAtIso: new Date(Math.min(...stamps)).toISOString(),
    endAtIso: new Date(Math.max(...stamps)).toISOString(),
    spans, decisions, duplicateReceipts, additionalReplies,
    linkedReceipts: spans.filter(s => s.ledgerReceipt).length,
  }
}

export function readBoard(unitedDir, opts = {}) {
  const runsDir = join(unitedDir, 'runs')
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now()
  const out = { tasks: [], backgroundTasks: readBackgroundTasks(unitedDir, nowMs), hands: [], summary: { runs: 0, assigned: 0, returned: 0, working: 0, attention: 0, done: 0 }, updatedAt: '', headline: '' }
  if (!existsSync(runsDir)) return { ...out, headline: '还没有任务记录。' }

  const runs = readdirSync(runsDir).filter(d => { try { return statSync(join(runsDir, d)).isDirectory() } catch { return false } })
  const ledger = readTimelineEvents(unitedDir, new Set(runs))
  let newest = 0

  for (const id of runs) {
    const d = join(runsDir, id)
    const st = rd(join(d, 'state.json'))
    const goal = rd(join(d, 'goal.json'))
    if (!st || !goal) continue

    const inbox = existsSync(join(d, 'in'))
      ? readdirSync(join(d, 'in')).filter(f => f.endsWith('.json')).map(f => rd(join(d, 'in', f))).filter(Boolean)
      : []
    const outbox = existsSync(join(d, 'out'))
      ? readdirSync(join(d, 'out')).filter(f => f.endsWith('.json')).map(f => ({ env: rd(join(d, 'out', f)), t: md(join(d, 'out', f)) })).filter(x => x.env)
      : []
    const decisions = existsSync(join(d, 'decisions')) ? readdirSync(join(d, 'decisions')).filter(f => f.endsWith('.json')).length : 0

    // 外部进程（cloud 直接起的 codex / 执行器）：由 watchdog 写进来
    const ext = rd(join(d, 'external.json'))
    const extItems = (ext && ext.items) || []
    const byId = new Map(inbox.map(e => [e.id, e]))
    const pend = st.pending || {}

    // 派出去的活：每一条都写清"派给谁、要求是什么、什么状态"
    const assignments = Object.entries(pend).map(([mid, v]) => {
      const task = byId.get(mid)
      // 这一单有没有交回
      const reply = outbox.find(o => (o.env.parent_id === mid) || (o.env.id === mid))?.env
      const deadlineMs = v.deadline_at ? new Date(v.deadline_at).getTime() : null
      const late = v.status === 'pending' && deadlineMs && nowMs > deadlineMs
      const blocked = reply?.kind === 'blocked' || reply?.kind === 'incident'
      // 阻塞回执不等于任务完成；保留它的实际状态供角色卡和任务卡共用。
      const state = blocked ? 'blocked' : (v.status === 'settled' ? 'done' : (late ? 'late' : 'open'))
      return {
        message: mid,
        who: roleName(v.part),
        role: v.part,
        phase: task?.phase || '',
        ask: (task?.task?.objective) || '（没记下要求）',
        want: (task?.task?.deliverables || []).join('、') || '结果',
        state,
        stateText: { blocked: '卡住', done: '已交回', late: '超时没交', open: '在做' }[state],
        dispatchedAtIso: v.dispatched_at || '',
        deadlineAtIso: v.deadline_at || '',
        settledAtIso: v.settled_at || '',
        dispatchedAt: v.dispatched_at ? ago(new Date(v.dispatched_at).getTime(), nowMs) : '',
        left: v.status === 'pending' ? left(v.deadline_at, nowMs) : '',
        got: reply ? summarizeReply(reply) : '',
        gotKind: reply?.kind || '',
      }
    })
    // 这是派单先后，不是依赖关系；旧记录缺时间戳时不重排。
    if (assignments.every(a => Number.isFinite(Date.parse(a.dispatchedAtIso)))) {
      assignments.sort((a, b) => Date.parse(a.dispatchedAtIso) - Date.parse(b.dispatchedAtIso))
    }

    // 有没有人提异议
    const objections = outbox.filter(o => o.env.kind === 'objection')
    const blockedOne = outbox.filter(o => o.env.kind === 'blocked' || o.env.kind === 'incident')
    const overdue = assignments.some(a => a.state === 'late')
    const waiting = assignments.filter(a => a.state === 'open' || a.state === 'late')
    // 旧字段表示已收回的派单回执；阻塞回执也已交回，但仍单列为卡住。
    const doneCount = assignments.filter(a => a.state === 'done' || a.state === 'blocked').length

    let statusCode = 'unknown'
    let verdict = '待核对'
    let verdictCls = 'wait'
    if (st.status === 'done') { statusCode = 'done'; verdict = '办完了'; verdictCls = 'ok' }
    else if (st.veto || objections.length) { statusCode = 'decision'; verdict = '有人提异议，等你定'; verdictCls = 'redo' }
    else if (st.status === 'blocked' || blockedOne.length) { statusCode = 'blocked'; verdict = '卡住了'; verdictCls = 'redo' }
    else if (overdue) { statusCode = 'overdue'; verdict = '有人超时'; verdictCls = 'wait' }
    else if (waiting.length) { statusCode = 'working'; verdict = '在做'; verdictCls = 'doing' }
    // 已交回不代表整单办完；没有未交派单时显示交接空档，而不是虚报有人在做。
    else if (st.status === 'running') { statusCode = 'handoff'; verdict = '待下一步'; verdictCls = 'wait' }

    let t = 0
    for (const o of outbox) t = Math.max(t, o.t)
    t = Math.max(t, md(join(d, 'state.json')))
    if (t) newest = Math.max(newest, t)

    for (const x of extItems) {
      assignments.push({
        message: x.task_id,
        who: '外部程序',
        role: 'external',
        ask: x.title + (x.what ? '：' + x.what : ''),
        want: '结果',
        state: x.state === 'running' ? 'open' : (x.state === 'done' ? 'done' : 'late'),
        stateText: x.stateText,
        dispatchedAt: x.startedAt ? x.startedAt : '',
        left: x.elapsedMin ? '已跑 ' + x.elapsedMin + ' 分钟' : '',
        got: x.recent && x.recent.length ? '刚动过：' + x.recent[0].file : '',
        gotKind: 'external',
        external: true,
      })
    }
    out.tasks.push({
      id,
      goal: goal.goal,
      acceptance: goal.acceptance || '',
      rawState: st.status || '',
      statusCode,
      verdict, verdictCls,
      turn: st.watermark?.turn || 0,
      step: st.watermark?.step || 0,
      decisions,
      assignments,
      timeline: buildTimeline(assignments, outbox, ledger.get(id), nowMs),
      waiting: waiting.length,
      doneCount,
      total: assignments.length,
      blockedCount: assignments.filter(a => a.state === 'blocked').length,
      objections: objections.length,
      lastAt: t ? ago(t, nowMs) : '',
      lastAtIso: t ? new Date(t).toISOString() : '',
      _t: t,
    })
  }

  out.tasks.sort((a, b) => {
    const rank = { redo: 0, wait: 1, doing: 2, ok: 3 }
    const r = (rank[a.verdictCls] ?? 4) - (rank[b.verdictCls] ?? 4)
    return r !== 0 ? r : b._t - a._t
  })

  // 手脚：谁在忙、谁闲着
  const busy = new Map()
  for (const t of out.tasks) for (const a of t.assignments) if (a.state === 'open' || a.state === 'late') busy.set(a.role, (busy.get(a.role) || 0) + 1)
  out.hands = ['explorer', 'builder', 'guardian'].map(r => ({
    role: r, who: roleName(r),
    busy: busy.get(r) || 0,
    state: busy.get(r) ? `手上有 ${busy.get(r)} 件` : '空闲',
  }))
  out.summary = {
    runs: out.tasks.length,
    assigned: out.tasks.reduce((n, t) => n + t.total, 0),
    returned: out.tasks.reduce((n, t) => n + t.doneCount, 0),
    working: out.tasks.reduce((n, t) => n + t.assignments.filter(a => a.state === 'open').length, 0),
    attention: out.tasks.filter(t => ['decision', 'blocked', 'overdue', 'handoff', 'unknown'].includes(t.statusCode)).length,
    done: out.tasks.filter(t => t.statusCode === 'done').length,
  }

  const attn = out.tasks.filter(t => t.verdictCls === 'redo' || t.verdictCls === 'wait')
  out.headline = attn.length
    ? `${attn.length} 件事需留意：${attn[0].verdict}`
    : (out.tasks.length ? `${out.tasks.length} 件事在手上，都在正常推进` : '还没有任务记录。')
  out.updatedAt = newest ? ago(newest, nowMs) : ''
  return out
}
