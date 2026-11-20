#!/usr/bin/env node
/**
 * 联合体 P0 骨架 · 按 codex 裁决 v2（docs/codex-裁决-P0.md）
 *
 * 角色：规划/决策/审核 = Codex；执行/维护 = 云舒。协调方（Self）只做三件事：分派、写账本、对外说话，不执行任务。
 *
 * 裁决落地对照：
 *  D1 pending[message_id] + deadline；逾期无回执 → outcome_unknown，暂停重派，只对账
 *  D2 一个完整窗口内「无合法回执推进 step」且「无内容哈希变化」才 STALE；turn/step 单调；turn 只计预算
 *  D3 Guardian 在 veto_scope 内有证据 objection → 协调方置 disputed 并阻断交付；只有 Self 能解除
 *  D4 Explorer 只读、Builder 可写禁网（由执行器强制；本骨架只声明与校验，不代跑）
 *  D5 全局 LOCK（wx 排他）覆盖所有变更命令，finally 释放
 *  D6 去重 = goal_rev+part+objective 哈希；超预算直接拒；done/blocked 不复活，人工开新 run
 *  D7 不做私有记忆；PartSpec 标 run-scoped-auditable，上下文只从 envelope/账本/决策读
 *  D8 7→15–16 不是联合体基线；+15pp 须冻结同题集配对算
 *
 * 命令：run / status / new / dispatch / recv / verdict / watch / show / selftest
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, appendFileSync, openSync, closeSync, unlinkSync, renameSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { join, dirname, resolve } from 'node:path'
import { LedgerV2, lockHolderAlive, LedgerError } from './ledger-v2.mjs'
import { reduce, diffState, COMPARABLE, REDUCER_REV } from './reducer.mjs'
import { handoffContract, assertHandoffFinding, enrollment } from './handoff-contract.mjs'
import { reviewRefs, completionBasis } from './verdict-evidence.mjs'
import { readPanelTicket, panelDispatchSummary, readSentTask } from './panel-control.mjs'
import { dispatchRestriction, objectiveKey, readPart } from './dispatch-policy.mjs'
import { ROOT as POLICY_ROOT } from './pathcheck.mjs'
import { matchingMediaHands } from '../media/registry.mjs'
import { assertRunnerKey, verifyReceipt } from './receipt.mjs'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = fileURLToPath(import.meta.url)
const RUNS = process.env.UNITED_RUNS_DIR || join(ROOT, 'runs')
const LEDGER = process.env.UNITED_LEDGER || join(ROOT, 'ledger.ndjson')
const dataRoot = process.env.UNITED_RUNS_DIR ? dirname(resolve(RUNS)) : ROOT
const LOCK = join(dataRoot, '.united.lock')

const now = () => new Date().toISOString()
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex')
class Exit extends Error { constructor(m, code = 2) { super(m); this.code = code } }
const die = (m, code = 2) => { throw new Exit(m, code) }
const ok = (m) => console.log('✓ ' + m)

function args(argv) {
  const a = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]
    if (t.startsWith('--')) {
      const k = t.slice(2); const nx = argv[i + 1]
      if (nx === undefined || (typeof nx === 'string' && nx.startsWith('--'))) a[k] = true
      else { a[k] = argv[++i] }
    } else a._.push(t)
  }
  return a
}
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
const writeJson = (p, o) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(o, null, 2) + '\n', 'utf8') }
const fileSha = (p) => sha(readFileSync(p))
const ledger = (rec) => appendFileSync(LEDGER, JSON.stringify(rec) + '\n', 'utf8')

// ── M3：权威提交流（先提交日志，再写投影）────────────────────────
const LEDGER_V2 = process.env.UNITED_LEDGER_V2 || join(ROOT, 'ledger-v2.ndjson')
let _v2 = null
function v2() {
  if (!_v2) _v2 = new LedgerV2(LEDGER_V2)
  return _v2
}
/** 提交一帧；失败即整体失败（不允许日志没落就写投影） */
/** 外部写入的 JSON 可能把单元素数组压成对象，统一规范成数组 */
const asArr = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v])

function commitV2(op, runId, payload, opId) {
  try {
    return v2().commit({ runId, opId, op, payload, at: now() })
  } catch (e) {
    if (e instanceof LedgerError) die(`${e.code}: ${e.message}`, e.code === 'LOG_CORRUPT' ? 7 : 8)
    throw e
  }
}
function framesOfV2(runId) {
  try { return v2().framesOf(runId) }
  catch (e) {
    if (e instanceof LedgerError) die(e.code + ': ' + e.message, e.code === 'LOG_CORRUPT' ? 7 : 8)
    throw e
  }
}
const runDir = (id) => { if (!/^r-[a-zA-Z0-9-]+$/.test(id || '')) die('run_id 非法'); const p = join(RUNS, id); if (!existsSync(p)) die('没有这个 run：' + id); return p }
function loadPart(id) {
  const part = readPart(dataRoot, id)
  if (!part) die('没有这个 part：' + id)
  return part
}

// ── D5：全局排他锁 ──────────────────────────────────────────────
function withLock(fn) {
  let fd
  try { fd = openSync(LOCK, 'wx') }
  catch { die('另一个联合体命令正在运行（.united.lock 存在），本次退出，不等待', 3) }
  try { return fn() }
  finally { try { closeSync(fd) } catch {} try { unlinkSync(LOCK) } catch {} }
}

// ── Envelope 校验（缺字段就退回，不猜）────────────────────────────
const REQUIRED = ['v', 'id', 'run_id', 'goal_id', 'goal_rev', 'from', 'to', 'kind', 'phase', 'at']
const KINDS = ['task', 'finding', 'objection', 'decline', 'blocked', 'incident', 'decision', 'ack']
function validateEnvelope(env) {
  const miss = REQUIRED.filter(k => env[k] === undefined || env[k] === null || env[k] === '')
  if (miss.length) return `缺字段：${miss.join(', ')}`
  if (env.v !== 1) return `版本不支持：${env.v}（只收 1）`
  if (!KINDS.includes(env.kind)) return `kind 非法：${env.kind}`
  if (env.kind === 'task' && !env.task) return 'task 缺 task 块'
  if (['finding', 'objection'].includes(env.kind) && !env.claim) return `${env.kind} 缺 claim 块`
  if (['finding', 'objection'].includes(env.kind) && !Array.isArray(env.claim?.evidence)) return 'claim.evidence 必须是数组'
  if (['blocked', 'incident'].includes(env.kind) && !env.stuck) return `${env.kind} 缺 stuck 块（必须给已试路径与解阻条件）`
  if (env.kind === 'decision' && !env.decision?.rule) return 'decision 缺 decision.rule'
  return null
}

