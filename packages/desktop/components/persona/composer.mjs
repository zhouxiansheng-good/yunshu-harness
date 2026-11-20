import { stableJson, contentHash, estimateContextTokens, compareId } from './shared/context-contract.mjs';
export function composeContext({ identityText, candidates = [], capabilities = [], maxTokens = 2200, maxChars = 6500, maxReferenceTokens = maxTokens, maxReferenceChars = maxChars, countTokens = estimateContextTokens }) {
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 256 || maxTokens > 20000 || !Number.isSafeInteger(maxChars) || maxChars < 1024 || maxChars > 60000 || !Number.isSafeInteger(maxReferenceTokens) || maxReferenceTokens < 1 || maxReferenceTokens > maxTokens || !Number.isSafeInteger(maxReferenceChars) || maxReferenceChars < 1 || maxReferenceChars > maxChars) throw new Error('人格上下文预算无效');
  if (countTokens(identityText) > maxTokens || identityText.length > maxChars) throw new Error('身份内核超过上下文预算');
  const records = [], acceptedCapabilities = [], selected = [], omitted = [], seen = new Set();
  const render = () => records.length || acceptedCapabilities.length ? stableJson({ type: 'yunshu_reference_data', instructions: false, capabilities: acceptedCapabilities, records }) : '';
  const fits = () => { const text = render(); return identityText.length + text.length <= maxChars && countTokens(identityText + text) <= maxTokens && text.length <= maxReferenceChars && countTokens(text) <= maxReferenceTokens; };
  // Only compact status/evidence enters the request. Poll times stay outside.
  for (const item of [...capabilities].sort((a, b) => compareId(a.id, b.id))) {
    acceptedCapabilities.push({ id: item.id, state: item.state, evidence: item.evidence });
    if (!fits()) { acceptedCapabilities.pop(); omitted.push({ id: 'capability:' + item.id, reason: 'budget' }); }
  }
  for (const item of [...candidates].sort((a, b) => b.priority - a.priority || compareId(a.id, b.id))) {
    if (seen.has(item.id)) continue; seen.add(item.id);
    records.push({ id: item.id, layer: item.layer, ...item.data });
    if (!fits()) { records.pop(); omitted.push({ id: item.id, reason: 'budget' }); continue; }
    selected.push({ id: item.id, layer: item.layer, reason: item.reason });
  }
  const text = render();
  return { text, diagnostics: { identityHash: contentHash(identityText), contextHash: contentHash(text), selected, omitted, estimatedTokens: countTokens(identityText + text), tokenMethod: countTokens === estimateContextTokens ? 'utf8-bytes-divided-by-3-estimate' : 'caller-supplied', chars: identityText.length + text.length, budget: { maxTokens, maxChars, maxReferenceTokens, maxReferenceChars }, budgetScope: 'yunshu-identity-and-reference-block-only', cacheUsage: { status: 'not_observed', hitTokens: null, missTokens: null } } };
}
