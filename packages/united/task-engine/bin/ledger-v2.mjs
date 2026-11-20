/**
 * ledger-v2 —— 联合体的权威提交流（M3，按 codex 裁决第 3 节）
 *
 * 与旧 ledger.ndjson 的区别：
 *   - 旧：事后追加的「摘要审计」，写不进去不影响主流程
 *   - 新：先提交的「事实源」，帧校验通过才写投影（state/in/out/decisions）
 *
 * 每帧字段（都是重放所必需的，不允许只存文件路径）：
 *   seq        全局单调递增，从 1 开始
 *   run_id     所属 run
 *   op_id      幂等键（调用方给或自动生成）
 *   req_digest 规范化请求摘要（sha256）
 *   op         操作类型 new|dispatch|recv|revise|verdict|watch|filtered|rejected
 *   payload    完整载荷（重放靠它，不靠读文件）
 *   at         确定的时间戳（入帧，重放不重新取时钟）
 *   prev_hash  上一帧 hash（链）
 *   hash       本帧 hash = sha256(prev_hash + 规范化正文)
 *   receipt    同帧回执
 *
 * 零第三方依赖，只用 node 标准库。
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync, openSync, fsyncSync, closeSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'

export class LedgerError extends Error {
  constructor(code, msg, extra = {}) {
    super(msg)
    this.code = code
    Object.assign(this, extra)
  }
}

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex')
export const digestRequest = (obj) => sha(canonical(obj))

/** 规范化：键排序 + 稳定序列化，保证同内容同摘要 */
export function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  // Match JSON.stringify: object properties with undefined disappear; array slots become null.
  if (Array.isArray(v)) return '[' + v.map(x => canonical(x === undefined ? null : x)).join(',') + ']'
  const keys = Object.keys(v).filter(k => v[k] !== undefined).sort()
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}'
}

export class LedgerV2 {
  /**
   * @param {string} file  ledger-v2.ndjson 的绝对路径
   */
  constructor(file) {
    this.file = file
    this.dir = dirname(file)
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
    this.frames = []
    this._load()
  }

  _load() {
    if (!existsSync(this.file)) { this.frames = []; return }
    const text = readFileSync(this.file, 'utf8')
    if (text.length === 0) { this.frames = []; return }
    const lines = text.split('\n')
    // 最后一行可能不带换行（正常）；末尾空串丢弃
    while (lines.length && lines[lines.length - 1] === '') lines.pop()
    const frames = []
    let prev = ''
    for (let i = 0; i < lines.length; i++) {
      let f
      try { f = JSON.parse(lines[i]) } catch (e) {
        throw new LedgerError('LOG_CORRUPT', `第 ${i + 1} 帧不是合法 JSON（位置 ${this.file}:${i + 1}）`, { line: i + 1 })
      }
      if (f.seq !== i + 1) {
        throw new LedgerError('LOG_CORRUPT', `第 ${i + 1} 帧 seq=${f.seq} 不连续`, { line: i + 1, got: f.seq, want: i + 1 })
      }
      if (f.prev_hash !== prev) {
        throw new LedgerError('LOG_CORRUPT', `第 ${i + 1} 帧 prev_hash 断链`, { line: i + 1, got: f.prev_hash, want: prev })
      }
      const body = this._bodyOf(f)
      if (sha(prev + canonical(body)) !== f.hash) {
        throw new LedgerError('LOG_CORRUPT', `第 ${i + 1} 帧自身 hash 不匹配（被篡改）`, { line: i + 1 })
      }
      prev = f.hash
      frames.push(f)
    }
    this.frames = frames
  }

  _bodyOf(f) {
    // hash 覆盖除 hash 自身外的全部字段
    const { hash, ...rest } = f
    return rest
  }

  get lastSeq() { return this.frames.length }

  get headHash() { return this.frames.length ? this.frames[this.frames.length - 1].hash : '' }

