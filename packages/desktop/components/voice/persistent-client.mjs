export async function mountVoiceClient(ctx, info) {
  const disposeRemote = await ctx.remote.$mount(info);
  let ui;
  try {
    ui = ctx.inject(['remote.yunshuVoice', 'slots'], inner => {
      const container = document.createElement('div'), fallback = document.createElement('div');
      fallback.style.cssText = 'position:fixed;right:24px;bottom:24px;z-index:850;background:var(--dsw-alias-bg-base,Canvas);color:var(--dsw-alias-label-primary,CanvasText);border-radius:12px';
      document.body.append(container, fallback);
      const style = document.createElement('style'); style.textContent = styles; document.head.append(style);
      const root = ReactDOMClient.createRoot(container);
      let selected = {}, active = false, pinned = null, target = fallback, closed = false;
      const call = async (sessionId, action, payload = {}, signal) => {
        const result = await inner.remote.yunshuVoice.request(sessionId, action, payload, signal);
        if (!result.ok) { const error = new Error(result.error.message); error.code = result.error.code; throw error; }
        return result.value;
      };
      const render = () => {
        if (closed) return;
        fallback.hidden = target !== fallback || !selected.sessionId;
        root.render(React.createElement(VoiceView, { sessionId: active ? pinned : selected.sessionId, locked: selected.locked, call, target,
          onActiveChange: value => { if (active === value) return; if (value) pinned = selected.sessionId; active = value; render(); } }));
      };
      function Entry(props) {
        const element = React.useRef(null);
        React.useLayoutEffect(() => {
          const node = element.current; selected = { sessionId: props.sessionId, locked: props.locked }; target = node; render();
          return () => { if (target === node) { target = fallback; render(); } };
        }, [props.sessionId, props.locked]);
        return React.createElement('span', { ref: element });
      }
      inner.slots.inject('conversation.input.left', () => inner.slots.register({ name: 'conversation.input.left', id: 'yunshuVoice', inject: () => ({}) }, Entry));
      render();
      inner.effect(() => () => { closed = true; root.unmount(); container.remove(); fallback.remove(); style.remove(); });
    });
    await ui;
  } catch (error) { await ui?.dispose(); await disposeRemote(); throw error; }
  return async () => { await ui.dispose(); await disposeRemote(); };
}
