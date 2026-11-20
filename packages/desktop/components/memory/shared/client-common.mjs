export const styles = '.ys-plugin{position:relative;display:inline-flex;color:inherit;font:inherit}.ys-plugin button,.ys-plugin input,.ys-plugin textarea,.ys-plugin select{font:inherit;color:inherit}.ys-plugin button{padding:6px 10px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:9px;background:transparent;cursor:pointer}.ys-plugin button:hover{background:color-mix(in srgb,currentColor 8%,transparent)}.ys-plugin button:disabled{opacity:.45;cursor:default}.ys-panel{position:absolute;bottom:calc(100% + 10px);left:0;z-index:40;width:min(520px,80vw);max-height:65vh;overflow:auto;padding:16px;border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:14px;background:Canvas;color:CanvasText;box-shadow:0 12px 36px #0003;display:grid;gap:10px}.ys-panel h3{font-size:15px;margin:0}.ys-panel small{opacity:.72}.ys-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}.ys-panel textarea,.ys-panel input,.ys-panel select{box-sizing:border-box;border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:8px;padding:8px;background:transparent}.ys-panel textarea{width:100%;min-height:72px}.ys-card{padding:10px;border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-radius:10px;display:grid;gap:7px}.ys-card p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.ys-error{color:#b74435;white-space:pre-wrap}.ys-muted{opacity:.6}.ys-primary{font-weight:600}.ys-panel :focus-visible{outline:2px solid #687cf6;outline-offset:2px}';
export function Panel({ anchor, label, onClose, children }) {
  const ref = React.useRef(null), [position, setPosition] = React.useState(null);
  React.useLayoutEffect(() => {
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect(); if (!rect) return;
      const width = Math.min(540, window.innerWidth - 32), height = Math.min(600, Math.max(160, rect.top - 80), window.innerHeight - 96);
      setPosition({ position: 'fixed', left: Math.max(16, Math.min(rect.left, window.innerWidth - width - 16)), bottom: Math.max(16, window.innerHeight - rect.top + 10), width, maxHeight: height, boxSizing: 'border-box', zIndex: 900, fontFamily: 'inherit', fontSize: 13, background: 'var(--dsw-alias-bg-base, Canvas)', color: 'var(--dsw-alias-label-primary, CanvasText)' });
    };
    place(); window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    const key = event => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } };
    const outside = event => { if (!ref.current?.contains(event.target) && !anchor.current?.contains(event.target)) onClose(); };
    document.addEventListener('keydown', key); document.addEventListener('pointerdown', outside);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); document.removeEventListener('keydown', key); document.removeEventListener('pointerdown', outside); };
  }, []);
  return ReactDOM.createPortal(React.createElement('section', { ref, className: 'ys-plugin ys-panel', role: 'region', 'aria-label': label, style: position ?? { visibility: 'hidden' } }, children), document.body);
}
export async function mountClient(ctx, namespace, info, View, React) {
  const disposeRemote = await ctx.remote.$mount(info);
  let ui;
  try {
    ui = ctx.inject(['remote.' + namespace, 'slots'], inner => {
      const style = document.createElement('style'); style.textContent = styles; document.head.append(style);
      inner.effect(() => () => style.remove());
      const call = async (sessionId, action, payload = {}, signal) => {
        const result = await inner.remote[namespace].request(sessionId, action, payload, signal);
        if (!result.ok) throw new Error(result.error.message);
        return result.value;
      };
      inner.slots.inject('conversation.input.left', () => inner.slots.register({ name: 'conversation.input.left', id: namespace, inject: () => ({}) }, props => React.createElement(View, { ...props, call })));
    });
    await ui;
  } catch (error) { await ui?.dispose(); await disposeRemote(); throw error; }
  return async () => { await ui.dispose(); await disposeRemote(); };
}