  /** 同 op_id 的既有帧（幂等查询） */
  findByOp(opId) {
    return this.frames.find(f => f.op_id === opId) || null
  }

  /**
   * 提交一帧。**先落日志 + fsync，成功后才由调用方写投影。**
   * @returns {{frame:object, replayed:boolean}}
   */
  commit({ runId, opId, op, payload, at }) {
    if (!runId) throw new LedgerError('BAD_ARGS', 'commit 需要 runId')
    if (!op) throw new LedgerError('BAD_ARGS', 'commit 需要 op')
    const id = opId || sha(`${runId}|${op}|${canonical(payload)}|${at}`)
    const digest = digestRequest({ op, payload })

    const old = this.findByOp(id)
    if (old) {
      const oldDigest = digestRequest({ op: old.op, payload: old.payload })
      if (oldDigest !== digest) {
        throw new LedgerError('DIGEST_CONFLICT', `op_id=${id} 已存在且摘要不同（旧 ${oldDigest.slice(0, 12)} / 新 ${digest.slice(0, 12)}）`, { op_id: id })
      }
      return { frame: old, replayed: true }
    }

    const seq = this.lastSeq + 1
    const prev = this.headHash
    const receipt = { op_id: id, run_id: runId, seq, at, result: 'committed' }
    const body = { seq, run_id: runId, op_id: id, req_digest: digest, op, payload, at, prev_hash: prev, receipt }
    const frame = { ...body, hash: sha(prev + canonical(body)) }

    // 落盘：append + fsync
    appendFileSync(this.file, JSON.stringify(frame) + '\n', 'utf8')
    try {
      const fd = openSync(this.file, 'r+')
      fsyncSync(fd)
      closeSync(fd)
    } catch { /* fsync 失败不致命，但下面会再读校验 */ }

    // 读回校验：确认这一帧真的可解析、链正确
    const back = readFileSync(this.file, 'utf8').trimEnd().split('\n').pop()
    let bf
    try { bf = JSON.parse(back) } catch { throw new LedgerError('LOG_CORRUPT', `刚写入的第 ${seq} 帧读回失败`, { seq }) }
    if (bf.seq !== seq || bf.hash !== frame.hash) {
      throw new LedgerError('LOG_CORRUPT', `第 ${seq} 帧读回不一致（可能被截断）`, { seq })
    }

    this.frames.push(frame)
    return { frame, replayed: false }
  }

  /** 某 run 的全部帧（按 seq 升序） */
  framesOf(runId) {
    return this.frames.filter(f => f.run_id === runId)
  }

  /** 某 run 的最后一条事实帧 */
  lastOf(runId) {
    const fs = this.framesOf(runId)
    return fs.length ? fs[fs.length - 1] : null
  }

  /** 校验完整性；返回 {ok, frames, error} */
  verifyChain() {
    try {
      const fresh = new LedgerV2(this.file)
      return { ok: true, frames: fresh.frames.length }
    } catch (e) {
      return { ok: false, error: e.code || 'UNKNOWN', message: e.message, line: e.line }
    }
  }
}

/**
 * 锁持有者存活检测（按裁决：不能仅凭锁文件年龄抢占）
 * 锁文件内容约定为 JSON：{pid, at, cmd}
 */
export function lockHolderAlive(lockPath) {
  if (!existsSync(lockPath)) return { exists: false, alive: false }
  let info
  try { info = JSON.parse(readFileSync(lockPath, 'utf8')) } catch { return { exists: true, alive: 'unknown', raw: true } }
  if (!info || !info.pid) return { exists: true, alive: 'unknown' }
  try {
    process.kill(info.pid, 0)   // 0 号信号只探活
    return { exists: true, alive: true, pid: info.pid, at: info.at }
  } catch (e) {
    if (e.code === 'ESRCH') return { exists: true, alive: false, pid: info.pid, stale: true }
    return { exists: true, alive: 'unknown', pid: info.pid }
  }
}
