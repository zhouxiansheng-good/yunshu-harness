import { setTimeout as delay } from 'node:timers/promises';
import { MediaError } from './media-vault.mjs';

const validScope = scope => typeof scope === 'string' && scope.trim() && scope.length <= 300;
export class MediaScheduler {
  constructor({ recovery, delayMs = 100, batchSize = 64, maxBatches = 128, maxScopes = 32 }) {
    for (const [value, min, max] of [[delayMs, 0, 60000], [batchSize, 1, 128], [maxBatches, 1, 1000], [maxScopes, 1, 100]]) {
      if (!Number.isSafeInteger(value) || value < min || value > max) throw new MediaError('INVALID_LIMIT', '补扫参数无效');
    }
    this.recovery = recovery; this.delayMs = delayMs; this.batchSize = batchSize; this.maxBatches = maxBatches; this.maxScopes = maxScopes;
    this.scopes = new Map(); this.work = null; this.active = null; this.closed = false; this.lifetime = new AbortController();
  }
  entry(scope) {
    if (!validScope(scope)) throw new MediaError('INVALID_SCOPE', '工作区无效');
    if (!this.scopes.has(scope)) {
      if (this.scopes.size >= this.maxScopes) {
        const disposable = [...this.scopes.values()].find(r => !r.queued && !r.paused && this.active?.scope !== r.scope);
        if (disposable) this.scopes.delete(disposable.scope);
      }
      if (this.scopes.size >= this.maxScopes) throw new MediaError('SCOPE_LIMIT', '同时处理的工作区过多');
      this.scopes.set(scope, { scope, state: 'idle', queued: false, paused: false, batches: 0, reverifyStored: false, recheckComplete: false, result: null, error: null });
    }
    return this.scopes.get(scope);
  }
  notify(scope, { reverifyStored = false, recheckComplete = false, resume = false } = {}) {
    if (this.closed) throw new MediaError('CLOSED', '媒体服务已关闭');
    const row = this.entry(scope);
    if (resume) { row.paused = false; row.batches = 0; }
    row.queued = true; row.reverifyStored ||= reverifyStored; row.recheckComplete ||= recheckComplete;
    if (!row.paused) row.state = 'queued'; this.kick(); return this.status(scope);
  }
  kick() {
    if (this.closed || this.work || ![...this.scopes.values()].some(r => r.queued && !r.paused)) return;
    const work = Promise.resolve().then(() => this.drain()); this.work = work;
    work.then(() => { this.work = null; this.kick(); }, () => { this.work = null; this.kick(); });
  }
  async drain() {
    while (!this.closed) {
      const row = [...this.scopes.values()].find(r => r.queued && !r.paused); if (!row) return;
      if (row.batches >= this.maxBatches) { row.paused = true; row.state = 'paused'; row.error = 'BATCH_LIMIT'; continue; }
      const controller = new AbortController(), signal = AbortSignal.any([controller.signal, this.lifetime.signal]);
      this.active = { scope: row.scope, controller }; row.state = 'scanning'; row.queued = false;
      const flags = { reverifyStored: row.reverifyStored, recheckComplete: row.recheckComplete };
      row.reverifyStored = false; row.recheckComplete = false;
      try {
        const result = await this.recovery.sweep({ scope: row.scope, signal, maxDiscover: this.batchSize, maxProcess: this.batchSize, ...flags });
        row.result = result; row.batches++; row.error = null;
        row.queued ||= result.more; row.state = result.more ? 'queued' : result.exhausted ? 'attention' : 'idle';
      } catch (error) {
        row.reverifyStored ||= flags.reverifyStored; row.recheckComplete ||= flags.recheckComplete;
        if (signal.aborted) { row.queued = true; row.state = 'paused'; }
        else { row.error = /^[A-Z][A-Z0-9_]{0,40}$/.test(error?.code ?? '') ? error.code : 'SCAN_FAILED'; row.state = 'failed'; }
      } finally {
        this.active = null;
        // Rotate scopes so one large workspace cannot monopolize the queue.
        this.scopes.delete(row.scope); this.scopes.set(row.scope, row);
      }
      if (row.paused) row.state = 'paused';
      if (!this.closed && this.delayMs) try { await delay(this.delayMs, undefined, { signal: this.lifetime.signal }); } catch { return; }
    }
  }
  async pause(scope) {
    const row = this.entry(scope); row.paused = true; row.state = 'paused';
    if (this.active?.scope === scope) this.active.controller.abort();
    // The caller can observe paused immediately; shutdown waits for settlement.
    return this.status(scope);
  }
  status(scope) {
    const row = this.scopes.get(scope);
    return row ? structuredClone({ ...row, state: this.closed ? 'closed' : row.state }) : { scope, state: this.closed ? 'closed' : 'idle', queued: false, paused: false, batches: 0, result: null, error: null };
  }
  async idle() { while (this.work) await this.work; }
  async close() { this.closed = true; this.lifetime.abort(); this.active?.controller.abort(); await this.idle(); }
}