// ── new ────────────────────────────────────────────────────────
function cmdNew(a) {
  let panel = null
  if (a['panel-stdin'] === true) {
    const input = JSON.parse(readFileSync(0, 'utf8'))
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input.requestId) ||
        typeof input.goal !== 'string' || !input.goal.trim() || input.goal.length > 2000 ||
        typeof input.accept !== 'string' || !input.accept.trim() || input.accept.length > 2000 ||
        typeof input.target !== 'string' || input.target.length > 500) die('任务参数无效')
    a = {goal:input.goal.trim(), accept:input.accept.trim()}
    panel = {requestId:input.requestId.toLowerCase(),target:input.target}
  }
  if (!a.goal) die('--goal 必填')
  if (!a.accept) die('--accept 必填（验收标准不能省）')
  const rev = Number(a.rev || 1)
  const goalId = 'g-' + sha(String(a.goal)).slice(0, 8)
  const runId = panel ? 'r-ui-' + panel.requestId : 'r-' + now().replace(/[-:T.Z]/g, '').slice(0, 14) + '-' + sha(String(Math.random())).slice(0, 4)
  const dir = join(RUNS, runId)
  const frames = panel ? framesOfV2(runId) : []
  if (frames.length) {
    const original = frames[0].payload
    if (frames[0].op !== 'new' || original.goal !== a.goal || original.acceptance !== a.accept ||
        original.panel?.target !== panel.target) die('同一创建请求的内容不一致')
    if (existsSync(join(dir,'state.json')) && existsSync(join(dir,'goal.json')) && existsSync(join(dir,'disposition.json'))) {
      console.log(runId); return
    }
    if (frames.length > 1) die('原任务已推进但资料缺失，请先核对原票')
  }
  for (const d of ['in', 'out', 'artifacts', 'decisions']) mkdirSync(join(dir, d), { recursive: true })
  const _turns = Number(a.turns) || 4
  if (!frames.length) commitV2('new', runId, {
    goal_id: goalId, goal_rev: rev, goal: a.goal, acceptance: a.accept,
    budget: { turns_max: _turns, active_max: 3, parts_max: 5 }, plan_rev: null, ...(panel ? {panel} : {}),
  })
  writeJson(join(dir, 'goal.json'), { goal_id: goalId, revision: rev, goal: a.goal, acceptance: a.accept, created_at: frames[0]?.at || now(), ...(panel ? {panel} : {}) })
  writeJson(join(dir, 'state.json'), {
    run_id: runId, goal_id: goalId, goal_rev: rev, status: 'open', phase: 'clarify',
    active_parts: [], pending: {}, decision_seq: 0, seen_ids: [], seen_objectives: [],
    budget: { parts_max: 5, active_max: 3, turns_max: _turns }, plan_rev: null,
    watermark: { seq: 0, turn: 0, step: 0, at: now() },
  })
  writeJson(join(dir, 'disposition.json'), { filtered: [], fanout: [] })
  ledger({ ts: now(), kind: 'run_created', run_id: runId, goal_id: goalId, goal_rev: rev })
  ok(`run 建好：${runId}`); console.log(`  goal_id=${goalId} rev=${rev}`)
}

function cmdDispatch(a) {
  const dir = runDir(a.run)
  const part = loadPart(a.part)
  const objective = a.objective || die('--objective 必填')
  const actionId = typeof a['action-id'] === 'string' && a['action-id'].trim() ? a['action-id'].trim() : null
  // The panel is an explicit human action. Keep the existing manual admission gate.
  if (part.executor && a.manual !== true) die('COST_ADMISSION_DENIED: paid unattended dispatch lacks a verified upstream hard cap; use --manual', 9)
  const st = readJson(join(dir, 'state.json'))
  const disp = readJson(join(dir, 'disposition.json'))
  // A panel retry must not create a second task. Check both the projection and the
  // authoritative V2 frame so a crash between commit and projection remains safe.
  if (actionId) {
    const prior = disp.fanout.find(x => x.action_id === actionId)
      || framesOfV2(a.run).find(f => f.op === 'dispatch' && f.payload?.action_id === actionId)?.payload
    if (prior) {
      const messageId = prior.message_id || prior.id || null
      ok(`动作 ${actionId} 已处理${messageId ? '：' + messageId : ''}`)
      if (messageId) console.log('  message_id=' + messageId)
      return { reused: true, message_id: messageId }
    }
  }
  const blocked = dispatchRestriction(st, part, objective)?.message
  if (blocked) {
    disp.filtered.push({ at: now(), part: a.part, reason: blocked })
    writeJson(join(dir, 'disposition.json'), disp)
    ledger({ ts: now(), kind: 'dispatch_filtered', run_id: a.run, part: a.part, reason: blocked })
    console.log(`· Fast Path 拦下：${blocked}`)
    // C2：被过滤不是成功，退出码 5；用 die 抛 Exit（不能 process.exit，否则跳过 withLock 的 finally，锁不释放）
    die(`Fast Path 过滤：${blocked}`, 5)
  }
  const goal = readJson(join(dir, 'goal.json'))
  const deadlineMin = Number(a.deadline || part.budget?.minutes || 20)
  const refs = reviewRefs(framesOfV2(st.run_id), dir, st)
  const env = {
    v: 1, id: 'm-' + sha(a.run + a.part + objective + now()).slice(0, 10), parent_id: st.last_message_id || null,
    run_id: st.run_id, goal_id: st.goal_id, goal_rev: st.goal_rev,
    from: 'self', to: a.part, kind: 'task', phase: part.trigger?.phase || 'explore', at: now(),
    deadline_ms: deadlineMin * 60000,
    execution_mode: a.manual === true ? 'manual' : 'unattended',
    task: { objective, deliverables: part.output_schema?.deliverables || ['finding'], acceptance: goal.acceptance, constraints: part.forbidden_actions || [], budget: { turns: 1 } },
    context: { summary: a['summary-stdin'] === true ? readFileSync(0, 'utf8') : a.summary || null, source_refs: [], artifact_refs: refs.map(r => r.uri), artifact_evidence: refs, memory_rev: st.goal_rev, media_hands: matchingMediaHands(objective) },
  }
  const bad = validateEnvelope(env); if (bad) die('task envelope 不合法：' + bad)
  const _dispAt = now()
  const _dlAt = new Date(Date.now() + deadlineMin * 60000).toISOString()
  commitV2('dispatch', st.run_id, {
    message_id: env.id, part: a.part, objective, phase: env.phase,
    dispatched_at: _dispAt, deadline_at: _dlAt,
    seen_objective: objectiveKey(st.goal_rev, a.part, objective),
    artifact_refs: env.context.artifact_refs, artifact_evidence: refs, execution_mode: env.execution_mode,
    ...(actionId ? { action_id: actionId } : {}),
    ...(a['handoff-state']||a['handoff-workspace'] ? {handoff_host:(()=>{if(a.part!=='builder'||a.manual!==true)die('专用交付须登记 manual builder');return enrollment(a['handoff-state'],a['handoff-workspace']);})()} : {}),
  })
  writeJson(join(dir, 'in', `${a.part}-${env.id}.json`), env)
  st.last_message_id = env.id
  st.active_parts = [...new Set([...(st.active_parts || []), a.part])]
  st.seen_objectives = [...(st.seen_objectives || []), objectiveKey(st.goal_rev, a.part, objective)]
  st.pending = { ...(st.pending || {}), [env.id]: { part: a.part, status: 'pending', dispatched_at: _dispAt, deadline_at: _dlAt } }
  st.status = st.status === 'open' ? 'running' : st.status
  st.watermark = { ...st.watermark, turn: (st.watermark.turn || 0) + 1, at: _dispAt }
  writeJson(join(dir, 'state.json'), st)
  disp.fanout.push({ at: _dispAt, part: a.part, message_id: env.id, ...(actionId ? { action_id: actionId } : {}) })
  writeJson(join(dir, 'disposition.json'), disp)
  ledger({ ts: now(), kind: 'dispatch', run_id: a.run, part: a.part, message_id: env.id, phase: env.phase })
  ok(`派给 ${a.part}：${env.id}`)
  console.log(`  acceptance 已冻结；artifact_refs=${env.context.artifact_refs.length} 条；截止 ${deadlineMin} 分钟`)
  return { message_id: env.id }
}

