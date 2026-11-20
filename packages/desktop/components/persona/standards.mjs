import { randomUUID } from 'node:crypto';
import { IdentityError } from './identity.mjs';

const check = (ok, message, code = 'INVALID_INPUT') => { if (!ok) throw new IdentityError(code, message); };
const validText = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max;
const clean = value => typeof value === 'string' ? value.trim() : '';
const now = () => new Date().toISOString();

// Standards are user-confirmed prefix data, never automatic memory output.
// One current version per family; old versions remain queryable.
export class StandardsStore {
  constructor(db) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS identity_standards(
      id TEXT PRIMARY KEY,family_id TEXT NOT NULL,version INTEGER NOT NULL,
      text TEXT NOT NULL,kind TEXT NOT NULL,reason TEXT NOT NULL,evidence TEXT NOT NULL,
      state TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(family_id,version));
      CREATE INDEX IF NOT EXISTS identity_standards_current ON identity_standards(state,family_id);`);
  }
  list() {
    return this.db.prepare("SELECT * FROM identity_standards WHERE state='current' ORDER BY family_id").all();
  }
  history(familyId) {
    if (familyId === undefined) return this.db.prepare('SELECT * FROM identity_standards ORDER BY created_at DESC,id LIMIT 100').all();
    check(validText(familyId, 100), '标准标识无效');
    return this.db.prepare('SELECT * FROM identity_standards WHERE family_id=? ORDER BY version DESC').all(familyId);
  }
  current(id) {
    check(validText(id, 100), '标准标识无效');
    return this.db.prepare("SELECT * FROM identity_standards WHERE id=? AND state='current'").get(id) ?? null;
  }
  validate(input, { revision = false } = {}) {
    check(input && validText(input.text, 120) && ['standard', 'tendency'].includes(input.kind), '标准内容或类型无效');
    check(!revision || validText(input.reason, 400), '修订原因不能为空');
    check(input.reason === undefined || typeof input.reason === 'string' && input.reason.length <= 400, '标准原因过长');
    check(input.evidence === undefined || typeof input.evidence === 'string' && input.evidence.length <= 600, '标准证据过长');
    return { text: clean(input.text), kind: input.kind, reason: clean(input.reason), evidence: clean(input.evidence) };
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  create(input, confirmed = false, validateNext = () => {}) {
    check(confirmed === true, '新增标准需要界面确认', 'CONFIRM_REQUIRED');
    const data = this.validate(input);
    return this.transaction(() => {
      check(this.list().length < 4, '当前标准最多四条；请先修订或撤回', 'CAPACITY');
      validateNext([...this.list(), data]);
      const id = randomUUID();
      this.db.prepare('INSERT INTO identity_standards VALUES(?,?,?,?,?,?,?,?,?)').run(id,id,1,data.text,data.kind,data.reason,data.evidence,'current',now());
      return this.current(id);
    });
  }
  revise(id, expectedVersion, input, confirmed = false, validateNext = () => {}) {
    check(confirmed === true, '修订标准需要界面确认', 'CONFIRM_REQUIRED');
    const data = this.validate(input, { revision: true });
    return this.transaction(() => {
      const prior = this.current(id);
      check(prior && prior.version === expectedVersion, '标准已更新，请刷新', 'VERSION_CONFLICT');
      validateNext([...this.list().filter(row => row.id !== id), data]);
      const nextId = randomUUID();
      this.db.prepare("UPDATE identity_standards SET state='superseded' WHERE id=?").run(id);
      this.db.prepare('INSERT INTO identity_standards VALUES(?,?,?,?,?,?,?,?,?)').run(nextId,prior.family_id,prior.version+1,data.text,data.kind,data.reason,data.evidence,'current',now());
      return this.current(nextId);
    });
  }
  withdraw(id, expectedVersion, reason, confirmed = false) {
    check(confirmed === true, '撤回标准需要界面确认', 'CONFIRM_REQUIRED');
    check(validText(reason, 400), '撤回原因不能为空');
    return this.transaction(() => {
      const prior = this.current(id);
      check(prior && prior.version === expectedVersion, '标准已更新，请刷新', 'VERSION_CONFLICT');
      const tombstone = randomUUID();
      this.db.prepare("UPDATE identity_standards SET state='superseded' WHERE id=?").run(id);
      this.db.prepare('INSERT INTO identity_standards VALUES(?,?,?,?,?,?,?,?,?)').run(tombstone,prior.family_id,prior.version+1,prior.text,prior.kind,reason.trim(),'','withdrawn',now());
      return this.db.prepare('SELECT * FROM identity_standards WHERE id=?').get(tombstone);
    });
  }
}
