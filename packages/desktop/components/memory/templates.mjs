// Templates stay in the editor until the user saves them.
export const CORE_TEMPLATES = Object.freeze([
  Object.freeze({ id: 'language', label: '交流语言', content: '默认用中文交流，专业术语附简短说明。' }),
  Object.freeze({ id: 'reply', label: '回复方式', content: '先给结论，再列操作步骤；回答简洁直接。' }),
  Object.freeze({ id: 'collaboration', label: '协作偏好', content: '修改前保留已有内容，完成后说明结果和未完成项。' }),
]);
export function profileTemplate() {
  return { identity: { 称呼: '', 职业: '', 所在地: '' }, preferences: { 交流语言: '中文', 回复方式: '先给结论，再给步骤', 篇幅: '简洁' }, personality: { 协作方式: '', 需要避免: '' }, current_state: { 当前项目: '', 近期目标: '' }, notes: [] };
}
export function hasProfileContent(value) {
  if (value === null || value === undefined || value === '') return false;
  return typeof value === 'object' ? Object.values(value).some(hasProfileContent) : true;
}
export function supplementProfile(value, template = profileTemplate()) {
  const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!object(value) || !object(template)) return structuredClone(value);
  const result = structuredClone(value);
  for (const [key, item] of Object.entries(template)) {
    const next = Object.hasOwn(value, key) ? supplementProfile(value[key], item) : structuredClone(item);
    Object.defineProperty(result, key, { value: next, enumerable: true, writable: true, configurable: true });
  }
  return result;
}