// ── recv：五类校验（B1）────────────────────────────────────────
function cmdRecv(a) {
  const dir = runDir(a.run)
  if (!!a.file === !!a.receipt) die('只能选 --receipt（正式路径）或 --file --manual（人工路径）')
  if (a.file && a.manual !== true) die('裸 --file 已关闭；人工接手须显式 --manual')
  if (a.receipt && a.manual) die('正式回执不可标为 manual')
  let src, proof = null
  if (a.receipt) {
    const receiptFile = resolve(a.receipt)
    if (dirname(receiptFile) !== resolve(dir, 'receipts')) die('回执必须在本 run 的 receipts 目录')
    try { proof = verifyReceipt(readJson(receiptFile), dir) } catch (e) { die('RUNNER_RECEIPT_INVALID: ' + e.message) }
    if (proof.run_id !== a.run) die('回执 run_id 不符')
    src = proof.envelope.path
  } else src = resolve(a.file)
  if (!existsSync(src)) die('结果文件不存在：' + src)
  const env = readJson(src)
  const bad = validateEnvelope(env); if (bad) { ledger({ ts: now(), kind: 'recv_rejected', run_id: a.run, reason: bad }); die('退回，不猜：' + bad) }
  const st = readJson(join(dir, 'state.json'))
  const reject = (why) => { ledger({ ts: now(), kind: 'recv_rejected', run_id: a.run, message_id: env.id, reason: why }); die('退回：' + why) }
  if (proof) {
    if (env.parent_id !== proof.message_id || env.runner_attempt_id !== proof.attempt_id || env.from !== proof.part) reject('回执与任务/attempt_id 不匹配')
    const taskFile = join(dir, 'claimed', proof.part + '-' + proof.message_id + '.json')
    if (resolve(proof.task.path) !== resolve(taskFile) || !existsSync(taskFile)) reject('没有对应的 runner 已认领任务')
    const mode = readJson(taskFile).execution_mode
    if (mode !== 'unattended' && !(mode === 'manual' && proof.cost_approval?.mode === 'manual'
      && proof.cost_approval.approved_estimate_usd > 0 && proof.cost_approval.price_basis)) reject('任务没有对应的费用准入')
    if (proof.exit_code !== 0 && env.kind !== 'incident') reject('执行器失败不能提交成功 claim')
  } else {
    const taskFile = join(dir, 'in', env.from + '-' + env.parent_id + '.json')
    if (!existsSync(taskFile) || readJson(taskFile).execution_mode !== 'manual') reject('人工回执没有对应 manual 任务单')
  }
  if (env.from==='builder' || env.handoff_delivery) { try { assertHandoffFinding(env,framesOfV2(st.run_id),st) } catch(e) { reject(e.message) } }
  if (env.rank_delivery && (env.rank_delivery.kind !== 'rank-list-v1' || env.rank_delivery.planRev !== null || st.plan_rev !== null || framesOfV2(st.run_id).some(f=>f.op==='revise'))) reject('固定合同在交回前已有修订');
  if (env.run_id !== st.run_id) reject(`run_id 不符（${env.run_id} ≠ ${st.run_id}）`)
  if (env.goal_id !== st.goal_id) reject(`goal_id 不符`)
  if ((st.seen_ids || []).includes(env.id)) reject(`重复回执 id：${env.id}`)
  if (env.goal_rev !== st.goal_rev) {
    commitV2('recv_stale', st.run_id, { message_id: env.id, from: env.from, reason: 'STALE' }, 'recvstale-' + env.id)
  writeJson(join(dir, 'out', 'stale-' + env.id + '.json'), { ...env, disposition: 'stale' })
    st.seen_ids = [...(st.seen_ids || []), env.id]; writeJson(join(dir, 'state.json'), st)
    ledger({ ts: now(), kind: 'recv_stale', run_id: a.run, message_id: env.id }); ok('归档为 stale，不推进水位'); return
  }
  // C1：必须精确命中 parent_id，且来源一致、仍在 pending；不再退化为"任意该 part 的 pending"
  if (a.from && a.from !== env.from) reject(`--from(${a.from}) 与回执 from(${env.from}) 不符`)
  const pend = (st.pending || {})[env.parent_id]
  if (!pend) reject(`parent_id 无对应派单：${env.parent_id || 'null'}`)
  if (pend.part !== env.from) reject(`回执来源不符：该派单属于 ${pend.part}，收到 ${env.from}`)
  if (pend.status !== 'pending') {
    if (pend.status === 'outcome_unknown') writeJson(join(dir, 'out', 'late-' + env.id + '.json'), { ...env, disposition: 'late_unsettled' })
    reject('该派单已 ' + pend.status + '，不能重复结算')
  }
  if (env.to !== 'self') reject(`回执必须发给 self，收到 to=${env.to}`)
  const _ev = [...asArr(env.evidence), ...asArr(env.claim && env.claim.evidence)]
  const _settledAt = now()
  commitV2('recv', st.run_id, {
    message_id: env.id, parent_id: env.parent_id, from: env.from, to: env.to, kind: env.kind,
    provenance: proof ? { attempt_id: proof.attempt_id, exit_code: proof.exit_code,
      started_at: proof.started_at, ended_at: proof.ended_at,
      stdout_sha256: proof.stdout.sha256, stderr_sha256: proof.stderr.sha256,
      model_output_sha256: proof.model_output?.sha256 || null,
      model_output_origin: proof.model_output_origin,
      normalized_result_sha256: proof.normalized_result.sha256 } : { mode: 'manual' },
    veto: env.veto || null, claim_statement: env.claim?.statement ?? null,
    evidence_count: _ev.length, evidence: _ev, envelope_sha256: sha(JSON.stringify(env)), confidence_p: env.confidence?.p ?? null,
    settled_at: _settledAt,
  }, 'recv-' + env.id)
  writeJson(join(dir, 'out', env.id + '.json'), env)
  st.seen_ids = [...(st.seen_ids || []), env.id]
  st.watermark = { ...st.watermark, step: (st.watermark.step || 0) + 1, seq: (st.watermark.seq || 0) + 1, at: now() }
  st.pending[env.parent_id] = { ...pend, status: 'settled', settled_at: _settledAt }
  st.active_parts = (st.active_parts || []).filter(p =>
    Object.values(st.pending || {}).some(v => v.part === p && v.status === 'pending'))
  if (env.kind === 'objection') {
    const g = loadPart('guardian'); const inScope = (g.veto_scope || []).includes(env.veto || 'acceptance_violation')
    if (inScope && Array.isArray(env.claim?.evidence) && env.claim.evidence.length) { st.status = 'disputed'; st.veto = { by: env.from, id: env.id, at: now(), scope: env.veto || 'acceptance_violation' } }
  }
  if (env.kind === 'blocked' || env.kind === 'incident') st.status = 'blocked'
  writeJson(join(dir, 'state.json'), st)
  ledger({ ts: now(), kind: 'recv', run_id: a.run, from: env.from, message_id: env.id, msg_kind: env.kind, status: st.status })
  ok(`收下 ${env.kind}：${env.id}（run=${st.status}）`)
}

