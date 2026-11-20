import { createHash } from 'node:crypto';
import path from 'node:path';

const textTypes = new Set(['read', 'write', 'edit', 'apply_patch']);
const versionOps = new Set(['write', 'edit', 'apply_patch']);
export const receiptKind = 'yunshu-file-receipt';
export function hasPendingMutation(calls, key) {
  return calls.some(c => versionOps.has(c.name) && (c.key === key || c.targets?.includes(key)));
}

function fsPath(root) {
  return typeof root === 'string' && /^[A-Za-z]:[\\/]/u.test(root) ? path.win32 : path.posix;
}

export function workspacePath(root, value, cwd = root) {
  if (!root || typeof value !== 'string' || !value || value.length > 2048 || /[\x00-\x1f]/u.test(value)) return null;
  const api = fsPath(root);
  if (!api.isAbsolute(root) || /^(?:[\\/]{2}|[a-z][\w+.-]*:\/\/)/iu.test(value)) return null;
  if (api === path.posix && value.includes('\\')) return null;
  if (api === path.win32 && /^[a-z]:[^\\/]/iu.test(value)) return null;
  const absolute = api.resolve(cwd || root, value);
  const rel = api.relative(root, absolute);
  if (!rel || rel === '..' || rel.startsWith('..' + api.sep) || api.isAbsolute(rel)) return null;
  if (rel.split(api.sep).some(s => /^(?:\.|node_modules$|credentials?(?:[.-]|$)|secrets?(?:[.-]|$)|id_(?:rsa|ed25519)(?:\.|$))/iu.test(s) || /\.(?:pem|key|pfx|p12|kdbx)$/iu.test(s) || s.includes(':'))) return null;
  const relative = rel.split(api.sep).join('/');
  return { path: absolute, relative, key: api === path.win32 ? relative.toLowerCase() : relative };
}
export const sessionFile = (state, value) => workspacePath(state.root, value, state.cwd);

export function digest(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function writtenDigest(text) {
  return typeof text === 'string' ? digest(text.replace(/\r\n/gu, '\n').replace(/\n$/u, '')) : null;
}

/** Only accept the original file tool envelope, including its window and exact numbered rows. */
export function fullRead(meta, blocks) {
  const rows = meta?.lines;
  if (!Array.isArray(rows) || meta.offset !== 1 || !Number.isSafeInteger(meta.totalLines) || rows.length !== meta.totalLines ||
      rows.length > 8192 || blocks?.length !== 1 || blocks[0].type !== 'text') return null;
  if (rows.some((line, i) => line?.number !== i + 1 || typeof line.text !== 'string' ||
      /\.\.\. \(line truncated to \d+ chars\)$/u.test(line.text))) return null;
  const content = blocks[0].text;
  if (typeof content !== 'string' || content.length > 512 * 1024) return null;
  const header = /^<path>([^\n]+)<\/path>\n<type>file<\/type>\n<content>\n/u.exec(content);
  if (!header || header[1] !== meta.path) return null;
  const rendered = rows.map(line => line.number + ': ' + line.text).join('\n');
  const footer = '(End of file - total ' + rows.length + ' lines)\n</content>';
  if (content.slice(header[0].length) !== (rows.length ? rendered + '\n\n' : '') + footer) return null;
  return rows.map(line => line.text).join('\n');
}

const id = value => typeof value === 'string' && /^[\p{L}\p{N}][\p{L}\p{N}_.:@/-]{0,95}$/u.test(value) ? value : null;
function stamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/u.test(value)) return null;
  const [year, month, day] = value.slice(0,10).split('-').map(Number);
  const maxDay = [31,(year%4===0 && (year%100!==0 || year%400===0))?29:28,31,30,31,30,31,31,30,31,30,31][month-1];
  if (!maxDay || day < 1 || day > maxDay || (value.length > 10 && Number(value.slice(11,13)) > 23)) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}
