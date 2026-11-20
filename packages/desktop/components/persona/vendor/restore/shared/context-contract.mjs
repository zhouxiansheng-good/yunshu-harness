import { createHash } from 'node:crypto';
export function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  return '{' + Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => JSON.stringify(k) + ':' + stableJson(value[k])).join(',') + '}';
}
export const contentHash = value => createHash('sha256').update(typeof value === 'string' ? value : stableJson(value)).digest('hex');
// This is an estimate, not the provider's tokenizer or billed usage.
export const estimateContextTokens = text => Math.ceil(Buffer.byteLength(text, 'utf8') / 3);
export const compareId = (a, b) => a < b ? -1 : a > b ? 1 : 0;
