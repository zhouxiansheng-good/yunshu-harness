export function createUnifiedHub() {
  const providers = new Map(), listeners = new Set();
  let snapshot = { owner: null, sections: [] }, epoch = 0;
  const publish = () => {
    const rows = [...providers.values()].sort((a, b) => (a.id === 'yunshuPersona' ? -1 : b.id === 'yunshuPersona' ? 1 : a.id.localeCompare(b.id)));
    const order = ['memory', 'persona', 'media'];
    snapshot = { owner: rows[0]?.id ?? null, sections: rows.flatMap(row => row.sections.map(section => ({ ...section, provider: row.id, call: row.call, epoch: row.epoch }))).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)) };
    for (const listener of listeners) listener(snapshot);
  };
  return {
    snapshot: () => snapshot,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    register(id, sections, call) {
      const token = Symbol(id); providers.set(id, { id, sections, call, token, epoch: ++epoch }); publish();
      return () => { if (providers.get(id)?.token === token) { providers.delete(id); publish(); } };
    },
  };
}
export function getUnifiedHub() {
  const key = Symbol.for('@yunshu/unified-panel/v1');
  return globalThis[key] ??= createUnifiedHub();
}
export function EmbeddedPanel({ label, children }) {
  return React.createElement('section', { role: 'region', 'aria-label': label, style: { display: 'grid', gap: 10, minWidth: 0 } }, children);
}
export function UnifiedView({ sessionId, providerId, hub, onActiveChange }) {
  const h = React.createElement, anchor = React.useRef(null);
  const [snapshot, setSnapshot] = React.useState(hub.snapshot()), [open, setOpen] = React.useState(false), [tab, setTab] = React.useState('memory');
  React.useEffect(() => { const off = hub.subscribe(setSnapshot); setSnapshot(hub.snapshot()); return off; }, [hub]);
  const owned = snapshot.owner === providerId, tabs = snapshot.sections.filter(row => row.id !== 'media');
  const selected = tabs.find(row => row.id === tab) ?? tabs[0], media = snapshot.sections.find(row => row.id === 'media');
  React.useEffect(() => { if (!owned) setOpen(false); }, [owned]);
  React.useEffect(() => { setOpen(false); setTab('memory'); }, [sessionId]);
  React.useEffect(() => { if (!owned) return; onActiveChange?.(open); return () => onActiveChange?.(false); }, [open, owned]);
  if (!owned) return null;
  const tabId = id => 'yunshu-' + providerId + '-tab-' + id, contentId = 'yunshu-' + providerId + '-content';
  const move = (event, index) => {
    const n = tabs.length; let next;
    if (event.key === 'ArrowRight') next = (index + 1) % n;
    else if (event.key === 'ArrowLeft') next = (index + n - 1) % n;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = n - 1;
    else return;
    event.preventDefault(); const id = tabs[next].id; setTab(id); document.getElementById(tabId(id))?.focus();
  };
  return h('div', { className: 'ys-plugin', ref: anchor },
    h('button', { type: 'button', disabled: !sessionId, onClick: () => setOpen(value => !value), 'aria-expanded': open, 'data-yunshu-entry': true }, '云舒'),
    open && h(Panel, { anchor, label: '云舒', onClose: () => setOpen(false) },
      h('div', { className: 'ys-row', style: { justifyContent: 'space-between' } }, h('h3', null, '云舒'), h('button', { type: 'button', onClick: () => setOpen(false) }, '关闭')),
      h('div', { role: 'tablist', 'aria-label': '云舒功能', className: 'ys-row', style: { borderBottom: '1px solid color-mix(in srgb,currentColor 18%,transparent)', paddingBottom: 8 } },
        ...tabs.map((row, index) => h('button', { key: row.id, id: tabId(row.id), type: 'button', role: 'tab', 'aria-selected': row.id === selected?.id, 'aria-controls': contentId, tabIndex: row.id === selected?.id ? 0 : -1, onClick: () => setTab(row.id), onKeyDown: event => move(event, index), style: row.id === selected?.id ? { fontWeight: 600, background: 'color-mix(in srgb,currentColor 9%,transparent)' } : undefined }, row.label))),
      selected && h('div', { role: 'tabpanel', id: contentId, 'aria-labelledby': tabId(selected.id), style: { minWidth: 0 } },
        h(selected.View, { key: selected.id + ':' + sessionId + ':' + selected.epoch, sessionId, call: selected.call, embedded: true,
          mediaSection: selected.id === 'memory' && media ? h(media.View, { key: 'media:' + sessionId + ':' + media.epoch, sessionId, call: media.call, embedded: true }) : null }))));
}
export async function mountUnifiedClient(ctx, namespace, info, sections, React) {
  const disposeRemote = await ctx.remote.$mount(info), hub = getUnifiedHub(); let ui;
  try {
    ui = ctx.inject(['remote.' + namespace, 'slots'], inner => {
      const style = document.createElement('style'); style.textContent = styles; document.head.append(style);
      inner.effect(() => () => style.remove());
      const call = async (sessionId, action, payload = {}, signal) => {
        const result = await inner.remote[namespace].request(sessionId, action, payload, signal);
        if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code, details: result.error.details });
        return result.value;
      };
      const unregister = hub.register(namespace, sections, call); inner.effect(() => unregister);
      inner.slots.inject('conversation.input.left', () => inner.slots.register({ name: 'conversation.input.left', id: namespace, inject: () => ({}) }, props => React.createElement(UnifiedView, { ...props, providerId: namespace, hub })));
    });
    await ui;
  } catch (error) { await ui?.dispose(); await disposeRemote(); throw error; }
  return async () => { await ui.dispose(); await disposeRemote(); };
}