// An interrupted launch never gets replayed automatically. A human must settle it.
function cmdUnknown(a) {
  const dir = runDir(a.run)
  const st = readJson(join(dir, 'state.json'))
  if (!a.action) {
    console.log(JSON.stringify(Object.entries(st.pending || {}).filter(([, p]) => p.status === 'outcome_unknown')
      .map(([message_id, p]) => ({ message_id, ...p })), null, 2))
    return
  }
  const old = st.pending?.[a.message]
  if (!old) die('没有该 pending message_id')
  if (!a.reason || a.reason === true) die('--reason 必填')
  if (a.action === 'mark') {
    if (old.status !== 'pending') die('只有 pending 可标为 outcome_unknown')
    const changed = { ...old, status: 'outcome_unknown', marked_at: now(), reason: String(a.reason) }
    commitV2('unknown_resolution', a.run, { message_id: a.message, pending: changed })
    st.pending[a.message] = changed
    writeJson(join(dir, 'state.json'), st)
    ok('标为 outcome_unknown：' + a.message)
    return
  }
  if (old.status !== 'outcome_unknown') die('只有 outcome_unknown 可人工处置')
  if (!['complete', 'void', 'redispatch'].includes(a.action)) die('--action 只能是 mark|complete|void|redispatch')
  if (a.action === 'redispatch' && a.confirm !== true) die('重派须显式 --confirm（将生成新 msg_id）')
  const evidence = a.evidence ? resolve(a.evidence) : null
  if (a.action === 'complete' && (!evidence || !existsSync(evidence))) die('标记完成须给现存 --evidence 文件')
  if (a.action === 'redispatch' && (st.watermark?.turn || 0) >= (st.budget?.turns_max || 4)) die('轮次预算已满，不重派')
  const source = [join(dir, 'claimed', old.part + '-' + a.message + '.json'), join(dir, 'in', old.part + '-' + a.message + '.json')].find(existsSync)
  if (a.action === 'redispatch' && !source) die('原任务单不存在，无法确认重派内容')
  const changed = { ...old, status: 'resolved_' + a.action, resolved_at: now(), resolution: { by: 'human', reason: String(a.reason), evidence: evidence ? { path: evidence, sha256: fileSha(evidence) } : null } }
  let next = null, dispatch = null
  if (a.action === 'redispatch') {
    next = { ...readJson(source), id: 'm-' + randomUUID().replace(/-/g, '').slice(0, 10), parent_id: a.message,
      at: now(), execution_mode: 'manual', retry_of: a.message }
    dispatch = { message_id: next.id, part: old.part, dispatched_at: next.at,
      deadline_at: new Date(Date.now() + next.deadline_ms).toISOString(), execution_mode: 'manual' }
  }
  if (next) writeJson(join(dir, 'in', old.part + '-' + next.id + '.json'), next)
  commitV2('unknown_resolution', a.run, { message_id: a.message, pending: changed, dispatch })
  st.pending[a.message] = changed
  st.active_parts = (st.active_parts || []).filter(p =>
    Object.values(st.pending || {}).some(v => v.part === p && v.status === 'pending'))
  if (dispatch) {
    st.pending[next.id] = { part: old.part, status: 'pending', dispatched_at: dispatch.dispatched_at, deadline_at: dispatch.deadline_at }
    if (!st.active_parts.includes(old.part)) st.active_parts.push(old.part)
    st.last_message_id = next.id
    st.watermark = { ...st.watermark, turn: (st.watermark.turn || 0) + 1, at: dispatch.dispatched_at }
  }
  writeJson(join(dir, 'state.json'), st)
  ok('人工处置 ' + a.message + ' → ' + changed.status + (next ? '；新任务 ' + next.id : ''))
}

