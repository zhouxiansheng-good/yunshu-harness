import { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { HEALTH_CHECKS, HEALTH_TTL_MS, countHealth } from './model.mjs'

function result(id, state, reason, evidence, extras = {}) {
  return { id, label: HEALTH_CHECKS[id].label, state, reason, evidence,
    checkedAt: new Date().toISOString(), staleAfterMs: HEALTH_TTL_MS, ...extras }
}

function withDb(path, id, fn) {
  if (!existsSync(path)) return result(id, 'unknown', '数据库不存在，尚未验证', path)
  let db
  try {
    db = new DatabaseSync(path, { readOnly: true })
    db.exec('PRAGMA query_only = ON')
    return fn(db)
  } catch (error) {
    return result(id, 'warn', '数据库只读探针失败', path + ': ' + (error.code || error.name))
  } finally {
    db?.close()
  }
}

export function memoryProbe(config) {
  return withDb(config.memoryDb, 'memory', db => {
    const row = db.prepare('SELECT COUNT(*) AS n, MAX(timestamp) AS lastAt FROM conversation_rounds').get()
    if (!row.lastAt) return result('memory', 'unknown', '数据库可读，尚无会话轮次写入', config.memoryDb + ': conversation_rounds=' + row.n)
    return result('memory', 'unknown', '存储可读；相关召回与回答采用尚未验证',
      config.memoryDb + ': conversation_rounds=' + row.n + ', MAX(timestamp)=' + row.lastAt,
      { facets: { storage: 'ok', retrieval: 'unknown', answerUse: 'unknown' },
        metrics: { rounds: row.n, lastWriteAt: row.lastAt } })
  })
}

export function personaProbe(config) {
  return withDb(config.identityDb, 'persona', db => {
    const row = db.prepare('SELECT state, touched FROM yunshu_affect_sessions ORDER BY touched DESC LIMIT 1').get()
    if (!row) return result('persona', 'unknown', '没有情感会话记录，检测器未验证', config.identityDb + ': yunshu_affect_sessions=0')
    const strength = Number(JSON.parse(row.state)?.strength)
    const touchedAt = new Date(Number(row.touched)).toISOString()
    if (!Number.isFinite(strength) || strength < 0) return result('persona', 'warn', '最近一次情感强度不可解析', config.identityDb + ': touched=' + touchedAt)
    return result('persona', 'unknown',
      strength === 0 ? '存储可读；当前无情绪信号，检测链路尚未验证' : '存储可读；已有情绪信号，检测链路尚未验证',
      config.identityDb + ': yunshu_affect_sessions.touched=' + touchedAt + ', strength=' + strength,
      { facets: { storage: 'ok', detection: 'unknown', profileRoundtrip: 'unknown' },
        metrics: { strength, touchedAt } })
  })
}

export function mediaProbe(config) {
  if (config.mediaEnabled === false) {
    return result('media', 'idle', '当前配置已关闭媒体附件', 'persona.media=false',
      { facets: { availability: 'disabled' } })
  }
  return withDb(config.memoryDb, 'media', db => {
    const jobs = db.prepare('SELECT state, COUNT(*) AS n FROM yunshu_media_jobs GROUP BY state').all()
    const refs = db.prepare('SELECT COUNT(*) AS n FROM yunshu_media_refs').get().n
    const detail = jobs.map(x => x.state + '=' + x.n).join(', ') || '无任务'
    // 索引存在不等于附件上传、读取和面板显示都通过。
    return result('media', 'unknown', '仅核对媒体索引；附件读写与面板尚未实测',
      config.memoryDb + ': media_jobs(' + detail + '), media_refs=' + refs)
  })
}

export function taskProbe(config) {
  if (!config.engineDir) return result('task', 'unknown', '当前 profile 未配置联合体台账', '未配置 engineDir')
  const statePath = join(config.engineDir, '_report', 'state.json')
  const runsPath = join(config.engineDir, 'runs')
  const evidence = statePath + '; ' + runsPath
  try {
    if (!existsSync(runsPath)) return result('task', 'unknown', '联合体 runs 目录缺失，尚未验证', evidence)
    // Manual runs do not need the optional background scheduler's _report ledger.
    // O(number of run states), read-only; never infer execution success or replay work.
    const runStatuses = Object.create(null)
    let runs = 0
    for (const entry of readdirSync(runsPath, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const runPath = join(runsPath, entry.name, 'state.json')
      if (!existsSync(runPath)) continue
      const run = JSON.parse(readFileSync(runPath, 'utf8').replace(/^\uFEFF/, ''))
      if (!run || typeof run !== 'object' || Array.isArray(run) || typeof run.status !== 'string' || !run.status.trim()) {
        throw new Error('runs/' + entry.name + '/state.json: status 缺失或无效')
      }
      runs++
      runStatuses[run.status] = (runStatuses[run.status] || 0) + 1
    }
    if (!existsSync(statePath)) {
      return result('task', 'unknown',
        (runs ? '联合体任务记录可读（' + runs + ' 条）' : '联合体目录可读，尚无任务记录') + '；未启用后台任务台账，执行与回执仍须核验',
        runsPath + ': runs=' + runs + '; ' + statePath + ': 未配置后台任务台账',
        { facets: { storage: 'ok', execution: 'unknown', background: 'not-configured' }, metrics: { runs, runStatuses: { ...runStatuses } } })
    }
    const state = JSON.parse(readFileSync(statePath, 'utf8').replace(/^\uFEFF/, ''))
    if (!state || typeof state !== 'object' || Array.isArray(state) || !state.tasks || typeof state.tasks !== 'object') {
      throw new Error('state.tasks 不是任务集合')
    }
    const taskCount = Array.isArray(state.tasks) ? state.tasks.length : Object.keys(state.tasks).length
    const updated = statSync(statePath).mtime
    const updatedAt = updated.toISOString()
    // Only the background scheduler ledger has a scan cadence. A completed
    // manual run need not keep rewriting its state to remain readable.
    const schedulePath = join(config.engineDir, 'report-tasks.json')
    const schedule = existsSync(schedulePath) ? JSON.parse(readFileSync(schedulePath, 'utf8').replace(/^\uFEFF/, '')) : {}
    const scanSeconds = Number(schedule.fallbackScanSeconds)
    const maxAgeSeconds = Math.max(90, Number.isFinite(scanSeconds) && scanSeconds > 0 ? scanSeconds * 3 : 90)
    const ageSeconds = Math.max(0, Math.floor((Date.now() - updated.getTime()) / 1000))
    const stale = ageSeconds > maxAgeSeconds
    return result('task', stale ? 'warn' : 'ok',
      stale ? '台账停更；任务现状待对账' : '后台台账新鲜可解析；联合体 runs ' + runs + ' 条',
      statePath + ': tasks=' + taskCount + ', runs=' + runs + ', ageSeconds=' + ageSeconds + ', mtime=' + updatedAt,
      { facets: { storage: 'ok', execution: 'unknown', background: stale ? 'warn' : 'ok' },
        metrics: { runs, runStatuses: { ...runStatuses }, tasks: taskCount, ageSeconds, maxAgeSeconds } })
  } catch (error) {
    return result('task', 'warn', '任务台台账解析失败', evidence + ': ' + error.message)
  }
}

export function voiceProbe() {
  return result('voice', 'unknown', '需要麦克风试听，尚无人工验收', 'docs/修单-语音面板一点就消失-20261112.md: 点击断言只验证抽屉留存')
}

export function deepProbe(config) {
  return result('deep', 'unknown', '模式切换前后能力未在浏览器实测',
    (config.craftClient || '当前 profile 未配置深度模式') + (config.craftClient && existsSync(config.craftClient) ? ': ModeChip 已注册，功能未实测' : ': 未找到入口'))
}

export function collect(config) {
  const startedAt = new Date().toISOString()
  const checks = [memoryProbe(config), personaProbe(config), mediaProbe(config), taskProbe(config), voiceProbe(), deepProbe(config)]
  const counts = countHealth(checks)
  const runId = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').replace('Z', '')
  const profileId = config.profileId || resolve(process.env.DSH_HOME || join(homedir(), '.dsh'))
  return { schemaVersion: 1, profileId, runId, startedAt, finishedAt: new Date().toISOString(), counts, checks }
}
