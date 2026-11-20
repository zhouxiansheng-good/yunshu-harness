import { tokens } from './store.mjs';
import { stableJson, contentHash, compareId } from './shared/context-contract.mjs';
import { currentPromotion } from './promoted-provenance.mjs';
function relevance(value, terms) { const have = new Set(tokens(value)); return terms.length ? terms.filter(t => have.has(t)).length / terms.length : 0; }
function leaves(value, path = '', out = []) {
  if (out.length >= 200) return out;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of Object.keys(value).sort()) leaves(value[key], path ? path + '.' + key : key, out);
  } else if (value !== '' && value !== null && value !== undefined && stableJson(value) !== '[]') out.push({ key: path, value });
  return out;
}
// A persona-specific selection adapter. Native-style archive/slide/retrieve
// contracts remain in MemorySystem, unchanged and available without persona.
export function memoryCandidates(store, scope, query, sessionId, semantic = {}) {
  const terms = tokens(query);
  const personal = /我是谁|我的(?:名字|偏好|习惯|要求)|我(?:喜欢|不喜欢)|个人档案|关于我/.test(query);
  const continuity = /继续|上次|刚才|之前|最近|接着/.test(query);
  const rows = [];
  for (const leaf of leaves(store.master().content)) {
    const score = relevance(stableJson(leaf), terms);
    if (score > 0 || personal) rows.push({ id: 'master:' + leaf.key, layer: 'profile', priority: 60 + score, reason: personal ? 'personal-query' : 'keyword-match', scores: { keyword: score }, data: { key: leaf.key, value: leaf.value, provenance: 'user-maintained-profile' } });
  }
  for (const core of store.core().content) {
    const score = relevance(core.content, terms);
    if (score > 0 || personal) rows.push({ id: 'core:' + core.id, layer: 'core', priority: 70 + score, reason: 'confirmed-core-match', scores: { keyword: score }, data: { id: core.id, content: core.content, updated_at: core.updated_at } });
  }
  const archived = store.recall(scope, query, { ...semantic, excludeSession: sessionId });
  if (continuity) archived.push(...store.recentForRecall(scope, sessionId));
  const seen = new Set();
  for (const row of archived) {
    if (seen.has(row.id)) continue; seen.add(row.id);
    const sourceId = Number.isSafeInteger(row.start_seq) ? contentHash([scope, row.session_id, row.start_seq]) : null;
    const source = sourceId && store.evidence.source(scope, sourceId);
    rows.push({ id: 'archive:' + row.id, layer: 'episode', priority: 40 + (row.score ?? 0), reason: row.score ? 'archive-match' : 'explicit-continuity', scores: row.score ? { keyword: row.lexicalScore, semantic: row.semanticScore, combined: row.score } : { explicitContinuity: true }, data: { id: row.id, content: row.content, historical: true, ...(row.lineageRedacted ? { user_input_only: true } : {}), timestamp: row.timestamp, source_id: source ? sourceId : null, source_status: source ? 'available' : 'legacy-or-unavailable' } });
  }
  // Promotion certifies provenance, not relevance. Only matching durable facts
  // may enter this request; otherwise unrelated queries receive old rules.
  // Scan at most 50 recent promoted records: O(50 * bounded token count).
  const promotedCandidates = [];
  for (const row of store.list(scope, { kind: 'experience', limit: 50 })) {
    const src = row.source;
    if (!src || typeof src !== 'object' || src.type !== 'distill-promoted') continue;
    if (!currentPromotion(store, scope, row)) continue;
    const score = relevance(row.content, terms);
    if (score <= 0) continue;
    promotedCandidates.push({ id: 'note:' + row.id, layer: 'experience', priority: 50 + score, reason: 'promoted-keyword-match', scores: { promoted: true, keyword: score }, data: { id: row.id, kind: row.kind, content: row.content, source: src } });
  }
  // Rank the bounded pool before applying its cap; recent weak matches must
  // not hide the strongest older match.
  rows.push(...promotedCandidates.sort((a, b) => b.priority - a.priority || compareId(a.id, b.id)).slice(0, 8));
  for (const row of store.search(scope, query)) {
    const score = relevance(row.content, terms);
    const promoted = !!row.source && typeof row.source === 'object' && row.source.type === 'distill-promoted';
    if (promoted) continue;
    if (score > 0 || personal && ['profile', 'core'].includes(row.kind)) rows.push({ id: 'note:' + row.id, layer: row.kind === 'experience' ? 'experience' : 'note', priority: 50 + score, reason: 'note-match', scores: { keyword: score }, data: { id: row.id, kind: row.kind, content: row.content, source: row.source } });
  }
  for (const row of store.evidence.search(scope, query)) rows.push({ id: 'observation:' + row.id, layer: row.kind, priority: 80 + row.score, reason: 'current-confirmed-observation', scores: { keyword: row.score }, data: { id: row.id, subject: row.subject, predicate: row.predicate, value: row.value, modality: row.modality, source_mode: row.source_mode, source_id: row.source_id, quote: row.quote, observed_at: row.observed_at, supersedes: row.supersedes } });
  return rows.sort((a, b) => b.priority - a.priority || compareId(a.id, b.id));
}

// Keep a relevant fact from the active project ahead of old-project facts when
// the user has not asked to inspect other projects. Core and master profile
// entries are global documents, so they retain their original priority.
export function scopedMemoryCandidate(item, candidateScope, currentScope, query) {
  const asksAcrossProjects = /跨项目|所有项目|其他项目|别的项目|另一个项目|旧项目|上个项目|以前的?项目|过去的?项目|历史项目/.test(query);
  const projectSpecific = item.layer !== 'core' && item.layer !== 'profile';
  const blocked = candidateScope !== currentScope && projectSpecific && !asksAcrossProjects;
  return {
    ...item,
    priority: blocked ? item.priority - 100 : item.priority,
    reason: blocked ? item.reason + ':other-project' : item.reason,
    data: { ...item.data, scope: candidateScope },
    ...(blocked ? { _blocked: true } : {}),
  };
}

