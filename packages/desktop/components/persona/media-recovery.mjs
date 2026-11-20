import { MediaError } from './media-vault.mjs';
import { realpathSync, statSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
const busyByDatabase = new Map();
function databaseKey(db) {
  const file = db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file;
  if (!file) return db; // Independent in-memory databases must not share a lock.
  const path = realpathSync(file), stat = statSync(path, { bigint: true });
  return stat.ino !== 0n ? 'file:' + stat.dev + ':' + stat.ino : 'path:' + (process.platform === 'win32' ? path.toLowerCase() : path);
}
const mediaTypes = new Set(['image', 'audio', 'video', 'file']);
const check = (ok, code, message) => { if (!ok) throw new MediaError(code, message); };
const codeOf = error => /^[A-Z][A-Z0-9_]{0,40}$/.test(error?.code ?? '') ? error.code : 'CAPTURE_FAILED';
const now = () => new Date().toISOString();
const validScope = scope => typeof scope === 'string' && scope.trim() && scope.length <= 300;

// Derived progress, not a second memory system. Immutable source payloads remain
// the replay source of truth. Each batch is bounded and explicitly reports more.
export class MediaRecovery {
  constructor({ vault, maxAttempts = 3, maxPartsPerSource = 64 }) {
    check(vault?.store?.evidence && Number.isSafeInteger(maxAttempts) && maxAttempts > 0 && maxAttempts <= 10 && Number.isSafeInteger(maxPartsPerSource) && maxPartsPerSource > 0 && maxPartsPerSource <= 1000, 'INVALID_LIMIT', '媒体补扫配置无效');
    this.vault = vault; this.store = vault.store; this.maxAttempts = maxAttempts; this.maxPartsPerSource = maxPartsPerSource;
    this.closed = false; this.lifetime = new AbortController(); this.operations = new Set();
    this.store.open(); this.store.db.exec([
      'CREATE TABLE IF NOT EXISTS yunshu_media_scan(scope TEXT PRIMARY KEY,cursor INTEGER NOT NULL,updated_at TEXT NOT NULL);',
      'CREATE TABLE IF NOT EXISTS yunshu_media_jobs(scope TEXT NOT NULL,source_id TEXT NOT NULL,source_hash TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,result TEXT,last_code TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(scope,source_id),FOREIGN KEY(source_id) REFERENCES yunshu_sources(id));',
    ].join('\n'));
    // The host runs one process but may open multiple connections or aliases.
    // This is a process-local exclusion, not a cross-process database lease.
    this.databaseKey = databaseKey(this.store.db);
  }
  status(scope) {
    check(validScope(scope), 'INVALID_SCOPE', '补扫范围无效'); this.store.open();
    const cursor = this.store.db.prepare('SELECT cursor FROM yunshu_media_scan WHERE scope=?').get(scope)?.cursor ?? 0;
    const newest = this.store.db.prepare('SELECT COALESCE(MAX(rowid),0) AS n FROM yunshu_sources WHERE scope=?').get(scope).n;
    const states = Object.fromEntries(this.store.db.prepare('SELECT state,COUNT(*) AS n FROM yunshu_media_jobs WHERE scope=? GROUP BY state').all(scope).map(r => [r.state, r.n]));
    const exhausted = this.store.db.prepare("SELECT COUNT(*) AS n FROM yunshu_media_jobs WHERE scope=? AND state IN ('failed','partial') AND attempts>=?").get(scope, this.maxAttempts).n;
    const retryable = this.store.db.prepare("SELECT COUNT(*) AS n FROM yunshu_media_jobs WHERE scope=? AND (state='pending' OR (state IN ('failed','partial') AND COALESCE(last_code,'')!='REFERENCE_ONLY' AND attempts<?))").get(scope, this.maxAttempts).n;
    return { scope, closed: this.closed, cursor, newestSourceCursor: newest, undiscovered: cursor < newest, states, exhausted, retryable, more: cursor < newest || retryable > 0, networkAccessed: false, modelCalled: false };
  }
  jobs(scope, { limit = 50 } = {}) {
    check(validScope(scope) && Number.isSafeInteger(limit) && limit > 0 && limit <= 200, 'INVALID_INPUT', '补扫查询无效'); this.store.open();
    return this.store.db.prepare('SELECT * FROM yunshu_media_jobs WHERE scope=? ORDER BY rowid DESC LIMIT ?').all(scope, limit).map(row => ({ ...row, result: row.result ? JSON.parse(row.result) : null }));
  }
  sweep({ scope, signal, maxDiscover = 128, maxProcess = 128, retryFailed = true, recheckComplete = false, reverifyStored = false }) {
    if (this.closed) return Promise.reject(new MediaError('CLOSED', '媒体补扫已关闭'));
    if (!validScope(scope) || ![maxDiscover, maxProcess].every(n => Number.isSafeInteger(n) && n > 0 && n <= 1000) || typeof retryFailed !== 'boolean' || typeof recheckComplete !== 'boolean' || typeof reverifyStored !== 'boolean') return Promise.reject(new MediaError('INVALID_INPUT', '媒体补扫参数无效'));
    const active = AbortSignal.any([this.lifetime.signal, this.vault.lifetime.signal, ...(signal ? [signal] : [])]);
    const busy = busyByDatabase.get(this.databaseKey) ?? new Set();
    if (busy.has(scope)) return Promise.reject(new MediaError('RECOVERY_BUSY', '此工作区已经在补扫'));
    busy.add(scope); busyByDatabase.set(this.databaseKey, busy);
    const promise = Promise.resolve().then(async () => {
      active.throwIfAborted(); this.store.open();
      if (recheckComplete) this.store.db.prepare("UPDATE yunshu_media_jobs SET state='pending',attempts=0,result=NULL,last_code=NULL,updated_at=? WHERE scope=? AND state IN ('complete','reference-only','failed','partial')").run(now(), scope);
      else if (reverifyStored) this.store.db.prepare("UPDATE yunshu_media_jobs SET state='pending',attempts=0,result=NULL,last_code=NULL,updated_at=? WHERE scope=? AND state IN ('complete','reference-only')").run(now(), scope);
      const cursor = this.status(scope).cursor;
      const upper = this.store.db.prepare('SELECT COALESCE(MAX(rowid),0) AS n FROM yunshu_sources WHERE scope=?').get(scope).n;
      const rows = this.store.db.prepare('SELECT rowid AS cursor,id,content_hash,withdrawn FROM yunshu_sources WHERE scope=? AND rowid>? AND rowid<=? ORDER BY rowid LIMIT ?').all(scope, cursor, upper, maxDiscover);
      let discovered = 0;
      for (const row of rows) {
        active.throwIfAborted(); let source, sourceError = false;
        if (!row.withdrawn) try { source = this.store.evidence.source(scope, row.id); } catch { sourceError = true; }
        this.store.transaction(() => {
          if (sourceError || source?.payload.parts.some(part => mediaTypes.has(part.type))) {
            this.store.db.prepare("INSERT OR IGNORE INTO yunshu_media_jobs(scope,source_id,source_hash,state,attempts,updated_at) VALUES(?,?,?,'pending',0,?)").run(scope, row.id, row.content_hash, now()); discovered++;
          }
          this.store.db.prepare('INSERT INTO yunshu_media_scan VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET cursor=MAX(cursor,excluded.cursor),updated_at=excluded.updated_at').run(scope, row.cursor, now());
        });
      }
      if (rows.length < maxDiscover) this.store.db.prepare('INSERT INTO yunshu_media_scan VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET cursor=MAX(cursor,excluded.cursor),updated_at=excluded.updated_at').run(scope, upper, now());
      const pending = this.store.db.prepare("SELECT * FROM yunshu_media_jobs WHERE scope=? AND (state='pending' OR (?=1 AND state IN ('failed','partial') AND COALESCE(last_code,'')!='REFERENCE_ONLY' AND attempts<?)) ORDER BY rowid LIMIT ?").all(scope, +retryFailed, this.maxAttempts, maxProcess);
      let processed = 0;
      for (const job of pending) {
        active.throwIfAborted();
        // An interrupted claim is not a failed attempt: only a recorded failure
        // consumes retry budget. Even legacy pending jobs at the cap can resume.
        this.store.db.prepare("UPDATE yunshu_media_jobs SET state='pending',result=NULL,last_code=NULL,updated_at=? WHERE scope=? AND source_id=?").run(now(), scope, job.source_id);
        try {
          const result = await this.process(job, active);
          active.throwIfAborted();
          this.store.db.prepare('UPDATE yunshu_media_jobs SET state=?,attempts=attempts+?,result=?,last_code=?,updated_at=? WHERE scope=? AND source_id=?').run(result.state, +['failed', 'partial'].includes(result.state), JSON.stringify(result), result.code ?? null, now(), scope, job.source_id); processed++;
        } catch (error) {
          if (active.aborted) {
            // A lifecycle cancellation is not a failed retrieval attempt.
            this.store.db.prepare("UPDATE yunshu_media_jobs SET state='pending',last_code='CANCELLED',updated_at=? WHERE scope=? AND source_id=?").run(now(), scope, job.source_id);
            throw error;
          }
          this.store.db.prepare("UPDATE yunshu_media_jobs SET state='failed',attempts=attempts+1,last_code=?,updated_at=? WHERE scope=? AND source_id=?").run(codeOf(error), now(), scope, job.source_id); processed++;
        }
        // Yield between sources so replay never monopolizes the host turn.
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      return { ...this.status(scope), discovered, processed, batchLimit: { maxDiscover, maxProcess } };
    }).finally(() => { busy.delete(scope); if (!busy.size) busyByDatabase.delete(this.databaseKey); this.operations.delete(promise); });
    this.operations.add(promise); return promise;
  }
  async process(job, signal) {
    let source;
    try { source = this.store.evidence.source(job.scope, job.source_id, { includeWithdrawn: true }); }
    catch { throw new MediaError('SOURCE_READ_FAILED', '补扫原件不可读'); }
    check(source, 'SOURCE_UNAVAILABLE', '补扫原件不存在');
    if (source.withdrawn) return { state: 'withdrawn', code: 'SOURCE_WITHDRAWN' };
    check(source.content_hash === job.source_hash, 'SOURCE_CHANGED', '补扫原件已变化');
    const parts = source.payload.parts.map((part, partIndex) => ({ part, partIndex })).filter(row => mediaTypes.has(row.part.type));
    const result = { state: 'complete', mediaParts: parts.length, verified: 0, referenceOnly: 0, failed: 0, omitted: Math.max(0, parts.length - this.maxPartsPerSource), errors: [] };
    for (const { partIndex } of parts.slice(0, this.maxPartsPerSource)) {
      signal.throwIfAborted(); const key = { scope: job.scope, sourceId: job.source_id, partIndex, signal };
      try {
        const current = await this.vault.verify(key);
        if (current.status === 'verified') result.verified++;
        else if (current.status === 'corrupt' || current.status === 'source-changed') throw new MediaError('INTEGRITY_ERROR', '媒体当前不可验证');
        else if (current.status === 'source-unavailable') throw new MediaError('SOURCE_UNAVAILABLE', '媒体来源已不可用');
        else {
          const captured = await this.vault.captureInline(key);
          if (captured.status === 'stored') result.verified++;
          else if (current.status === 'missing') throw new MediaError('MEDIA_MISSING', '补交媒体已缺失，不能从引用重建');
          else result.referenceOnly++;
        }
      } catch (error) { signal.throwIfAborted(); result.failed++; result.errors.push({ partIndex, code: codeOf(error) }); }
    }
    const current = this.store.evidence.source(job.scope, job.source_id, { includeWithdrawn: true });
    if (!current || current.withdrawn) return { state: 'withdrawn', code: 'SOURCE_WITHDRAWN' };
    check(current.content_hash === job.source_hash, 'SOURCE_CHANGED', '补扫完成时原件已变化');
    if (result.failed || result.omitted) { result.state = result.verified ? 'partial' : 'failed'; result.code = result.omitted ? 'PART_LIMIT' : result.errors[0]?.code; }
    else if (result.referenceOnly) {
      result.state = result.verified ? 'partial' : 'reference-only';
      result.code = 'REFERENCE_ONLY';
    }
    return result;
  }
  reconcileSource(scope, sourceId, signal) {
    if (this.closed) return Promise.reject(new MediaError('CLOSED', '媒体补扫已关闭'));
    const active=AbortSignal.any([this.lifetime.signal,this.vault.lifetime.signal,signal]);
    const op=(async()=>{
      // The same per-database exclusion as sweep prevents a late scan overwriting this receipt.
      while(busyByDatabase.get(this.databaseKey)?.has(scope)) await delay(12,undefined,{signal:active});
      active.throwIfAborted();
      const busy=busyByDatabase.get(this.databaseKey)??new Set();busy.add(scope);busyByDatabase.set(this.databaseKey,busy);
      try {
        const source=this.store.evidence.source(scope,sourceId,{includeWithdrawn:true});
        check(source,'SOURCE_UNAVAILABLE','媒体原件不存在');
        const job={scope,source_id:sourceId,source_hash:source.content_hash};
        this.store.db.prepare("INSERT INTO yunshu_media_jobs(scope,source_id,source_hash,state,attempts,updated_at) VALUES(?,?,?,'pending',0,?) ON CONFLICT(scope,source_id) DO UPDATE SET state='pending',attempts=0,result=NULL,last_code=NULL,updated_at=excluded.updated_at").run(scope,sourceId,source.content_hash,now());
        const result=await this.process(job,active);active.throwIfAborted();
        this.store.db.prepare('UPDATE yunshu_media_jobs SET state=?,result=?,last_code=?,updated_at=? WHERE scope=? AND source_id=? AND source_hash=?').run(result.state,JSON.stringify(result),result.code??null,now(),scope,sourceId,source.content_hash);
        return result;
      } finally {busy.delete(scope);if(!busy.size)busyByDatabase.delete(this.databaseKey);}
    })();
    this.operations.add(op);op.then(()=>this.operations.delete(op),()=>this.operations.delete(op));return op;
  }
  async close() { this.closed = true; this.lifetime.abort(); await Promise.allSettled([...this.operations]); }
}
