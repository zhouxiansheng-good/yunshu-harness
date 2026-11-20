import { chatPlanBridge } from './chat-plan.mjs';
import { registerSessionTasks } from './session-tasks.mjs';
/**
 * 云舒联合体 · 任务台插件（服务端）0.2.0
 *
 * 看板读取绑定目录中的原任务和账本。用户操作经包内动作消费者调用
 * 联合体的 revise / dispatch 命令，纯数据目录也能独立接续原任务。
 *
 * 0.2.0 新增（YG：面板要能看到后台在干嘛，出问题自己修）：
 *   · background  —— 读 <引擎>/_report/state.json，把后台 Codex 任务搬上面板
 *   · health      —— 主动体检：通知 watcher、弹窗回执、watch 计划任务、rea 开关
 *   · problems    —— 体检异常转成「谁该修 + 怎么修」，不用人去翻日志
 *
 * 显式 config.engineDir 优先，显式路径失效时不回落其他项目。
 * 未配置时才用 YUNSHU_UNITED_HOME；同样失效即返回空。
 * 两者都未配置时才探测默认目录。
 */
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs'
import { join, resolve, isAbsolute, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { readCodingActivity } from './coding-activity.mjs'
import { consumeTaskActions as processQueuedActions, withActionLock } from './task-engine/bin/task-actions-consumer.mjs'
import { closedTaskReason, readPanelLedger, readPanelTicket } from './task-engine/bin/panel-control.mjs'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info'

/* ═══════════ 找引擎目录 ═══════════ */

function candidates(configDir) {
  // An explicit binding is a boundary, not a suggestion. No cross-project fallback.
  if (configDir !== undefined && configDir !== null) {
    return typeof configDir === 'string' && configDir.trim() && isAbsolute(configDir)
      ? [resolve(configDir)] : []
  }
  if (process.env.YUNSHU_UNITED_HOME !== undefined) {
    const envDir = process.env.YUNSHU_UNITED_HOME
    return envDir.trim() && isAbsolute(envDir) ? [resolve(envDir)] : []
  }
  const list = []
  list.push(join(homedir(), '.yunshu', 'united'))
  // 常见安装位置（群友可能就解压在这几处）
  for (const d of ['C:\\yunshu\\united', 'D:\\yunshu\\united', 'D:\\yunshu', 'C:\\yunshu']) list.push(d)
  return list.map(p => (isAbsolute(p) ? p : resolve(p)))
}

/** 一个目录像不像引擎：有 runs/ 或者 bin/united.mjs */
function looksLikeEngine(dir) {
  try {
    if (!statSync(dir).isDirectory()) return false
    return (existsSync(join(dir, 'runs')) && statSync(join(dir, 'runs')).isDirectory())
      || (existsSync(join(dir, 'bin', 'united.mjs')) && statSync(join(dir, 'bin', 'united.mjs')).isFile())
  } catch { return false }
}

export function findEngine(configDir) {
  for (const c of candidates(configDir)) {
    if (looksLikeEngine(c)) return c
  }
  return null
}

/* ═══════════ 读引擎数据（不依赖引擎代码） ═══════════ */

const rd = (p, d = null) => { try { return JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) } catch { return d } }
const md = p => { try { return statSync(p).mtimeMs } catch { return 0 } }
const txt = p => { try { return readFileSync(p, 'utf8').replace(/^\uFEFF/, '') } catch { return '' } }
const TASK_ACTIONS = new Set(['continue', 'edit-goal', 'edit-step'])
const TASK_ACTIONS_FILE = '_report/task-actions.ndjson'

function taskActionText(value, limit) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return text.length > limit ? text.slice(0, limit) : text
}

export function readTaskActions(engineDir, limit = 40) {
  const file = join(engineDir, TASK_ACTIONS_FILE)
  const body = txt(file)
  if (!body) return []
  const rows = []
  for (const line of body.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line)
      if (row && typeof row === 'object' && TASK_ACTIONS.has(row.action)) rows.push(row)
    } catch { /* 保留坏行，不让历史损坏面板 */ }
  }
  return rows.slice(-Math.max(1, Math.min(Number(limit) || 40, 200))).reverse()
}

export function consumeTaskActions(engineDir, limit = 1, target = {}) {
  const cliPath = fileURLToPath(new URL('./task-engine/bin/united.mjs', import.meta.url))
  const results = processQueuedActions(engineDir, { limit, cliPath, ...target })
  return { available: true, processed: results.length, results }
}

export function recordTaskAction(engineDir, payload = {}) {
  const action = String(payload.action || '')
  if (!TASK_ACTIONS.has(action)) return { accepted: false, error: '不支持的任务操作：' + action }
  const runId = String(payload.runId || '')
  if (!/^r-[a-zA-Z0-9-]+$/.test(runId)) return { accepted: false, error: '缺少有效的任务 runId' }
  const dir = join(engineDir, 'runs', runId)
  if (!existsSync(dir)) return { accepted: false, error: '任务不存在或已归档：' + runId }
  const state = rd(join(dir, 'state.json'), null)
  if (!state) return { accepted: false, error: '任务状态暂时不可读：' + runId }
  const requestId = payload.requestId
  if (requestId != null && !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(requestId)) {
    return { accepted: false, error: '操作标识无效' }
  }
  const row = {
    v: 1,
    id: 'ta-' + (requestId || randomUUID()),
    action,
    runId,
    at: new Date().toISOString(),
    source: 'yunshu-panel',
    status: 'queued',
  }
  if (action === 'edit-goal') {
    row.goal = taskActionText(payload.goal, 2000)
    if (!row.goal) return { accepted: false, error: '修改目标不能为空' }
  }
  if (action === 'edit-step') {
    row.stepId = taskActionText(payload.stepId, 120)
    row.stepText = taskActionText(payload.stepText, 1200)
    if (!row.stepId) return { accepted: false, error: '缺少步骤标识' }
    if (!row.stepText) return { accepted: false, error: '修改后的步骤不能为空' }
  }
  const file = join(engineDir, TASK_ACTIONS_FILE)
  mkdirSync(dirname(file), { recursive: true })
  return withActionLock(engineDir, () => {
    const prior = requestId && txt(file).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)).find(a => a.id === row.id)
    if (prior && ['runId','action','stepId','stepText','goal'].some(k => prior[k] !== row[k])) return { accepted:false, error:'同一操作标识对应不同内容' }
    const closed = closedTaskReason(state.status)
    if (!prior && closed) return { accepted:false, error:closed }
    if (!prior) appendFileSync(file, JSON.stringify(row) + '\n', 'utf8')
    const saved = prior || row
    return { accepted:true, actionId:saved.id, action, status:saved.status, at:saved.at, result:saved.result || null, error:saved.error || null }
  })
}