// ── rebuild：从 V2 权威帧重放 state（M4）────────────────────────────
function cmdRebuild(a) {
  const dir = runDir(a.run)
  const stateFile = join(dir, 'state.json')
  const frames = framesOfV2(a.run)

  if (!frames.length) {
    // 旧协议 run：没有 V2 帧，只能报不可重建
    const legacyFields = existsSync(stateFile) ? Object.keys(readJson(stateFile)) : []
    const out = {
      run_id: a.run, protocol: 'legacy', verdict: 'LEGACY_UNRECONSTRUCTABLE',
      reason: '该 run 没有 V2 权威帧（协议升级前创建），无法从日志重放',
      fields_present: legacyFields,
      missing: ['完整事件载荷', '提交顺序', 'watch/pending 的具体转移', 'source_seq/source_hash'],
      suggestion: '只做诊断；如需接续，先经核验建立基线首帧（见裁决 4.旧协议）',
    }
    if (a.json) console.log(JSON.stringify(out, null, 2))
    else {
      console.log(`⚠ ${a.run} 是旧协议 run：LEGACY_UNRECONSTRUCTABLE`)
      console.log(`  有 ${legacyFields.length} 个字段，但缺完整事件源，无法精确重建`)
    }
    return a.verify ? 6 : 0
  }

  const { state: replayed, unreconstructable, source_seq, source_hash } = reduce(frames)
  const actual = existsSync(stateFile) ? readJson(stateFile) : null

  if (!actual) {
    if (a.verify) { console.log(`✗ state.json 缺失，无法比对`); return 6 }
    st_write()
    console.log(`✓ state.json 已从 ${frames.length} 帧重建（seq=${source_seq}）`)
    return
  }

  const diffs = diffState(replayed, actual)
  if (a.verify) {
    const result = {
      run_id: a.run, protocol: 'v2', frames: frames.length,
      source_seq, source_hash: source_hash.slice(0, 16),
      reducer_rev: REDUCER_REV,
      verdict: diffs.length ? 'MISMATCH' : 'VERIFIED',
      diffs, unreconstructable,
      ...(a['handoff-message'] ? {handoff_contract:handoffContract(frames,replayed,a['handoff-message'])} : {}),
      ...(a['rank-contract'] ? {rank_contract:{version:1,goal_rev:replayed.goal_rev,plan_rev:replayed.plan_rev,
        revisions:frames.filter(f=>f.op==='revise').length}} : {}),
    }
    if (a.json) console.log(JSON.stringify(result, null, 2))
    else {
      if (diffs.length) {
        console.log(`✗ ${a.run}: ${diffs.length} 处不一致（${frames.length} 帧）`)
        for (const d of diffs) console.log(`    ${d.field}: 重放=${d.replayed} 实际=${d.actual}`)
      } else {
        console.log(`✓ ${a.run}: VERIFIED（${frames.length} 帧，seq=${source_seq}）`)
      }
      for (const u of unreconstructable) console.log(`    · ${u}`)
    }
    return diffs.length ? 6 : 0
  }

  // 非 verify：原子重写
  st_write()
  function st_write() {
    const merged = { ...replayed }
    // 保留运行时观测字段（_watch 由 watch 命令写，不在事件源里）
    if (actual && actual._watch) merged._watch = actual._watch
    const tmp = stateFile + '.tmp'
    writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf8')
    renameSync(tmp, stateFile)
  }
  console.log(`✓ ${a.run}: state 已从 ${frames.length} 帧重放（seq=${source_seq}，差异 ${diffs.length} 处已覆盖）`)
  for (const u of unreconstructable) console.log(`  · ${u}`)
}

// ── revise：自主改方案必须留痕（协作宪章第三节）───────────────────
function cmdRevise(a) {
  const isGlobal = !!a.global
  const dir = isGlobal ? POLICY_ROOT : runDir(a.run)
  if (!a.problem) die('--problem 必填（必须写现象与证据，不许写"感觉不对"）')
  if (!a.change) die('--change 必填')
  const by = String(a.by || 'cloud')
  if (!['cloud', 'codex', 'claude', 'consensus'].includes(by)) die(`--by 只能是 cloud|codex|claude|consensus，收到 ${by}`)
  const st = isGlobal ? { run_id: 'GLOBAL', goal_rev: null, plan_rev: 1, status: 'n/a' } : readJson(join(dir, 'state.json'))
  if (!isGlobal && st.status === 'done' && !a.force) die('该 run 已 done，改方案必须新开 run（--force 也不建议）')
  const file = join(dir, 'revisions.ndjson')
  const actionId = typeof a['action-id'] === 'string' && a['action-id'].trim() ? a['action-id'].trim() : null
  const evidence = a.evidence ? (Array.isArray(a.evidence) ? a.evidence : [a.evidence]) : []
  const prior = actionId && existsSync(file)
    ? readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(x => JSON.parse(x)).find(x => x.action_id === actionId || x.evidence?.includes('task-action:' + actionId))
    : null
  if (prior) {
    ok(`动作 ${actionId} 已记录方案变更 rev-${prior.rev}`)
    return { reused: true, rev: prior.rev }
  }
  const seq = existsSync(file) ? readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).length + 1 : 1
  const rec = {
    rev: seq, at: now(), run_id: st.run_id, goal_rev: st.goal_rev, by,
    problem: String(a.problem), change: String(a.change),
    evidence,
    ...(actionId && typeof a['panel-goal'] === 'string' ? { panelEdit: { type: 'goal', value: a['panel-goal'] } } : {}),
    ...(actionId && typeof a['panel-step'] === 'string' && typeof a['step-id'] === 'string'
      ? { panelEdit: { type: 'step', stepId: a['step-id'], value: a['panel-step'] } } : {}),
    ...(actionId ? { action_id: actionId } : {}),
    plan_before: st.plan_rev || 1, plan_after: seq,
  }
  const committed = commitV2('revise', isGlobal ? 'GLOBAL' : st.run_id, { rev: seq, by, problem: rec.problem, change: rec.change, evidence: rec.evidence, ...(rec.panelEdit ? { panelEdit: rec.panelEdit } : {}), ...(actionId ? { action_id: actionId } : {}) }, actionId ? 'revise-action-' + actionId : 'revise-' + (isGlobal ? 'G' : st.run_id) + '-' + seq)
  // If the process died after the authoritative commit, the retry replays the
  // same frame and only repairs the missing human-readable revision row.
  if (!existsSync(file) || !readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).some(x => { try { const r = JSON.parse(x); return actionId ? r.action_id === actionId : r.rev === seq } catch { return false } })) {
    appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8')
  }
  if (!isGlobal) { st.plan_rev = seq; st.revisions = seq; writeJson(join(dir, 'state.json'), st) }
  ledger({ ts: now(), kind: 'revise', run_id: st.run_id, rev: seq, by, problem: rec.problem.slice(0, 80) })
  ok(`已记录方案变更 rev-${seq}（by ${by}）`)
  console.log(`  问题：${rec.problem}`)
  console.log(`  改为：${rec.change}`)
  if (!rec.evidence.length) console.log('  ⚠ 没有 evidence，改方案无据可查')
}

