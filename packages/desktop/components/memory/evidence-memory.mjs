import { createHash, randomUUID } from 'node:crypto';
import { MemoryError, tokens } from './store.mjs';
import { stableJson, contentHash, compareId } from './shared/context-contract.mjs';
const check = (ok, message, code = 'INVALID_INPUT') => { if (!ok) throw new MemoryError(code, message); };
const text = (v, max = 2000) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const validDate = v => typeof v === 'string' && Number.isFinite(Date.parse(v));
const stamp = () => new Date().toISOString();
const decodeSource = (row, body) => row ? { ...row, payload: JSON.parse(body), withdrawn: !!row.withdrawn } : null;
const decodeObservation = row => row ? { ...row, value: JSON.parse(row.value) } : null;
const INLINE_SOURCE_BYTES = 2 * 1024 * 1024;
const SOURCE_CHUNK_BYTES = 256 * 1024;
const byteHash = bytes => createHash('sha256').update(bytes).digest('hex');

// Additive evidence layer in the SAME memory database. It does not replace
// completed-round storage, archive lifecycle or the original core/master.
export class EvidenceMemory {
  constructor(store) {
    this.store = store; this.db = store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS yunshu_sources(id TEXT PRIMARY KEY,scope TEXT NOT NULL,session_id TEXT NOT NULL,event_seq INTEGER NOT NULL,role TEXT NOT NULL,payload TEXT NOT NULL,content_hash TEXT NOT NULL,captured_at TEXT NOT NULL,withdrawn INTEGER NOT NULL DEFAULT 0,UNIQUE(scope,session_id,event_seq));
      CREATE INDEX IF NOT EXISTS yunshu_sources_scope ON yunshu_sources(scope,session_id,event_seq);
      CREATE TABLE IF NOT EXISTS yunshu_source_chunks(source_id TEXT NOT NULL REFERENCES yunshu_sources(id) ON DELETE CASCADE,ordinal INTEGER NOT NULL,data BLOB NOT NULL,chunk_hash TEXT NOT NULL,PRIMARY KEY(source_id,ordinal));
      CREATE TABLE IF NOT EXISTS yunshu_observations(id TEXT PRIMARY KEY,scope TEXT NOT NULL,subject TEXT NOT NULL,predicate TEXT NOT NULL,value TEXT NOT NULL,modality TEXT NOT NULL,source_mode TEXT NOT NULL,source_id TEXT NOT NULL REFERENCES yunshu_sources(id),quote TEXT NOT NULL,kind TEXT NOT NULL,state TEXT NOT NULL,version INTEGER NOT NULL,observed_at TEXT NOT NULL,created_at TEXT NOT NULL,supersedes TEXT REFERENCES yunshu_observations(id));
      CREATE INDEX IF NOT EXISTS yunshu_observations_scope ON yunshu_observations(scope,state,subject,predicate);
    `);
  }
  _insertSource(row) {
    const bytes = Buffer.byteLength(row.payload), chunked = bytes > INLINE_SOURCE_BYTES;
    const count = chunked ? Math.ceil(bytes / SOURCE_CHUNK_BYTES) : 0;
    const stored = chunked ? stableJson({ format: 'yunshu-source-chunks-v1', byteLength: bytes, chunkCount: count }) : row.payload;
    this.db.prepare('INSERT INTO yunshu_sources VALUES(?,?,?,?,?,?,?,?,?)').run(row.id,row.scope,row.session_id,row.event_seq,row.role,stored,row.content_hash,row.captured_at,+row.withdrawn);
    if (!chunked) return;
    const buffer = Buffer.from(row.payload, 'utf8');
    const insert = this.db.prepare('INSERT INTO yunshu_source_chunks VALUES(?,?,?,?)');
    for (let i = 0; i < count; i++) {
      const part = buffer.subarray(i * SOURCE_CHUNK_BYTES, (i + 1) * SOURCE_CHUNK_BYTES);
      insert.run(row.id, i, part, byteHash(part));
    }
  }
  _payloadText(row) {
    let envelope;
    try { envelope = JSON.parse(row.payload); }
    catch { throw new MemoryError('SOURCE_CORRUPT', '原件内容无法解析'); }
    if (envelope?.format !== 'yunshu-source-chunks-v1') {
      check(contentHash(row.payload) === row.content_hash, '原件哈希不匹配', 'SOURCE_CORRUPT');
      return row.payload;
    }
    check(Number.isSafeInteger(envelope.byteLength) && envelope.byteLength > INLINE_SOURCE_BYTES && Number.isSafeInteger(envelope.chunkCount) && envelope.chunkCount > 0, '原件分块索引无效', 'SOURCE_CORRUPT');
    const rows = this.db.prepare('SELECT ordinal,data,chunk_hash FROM yunshu_source_chunks WHERE source_id=? ORDER BY ordinal').all(row.id);
    check(rows.length === envelope.chunkCount, '原件分块缺失', 'SOURCE_CORRUPT');
    let total = 0;
    const chunks = rows.map((part, i) => {
      const bytes = Buffer.from(part.data);
      check(part.ordinal === i && bytes.length > 0 && bytes.length <= SOURCE_CHUNK_BYTES && byteHash(bytes) === part.chunk_hash, '原件分块损坏', 'SOURCE_CORRUPT');
      total += bytes.length;
      return bytes;
    });
    check(total === envelope.byteLength, '原件大小不匹配', 'SOURCE_CORRUPT');
    const body = Buffer.concat(chunks).toString('utf8');
    check(contentHash(body) === row.content_hash, '原件哈希不匹配', 'SOURCE_CORRUPT');
    return body;
  }
  capture(scope, sessionId, event) {
    this.store.open();
    if (!['user/message', 'assistant/message'].includes(event?.type)) return { ignored: true };
    check(text(scope, 300) && text(sessionId, 200) && Number.isSafeInteger(event.seq) && event.seq >= 0, '原始事件标识无效');
    const user = event.type === 'user/message', message = user ? event.data : event.data?.message;
    if (user && message?.source?.kind !== 'user') return { ignored: true };
    const parts = [], omittedTypes = [];
    for (const part of Array.isArray(message?.content) ? message.content : []) {
      if (part?.type === 'text' && typeof part.text === 'string') parts.push({ type: 'text', text: part.text });
      else if (['image', 'audio', 'video', 'file'].includes(part?.type)) {
        // Public content parts only. Never dereference paths/URLs automatically.
        const copy = JSON.parse(JSON.stringify(part));
        parts.push({ ...copy, capture: 'message-payload-only', mediaBytesVerified: false });
      } else if (typeof part?.type === 'string') omittedTypes.push(part.type);
    }
    if (!parts.length) return { ignored: true };
    const timestamp = event.timestamp ?? (Number.isFinite(event.time) ? new Date(event.time).toISOString() : message?.timestamp ?? null);
    check(timestamp === null || validDate(timestamp), '原始事件时间无效');
    const payload = { format: 'yunshu-public-source-v1', type: event.type, parts, timestamp, interrupted: !user && event.data?.interrupted === true, omittedTypes: [...new Set(omittedTypes)].sort(), coverage: 'public-content-parts' };
    const body = stableJson(payload);
    const id = contentHash([scope, sessionId, event.seq]), digest = contentHash(body);
    return this.store.transaction(() => {
      const old = this.db.prepare('SELECT * FROM yunshu_sources WHERE id=?').get(id);
      if (old) { check(old.content_hash === digest, '原始事件内容冲突', 'EVENT_CONFLICT'); return { id, duplicate: true, withdrawn: !!old.withdrawn }; }
      this._insertSource({ id, scope, session_id: sessionId, event_seq: event.seq, role: user ? 'user' : 'assistant', payload: body, content_hash: digest, captured_at: stamp(), withdrawn: false });
      return { id, duplicate: false };
    });
  }
  source(scope, id, { includeWithdrawn = false } = {}) {
    this.store.open();
    const row = this.db.prepare('SELECT * FROM yunshu_sources WHERE scope=? AND id=?').get(scope, id);
    return row && (includeWithdrawn || !row.withdrawn) ? decodeSource(row, this._payloadText(row)) : null;
  }
  sources(scope, { sessionId, limit = 50, beforeSeq, beforeCursor } = {}) {
    this.store.open();
    check(Number.isSafeInteger(limit) && limit > 0 && limit <= 200, '来源分页上限无效');
    check(beforeSeq === undefined || Number.isSafeInteger(beforeSeq) && text(sessionId,200), 'beforeSeq必须同时指定会话；跨会话请用beforeCursor');
    check(beforeCursor === undefined || Number.isSafeInteger(beforeCursor) && beforeCursor > 0, '来源游标无效');
    if (beforeSeq !== undefined) return this.db.prepare('SELECT rowid AS cursor,id,session_id,event_seq,role,content_hash,captured_at,withdrawn FROM yunshu_sources WHERE scope=? AND withdrawn=0 AND session_id=? AND event_seq<? ORDER BY event_seq DESC LIMIT ?').all(scope,sessionId,beforeSeq,limit);
    return this.db.prepare('SELECT rowid AS cursor,id,session_id,event_seq,role,content_hash,captured_at,withdrawn FROM yunshu_sources WHERE scope=? AND withdrawn=0 AND (? IS NULL OR session_id=?) AND (? IS NULL OR rowid<?) ORDER BY rowid DESC LIMIT ?').all(scope, sessionId ?? null, sessionId ?? null, beforeCursor ?? null, beforeCursor ?? null, limit);
  }
  _validate(scope, input, confirmed, sourceLookup = id => this.source(scope, id)) {
    check(input && text(input.subject, 300) && text(input.predicate, 200) && text(input.value, 4000), '观察主体、属性或值无效');
    check(['text', 'image', 'audio', 'taste', 'smell', 'touch', 'tool'].includes(input.modality), '观察模态无效');
    check(['user_report', 'model_inference'].includes(input.source_mode), '当前只接入口述或明确标记的模型推断');
    check(['observation', 'fact', 'experience', 'episode'].includes(input.kind ?? 'observation'), '记忆类型无效');
    const source = sourceLookup(input.source_id); check(source, '来源不存在或已撤回', 'SOURCE_REQUIRED');
    check(text(input.quote, 4000), '必须提供原始依据片段');
    const original = source.payload.parts.filter(p => p.type === 'text').map(p => p.text).join('\n');
    if (input.source_mode === 'user_report') {
      check(source.role === 'user', '助手回复不能冒充用户口述', 'PROVENANCE_MISMATCH');
      check(original.includes(input.quote), '引用不在原话中', 'PROVENANCE_MISMATCH');
    } else {
      // A model proposal remains an inference even if later accepted by owner.
      check(original.includes(input.quote) || source.payload.parts.some(p => p.type !== 'text'), '推断缺少可回查依据', 'PROVENANCE_MISMATCH');
    }
    const observed = input.observed_at ?? source.payload.timestamp ?? source.captured_at;
    check(validDate(observed), '观察时间无效');
    return { subject: input.subject.trim(), predicate: input.predicate.trim(), value: input.value, modality: input.modality, source_mode: input.source_mode, source_id: source.id, quote: input.quote, kind: input.kind ?? 'observation', state: confirmed ? 'confirmed' : 'proposed', observed_at: observed };
  }
  _insert(scope, clean, supersedes = null) {
    const id = randomUUID();
    this.db.prepare('INSERT INTO yunshu_observations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, scope, clean.subject, clean.predicate, JSON.stringify(clean.value), clean.modality, clean.source_mode, clean.source_id, clean.quote, clean.kind, clean.state, 1, clean.observed_at, stamp(), supersedes);
    return this.observation(scope, id);
  }
  add(scope, input, { confirmed = false } = {}) {
    return this.store.transaction(() => this.addInTransaction(scope, input, { confirmed }));
  }
  // The auto-memory cursor and all observations must commit together.
  addInTransaction(scope, input, { confirmed = false } = {}) {
    const clean = this._validate(scope, input, confirmed);
    const old = this.db.prepare('SELECT * FROM yunshu_observations WHERE scope=? AND subject=? AND predicate=? AND value=? AND modality=? AND source_mode=? AND source_id=? AND quote=? AND kind=? AND observed_at=? ORDER BY created_at,id LIMIT 1').get(scope,clean.subject,clean.predicate,JSON.stringify(clean.value),clean.modality,clean.source_mode,clean.source_id,clean.quote,clean.kind,clean.observed_at);
    if (old) {
      if (confirmed && old.state === 'proposed') this.db.prepare("UPDATE yunshu_observations SET state='confirmed',version=version+1 WHERE id=?").run(old.id);
      return this.observation(scope,old.id);
    }
    return this._insert(scope, clean);
  }
  observation(scope, id) { this.store.open(); return decodeObservation(this.db.prepare('SELECT * FROM yunshu_observations WHERE scope=? AND id=?').get(scope, id)); }
  list(scope, { state, limit = 100 } = {}) {
    this.store.open(); check(Number.isSafeInteger(limit) && limit > 0 && limit <= 1000, '观察分页上限无效');
    return this.db.prepare('SELECT o.* FROM yunshu_observations o JOIN yunshu_sources s ON s.id=o.source_id WHERE o.scope=? AND s.withdrawn=0 AND (? IS NULL OR o.state=?) ORDER BY o.created_at DESC,o.id LIMIT ?').all(scope, state ?? null, state ?? null, limit).map(decodeObservation);
  }
  decide(scope, id, version, accept) {
    return this.store.transaction(() => {
      const row = this.observation(scope, id); check(row, '观察不存在', 'NOT_FOUND');
      check(row.version === version && row.state === 'proposed', '观察已更新，请刷新', 'VERSION_CONFLICT');
      check(this.source(scope, row.source_id), '来源已撤回', 'SOURCE_REQUIRED');
      this.db.prepare('UPDATE yunshu_observations SET state=?,version=version+1 WHERE scope=? AND id=?').run(accept ? 'confirmed' : 'withdrawn', scope, id);
      return this.observation(scope, id);
    });
  }
  correct(scope, id, version, input) {
    return this.store.transaction(() => {
      const old = this.observation(scope, id); check(old, '观察不存在', 'NOT_FOUND');
      check(old.version === version && old.state === 'confirmed', '观察已更新或不是当前确认版本', 'VERSION_CONFLICT');
      const clean = this._validate(scope, input, true);
      check(clean.subject === old.subject && clean.predicate === old.predicate, '纠正必须指向同一对象和属性');
      const next = this._insert(scope, clean, id);
      this.db.prepare("UPDATE yunshu_observations SET state='superseded',version=version+1 WHERE scope=? AND id=?").run(scope, id);
      return next;
    });
  }
  withdraw(scope, id, version) {
    return this.store.transaction(() => {
      const old = this.observation(scope, id); check(old, '观察不存在', 'NOT_FOUND');
      check(old.version === version, '观察已更新', 'VERSION_CONFLICT');
      this.db.prepare("UPDATE yunshu_observations SET state='withdrawn',version=version+1 WHERE scope=? AND id=?").run(scope, id);
      return this.observation(scope, id);
    });
  }
  withdrawSource(scope, id) {
    return this.store.transaction(() => {
      check(this.source(scope, id, { includeWithdrawn: true }), '来源不存在', 'NOT_FOUND');
      this.db.prepare('UPDATE yunshu_sources SET withdrawn=1 WHERE scope=? AND id=?').run(scope, id);
      return { id, withdrawn: true, physicallyErased: false };
    });
  }
  isWithdrawn(scope, row) {
    const start = row.start_seq ?? row.event_seq, end = row.end_seq ?? row.event_seq;
    return Number.isSafeInteger(start) && Number.isSafeInteger(end) && !!this.db.prepare('SELECT 1 FROM yunshu_sources WHERE scope=? AND session_id=? AND event_seq>=? AND event_seq<=? AND withdrawn=1 LIMIT 1').get(scope, row.session_id, start, end);
  }
  export(scope) {
    this.store.open();
    const count = this.db.prepare('SELECT (SELECT COUNT(*) FROM yunshu_sources WHERE scope=?) AS sources,(SELECT COUNT(*) FROM yunshu_observations WHERE scope=?) AS observations').get(scope, scope);
    check(count.sources <= 10000 && count.observations <= 10000, '证据超过JSON备份上限，请停机复制完整数据目录', 'CAPACITY');
    return { format: 'yunshu-evidence-v1', scope, sources: this.db.prepare('SELECT * FROM yunshu_sources WHERE scope=? ORDER BY session_id,event_seq').all(scope).map(row => decodeSource(row, this._payloadText(row))), observations: this.db.prepare('SELECT * FROM yunshu_observations WHERE scope=? ORDER BY created_at,id').all(scope).map(decodeObservation) };
  }
  validateBackup(scope, packet) {
    check(packet?.format === 'yunshu-evidence-v1' && packet.scope === scope && Array.isArray(packet.sources) && Array.isArray(packet.observations) && packet.sources.length <= 10000 && packet.observations.length <= 10000, '证据备份格式无效');
    const sourceIds = new Map(), observationIds = new Map();
    const sources = packet.sources.map(r => {
      check(r && r.scope === scope && text(r.session_id, 200) && Number.isSafeInteger(r.event_seq) && r.event_seq >= 0 && ['user', 'assistant','owner'].includes(r.role) && typeof r.withdrawn === 'boolean' && validDate(r.captured_at), '证据来源标识无效');
      check(r.id === contentHash([scope, r.session_id, r.event_seq]) && !sourceIds.has(r.id), '证据来源重复或标识不匹配');
      const p = r.payload;
      check(p?.format === 'yunshu-public-source-v1' && (r.role==='owner' ? p.type==='owner/attachment' && r.session_id.startsWith('owner-import:') && p.parts?.length===1 : p.type===r.role+'/message') && Array.isArray(p.parts) && p.parts.length > 0 && p.parts.every(part => part && (part.type === 'text' ? typeof part.text === 'string' : ['image','audio','video','file'].includes(part.type) && part.mediaBytesVerified === false && part.capture === (r.role==='owner'?'owner-selected-file':'message-payload-only'))) && Array.isArray(p.omittedTypes) && p.omittedTypes.every(v => typeof v === 'string') && typeof p.interrupted === 'boolean' && p.coverage === (r.role==='owner'?'owner-selected-file':'public-content-parts') && (p.timestamp === null || validDate(p.timestamp)), '证据来源内容无效');
      const body = stableJson(p); check(contentHash(body) === r.content_hash, '原件哈希不匹配');
      const clean = { id: r.id, scope, session_id: r.session_id, event_seq: r.event_seq, role: r.role, payload: JSON.parse(body), content_hash: r.content_hash, captured_at: r.captured_at, withdrawn: r.withdrawn };
      sourceIds.set(r.id, clean); return clean;
    });
    const observations = packet.observations.map(r => {
      check(r && text(r.id, 200) && r.scope === scope && !observationIds.has(r.id) && ['proposed','confirmed','superseded','withdrawn'].includes(r.state) && Number.isSafeInteger(r.version) && r.version > 0 && validDate(r.created_at) && (r.supersedes === null || text(r.supersedes, 200)), '观察备份标识或状态无效');
      const clean = this._validate(scope, r, r.state === 'confirmed', id => sourceIds.get(id));
      const row = { id: r.id, scope, ...clean, state: r.state, version: r.version, created_at: r.created_at, supersedes: r.supersedes };
      observationIds.set(row.id, row); return row;
    });
    const children = new Set();
    for (const row of observations) if (row.supersedes) {
      const prior = observationIds.get(row.supersedes);
      check(prior && prior.subject === row.subject && prior.predicate === row.predicate && ['superseded','withdrawn'].includes(prior.state) && !children.has(prior.id), '纠正来源链无效'); children.add(prior.id);
      const seen = new Set([row.id]); let cursor = prior;
      while (cursor) { check(!seen.has(cursor.id), '纠正来源链形成循环'); seen.add(cursor.id); cursor = cursor.supersedes ? observationIds.get(cursor.supersedes) : null; }
    }
    return { sources, observations };
  }
  // Called inside MemorySystem.restoreLayers' single transaction.
  restoreValidated(packet) {
    for (const r of packet.sources) this._insertSource({ ...r, payload: stableJson(r.payload) });
    // Insert roots first regardless of equal timestamps / input order.
    const pending = new Map(packet.observations.map(r => [r.id,r]));
    while (pending.size) for (const [id,r] of pending) if (!r.supersedes || !pending.has(r.supersedes)) {
      this.db.prepare('INSERT INTO yunshu_observations VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(r.id,r.scope,r.subject,r.predicate,JSON.stringify(r.value),r.modality,r.source_mode,r.source_id,r.quote,r.kind,r.state,r.version,r.observed_at,r.created_at,r.supersedes); pending.delete(id);
    }
  }
  search(scope, query, { limit = 10 } = {}) {
    this.store.open(); check(typeof query === 'string' && query.length <= 4000 && Number.isInteger(limit) && limit > 0 && limit <= 100, '观察查询无效');
    const terms = tokens(query); if (!terms.length) return [];
    // Complete scope scan using an iterator: no silent newest-1000 cutoff.
    const best = [];
    for (const raw of this.db.prepare("SELECT o.* FROM yunshu_observations o JOIN yunshu_sources s ON s.id=o.source_id WHERE o.scope=? AND o.state='confirmed' AND s.withdrawn=0").iterate(scope)) {
      const row = decodeObservation(raw), have = new Set(tokens([row.subject, row.predicate, row.value].join(' ')));
      const score = terms.filter(t => have.has(t)).length / terms.length;
      if (score > 0) best.push({ ...row, score });
      best.sort((a, b) => b.score - a.score || compareId(b.observed_at, a.observed_at) || compareId(a.id, b.id));
      if (best.length > limit) best.pop();
    }
    return best;
  }
}