/** 去掉 markdown 记号，太长截断——面板上只留人能一眼看懂的部分 */
function plain(s, limit = 200) {
  if (!s) return ''
  let out = String(s)
    .replace(/\r/g, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`#>|]/g, '')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  return out.length > limit ? out.slice(0, limit) + '…' : out
}

function ago(minutes) {
  if (minutes === null || minutes === undefined) return ''
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return minutes + ' 分钟前'
  const h = Math.floor(minutes / 60)
  if (h < 24) return h + ' 小时前'
  return Math.floor(h / 24) + ' 天前'
}

/* ═══════════ 后台执行（Codex 会话） ═══════════ */

/**
 * <引擎>/_report/state.json 是 report-watcher 写的任务台账。
 * 面板只读它，不启动、不修改任何进程。
 *
 * 判定规则（评审后统一，别再多处各写一套）：
 *   · 卡住阈值只有一个来源：report-tasks.json 的 stallSeconds（默认 600 秒）
 *   · 台账本身停更（state.json 超过 3 个扫描周期没更新）时，抑制所有单任务卡住判定，
 *     只报「台账停更」——否则 watcher 一死，所有任务会一起变"卡住"，人跑去查 codex 白忙
 *   · 会话日志 mtime 与 lastActivityAt 并列，日志也停更才算真卡死
 *   · done / failed 都算出结论；failed 给错误原因，不给"完成"
 *
 * 2026-11-12 晚（YG 反馈后）：
 *   · 一个 codex 会话 = 一条「线」，线里只有最新一步，展开才看历史 → 不再平铺几十行
 *   · 已完成的默认收起；超过 DONE_KEEP 条折成「另有 N 条」
 *   · 卡住超 ARCHIVE_MINUTES 且日志也停更 = 死会话，自动归档，不再算待修（这就是"自己去修"）
 *   · _report/repair-notes.json 里登记过的问题直接判「已处理」，从待修移除并写明谁修的
 */
/**
 * Keep the 120-minute archive window: a stalled session can resume after a quiet period.
 * Archive only when the ledger is still live, task activity is at least 120 minutes old,
 * and the session log (if present) has also been quiet for at least 120 minutes.
 */
const ARCHIVE_MINUTES = 120
const DONE_KEEP = 6           // 已完成区一次显示几条

export function readBackground(engineDir, limit = 6) {
  const reportDir = join(engineDir, '_report')
  const stateFile = join(reportDir, 'state.json')
  const state = rd(stateFile, { tasks: {} }) || { tasks: {} }
  const cfg = rd(join(engineDir, 'report-tasks.json'), {}) || {}
  const notes = rd(join(reportDir, 'repair-notes.json'), {}) || {}
  const stallSeconds = Number(cfg.stallSeconds) || 600
  const fallbackSeconds = Number(cfg.fallbackScanSeconds) || 30
  const ledgerAge = md(stateFile) ? Math.round((Date.now() - md(stateFile)) / 1000) : null
  const ledgerStale = ledgerAge === null || ledgerAge > Math.max(90, fallbackSeconds * 3)
  const tasks = state.tasks || {}
  const now = Date.now()

  const rows = Object.entries(tasks).map(([id, t]) => {
    const lastAt = t.lastActivityAt ? Date.parse(t.lastActivityAt) : null
    const idle = lastAt ? Math.round((now - lastAt) / 60000) : null
    const logMtime = t.logPath ? md(t.logPath) : 0
    const logIdle = logMtime ? Math.round((now - logMtime) / 60000) : null
    const done = t.state === 'done'
    const failed = t.state === 'failed'
    const finished = done || failed
    // 两个证据都停更才算卡死；只有一个停更，另一个还在动，就是"还在写但在思考"
    const bothIdle = idle !== null && logIdle !== null
      ? (idle * 60 >= stallSeconds && logIdle * 60 >= stallSeconds)
      : (idle !== null && idle * 60 >= stallSeconds)
    const stalled = !finished && !ledgerStale && (t.state === 'stalled' || bothIdle)
    const startedMs = t.startedAt ? Date.parse(t.startedAt) : null
    const endMs = t.terminal?.at ? Date.parse(t.terminal.at) : (finished ? null : now)
    const duration = startedMs ? Math.round(((endMs || now) - startedMs) / 60000) : null
    const expected = Number(cfg.expectedSeconds) || 7200
    const overdue = !finished && startedMs ? (now - startedMs) / 1000 >= expected : false
    const note = notes[id] || null
    // 死会话：卡着、且台账与日志都很久没动 → 归档，不再打扰
    const abandoned = !finished && !note && stalled
      && idle !== null && idle >= ARCHIVE_MINUTES
      && (logIdle === null || logIdle >= ARCHIVE_MINUTES)
    const level = failed ? 'high' : stalled ? (idle !== null && idle >= 30 ? 'high' : 'mid')
      : done || note ? 'low' : (overdue ? 'mid' : 'low')

    return {
      id,
      line: 'codex',
      title: plain(t.title || id, 60),
      state: t.state || 'unknown',
      stateText: done ? '完成' : failed ? '失败'
        : note ? '已处理' : abandoned ? '已归档'
        : stalled ? '卡住' : (t.state === 'running' ? '在做' : (ledgerStale ? '台账停更' : t.state)),
      level,
      stalled,
      abandoned: Boolean(abandoned),
      resolved: note ? { by: note.by || '云舒', at: note.at || '', note: note.note || '' } : null,
      step: plain(t.step, 140),
      idleMinutes: idle,
      idleText: ago(idle),
      logIdleMinutes: logIdle,
      logIdleText: ago(logIdle),
      activitySource: logMtime && lastAt ? (logMtime > lastAt ? 'session' : 'artifact') : (logMtime ? 'session' : 'unknown'),
      startedAt: t.startedAt || '',
      lastActivityAt: t.lastActivityAt || '',
      durationMinutes: duration,
      overdue,
      result: done ? plain(t.terminal?.result, 240) : '',
      error: failed ? plain(t.terminal?.error, 240) : '',
      logPath: t.logPath || '',
    }
  })

  const byTime = (a, b) => {
    const ta = a.lastActivityAt ? Date.parse(a.lastActivityAt) : 0
    const tb = b.lastActivityAt ? Date.parse(b.lastActivityAt) : 0
    return tb - ta
  }
  const doneRows = rows.filter(x => x.state === 'done' && !x.resolved).sort(byTime)
  const archivedRows = rows.filter(x => x.abandoned || x.resolved).sort(byTime)
  // 需要你/我们看一眼的：失败、卡住、超时、在做
  const activeRows = rows
    .filter(x => !x.abandoned && !x.resolved && x.state !== 'done')
    .sort((a, b) => {
      const rank = x => (x.state === 'failed' ? 0 : x.level === 'high' ? 1 : x.stalled ? 2 : 3)
      const r = rank(a) - rank(b)
      return r !== 0 ? r : (b.idleMinutes === null ? -1 : a.idleMinutes) - (a.idleMinutes === null ? -1 : b.idleMinutes)
    })

  const summary = {
    total: rows.length,
    running: rows.filter(x => x.state === 'running' && !x.stalled && !x.abandoned).length,
    stalled: rows.filter(x => x.stalled && !x.abandoned && !x.resolved).length,
    failed: rows.filter(x => x.state === 'failed').length,
    done: doneRows.length,
    archived: archivedRows.length,
  }
  const doneVisible = doneRows.slice(0, DONE_KEEP)
  const archivedCount = archivedRows.length + Math.max(0, doneRows.length - DONE_KEEP)
  const activeVisible = limit > 0 ? activeRows.slice(0, Math.max(limit, 8)) : activeRows

  return {
    tasks: activeVisible,            // 需要关注的那些（兼容旧字段名）
    done: doneVisible,               // 已完成，默认折叠
    archived: archivedRows.slice(0, 5), // 归档预览，点开看
    hidden: rows.length - activeVisible.length - doneVisible.length,
    archivedCount,
    summary,
    ledger: { ageSeconds: ledgerAge, stale: ledgerStale, stallSeconds, archiveMinutes: ARCHIVE_MINUTES },
    at: new Date().toISOString(),
  }
}

/* ═══════════ 体检（出问题自己修） ═══════════ */

const PORT_DEFAULT = 39971

async function probeWatcher(port) {
  const startedAt = Date.now()
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/api/state', {
      signal: AbortSignal.timeout(900),
    })
    const body = await res.json()
    return {
      alive: res.ok,
      status: res.status,
      taskCount: body && typeof body === 'object' ? Object.keys(body).length : null,
      ms: Date.now() - startedAt,
    }
  } catch (error) {
    return { alive: false, status: 0, error: String(error?.message || error), ms: Date.now() - startedAt }
  }
}

function readReaSwitch() {
  const patch = join(homedir(), '.dsh', 'cordis.patch.yml')
  const body = txt(patch)
  if (!body) return { known: false, on: false, patch }
  return { known: true, on: /#\s*rea-toggle:begin/.test(body), patch }
}

function readWatchCron(engineDir) {
  const file = join(engineDir, 'logs', 'watch-cron.log')
  const body = txt(file)
  if (!body) return { known: false, file }
  const tail = body.trimEnd().split(/\r?\n/).slice(-12)
  const bad = tail.find(line => /ENOENT|Error:|错误/i.test(line))
  return {
    known: true,
    file,
    ageMinutes: Math.round((Date.now() - md(file)) / 60000),
    error: bad ? plain(bad, 160) : '',
  }
}

/**
 * 现在跑的这份服务端代码，是不是最新那份？
 * 判据不用「进程启动时间」（插件的 entry 可以被单独重启，进程不动），
 * 而是用插件自己在加载时写下的 loadedAt 跟模块 mtime 比。
 */
function readLoadState(engineDir) {
  const self = fileURLToPath(import.meta.url)
  const mtime = md(self)
  const marker = rd(join(engineDir, '_report', 'plugin-load.json'), null)
  const loadedAt = marker?.loadedAt ? Date.parse(marker.loadedAt) : null
  const stale = loadedAt === null || (mtime > 0 && mtime > loadedAt + 2000)
  return {
    module: self,
    moduleMtime: mtime ? new Date(mtime).toISOString() : null,
    loadedAt: loadedAt ? new Date(loadedAt).toISOString() : null,
    declaredVersion: marker?.version || null,
    stale,
  }
}

/** 弹过但没人确认的提醒（acks 里没有同名回执） */
function readUnacked(reportDir) {
  const outDir = join(reportDir, 'outbox')
  const ackDir = join(reportDir, 'acks')
  if (!existsSync(outDir)) return { count: 0, oldestMinutes: null }
  const acked = new Set(existsSync(ackDir)
    ? readdirSync(ackDir).filter(n => n.endsWith('.json')).map(n => n.slice(0, -5))
    : [])
  let count = 0
  let oldest = null
  for (const name of readdirSync(outDir).filter(n => n.endsWith('.json'))) {
    if (acked.has(name.slice(0, -5))) continue
    count++
    const ev = rd(join(outDir, name))
    const at = ev?.at ? Date.parse(ev.at) : null
    if (at && (oldest === null || at < oldest)) oldest = at
  }
  return { count, oldestMinutes: oldest ? Math.round((Date.now() - oldest) / 60000) : null }
}

export async function readHealth(engineDir, { engineOnly = false } = {}) {
  if (engineOnly) {
    // Isolated fixtures have no watcher. Do not probe a daily port or read ~/.dsh.
    const background = readBackground(engineDir, 0)
    return {
      checks: [{ id: 'engine-directory', label: '任务目录绑定', ok: true,
        detail: '当前目录：' + engineDir + '；隔离模式未探测日常 watcher、计划任务或 rea', owner: '云舒', fix: '' }],
      problems: [], backgroundSummary: background.summary, ledger: background.ledger,
      load: readLoadState(engineDir), externalProbes: 'not_executed', at: new Date().toISOString(),
    }
  }
  const reportDir = join(engineDir, '_report')
  const cfg = rd(join(engineDir, 'report-tasks.json'), {}) || {}
  const port = Number(cfg.httpPort) || PORT_DEFAULT

  const [watcherProbe] = await Promise.all([probeWatcher(port)])
  const popup = rd(join(reportDir, 'notification-health.json'), {}) || {}
  const rea = readReaSwitch()
  const watch = readWatchCron(engineDir)
  const background = readBackground(engineDir, 0)
  const unacked = readUnacked(reportDir)
  const load = readLoadState(engineDir)
  const selfcheck = rd(join(reportDir, 'selfcheck.json'), null)
  const selfcheckAge = selfcheck?.at ? Math.round((Date.now() - Date.parse(selfcheck.at)) / 60000) : null

  const checks = [
    {
      id: 'report-watcher',
      label: '任务提醒服务',
      ok: Boolean(watcherProbe.alive),
      detail: watcherProbe.alive
        ? `活着，${watcherProbe.ms}ms，跟 ${watcherProbe.taskCount ?? '?'} 个任务`
        : '没在跑（' + (watcherProbe.error || '连不上 ' + port) + '）',
      owner: '云舒',
      fix: 'powershell -NoProfile -ExecutionPolicy Bypass -File "' + join(engineDir, 'bin', 'run-report-watcher.ps1') + '"',
    },
    {
      id: 'watchdog',
      label: '看门狗自修',
      ok: selfcheckAge !== null && selfcheckAge <= 5,
      detail: selfcheck
        ? `${selfcheckAge} 分钟前自检 ${(selfcheck.checks || []).filter(c => c.ok).length}/${(selfcheck.checks || []).length} 正常`
          + (selfcheck.actions?.length ? `，最近一轮自修 ${selfcheck.actions.length} 次` : '，无需修')
        : '还没跑过自检',
      owner: '云舒',
      fix: 'schtasks /run /tn "Yunshu-Watchdog"',
    },
    {
      id: 'popup',
      label: '桌面弹窗',
      ok: popup.status === 'shown' || popup.status === 'dismissed' || popup.status === 'opened',
      detail: popup.status
        ? `最近一次：${popup.status}（${ago(Math.round((Date.now() - Date.parse(popup.checkedAt || 0)) / 60000))}，退出码 ${popup.exitCode ?? '?'}）`
        : '还没有回执',
      owner: '云舒',
      fix: 'node "' + join(engineDir, 'bin', 'test-report-popup.mjs') + '"',
    },
    {
      id: 'united-watch',
      label: '联合体巡检',
      ok: watch.known ? !watch.error : false,
      detail: watch.known
        ? (watch.error ? '上次有报错：' + watch.error : `正常，最后更新 ${ago(watch.ageMinutes)}`)
        : '还没有巡检日志',
      owner: '云舒',
      fix: 'schtasks /run /tn "Yunshu-United-Watch"',
    },
    {
      id: 'rea',
      label: '逆向工具 rea',
      ok: true,
      detail: !rea.known ? '读不到补丁文件' : (rea.on ? '开着（每轮多带约 29 万 token 的工具定义）' : '关着（日常省 token）'),
      owner: '云舒',
      fix: 'node "' + join(engineDir, 'bin', 'rea-toggle.mjs') + '" on|off',
    },
    {
      id: 'ledger',
      label: '任务台账新鲜度',
      ok: !background.ledger.stale,
      detail: background.ledger.ageSeconds === null
        ? '读不到 state.json'
        : (background.ledger.stale
          ? `${background.ledger.ageSeconds} 秒没更新；单任务卡住判定已暂停（否则会把 watcher 死了误判成大家都在卡）`
          : `${background.ledger.ageSeconds} 秒前更新，卡住阈值 ${background.ledger.stallSeconds} 秒`),
      owner: '云舒',
      fix: 'powershell -NoProfile -ExecutionPolicy Bypass -File "' + join(engineDir, 'bin', 'run-report-watcher.ps1') + '"',
    },
    {
      id: 'unacked',
      label: '未确认提醒',
      ok: unacked.count === 0,
      detail: unacked.count === 0
        ? '没有堆积'
        : `${unacked.count} 条弹过没确认，最老 ${ago(unacked.oldestMinutes)}`,
      owner: '云舒',
      fix: '看 "' + join(reportDir, 'acks') + '" 与 toast-attempts；一条都没点掉说明只是自动关，不代表人看到了',
    },
    {
      id: 'loaded',
      label: '面板代码是否生效',
      ok: !load.stale,
      detail: load.stale
        ? `模块 ${load.moduleMtime ? load.moduleMtime.slice(11, 19) : '?'} 改过，但插件加载于 ${load.loadedAt ? load.loadedAt.slice(11, 19) : '未知'} → 现在跑的是旧逻辑`
        : `跑的是 ${load.declaredVersion || '?'} 版，加载于 ${load.loadedAt ? load.loadedAt.slice(11, 19) : '?'}`,
      owner: '用户授权',
      fix: '面板装成 link 时可单独重启这条插件（plugin_manager set_plugin disable→enable），只有换了包或改了 package.json 才需要重启桌面端',
    },
  ]

  const problems = []
  for (const c of checks) {
    if (c.ok) continue
    problems.push({
      key: c.id, level: c.id === 'report-watcher' ? 'high' : 'mid',
      what: c.label + '：' + c.detail, owner: c.owner, fix: c.fix,
    })
  }
  for (const t of background.tasks) {
    if (t.state === 'failed') {
      problems.push({
        key: 'task-' + t.id, level: 'high',
        what: `后台任务「${t.title}」失败：${t.error || '（没写原因）'}，爬到：${t.step || '（没写步骤）'}`,
        owner: 'codex',
        fix: t.logPath ? '会话日志：' + t.logPath : '打开 Codex 会话核对失败原因后重派',
        memoryHint: t.title,
      })
      continue
    }
    if (!t.stalled) continue
    problems.push({
      key: 'task-' + t.id, level: t.level === 'high' ? 'high' : 'mid',
      what: `后台任务「${t.title}」卡住：台账 ${t.idleText}，会话日志 ${t.logIdleText || '未知'}，停在：${t.step || '（没写步骤）'}`,
      owner: 'codex',
      fix: t.logPath ? '会话日志：' + t.logPath : '打开 Codex 会话核对后决定续跑或收掉',
      memoryHint: t.title,
    })
  }
  // 大问题排在前面：一眼看到的就是要人决定的那几条
  problems.sort((a, b) => (a.level === 'high' ? 0 : 1) - (b.level === 'high' ? 0 : 1))

  return {
    checks,
    problems,
    backgroundSummary: background.summary,
    ledger: background.ledger,
    unacked,
    load,
    selfcheck: selfcheck
      ? { at: selfcheck.at, ageMinutes: selfcheckAge, actions: selfcheck.actions || [] }
      : null,
    at: new Date().toISOString(),
  }
}

/* ═══════════ 读 run（联合体） ═══════════ */

function readRun(dir, id, { codingStateDir } = {}, frames) {
  const d = join(dir, 'runs', id)
  const state = rd(join(d, 'state.json'))
  const goal = rd(join(d, 'goal.json'))
  if (!state && !goal) return null

  const taskFiles = []
  for (const sub of ['in', 'claimed']) {
    const dir2 = join(d, sub)
    if (!existsSync(dir2)) continue
    for (const f of readdirSync(dir2).filter(x => x.endsWith('.json'))) {
      const t = rd(join(dir2, f))
      if (t) taskFiles.push(t)
    }
  }
  const inbox = taskFiles
  const journaled = frames === null || frames?.some(f => f.op === 'new')
  const outbox = !journaled && existsSync(join(d, 'out'))
    ? readdirSync(join(d, 'out')).filter(f => f.endsWith('.json')).map(f => rd(join(d, 'out', f))).filter(o => o && !o.disposition)
    : []
  const external = rd(join(d, 'external.json'))
  const receipts = existsSync(join(d, 'receipts'))
    ? readdirSync(join(d, 'receipts')).filter(f => f.endsWith('.json')).length
    : 0
  const claimed = existsSync(join(d, 'claimed'))
    ? readdirSync(join(d, 'claimed')).filter(f => f.endsWith('.json')).length
    : 0

  const pending = state?.pending || {}
  const ticket = readPanelTicket(d, id, frames, {state, goal})
  const plan = ticket.plan
  const assignments = []

  const askOf = t => t?.task?.objective || t?.objective || t?.ask || ''
  const wantOf = t => {
    const dv = t?.task?.deliverables
    return Array.isArray(dv) && dv.length ? dv.join(' / ') : (t?.expected_output || '结果')
  }

  for (const [mid, v] of Object.entries(pending)) {
     if (!v || typeof v !== 'object') continue
     const task = inbox.find(t => t.id === mid)
     // Coding binding follows the original bridge's exact filename and in-before-
     // claimed precedence. Unrelated JSON with a duplicated id is not authority.
     const safeCodingIds = v.part === 'builder' && /^r-[A-Za-z0-9-]+$/.test(id)
       && /^m-[A-Za-z0-9-]+$/.test(mid) && (id + '_' + mid).length <= 80
     const canonicalFile = safeCodingIds
       ? ['in', 'claimed'].map(sub => join(d, sub, 'builder-' + mid + '.json')).find(existsSync) : null
     const codingTask = canonicalFile ? rd(canonicalFile) : null
    const got = journaled ? ticket.receiptFor(mid) : outbox.find(o => o.parent_id === mid && o.from === v.part && v.status === 'settled')
    const late = v.status === 'outcome_unknown' || v.status === 'late' || v.status === 'settled'
    assignments.push({
      message: mid,
      who: task?.to || v.part || '未知',
      role: task?.to || 'unknown',
      ask: plain(askOf(task) || v.objective || '（这张单没写要求）', 160),
      sentObjective: askOf(task) || v.objective || '',
      sentContext: task?.context?.summary || '',
      nextInstruction: plan?.steps.get(mid) || '',
      want: wantOf(task),
      state: got ? 'done' : (late ? 'late' : 'open'),
      stateText: got ? '已交回' : (v.status === 'settled' ? '回执缺失，待对账' : (late ? '回执待核对' : task && existsSync(join(d, 'claimed', v.part + '-' + mid + '.json')) ? '已领取' : '已派发，待交回')),
      dispatchedAt: v.dispatched_at || task?.at || '',
      deadline: v.deadline_at || '',
      got: got ? plain(got.statement || got.claim?.statement, 140) : '',
      external: false,
      ...(v.part === 'builder' && codingStateDir != null ? { codingActivity: readCodingActivity(codingStateDir,
        { runId: id, messageId: mid, goalId: state.goal_id, goalRev: state.goal_rev, part: v.part,
           phase: state.run_id === id && codingTask?.id === mid && codingTask?.kind === 'task'
             && codingTask?.run_id === id && codingTask?.to === v.part
             && codingTask?.goal_id === state.goal_id && codingTask?.goal_rev === state.goal_rev ? codingTask.phase : null }) } : {}),
    })
  }

  for (const o of outbox) {
    const mid = o.parent_id || o.message_id || o.id
    if (assignments.some(a => a.message === mid)) continue
    assignments.push({
      message: mid, who: o.from || o.part || '未知', role: o.from || 'unknown',
      ask: o.statement ? plain(o.statement, 100) : '（历史记录）', want: '结果',
      state: 'done', stateText: '已交回', dispatchedAt: o.at || '',
      got: o.statement ? plain(o.statement, 140) : '', external: false,
    })
  }

  for (const x of (external?.items || [])) {
    assignments.push({
      message: x.task_id, who: '外部程序', role: 'external',
      ask: x.title + (x.what ? '：' + x.what : ''), want: '结果',
      state: x.state === 'running' ? 'open' : (x.state === 'done' ? 'done' : 'late'),
      stateText: x.stateText, dispatchedAt: x.startedAt || '',
      got: x.recent?.[0]?.file ? '刚动过：' + x.recent[0].file : '',
      external: true,
    })
  }

  const open = assignments.filter(a => a.state === 'open').length
  const late = assignments.filter(a => a.state === 'late').length
  const done = assignments.filter(a => a.state === 'done').length

  return {
    id,
    goal: plan?.goal || goal?.goal || state?.goal || '（没有标题）',
    accept: goal?.accept || '',
    status: state?.status || 'unknown',
    continuation: ticket.continuation,
    verdict: state?.status === 'done' ? '已完成' : state?.status === 'blocked' ? '有阻塞'
      : state?.status === 'disputed' ? '有争议' : open > 0 ? '在做'
      : late > 0 ? '有卡住的' : done > 0 ? '待裁决' : '还没派活',
    turn: state?.watermark?.turn ?? 0,
    assignments,
    counts: { open, late, done, total: assignments.length, receipts, claimed },
    updatedAt: new Date(Math.max(md(join(d, 'state.json')), md(join(d, 'external.json')))).toISOString(),
  }
}

export function readBoard(engineDir, limit = 20, options = {}) {
  const runsDir = join(engineDir, 'runs')
  if (!existsSync(runsDir)) {
    return { tasks: [], summary: { runs: 0, assigned: 0, working: 0, attention: 0, done: 0 }, headline: '引擎装好了，但还没有任务记录。' }
  }
  const ids = readdirSync(runsDir)
    // runs/.instinct 是本能路由的记录目录，不是 run
    .filter(d => !d.startsWith('.'))
    .filter(d => { try { return statSync(join(runsDir, d)).isDirectory() } catch { return false } })
    .sort((a, b) => md(join(runsDir, b)) - md(join(runsDir, a)))
    .slice(0, limit)

  const ledger = ids.length ? readPanelLedger(engineDir) : null
  const tasks = ids.map(id => readRun(engineDir, id, options, ledger?.framesOf(id) ?? null)).filter(Boolean)
  const summary = {
    runs: tasks.length,
    assigned: tasks.reduce((a, t) => a + t.counts.total, 0),
    working: tasks.reduce((a, t) => a + t.counts.open, 0),
    attention: tasks.reduce((a, t) => a + t.counts.late, 0),
    done: tasks.reduce((a, t) => a + t.counts.done, 0),
  }
  let headline
  if (!tasks.length) headline = '引擎装好了，但还没有任务记录。'
  else if (summary.attention > 0) headline = `${summary.attention} 件事卡住了，需要看一眼`
  else if (summary.working > 0) headline = `${summary.working} 件事正在做`
  else if (summary.done > 0 && tasks.every(t => t.status === 'done')) headline = `都办完了（共 ${summary.done} 件）`
  else if (summary.done > 0) headline = `${summary.done} 条回执待裁决`
  else headline = '还没有派活'

  return { tasks, summary, headline, engineDir, at: new Date().toISOString() }
}

/* ═══════════ 归线：一条工作线＝一个话题的全部条目 ═══════════
 * YG 2026-11-12：「同一种任务的内容放在一个对话逻辑里，作为分对话排序下来」。
 * 判据链按顺序命中即停：规则文件 → id slug → 标题关键词 → 兜底单条。
 * 规则放 <引擎>/_report/line-rules.json，改分组不用改插件。
 */

function readLineRules(engineDir) {
  const fallback = { version: 0, rules: [], ignoreTitlePatterns: [], stopWords: [], doneKeepPerLine: 2 }
  const rules = rd(join(engineDir, '_report', 'line-rules.json'), fallback)
  return rules && Array.isArray(rules.rules) ? rules : fallback
}

function isSettled(entry) {
  return entry.state === 'done' || Boolean(entry.resolved)
}

function levelRank(level) {
  return level === 'critical' ? 0 : level === 'high' ? 1 : level === 'mid' || level === 'major' ? 2 : 3
}

/**
 * 把后台任务和联合体 run 归成「线」。
 * 纯读，不改任何文件；每次调用都重新读规则，改规则立即生效。
 */
export function buildLines(engineDir, { includeRuns = false } = {}) {
  const rules = readLineRules(engineDir)
  const badPatterns = (rules.ignoreTitlePatterns || []).map(p => { try { return new RegExp(p) } catch { return null } }).filter(Boolean)
  const bg = readBackground(engineDir, 0)
  const board = includeRuns ? readBoard(engineDir, 20) : { tasks: [] }

  const entries = []
  for (const t of [...bg.tasks, ...bg.done, ...(bg.archived || [])]) {
    entries.push({
      id: 'bg:' + t.id,
      source: 'background',
      ref: t.id,
      title: t.title,
      state: t.state,
      stateText: t.stateText,
      level: t.level || 'low',
      stalled: Boolean(t.stalled),
      resolved: t.resolved || null,
      badTitle: badPatterns.some(re => re.test(t.title || '')),
      summary: t.error || t.result || t.step || '',
      at: t.lastActivityAt || t.startedAt || '',
      idleMinutes: t.idleMinutes,
      logPath: t.logPath || '',
    })
  }
  for (const r of board.tasks) {
    entries.push({
      id: 'run:' + r.id,
      source: 'run',
      ref: r.id,
      title: r.goal,
      state: r.status,
      stateText: r.verdict,
      level: r.counts.late > 0 ? 'high' : 'low',
      stalled: false,
      resolved: null,
      badTitle: false,
      summary: `在干 ${r.counts.open} / 卡住 ${r.counts.late} / 完成 ${r.counts.done}`,
      at: r.updatedAt || '',
      idleMinutes: null,
    })
  }

  const matchRule = entry => {
    for (const rule of rules.rules) {
      if ((rule.idAny || []).some(x => String(entry.ref).includes(x))) return rule
      if ((rule.titleAny || []).some(x => String(entry.title).includes(x))) return rule
      if ((rule.pathAny || []).some(x => String(entry.logPath || '').includes(x))) return rule
    }
    return null
  }

  const groups = new Map()
  const byTitle = new Map()   // 标题完全相同 → 同一条线（同一次任务重试/续跑）
  for (const entry of entries) {
    const rule = entry.badTitle ? null : matchRule(entry)
    let key = rule ? 'line:' + rule.id : byTitle.get(entry.title)
    if (!key) key = rule ? 'line:' + rule.id : 'solo:' + entry.id
    let group = groups.get(key)
    if (!group) {
      group = {
        id: key,
        title: rule ? rule.title : entry.title.slice(0, 40),
        groupedBy: rule ? 'rule:' + rule.id : (entry.badTitle ? 'bad-title' : 'title'),
        entries: [],
      }
      groups.set(key, group)
      if (!rule && !byTitle.has(entry.title)) byTitle.set(entry.title, key)
    }
    group.entries.push(entry)
  }

  const lines = [...groups.values()].map(group => {
    const open = group.entries.filter(e => !isSettled(e))
    const settled = group.entries.filter(isSettled)
    open.sort((a, b) => levelRank(a.level) - levelRank(b.level))
    settled.sort((a, b) => String(b.at).localeCompare(String(a.at)))
    const level = group.entries.some(e => e.level === 'critical') ? 'critical'
      : group.entries.some(e => e.level === 'high') ? 'high'
      : group.entries.some(e => e.level === 'mid') ? 'mid' : 'low'
    const stalledLong = open.some(e => e.stalled && (e.idleMinutes ?? 0) >= 30)
    const lastAt = group.entries.map(e => e.at).filter(Boolean).sort().pop() || ''
    return {
      id: group.id,
      title: group.title,
      groupedBy: group.groupedBy,
      level,
      needsYou: Boolean(open.some(e => e.level === 'high' && (e.stalled || e.state === 'failed'))) || (level === 'high' && stalledLong),
      state: open.length ? 'open' : 'settled',
      entries: [...open, ...settled].slice(0, 6),
      hidden: Math.max(0, group.entries.length - 6),
      counts: { total: group.entries.length, open: open.length, settled: settled.length },
      lastAt,
    }
  })

  lines.sort((a, b) => {
    if (a.needsYou !== b.needsYou) return a.needsYou ? -1 : 1
    const r = levelRank(a.level) - levelRank(b.level)
    if (r !== 0) return r
    return String(b.lastAt).localeCompare(String(a.lastAt))
  })

  const counts = {
    lines: lines.length,
    open: lines.filter(l => l.state === 'open').length,
    settled: lines.filter(l => l.state === 'settled').length,
    needsYou: lines.filter(l => l.needsYou).length,
    entries: entries.length,
    ungrouped: lines.filter(l => l.groupedBy === 'solo' || l.groupedBy === 'bad-title').length,
  }
  return { v: 2, lines, counts, rulesVersion: rules.version || 0, at: new Date().toISOString() }
}

/* ═══════════ DSH 遥控服务 ═══════════ */

const PLUGIN_VERSION = '0.2.1-preview.8'

const json = z.custom(v => z.json().safeParse(v).success, { message: 'Invalid JSON' })

const codec = (type, schema, jsonSchema) => ({
  mode: 'strict',
  typeSymbol: '@yunshu/yunshuUnited#' + type,
  create: () => schema,
  jsonSchema,
})

const parameter = (name, schema, jsonSchema, extras = {}) => {
  const c = codec(name, schema, jsonSchema)
  if (extras.source === 'lookup') c.typeSymbol = '@deepseek-ai/dsh-session/types#SessionId'
  return { name, source: 'json', codec: c, strictCodec: c, ...extras }
}

export const remoteInfo = createTypertRemoteInfo({
  package: '@yunshu/dsh-united',
  methods: {
    'yunshuUnited/request': {
      service: 'yunshuUnited',
      description: '联合体任务台操作',
      invocation: { kind: 'direct' },
      parameters: [
        parameter('agent', z.string(), { type: 'string' }, { wire: 'agentId', source: 'lookup', lookup: 'agent' }),
        parameter('action', z.string(), { type: 'string' }),
        parameter('payload', json, {}),
      ],
      cancellation: { parameter: 'signal' },
      result: codec('result', json, {}),
      sourceLocation: { file: 'packages/yunshu-united-plugin/index.mjs', line: 1, column: 1 },
    },
  },
}, z)

/** 包级插件入口：DSH 的 loader 只认 apply（直接导出一个 Service 类不会被当成插件加载） */
export const name = 'yunshu-united'
export const inject = ['typert']

/**
 * 把 Host 侧 Remote 描述注册进 typert。少了这一步，网关查不到 endpoint，
 * 浏览器调用会得到 `transport failure for /api/yunshuUnited/request`。
 * 抽成导出函数是为了能单独测（不需要真 Cordis 上下文）。
 */
export function registerHost(ctx, info = remoteInfo) {
  ctx.typert.register({
    package: info.package,
    face: 'host',
    schemas: [],
    invocations: info.descriptors,
    model: { services: [], events: [], objects: [] },
  })
}

export function apply(ctx, config = {}) {
  ctx.plugin(YunshuUnited, config)
}

export default class YunshuUnited extends TypertRemoteService {
  static inject = ['typert','sessionProjections','sessionQuery']

  constructor(ctx, config = {}) {
    super(ctx, 'yunshuUnited')
    this.ctx = ctx
    this.config = config
    this.engineConfigDir = config.engineDir ?? null
    this.lastEngine = null
    registerHost(ctx)
    this.sessionTasks = registerSessionTasks(ctx,()=>this.engine());
    this.chatPlans=chatPlanBridge(this.sessionTasks);
    // 启动即定位一次引擎：顺便把「这一版代码何时被加载」写进台账，外部脚本不用猜
    try { this.engine() } catch {}
  }

  /** 每次调用都重新找引擎 —— 这样换引擎目录不用重启插件 */
  engine() {
    const found = findEngine(this.engineConfigDir)
    if (found !== this.lastEngine) {
      this.lastEngine = found
      ctx_log(this.ctx, found ? '引擎目录: ' + found : '没找到引擎目录')
      this.announce(found)
    }
    return found
  }

  /** 把「这一版服务端代码什么时候被加载的」写进台账目录，外部脚本不用猜就知道跑的是哪版 */
  announce(engineDir) {
    if (this.announced || !engineDir) return
    this.announced = true
    try {
      const file = join(engineDir, '_report', 'plugin-load.json')
      const body = {
        package: '@yunshu/dsh-united',
        version: PLUGIN_VERSION,
        loadedAt: new Date().toISOString(),
        processStartedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
        pid: process.pid,
      }
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(body, null, 2) + '\n', 'utf8')
    } catch {}
  }

  coordinating(agent) { return this.chatPlans.ownsTurn(agent.session); }
  async planFromChat(agent,payload,signal) {
    return this.chatPlans.fromChat(this.engine(),agent,payload,signal);
  }
  async routeFromChat(agent,payload,signal) {
    this.chatPlans.claimTurn(agent.session);
    return (await this.sessionTasks).route(this.engine(),agent,payload,signal);
  }
  async request(agent, action, payload = {}, signal) {
    signal?.throwIfAborted?.()

    if(this.ctx.get('yunshuControl')?.enabled('tasks')===false) throw Error('任务台已关闭，可在功能开关中启用。');
    if (action==='channels' || action==='channel-edit') {
      const control=this.ctx.get('yunshuControl');
      if (!control?.directory) throw Error('云舒能力目录未连接。');
      if (action==='channel-edit') control.editDirectory(payload,signal);
      return control.directory.snapshot(agent,control,payload.refresh===true);
    }
    if (action === 'engine') {
      const e = this.engine()
      return { engineDir: e, ok: Boolean(e) }
    }

    if (['board','task-action','session-task'].includes(action) && this.config.sharedTickets !== true) {
      const service = await this.sessionTasks;
      const engine = this.engine();
      if (action==='session-task' && payload.action==='create' && payload.draftId) return this.chatPlans.createEdited(engine,agent,payload,signal);
      if (action === 'session-task') return service.action(engine,agent,payload.action,payload,signal);
      const selected = service.scope(engine,agent.session);
      if (action === 'task-action') throw Error('请在当前会话操作原任务。');
      return service.describe(engine,agent,{...readBoard(selected,Number(payload.limit)||100),
        chatPlan:this.chatPlans.view(selected),background:{tasks:[],summary:{}},lines:{lines:[]},actions:[]});
    }
    if (action === 'board') {
      const e = this.engine()
      if (!e) {
        return {
          tasks: [],
          summary: { runs: 0, assigned: 0, working: 0, attention: 0, done: 0 },
          headline: '没找到引擎目录。装好引擎后在插件设置里填路径。',
          background: { tasks: [], summary: { total: 0, running: 0, stalled: 0, done: 0 } },
          actions: [],
          engineDir: null,
          at: new Date().toISOString(),
        }
      }
      const board = readBoard(e, Number(payload.limit) || 20, { codingStateDir: this.config.codingStateDir })
      const background = readBackground(e, Number(payload.backgroundLimit) || 6)
      const lines = buildLines(e, { includeRuns: payload.includeRuns === true })
      return { ...board, background, lines, actions: readTaskActions(e, Number(payload.actionLimit) || 40) }
    }

    if (action === 'task-action') {
      const e = this.engine()
      if (!e) return { accepted: false, error: '没找到引擎目录' }
      const queued = recordTaskAction(e, payload)
      if (!queued.accepted || queued.status !== 'queued') return queued
      try {
        const consumer = consumeTaskActions(e, 200, { runId: payload.runId, untilActionId: queued.actionId })
        const receipt = consumer.results.find(row => row.actionId === queued.actionId)
        return { ...queued, ...receipt }
      } catch (error) {
        return { ...queued, error: error.message }
      }
    }

    if (action === 'health') {
      const e = this.engine()
      if (!e) return { checks: [], problems: [{ key: 'engine', level: 'high', what: '没找到引擎目录', owner: '云舒', fix: '在插件设置里填 engineDir' }], at: new Date().toISOString() }
      return await readHealth(e, { engineOnly: this.config.healthMode === 'engine-only' })
    }

    return { error: 'unknown action: ' + String(action) }
  }
}

function ctx_log(ctx, msg) {
  try { ctx?.logger?.info?.('[yunshu-united] ' + msg) } catch {}
}