// ── verdict：只认已收 claim；done 需 guardian 通过（B5/D3）────────
function cmdVerdict(a) {
  const dir = runDir(a.run)
  if (!a.select) die('--select 必填')
  if (typeof a.rule !== 'string' || !a.rule.trim()) die('--rule 必填（裁决必须能回指依据）')
  const st = readJson(join(dir, 'state.json'))
  if (st.run_id !== a.run) die('父任务投影与请求的 run 不符')
  const frames = framesOfV2(a.run)
  const previous = frames.filter(f => f.op === 'verdict')
  // A repeat, even after a crash between commit and projection, must not append another decision.
  if (st.status === 'done' || previous.some(f => f.payload.status === 'done')) die('已有终裁凭据；请读回或对账，不再写入')
  const replayed = reduce(frames).state
  if (!frames.length || diffState(replayed, st).length || previous.length !== st.decision_seq || (replayed.veto?.id ?? null) !== (st.veto?.id ?? null))
    die('父任务投影与权威账本不符；请先对账')
  if (!frames.some(f => f.op === 'recv' && f.payload.message_id === a.select)) die(`--select 不是已收回执：${a.select}`)
  const wantDone = a.status === 'done' || a.next === 'done'
  if (wantDone && ((a.status && a.status !== 'done') || (a.next && a.next !== 'done'))) die('终裁的 status 与 next 不一致')
  if (a['clear-veto'] && !st.veto) die('没有待解除的 veto')
  const next = wantDone ? 'done' : a.next || 'repair'
  const status = wantDone ? 'done' : (a['clear-veto'] ? 'running' : st.status)
  let basis = {}
  if (wantDone) {
    if (st.status !== 'running' && !(st.status === 'disputed' && st.veto)) die('父任务尚不能终裁：' + st.status)
    try { basis = completionBasis(frames, dir, st, a.select) } catch (e) { die(e.message) }
  }
  if (st.veto && (wantDone || a['clear-veto'])) {
    if (a['clear-veto'] !== st.veto.id || typeof a['clear-reason'] !== 'string' || !a['clear-reason'].trim())
      die(`存在 veto：需 --clear-veto ${st.veto.id} 和非空 --clear-reason`)
  }
  const cleared = st.veto && a['clear-veto'] === st.veto.id ? st.veto.id : null
  const seq = (st.decision_seq || 0) + 1
  if (existsSync(join(dir, 'decisions', `d-${seq}.json`))) die('待写的裁决已有同名记录；请先对账')
  const rec = { decision_id: `d-${seq}`, run_id: st.run_id, goal_id: st.goal_id, goal_rev: st.goal_rev, selected: a.select, rule: a.rule, dissent: a.dissent && a.dissent !== true ? String(a.dissent).split(',') : [], owner: 'self', at: now(), next_state: next, ...basis }
  // A1：解除 veto 的完整记录（objection_id / reason / evidence_refs 逐项校验已在上面做完）
  if (cleared) rec.clear_veto = { objection_id: st.veto.id, reason: String(a['clear-reason']), evidence_refs: a['clear-evidence'] ? [String(a['clear-evidence'])] : [], cleared_by: 'self', at: now() }
  commitV2('verdict', st.run_id, { decision_id: `d-${seq}`, selected: a.select, rule: a.rule, status, next, ...(cleared ? { cleared_veto: cleared } : {}), ...basis }, `verdict-${st.run_id}-${seq}`)
  writeJson(join(dir, 'decisions', `d-${seq}.json`), rec)
  st.decision_seq = seq
  if (wantDone) { st.status = 'done'; delete st.veto }
  else if (a['clear-veto']) { st.status = 'running'; delete st.veto }
  writeJson(join(dir, 'state.json'), st)
  ledger({ ts: now(), kind: 'decision', run_id: st.run_id, decision_id: rec.decision_id, selected: rec.selected, dissent: rec.dissent, run_status: st.status })
  ok(`裁决 d-${seq}：选 ${rec.selected}，异议 ${rec.dissent.length} 条，run=${st.status}`)
}

// ── watch：内容哈希为前，mtime 为后；D1 未知结果；D2 双条件 ────────
function contentFingerprint(dir) {
  const parts = []
  const walk = (d) => { if (!existsSync(d)) return; for (const f of readdirSync(d)) { const p = join(d, f); const s = statSync(p); if (s.isDirectory()) walk(p); else parts.push(f + ':' + fileSha(p)) } }
  walk(join(dir, 'artifacts')); walk(join(dir, 'out'))
  return sha(parts.sort().join('|'))
}

function cmdWatch(a) {
  const staleMin = Number(a['stale-min'] || 30)
  if (!existsSync(RUNS)) { console.log('还没有任何 run'); return }
  const rows = []
  for (const r of readdirSync(RUNS)) {
    // runs/.instinct 是本能路由的记录目录，不是 run；没有 state.json 的目录一律跳过。
    if (r.startsWith('.')) continue
    const dir = join(RUNS, r); if (!statSync(dir).isDirectory()) continue
    if (!existsSync(join(dir, 'state.json'))) continue
    const st = readJson(join(dir, 'state.json'))
    if (st.status === 'done') continue
    // A legacy run has no authoritative new frame; do not create an orphan watch frame.
    if (!framesOfV2(r).some(f => f.op === 'new')) {
      rows.push({ run: r, status: st.status, turn: st.watermark?.turn, step: st.watermark?.step, idle_min: null, unknown: 0, verdict: 'LEGACY_UNRECONSTRUCTABLE' })
      continue
    }
    const wm = st.watermark || {}
    const ageMin = (Date.now() - new Date(wm.at || 0).getTime()) / 60000
    const fp = contentFingerprint(dir)
    const prev = st._watch || {}
    const changed = prev.fingerprint !== undefined && prev.fingerprint !== fp
    const fingerprintAt = changed ? now() : (prev.fingerprintAt || now())
    const idleSinceChange = (Date.now() - new Date(fingerprintAt).getTime()) / 60000
    const noStepProgress = ageMin > staleMin
    const noContentChange = idleSinceChange > staleMin
    const stale = noStepProgress && noContentChange
    // D1：逾期无回执
    let unknowns = 0
    for (const [id, p] of Object.entries(st.pending || {})) {
      if (p.status === 'pending' && new Date(p.deadline_at).getTime() < Date.now()) { st.pending[id] = { ...p, status: 'outcome_unknown', marked_at: now() }; unknowns++ }
    }
    st._watch = { fingerprint: fp, fingerprintAt, checked_at: now(), verdict: stale ? 'STALE' : 'ok' }
    commitV2('watch', r, { state_patch: { pending: st.pending, _watch: st._watch } })
    writeJson(join(dir, 'state.json'), st)
    if (unknowns) ledger({ ts: now(), kind: 'outcome_unknown', run_id: r, count: unknowns })
    rows.push({ run: r, status: st.status, turn: wm.turn, step: wm.step, idle_min: Math.round(ageMin), unknown: unknowns, verdict: st._watch.verdict })
  }
  if (!rows.length) { console.log('没有进行中的 run'); return }
  console.table(rows)
  const stale = rows.filter(x => x.verdict === 'STALE')
  if (stale.length) { ledger({ ts: now(), kind: 'watch_stale', runs: stale.map(x => x.run) }); console.log(`\n⚠ ${stale.length} 个 run STALE：暂停新派单，只允许 Guardian 进场`) }
  const unk = rows.reduce((s, x) => s + x.unknown, 0)
  if (unk) console.log(`⚠ ${unk} 个派单逾期无回执 → outcome_unknown（只对账，不自动重放）`)
}

