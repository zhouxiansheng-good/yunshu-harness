import { contentHash } from './shared/context-contract.mjs';

export const AFFECT_VERSION = 1;
export const AFFECT_LABELS = Object.freeze({ unknown: '未判断', calm: '平静', happy: '开心', sad: '难过', worried: '担心', frustrated: '烦躁', tired: '疲惫' });
export const TONE_LABELS = Object.freeze({ natural: '自然', warm: '轻快', gentle: '温和陪伴', steady: '耐心梳理', concise: '简短体贴', repair: '专注修正' });
const TONES = { unknown: 'natural', calm: 'natural', happy: 'warm', sad: 'gentle', worried: 'steady', frustrated: 'steady', tired: 'concise' };
const GUIDANCE = { natural: '自然直接地回应。', warm: '可以分享喜悦，保持轻快，不夸大结果。', gentle: '先简短回应感受，再询问或处理实际需要；不强行劝乐观。', steady: '语气平稳，优先梳理当前问题，不反复追问已知信息。', concise: '减少重复和长篇说明，优先最小下一步。', repair: '先落实最新更正，给出具体修复与验证，不用情绪话术替代行动。' };
const HALF_HOUR = 30 * 60 * 1000, EXPIRY = 6 * 60 * 60 * 1000;
const groups = [ ['happy', '开心|高兴|愉快|兴奋|happy|excited'], ['sad', '难过|伤心|低落|sad|upset'], ['worried', '担心|紧张|焦虑|worried|anxious|nervous'], ['frustrated', '烦躁|生气|郁闷|frustrated|angry|烦(?=$|了|得|啊|呀|呢)'], ['tired', '疲惫|疲倦|tired|exhausted|累(?=$|了|得|啊|呀|呢)|困(?=$|了|得|啊|呀|呢)'], ['calm', '平静|放松|calm|relaxed'] ];
const prefix = "(?:我(?:(?:现在|今天|最近|此刻|真的|感觉|觉得|感到|有点|很|非常|特别|好|挺|太|确实|有些|有点儿|心里)\\s*){0,6}|I(?: am|’m|'m| feel)(?: really| very| a bit| so)?)\\s*";

