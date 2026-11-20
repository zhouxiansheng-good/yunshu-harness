#!/usr/bin/env node
/**
 * 云舒联合体 · 面板任务动作消费者
 *
 * 面板只负责把用户动作写入 _report/task-actions.ndjson；本进程负责把动作
 * 转换成联合体已有的 revise / dispatch 命令。所有实际状态变化仍由 united.mjs
 * 的全局锁、V2 账本和 reducer 维护。
 */
import {
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const defaultEngine = resolve(here, '..')
const ACTION_FILE = join('_report', 'task-actions.ndjson')
const ACTION_LOCK = join('_report', 'task-actions.lock')
const RESULT_DIR = join('_report', 'task-action-results')

const now = () => new Date().toISOString()
const text = (value, limit = 4000) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit)
const rowsFrom = (file) => {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).flatMap(line => {
    try {
      const row = JSON.parse(line)
      return row && typeof row === 'object' && row.id ? [row] : []
    } catch { return [] }
  })
}
const atomicJson = (file, value) => {
  mkdirSync(dirname(file), { recursive: true })
  const temp = file + '.tmp-' + process.pid
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  renameSync(temp, file)
}

const atomicText = (file, value) => {
  mkdirSync(dirname(file), { recursive: true })
  const temp = file + '.tmp-' + process.pid
  writeFileSync(temp, value, 'utf8')
  renameSync(temp, file)
}

export function withActionLock(engineDir, fn) {
  const report = join(engineDir, '_report')
  mkdirSync(report, { recursive: true })
  const lock = join(engineDir, ACTION_LOCK)
  let fd
  try { fd = openSync(lock, 'wx') } catch { throw new Error('任务动作队列正在被其他消费者处理') }
  try { return fn() } finally {
    try { closeSync(fd) } catch {}
    try { unlinkSync(lock) } catch {}
  }
}

function actionFile(engineDir) { return join(engineDir, ACTION_FILE) }
function resultFile(engineDir, actionId) { return join(engineDir, RESULT_DIR, actionId + '.json') }

function updateAction(engineDir, actionId, patch) {
  return withActionLock(engineDir, () => {
    const file = actionFile(engineDir)
    const rows = rowsFrom(file)
    let found = false
    const next = rows.map(row => {
      if (row.id !== actionId) return row
      found = true
      return { ...row, ...patch }
    })
    if (found) atomicText(file, next.map(row => JSON.stringify(row)).join('\n') + '\n')
    return found
  })
}

function claimNext(engineDir, retryProcessingMinutes, runId) {
  return withActionLock(engineDir, () => {
    const file = actionFile(engineDir)
    const rows = rowsFrom(file)
    const cutoff = Date.now() - Math.max(1, retryProcessingMinutes) * 60000
    const index = rows.findIndex(row => {
      if (runId && row.runId !== runId) return false
      if (row.status === 'queued') return true
      if (row.status !== 'processing') return false
      const started = Date.parse(row.processingAt || row.at || '')
      return Number.isFinite(started) && started < cutoff
    })
    if (index < 0) return null
    const old = rows[index]
    const claimed = {
      ...old,
      status: 'processing',
      processingAt: now(),
      attempts: Number(old.attempts || 0) + 1,
    }
    rows[index] = claimed
    atomicText(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
    return claimed
  })
}

function envFor(engineDir) {
  return {
    ...process.env,
    UNITED_RUNS_DIR: join(engineDir, 'runs'),
    UNITED_LEDGER: join(engineDir, 'ledger.ndjson'),
    UNITED_LEDGER_V2: join(engineDir, 'ledger-v2.ndjson'),
  }
}

export function runUnited(engineDir, args, cliPath, input) {
  const cli = cliPath || join(engineDir, 'bin', 'united.mjs')
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: engineDir,
    env: { ...envFor(engineDir), ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true,
    encoding: 'utf8',
    input,
    maxBuffer: 2 * 1024 * 1024,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error([result.stdout, result.stderr].filter(Boolean).join('\n').trim() || `united.mjs 退出码 ${result.status}`)
  return (result.stdout || '').trim()
}

function processAction(engineDir, action, cliPath) {
  const output = runUnited(engineDir, ['panel-action', '--run', action.runId], cliPath, JSON.stringify(action))
  const lines = output.split(/\r?\n/)
  const result = JSON.parse(lines.pop())
  return { ...result, output:lines.join('\n') }
}

export function consumeTaskActions(engineDir = defaultEngine, options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit) || 20, 200))
  const retryProcessingMinutes = Number(options.retryProcessingMinutes) || 10
  const cliPath = options.cliPath || null
  const results = []
  for (let i = 0; i < limit; i++) {
    const action = claimNext(engineDir, retryProcessingMinutes, options.runId)
    if (!action) break
    try {
      const result = processAction(engineDir, action, cliPath)
      const finishedAt = now()
      updateAction(engineDir, action.id, {
        status: 'processed', processedAt: finishedAt, result: { ...result, at: finishedAt }, error: null,
      })
      atomicJson(resultFile(engineDir, action.id), { actionId: action.id, status: 'processed', at: finishedAt, result })
      results.push({ actionId: action.id, status: 'processed', result })
    } catch (error) {
      const failedAt = now()
      const message = text(error?.message || error, 2000)
      updateAction(engineDir, action.id, { status: 'failed', processedAt: failedAt, error: message })
      atomicJson(resultFile(engineDir, action.id), { actionId: action.id, status: 'failed', at: failedAt, error: message })
      results.push({ actionId: action.id, status: 'failed', error: message })
    }
    if (options.untilActionId === action.id) break
  }
  return results
}

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) { out._.push(token); continue }
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) out[key] = true
    else out[key] = argv[++i]
  }
  return out
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const args = parseArgs(process.argv.slice(2))
  const engine = resolve(args.engine || process.env.YUNSHU_UNITED_HOME || defaultEngine)
  const results = consumeTaskActions(engine, {
    limit: args.limit,
    retryProcessingMinutes: args['retry-processing-minutes'],
    cliPath: args.cli,
  })
  console.log(JSON.stringify({ engine, processed: results.length, results }, null, 2))
  process.exitCode = results.some(x => x.status === 'failed') ? 1 : 0
}