function cmdShow(a) {
  const dir = runDir(a.run)
  console.log(JSON.stringify({ state: readJson(join(dir, 'state.json')), goal: readJson(join(dir, 'goal.json')), disposition: readJson(join(dir, 'disposition.json')) }, null, 2))
}

// A read-only view of the active process, independent of the slower run watermark.
function cmdStatus(a) {
  const dir = runDir(a.run)
  const st = readJson(join(dir, 'state.json'))
  const attemptsDir = join(dir, 'attempts')
  const attempts = existsSync(attemptsDir) ? readdirSync(attemptsDir).flatMap(name => {
    const folder = join(attemptsDir, name), intent = join(folder, 'intent.json')
    if (!existsSync(intent)) return []
    const progress = join(folder, 'progress.json')
    return [{ attempt_id: name, intent: readJson(intent), progress: existsSync(progress) ? readJson(progress) : null }]
  }) : []
  const rows = Object.entries(st.pending || {}).map(([message_id, pending]) => {
    const attempt = attempts.filter(x => x.intent.message_id === message_id).sort((x, y) => y.intent.at.localeCompare(x.intent.at))[0]
    const p = attempt?.progress
    let alive = false
    if (p?.pid && !p.ended_at) try { process.kill(p.pid, 0); alive = true } catch (e) { alive = e.code === 'EPERM' }
    const execution = p?.ended_at ? p.status : alive ? (Date.now() > Date.parse(p.deadline_at) ? 'overdue_alive' : 'alive')
      : p ? 'interrupted_unknown' : attempt ? 'claimed_no_heartbeat' : 'queued'
    return { message_id, part: pending.part, settlement: pending.status, execution,
      attempt_id: attempt?.attempt_id || null, pid: p?.pid || null,
      items_completed: p?.items_completed || 0, last_event: p?.last_event || null,
      last_event_detail: p?.last_event_detail || null,
      last_event_at: p?.last_event_at || null, deadline_at: p?.deadline_at || pending.deadline_at }
  })
  if (a.json) console.log(JSON.stringify({ run_id: a.run, run_status: st.status, tasks: rows }, null, 2))
  else if (rows.length) console.table(rows)
  else console.log('该 run 没有派单')
}

// One command removes ID copying; paid work still requires explicit one-task admission.
async function cmdRun(a) {
  if (!a.part || !a.objective) die('run 需要 --part 和 --objective')
  loadPart(a.part)
  const approved = Number(a['approved-cost-usd'])
  if (!Number.isFinite(approved) || approved <= 0 || !a['price-basis'])
    die('COST_ADMISSION_DENIED: run 需要 --approved-cost-usd 和 --price-basis', 9)
  assertRunnerKey()
  if (a['fixture-script'] && process.env.UNITED_RUNNER_TEST !== '1') die('--fixture-script 仅供测试')
  if (process.env.UNITED_RUNNER_TEST !== '1') {
    if (!process.env.HTTP_PROXY || !process.env.HTTPS_PROXY || !process.env.ALL_PROXY)
      die('缺少 HTTP_PROXY / HTTPS_PROXY / ALL_PROXY；没有创建 run')
    const home = process.env.CODEX_HOME || join(process.env.USERPROFILE || process.env.HOME, '.codex')
    const probe = join(home, '.united-write-probe-' + process.pid)
    try { readFileSync(join(home, 'config.toml')); writeFileSync(probe, ''); unlinkSync(probe) }
    catch (e) { die('CODEX_HOME 不可读写：' + home + ' (' + e.message + ')；没有创建 run') }
  }
  const step = (...params) => {
    const r = spawnSync(process.execPath, [CLI, ...params], { encoding: 'utf8', env: process.env, maxBuffer: 1024 * 1024 })
    if (r.stdout) process.stdout.write(r.stdout)
    if (r.stderr) process.stderr.write(r.stderr)
    if (r.status !== 0) die('run 的 ' + params[0] + ' 步骤失败，exit=' + r.status, r.status || 2)
    return r.stdout
  }
  const goal = a.goal || a.objective
  const accept = a.accept || ('收到 ' + a.part + ' 的结构化回执，并通过 recv 校验')
  const created = step('new', '--goal', String(goal), '--accept', String(accept), '--turns', String(a.turns || 4))
  const runId = created.match(/r-\d{14}-[0-9a-f]{4}/)?.[0]
  if (!runId) die('new 没有返回 run_id')
  const dispatched = step('dispatch', '--run', runId, '--part', String(a.part), '--objective', String(a.objective),
    '--manual', ...(a.deadline ? ['--deadline', String(a.deadline)] : []))
  const messageId = dispatched.match(/m-[0-9a-f]{10}/)?.[0]
  if (!messageId) die('dispatch 没有返回 message_id；run=' + runId)
  const args = [join(ROOT, 'bin', 'runner.mjs'), '--run', runId, '--message', messageId,
    '--approved-cost-usd', String(approved), '--price-basis', String(a['price-basis']),
    ...(a['fixture-script'] ? ['--fixture-script', String(a['fixture-script'])] : [])]
  const child = spawn(process.execPath, args, { env: process.env, stdio: 'inherit', windowsHide: true })
  const exitCode = await new Promise((done, fail) => { child.once('error', fail); child.once('close', done) })
  if (exitCode !== 0) die('runner 失败：run=' + runId + ' message=' + messageId + ' exit=' + exitCode, exitCode || 2)
  const state = readJson(join(RUNS, runId, 'state.json'))
  const pending = state.pending?.[messageId]
  if (pending?.status !== 'settled') die('runner 未结算：run=' + runId + ' message=' + messageId + ' status=' + pending?.status)
  const receipt = readJson(join(RUNS, runId, 'receipts', messageId + '.json'))
  const env = readJson(receipt.envelope.path)
  console.log('✓ run=' + runId + ' message=' + messageId + ' recv=' + env.kind + ' reply=' + env.id)
  if (env.kind === 'incident' || env.kind === 'blocked') die('执行结果为 ' + env.kind + '；run=' + runId, 4)
}