// Local explicit cues only, not medical assessment or Aivy's algorithm.
export function detectAffect(text) {
  if (typeof text !== 'string') return null;
  const prepared = text.slice(0, 8000).split(/\n\s*\n/).filter(p => !/^(?:请)?(?:翻译|改写|润色|复述|朗读|分析以下|分析下面|例句|台词|角色对白)/.test(p.trim())).join('\n');
  const clean = prepared.replace(/\x60{3}[\s\S]*?\x60{3}|~~~[\s\S]*?~~~/g, ' ').replace(/^[ \t]*>.*$/gm, ' ').replace(/\x60[^\x60]*\x60|“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"/g, ' ');
  const present = clean.split(/(?<=[。！？!?])/).filter(p => !/(?:这是|那是|那只是|那只是我|这是我)(?:昨天|以前|过去|当时|上次).*(?:感受|情绪|心情)/.test(p)).join('');
  const clauses = present.match(/[^。！？!?；;.\n，,]+[。！？!?；;.\n，,]?/g) ?? [];
  let found = null;
  for (const raw of clauses) {
    const value = raw.trim();
    if (/[?？]/.test(value) || /^(?:如果|假如|假设|比如|例如|翻译|例句|请把|角色|台词|他说|她说)/.test(value)) continue;
    const clause = value.replace(/[。！？!?；;.,，]$/, '').trim();
    if (/^(?:我)?(?:现在|已经|感觉)?(?:好多了|没事了|好些了|缓过来了)$/.test(clause)) { found = { emotion: 'calm', tone: 'natural', origin: 'self-report', quote: clause }; continue; }
    if (/的时候|的话|时(?:会|就)|就会|(?:吗|么)$|开心果|难过关|才怪/.test(clause)) continue;
    if (/^我(?:现在|今天|真的|感觉|觉得)?(?:很)?不(?:开心|高兴)/.test(clause)) { found = { emotion: 'sad', tone: 'gentle', origin: 'self-report', quote: clause.slice(0, 160) }; continue; }
    if (/^我(?:现在|今天|真的|感觉|觉得|很)?(?:开心|高兴)(?:不起来|不了)/.test(clause)) { found = { emotion: 'sad', tone: 'gentle', origin: 'self-report', quote: clause.slice(0, 160) }; continue; }
    let direct = false;
    for (const [emotion, words] of groups) {
      if (new RegExp('^' + prefix + '(?:并不|没有|不再|不是|不|not\\s+)(?:觉得|感到|那么|很)?(?:' + words + ')', 'i').test(clause)) { found = { emotion: 'unknown', tone: 'natural', origin: 'self-correction', quote: clause.slice(0, 160) }; direct = true; break; }
      if (new RegExp('^' + prefix + '(?:' + words + ')(?:$|[^a-z])', 'i').test(clause)) { found = { emotion, tone: TONES[emotion], origin: 'self-report', quote: clause.slice(0, 160) }; direct = true; break; }
    }
    if (direct) continue;
    if (/^(?:还是不对|还是用不了|不是这样(?:做的)?|你(?:做的|理解的|现在做的)(?:又)?不对(?:了)?|请按我(?:刚才|说的)|这(?:个|次)?(?:已经)?好了|这次对了|谢谢你|谢谢|太棒了)$/.test(clause)) {
      const positive = /好了|^这次对了$|谢谢|太棒/.test(clause); found = { emotion: 'unknown', tone: positive ? 'warm' : 'repair', origin: 'interaction-feedback', quote: clause.slice(0, 160) };
    }
    if (/^(?:请)?(?:陪陪我|陪我聊(?:一会儿|一会|聊)?|先别讲道理|我只想让你听我说)$/.test(clause)) found = { emotion: 'unknown', tone: 'gentle', origin: 'explicit-request', quote: clause.slice(0, 160) };
  }
  return found;
}
const empty = () => ({ emotion: 'unknown', tone: 'natural', strength: 0, origin: 'none', quote: '', messageId: null, updatedAt: null, neutralTurns: 0 });
export function affectScope(agent) {
  const h = agent?.session?.header;
  if (!h?.id) throw new Error('请先选择会话');
  return contentHash([h.cwd ?? '', h.id]);
}
export class AffectStore {
  constructor(db, { now = Date.now } = {}) {
    this.db = db; this.now = now; this.generation = 0; this.scopeGenerations = new Map();
    db.exec('CREATE TABLE IF NOT EXISTS yunshu_affect_config(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL); INSERT OR IGNORE INTO yunshu_affect_config VALUES(1,1); CREATE TABLE IF NOT EXISTS yunshu_affect_sessions(scope TEXT PRIMARY KEY,last_key TEXT NOT NULL,state TEXT NOT NULL,touched INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS yunshu_affect_seen(scope TEXT NOT NULL,message_key TEXT NOT NULL,PRIMARY KEY(scope,message_key)); CREATE TABLE IF NOT EXISTS yunshu_affect_events(scope TEXT NOT NULL,message_key TEXT NOT NULL,event TEXT NOT NULL,created INTEGER NOT NULL,PRIMARY KEY(scope,message_key)); INSERT OR IGNORE INTO yunshu_affect_seen SELECT scope,message_key FROM yunshu_affect_events;');
  }
  generationFor(scope) { return this.generation + ':' + (this.scopeGenerations.get(scope) ?? 0); }
  enabled() { return this.db.prepare('SELECT enabled FROM yunshu_affect_config WHERE id=1').get().enabled === 1; }
  age(state) {
    if (!state.updatedAt || !state.strength) return { ...state };
    const elapsed = Math.max(0, this.now() - state.updatedAt);
    const timeStrength = elapsed >= EXPIRY ? 0 : elapsed >= 4 * HALF_HOUR ? 1 : elapsed >= HALF_HOUR ? 2 : 3;
    const strength = Math.min(state.strength, timeStrength, Math.max(0, 3 - Math.floor(state.neutralTurns / 2)));
    return strength ? { ...state, strength } : empty();
  }
  read(scope) {
    const row = this.db.prepare('SELECT state FROM yunshu_affect_sessions WHERE scope=?').get(scope);
    const state = row ? this.age(JSON.parse(row.state)) : empty();
    return { enabled: this.enabled(), ...state, label: AFFECT_LABELS[state.emotion], toneLabel: TONE_LABELS[state.tone], method: 'local-explicit-cues-v1', version: AFFECT_VERSION };
  }
  update(scope, message, expectedGeneration = this.generationFor(scope)) {
    if (message?.role !== 'user' || message.source?.kind !== 'user' || typeof message.id !== 'string' || !message.id) return this.read(scope);
    const text = (message.content ?? []).filter(p => p.type === 'text').map(p => p.text).join('\n');
    if (!text.trim()) return this.read(scope);
    const key = contentHash([message.id, text]), now = this.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT * FROM yunshu_affect_sessions WHERE scope=?').get(scope);
      const seen = row?.last_key === key || this.db.prepare('SELECT 1 FROM yunshu_affect_seen WHERE scope=? AND message_key=?').get(scope, key);
      if (!seen) {
        this.db.prepare('INSERT OR IGNORE INTO yunshu_affect_seen VALUES(?,?)').run(scope, key);
        if (expectedGeneration !== this.generationFor(scope)) { this.db.exec('COMMIT'); return this.read(scope); }
        const enabled = this.enabled(), cue = enabled ? detectAffect(text) : null;
        let state = enabled && row ? this.age(JSON.parse(row.state)) : empty();
        if (cue) state = { ...cue, strength: 3, messageId: message.id, updatedAt: now, neutralTurns: 0 };
        else state = this.age({ ...state, neutralTurns: state.neutralTurns + 1 });
        this.db.prepare('INSERT INTO yunshu_affect_sessions VALUES(?,?,?,?) ON CONFLICT(scope) DO UPDATE SET last_key=excluded.last_key,state=excluded.state,touched=excluded.touched').run(scope, key, JSON.stringify(state), now);
        this.db.prepare('INSERT INTO yunshu_affect_events VALUES(?,?,?,?)').run(scope, key, JSON.stringify({ messageId: message.id, cue: cue ?? null }), now);
        this.db.prepare('DELETE FROM yunshu_affect_events WHERE scope=? AND rowid NOT IN (SELECT rowid FROM yunshu_affect_events WHERE scope=? ORDER BY rowid DESC LIMIT 100)').run(scope, scope);
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.read(scope);
  }
  setEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw new Error('情感开关无效');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE yunshu_affect_config SET enabled=? WHERE id=1').run(Number(enabled));
      if (!enabled) {
        this.db.prepare('UPDATE yunshu_affect_sessions SET state=?').run(JSON.stringify(empty()));
        this.db.prepare('UPDATE yunshu_affect_events SET event=?').run(JSON.stringify({ cleared: true }));
      }
      this.db.exec('COMMIT');
      this.generation++;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  reset(scope) {
    this.db.prepare('UPDATE yunshu_affect_sessions SET state=? WHERE scope=?').run(JSON.stringify(empty()), scope);
    this.db.prepare('UPDATE yunshu_affect_events SET event=? WHERE scope=?').run(JSON.stringify({ cleared: true }), scope);
    this.scopeGenerations.set(scope, (this.scopeGenerations.get(scope) ?? 0) + 1);
    return this.read(scope);
  }
  candidate(scope) {
    const s = this.read(scope);
    if (!s.enabled || !s.strength) return null;
    return { id: 'affect:current', layer: 'affect', priority: 85, reason: s.origin, data: { emotion: s.emotion, responseTone: s.tone, intensity: s.strength, source: { kind: s.origin, messageId: s.messageId, quote: s.quote }, temporary: true, guidance: GUIDANCE[s.tone] } };
  }
}
