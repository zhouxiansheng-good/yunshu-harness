import { enabled, requireFeature, featureTool, onChange } from '../system/policy.mjs';
import { contentHash } from './shared/context-contract.mjs';
import { MediaError } from './media-vault.mjs';

// Opt-in adapter. Existing memory captures the public event first; this queue
// reads that immutable source after the synchronous host event handlers finish.
// Not imported by the frozen release packages or their build scripts.
export function attachMediaCapture({ ctx, memory, vault, maxPending = 64, maxPartsPerSource = 64, recovery, startupScopes = [] }) {
  if (!ctx?.on || !memory?.store?.evidence || !memory?.scopeFor || !vault?.captureInline) throw new MediaError('INVALID_ADAPTER', '媒体适配器需要宿主事件和现有记忆组件');
  if (![maxPending, maxPartsPerSource].every(n => Number.isSafeInteger(n) && n > 0 && n <= 1000)) throw new MediaError('INVALID_LIMIT', '媒体队列限制无效');
  if (!Array.isArray(startupScopes) || startupScopes.length > 100 || startupScopes.some(scope => typeof scope !== 'string' || !scope.trim() || scope.length > 300) || startupScopes.length && (!recovery?.sweep || recovery.vault !== vault)) throw new MediaError('INVALID_ADAPTER', '启动补扫必须使用同一媒体组件和明确工作区');
  const lifetime = new AbortController(), pending = new Set(), recent = [];
  const counts = { accepted: 0, duplicates: 0, dropped: 0, completed: 0, failed: 0, cancelled: 0 };
  let tail = Promise.resolve(), closed = false;
  const remember = result => { recent.push(result); if (recent.length > 100) recent.shift(); };
  const processSource = async (scope, sourceId) => {
    lifetime.signal.throwIfAborted();
    const source = memory.store.evidence.source(scope, sourceId);
    if (!source) throw new MediaError('SOURCE_UNAVAILABLE', '来源未记录或已撤回');
    const media = source.payload.parts.map((part, partIndex) => ({ part, partIndex })).filter(row => ['image', 'audio', 'video', 'file'].includes(row.part.type));
    const results = [];
    for (const { partIndex } of media.slice(0, maxPartsPerSource)) {
      lifetime.signal.throwIfAborted();
      try { results.push(await vault.captureInline({ scope, sourceId, partIndex, signal: lifetime.signal })); }
      catch (error) { lifetime.signal.throwIfAborted(); results.push({ sourceId, partIndex, status: 'failed', code: error instanceof MediaError ? error.code : 'CAPTURE_FAILED', mediaBytesVerified: false }); }
    }
    const coverage = { mediaParts: media.length, stored: results.filter(r => r.status === 'stored').length, referenceOnly: results.filter(r => r.status === 'reference-only').length, failed: results.filter(r => r.status === 'failed').length, omitted: Math.max(0, media.length - maxPartsPerSource) };
    const status = !media.length ? 'no-media' : coverage.stored === media.length ? 'bytes-complete' : coverage.stored ? 'partial' : coverage.failed || coverage.omitted ? 'failed' : 'reference-only';
    if (coverage.failed || coverage.omitted) counts.failed++;
    counts.completed++; remember({ scope, sourceId, status, coverage, results });
  };
  const enqueue = (scope, sourceId) => {
    if (closed) return { queued: false, reason: 'closed' };
    if (typeof scope !== 'string' || !scope.trim() || scope.length > 300 || typeof sourceId !== 'string' || !/^[a-f0-9]{64}$/.test(sourceId)) throw new MediaError('INVALID_INPUT', '媒体队列来源无效');
    const key = JSON.stringify([scope, sourceId]);
    if (pending.has(key)) { counts.duplicates++; return { queued: false, reason: 'already-pending' }; }
    if (pending.size >= maxPending) {
      let originalSourceRetained = null;
      try { originalSourceRetained = !!memory.store.evidence.source(scope, sourceId, { includeWithdrawn: true }); } catch { /* unknown is not success */ }
      counts.dropped++; remember({ scope, sourceId, status: 'not-queued', code: 'QUEUE_FULL', originalSourceRetained, sourceCheck: originalSourceRetained === null ? 'unknown' : 'observed-at-drop' });
      return { queued: false, reason: 'queue-full' };
    }
    pending.add(key); counts.accepted++;
    tail = tail.then(() => processSource(scope, sourceId)).catch(error => {
      if (lifetime.signal.aborted) { counts.cancelled++; remember({ scope, sourceId, status: 'cancelled' }); }
      else { counts.failed++; remember({ scope, sourceId, status: 'failed', code: error instanceof MediaError ? error.code : 'CAPTURE_FAILED' }); }
    }).finally(() => pending.delete(key));
    return { queued: true };
  };
  const off = ctx.on('session/event', (session, event) => {
    if (!enabled('media') || closed || !['user/message', 'assistant/message'].includes(event?.type) || !Number.isSafeInteger(event.seq) || event.seq < 0) return;
    if (event.type === 'user/message' && event.data?.source?.kind !== 'user') return;
    try {
      const scope = memory.scopeFor({ session });
      if (!enabled('memory')) {
        const owner=event.type==='user/message', msg=owner?event.data:event.data?.message;
        const parts=(msg?.content??[]).filter(p=>['image','audio','video','file'].includes(p?.type));
        if (!parts.length) return;
        const attachment={...msg,content:parts};
        memory.store.evidence.capture(scope,session.header.id,{...event,data:owner?attachment:{...event.data,message:attachment}});
      }
      enqueue(scope, contentHash([scope, session.header.id, event.seq]));
    } catch { counts.failed++; remember({ status: 'failed', code: 'EVENT_SCOPE_FAILED' }); }
  });
  const startup = { state: startupScopes.length ? 'processing' : 'disabled', results: [] };
  const ready = Promise.resolve().then(async () => {
    for (const scope of [...new Set(startupScopes)]) {
      lifetime.signal.throwIfAborted();
      // Persisted complete jobs are historical facts, not current byte checks.
      startup.results.push(await recovery.sweep({ scope, signal: lifetime.signal, reverifyStored: true }));
    }
    if (startupScopes.length) {
      startup.state = startup.results.some(r => r.more || r.exhausted) ? 'incomplete' : 'scan-complete';
      startup.bytesComplete = startup.results.every(r => !r.more && !r.exhausted && !r.states['reference-only'] && !r.states.failed && !r.states.partial);
    }
  }).catch(error => { startup.state = lifetime.signal.aborted ? 'cancelled' : 'failed'; startup.code = error instanceof MediaError ? error.code : 'RECOVERY_FAILED'; });
  const status = () => ({ state: closed ? 'closed' : pending.size || startup.state === 'processing' ? 'processing' : 'idle', pending: pending.size, ...counts, recent: structuredClone(recent), startup: structuredClone(startup), networkAccessed: false, modelCalled: false });
  const dispose = async () => { if (!closed) { closed = true; off(); lifetime.abort(); } await Promise.all([tail, ready]); };
  return { enqueue, status, ready, flush: async () => { await ready; let current; do { current = tail; await current; } while (current !== tail); return status(); }, dispose };
}
