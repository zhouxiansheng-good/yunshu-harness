import { RecallLineage, lineageHeader, unwrapLineage } from './recall-lineage.mjs';
import { currentPromotion } from './promoted-provenance.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { MemoryStore, MemoryError, tokens, cosine } from './store.mjs';
import { EvidenceMemory } from './evidence-memory.mjs';

// Recovered contracts: core/master, completed-round fields, window thresholds,
// timestamp-ordered snapshots and global keyword fallback. Event adaptation,
// idempotence and ranking are explicit reconstructions, not recovered source.
export const MEMORY_DEFAULTS = Object.freeze({ coreLimit: 30, shortTermLimit: 50, slideCount: 10, snapshotCount: 20, searchCount: 5, maxContextTokens: 1600, contextCapacityTokens: 0, archiveThresholdPercent: 85 });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const now = () => new Date().toISOString();
const check = (condition, message, code = 'INVALID_INPUT') => { if (!condition) throw new MemoryError(code, message); };
const text = (value, max = 100000) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const jsonCopy = value => JSON.parse(JSON.stringify(value));
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const entryContent = row => row.user_input + '\n' + row.assistant_response;
const projectPublicText = (original, sourceId) => original.length <= 100000 ? original : original.slice(0, 48000) + '\n[原话节选；完整原件 ID: ' + sourceId + ']\n' + original.slice(-48000);
const newest = (a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp) || a.session_id.localeCompare(b.session_id) || b.event_seq - a.event_seq || a.id.localeCompare(b.id);
const eventColumns = 'id,scope,session_id,event_seq,role,content,created_at,terminal,has_tool_calls,resonance,authenticated,archived';
const roundColumns = 'id,scope,session_id,start_seq,end_seq,timestamp,user_input,assistant_response,importance,authenticated,authentication_known,tag,deleted,content_hash,created_at,archived_at';
// Conservative local fallback; callers may supply a model tokenizer. Not an
// assertion of the original tokenizer or the model's exact context capacity.
export function estimateTokens(value) { return Math.ceil(Buffer.byteLength(value, 'utf8') / 3); }
export class MemorySystem extends MemoryStore {
  constructor(filename, options = {}) {
    super(filename);
    this.options = { ...MEMORY_DEFAULTS, ...options };
    this.identityScope = options.identityScope ?? 'owner:default';
    check(text(this.identityScope, 300), '个人记忆范围无效');
    for (const key of Object.keys(MEMORY_DEFAULTS).filter(k => k !== 'contextCapacityTokens')) check(Number.isSafeInteger(this.options[key]) && this.options[key] > 0 && this.options[key] <= 10000, '记忆参数无效：' + key);
    check(Number.isSafeInteger(this.options.contextCapacityTokens) && this.options.contextCapacityTokens >= 0 && this.options.contextCapacityTokens <= 2000000 && this.options.archiveThresholdPercent <= 100, '上下文容量无效');
    check(this.options.slideCount <= this.options.shortTermLimit, '归档数量不能超过窗口数量');
    this.db.exec([
      'CREATE TABLE IF NOT EXISTS memory_documents(owner TEXT NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL,version TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(owner,kind));',
      'CREATE TABLE IF NOT EXISTS document_history(seq INTEGER PRIMARY KEY,owner TEXT NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL,version TEXT NOT NULL,updated_at TEXT NOT NULL);',
      'CREATE TABLE IF NOT EXISTS conversation_window(id TEXT PRIMARY KEY,scope TEXT NOT NULL,session_id TEXT NOT NULL,event_seq INTEGER NOT NULL,role TEXT NOT NULL,content TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(scope,session_id,event_seq));',
      'CREATE INDEX IF NOT EXISTS conversation_window_session ON conversation_window(scope,session_id,event_seq);',
      'CREATE TABLE IF NOT EXISTS conversation_archive(id TEXT PRIMARY KEY,scope TEXT NOT NULL,session_id TEXT NOT NULL,event_seq INTEGER NOT NULL,role TEXT NOT NULL,content TEXT NOT NULL,created_at TEXT NOT NULL,archived_at TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,content_hash TEXT NOT NULL,UNIQUE(scope,session_id,event_seq));',
      'CREATE INDEX IF NOT EXISTS conversation_archive_scope ON conversation_archive(scope,deleted,archived_at);',
      'CREATE TABLE IF NOT EXISTS conversation_vectors(id TEXT PRIMARY KEY REFERENCES conversation_archive(id),model TEXT NOT NULL,dimension INTEGER NOT NULL,content_hash TEXT NOT NULL,vector TEXT NOT NULL);',
      'CREATE TABLE IF NOT EXISTS vector_models(scope TEXT PRIMARY KEY,model TEXT NOT NULL,dimension INTEGER NOT NULL);',
      'CREATE TABLE IF NOT EXISTS recent_snapshots(scope TEXT PRIMARY KEY,entries TEXT NOT NULL,updated_at TEXT NOT NULL);',
      // Additive v2 tables. Old per-message tables stay intact and readable;
      // missing tool/auth metadata is never guessed to manufacture old rounds.
      'CREATE TABLE IF NOT EXISTS conversation_events(id TEXT PRIMARY KEY,scope TEXT NOT NULL,session_id TEXT NOT NULL,event_seq INTEGER NOT NULL,role TEXT NOT NULL,content TEXT NOT NULL,created_at TEXT NOT NULL,terminal INTEGER NOT NULL,has_tool_calls INTEGER NOT NULL,resonance INTEGER NOT NULL,authenticated INTEGER,archived INTEGER NOT NULL DEFAULT 0,UNIQUE(scope,session_id,event_seq));',
      'CREATE INDEX IF NOT EXISTS conversation_events_session ON conversation_events(scope,session_id,event_seq);',
      'CREATE TABLE IF NOT EXISTS conversation_rounds(id TEXT PRIMARY KEY,scope TEXT NOT NULL,session_id TEXT NOT NULL,start_seq INTEGER NOT NULL,end_seq INTEGER NOT NULL,timestamp TEXT NOT NULL,user_input TEXT NOT NULL,assistant_response TEXT NOT NULL,importance REAL NOT NULL,authenticated INTEGER NOT NULL,authentication_known INTEGER NOT NULL,tag TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,content_hash TEXT NOT NULL,created_at TEXT NOT NULL,archived_at TEXT,UNIQUE(scope,session_id,end_seq));',
      'CREATE INDEX IF NOT EXISTS conversation_rounds_scope ON conversation_rounds(scope,deleted,tag,timestamp);',
      'CREATE TABLE IF NOT EXISTS round_vectors(id TEXT PRIMARY KEY REFERENCES conversation_rounds(id),model TEXT NOT NULL,dimension INTEGER NOT NULL,content_hash TEXT NOT NULL,vector TEXT NOT NULL);',
    ].join('\n'));
    if (!this.db.prepare('PRAGMA table_info(conversation_window)').all().some(c => c.name === 'terminal')) this.db.exec('ALTER TABLE conversation_window ADD COLUMN terminal INTEGER NOT NULL DEFAULT 0');
    if (!this.db.prepare('PRAGMA table_info(conversation_archive)').all().some(c => c.name === 'tag')) this.db.exec("ALTER TABLE conversation_archive ADD COLUMN tag TEXT NOT NULL DEFAULT 'archived'");
    this.evidence = new EvidenceMemory(this);
    this.lineage = new RecallLineage(this.db);
  }
  document(kind) {
    this.open();
    let row = this.db.prepare('SELECT * FROM memory_documents WHERE owner=? AND kind=?').get(this.identityScope, kind);
    if (!row) {
      const body = kind === 'core' ? [] : { identity: {}, preferences: {}, personality: {}, current_state: {}, notes: [] };
      this.db.prepare('INSERT OR IGNORE INTO memory_documents VALUES(?,?,?,?,?)').run(this.identityScope, kind, JSON.stringify(body), randomUUID(), now());
      row = this.db.prepare('SELECT * FROM memory_documents WHERE owner=? AND kind=?').get(this.identityScope, kind);
    }
    return { content: JSON.parse(row.body), version: row.version, updated_at: row.updated_at };
  }
  core() { const { content, version } = this.document('core'); return { content, version }; }
  master() { const { content, updated_at } = this.document('master'); return { content, updated_at }; }
  _document(kind, content) {
    const previous = this.document(kind), updated = now(), version = randomUUID();
    this.db.prepare('INSERT INTO document_history(owner,kind,body,version,updated_at) VALUES(?,?,?,?,?)').run(this.identityScope, kind, JSON.stringify(previous.content), previous.version, previous.updated_at);
    this.db.prepare('UPDATE memory_documents SET body=?,version=?,updated_at=? WHERE owner=? AND kind=?').run(JSON.stringify(content), version, updated, this.identityScope, kind);
    return kind === 'core' ? { content, version } : { content, updated_at: updated };
  }
  saveCore(content, version) {
    check(Array.isArray(content) && content.length <= this.options.coreLimit, '核心事实数量超限或格式错误');
    const ids = new Set();
    const clean = content.map(entry => {
      check(object(entry) && text(entry.id, 200) && !ids.has(entry.id) && text(entry.content, 12000), '核心事实格式错误');
      check(typeof entry.created_at === 'string' && Number.isFinite(Date.parse(entry.created_at)) && typeof entry.updated_at === 'string' && Number.isFinite(Date.parse(entry.updated_at)), '核心事实时间无效');
      ids.add(entry.id);
      return { id: entry.id, content: entry.content.trim(), created_at: entry.created_at, updated_at: entry.updated_at };
    });
    return this.transaction(() => {
      check(typeof version === 'string' && version === this.core().version, '内容已更新，请刷新后重试', 'VERSION_CONFLICT');
      return this._document('core', clean);
    });
  }
  saveMaster(content) {
    check(object(content) && JSON.stringify(content).length <= 50000, '个人档案格式错误或内容过长');
    // Master is a separate structured document; do not invent a core-style CAS
    // contract or silently infer/overwrite it from assistant output.
    return this.transaction(() => this._document('master', jsonCopy(content)));
  }
  acceptCoreProposal(scope, id, version) {
    return this.transaction(() => {
      const proposal = this.db.prepare("SELECT * FROM proposals WHERE id=? AND scope=? AND kind='core' AND state='pending'").get(id, scope);
      check(proposal, '待确认事实不存在', 'NOT_FOUND');
      const current = this.core(); check(current.version === version, '内容已更新，请刷新后重试', 'VERSION_CONFLICT');
      check(current.content.length < this.options.coreLimit, '核心事实数量已达上限', 'CAPACITY');
      const stamp = now(), entry = { id: randomUUID(), content: proposal.content, created_at: stamp, updated_at: stamp };
      const saved = this._document('core', [...current.content, entry]);
      this.db.prepare("UPDATE proposals SET state='accepted' WHERE id=?").run(id);
      return { id, state: 'accepted', core: saved };
    });
  }
  _searchEligible(scope, row) { return currentPromotion(this, scope, row); }
  searchMemory(scope, query, semantic = {}) {
    const context = this.structuredContext(scope, query, { ...semantic, maxTokens: this.options.maxContextTokens });
    return { personal: context.records.filter(r => r.layer === 'core' || r.layer === 'master'), conversations: this.recall(scope, query, semantic), notes: this.search(scope, query, semantic), observations: this.evidence.search(scope, query) };
  }
  ingest(scope, sessionId, event, { authenticated = null, answerBasis = null } = {}) {
    this.open();
    // Durable public evidence is independent of text-only completed-round
    // projection. Interrupted replies and attachment-only messages survive.
    const captured = this.evidence.capture(scope, sessionId, event);
    if (!['user/message', 'assistant/message'].includes(event?.type)) return { ignored: true };
    check(text(scope, 300) && text(sessionId, 200) && Number.isSafeInteger(event.seq) && event.seq >= 0, '对话事件标识无效');
    check(authenticated === null || typeof authenticated === 'boolean', '认证元数据无效');
    const user = event.type === 'user/message', message = user ? event.data : event.data?.message;
    if ((user && message?.source?.kind !== 'user') || (!user && event.data?.interrupted)) return { ignored: true };
    const parts = Array.isArray(message?.content) ? message.content : [];
    const original = parts.filter(p => p.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n');
    // The round/search projection is bounded; the full public input remains
    // available by source ID in the same SQLite archive.
    const content = projectPublicText(original, captured.id);
    const hasTools = !user && (parts.some(p => p.type === 'tool-call') || (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0));
    const resonance = !user && (message?._resonance === true || event.data?._resonance === true);
    if (!content.trim() && !hasTools) return { ignored: true };
    check(content.length <= 100000, '对话文字过长');
    const id = hash([scope, sessionId, event.seq]), role = user ? 'user' : 'assistant';
    const terminal = !user && !hasTools && !resonance;
    const suppliedTimestamp = event.timestamp ?? message?.timestamp;
    check(suppliedTimestamp === undefined || date(suppliedTimestamp), '对话时间无效');
    const stamp = suppliedTimestamp ?? now(), auth = authenticated === null ? null : +authenticated;
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM conversation_events WHERE id=?').get(id);
      if (existing) {
        check(existing.content === content && existing.role === role && existing.terminal === +terminal && existing.has_tool_calls === +hasTools && existing.resonance === +resonance && existing.authenticated === auth && (suppliedTimestamp === undefined || existing.created_at === stamp), '对话事件内容或元数据冲突', 'EVENT_CONFLICT');
        return { duplicate: true };
      }
      const legacy = this.db.prepare('SELECT content,role FROM conversation_window WHERE id=? UNION ALL SELECT content,role FROM conversation_archive WHERE id=?').all(id, id);
      if (legacy.length) {
        check(legacy.every(r => r.content === content && r.role === role), '旧对话事件内容冲突', 'EVENT_CONFLICT');
        return { duplicate: true, legacy: true };
      }
      const last = this.db.prepare('SELECT MAX(event_seq) AS seq FROM conversation_events WHERE scope=? AND session_id=?').get(scope, sessionId).seq;
      check(last === null || event.seq > last, '对话事件必须按序保存；重复事件可重放', 'EVENT_ORDER');
      this.db.prepare('INSERT INTO conversation_events(' + eventColumns + ') VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id, scope, sessionId, event.seq, role, content, stamp, +terminal, +hasTools, +resonance, auth, 0);
      let archived = 0;
      let completedEntryId = null;
      if (terminal) {
        completedEntryId = this._persistCompleted(scope, sessionId, event.seq);
        if (completedEntryId) this.lineage.bind(scope, sessionId, completedEntryId, answerBasis);
        archived = this._slideWindow(scope, sessionId).archived;
      }
      return { id, archived, completedEntryId };
    });
  }
  _events(scope, sessionId) {
    return this.db.prepare('SELECT * FROM conversation_events WHERE scope=? AND (? IS NULL OR session_id=?) ORDER BY session_id,event_seq').all(scope, sessionId ?? null, sessionId ?? null);
  }
  _eventView(row) { return { ...row, grain: 'event', metadata_complete: true }; }
  _legacyView(row) { return { ...row, grain: 'legacy_message', metadata_complete: false, timestamp: row.created_at }; }
  _roundView(row) {
    return { ...row, authenticated: !!row.authenticated, authentication_known: !!row.authentication_known, grain: 'round', event_seq: row.end_seq, role: 'conversation', content: entryContent(row) };
  }
  window(scope, sessionId) {
    this.open();
    const legacy = this.db.prepare('SELECT * FROM conversation_window WHERE scope=? AND (? IS NULL OR session_id=?)').all(scope, sessionId ?? null, sessionId ?? null).map(r => this._legacyView(r));
    return [...legacy, ...this._events(scope, sessionId).filter(r => !r.archived).map(r => this._eventView(r))].sort((a, b) => a.session_id.localeCompare(b.session_id) || a.event_seq - b.event_seq);
  }
  _completeRounds(rows) {
    const rounds = []; let begin = 0;
    rows.forEach((row, i) => { if (row.terminal) { rounds.push(rows.slice(begin, i + 1)); begin = i + 1; } });
    return rounds;
  }
  _persistCompleted(scope, sessionId, endSeq) {
    // Native: one entry per terminal round, joined user inputs, last final
    // answer, first user timestamp. UUID plus end-seq uniqueness is the local
    // idempotence adapter; native duplicate matching has not been recovered.
    const prior = this.db.prepare('SELECT MAX(event_seq) AS seq FROM conversation_events WHERE scope=? AND session_id=? AND terminal=1 AND event_seq<?').get(scope, sessionId, endSeq).seq ?? -1;
    const rows = this.db.prepare('SELECT * FROM conversation_events WHERE scope=? AND session_id=? AND event_seq>? AND event_seq<=? ORDER BY event_seq').all(scope, sessionId, prior, endSeq);
    const users = rows.filter(r => r.role === 'user' && r.content.trim()), answers = rows.filter(r => r.role === 'assistant' && r.terminal && r.content.trim());
    if (!users.length || !answers.length) return null;
    const first = users[0], final = answers.at(-1), id = randomUUID();
    const known = final.authenticated !== null, authenticated = final.authenticated === 1;
    const userInput = users.map(r => r.content).join('\n'), response = final.content;
    this.db.prepare('INSERT INTO conversation_rounds(' + roundColumns + ') VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, scope, sessionId, rows[0].event_seq, endSeq, first.created_at, userInput, response, authenticated ? 0.8 : 0.3, +authenticated, +known, 'current_window', 0, hash(entryContent({ user_input: userInput, assistant_response: response })), now(), null);
    return id;
  }
  checkAndSlideWindow(scope, sessionId, options = {}) { return this.transaction(() => this._slideWindow(scope, sessionId, options)); }
  _slideWindow(scope, sessionId, { contextTokens = null, projectedTokens = null, forceTokenArchive = false, protectedEndSeqs = [] } = {}) {
    for (const value of [contextTokens, projectedTokens]) check(value === null || (Number.isSafeInteger(value) && value >= 0), '上下文用量无效');
    check(typeof forceTokenArchive === 'boolean' && Array.isArray(protectedEndSeqs) && protectedEndSeqs.every(v => Number.isSafeInteger(v) && v >= 0), '归档条件无效');
    const rounds = this._completeRounds(this._events(scope, sessionId).filter(r => !r.archived));
    const capacity = this.options.contextCapacityTokens, threshold = Math.trunc(capacity * this.options.archiveThresholdPercent / 100);
    const roundTriggered = rounds.length > this.options.shortTermLimit;
    const tokenTriggered = forceTokenArchive || (contextTokens !== null && threshold > 0 && contextTokens >= threshold) || (projectedTokens !== null && capacity > 0 && projectedTokens >= capacity);
    if (!roundTriggered && !tokenTriggered) return { archived: 0, rounds: 0, roundTriggered, tokenTriggered };
    // Explicit protection adapter; native authentication rules are not guessed.
    const protectedEnds = new Set(protectedEndSeqs), selected = rounds.filter(round => {
      const end = round.at(-1);
      return !protectedEnds.has(end.event_seq) && this.db.prepare("SELECT id FROM conversation_rounds WHERE scope=? AND session_id=? AND end_seq=? AND tag='current_window'").get(scope, sessionId, end.event_seq);
    }).slice(0, this.options.slideCount);
    const archived = this._archive(scope, selected);
    return { archived, rounds: selected.length, roundTriggered, tokenTriggered };
  }
  _archive(scope, rounds) {
    let archived = 0;
    for (const rows of rounds) {
      const final = rows.at(-1);
      const result = this.db.prepare("UPDATE conversation_rounds SET tag='recent',importance=0.7,archived_at=COALESCE(archived_at,?) WHERE scope=? AND session_id=? AND end_seq=? AND tag='current_window'").run(now(), scope, final.session_id, final.event_seq);
      if (!result.changes) continue; // Orphan answers / legacy data are not invented rounds.
      for (const r of rows) this.db.prepare('UPDATE conversation_events SET archived=1 WHERE id=?').run(r.id);
      archived += Number(result.changes);
    }
    this._demoteRecent(scope); this._snapshot(scope);
    return archived; // Completed entries, never message count.
  }
  archive(scope, sessionId) { return this.transaction(() => this._archive(scope, this._completeRounds(this._events(scope, sessionId).filter(r => !r.archived)))); }
  archives(scope, { limit = 100, includeDeleted = false, includeCurrent = false, includeLegacy = true } = {}) {
    this.open(); check(Number.isInteger(limit) && limit > 0 && limit <= 10000, '查询数量无效');
    const rows = this.db.prepare("SELECT * FROM conversation_rounds WHERE scope=? AND (? OR deleted=0) AND (? OR tag!='current_window')").all(scope, +includeDeleted, +includeCurrent).map(r => this._roundView(r));
    const legacy = includeLegacy ? this.db.prepare("SELECT * FROM conversation_archive WHERE scope=? AND (? OR deleted=0) AND (? OR tag!='current_window')").all(scope, +includeDeleted, +includeCurrent).map(r => this._legacyView(r)) : [];
    return [...rows, ...legacy].filter(r => includeDeleted || !this.evidence.isWithdrawn(scope, r)).sort(newest).slice(0, limit);
  }
  _demoteRecent(scope) {
    const recent = this.db.prepare("SELECT * FROM conversation_rounds WHERE scope=? AND deleted=0 AND tag='recent'").all(scope).map(r => this._roundView(r)).sort(newest);
    for (const r of recent.slice(this.options.snapshotCount)) this.db.prepare("UPDATE conversation_rounds SET tag='archived' WHERE id=? AND tag='recent'").run(r.id);
  }
  _projectSnapshot(scope) {
    return this.archives(scope, { limit: this.options.snapshotCount, includeLegacy: false }).map(r => ({ ...r, tag: 'snapshot' }));
  }
  _snapshot(scope) {
    const entries = this._projectSnapshot(scope);
    this.db.prepare('INSERT INTO recent_snapshots VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET entries=excluded.entries,updated_at=excluded.updated_at').run(scope, JSON.stringify(entries), now());
    return entries;
  }
  recent(scope) { this.open(); return this._projectSnapshot(scope); }
  // A transcript remains readable in history, but is not an independent live fact.
  // Filter before lexical/vector scoring and before the continuity shortcut takes its first row.
  _recallableRounds(scope, excludeSession) {
    const rows = this.archives(scope, { limit: 10000, includeCurrent: true, includeLegacy: false });
    const closed = this.db.prepare(`SELECT s.id,s.session_id,s.event_seq FROM yunshu_sources s
      WHERE s.scope=? AND s.withdrawn=1 UNION
      SELECT s.id,s.session_id,s.event_seq FROM yunshu_observations o JOIN yunshu_sources s
      ON s.scope=o.scope AND s.id=o.source_id WHERE o.scope=? AND o.state IN ('superseded','withdrawn')`).all(scope,scope);
    const ids = new Set(), sessions = new Map();
    for (const r of closed) {
      ids.add(r.id); if (!sessions.has(r.session_id)) sessions.set(r.session_id, []);
      sessions.get(r.session_id).push(r.event_seq);
    }
    for (const seq of sessions.values()) seq.sort((a,b) => a-b);
    const status = this.lineage.status(scope);
    return rows.filter(r => {
      if (r.session_id === excludeSession || status.get(r.id)?.blocked) return false;
      if (!ids.size) return true;
      const seq = sessions.get(r.session_id) ?? [];
      let lo = 0, hi = seq.length;
      while (lo < hi) { const mid = (lo+hi) >>> 1; if (seq[mid] < r.start_seq) lo = mid+1; else hi = mid; }
      if (lo < seq.length && seq[lo] <= r.end_seq) return false;
      // A later assistant can repeat the fact, including its citation. One scan of the text;
      // do not block unrelated rounds by comparing short/common preference values.
      return !(r.content.match(/(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/gi) ?? []).some(id => ids.has(id.toLowerCase()));
    }).map(r => ids.size && !status.get(r.id)?.known
      ? { ...r, assistant_response: '', content: r.user_input, lineageRedacted: true } : r); // legacy: keep the user’s independent words, not an untraceable assistant echo
  }
  recentForRecall(scope, excludeSession, limit = 1) {
    check(Number.isInteger(limit) && limit > 0 && limit <= 100, '近期查询数量无效');
    return this._recallableRounds(scope, excludeSession).slice(0, limit);
  }
  withdrawArchive(scope, id) {
    return this.transaction(() => {
      const round = this.db.prepare('UPDATE conversation_rounds SET deleted=1 WHERE scope=? AND id=? AND deleted=0').run(scope, id);
      const legacy = this.db.prepare('UPDATE conversation_archive SET deleted=1 WHERE scope=? AND id=? AND deleted=0').run(scope, id);
      this.db.prepare('DELETE FROM round_vectors WHERE id IN (SELECT id FROM conversation_rounds WHERE scope=? AND deleted=1)').run(scope);
      this.db.prepare('DELETE FROM conversation_vectors WHERE id IN (SELECT id FROM conversation_archive WHERE scope=? AND deleted=1)').run(scope);
      this._snapshot(scope); return { withdrawn: Number(round.changes) + Number(legacy.changes) };
    });
  }
  indexCandidates(model, limit = 8) {
    this.open();check(text(model,300)&&Number.isInteger(limit)&&limit>0&&limit<=100,'索引条件无效');
    return this.db.prepare('SELECT r.* FROM conversation_rounds r LEFT JOIN round_vectors v ON v.id=r.id AND v.model=? AND v.content_hash=r.content_hash WHERE r.deleted=0 AND v.id IS NULL ORDER BY r.timestamp,r.id LIMIT ?').all(model,limit).map(r=>({...r,content:entryContent(r)}));
  }
  indexProgress(scope, model) {
    this.open();
    const row=this.db.prepare('SELECT COUNT(*) AS total,COUNT(v.id) AS indexed FROM conversation_rounds r LEFT JOIN round_vectors v ON v.id=r.id AND v.model=? AND v.content_hash=r.content_hash WHERE r.scope=? AND r.deleted=0').get(model,scope);
    return {total:row.total,indexed:row.indexed,pending:row.total-row.indexed};
  }
  clearRoundVectors(scope) { return this.transaction(()=>this.db.prepare('DELETE FROM round_vectors WHERE id IN (SELECT id FROM conversation_rounds WHERE scope=?)').run(scope)); }
  setArchiveVector(scope, id, model, vector, { expectedHash } = {}) {
    check(text(model, 300) && Array.isArray(vector) && vector.length > 0 && vector.length <= 16000 && vector.every(Number.isFinite), '向量格式无效');
    return this.transaction(() => {
      const round = this.db.prepare('SELECT * FROM conversation_rounds WHERE scope=? AND id=? AND deleted=0').get(scope, id);
      const row = round ?? this.db.prepare('SELECT * FROM conversation_archive WHERE scope=? AND id=? AND deleted=0').get(scope, id);
      check(row, '归档不存在', 'NOT_FOUND');
      if(expectedHash!==undefined&&row.content_hash!==expectedHash)return {indexed:false,stale:true};
      const previous = this.db.prepare('SELECT * FROM vector_models WHERE scope=?').get(scope);
      if (previous && (previous.model !== model || previous.dimension !== vector.length)) {
        this.db.prepare('DELETE FROM conversation_vectors WHERE id IN (SELECT id FROM conversation_archive WHERE scope=?)').run(scope);
        this.db.prepare('DELETE FROM round_vectors WHERE id IN (SELECT id FROM conversation_rounds WHERE scope=?)').run(scope);
      }
      this.db.prepare('INSERT INTO vector_models VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET model=excluded.model,dimension=excluded.dimension').run(scope, model, vector.length);
      this.db.prepare('INSERT INTO ' + (round ? 'round_vectors' : 'conversation_vectors') + ' VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET model=excluded.model,dimension=excluded.dimension,content_hash=excluded.content_hash,vector=excluded.vector').run(id, model, vector.length, row.content_hash, JSON.stringify(vector));
      return { indexed: true };
    });
  }
  recall(scope, query, { limit = this.options.searchCount, vector, model, excludeSession } = {}) {
    check(typeof query === 'string' && query.length <= 4000 && Number.isInteger(limit) && limit > 0 && limit <= 100, '查询无效');
    this.open();
    if (!query.trim()) return [];
    check(vector === undefined || (Array.isArray(vector) && vector.length <= 16000 && vector.every(Number.isFinite)), '查询向量无效');
    const semanticRoute = Array.isArray(vector) && vector.length > 0 && text(model, 300);
    const terms = tokens(query), ranked = [];
    // Retrieval visibility is independent of the archive/sliding lifecycle.
    // A completed current round can be found in another session immediately.
    // Missing/stale vectors retain lexical retrieval during index warm-up.
    // Legacy messages stay readable in archives(), outside the round path.
    for (const row of this._recallableRounds(scope, excludeSession)) {
      const have = new Set(tokens(row.content));
      const lexical = terms.length ? terms.filter(t => have.has(t)).length / terms.length : 0;
      let semantic = 0;
      if (semanticRoute) {
        const index = this.db.prepare('SELECT * FROM round_vectors WHERE id=? AND model=? AND content_hash=? AND dimension=?').get(row.id, model, row.content_hash, vector.length);
        if (index) {
          const similarity = cosine(vector, JSON.parse(index.vector));
          semantic = similarity === null ? 0 : Math.max(0, similarity);
        }
      }
      const score = Math.max(lexical, semantic);
      if (score > 0) ranked.push({ ...row, score, lexicalScore: lexical, semanticScore: semantic, match: semantic > 0 && semantic >= lexical ? 'vector' : 'keyword' });
    }
    return ranked.sort((a, b) => b.score - a.score || newest(a, b)).slice(0, limit);
  }
  structuredContext(scope, query, { sessionId, maxTokens = this.options.maxContextTokens, maxChars = 20000, countTokens = estimateTokens, vector, model } = {}) {
    check(Number.isSafeInteger(maxTokens) && maxTokens > 0 && maxTokens <= 20000 && Number.isSafeInteger(maxChars) && maxChars >= 128, '上下文预算无效');
    const master = this.master().content, core = this.core().content;
    const candidates = [
      ...Object.entries(master).filter(([, v]) => JSON.stringify(v) !== '{}' && JSON.stringify(v) !== '[]' && v !== '').map(([key, value]) => ({ layer: 'master', key, value })),
      ...core.map(r => ({ layer: 'core', ...r })),
      ...this.recall(scope, query, { vector, model, excludeSession: sessionId }).map(r => ({ layer: 'archive', id: r.id, role: r.role, content: r.content, session_id: r.session_id })),
      ...this.recentForRecall(scope, sessionId).map(r => ({ layer: 'recent', id: r.id, role: r.role, content: r.content, session_id: r.session_id, timestamp: r.timestamp })),
      // Legacy records remain user-visible and retrievable, never auto-promoted
      // into the independent master or core document.
      ...this.search(scope, query).map(r => ({ layer: 'note', id: r.id, content: r.content, kind: r.kind })),
    ];
    const selected = [], seen = new Set(); let value = '';
    for (const item of candidates) {
      const key = item.id ?? 'master:' + item.key; if (seen.has(key)) continue; seen.add(key);
      const next = JSON.stringify({ type: 'recalled_memory_data', records: [...selected, item] });
      if (next.length > maxChars || countTokens(next) > maxTokens) continue;
      selected.push(item); value = next;
    }
    return { text: value, records: selected, tokens: countTokens(value), budget: maxTokens, omitted: candidates.length - selected.length };
  }
  layeredExport(scope, sessionId) {
    this.open();
    const count = this.db.prepare('SELECT (SELECT count(*) FROM conversation_archive WHERE scope=?) + (SELECT count(*) FROM conversation_rounds WHERE scope=?) AS n').get(scope, scope).n;
    const events = this._events(scope), window = this.window(scope);
    check(count <= 10000 && events.length <= 10000 && window.length <= 10000, '对话超过导出上限，请分批备份', 'CAPACITY');
    const autoMemory = this.autoMemory?.exportState(scope);
    const answerBasis = this.lineage.export(scope);
    return { format: 'yunshu-memory-layers', schemaVersion: autoMemory ? 4 : 3, ...lineageHeader(scope, autoMemory ? 4 : 3, answerBasis), exportedAt: now(), scope, core: this.core(), master: this.master(), window, archives: this.archives(scope, { limit: 10000, includeDeleted: true, includeCurrent: true }), events, notes: this.export(scope), evidence: this.evidence.export(scope), ...(autoMemory ? { autoMemory } : {}), migration: { legacyMessages: 'preserved-readable-no-round-inference', vectorIndexes: 'rebuild-after-restore', mediaBytes: 'only-received-public-payloads-no-external-fetch' } };
  }
  restoreLayers(scope, packet) {
    const lineage = unwrapLineage(packet); packet = lineage.packet;
    check(packet?.format === 'yunshu-memory-layers' && [1, 2, 3, 4].includes(packet.schemaVersion) && packet.scope === scope && Array.isArray(packet.core?.content) && object(packet.master?.content) && Array.isArray(packet.window) && Array.isArray(packet.archives), '备份格式或工作区不匹配');
    check(packet.schemaVersion >= 3 || packet.evidence === undefined, '带证据的备份必须使用v3或v4格式');
    const evidence = packet.schemaVersion >= 3 ? this.evidence.validateBackup(scope, packet.evidence) : { sources: [], observations: [] };
    check(packet.schemaVersion === 4 ? !!this.autoMemory : packet.autoMemory === undefined, '自动记忆备份需要启用兼容版本', 'INVALID_BACKUP');
    const autoMemory = packet.schemaVersion === 4 ? this.autoMemory.validateBackup(scope, packet.autoMemory, evidence.sources) : null;
    check(packet.core.content.length <= this.options.coreLimit && packet.window.length <= 10000 && packet.archives.length <= 10000 && JSON.stringify(packet.master.content).length <= 50000, '备份超过容量限制');
    const coreIds = new Set();
    const core = packet.core.content.map(r => {
      check(object(r) && text(r.id, 200) && !coreIds.has(r.id) && text(r.content, 12000) && date(r.created_at) && date(r.updated_at), '备份核心事实无效'); coreIds.add(r.id);
      return { id: r.id, content: r.content, created_at: r.created_at, updated_at: r.updated_at };
    });
    const legacyPacket = packet.schemaVersion === 1;
    check(legacyPacket || (Array.isArray(packet.events) && packet.events.length <= 10000), '备份事件无效');
    const validateLegacy = (rows, archive) => {
      const ids = new Set(); return rows.map(r => {
        check(object(r) && r.scope === scope && text(r.session_id, 200) && Number.isSafeInteger(r.event_seq) && r.event_seq >= 0 && ['user', 'assistant'].includes(r.role) && text(r.content) && date(r.created_at), '备份旧对话记录无效');
        check(legacyPacket || (r.grain === 'legacy_message' && r.metadata_complete === false), '旧数据迁移边界无效');
        const id = hash([scope, r.session_id, r.event_seq]); check(r.id === id && !ids.has(id), '备份记录标识冲突'); ids.add(id);
        if (archive) check(['current_window', 'recent', 'archived'].includes(r.tag) && [0, 1].includes(r.deleted) && date(r.archived_at) && r.content_hash === hash(r.content), '备份旧归档无效');
        else check([0, 1].includes(r.terminal), '备份轮次无效');
        const row = { id, scope, session_id: r.session_id, event_seq: r.event_seq, role: r.role, content: r.content, created_at: r.created_at };
        return archive ? { ...row, archived_at: r.archived_at, deleted: r.deleted, content_hash: r.content_hash, tag: r.tag } : { ...row, terminal: r.terminal };
      });
    };
    const window = validateLegacy(legacyPacket ? packet.window : packet.window.filter(r => r?.grain !== 'event'), false);
    const archives = validateLegacy(legacyPacket ? packet.archives : packet.archives.filter(r => r?.grain !== 'round'), true);
    const legacyById = new Map(archives.map(r => [r.id, r]));
    for (const r of window) if (legacyById.has(r.id)) {
      const a = legacyById.get(r.id);
      check(a.content === r.content && a.role === r.role && a.created_at === r.created_at && a.tag === 'current_window', '备份旧窗口与归档冲突');
    }
    const legacyIds = new Set([...window, ...archives].map(r => r.id)), eventIds = new Set();
    const events = (legacyPacket ? [] : packet.events).map(r => {
      check(object(r) && r.scope === scope && text(r.session_id, 200) && Number.isSafeInteger(r.event_seq) && r.event_seq >= 0 && ['user', 'assistant'].includes(r.role) && typeof r.content === 'string' && r.content.length <= 100000 && date(r.created_at), '备份事件无效');
      const id = hash([scope, r.session_id, r.event_seq]);
      check(id === r.id && !legacyIds.has(id) && !eventIds.has(id), '备份事件标识冲突'); eventIds.add(id);
      check([0, 1].includes(r.terminal) && [0, 1].includes(r.has_tool_calls) && [0, 1].includes(r.resonance) && [0, 1].includes(r.archived) && [null, 0, 1].includes(r.authenticated), '备份事件元数据无效');
      check(r.role !== 'user' || (!r.terminal && !r.has_tool_calls && !r.resonance && r.content.trim()), '备份用户事件无效');
      check(r.role !== 'assistant' || (r.terminal === +(!r.has_tool_calls && !r.resonance) && (r.content.trim() || r.has_tool_calls)), '备份助手边界无效');
      return Object.fromEntries(eventColumns.split(',').map(key => [key, r[key]]));
    }).sort((a, b) => a.session_id.localeCompare(b.session_id) || a.event_seq - b.event_seq);
    const eventById = new Map(events.map(r => [r.id, r]));
    const evidenceById = new Map(evidence.sources.map(r => [r.id,r]));
    for (const e of events) {
      const original = evidenceById.get(e.id);
      if (original) check(original.role === e.role && !original.payload.interrupted && projectPublicText(original.payload.parts.filter(p=>p.type==='text').map(p=>p.text).join('\n'), original.id) === e.content, '派生对话与原始证据不一致');
    }
    if (!legacyPacket) {
      const projection = packet.window.filter(r => r?.grain === 'event'), ids = new Set();
      check(projection.length === events.filter(r => !r.archived).length, '备份窗口投影数量不一致');
      for (const r of projection) {
        const e = eventById.get(r.id);
        check(e && !e.archived && r.metadata_complete === true && !ids.has(r.id) && eventColumns.split(',').every(k => r[k] === e[k]), '备份窗口投影与事件冲突'); ids.add(r.id);
      }
    }
    const groups = new Map(), sessions = new Map();
    for (const r of events) { if (!sessions.has(r.session_id)) sessions.set(r.session_id, []); sessions.get(r.session_id).push(r); }
    for (const [session, rows] of sessions) for (const group of this._completeRounds(rows)) {
      if (group.some(r => r.role === 'user' && r.content.trim())) groups.set(JSON.stringify([session, group.at(-1).event_seq]), group);
    }
    const roundIds = new Set(), roundKeys = new Set(), archivedEventIds = new Set();
    const rounds = (legacyPacket ? [] : packet.archives.filter(r => r?.grain === 'round')).map(r => {
      check(object(r) && r.scope === scope && text(r.id, 200) && !roundIds.has(r.id) && !eventIds.has(r.id) && !legacyIds.has(r.id) && text(r.session_id, 200), '备份完整轮次标识无效'); roundIds.add(r.id);
      const key = JSON.stringify([r.session_id, r.end_seq]), group = groups.get(key);
      check(group && !roundKeys.has(key) && r.start_seq === group[0].event_seq && r.event_seq === r.end_seq && r.role === 'conversation', '备份完整轮次边界无效'); roundKeys.add(key);
      const users = group.filter(e => e.role === 'user'), final = group.at(-1);
      check(r.user_input === users.map(e => e.content).join('\n') && r.assistant_response === final.content && r.timestamp === users[0].created_at && r.content === entryContent(r) && r.content_hash === hash(r.content), '备份完整轮次内容不一致');
      check(typeof r.authenticated === 'boolean' && typeof r.authentication_known === 'boolean' && r.authenticated === (final.authenticated === 1) && r.authentication_known === (final.authenticated !== null), '备份认证元数据不一致');
      check(['current_window', 'recent', 'archived'].includes(r.tag) && [0, 1].includes(r.deleted) && date(r.created_at), '备份完整轮次状态无效');
      const current = r.tag === 'current_window';
      check(r.importance === (current ? (r.authenticated ? 0.8 : 0.3) : 0.7) && (current ? r.archived_at === null : date(r.archived_at)) && group.every(e => e.archived === +!current), '备份完整轮次生命周期冲突');
      if (!current) for (const e of group) archivedEventIds.add(e.id);
      return { ...Object.fromEntries(roundColumns.split(',').map(k => [k, r[k]])), authenticated: +r.authenticated, authentication_known: +r.authentication_known };
    });
    check(roundKeys.size === groups.size && events.every(e => !e.archived || archivedEventIds.has(e.id)), '备份完整轮次或溯源事件缺失');
    const notes = packet.notes;
    check(notes?.format === 'yunshu-memory' && notes.schemaVersion === 1 && notes.scope === scope && Array.isArray(notes.records) && notes.records.length <= 10000, '备份笔记无效');
    const noteIds = new Set(), noteRows = notes.records.map(r => { const v = this.validate(r); check(text(r.id, 200) && !noteIds.has(r.id) && r.scope === scope && typeof r.deleted === 'boolean', '备份笔记标识无效'); noteIds.add(r.id); return { ...v, id: r.id, deleted: r.deleted }; });
    const restored = this.transaction(() => {
      const master = this.master().content;
      check(this.core().content.length === 0 && Object.values(master).every(v => ['{}', '[]', '""'].includes(JSON.stringify(v))) && this.list(scope, { includeDeleted: true }).length === 0 && ['conversation_archive', 'conversation_window', 'conversation_rounds', 'conversation_events', 'yunshu_sources', 'yunshu_observations', ...(this.autoMemory ? ['yunshu_distill_activation', 'yunshu_distill_cursor', 'yunshu_distill_jobs', 'yunshu_capture_failures'] : [])].every(table => this.db.prepare('SELECT count(*) AS n FROM ' + table + ' WHERE scope=?').get(scope).n === 0), '恢复目标必须为空，已有内容保持不变', 'RESTORE_CONFLICT');
      for (const r of noteRows) check(!this.db.prepare('SELECT id FROM memories WHERE id=?').get(r.id), '备份笔记标识冲突', 'RESTORE_CONFLICT');
      for (const [table, rows] of [['conversation_window', window], ['conversation_archive', archives], ['conversation_events', events], ['conversation_rounds', rounds]]) for (const r of rows) check(!this.db.prepare('SELECT id FROM ' + table + ' WHERE id=?').get(r.id), '备份对话标识冲突', 'RESTORE_CONFLICT');
      this._document('core', core); this._document('master', jsonCopy(packet.master.content));
      for (const r of window) this.db.prepare('INSERT INTO conversation_window VALUES(?,?,?,?,?,?,?,?)').run(r.id, scope, r.session_id, r.event_seq, r.role, r.content, r.created_at, r.terminal);
      for (const r of archives) this.db.prepare('INSERT INTO conversation_archive VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(r.id, scope, r.session_id, r.event_seq, r.role, r.content, r.created_at, r.archived_at, r.deleted, r.content_hash, r.tag);
      for (const r of events) this.db.prepare('INSERT INTO conversation_events(' + eventColumns + ') VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(...eventColumns.split(',').map(k => r[k]));
      for (const r of rounds) this.db.prepare('INSERT INTO conversation_rounds(' + roundColumns + ') VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...roundColumns.split(',').map(k => r[k]));
      for (const r of noteRows) this._save(scope, r, 0);
      this.evidence.restoreValidated(evidence);
      this.lineage.restore(lineage.rows, rounds);
      if (autoMemory) this.autoMemory.restoreValidated(scope, autoMemory);
      this.autoMemory?.seedActivation();
      this._snapshot(scope);
      return { restored: true, facts: core.length, window: window.length + events.filter(r => !r.archived).length, archives: archives.length + rounds.length, roundEntries: rounds.length, legacyMessages: archives.length, notes: noteRows.length, sources: evidence.sources.length, observations: evidence.observations.length, autoJobs: autoMemory?.jobs.length ?? 0 };
    });
    this.autoMemory?.wake();
    return restored;
  }
}
