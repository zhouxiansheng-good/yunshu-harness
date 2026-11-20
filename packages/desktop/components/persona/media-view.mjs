export function MediaView({ sessionId, call, onActiveChange, embedded = false }) {
  const h = React.createElement, anchor = React.useRef(null), life = React.useRef(null), operation = React.useRef(null);
  const [open, setOpen] = React.useState(embedded), [data, setData] = React.useState(null), [error, setError] = React.useState(''), [message, setMessage] = React.useState(''), [busy, setBusy] = React.useState(false);
  const [loadError, setLoadError] = React.useState('');
  const [attachmentSource, setAttachmentSource] = React.useState(''), [attachments, setAttachments] = React.useState(null), [partIndex, setPartIndex] = React.useState('');
  const [file, setFile] = React.useState(null), [fileKey, setFileKey] = React.useState(0), [uploadProgress, setUploadProgress] = React.useState(null);
  const [backup, setBackup] = React.useState(''), [source, setSource] = React.useState(''), [destination, setDestination] = React.useState('');
  React.useEffect(() => {
    const abort = new AbortController(); life.current = abort; let timer;
    setData(null); setError(''); setLoadError(''); setMessage(''); setBusy(false); setBackup(''); setSource(''); setDestination('');
    setAttachmentSource(''); setAttachments(null); setPartIndex(''); setFile(null); setFileKey(n => n + 1); setUploadProgress(null);
    const refresh = async () => {
      try { const result = await call(sessionId, 'media-status', {}, abort.signal); if (!abort.signal.aborted) { setData(result); setLoadError(''); } }
      catch (e) { if (!abort.signal.aborted) setLoadError(e.message); }
      if (!abort.signal.aborted) timer = setTimeout(refresh, 2000);
    };
    if (open && sessionId) void refresh();
    return () => { abort.abort(); clearTimeout(timer); const pending = operation.current; pending?.abort(); if (operation.current === pending) operation.current = null; };
  }, [sessionId, open]);
  React.useEffect(() => { onActiveChange?.(open); return () => onActiveChange?.(false); }, [open]);
  const run = async (action, payload = {}, success = '已完成', execute) => {
    const scopeLife = life.current; if (!scopeLife || scopeLife.signal.aborted || operation.current) return;
    const abort = new AbortController(); operation.current = abort; const signal = AbortSignal.any([scopeLife.signal, abort.signal]);
    setBusy(true); setError(''); setMessage('');
    try {
      const result = execute ? await execute(signal) : await call(sessionId, action, payload, signal);
      if (!signal.aborted) setMessage(typeof success === 'function' ? success(result) : success);
    } catch (e) {
      if (!scopeLife.signal.aborted) {
        if (action === 'media-upload') setUploadProgress(null);
        if (e?.details?.cleanupComplete === false || e?.details?.incompleteDirectory || e?.details?.uploadCleanupConfirmed === false) {
          const leftover = e.details.incompleteDirectory;
          setError(e.message + (leftover && !e.message.includes(leftover) ? '；残留目录：' + leftover : ''));
        } else if (abort.signal.aborted) setMessage(['media-backup', 'media-restore'].includes(action) ? '已请求取消；请检查目标目录' : action === 'media-upload' ? '已请求取消；请检查附件状态' : '已请求取消');
        else setError(e.message);
      }
    } finally {
      if (operation.current === abort) operation.current = null;
      if (!scopeLife.signal.aborted) { setBusy(false); try { const result = await call(sessionId, 'media-status', {}, scopeLife.signal); if (!scopeLife.signal.aborted) setData(result); } catch (e) { if (!scopeLife.signal.aborted) setError(e.message); } }
    }
  };
  const loadParts = (id = attachmentSource, offset = 0) => run('media-parts', { sourceId: id, offset }, result => {
    setAttachmentSource(result.sourceId); setAttachments(result); setPartIndex(''); setFile(null); setFileKey(n => n + 1); setUploadProgress(null); return '附件已加载';
  });
  const selectedPart = attachments?.items.find(item => String(item.partIndex) === partIndex);
  const upload = () => {
    if (!file || !selectedPart?.canImport || !confirm('将所选文件补交到此附件？保留补交标记，不替换原始消息。')) return;
    return run('media-upload', {}, result => { setFile(null); setFileKey(n => n + 1); setAttachments(current => ({ ...current, items: current.items.map(item => item.partIndex === selectedPart.partIndex ? { ...item, origin: result.origin, retained: true, mimeType: result.mimeType } : item) })); return '文件已补交；请重新检查处理状态'; }, signal => uploadMediaFile({ file, sourceId: attachments.sourceId, partIndex: selectedPart.partIndex, mimeType: selectedPart.mimeType, sessionId, call, signal, maxBytes: data.limits.maxAssetBytes, onProgress: progress => { if (!signal.aborted) setUploadProgress(progress); } }));
  };
  const button = (label, fn, disabled = false) => h('button', { type: 'button', onClick: fn, disabled: busy || disabled }, label);
  const scanNames = { idle: '已完成', queued: '等待处理', scanning: '检查中', paused: '已暂停', attention: '需要处理', failed: '检查失败', closed: '已关闭' };
  const jobNames = { pending: '待处理', complete: '已保存', 'reference-only': '仅有引用', partial: '部分完成', failed: '处理失败', withdrawn: '来源已撤回' };
  const errors = { BATCH_LIMIT: '请继续补扫', MEDIA_MISSING: '请重新补交文件', INTEGRITY_ERROR: '文件损坏', PART_LIMIT: '附件数量超限', VAULT_BUSY: '媒体库正在使用', RECOVERY_BUSY: '补扫正在运行' };
  const counts = data?.progress.states ?? {}, total = Object.values(counts).reduce((a, b) => a + b, 0);
  const pending = counts.pending ?? 0;
  const attention = (counts['reference-only'] ?? 0) + (counts.failed ?? 0) + (counts.partial ?? 0);
  const needsRepair = attention > 0 || !!data?.scan.error || (data?.scan.paused && data?.progress.undiscovered) || ['degraded', 'failed'].includes(data?.health?.state);
  const problemJobs = (data?.jobs ?? []).filter(job => ['pending', 'reference-only', 'partial', 'failed'].includes(job.state));
  const attachmentList = attachments && h('div', { className: 'ys-card', style: { minWidth: 0 } },
    h('select', { 'aria-label': '目标附件', style: { minWidth: 0, maxWidth: '100%' }, value: partIndex, disabled: busy, onChange: e => { setPartIndex(e.target.value); setFile(null); setFileKey(n => n + 1); setUploadProgress(null); } },
      h('option', { value: '' }, '选择附件'),
      ...attachments.items.map(item => h('option', { key: item.partIndex, value: String(item.partIndex) }, '附件 '+(item.partIndex + 1)+' · '+(item.name || ({ image: '图片', audio: '音频', video: '视频', file: '文件' }[item.type]))))),
    attachments.nextOffset !== null && button('下一页附件', () => loadParts(attachments.sourceId, attachments.nextOffset)),
    selectedPart && h('div', null,
      h('small', null, selectedPart.origin === 'owner-import' ? '用户补交' : selectedPart.canImport ? '仅有引用' : '内联附件'),
      button('检查文件', () => run('media-verify', { sourceId: attachments.sourceId, partIndex: selectedPart.partIndex }, result => ({ verified: '文件检查通过', missing: '文件缺失', corrupt: '文件损坏', 'not-retained': '尚未保存文件', 'source-unavailable': '来源已撤回', 'source-changed': '来源已变更' }[result.status] ?? '文件检查未完成'))),
      selectedPart.canImport && h(React.Fragment, null,
        h('input', { key: fileKey, type: 'file', 'aria-label': '补交文件', style: { width: '100%', minWidth: 0 }, disabled: busy, onChange: e => { setFile(e.target.files?.[0] ?? null); setUploadProgress(null); } }),
        file && h('small', { style: { overflowWrap: 'anywhere' } }, file.name+' · '+file.size+' 字节'),
        button('确认补交', upload, !file || file.size <= 0 || file.size > data.limits.maxAssetBytes),
        file && (file.size <= 0 || file.size > data.limits.maxAssetBytes) && h('small', { role: 'alert' }, '文件为空或超出单文件上限'),
        uploadProgress && h('div', { className: 'ys-row' }, h('progress', { 'aria-label': '上传进度', value: uploadProgress.received, max: uploadProgress.total }), h('small', null, Math.floor(uploadProgress.received / uploadProgress.total * 100)+'%'))),
      !selectedPart.canImport && h('small', null, '使用补扫保存内联附件')));
  return h('section', { className: 'ys-plugin', ref: anchor, style: embedded ? { minWidth: 0 } : undefined, 'aria-label': '附件与备份' },
    !embedded && h('button', { type: 'button', disabled: !sessionId, onClick: () => setOpen(!open), 'aria-expanded': open }, '附件与备份'),
    open && h(embedded ? EmbeddedPanel : Panel, { anchor, label: '附件与备份', onClose: () => setOpen(false) },
      h('div', { className: 'ys-row' }, h('h3', null, '附件与备份'), !embedded && button('关闭', () => setOpen(false))),
      (error || loadError) && h('div', { role: 'alert', className: 'ys-error' }, error || loadError),
      message && h('div', { role: 'status' }, message),
      busy && h('div', { className: 'ys-row' }, h('span', null, '处理中…'), h('button', { type: 'button', onClick: () => operation.current?.abort() }, '取消操作')),
      !data && !error && !loadError && h('small', null, '读取附件状态…'),
      data && h(React.Fragment, null,
        h('div', { className: 'ys-card', role: 'status', 'aria-label': '附件状态' },
          h('p', null, total === 0 ? '当前项目暂无已保存附件' : '已保存 '+(counts.complete ?? 0)+' 条 · 待处理 '+pending+' 条'+(attention ? ' · 需处理 '+attention+' 条' : '')),
          h('small', null, '内容观察 '+(data.observations ?? 0)+' 条'+(total > 0 ? ' · 仅有引用 '+(counts['reference-only'] ?? 0)+' 条' : ''))),
        needsRepair && h('details', { open: true }, h('summary', null, '处理附件问题'+(attention ? ' · '+attention : '')),
          data.scan.error && h('small', { role: 'alert' }, errors[data.scan.error] ?? '检查失败，请重试'),
          h('div', { className: 'ys-row' },
            button(data.scan.paused ? '继续检查' : '补扫遗漏附件', () => run('media-scan', {}, '检查已启动'), ['queued', 'scanning'].includes(data.scan.state)),
            button('重新检查', () => { if (confirm('重新检查当前项目的全部附件？')) void run('media-recheck', { confirmed: true }, '检查已启动'); })),
          ...problemJobs.map(job => h('div', { className: 'ys-row', key: job.source_id }, h('small', null, (jobNames[job.state] ?? '待处理')+' · '+job.source_id.slice(0, 12)), button('查看', () => loadParts(job.source_id)))),
          h('details', null, h('summary', null, '按来源编号查找'), h('input', { 'aria-label': '附件来源编号', placeholder: '附件来源编号', value: attachmentSource, onChange: e => setAttachmentSource(e.target.value) }), button('查看附件', () => loadParts(), !attachmentSource.trim())),
          attachmentList),
        !needsRepair && h('details', null, h('summary', null, '检查附件'),
          h('small', null, '新附件自动保存；需要时可检查当前项目的历史消息。'),
          button('开始检查', () => run('media-scan', {}, '检查已启动'), ['queued', 'scanning'].includes(data.scan.state))),
        h('details', null, h('summary', null, '备份与恢复'),
          h('input', { 'aria-label': '新备份目录', placeholder: '新备份目录', value: backup, onChange: e => setBackup(e.target.value), maxLength: 3000 }),
          button('创建备份', () => run('media-backup', { directory: backup }, result => '备份已保存：'+result.directory), !backup.trim()),
          h('input', { 'aria-label': '备份来源目录', placeholder: '备份来源目录', value: source, onChange: e => setSource(e.target.value), maxLength: 3000 }),
          h('input', { 'aria-label': '新恢复目录', placeholder: '新恢复目录', value: destination, onChange: e => setDestination(e.target.value), maxLength: 3000 }),
          button('恢复备份', () => { if (confirm('将备份恢复到新目录？')) void run('media-restore', { directory: source, destination, confirmed: true }, result => '已恢复：'+result.directory); }, !source.trim() || !destination.trim()),
          h('small', null, '恢复到新目录，不自动切换当前存档区。')))));
}

export function PersonaMediaView(props) {
  return React.createElement(React.Fragment, null, React.createElement(PersonaView, props), React.createElement(MediaView, props));
}
