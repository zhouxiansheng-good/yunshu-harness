import { libraryRequest } from './media-library.mjs';
import { enabled, requireFeature, featureTool, onChange } from '../system/policy.mjs';
import { Service } from '@deepseek-ai/cordis';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { MediaVault, MediaError } from './media-vault.mjs';
import { MediaRecovery } from './media-recovery.mjs';
import { MediaScheduler } from './media-scheduler.mjs';
import { attachMediaCapture } from './capture-adapter.mjs';
import { exportMediaBundle, restoreMediaBundle } from './media-backup.mjs';
import { MediaUploads } from './media-upload.mjs';

export default class YunshuMedia extends Service {
  static inject = ['yunshuMemory'];
  constructor(ctx, config = {}) {
    super(ctx, 'yunshuMedia');
    this.memory = ctx.yunshuMemory; this.config = config; this.closed = false; this.state = 'starting'; this.error = null;
    this.lifetime = new AbortController(); this.operations = new Set(); this.knownScopes = new Set();
    this.memoryAbort = () => { void this.close().catch(() => {}); };
    this.memory.lifetime.signal.addEventListener('abort', this.memoryAbort, { once: true });
    ctx.effect(() => () => { this.memory.lifetime.signal.removeEventListener('abort', this.memoryAbort); return this.close(); });
    this.ready = this.initialize(); this.ready.catch(() => {});
  }
  async [Service.init]() { await this.ready; }
  async initialize() {
    try {
      this.vault = await MediaVault.create({ store: this.memory.store, root: this.config.root ?? dshHomePath('plugins', 'yunshu-memory', 'media'), ...this.config.limits });
      this.lifetime.signal.throwIfAborted();
      this.uploads = new MediaUploads({ vault: this.vault, ...this.config.uploads });
      this.recovery = new MediaRecovery({ vault: this.vault, ...this.config.recovery });
      this.scheduler = new MediaScheduler({ recovery: this.recovery, ...this.config.scheduler });
      this.capture = attachMediaCapture({ ctx: this.ctx, memory: this.memory, vault: this.vault });
      this.off = this.ctx.on('session/event', (session, event) => {
        if (!enabled('media') || !['user/message', 'assistant/message'].includes(event?.type)) return;
        try { this.activate(this.memory.scopeFor({ session })); } catch { this.error = 'QUEUE_FAILED'; }
      });
      const scopes = this.config.startupScopes ?? [];
      if (!Array.isArray(scopes) || scopes.length > this.scheduler.maxScopes) throw new MediaError('INVALID_SCOPE', '启动工作区无效');
      onChange(this.ctx,()=>{if(!enabled('media'))this.scheduler.active?.controller.abort();});
      for (const scope of new Set(scopes)) if(enabled('media'))this.activate(scope);
      this.state = 'ready';
    } catch (error) {
      this.state = 'failed'; this.error = error?.code ?? 'START_FAILED';
      this.uploads?.close();
      await this.capture?.dispose(); await this.scheduler?.close(); await this.recovery?.close(); await this.vault?.close();
      throw error;
    }
  }
  activate(scope) {
    if (this.closed) throw new MediaError('CLOSED', '媒体服务已关闭');
    const first = !this.knownScopes.has(scope) || !this.scheduler.scopes.has(scope);
    this.scheduler.notify(scope, { reverifyStored: first }); this.knownScopes.add(scope);
    for (const old of this.knownScopes) if (!this.scheduler.scopes.has(old)) this.knownScopes.delete(old);
    if (this.error === 'QUEUE_FAILED') this.error = null;
  }
  health() {
    let state = this.closed ? 'not_installed' : this.state, code = this.error, error = code ? '媒体任务排队失败' : null;
    if (!this.closed && state === 'ready') try {
      this.memory.store.open(); this.memory.store.db.prepare('SELECT 1').get();
      const failedScan = [...this.scheduler.scopes.values()].some(row => ['failed', 'attention'].includes(row.state)) || !!this.memory.store.db.prepare("SELECT 1 FROM yunshu_media_jobs j JOIN yunshu_sources s ON s.id=j.source_id WHERE j.state IN ('failed','partial') AND s.withdrawn=0 LIMIT 1").get();
      const lookup = this.memory.store.db.prepare('SELECT j.state,s.withdrawn FROM yunshu_sources s LEFT JOIN yunshu_media_jobs j ON j.scope=s.scope AND j.source_id=s.id WHERE s.scope=? AND s.id=?');
      const failedCapture = this.capture.status().recent.some(row => {
        if (!(['failed', 'not-queued'].includes(row.status) || row.coverage?.failed || row.coverage?.omitted)) return false;
        const current = row.scope && row.sourceId ? lookup.get(row.scope, row.sourceId) : null;
        return !current?.withdrawn && !['complete', 'reference-only', 'withdrawn'].includes(current?.state);
      });
      if (code || failedScan || failedCapture) { state = 'degraded'; code ??= 'MEDIA_TASK_FAILED'; error ??= '部分附件需要处理'; }
    } catch { state = 'failed'; code = 'STORE_UNAVAILABLE'; error = '记忆存储不可用'; }
    return { id: 'media', state, configured: true, error, code, evidence: state === 'ready' ? 'media-service-open' : 'media-service-' + state, checkedAt: new Date().toISOString() };
  }
  request(agent, action, payload = {}, signal = new AbortController().signal) {
    if (this.closed) return Promise.reject(new MediaError('CLOSED', '媒体服务已关闭'));
    const active = AbortSignal.any([signal, this.lifetime.signal]);
    const op = Promise.resolve().then(async () => {
      await this.ready; active.throwIfAborted(); requireFeature('media'); const scope = this.memory.scopeFor(agent);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new MediaError('INVALID_INPUT', '操作参数无效');
      // Read-only status does not start a scan or reset a completed/paused job.
      if (action.startsWith('media-library-')) return libraryRequest(this,scope,action,payload,active);
      if (action === 'media-status') {
        const stored=this.memory.store.db.prepare('SELECT COUNT(*) AS n FROM yunshu_media_refs r JOIN yunshu_sources s ON s.id=r.source_id AND s.scope=r.scope WHERE r.scope=? AND s.withdrawn=0').get(scope).n;
        const observations = this.memory.store.db.prepare("SELECT COUNT(*) AS count FROM yunshu_observations o JOIN yunshu_sources s ON s.id=o.source_id WHERE o.scope=? AND o.state='confirmed' AND o.source_mode='model_inference' AND o.modality IN ('image','audio') AND s.withdrawn=0").get(scope).count;
        return { stored, health: this.health(), scope, scan: this.scheduler.status(scope), progress: this.recovery.status(scope), jobs: this.recovery.jobs(scope, { limit: 30 }), observations, limits: { maxAssetBytes: this.vault.maxAssetBytes, maxTotalBytes: this.vault.maxTotalBytes } };
      }
      if (action === 'media-pause') return this.scheduler.pause(scope);
      if (action === 'media-scan' || action === 'media-recheck') {
        if (action === 'media-recheck' && payload.confirmed !== true) throw new MediaError('CONFIRM_REQUIRED', '请确认重新检查');
        const first = !this.knownScopes.has(scope) || !this.scheduler.scopes.has(scope);
        const result = this.scheduler.notify(scope, { resume: true, reverifyStored: first, recheckComplete: action === 'media-recheck' }); this.knownScopes.add(scope);
        for (const old of this.knownScopes) if (!this.scheduler.scopes.has(old)) this.knownScopes.delete(old);
        if (this.error === 'QUEUE_FAILED') this.error = null; return result;
      }
      if (action === 'media-backup') return exportMediaBundle({ vault: this.vault, scope, directory: payload.directory, signal: active });
      if (action === 'media-restore') return restoreMediaBundle({ directory: payload.directory, destination: payload.destination, confirmed: payload.confirmed, signal: active });
      if (action === 'media-verify') return this.vault.verify({ scope, sourceId: payload.sourceId, partIndex: payload.partIndex, signal: active });
      if (action === 'media-parts') return this.uploads.parts(scope, payload);
      if (action === 'media-upload-begin') return this.uploads.begin(scope, payload);
      if (action === 'media-upload-chunk') return this.uploads.chunk(scope, payload);
      if (action === 'media-upload-cancel') return this.uploads.cancel(scope, payload);
      if (action === 'media-upload-commit') {
        const saved=await this.uploads.commit(scope,payload,active);
        const progress=await this.recovery.reconcileSource(scope,saved.sourceId,active);
        return {...saved,sourceState:progress.state};
      }
      throw new MediaError('UNKNOWN_ACTION', '未知媒体操作');
    });
    this.operations.add(op); op.then(() => this.operations.delete(op), () => this.operations.delete(op)); return op;
  }
  async flush() { await this.ready; await this.capture.flush(); await this.scheduler.idle(); }
  close() {
    if (this.closing) return this.closing;
    this.closed = true; this.lifetime.abort(); this.off?.();
    this.uploads?.close();
    // Signal all workers before yielding; the memory provider may close next.
    const stopping = [this.capture?.dispose(), this.scheduler?.close(), this.recovery?.close()];
    this.closing = (async () => {
      await this.ready.catch(() => {});
      await Promise.allSettled(stopping);
      await Promise.allSettled([...this.operations]); await this.vault?.close(); this.state = 'closed';
    })(); return this.closing;
  }
}