function identity(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const canonical = obj.sourceId !== undefined || obj.revisionId !== undefined;
  const sourceId = id(canonical ? obj.sourceId : obj.receipt_id);
  const revisionId = id(canonical ? obj.revisionId : obj.attempt_id);
  const subjectId = id(canonical ? obj.subjectId : obj.station);
  const domainId = obj.domainId == null ? null : id(obj.domainId);
  if (obj.domainId != null && !domainId) return null;
  return sourceId && revisionId && subjectId ? { domainId, sourceId, revisionId, subjectId } : null;
}
function document(text) {
  if (text.length > 64000 || !text.trimStart().startsWith('{')) return null;
  try { return JSON.parse(text); } catch { return null; }
}
function reference(doc) { return identity(doc?.sourceRef ?? doc); }
function sourceFrom(doc, file, seq, time) {
  const ref = identity(doc);
  if (!ref || doc.sourceRef || doc.signed === false) return null;
  if (doc.signed !== true && !(doc.sourceId && stamp(doc.effectiveAt))) return null;
  return { ...ref, path: file.relative, key: file.key, seq, observedAt: time,
    recordedAt: stamp(doc.recordedAt ?? doc.at), effectiveAt: stamp(doc.effectiveAt) };
}
function sameRef(a,b) {
  return a && b && a.domainId === b.domainId && a.subjectId === b.subjectId && a.sourceId === b.sourceId && a.revisionId === b.revisionId;
}
function uniqueBasis(sources, ref, file, writeSeq) {
  if (!ref) return null;
  const candidates = sources.filter(s => s.key !== file.key && s.seq < writeSeq && sameRef(s, ref));
  return candidates.length === 1 ? candidates[0] : null;
}
function previousFor(state, file, basis) {
  if (!basis) return null;
  const last = state.active.prior.find(r => r.key === file.key) ??
    Object.values(state.view.turns).flatMap(t => t.files).filter(r => r.key === file.key).at(-1);
  const previous = last?.basis;
  return previous && previous.domainId === basis.domainId && previous.subjectId === basis.subjectId && !sameRef(previous, basis) ? previous : null;
}
export function deriveBasis(state, text, file, writeSeq) {
  const basis = uniqueBasis(state.sources, reference(document(text)), file, writeSeq);
  return { basis, previous: previousFor(state, file, basis) };
}

