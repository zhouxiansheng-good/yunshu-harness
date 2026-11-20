window.__ModuleLoader__.load({id:"@yunshu/dsh-persona",factory:require=>{
const React=require("react");const ReactDOM=require("react-dom");const {z}=require("zod");
/** Lazy assembly of generated Remote definitions using caller-supplied Zod; no runtime imports. */
/**
 * Retain one generated definition per endpoint without constructing parsers or projections.
 * The class instance builds its shared descriptor/method index on first access;
 * input schemas and JSON Schema projections are cached only when requested.
 * @param spec - compiler-produced method facts and Zod factories.
 * @param zod - the generated artifact's Zod runtime for named-input parsers.
 * @returns a lazy, mountable info instance with no registration or transport effects.
 */
function createTypertRemoteInfo(spec, zod) {
    return new RemoteInfo(spec, zod);
}
class RemoteInfo {
    spec;
    zod;
    index;
    constructor(spec, zod) {
        this.spec = spec;
        this.zod = zod;
    }
    get package() { return this.spec.package; }
    get descriptors() { return this.resolve().descriptors; }
    get methods() { return this.resolve().methods; }
    resolve() {
        if (this.index !== undefined)
            return this.index;
        const zod = this.zod;
        const descriptors = [];
        const methods = Object.create(null);
        for (const [endpoint, definition] of Object.entries(this.spec.methods)) {
            const separator = endpoint.indexOf('/');
            const namespace = endpoint.slice(0, separator);
            const method = endpoint.slice(separator + 1);
            const parameters = definition.parameters.map(parameter => ({ ...parameter, wire: parameter.wire ?? parameter.name }));
            const descriptor = {
                ...definition,
                id: `${this.spec.package}#${endpoint}`,
                namespace,
                method,
                parameters,
                result: definition.result.description === undefined ? definition.result : new ResultValue(definition.result),
            };
            if (definition.invocation.kind === 'direct') {
                const inputs = [];
                const direct = Object.assign(descriptor, {
                    input(options) {
                        const strict = options?.strict === true;
                        return inputs[strict ? 1 : 0] ??= new NamedInput(parameters, strict, zod);
                    },
                    invoke(remote, input, signal) {
                        const named = input;
                        const values = parameters.map(parameter => named[parameter.wire]);
                        if (definition.cancellation !== undefined)
                            values.push(signal);
                        // Namespace access retains the Gateway's mount checks and scoped receiver policy.
                        const receiver = Reflect.get(remote, namespace);
                        const call = Reflect.get(receiver, method);
                        return call.apply(receiver, values);
                    },
                });
                // The generated namespace return type is selected by this same descriptor's mode.
                methods[endpoint] = direct;
            }
            descriptors.push(descriptor);
        }
        return this.index = { descriptors, methods };
    }
}
/**
 * Narrow a Registry descriptor to its generated direct-method capabilities.
 * @param descriptor - a live descriptor, including possible source fallback or Context-only receivers.
 * @returns whether generated named input and direct invocation are available.
 */
function isTypertRemoteMethod(descriptor) {
    return descriptor.invocation.kind === 'direct' && descriptor.result.mode === 'strict'
        && 'input' in descriptor && typeof descriptor.input === 'function'
        && 'invoke' in descriptor && typeof descriptor.invoke === 'function';
}
function optional(parameter) {
    return parameter.source === 'json' && parameter.acceptsUndefined === true;
}
class NamedInput {
    parameters;
    strict;
    zod;
    schema;
    projection;
    constructor(parameters, strict, zod) {
        this.parameters = parameters;
        this.strict = strict;
        this.zod = zod;
    }
    codec(parameter) {
        return this.strict ? parameter.strictCodec : parameter.codec;
    }
    create = () => this.schema ??= this.zod.strictObject(Object.fromEntries(this.parameters.map((parameter) => {
        const value = this.codec(parameter).create();
        return [parameter.wire, optional(parameter) ? value.optional() : value.nonoptional()];
    })));
    get jsonSchema() { return this.project().jsonSchema; }
    get jsonSchemaError() { return this.project().jsonSchemaError; }
    project() {
        if (this.projection !== undefined)
            return this.projection;
        const unavailable = this.parameters.find(parameter => this.codec(parameter).jsonSchema === undefined);
        if (unavailable !== undefined) {
            return this.projection = { jsonSchemaError: this.codec(unavailable).jsonSchemaError ?? `No JSON Schema for parameter ${unavailable.wire}` };
        }
        return this.projection = {
            jsonSchema: {
                type: 'object',
                properties: Object.fromEntries(this.parameters.map(parameter => [parameter.wire, {
                        ...this.codec(parameter).jsonSchema,
                        ...(parameter.description === undefined ? {} : { description: parameter.description }),
                    }])),
                required: this.parameters.filter(parameter => !optional(parameter)).map(parameter => parameter.wire),
                additionalProperties: false,
            },
        };
    }
}
class ResultValue {
    spec;
    projection;
    constructor(spec) {
        this.spec = spec;
    }
    get mode() { return this.spec.mode; }
    get typeSymbol() { return this.spec.typeSymbol; }
    get create() { return this.spec.create; }
    get decode() { return this.spec.decode; }
    get encode() { return this.spec.encode; }
    get description() { return this.spec.description; }
    get jsonSchemaError() { return this.spec.jsonSchemaError; }
    get jsonSchema() {
        if (this.projection === undefined) {
            const schema = this.spec.jsonSchema;
            this.projection = { value: schema === undefined ? undefined : { ...schema, description: this.spec.description } };
        }
        return this.projection.value;
    }
}
//# sourceMappingURL=remote-info.js.map
// One source of truth for both Host and browser Remote descriptions.
function remoteSpec(namespace, z, createTypertRemoteInfo) {
  // z.json() validates correctly but its parsed record strips __proto__ keys.
  // Preserve arbitrary user JSON as data after validation, including backups.
  const json = z.custom(value => z.json().safeParse(value).success, { message: 'Invalid JSON' });
  const codec = (type, schema, jsonSchema) => ({ mode: 'strict', typeSymbol: '@yunshu/' + namespace + '#' + type, create: () => schema, jsonSchema });
  const parameter = (name, schema, jsonSchema, extras = {}) => {
    const c = codec(name, schema, jsonSchema);
    if (extras.source === 'lookup') c.typeSymbol = '@deepseek-ai/dsh-session/types#SessionId';
    return { name, source: 'json', codec: c, strictCodec: c, ...extras };
  };
  return createTypertRemoteInfo({
    package: ({ yunshuMemory: '@yunshu/dsh-memory', yunshuVoice: '@yunshu/dsh-voice', yunshuPersona: '@yunshu/dsh-persona' })[namespace],
    methods: { [namespace + '/request']: {
      service: namespace, description: 'User-owned Yunshu plugin operation', invocation: { kind: 'direct' },
      parameters: [
        parameter('agent', z.string(), { type: 'string' }, { wire: 'agentId', source: 'lookup', lookup: 'agent' }),
        parameter('action', z.string(), { type: 'string' }),
        parameter('payload', json, {}),
      ],
      cancellation: { parameter: 'signal' },
      result: codec('result', json, {}),
      sourceLocation: { file: 'packages/shared/remote-spec.mjs', line: 1, column: 1 },
    } },
  }, z);
}

const styles = '.ys-plugin{position:relative;display:inline-flex;color:inherit;font:inherit}.ys-plugin button,.ys-plugin input,.ys-plugin textarea,.ys-plugin select{font:inherit;color:inherit}.ys-plugin button{padding:6px 10px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:9px;background:transparent;cursor:pointer}.ys-plugin button:hover{background:color-mix(in srgb,currentColor 8%,transparent)}.ys-plugin button:disabled{opacity:.45;cursor:default}.ys-panel{position:absolute;bottom:calc(100% + 10px);left:0;z-index:40;width:min(520px,80vw);max-height:65vh;overflow:auto;padding:16px;border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:14px;background:Canvas;color:CanvasText;box-shadow:0 12px 36px #0003;display:grid;gap:10px}.ys-panel h3{font-size:15px;margin:0}.ys-panel small{opacity:.72}.ys-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}.ys-panel textarea,.ys-panel input,.ys-panel select{box-sizing:border-box;border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:8px;padding:8px;background:transparent}.ys-panel textarea{width:100%;min-height:72px}.ys-card{padding:10px;border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-radius:10px;display:grid;gap:7px}.ys-card p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.ys-error{color:#b74435;white-space:pre-wrap}.ys-muted{opacity:.6}.ys-primary{font-weight:600}.ys-panel :focus-visible{outline:2px solid #687cf6;outline-offset:2px}' + ".ys-plugin select,\n.ys-panel select,\n.ys-plugin select option,\n.ys-panel select option,\n.ys-plugin select optgroup,\n.ys-panel select optgroup {\n  background-color: Canvas;\n  color: CanvasText;\n}\n\n.ys-plugin select:disabled,\n.ys-panel select:disabled,\n.ys-plugin select option:disabled,\n.ys-panel select option:disabled,\n.ys-plugin select optgroup:disabled,\n.ys-panel select optgroup:disabled {\n  color: GrayText;\n}\n";
function Panel({ anchor, label, onClose, children }) {
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
async function mountClient(ctx, namespace, info, View, React) {
  const disposeRemote = await ctx.remote.$mount(info);
  let ui;
  try {
    ui = ctx.inject(['remote.' + namespace, 'slots'], inner => {
      const style = document.createElement('style'); style.textContent = styles; document.head.append(style);
      inner.effect(() => () => style.remove());
      const call = async (sessionId, action, payload = {}, signal) => {
        const result = await inner.remote[namespace].request(sessionId, action, payload, signal);
        if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code, details: result.error.details });
        return result.value;
      };
      inner.slots.inject('conversation.input.left', () => inner.slots.register({ name: 'conversation.input.left', id: namespace, inject: () => ({}) }, props => React.createElement(View, { ...props, call })));
    });
    await ui;
  } catch (error) { await ui?.dispose(); await disposeRemote(); throw error; }
  return async () => { await ui.dispose(); await disposeRemote(); };
}


function createUnifiedHub() {
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
function getUnifiedHub() {
  const key = Symbol.for('@yunshu/unified-panel/v1');
  return globalThis[key] ??= createUnifiedHub();
}
function EmbeddedPanel({ label, children }) {
  return React.createElement('section', { role: 'region', 'aria-label': label, style: { display: 'grid', gap: 10, minWidth: 0 } }, children);
}
function UnifiedView({ sessionId, providerId, hub, onActiveChange }) {
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
async function mountUnifiedClient(ctx, namespace, info, sections, React) {
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

function PersonaView({ sessionId, call, onActiveChange, embedded = false }) {
  const h = React.createElement, anchor = React.useRef(null), life = React.useRef(null);
  const [open,setOpen] = React.useState(embedded), [data,setData] = React.useState(null), [error,setError] = React.useState(''), [busy,setBusy] = React.useState(false);
  const [draft,setDraft] = React.useState(null), [history,setHistory] = React.useState([]), [query,setQuery] = React.useState(''), [capabilities,setCapabilities] = React.useState(null);
  const [standardDraft,setStandardDraft] = React.useState(null), [standardHistory,setStandardHistory] = React.useState([]);
  React.useEffect(() => {
    const abort = new AbortController(); life.current = abort; setData(null); setDraft(null); setHistory([]); setStandardDraft(null); setStandardHistory([]); setError(''); setBusy(false); setCapabilities(null);
    if (open && sessionId) call(sessionId,'status',{},abort.signal).then(v=>{if(!abort.signal.aborted)setData(v);}).catch(e=>{if(!abort.signal.aborted)setError(e.message);});
    return () => abort.abort();
  },[sessionId,open]);
  React.useEffect(()=>{onActiveChange?.(open);return()=>onActiveChange?.(false);},[open]);
  const run=async task=>{const signal=life.current.signal;setBusy(true);setError('');try{await task(signal);if(!signal.aborted){const next=await call(sessionId,'status',{},signal);if(!signal.aborted)setData(next);}}catch(e){if(!signal.aborted)setError(e.message);}finally{if(!signal.aborted)setBusy(false);}};
  const button=(label,action,disabled=false)=>h('button',{type:'button',onClick:action,disabled:busy||disabled},label);
  const names={memory:'记忆',voice:'语音',media:'媒体'}, states={starting:'启动中',closed:'已关闭',ready:'可读取',degraded:'部分异常',failed:'异常',not_installed:'未启用',unconfigured:'未配置',unverified:'已配置，未实测',unknown:'状态未知'};
  const standardStates={current:'当前',superseded:'已修订',withdrawn:'已撤回'};
  const limits=data?.rules?.limits??{nameChars:60,conventions:200,conventionChars:3000,contentChars:12000};
  const draftRules=draft?.conventions.split('\n').map(s=>s.trim()).filter(Boolean)??[];
  const draftPayload=draft?{name:draft.name.trim(),conventions:draftRules}:null;
  const draftChars=draftPayload?JSON.stringify(draftPayload).length:0;
  const draftError=!draft?'':draftRules.length>limits.conventions?'协作约定最多'+limits.conventions+'条':draftRules.some(s=>s.length>limits.conventionChars)?'每条协作约定最多'+limits.conventionChars+'字':draftChars>limits.contentChars?'个人规则内容最多'+limits.contentChars+'字（含名称与格式）':'';
  const editorStyle={position:'fixed',inset:0,width:'100vw',height:'100vh',maxHeight:'none',boxSizing:'border-box',zIndex:1000,display:'grid',gridTemplateRows:'auto auto minmax(0,1fr) auto auto',overflow:'hidden',padding:'min(4vh,24px) min(4vw,40px)',border:0,borderRadius:0,background:'var(--dsw-alias-bg-base, Canvas)',color:'var(--dsw-alias-label-primary, CanvasText)'};
  return h('div',{ className: 'ys-plugin', ref: anchor, style: embedded ? { display: 'contents' } : undefined }, !embedded && h('button',{type:'button',disabled:!sessionId,onClick:()=>setOpen(!open),'aria-expanded':open},'人格'),open&&h(embedded ? EmbeddedPanel : Panel,{anchor,label:'云舒人格',onClose:()=>setOpen(false)},
    h('div',{className:'ys-row'},!embedded && h('h3',null,'云舒人格'),button('刷新',()=>run(async()=>{})),!embedded && button('关闭',()=>setOpen(false))),
    error&&h('div',{role:'alert',className:'ys-error'},error),!data&&!error&&h('small',null,'加载中…'),
    data&&h(React.Fragment,null,h('h3',null,'个人规则'),h('small',{'aria-label':'规则生效方式'},data.rules?.registered?'固定规则已注册':'规则未就绪'),
      draft?h('section',{className:'ys-plugin ys-panel',role:'dialog','aria-label':'编辑个人规则',style:editorStyle,onKeyDown:e=>{if(e.key==='Escape')e.stopPropagation();}},
        h('h3',null,'编辑个人规则'),
        h('input',{'aria-label':'助手名称',maxLength:limits.nameChars,value:draft.name,onChange:e=>setDraft({...draft,name:e.target.value})}),
        h('textarea',{'aria-label':'协作约定',maxLength:limits.contentChars,value:draft.conventions,onChange:e=>setDraft({...draft,conventions:e.target.value}),placeholder:'每行一条个人规则',style:{width:'100%',height:'100%',minHeight:0,resize:'none',lineHeight:1.5}}),
        h('div',null,h('small',null,'协作约定 '+draftRules.length+'/'+limits.conventions+' 条 · 内容 '+draftChars+'/'+limits.contentChars+' 字 · 单条最多'+limits.conventionChars+'字'),draftError&&h('div',{role:'alert',className:'ys-error'},draftError),error&&h('div',{role:'alert',className:'ys-error'},error)),
        h('div',{className:'ys-row'},button('保存个人规则',()=>{if(confirm('保存个人规则？'))void run(async signal=>{await call(sessionId,'identity-save',{content:draftPayload,version:draft.version,confirmed:true},signal);if(!signal.aborted)setDraft(null);});},!draft.name.trim()||Boolean(draftError)),button('取消编辑',()=>setDraft(null)))
      ):
        h('article',{className:'ys-card'},h('strong',null,data.identity.content.name),...data.identity.content.conventions.map((s,i)=>h('p',{key:i},s)),button('编辑个人规则',()=>setDraft({...data.identity.content,conventions:data.identity.content.conventions.join('\n'),version:data.identity.version}))),
      button('查看规则历史',()=>run(async signal=>{const rows=await call(sessionId,'identity-history',{},signal);if(!signal.aborted)setHistory(rows);})),
      ...history.map(row=>h('article',{className:'ys-card',key:row.version},h('p',null,row.content.name+' · '+row.created_at),button('恢复此版本',()=>{if(confirm('恢复这个规则版本？'))void run(async signal=>{await call(sessionId,'identity-restore',{targetVersion:row.version,version:data.identity.version,confirmed:true},signal);if(!signal.aborted){setDraft(null);setHistory([]);}});}))),
      h('h3',null,'个人标准'),
      ...(data.standards??[]).map(row=>h('article',{className:'ys-card',key:row.id},
        h('strong',null,(row.kind==='standard'?'标准':'倾向')+' · '+row.text),
        h('div',{className:'ys-row'},
          button('修订',()=>setStandardDraft({...row,mode:'revise'})),
          button('撤回',()=>setStandardDraft({...row,mode:'withdraw'})),
          button('历史',()=>run(async signal=>{const rows=await call(sessionId,'standards-history',{familyId:row.family_id},signal);if(!signal.aborted)setStandardHistory(rows);}))))),
      standardDraft?h('article',{className:'ys-card'},
        standardDraft.mode==='withdraw'?h('strong',null,standardDraft.text):h(React.Fragment,null,
          h('textarea',{'aria-label':'标准内容',maxLength:120,value:standardDraft.text,onChange:e=>setStandardDraft({...standardDraft,text:e.target.value})}),
          h('div',{className:'ys-row'},button('标准',()=>setStandardDraft({...standardDraft,kind:'standard'}),standardDraft.kind==='standard'),button('倾向',()=>setStandardDraft({...standardDraft,kind:'tendency'}),standardDraft.kind==='tendency'))),
        h('input',{'aria-label':standardDraft.mode==='withdraw'?'撤回原因':'修订原因',maxLength:400,value:standardDraft.reason,onChange:e=>setStandardDraft({...standardDraft,reason:e.target.value}),placeholder:standardDraft.id?standardDraft.mode==='withdraw'?'撤回原因':'修订原因':'原因（可选）'}),
        standardDraft.mode!=='withdraw'&&h('input',{'aria-label':'依据',maxLength:600,value:standardDraft.evidence,onChange:e=>setStandardDraft({...standardDraft,evidence:e.target.value}),placeholder:'依据（可选）'}),
        h('div',{className:'ys-row'},button(standardDraft.mode==='withdraw'?'确认撤回':standardDraft.id?'保存修订':'添加标准',()=>{if(confirm(standardDraft.mode==='withdraw'?'撤回这条个人标准？':standardDraft.id?'保存标准修订？':'添加个人标准？'))void run(async signal=>{
          if(standardDraft.mode==='withdraw')await call(sessionId,'standards-withdraw',{id:standardDraft.id,version:standardDraft.version,reason:standardDraft.reason,confirmed:true},signal);
          else await call(sessionId,standardDraft.id?'standards-revise':'standards-create',{...(standardDraft.id?{id:standardDraft.id,version:standardDraft.version}:{}),standard:{text:standardDraft.text,kind:standardDraft.kind,reason:standardDraft.reason,evidence:standardDraft.evidence},confirmed:true},signal);
          if(!signal.aborted){setStandardDraft(null);setStandardHistory([]);}});},!standardDraft.text.trim()||Boolean(standardDraft.id&&!standardDraft.reason.trim())),button('取消',()=>setStandardDraft(null)))):
        button('添加个人标准',()=>setStandardDraft({text:'',kind:'standard',reason:'',evidence:''}),(data.standards??[]).length>=4),
      standardHistory.length>0&&h('details',{open:true},h('summary',null,'标准历史'),...standardHistory.map(row=>h('article',{className:'ys-card',key:row.id},h('strong',null,'v'+row.version+' · '+(standardStates[row.state]??row.state)),h('p',null,row.text),row.reason&&h('small',null,'原因：'+row.reason),row.evidence&&h('small',null,'依据：'+row.evidence),h('small',null,row.created_at)))),
      button('查看全部标准历史',()=>run(async signal=>{const rows=await call(sessionId,'standards-history',{},signal);if(!signal.aborted)setStandardHistory(rows);})),
      h('h3',null,'情感回应'),
      data.affect?.available ? h('article',{className:'ys-card','aria-label':'情感状态'},
        h('div',{className:'ys-row'},h('strong',null,data.affect.enabled?'已开启':'已关闭'),button(data.affect.enabled?'关闭情感回应':'开启情感回应',()=>run(signal=>call(sessionId,'affect-enable',{enabled:!data.affect.enabled},signal)))),
        data.affect.enabled && h(React.Fragment,null,
          h('p',null,'当前感受：'+(data.affect.label??'未判断')),
          h('p',null,'回应方式：'+(data.affect.toneLabel??'自然')),
          data.affect.quote && h('p',null,'依据：'+data.affect.quote),
          data.affect.memoryMatches>0 && h('small',null,'本轮关联记忆：'+data.affect.memoryMatches+' 条'),
          button('清除当前状态',()=>run(signal=>call(sessionId,'affect-reset',{},signal)),!data.affect.strength))):
        h('small',null,data.affect?.error??'情感状态未就绪'),
      h('h3',null,'组件状态'),
      ...data.components.map(row=>h('article',{className:'ys-card',key:row.id,'data-component':row.id},h('strong',null,(names[row.id]??row.id)+' · '+(row.id==='media'&&row.state==='ready'?'已启用':states[row.state]??row.state)),row.error&&h('p',null,row.error),row.id==='voice'&&h('small',null,'麦克风：未知 · 扬声器：未知'),h('small',null,'检查时间：'+row.checkedAt))),
      h('h3',null,'本轮上下文'),
      data.context.status==='composed'?h('article',{className:'ys-card'},h('p',null,'上下文估算：'+data.context.estimatedTokens+' / '+data.context.budget.maxTokens+' token'),h('p',null,'选取 '+data.context.selected.length+' 条 · 省略 '+data.context.omitted.length+' 条'),h('small',null,'缓存用量：未获取')):h('small',null,data.context.status==='degraded'?'上下文暂不可用':'暂无上下文'),
      h('details',null,h('summary',null,'可用能力'),h('div',{className:'ys-row'},h('input',{'aria-label':'查找能力',maxLength:300,value:query,onChange:e=>setQuery(e.target.value),placeholder:'输入能力名称'}),button('查询能力',()=>run(async signal=>{const result=await call(sessionId,'capabilities',{query},signal);if(!signal.aborted)setCapabilities(result);}))),
        ...(capabilities?.tools??[]).map(tool=>h('article',{className:'ys-card',key:tool.name},h('strong',null,tool.name),h('p',null,tool.description),h('small',null,'已注册 · 未探测'))),capabilities?.truncated&&h('small',null,'显示前50项，请缩小查询范围'))
    )));
}


function MediaView({ sessionId, call, onActiveChange, embedded = false }) {
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

function PersonaMediaView(props) {
  return React.createElement(React.Fragment, null, React.createElement(PersonaView, props), React.createElement(MediaView, props));
}

return {inject:["remote","slots"],apply:ctx=>mountUnifiedClient(ctx,"yunshuPersona",remoteSpec("yunshuPersona",z,createTypertRemoteInfo),[{id:"persona",label:"人格",View:PersonaView},{id:"media",label:"媒体",View:MediaView}],React)};
}});