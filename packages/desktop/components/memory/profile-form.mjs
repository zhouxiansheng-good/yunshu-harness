// Lossless JSON drafts: numeric input stays text until validation at Save.
// Objects/arrays retain their shape, unknown fields and explicit nulls.
export function profileDraft(value) {
  if (value === null) return { type: 'null', text: '' };
  if (Array.isArray(value)) return { type: 'array', children: value.map(v => ({ key: '', value: profileDraft(v) })) };
  if (typeof value === 'object') return { type: 'object', children: Object.entries(value).map(([key, v]) => ({ key, value: profileDraft(v) })) };
  return { type: typeof value, text: String(value) };
}
export function profileValue(draft) {
  switch (draft.type) {
    case 'string': return draft.text;
    case 'null': return null;
    case 'boolean': if (!['true','false'].includes(draft.text)) throw new Error('开关值无效'); return draft.text === 'true';
    case 'number': {
      if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(draft.text) || !Number.isFinite(Number(draft.text))) throw new Error('请输入有效数字');
      return Number(draft.text);
    }
    case 'array': return draft.children.map(row => profileValue(row.value));
    case 'object': {
      const keys = draft.children.map(row => row.key);
      if (new Set(keys).size !== keys.length) throw new Error('字段名重复');
      return Object.fromEntries(draft.children.map(row => [row.key, profileValue(row.value)]));
    }
    default: throw new Error('字段类型无效');
  }
}
export function emptyProfileField(type) {
  return ['object','array'].includes(type) ? { type, children: [] } : { type, text: type === 'number' ? '0' : type === 'boolean' ? 'false' : '' };
}