function linkKeys(text, state) {
  const keys = new Set();
  // Restrict deduplication to destinations, never link labels, prose or code examples.
  let fence = '';
  const prose = text.replace(/<!--[\s\S]*?(?:-->|$)/gu,'').split('\n').filter(line => {
    const mark = /^ {0,3}(\x60{3,}|~{3,})/u.exec(line)?.[1];
    if (fence) {
      if (mark?.[0] === fence[0] && mark.length >= fence.length && line.trim() === mark) fence = '';
      return false;
    }
    if (mark) { fence = mark; return false; }
    return !/^(?: {4}|\t| {0,3}>)/u.test(line);
  }).join('\n').replace(/(\x60+)[\s\S]*?\1/gu,'');
  for (const match of prose.matchAll(/(?<![!\\])\[[^\]\n]*\]\(\s*(?:<([^<>\n]+)>|((?:\\[()]|[^\s()\\]|\([^()\s]*\))+))(?:\s+["'][^\n]*?["'])?\s*\)/gu)) {
    try {
      const value = decodeURIComponent((match[1] ?? match[2]).split('#')[0]).replace(/\\([()])/gu, '$1').replace(/:\d+(?:[-–]\d+)?$/u,'');
      const file = sessionFile(state, value);
      if (file) keys.add(file.key);
    } catch {}
  }
  return [...keys];
}
function frame() { return { calls: [], writes: [], reads: [], prior: [], presented: [], finalLinks: [], replied: false }; }
export function initial(header = {}, inherited = 0) {
  return { root: header.cwd ?? null, cwd: header.cwd ?? null, inherited, turn: null, active: frame(), sources: [], view: { turns: {} } };
}
function replaceBy(list, match, item, limit = 96) {
  const items = list.filter(row => !match(row));
  if (item) items.push(item);
  return items.slice(-limit);
}
function rows(state, files, end) {
  const turns = { ...state.view.turns };
  const key = String(state.turn);
  if (files.length) turns[key] = { files, end: end ?? turns[key]?.end ?? null };
  else delete turns[key];
  return { ...state, view: { turns } };
}
function filesOf(state) { return state.view.turns[String(state.turn)]?.files ?? []; }
function forgetFile(state, file) {
  const active = state.active;
  const match = r => r.key === file.key;
  const previous = filesOf(state).find(match);
  const next = { ...state, sources: state.sources.filter(s => !match(s)), active: { ...active,
    prior: previous ? replaceBy(active.prior,match,{key:file.key,basis:previous.basis}) : active.prior,
    writes: active.writes.filter(r => !match(r)), reads: active.reads.filter(r => !match(r)) } };
  const files = filesOf(state);
  return files.some(match) ? rows(next, files.filter(r => !match(r))) : next;
}
function record(state, read, write, verification = 'matched') {
  const files = filesOf(state);
  const item = { key: read.key, relative: read.relative, verification, writeSeq: write.seq, readSeq: read.seq,
    readAt: read.time, hash: read.hash, basis: read.basis, previous: read.previous,
    linked: state.active.presented.includes(read.key) || state.active.finalLinks.includes(read.key) };
  return rows(state, replaceBy(files, r => r.key === item.key, item, 40));
}
function links(state, patch) {
  const active = { ...state.active, ...patch };
  const next = { ...state, active };
  const files = filesOf(state);
  const updated = files.map(f => ({ ...f, linked: active.presented.includes(f.key) || active.finalLinks.includes(f.key) }));
  return files.some((f,i) => f.linked !== updated[i].linked) ? rows(next, updated) : next;
}
function callArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return {}; }
}
function rememberCall(state, event) {
  const d = event.data;
  if (!textTypes.has(d.name) || typeof d.callId !== 'string') return state;
  const args = callArgs(d.arguments);
  const file = sessionFile(state, args?.file_path);
  if (!file && d.name !== 'apply_patch') return state;
  const call = { id: d.callId, name: d.name, seq: event.seq, step: d.step, key: file?.key ?? null,
    expected: d.name === 'write' ? writtenDigest(args.content) : null };
  if (d.name === 'apply_patch') {
    call.targets = [...new Set(Array.from(String(args?.input ?? '').matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): ([^\r\n]+)$/gmu),
      m => sessionFile(state, m[1])?.key).filter(Boolean))].slice(0,128);
  }
  return { ...state, active: { ...state.active, calls: [...state.active.calls, call].slice(-128) } };
}
function resultOf(state, event) {
  const d = event.data, msg = d.message;
  const parents = event.sourceEventSeqs;
  if (!Array.isArray(parents) || parents.length !== 1 || !msg || msg.role !== 'tool') return state;
  const call = state.active.calls.find(c => c.seq === parents[0] && c.id === msg.toolCallId &&
    c.id === msg.source?.callId && msg.source?.kind === 'tool' && c.step === d.step);
  if (!call) return state;
  const active = { ...state.active, calls: state.active.calls.filter(c => c !== call) };
  let next = { ...state, active };
  if (event.surfaceOp !== 'append') return next;
  if (msg.isError || d.error) {
    if (versionOps.has(call.name) && d.error?.code === 'TOOL_OUTCOME_UNKNOWN') {
      for (const key of call.targets ?? [call.key]) next = forgetFile(next,{key});
    }
    return next;
  }
  if (call.name === 'apply_patch') {
    // Partial patches may already have modified a subset. Revoke the potentially affected receipts.
    for (const key of call.targets) next = forgetFile(next,{key});
    if (d.meta?.stopped !== false) return next;
    return { ...next, active: { ...next.active, writes: [...next.active.writes,
      ...call.targets.map(key => ({...call, key}))].slice(-96) } };
  }
  const file = sessionFile(state, d.meta?.path);
  if (!file || file.key !== call.key) return next;
  if (call.name !== 'read') {
    const entry = { ...call, key: file.key };
    next = forgetFile(next,file);
    return { ...next, active: { ...next.active, writes: replaceBy(next.active.writes, r => r.key === file.key, entry) } };
  }
  const text = fullRead(d.meta, msg.content);
  if (text === null) return next;
  const hash = digest(text);
  const latest = active.writes.filter(r => r.key === file.key).at(-1);
  if (latest && (latest.seq >= call.seq || latest.step >= call.step)) return next;
  if (hasPendingMutation(active.calls, file.key)) return next;
  const write = latest;
  const proofs = write ? deriveBasis(next, text, file, write.seq) : { basis: null, previous: null };
  const read = { relative:file.relative, key:file.key, seq: event.seq, id: call.id, time: event.time, hash, writeSeq: write?.seq ?? null, ...proofs };
  next = { ...next, active: { ...active, reads: replaceBy(active.reads,r => r.key === file.key, read) } };
  const existing = filesOf(next);
  if (existing.some(f => f.key === file.key && f.hash !== hash)) next = rows(next, existing.filter(f => f.key !== file.key));
  if (!write) {
    const source = sourceFrom(document(text), file, event.seq, event.time);
    next.sources = replaceBy(next.sources, s => s.key === file.key, source);
  } else if (write.expected && write.expected === hash) {
    next = record(next, read, write);
  } else if (write.name === 'edit') {
    // On old logs a successful edit and later full read are real, but the revision at read was not captured.
    next = record(next, {...read,basis:null,previous:null}, write, 'read-after-edit');
  }
  return next;
}
function attest(state, message) {
  const s = message?.source;
  if (message?.role !== 'user' || s?.kind !== receiptKind || s.turn !== state.turn || !Number.isSafeInteger(s.writeSeq)) return state;
  const r = state.active.reads.find(r => r.id === s.readCallId && r.hash === s.hash && r.key === s.key && r.writeSeq === s.writeSeq);
  const w = state.active.writes.find(w => w.seq === s.writeSeq && w.id === s.writeCallId && w.key === s.key);
  return r && w && !filesOf(state).some(f => f.readSeq === r.seq && f.key === r.key && f.verification === 'matched') ? record(state, r, w) : state;
}