// ── selftest：纯函数级断言（不含端到端）──────────────────────────
function cmdSelftest() {
  const good = { v: 1, id: 'm-good', parent_id: 'm-task', run_id: 'r-test', goal_id: 'g-test', goal_rev: 1, from: 'explorer', to: 'self', kind: 'finding', phase: 'explore', at: now(), claim: { statement: 'A', assumptions: [], proposed_action: 'B', evidence: [{ uri: 'artifact://x', sha256: 'a'.repeat(64) }] }, confidence: { p: 0.6, basis: 'x', calibration_tag: 'uncalibrated' } }
  const checks = [
    ['合法 envelope 通过', validateEnvelope(good) === null],
    ['缺字段被拦', /缺字段/.test(validateEnvelope({ v: 1, id: 'x' }) || '')],
    ['blocked 缺 stuck 被拦', /stuck/.test(validateEnvelope({ ...good, kind: 'blocked', claim: undefined }) || '')],
    ['版本 2 被拦', /版本/.test(validateEnvelope({ ...good, v: 2 }) || '')],
    ['finding 缺 evidence 被拦', /evidence/.test(validateEnvelope({ ...good, claim: { statement: 'x' } }) || '')],
  ]
  let pass = 0
  for (const [n, c] of checks) { console.log((c ? '✓ ' : '✗ ') + n); if (c) pass++ }
  console.log(`\n${pass}/${checks.length} 通过`)
  process.exit(pass === checks.length ? 0 : 1)
}

// One engine lock covers the observation, any recorded revision and the dispatch.
function cmdPanelAction(a) {
  const dir = runDir(a.run)
  const action = JSON.parse(readFileSync(0, 'utf8'))
  const type = action.action, id = action.id
  if (typeof id !== 'string' || !/^ta-[a-zA-Z0-9-]+$/.test(id) || !['continue', 'edit-goal', 'edit-step'].includes(type)) die('任务操作无效。')
  const frames = framesOfV2(a.run)
  const dispatchId = type === 'edit-step' ? id + '-dispatch' : id
  const prior = frames.find(f => f.op === 'dispatch' && f.payload.action_id === dispatchId)?.payload
  const revision = frames.find(f => f.op === 'revise' && f.payload.action_id === id)
  if (revision) {
    const original = revision.payload.panelEdit
    const matches = original?.type === 'goal' ? type === 'edit-goal' && original.value === action.goal :
      original?.type === 'step' && type === 'edit-step' && original.stepId === action.stepId && original.value === action.stepText
    if (!matches) die('相同请求编号对应不同的任务修订。')
  } else if (prior && type !== 'continue') die('相同请求编号已用于其他任务操作。')
  const emit = result => console.log(JSON.stringify(result))
  if (prior) {
    const state = readJson(join(dir, 'state.json'))
    if (state.pending?.[prior.message_id]?.part !== prior.part || !readSentTask(dir, state, prior.message_id, prior.part, prior.objective)) die('派单已登记，原指令尚待核对。')
    return emit({kind:type === 'edit-step' ? 'revise+dispatch' : 'dispatch', part:prior.part, messageId:prior.message_id, reused:true})
  }

  let ticket = readPanelTicket(dir, a.run, frames)
  const edit = type !== 'continue'
  if (edit && revision) {
    // The earlier click already changed this plan. Replaying it after a receipt
    // arrives must not send work that had been deferred on the original click.
    const rows = join(dir, 'revisions.ndjson')
    if (!existsSync(rows) || !readFileSync(rows, 'utf8').split(/\r?\n/).filter(Boolean).some(row => JSON.parse(row).action_id === id)) {
      die('修订已登记，原任务记录尚待核对。')
    }
    return emit({kind:'revise', reused:true})
  }
  if (!(edit ? ticket.continuation.canEdit : ticket.continuation.canContinue)) die(ticket.continuation.reason)
  if (edit) {
    const isGoal = type === 'edit-goal'
    const value = isGoal ? action.goal : action.stepText
    if (typeof value !== 'string' || !value.trim() || value.length > (isGoal ? 2000 : 1200)) die('请填写有效的修订内容。')
    if (!isGoal) {
      const original = ticket.state.pending?.[action.stepId]
      if (!original || !readSentTask(dir, ticket.state, action.stepId, original.part)) die('原任务中没有这个派单步骤，请刷新任务台后再编辑')
    }
    cmdRevise({run:a.run, by:'cloud', 'action-id':id, evidence:'task-action:' + id,
      problem:isGoal ? '用户从任务台修改了任务目标：' + value.slice(0, 1200) : '用户从任务台修改步骤 ' + action.stepId,
      change:isGoal ? '保留原始目标证据，并将后续方案调整为：' + value : '后续执行步骤改为：' + value,
      ...(isGoal ? {'panel-goal':value} : {'panel-step':value,'step-id':action.stepId})})
    if (isGoal) return emit({kind:'revise'})
    ticket = readPanelTicket(dir, a.run, framesOfV2(a.run), {stepText:value})
    if (!ticket.continuation.canContinue) {
      const {code, reason} = ticket.continuation
      return emit({kind:'revise', deferred:code === 'pending' ? 'pending-dispatch' : code, reason})
    }
  }
  const part = ticket.continuation.nextRole
  // Manual admission creates a ticket. It never launches a runner or a paid service.
  try {
    const sent = cmdDispatch({run:a.run, part, objective:ticket.objective, manual:true, 'action-id':dispatchId, summary:panelDispatchSummary(ticket)})
    emit({kind:edit ? 'revise+dispatch' : 'dispatch', part, messageId:sent.message_id})
  } catch (error) {
    if (!edit || !(error instanceof Exit) || error.code !== 5) throw error
    emit({kind:'revise', deferred:'dispatch-filtered', reason:error.message})
  }
}

const a = args(process.argv.slice(2))
const cmd = a._[0]
const MUTATING = ['new', 'dispatch', 'recv', 'verdict', 'watch', 'revise', 'rebuild', 'unknown', 'panel-action']
const table = { new: cmdNew, dispatch: cmdDispatch, recv: cmdRecv, verdict: cmdVerdict, watch: cmdWatch, status: cmdStatus, run: cmdRun, revise: cmdRevise, rebuild: cmdRebuild, unknown: cmdUnknown, show: cmdShow, selftest: cmdSelftest, 'panel-action': cmdPanelAction }
async function main() {
  if (!cmd || !table[cmd]) die(`用法：node bin/united.mjs <${Object.keys(table).join('|')}>`)
  // 命令可返回数字当退出码（如 rebuild --verify 有差异时返回 6）
  let _rc = 0
  if (MUTATING.includes(cmd)) _rc = withLock(() => table[cmd](a))
  else _rc = await table[cmd](a)
  if (typeof _rc === 'number' && _rc !== 0) process.exitCode = _rc
}
main().catch(e => {
  console.error('✗ ' + (e instanceof Exit ? e.message : (e && e.message) || String(e)))
  process.exitCode = e instanceof Exit ? e.code : 1
})
