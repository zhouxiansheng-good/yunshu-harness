import { CORE_TEMPLATES, profileTemplate, hasProfileContent, supplementProfile } from './templates.mjs';
export function MemoryView({ sessionId, call, onActiveChange, embedded = false, mediaSection = null }) {
  const anchor = React.useRef(null);
  const h = React.createElement, [open, setOpen] = React.useState(embedded), [data, setData] = React.useState(null);
  const [error, setError] = React.useState(''), [busy, setBusy] = React.useState(false), [query, setQuery] = React.useState('');
  const [draft, setDraft] = React.useState({ kind: 'long_term', content: '', version: 0 }), [packet, setPacket] = React.useState(''), [details, setDetails] = React.useState('');
  const [storageDraft, setStorageDraft] = React.useState('');
  const life = React.useRef();
  React.useEffect(() => {
    const abort = new AbortController(); life.current = abort;
    setData(null); setError(''); setBusy(false); setPacket(''); setDetails(''); setQuery(''); setDraft({ kind: 'long_term', content: '', version: 0 });
    if (open && sessionId) call(sessionId, 'list', {}, abort.signal).then(v => { if (!abort.signal.aborted) { setData(v); setStorageDraft(v.storage?.pending ?? v.storage?.active ?? ''); } }).catch(e => { if (!abort.signal.aborted) setError(e.message); });
    return () => abort.abort();
  }, [sessionId, open]);
  React.useEffect(() => { onActiveChange?.(open); return () => onActiveChange?.(false); }, [open]);
  React.useEffect(() => {
    if (!open || !sessionId) return;
    const abort = new AbortController(); let timer;
    const refresh = async () => {
      try {
        const [indexing, autoMemory] = await Promise.allSettled([
          call(sessionId, 'index-status', {}, abort.signal),
          call(sessionId, 'auto-memory-status', {}, abort.signal),
        ]);
        if (!abort.signal.aborted) setData(value => value ? {
          ...value,
          ...(indexing.status === 'fulfilled' ? { indexing: indexing.value } : {}),
          ...(autoMemory.status === 'fulfilled' ? { autoMemory: autoMemory.value } : {}),
        } : value);
      }
      catch { /* main refresh shows connection errors; polling never replaces edits */ }
      if (!abort.signal.aborted) timer = setTimeout(refresh, 2000);
    };
    timer = setTimeout(refresh, 2000);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [open, sessionId]);
  const run = async operation => {
    const signal = life.current.signal; setBusy(true); setError('');
    try { await operation(signal); if (!signal.aborted) { const fresh = await call(sessionId, 'list', {}, signal); if (!signal.aborted) setData(fresh); } }
    catch (e) { if (!signal.aborted) setError(e.message); }
    finally { if (!signal.aborted) setBusy(false); }
  };
  const button = (label, action, disabled = false) => h('button', { type: 'button', disabled: busy || disabled, onClick: action }, label);
  const labels = { core: '旧版核心记录', profile: '旧版档案记录', long_term: '笔记', experience: '经验' };
  const records = data?.records.filter(r => !query || r.content.toLowerCase().includes(query.toLowerCase())) ?? [];
  return h('div', { className: 'ys-plugin', ref: anchor, style: embedded ? { display: 'contents' } : undefined }, !embedded && h('button', { type: 'button', disabled: !sessionId, onClick: () => setOpen(!open), 'aria-expanded': open }, '记忆'), open && h(embedded ? EmbeddedPanel : Panel, { anchor, label: '云舒记忆', onClose: () => setOpen(false) },
    !embedded && h('div', { className: 'ys-row' }, h('h3', null, '云舒记忆'), button('关闭', () => setOpen(false))),
    h(AutoMemoryControl, { data, call, sessionId, run, busy }),
    h('details', { open: true }, h('summary', null, '存档区'),
      h('div', { className: 'ys-card', 'aria-label': '当前存档位置' }, h('strong', null, '当前位置'), h('code', { style: { display: 'block', overflowWrap: 'anywhere' } }, data?.storage?.active ?? '加载中…')),
      h('label', { style: { display: 'block' } }, '切换存档区', h('input', { 'aria-label': '选择存档文件夹', value: storageDraft, placeholder: '输入文件夹完整路径', style: { display: 'block', width: '100%', boxSizing: 'border-box' }, onChange: e => setStorageDraft(e.target.value) })),
      button('使用此存档区', () => run(async signal => { const result = await call(sessionId, 'storage-select', { path: storageDraft }, signal); if (!signal.aborted) setData(value => value ? { ...value, storage: result } : value); }), !storageDraft.trim()),
      data?.storage?.pending && h('div', { role: 'status', style: { overflowWrap: 'anywhere' } }, '待启用：' + data.storage.pending + ' · 完整退出并重启 DeepSeek 后生效'),
      data?.storage?.error && h('div', { role: 'alert', className: 'ys-error' }, data.storage.error),
      data?.storage?.paths && h('details', null, h('summary', null, '详细文件位置'), ...Object.entries({ '记忆': data.storage.paths.memory, '身份': data.storage.paths.identity, '媒体': data.storage.paths.media }).map(([name, path]) => h('p', { key: name, style: { overflowWrap: 'anywhere' } }, name + '：' + path))),
      h('small', null, '切换到空文件夹时复制现有存档。')),
    mediaSection && h('details', null, h('summary', null, '附件与备份'), mediaSection),
    h(MemoryLayers, { key: sessionId, data, call, sessionId, run, busy }),
    h(EvidenceView, { key: 'evidence:' + sessionId, sessionId, call }),
    h('details', null, h('summary', null, '工作区笔记与人工复核'),
    data?.otherProjects > 0 && h('details', null, h('summary', null, '其他项目记忆 · ' + data.otherProjects + ' 个项目'), ...data.otherRecords.map(row => h('article', { className: 'ys-card', key: row.id }, h('small', null, '其他项目 · ' + (labels[row.kind] ?? row.kind)), h('p', null, row.content)))),
    error && h('div', { role: 'alert', className: 'ys-error' }, error),
    h('div', { className: 'ys-row' }, h('input', { 'aria-label': '筛选记忆', placeholder: '筛选记忆…', value: query, onChange: e => setQuery(e.target.value) }), button('刷新', () => run(async () => {})), button('搜索', () => run(async signal => { const result = await call(sessionId, 'search', { query }, signal); if (!signal.aborted) setDetails(JSON.stringify(result, null, 2)); }), !query.trim())),
    ...(data?.proposals ?? []).map(p => h('article', { className: 'ys-card', key: p.id }, h('small', null, '待确认 · ' + (p.kind === 'core' ? '核心事实' : labels[p.kind])), h('p', null, p.content), h('div', { className: 'ys-row' }, button('确认写入', () => run(signal => call(sessionId, p.kind === 'core' ? 'accept-core' : 'accept', { id: p.id, version: data.core.version }, signal))), button('拒绝', () => run(signal => call(sessionId, 'reject', { id: p.id }, signal)))))),
    ...records.slice(0, 100).map(r => h('article', { className: 'ys-card' + (r.deleted ? ' ys-muted' : ''), key: r.id }, h('small', null, labels[r.kind] + ' · v' + r.version + (r.deleted ? ' · 已撤回' : '')), h('p', null, r.content), h('small', null, '来源：' + ({ user: '手动添加', 'model-proposal': '对话建议', 'model-autosave': 'AI 自动整理', import: '导入' }[r.source?.type] ?? '其他')), h('div', { className: 'ys-row' }, button('编辑', () => setDraft({ id: r.id, kind: r.kind, content: r.content, version: r.version }), r.deleted), button('撤回', () => { if (confirm('撤回这条记忆并保留历史？')) void run(signal => call(sessionId, 'withdraw', { id: r.id, version: r.version }, signal)); }, r.deleted), button('恢复上一版', () => { if (confirm('恢复上一版？')) void run(signal => call(sessionId, 'undo', { id: r.id, version: r.version }, signal)); }), button('历史', () => run(async signal => { const result = await call(sessionId, 'history', { id: r.id }, signal); if (!signal.aborted) setDetails(JSON.stringify(result, null, 2)); })), data?.embedding && button('建立向量', () => run(signal => call(sessionId, 'index', { id: r.id, version: r.version }, signal)), r.deleted)))),
    records.length > 100 && h('small', null, '显示前 100 条'),
    h('h3', null, draft.id ? '编辑记忆' : '新建记忆'),
    h('select', { value: draft.kind, 'aria-label': '记忆层级', onChange: e => setDraft({ ...draft, kind: e.target.value }) }, ...Object.entries(labels).filter(([v]) => !['core', 'profile'].includes(v) || draft.kind === v).map(([v, label]) => h('option', { key: v, value: v }, label))),
    h('textarea', { value: draft.content, 'aria-label': '记忆内容', maxLength: 12000, placeholder: '输入记忆内容', onChange: e => setDraft({ ...draft, content: e.target.value }) }),
    h('div', { className: 'ys-row' }, button('确认保存', () => run(async signal => { await call(sessionId, 'save', draft, signal); if (!signal.aborted) setDraft({ kind: 'long_term', content: '', version: 0 }); }), !draft.content.trim()), button('清空', () => setDraft({ kind: 'long_term', content: '', version: 0 }))),
    h('details', null, h('summary', null, '导入与导出'),
      button('导出记录', () => run(async signal => { const result = await call(sessionId, 'export', {}, signal); if (signal.aborted) return; const content = JSON.stringify(result, null, 2); setPacket(content); const url = URL.createObjectURL(new Blob([content], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = 'yunshu-memory.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); })),
      h('textarea', { 'aria-label': '导入数据', value: packet, onChange: e => setPacket(e.target.value), placeholder: '粘贴 JSON 记录' }),
      button('确认导入', () => { if (confirm('恢复备份或导入笔记？已有内容保持不变。')) void run(signal => call(sessionId, JSON.parse(packet).format === 'yunshu-memory-layers' ? 'layered-restore' : 'import', { packet: JSON.parse(packet) }, signal)); }, !packet.trim()),
      details && h('textarea', { 'aria-label': '详情结果', readOnly: true, value: details }))),
    !data && !error && h('small', null, '加载中…')
  ));
}

function AutoMemoryControl({ data, call, sessionId, run, busy }) {
  const h = React.createElement;
  if (!data) return null;
  const auto = data.autoMemory;
  const autoError = auto?.jobs?.findLast(job => job.status === 'failed')?.last_error ?? auto?.workerError;
  const autoErrorLabels = { MODEL_UNAVAILABLE: '等待回答模型', SOURCE_INCOMPLETE: '原话未完整保存', SOURCE_CORRUPT: '原话校验失败', SOURCE_CHANGED: '提炼时原话已变更', EXTRACTION_INVALID: '提取结果格式错误', PROVENANCE_MISMATCH: '来源校验失败', WINDOW_TOO_LARGE: '原话超过自动提炼调用上限', MODEL_FAILED: '模型返回失败', EXTRACTION_FAILED: '提取失败', ABORTED: '已中断' };
  return h(React.Fragment, null,
    h('h3', null, '自动记忆'),
    auto?.available !== false && h('button', { type: 'button', disabled: busy, 'aria-label': auto?.enabled ? '关闭自动记忆' : '开启自动记忆', 'aria-pressed': auto?.enabled === true, onClick: () => run(signal => call(sessionId, 'auto-memory-set-enabled', { enabled: !auto?.enabled }, signal)) }, auto?.enabled ? '关闭自动记忆' : '开启自动记忆'),
    h('div', { className: 'ys-card', role: 'status', 'aria-label': '自动记忆状态' }, auto?.enabled === false ? '自动记忆已关闭' : '自动记忆已启用 · 已保存 ' + (auto?.counts?.done ?? 0) + ' 轮 · 等待 ' + (auto?.counts?.pending ?? 0) + ' 轮 · 重试 ' + (auto?.counts?.failed ?? 0) + ' 轮'),
    data.captureError && h('div', { role: 'alert', className: 'ys-error' }, data.captureError),
    auto && h('details', null, h('summary', null, '写入详情'),
      auto.cachedSegments > 0 && h('div', { role: 'status' }, '已保留 ' + auto.cachedSegments + ' 段 · 下次接续'),
      auto.captureFailures > 0 && h('div', { role: 'alert', className: 'ys-error' }, '原话保存失败 ' + auto.captureFailures + ' 条'),
      autoError && h('div', { role: 'alert', className: 'ys-error' }, autoErrorLabels[autoError] ?? '自动记忆暂不可用')));
}

export function MemoryLayers({ data, call, sessionId, run, busy }) {
  const h = React.createElement;
  const [fact, setFact] = React.useState(''), [editing, setEditing] = React.useState(null);
  const button = (label, onClick, disabled = false) => h('button', { type: 'button', onClick, disabled: busy || disabled }, label);
  if (!data) return null;
  const saveFact = () => run(async signal => {
    const stamp = new Date().toISOString(), current = data.core.content;
    const entry = { id: editing ?? crypto.randomUUID(), content: fact.trim(), created_at: current.find(r => r.id === editing)?.created_at ?? stamp, updated_at: stamp };
    const content = editing ? current.map(r => r.id === editing ? entry : r) : [...current, entry];
    await call(sessionId, 'core-save', { content, version: data.core.version }, signal);
    if (!signal.aborted) { setFact(''); setEditing(null); }
  });
  return h(React.Fragment, null,
    h('h3', null, '个人记忆'),
    h('details', null, h('summary', null, '核心事实 · ' + data.core.content.length),
      ...data.core.content.map(entry => h('article', { className: 'ys-card', key: entry.id }, h('p', null, entry.content), h('div', { className: 'ys-row' },
        button('编辑', () => { setEditing(entry.id); setFact(entry.content); }),
        button('撤回', () => { if (confirm('撤回这条核心事实？')) void run(signal => call(sessionId, 'core-save', { content: data.core.content.filter(r => r.id !== entry.id), version: data.core.version }, signal)); })))),
      h('details', { open: data.core.content.length === 0 }, h('summary', null, '事实模板 · 保存后生效'),
        ...CORE_TEMPLATES.map(item => h('article', { className: 'ys-card', key: item.id }, h('strong', null, item.label), h('p', null, item.content),
          button('使用' + item.label + '模板', () => { if (fact.trim() && !confirm('替换尚未保存的事实草稿？')) return; setEditing(null); setFact(item.content); })))),
      h('textarea', { 'aria-label': '核心事实内容', value: fact, maxLength: 12000, placeholder: '输入核心事实', onChange: e => setFact(e.target.value) }),
      h('div', { className: 'ys-row' }, button(editing ? '保存事实' : '添加事实', saveFact, !fact.trim()), button('清空', () => { setFact(''); setEditing(null); }))),
    h('details', null, h('summary', null, '个人档案'),
      h(ProfileEditor, { content: data.master.content, call, sessionId, run, busy })),
    data.indexing?.enabled && h('details', null, h('summary', null, '本地索引'),
      h('div', { role: 'status', 'aria-label': '索引状态' }, ({ idle: data.indexing.pending ? '等待索引' : '已就绪', indexing: '正在索引', paused: '已暂停', error: '索引失败', closed: '已停止' })[data.indexing.state] + ' · ' + data.indexing.indexed + ' / ' + data.indexing.total),
      data.indexing.error && h('div', { role: 'alert', className: 'ys-error' }, data.indexing.error),
      h('div', { className: 'ys-row' },
        button(data.indexing.state === 'paused' ? '继续索引' : data.indexing.state === 'error' ? '重试索引' : '暂停索引', () => run(signal => call(sessionId, ['paused','error'].includes(data.indexing.state) ? 'index-resume' : 'index-pause', {}, signal))),
        button('重建当前工作区索引', () => { if (confirm('重建当前工作区索引？记忆内容保持不变。')) void run(signal => call(sessionId, 'index-rebuild', {}, signal)); }))),
    h('details', null, h('summary', null, '对话记录 · ' + data.window.length + ' 条'),
      ...data.window.slice(-10).map(r => h('article', { className: 'ys-card', key: r.id }, h('small', null, r.role === 'user' ? '我' : '回复'), h('p', null, r.content))),
      button('归档当前记录', () => { if (confirm('归档当前对话记录？')) void run(signal => call(sessionId, 'archive', {}, signal)); }, !data.window.length)),
    h('details', null, h('summary', null, '长期归档 · ' + data.archives.length + ' 条'),
      ...data.archives.slice(0, 30).map(r => h('article', { className: 'ys-card', key: r.id }, h('p', null, r.content), h('div', { className: 'ys-row' },
        button('撤回', () => { if (confirm('撤回这条归档？')) void run(signal => call(sessionId, 'archive-withdraw', { id: r.id }, signal)); }),
        data.embedding && button('建立向量', () => run(signal => call(sessionId, 'archive-index', { id: r.id }, signal))))))),
    button('导出记忆 JSON', () => run(async signal => {
      const packet = await call(sessionId, 'layered-export', {}, signal); if (signal.aborted) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify(packet, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = 'yunshu-memory-backup.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }))
  );
}

export function ProfileEditor({ content, call, sessionId, run, busy }) {
  const h = React.createElement, [draft, setDraft] = React.useState(null), [advanced, setAdvanced] = React.useState(null), [error, setError] = React.useState('');
  const button = (label, onClick) => h('button', { type: 'button', disabled: busy, onClick }, label);
  const end = () => { setDraft(null); setAdvanced(null); setError(''); };
  const save = () => {
    let value;
    try { value = advanced === null ? profileValue(draft) : JSON.parse(advanced); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('档案须为对象'); }
    catch (e) { setError(e.message === '字段名重复' || e.message === '请输入有效数字' ? e.message : '档案格式无效'); return; }
    void run(async signal => { await call(sessionId, 'master-save', { content: value }, signal); if (!signal.aborted) end(); });
  };
  if (draft === null) return h(React.Fragment, null,
    !hasProfileContent(content) && h('small', { 'aria-label': '档案模板状态' }, '默认档案 · 未保存'),
    ...Object.entries(hasProfileContent(content) ? content : supplementProfile(content)).map(([key, value]) => h('article', { className: 'ys-card', key }, h('strong', null, ({ __proto__: null, identity: '身份', preferences: '偏好', personality: '性格', current_state: '近况', notes: '备注' })[key] ?? key), h(ProfileDisplay, { value }))),
    button('编辑档案', () => { setDraft(profileDraft(hasProfileContent(content) ? content : supplementProfile(content))); setError(''); }),
    hasProfileContent(content) && button('补充默认字段', () => { setDraft(profileDraft(supplementProfile(content))); setError(''); }));
  return h('div', { className: 'ys-profile-editor' },
    h('fieldset', { disabled: busy, style: { border: 0, margin: 0, padding: 0, minWidth: 0 } },
      advanced === null && h(ProfileField, { draft, change: setDraft, label: '档案', depth: 0, root: true }),
      h('details', { onToggle: e => {
        if (e.currentTarget.open && advanced === null) { try { setAdvanced(JSON.stringify(profileValue(draft), null, 2)); setError(''); } catch (error) { e.currentTarget.open = false; setError(error.message); } }
        if (!e.currentTarget.open && advanced !== null) { try { const value = JSON.parse(advanced); if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(); setDraft(profileDraft(value)); setAdvanced(null); setError(''); } catch { e.currentTarget.open = true; setError('档案格式无效'); } }
      } }, h('summary', null, '高级 JSON'), advanced !== null && h('textarea', { 'aria-label': '个人档案内容', value: advanced, maxLength: 50000, onChange: e => setAdvanced(e.target.value) }))),
    error && h('div', { role: 'alert', className: 'ys-error' }, error),
    h('div', { className: 'ys-row', style: { position: 'sticky', bottom: -16, padding: '10px 0', background: 'var(--dsw-alias-bg-base, Canvas)', borderTop: '1px solid color-mix(in srgb,currentColor 15%,transparent)' } }, button('保存档案', save), button('取消编辑', end)));
}

export function ProfileField({ draft, change, label, depth, root = false }) {
  const h = React.createElement, [newKey, setNewKey] = React.useState(''), [newType, setNewType] = React.useState('string'), [error, setError] = React.useState('');
  const types = { string: '文本', number: '数字', boolean: '开关', array: '列表', object: '分组', null: '空值' };
  const names = { __proto__: null, identity: '身份', preferences: '偏好', personality: '性格', current_state: '近况', notes: '备注' };
  const group = ['object','array'].includes(draft.type);
  const select = (value, action, name) => h('select', { 'aria-label': name, value, onChange: e => action(e.target.value) }, ...Object.entries(types).map(([key, title]) => h('option', { key, value: key }, title)));
  const update = (i, patch) => change({ ...draft, children: draft.children.map((row, j) => j === i ? { ...row, ...patch } : row) });
  const add = () => {
    if (draft.type === 'object' && (!newKey.trim() || draft.children.some(row => row.key === newKey.trim()))) { setError('请输入未使用的字段名'); return; }
    change({ ...draft, children: [...draft.children, { key: draft.type === 'object' ? newKey.trim() : '', value: emptyProfileField(newType) }] }); setNewKey(''); setError('');
  };
  // Deep custom values remain lossless and editable through Advanced JSON.
  if (depth > 8) return h('div', { className: 'ys-card' }, label, h('pre', null, JSON.stringify(profileValue(draft), null, 2)));
  return h('div', { className: root ? '' : 'ys-card', style: { display: 'grid', gap: 8, minWidth: 0 } },
    !root && h('div', { className: 'ys-row' }, h('strong', null, label), select(draft.type, value => { if (confirm('更改字段类型并清空原值？')) change(emptyProfileField(value)); }, label + '类型')),
    group ? h(React.Fragment, null,
      ...draft.children.map((row, i) => h('div', { key: i, style: { display: 'grid', gap: 5 } },
        h('div', { className: 'ys-row' }, draft.type === 'object' && !Object.hasOwn(names, row.key) && h('input', { 'aria-label': label + '字段名' + (i + 1), value: row.key, onChange: e => update(i, { key: e.target.value }) }),
          h('button', { type: 'button', onClick: () => change({ ...draft, children: draft.children.filter((_, j) => j !== i) }), 'aria-label': '删除' + (names[row.key] ?? (row.key || label + (i + 1))) }, root ? '删除' + (names[row.key] ?? row.key) : '删除')),
        h(ProfileField, { draft: row.value, change: value => update(i, { value }), label: names[row.key] ?? (row.key || label + (i + 1)), depth: depth + 1 }))),
      h('div', { className: 'ys-row' }, draft.type === 'object' && h('input', { 'aria-label': label + '新字段名', value: newKey, placeholder: '字段名', onChange: e => setNewKey(e.target.value) }), select(newType, setNewType, label + '新字段类型'), h('button', { type: 'button', onClick: add }, draft.type === 'array' ? '添加' + label : '添加' + label + '字段')),
      error && h('div', { role: 'alert', className: 'ys-error' }, error)) :
      draft.type === 'boolean' ? h('label', null, h('input', { type: 'checkbox', 'aria-label': label, checked: draft.text === 'true', onChange: e => change({ ...draft, text: String(e.target.checked) }) }), '启用') :
      draft.type === 'null' ? h('span', null, '空值') :
      h(draft.type === 'string' ? 'textarea' : 'input', { 'aria-label': label, value: draft.text, inputMode: draft.type === 'number' ? 'decimal' : undefined, maxLength: 50000, onChange: e => change({ ...draft, text: e.target.value }) }));
}

export function ProfileDisplay({ value, depth = 0 }) {
  const h = React.createElement;
  if (value === null) return h('small', null, '未设置');
  if (typeof value !== 'object') return h('p', null, typeof value === 'boolean' ? (value ? '是' : '否') : String(value));
  if (!Object.keys(value).length) return h('small', null, '未设置');
  if (depth > 8) return h('p', null, JSON.stringify(value));
  return Array.isArray(value) ? h('ul', { style: { margin: 0, paddingLeft: 20 } }, ...value.map((item, i) => h('li', { key: i }, h(ProfileDisplay, { value: item, depth: depth + 1 })))) :
    h('dl', { style: { margin: 0, display: 'grid', gap: 6 } }, ...Object.entries(value).map(([key, item]) => h('div', { key, style: { display: 'grid', gridTemplateColumns: 'minmax(60px, 25%) minmax(0, 1fr)', gap: 10 } }, h('dt', null, key), h('dd', { style: { margin: 0, minWidth: 0 } }, h(ProfileDisplay, { value: item, depth: depth + 1 })))));
}