/** Fold the committed session only. Inherited fork history cannot publish receipts in its child. */
export function fold(state, event) {
  if (event.seq < state.inherited) return state;
  const d = event.data;
  if (event.type === 'working-directory/change') {
    if (!d.cwd || state.cwd === d.cwd) return state;
    return { ...state, root: state.root ?? d.cwd, cwd: d.cwd, active: frame(), sources: [] };
  }
  if (event.type === 'turn/start') return { ...state, turn: d.turn, active: frame(), sources: [] };
  if (state.turn === null || (d.turn != null && d.turn !== state.turn)) return state;
  switch (event.type) {
    case 'tool/call': return rememberCall(state, event);
    case 'tool/result': return resultOf(state, event);
    case 'agent/inbox/spliced':
      return d.target === 'next-step' && Array.isArray(d.inserted) ? d.inserted.reduce(attest, state) : state;
    case 'deliverables/presented': {
      if (!Array.isArray(d.files) || !d.callId) return state;
      const keys = d.files.map(f => sessionFile(state, f?.path)?.key).filter(Boolean);
      return keys.length ? links(state, { presented: [...new Set([...state.active.presented, ...keys])] }) : state;
    }
    case 'assistant/message': {
      const msg = d.message;
      if (msg?.role !== 'assistant' || d.interrupted || !Array.isArray(msg.content) || msg.content.some(b => b.type === 'tool-call')) return state;
      const text = msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      return text.trim() ? links(state, { replied: true, finalLinks: linkKeys(text,state) }) : state;
    }
    case 'turn/end': {
      const status = d.reason?.kind === 'completed' ? (state.active.replied ? 'replied' : 'ended') : 'interrupted';
      const next = filesOf(state).length ? rows(state, filesOf(state), status) : state;
      return { ...next, turn: null, active: frame(), sources: [] };
    }
    default: return state;
  }
}
