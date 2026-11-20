import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve, isAbsolute } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
export class MemoryError extends Error {
  constructor(code, message) { super(message); this.name = 'MemoryError'; this.code = code; }
}
const kinds = new Set(['core', 'profile', 'long_term', 'experience']);
const nonempty = (v, label, max = 12000) => {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new MemoryError('INVALID_INPUT', label + ' is empty or too long');
  return v.trim();
};
export function workspaceScope(cwd, sessionId) {
  if (!cwd) return 'session:' + nonempty(sessionId, 'sessionId', 200);
  if (!isAbsolute(cwd)) throw new MemoryError('INVALID_SCOPE', 'Workspace must be absolute');
  const canonical = resolve(cwd).normalize('NFC');
  return 'workspace:' + createHash('sha256').update(process.platform === 'win32' ? canonical.toLowerCase() : canonical).digest('hex');
}
export function tokens(text) {
  const s = String(text).normalize('NFKC').toLowerCase();
  const out = s.match(/[a-z0-9_]+/g) ?? [];
  for (const run of s.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu) ?? []) {
    const chars = [...run];
    if (chars.length === 1) out.push(chars[0]);
    for (let i = 0; i < chars.length - 1; i++) out.push(chars[i] + chars[i + 1]);
  }
  return [...new Set(out)].slice(0, 1000);
}
export function cosine(a, b) {
  if (!Array.isArray(a) || a.length !== b?.length || !a.length) return null;
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) return null;
    dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2;
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : null;
}
const decode = row => row ? { ...row, source: JSON.parse(row.source), deleted: !!row.deleted } : null;
export class MemoryStore {
  constructor(filename) {
    if (!isAbsolute(filename)) throw new MemoryError('INVALID_PATH', 'Database path must be absolute');
    mkdirSync(dirname(filename), { recursive: true });
    this.filename=filename;this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version > 1) { this.db.close(); throw new MemoryError('NEWER_SCHEMA', 'Database schema is newer than this plugin'); }
    this.db.exec([
      'CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY,scope TEXT NOT NULL,kind TEXT NOT NULL,content TEXT NOT NULL,source TEXT NOT NULL,version INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0);',
      'CREATE INDEX IF NOT EXISTS memories_scope ON memories(scope,deleted,kind);',
      'CREATE TABLE IF NOT EXISTS revisions (seq INTEGER PRIMARY KEY AUTOINCREMENT,memory_id TEXT NOT NULL,scope TEXT NOT NULL,operation TEXT NOT NULL,before_json TEXT,after_json TEXT NOT NULL,time TEXT NOT NULL);',
      "CREATE TABLE IF NOT EXISTS proposals (id TEXT PRIMARY KEY,scope TEXT NOT NULL,kind TEXT NOT NULL,content TEXT NOT NULL,source TEXT NOT NULL,created_at TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending');",
      'CREATE TABLE IF NOT EXISTS vectors (memory_id TEXT PRIMARY KEY REFERENCES memories(id),model TEXT NOT NULL,memory_version INTEGER NOT NULL,vector_json TEXT NOT NULL);',
      'PRAGMA user_version=1;'].join('\n'));
    this.closed = false;
  }
  open() { if (this.closed) throw new MemoryError('CLOSED', 'Memory plugin has been unloaded'); }
  transaction(fn) {
    this.open(); this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { if (!this.closed) { this.closed = true; this.db.close(); } }
  validate(input) {
    const kind = input.kind ?? 'long_term';
    if (!kinds.has(kind)) throw new MemoryError('INVALID_KIND', 'Unknown memory kind');
    const source = input.source ?? { type: 'manual' };
    if (!source || typeof source !== 'object' || Array.isArray(source) || JSON.stringify(source).length > 4000) throw new MemoryError('INVALID_SOURCE', 'Invalid provenance');
    return { kind, content: nonempty(input.content, 'content'), source: JSON.parse(JSON.stringify(source)) };
  }
  get(scope, id, includeDeleted = false) {
    this.open(); nonempty(scope, 'scope', 300);
    const row = this.db.prepare('SELECT * FROM memories WHERE scope=? AND id=?').get(scope, id);
    return row && (includeDeleted || !row.deleted) ? decode(row) : null;
  }
  list(scope, { kind, limit = 100, includeDeleted = false } = {}) {
    this.open(); nonempty(scope, 'scope', 300);
    if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new MemoryError('INVALID_LIMIT', 'limit must be 1..10000');
    if (kind && !kinds.has(kind)) throw new MemoryError('INVALID_KIND', 'Unknown kind');
    return this.db.prepare('SELECT * FROM memories WHERE scope=? AND (? OR deleted=0) AND (? IS NULL OR kind=?) ORDER BY updated_at DESC,id LIMIT ?').all(scope, includeDeleted ? 1 : 0, kind ?? null, kind ?? null, limit).map(decode);
  }
  save(scope, input, expectedVersion, { confirmed = false } = {}) {
    nonempty(scope, 'scope', 300);const v = this.validate(input);
    if (['core', 'profile'].includes(v.kind) && !confirmed) throw new MemoryError('CONFIRM_REQUIRED', 'Core/profile facts require confirmation through the user interface');
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new MemoryError('VERSION_REQUIRED', 'An expected version is required');
    return this.transaction(() => this._save(scope, { ...v, id: input.id ?? randomUUID() }, expectedVersion));
  }
  _save(scope, input, expectedVersion) {
    const id = nonempty(input.id, 'id', 200);const existing = this.db.prepare('SELECT * FROM memories WHERE id=?').get(id);
    if (existing && existing.scope !== scope) throw new MemoryError('NOT_FOUND', 'Memory not found in this workspace');
    if ((existing?.version ?? 0) !== expectedVersion) throw new MemoryError('VERSION_CONFLICT', 'Memory changed; reload before saving');
    if (!existing && this.db.prepare('SELECT count(*) AS n FROM memories WHERE scope=?').get(scope).n >= 10000) throw new MemoryError('CAPACITY', 'Workspace capacity is 10000 records including withdrawn records; export before archiving');
    const now = new Date().toISOString();
    const row = { id, scope, kind: input.kind, content: input.content, source: input.source, version: expectedVersion + 1, created_at: existing?.created_at ?? now, updated_at: now, deleted: input.deleted === true };
    this.db.prepare('INSERT INTO memories VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,content=excluded.content,source=excluded.source,version=excluded.version,updated_at=excluded.updated_at,deleted=excluded.deleted').run(id, scope, row.kind, row.content, JSON.stringify(row.source), row.version, row.created_at, now, row.deleted ? 1 : 0);
    this.db.prepare('DELETE FROM vectors WHERE memory_id=?').run(id);this.audit(scope, id, existing ? 'update' : 'create', decode(existing), row);return row;
  }
  audit(scope, id, operation, before, after) {
    this.db.prepare('INSERT INTO revisions(memory_id,scope,operation,before_json,after_json,time) VALUES(?,?,?,?,?,?)').run(id, scope, operation, before ? JSON.stringify(before) : null, JSON.stringify(after), new Date().toISOString());
  }
  withdraw(scope, id, expectedVersion) {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new MemoryError('VERSION_REQUIRED', 'Expected version is required');
    return this.transaction(() => {
      const before = this.get(scope, id, true);
      if (!before) throw new MemoryError('NOT_FOUND', 'Memory not found');
      if (before.version !== expectedVersion) throw new MemoryError('VERSION_CONFLICT', 'Memory changed; reload first');
      if (before.deleted) return before;
      const after = { ...before, deleted: true, version: before.version + 1, updated_at: new Date().toISOString() };
      this.db.prepare('UPDATE memories SET deleted=1,version=?,updated_at=? WHERE id=? AND scope=?').run(after.version, after.updated_at, id, scope);
      this.db.prepare('DELETE FROM vectors WHERE memory_id=?').run(id);this.audit(scope, id, 'withdraw', before, after);return after;
    });
  }
  history(scope, id) {
    this.open();return this.db.prepare('SELECT seq,operation,before_json,after_json,time FROM revisions WHERE scope=? AND memory_id=? ORDER BY seq DESC LIMIT 100').all(scope,id).map(r => ({ seq:r.seq,operation:r.operation,before:r.before_json?JSON.parse(r.before_json):null,after:JSON.parse(r.after_json),time:r.time }));
  }
  undo(scope, id, expectedVersion) {
    return this.transaction(() => {
      const current = this.get(scope,id,true);
      if (!current) throw new MemoryError('NOT_FOUND','Memory not found');
      if (current.version!==expectedVersion) throw new MemoryError('VERSION_CONFLICT','Memory changed; reload first');
      const revision = this.history(scope,id)[0];if (!revision) throw new MemoryError('NO_HISTORY','No revision exists');
      const target = revision.before;
      const after = target ? { ...target,version:current.version+1,updated_at:new Date().toISOString() } : { ...current,deleted:true,version:current.version+1,updated_at:new Date().toISOString() };
      this.db.prepare('UPDATE memories SET kind=?,content=?,source=?,version=?,updated_at=?,deleted=? WHERE scope=? AND id=?').run(after.kind,after.content,JSON.stringify(after.source),after.version,after.updated_at,after.deleted?1:0,scope,id);
      this.db.prepare('DELETE FROM vectors WHERE memory_id=?').run(id);this.audit(scope,id,'undo',current,after);return after;
    });
  }
  propose(scope, input) {
    this.open();nonempty(scope,'scope',300);const v=this.validate(input);
    const same=this.db.prepare("SELECT * FROM proposals WHERE scope=? AND kind=? AND content=? AND state='pending'").get(scope,v.kind,v.content);
    if (same) return { ...same,source:JSON.parse(same.source) };
    if (this.db.prepare("SELECT count(*) AS n FROM proposals WHERE scope=? AND state='pending'").get(scope).n >= 100) throw new MemoryError('CAPACITY','Review pending proposals first');
    const row={id:randomUUID(),scope,...v,created_at:new Date().toISOString(),state:'pending'};
    this.db.prepare('INSERT INTO proposals VALUES(?,?,?,?,?,?,?)').run(row.id,scope,v.kind,v.content,JSON.stringify(v.source),row.created_at,row.state);return row;
  }
  proposals(scope) { this.open();return this.db.prepare("SELECT * FROM proposals WHERE scope=? AND state='pending' ORDER BY created_at,id LIMIT 100").all(scope).map(r=>({...r,source:JSON.parse(r.source)})); }
  decide(scope,id,accept) {
    return this.transaction(()=>{
      const row=this.db.prepare("SELECT * FROM proposals WHERE id=? AND scope=? AND state='pending'").get(id,scope);
      if (!row) throw new MemoryError('NOT_FOUND','Pending proposal not found');
      const memory=accept?this._save(scope,{id:randomUUID(),kind:row.kind,content:row.content,source:JSON.parse(row.source)},0):null;
      this.db.prepare('UPDATE proposals SET state=? WHERE id=?').run(accept?'accepted':'rejected',id);return {id,state:accept?'accepted':'rejected',memory};
    });
  }
  export(scope) { return {format:'yunshu-memory',schemaVersion:1,exportedAt:new Date().toISOString(),scope,records:this.list(scope,{limit:10000,includeDeleted:true})}; }
  import(scope, packet, { confirmed = false }={}) {
    if (!confirmed) throw new MemoryError('CONFIRM_REQUIRED','Import requires user confirmation');
    if (packet?.format!=='yunshu-memory'||packet.schemaVersion!==1||packet.scope!==scope||!Array.isArray(packet.records)||packet.records.length>10000) throw new MemoryError('INVALID_IMPORT','Wrong format/version/workspace');
    const ids=new Set();const rows=packet.records.map(r=>{const v=this.validate(r);const id=nonempty(r.id,'id',200);if(ids.has(id)||r.scope!==scope||typeof r.deleted!=='boolean')throw new MemoryError('INVALID_IMPORT','Duplicate id or invalid scope/state');ids.add(id);return {...v,id,deleted:r.deleted};});
    return this.transaction(()=>{
      for(const row of rows)if(this.db.prepare('SELECT id FROM memories WHERE id=?').get(row.id))throw new MemoryError('IMPORT_CONFLICT','Import never overwrites existing records');
      const imported=[];for(const row of rows){const saved=this._save(scope,row,0);imported.push(saved);}return {imported:imported.length};
    });
  }
  setVector(scope,id,version,model,vector) {
    nonempty(model,'model',300);
    if(!Array.isArray(vector)||vector.length<1||vector.length>16000||vector.some(v=>!Number.isFinite(v)))throw new MemoryError('INVALID_VECTOR','Invalid embedding');
    return this.transaction(()=>{const row=this.get(scope,id);if(!row||row.version!==version)throw new MemoryError('VERSION_CONFLICT','Embedding refers to stale content');this.db.prepare('INSERT INTO vectors VALUES(?,?,?,?) ON CONFLICT(memory_id) DO UPDATE SET model=excluded.model,memory_version=excluded.memory_version,vector_json=excluded.vector_json').run(id,model,version,JSON.stringify(vector));return true;});
  }
  search(scope,query,{limit=8,kind,vector,model}={}) {
    if(typeof query!=='string'||query.length>4000)throw new MemoryError('INVALID_QUERY','Query must be at most 4000 characters');
    if(!Number.isInteger(limit)||limit<1||limit>100)throw new MemoryError('INVALID_LIMIT','limit must be 1..100');
    const terms=tokens(query);const normalized=query.normalize('NFKC').toLowerCase().trim();
    const ranked=this.list(scope,{limit:10000,kind}).map(row=>{const text=row.content.normalize('NFKC').toLowerCase();const have=new Set(tokens(row.content));const lexical=terms.length?terms.filter(t=>have.has(t)).length/terms.length:0;let semantic=null;if(vector&&model){const e=this.db.prepare('SELECT * FROM vectors WHERE memory_id=? AND model=? AND memory_version=?').get(row.id,model,row.version);if(e)semantic=cosine(vector,JSON.parse(e.vector_json));}const exact=normalized&&text.includes(normalized)?1:0;return {...row,score:lexical+exact+(semantic===null?0:Math.max(0,semantic)),match:{lexical,semantic,exact:!!exact}};});
    return ranked.filter(r=>!terms.length||r.score>0).sort((a,b)=>b.score-a.score||b.updated_at.localeCompare(a.updated_at)||a.id.localeCompare(b.id)).slice(0,limit);
  }
  context(scope,query,{maxChars=4000,limit=8,vector,model}={}) {
    if(!Number.isInteger(maxChars)||maxChars<128||maxChars>20000)throw new MemoryError('INVALID_BUDGET','Context budget must be 128..20000 characters');
    const candidates=[...this.list(scope,{kind:'profile',limit:30}),...this.list(scope,{kind:'core',limit:50}),...this.search(scope,query,{limit,vector,model})];
    const selected=[];const seen=new Set();let text='';
    for(const row of candidates){if(seen.has(row.id))continue;seen.add(row.id);const entry={id:row.id,kind:row.kind,content:row.content,source:row.source,version:row.version};const next=JSON.stringify({type:'recalled_memory_data',records:[...selected,entry]});if(next.length>maxChars)continue;selected.push(entry);text=next;}
    return {text,records:selected,characters:text.length,budget:maxChars};
  }
}
