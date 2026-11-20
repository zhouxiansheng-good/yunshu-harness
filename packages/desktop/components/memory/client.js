window.__ModuleLoader__.load({id:"@yunshu/dsh-memory",factory:require=>{
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

// Lossless JSON drafts: numeric input stays text until validation at Save.
// Objects/arrays retain their shape, unknown fields and explicit nulls.
function profileDraft(value) {
  if (value === null) return { type: 'null', text: '' };
  if (Array.isArray(value)) return { type: 'array', children: value.map(v => ({ key: '', value: profileDraft(v) })) };
  if (typeof value === 'object') return { type: 'object', children: Object.entries(value).map(([key, v]) => ({ key, value: profileDraft(v) })) };
  return { type: typeof value, text: String(value) };
}
function profileValue(draft) {
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
function emptyProfileField(type) {
  return ['object','array'].includes(type) ? { type, children: [] } : { type, text: type === 'number' ? '0' : type === 'boolean' ? 'false' : '' };
}

function EvidenceView({ sessionId, call }) {
  const h=React.createElement,life=React.useRef(null);
  const [open,setOpen]=React.useState(false),[sources,setSources]=React.useState([]),[rows,setRows]=React.useState([]),[error,setError]=React.useState(''),[busy,setBusy]=React.useState(false),[raw,setRaw]=React.useState('');
  const blank=()=>({subject:'',predicate:'',value:'',modality:'text',source_mode:'user_report',source_id:'',quote:''});
  const [draft,setDraft]=React.useState(blank),[editing,setEditing]=React.useState(null);
  const refresh=async signal=>{const [s,r]=await Promise.all([call(sessionId,'sources',{},signal),call(sessionId,'observations',{},signal)]);if(!signal.aborted){setSources(s);setRows(r);}};
  React.useEffect(()=>{const abort=new AbortController();life.current=abort;setSources([]);setRows([]);setError('');setBusy(false);setRaw('');setDraft(blank());setEditing(null);if(open&&sessionId)refresh(abort.signal).catch(e=>{if(!abort.signal.aborted)setError(e.message);});return()=>abort.abort();},[open,sessionId]);
  const run=async action=>{const signal=life.current.signal;setBusy(true);setError('');try{await action(signal);if(!signal.aborted)await refresh(signal);}catch(e){if(!signal.aborted)setError(e.message);}finally{if(!signal.aborted)setBusy(false);}};
  const button=(name,action,disabled=false)=>h('button',{type:'button',onClick:action,disabled:busy||disabled},name);
  const input=(label,key,max=300)=>h('input',{'aria-label':label,placeholder:label,maxLength:max,value:draft[key],onChange:e=>setDraft({...draft,[key]:e.target.value}),disabled:!!editing&&['subject','predicate'].includes(key)});
  const viewSource=id=>run(async signal=>{const source=await call(sessionId,'source-read',{id},signal);if(signal.aborted)return;if(!source)throw new Error('原始记录已撤回或不存在');const texts=source.payload.parts.filter(p=>p.type==='text').map(p=>p.text).join('\n');setRaw(JSON.stringify(source.payload,null,2));setDraft(d=>({...d,source_id:id,quote:texts.slice(0,4000),source_mode:source.role==='user'?'user_report':'model_inference'}));});
  const stateLabel={proposed:'待确认',confirmed:'已确认',superseded:'已更正',withdrawn:'已撤回'};
  return h('details',{open,onToggle:e=>setOpen(e.currentTarget.open)},h('summary',null,'原始记录与观察'),open&&h(React.Fragment,null,
    error&&h('div',{role:'alert',className:'ys-error'},error),button('刷新记录',()=>run(async()=>{})),
    h('h3',null,'原始记录'),sources.length===0&&h('small',null,'暂无原始记录'),
    ...sources.slice(0,20).map(s=>h('article',{className:'ys-card',key:s.id},h('small',null,(s.role==='user'?'我':'回复')+' · '+s.captured_at),h('div',{className:'ys-row'},button('查看原话',()=>viewSource(s.id)),button('撤回来源',()=>{if(confirm('撤回此来源及关联记忆？保留历史和对话。'))void run(async signal=>{await call(sessionId,'source-withdraw',{id:s.id},signal);if(!signal.aborted){setRaw('');setDraft(blank());setEditing(null);}});})) )),
    sources.length>20&&h('small',null,'显示最近20条'),raw&&h('textarea',{'aria-label':'原始记录详情',value:raw,readOnly:true}),raw&&h('small',null,'附件：已接收内容与引用；外部文件未保存'),
    h('h3',null,'观察'),rows.length===0&&h('small',null,'暂无观察'),
    ...rows.map(row=>h('article',{className:'ys-card',key:row.id,'data-observation':row.id},h('small',null,stateLabel[row.state]+' · '+(row.source_mode==='user_report'?'用户口述':'推断')),h('p',null,row.subject+' · '+row.predicate+'：'+row.value),h('small',null,'依据：'+row.quote),
      h('div',{className:'ys-row'},button('查看依据',()=>viewSource(row.source_id)),row.state==='proposed'&&button('确认观察',()=>run(signal=>call(sessionId,'observation-accept',{id:row.id,version:row.version},signal))),row.state==='proposed'&&button('拒绝观察',()=>run(signal=>call(sessionId,'observation-reject',{id:row.id,version:row.version},signal))),row.state==='confirmed'&&button('更正观察',()=>{setEditing({id:row.id,version:row.version});setDraft({subject:row.subject,predicate:row.predicate,value:row.value,modality:row.modality,source_mode:row.source_mode,source_id:row.source_id,quote:row.quote});}),['confirmed','proposed'].includes(row.state)&&button('撤回观察',()=>{if(confirm('撤回这条观察？'))void run(signal=>call(sessionId,'observation-withdraw',{id:row.id,version:row.version},signal));})))),
    h('h3',null,editing?'更正记录':'记录观察'),h('small',null,'选择原话，填写观察'),
    input('观察对象','subject'),input('观察属性','predicate',200),input('观察内容','value',4000),
    h('select',{'aria-label':'观察模态',value:draft.modality,onChange:e=>setDraft({...draft,modality:e.target.value})},...Object.entries({text:'文字',image:'图像',audio:'声音',taste:'味道',smell:'气味',touch:'触感',tool:'工具'}).map(([v,label])=>h('option',{key:v,value:v},label))),
    h('select',{'aria-label':'依据类型',value:draft.source_mode,onChange:e=>setDraft({...draft,source_mode:e.target.value})},h('option',{value:'user_report'},'用户口述'),h('option',{value:'model_inference'},'推断')),
    h('textarea',{'aria-label':'观察依据',value:draft.quote,maxLength:4000,onChange:e=>setDraft({...draft,quote:e.target.value})}),
    h('div',{className:'ys-row'},button(editing?'确认更正':'确认记录',()=>run(async signal=>{await call(sessionId,editing?'observation-correct':'observation-add',{...(editing??{}),observation:draft,confirmed:true},signal);if(!signal.aborted){setEditing(null);setDraft(blank());}}),!draft.source_id||!draft.subject.trim()||!draft.predicate.trim()||!draft.value.trim()||!draft.quote.trim()),button('清空观察',()=>{setEditing(null);setDraft(blank());}))
  ));
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

// Templates stay in the editor until the user saves them.
const CORE_TEMPLATES = Object.freeze([
  Object.freeze({ id: 'language', label: '交流语言', content: '默认用中文交流，专业术语附简短说明。' }),
  Object.freeze({ id: 'reply', label: '回复方式', content: '先给结论，再列操作步骤；回答简洁直接。' }),
  Object.freeze({ id: 'collaboration', label: '协作偏好', content: '修改前保留已有内容，完成后说明结果和未完成项。' }),
]);
function profileTemplate() {
  return { identity: { 称呼: '', 职业: '', 所在地: '' }, preferences: { 交流语言: '中文', 回复方式: '先给结论，再给步骤', 篇幅: '简洁' }, personality: { 协作方式: '', 需要避免: '' }, current_state: { 当前项目: '', 近期目标: '' }, notes: [] };
}
function hasProfileContent(value) {
  if (value === null || value === undefined || value === '') return false;
  return typeof value === 'object' ? Object.values(value).some(hasProfileContent) : true;
}
function supplementProfile(value, template = profileTemplate()) {
  const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!object(value) || !object(template)) return structuredClone(value);
  const result = structuredClone(value);
  for (const [key, item] of Object.entries(template)) {
    const next = Object.hasOwn(value, key) ? supplementProfile(value[key], item) : structuredClone(item);
    Object.defineProperty(result, key, { value: next, enumerable: true, writable: true, configurable: true });
  }
  return result;
}

/**
 * TaskBoardView —— 任务掌控台（不是成果展示）
 *
 * 关键修复：它是 UnifiedView 的一个 tab 内容，外层已有 Panel 浮层，
 * 所以这里**绝不能再套 Panel**（两个 portal 互为"外部"，任何点击都会触发关闭）。
 *
 * 显示什么（按 YG 的原话）：
 *   谁接了活、要求是什么、干到哪、等多久、交回了什么内容、其他手脚忙不忙
 */
/** 任务台内容组件；外层由宿主的 520px Panel 管理，这里不创建浮层。 */
const ROLES = [
  { role: 'self', who: '拍板', glyph: '主' },
  { role: 'explorer', who: '探路', glyph: '探' },
  { role: 'builder', who: '动手', glyph: '做' },
  { role: 'guardian', who: '把关', glyph: '验' },
]
const ATTENTION = new Set(['decision', 'blocked', 'overdue', 'handoff', 'unknown'])
const STATUS = {
  open: { text: '在做', tone: 'active' },
  done: { text: '已交回', tone: 'done' },
  late: { text: '超时没交', tone: 'late' },
  blocked: { text: '卡住', tone: 'blocked' },
}

const TASKBOARD_CSS = [
  '.ys-panel:has(.ys-b){width:min(520px,calc(100vw - 32px))!important;box-sizing:border-box}',
  '.ys-b{--ys-b-accent:#356e75;--ys-b-ok:#2e6b53;--ys-b-warn:#805e29;--ys-b-danger:#9a4a4e;box-sizing:border-box;container-type:inline-size;display:grid;gap:12px;width:100%;max-width:100%;min-width:0}',
  '.ys-b *{box-sizing:border-box;min-width:0}',
  '.ys-bhead{display:flex;align-items:center;justify-content:space-between;gap:8px}',
  '.ys-btitle{font-size:14px;font-weight:650;line-height:20px;margin:0}',
  '.ys-bfilter{font-size:11px!important;line-height:16px!important;padding:4px 8px!important;border-radius:7px!important;white-space:nowrap}',
  '.ys-bfilter[aria-pressed=true]{color:var(--ys-b-warn);border-color:var(--ys-b-warn)}',
  '.ys-bsummary,.ys-bempty,.ys-bfoot{margin:0;font-size:11.5px;line-height:17px;opacity:.72}',
  '.ys-broster{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px}',
  '.ys-bmember{display:grid;grid-template-columns:20px minmax(0,1fr);column-gap:6px;row-gap:3px;align-items:center;padding:8px 7px;border:1px solid color-mix(in srgb,currentColor 12%,transparent);border-radius:8px}',
  '.ys-bavatar{grid-row:span 2;display:grid;place-items:center;width:20px;height:20px;border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:50%;font-size:10px;font-weight:600}',
  '.ys-bmember-name{font-size:11.5px;font-weight:600;line-height:15px;white-space:nowrap}',
  '.ys-bmember-state{display:flex;align-items:center;gap:4px;font-size:10.5px;line-height:14px;white-space:nowrap}',
  '.ys-bdot{display:inline-block;flex:none;width:6px;height:6px;border-radius:50%;background:color-mix(in srgb,currentColor 32%,transparent)}',
  '.ys-bmember.is-busy .ys-bdot{background:var(--ys-b-accent)}',
  '.ys-bmember.is-alert .ys-bdot{background:var(--ys-b-warn)}',
  '.ys-bruns{display:grid;gap:8px}',
  '.ys-brun{border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-radius:12px;overflow:hidden}',
  '.ys-brun.is-alert{border-color:color-mix(in srgb,var(--ys-b-warn) 38%,transparent)}',
  '.ys-brun-toggle{display:grid!important;grid-template-columns:minmax(0,1fr) auto;align-items:center;column-gap:8px;row-gap:3px;width:100%;padding:10px 11px!important;text-align:left;border:0!important;border-radius:0!important;background:transparent!important}',
  '.ys-brun-toggle:hover{background:color-mix(in srgb,currentColor 3%,transparent)!important}',
  '.ys-brun-goal{font-size:13px;font-weight:600;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.ys-brun-sub{font-size:11px;line-height:15px;opacity:.66}',
  '.ys-btag{display:inline-block;justify-self:end;border:1px solid currentColor;border-radius:999px;padding:2px 7px;font-size:10.5px;line-height:15px;white-space:nowrap}',
  '.ys-btag.is-active{color:var(--ys-b-accent)}.ys-btag.is-done{color:var(--ys-b-ok)}.ys-btag.is-late{color:var(--ys-b-warn)}.ys-btag.is-blocked{color:var(--ys-b-danger)}',
  '.ys-brun-body{display:grid;gap:11px;padding:0 11px 11px}',
  '.ys-blead{border-top:1px solid color-mix(in srgb,currentColor 10%,transparent);padding-top:9px;font-size:11.5px;line-height:17px}',
  '.ys-btimeline{display:grid;gap:5px;margin:0}',
  '.ys-btimeline-title{font-size:11px;font-weight:600;line-height:16px;margin:0}',
  '.ys-btimeline-note{font-size:10.5px;line-height:15px;opacity:.65;margin:0}',
  '.ys-baxis,.ys-blane{display:grid;grid-template-columns:38px minmax(0,1fr);gap:5px;align-items:center}',
  '.ys-baxis-track{display:flex;justify-content:space-between;font-size:10px;line-height:14px;opacity:.62}',
  '.ys-blane-name{font-size:10.5px;line-height:17px;opacity:.78}',
  '.ys-blane-track{position:relative;height:18px;border-bottom:1px solid color-mix(in srgb,currentColor 13%,transparent);overflow:hidden}',
  '.ys-bbar{position:absolute;top:6px;height:7px;min-width:4px;border-radius:3px;background:var(--ys-b-accent)}',
  '.ys-bbar.is-done{background:var(--ys-b-ok)}',
  '.ys-bbar.is-late{top:5px;height:8px;border:1px dashed var(--ys-b-warn);background:color-mix(in srgb,var(--ys-b-warn) 16%,transparent)}',
  '.ys-bbar.is-blocked{background:var(--ys-b-danger)}',
  '.ys-btick{position:absolute;top:6px;width:6px;height:6px;border-radius:50%;transform:translateX(-50%);background:var(--ys-b-ok)}',
  '.ys-btick.is-active{background:var(--ys-b-accent)}.ys-btick.is-late{background:var(--ys-b-warn)}.ys-btick.is-blocked{background:var(--ys-b-danger)}',
  '.ys-bsettle{position:absolute;top:5px;width:8px;height:8px;border:1px solid var(--ys-b-ok);border-radius:50%;transform:translateX(-50%);background:Canvas}',
  '.ys-bsettle.is-blocked{border-color:var(--ys-b-danger)}',
  '.ys-bdecision{position:absolute;top:5px;width:7px;height:7px;transform:translateX(-50%) rotate(45deg);background:var(--ys-b-warn)}',
  '.ys-bassignments{display:grid;gap:0}',
  '.ys-bassignment{border-top:1px solid color-mix(in srgb,currentColor 9%,transparent);padding:6px 0}',
  '.ys-bassignment summary{display:grid;grid-template-columns:28px 28px minmax(0,1fr) auto;gap:6px;align-items:center;cursor:pointer;list-style:none;font-size:12px;line-height:18px}',
  '.ys-bassignment summary::-webkit-details-marker{display:none}',
  '.ys-bnumber{font-size:10.5px;opacity:.62;font-variant-numeric:tabular-nums}',
  '.ys-bwho{font-weight:600;white-space:nowrap}',
  '.ys-bask{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.ys-bstate{font-size:10.5px;white-space:nowrap}',
  '.ys-bstate.is-active{color:var(--ys-b-accent)}.ys-bstate.is-done{color:var(--ys-b-ok)}.ys-bstate.is-late{color:var(--ys-b-warn)}.ys-bstate.is-blocked{color:var(--ys-b-danger)}',
  '.ys-bdetails{padding:6px 0 2px 62px;display:grid;gap:3px;font-size:11px;line-height:16px;overflow-wrap:anywhere}',
  '.ys-bdetails p{margin:0}.ys-bdetails-label{opacity:.62}',
  '.ys-bmissing{margin:0;font-size:10.5px;line-height:16px;opacity:.62}',
  '.ys-bsection{display:grid;gap:7px;border-top:1px solid color-mix(in srgb,currentColor 12%,transparent);padding-top:10px}',
  '.ys-bsection-title{margin:0;font-size:12px;font-weight:650;line-height:18px}',
  '.ys-bbackground{display:grid;gap:7px}',
  '.ys-bjob{display:grid;gap:5px;padding:9px 10px;border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-radius:9px}',
  '.ys-bjob-head{display:flex;justify-content:space-between;align-items:center;gap:8px}',
  '.ys-bjob-title{font-size:12px;font-weight:600;line-height:17px;overflow-wrap:anywhere}',
  '.ys-bjob-step{margin:0;font-size:11px;line-height:16px;overflow-wrap:anywhere}',
  '.ys-bjob-meta{margin:0;font-size:10.5px;line-height:15px;opacity:.68}',
  '.ys-b :focus-visible{outline:2px solid var(--ys-b-accent);outline-offset:2px}',
  '@container (max-width:360px){.ys-broster{grid-template-columns:repeat(2,minmax(0,1fr))}.ys-bassignment summary{grid-template-columns:26px 28px minmax(0,1fr) auto;gap:4px}.ys-bdetails{padding-left:54px}}',
  '@media (prefers-color-scheme:dark){.ys-b{--ys-b-accent:#83b9c0;--ys-b-ok:#91c7ab;--ys-b-warn:#dfc58e;--ys-b-danger:#e5a3a5}}',
].join('\n')

function buildBoardViewModel(data, onlyAttn = false) {
  const all = Array.isArray(data?.tasks) ? data.tasks : []
  const tasks = onlyAttn ? all.filter(t => ATTENTION.has(t.statusCode)) : all
  const allBackground = Array.isArray(data?.backgroundTasks) ? data.backgroundTasks : []
  const background = onlyAttn ? allBackground.filter(t => t.state === 'stalled' || t.state === 'failed') : allBackground
  const busy = new Map(ROLES.map(r => [r.role, 0]))
  const late = new Map(ROLES.map(r => [r.role, 0]))
  for (const t of all) for (const a of t.assignments || []) {
    if (a.state === 'open' || a.state === 'late') busy.set(a.role, (busy.get(a.role) || 0) + 1)
    if (a.state === 'late') late.set(a.role, (late.get(a.role) || 0) + 1)
  }
  const decisions = all.filter(t => t.statusCode === 'decision').length
  const roster = ROLES.map(r => ({
    ...r, count: r.role === 'self' ? decisions : (busy.get(r.role) || 0), late: late.get(r.role) || 0,
    state: r.role === 'self' ? (decisions ? '待定' : '无需拍板') : ((busy.get(r.role) || 0) ? '手上' : '空闲'),
  }))
  return { tasks, background, backgroundCount: allBackground.length, roster, allCount: all.length, attention: all.filter(t => ATTENTION.has(t.statusCode)).length,
    unreturned: [...busy.values()].reduce((sum, n) => sum + n, 0),
    done: all.filter(t => t.statusCode === 'done').length }
}

function tone(state) { return STATUS[state]?.tone || 'late' }
function time(iso) {
  const date = new Date(iso)
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '时间未知'
}
function position(iso, start, duration) {
  const at = Date.parse(iso)
  return Number.isFinite(at) ? Math.max(1, Math.min(99, (at - start) / duration * 100)) : 1
}

function renderTimeline(timeline, h) {
  if (!timeline?.spans?.length) return null
  const start = Date.parse(timeline.startAtIso)
  const duration = Math.max(1000, Date.parse(timeline.endAtIso) - start)
  const lanes = ROLES.filter(r => r.role !== 'self' && timeline.spans.some(s => s.role === r.role))
  const lane = (r) => h('div', { className: 'ys-blane', key: r.role },
    h('span', { className: 'ys-blane-name' }, r.who),
    h('div', { className: 'ys-blane-track', 'aria-hidden': 'true' },
      ...timeline.spans.filter(s => s.role === r.role).flatMap(s => {
        const left = position(s.dispatchedAtIso, start, duration)
        const right = position(s.endAtIso, start, duration)
        const parts = [h('span', { key: s.message + '-bar', className: 'ys-bbar is-' + tone(s.state),
          style: { left: left + '%', width: Math.max(0.9, right - left) + '%' } })]
        if (s.firstRecvAtIso) parts.push(h('span', { key: s.message + '-recv', className: 'ys-btick is-' + tone(s.state),
          style: { left: position(s.firstRecvAtIso, start, duration) + '%' } }))
        if (s.settledAtIso && s.settledAtIso !== s.firstRecvAtIso) parts.push(h('span', {
          key: s.message + '-settle', className: 'ys-bsettle is-' + tone(s.state),
          style: { left: position(s.settledAtIso, start, duration) + '%' },
        }))
        return parts
      })))
  return h('figure', { className: 'ys-btimeline', 'aria-label': '派单到首回执的静态时间轨' },
    h('figcaption', { className: 'ys-btimeline-title' }, '派单时间轨'),
    h('div', { className: 'ys-baxis' }, h('span', null),
      h('div', { className: 'ys-baxis-track' }, h('span', null, time(timeline.startAtIso)), h('span', null, time(timeline.endAtIso)))),
    ...lanes.map(lane),
    timeline.decisions?.length ? h('div', { className: 'ys-blane' }, h('span', { className: 'ys-blane-name' }, '拍板'),
      h('div', { className: 'ys-blane-track', 'aria-hidden': 'true' }, ...timeline.decisions.map((d, i) =>
        h('span', { key: 'decision-' + i, className: 'ys-bdecision', style: { left: position(d.atIso, start, duration) + '%' } })))) : null,
    h('p', { className: 'ys-btimeline-note' }, '色条＝派出到首回执；缺回执时间时止于结清或现在。实心点＝首回执；空心点＝结清；不代表持续执行。'))
}

function renderAssignment(a, index, h) {
  const state = STATUS[a.state] || { text: a.stateText || '待核对', tone: 'late' }
  const number = '#' + String(index + 1).padStart(2, '0')
  const details = [
    ['要求', a.ask], ['要交回', a.want], ['交回内容', a.got],
    ['派出', a.dispatchedAtIso], ['期限', a.deadlineAtIso], ['结清', a.settledAtIso],
  ].filter(([, value]) => value)
  return h('details', { className: 'ys-bassignment', key: a.message || number },
    h('summary', { 'aria-label': number + ' ' + a.who + ' ' + state.text + ' ' + a.ask },
      h('span', { className: 'ys-bnumber' }, number),
      h('span', { className: 'ys-bwho' }, a.who),
      h('span', { className: 'ys-bask', title: a.ask }, a.ask),
      h('span', { className: 'ys-bstate is-' + state.tone }, state.text)),
    h('div', { className: 'ys-bdetails' }, ...details.map(([label, value]) =>
      h('p', { key: label }, h('span', { className: 'ys-bdetails-label' }, label + '：'), value)),
      a.left ? h('p', { key: 'left' }, a.left) : null))
}

function renderRun(t, index, expanded, onToggle, h) {
  const status = t.statusCode === 'done' ? 'done' : ['blocked', 'decision'].includes(t.statusCode) ? 'blocked'
    : ['overdue', 'handoff', 'unknown'].includes(t.statusCode) ? 'late' : 'active'
  return h('section', { className: 'ys-brun' + (ATTENTION.has(t.statusCode) ? ' is-alert' : ''), key: t.id },
    h('button', { type: 'button', className: 'ys-brun-toggle', 'aria-expanded': expanded,
      'aria-controls': expanded ? 'ys-brun-body-' + t.id : undefined, onClick: () => onToggle(t.id) },
      h('span', { className: 'ys-brun-goal', title: t.goal }, t.goal || '未命名目标'),
      h('span', { className: 'ys-btag is-' + status }, t.verdict || '待核对'),
      h('span', { className: 'ys-brun-sub' }, (t.doneCount || 0) + '/' + (t.total || 0) + ' 件已交回' + (t.lastAt ? ' · 最后动静 ' + t.lastAt : ''))),
    expanded ? h('div', { className: 'ys-brun-body', id: 'ys-brun-body-' + t.id },
      h('div', { className: 'ys-blead' }, '主导者：' + (t.statusCode === 'decision' ? '等拍板' : t.statusCode === 'handoff' ? '待下一步' : t.verdict)),
      renderTimeline(t.timeline, h),
      !t.timeline && t.assignments?.length ? h('p', { className: 'ys-bmissing' }, '暂无可用派单时间记录，仍可查看每条派单。') : null,
      h('div', { className: 'ys-bassignments' }, ...(t.assignments || []).map((a, i) => renderAssignment(a, i, h))),
      t.objections ? h('p', { className: 'ys-bfoot' }, t.objections + ' 条异议待核对') : null) : null)
}

function renderBackgroundTask(task, h) {
  const status = { running: ['运行中', 'active'], stalled: ['卡住', 'late'],
    done: ['完成', 'done'], failed: ['失败', 'blocked'] }[task.state] || ['待核对', 'late']
  return h('article', { className: 'ys-bjob', key: task.id },
    h('div', { className: 'ys-bjob-head' },
      h('span', { className: 'ys-bjob-title' }, task.title),
      h('span', { className: 'ys-btag is-' + status[1] }, status[0])),
    h('p', { className: 'ys-bjob-step' }, '正在做：' + (task.step || '未记录步骤')),
    h('p', { className: 'ys-bjob-meta', title: task.lastActivityAtIso || '' },
      '已跑 ' + (task.elapsed || '未知') + ' · 最后活动 ' + (task.lastAt || '未知') +
      (task.lastActivityAtIso ? ' · ' + time(task.lastActivityAtIso) : '')))
}

/** 纯渲染入口，供无 DOM 的断言复用；h 是 React.createElement。 */
function renderBoardContent(data, options, h) {
  const { onlyAttn = false, expandedRunId = null, onToggleAttention = () => {}, onToggleRun = () => {}, error = '' } = options || {}
  const model = buildBoardViewModel(data, onlyAttn)
  const expanded = expandedRunId === '' ? null
    : model.tasks.some(t => t.id === expandedRunId) ? expandedRunId : model.tasks[0]?.id
  return h('div', { className: 'ys-b' },
    h('header', { className: 'ys-bhead' }, h('h3', { className: 'ys-btitle' }, '任务台'),
      h('button', { type: 'button', className: 'ys-bfilter', disabled: !data,
        'aria-pressed': onlyAttn, onClick: onToggleAttention }, onlyAttn ? '看全部' : '只看需留意')),
    data ? h('p', { className: 'ys-bsummary' },
      model.allCount + ' 件目标 · ' + model.attention + ' 件需留意 · ' + model.unreturned + ' 条未交 · ' + model.done + ' 件办完') : null,
    error ? h('div', { role: 'alert', className: 'ys-bempty' }, error) : null,
    !data && !error ? h('p', { className: 'ys-bempty' }, '读取中…') : null,
    data ? h('div', { className: 'ys-broster', 'aria-label': '角色忙闲' }, ...model.roster.map(r =>
      h('div', { className: 'ys-bmember' + (r.count ? (r.role === 'self' || r.late ? ' is-alert' : ' is-busy') : ''),
        key: r.role, title: r.late ? r.late + ' 件超时没交' : undefined },
        h('span', { className: 'ys-bavatar', 'aria-hidden': 'true' }, r.glyph),
        h('span', { className: 'ys-bmember-name' }, r.who),
        h('span', { className: 'ys-bmember-state' }, h('span', { className: 'ys-bdot', 'aria-hidden': 'true' }),
          r.count ? r.state + ' ' + r.count + ' 件' : r.state)))) : null,
    data ? h('section', { className: 'ys-bsection', 'aria-label': '后台执行' },
      h('h4', { className: 'ys-bsection-title' }, '后台执行 · ' + model.backgroundCount),
      model.background.length ? h('div', { className: 'ys-bbackground' }, ...model.background.map(t => renderBackgroundTask(t, h)))
        : h('p', { className: 'ys-bempty' }, onlyAttn && model.backgroundCount ? '后台任务暂无需留意项。' : '暂无后台任务。')) : null,
    data && !model.allCount && !model.backgroundCount ? h('p', { className: 'ys-bempty' }, '还没有任务记录。派单后会在这里出现。') : null,
    data && onlyAttn && !model.tasks.length && model.allCount ? h('p', { className: 'ys-bempty' }, '当前没有需留意的目标。') : null,
    model.tasks.length ? h('div', { className: 'ys-bruns' }, ...model.tasks.map((t, i) =>
      renderRun(t, i, t.id === expanded, onToggleRun, h))) : null)
}

function renderTaskBoardView({ sessionId, call }, runtime) {
  if (!runtime?.createElement) throw new Error('TaskBoardView 需要宿主 React 实例')
  const h = runtime.createElement
  const [data, setData] = runtime.useState(null)
  const [error, setError] = runtime.useState('')
  const [onlyAttn, setOnlyAttn] = runtime.useState(false)
  const [expandedRunId, setExpandedRunId] = runtime.useState(null)

  runtime.useEffect(() => {
    const id = 'ys-board-style'
    if (document.getElementById(id)) return
    const style = document.createElement('style')
    style.id = id
    style.textContent = TASKBOARD_CSS
    document.head.append(style)
  }, [])

  runtime.useEffect(() => {
    const abort = new AbortController()
    let timer
    setData(null); setError(''); setOnlyAttn(false); setExpandedRunId(null)
    if (!sessionId) return () => abort.abort()
    const tick = async () => {
      try {
        const next = await call(sessionId, 'board', {}, abort.signal)
        if (!abort.signal.aborted) { setData(next); setError('') }
      } catch (e) { if (!abort.signal.aborted) setError(e?.message || String(e)) }
      if (!abort.signal.aborted) timer = setTimeout(tick, 4000)
    }
    tick()
    return () => { abort.abort(); clearTimeout(timer) }
  }, [sessionId])

  return renderBoardContent(data, {
    error, onlyAttn, expandedRunId,
    onToggleAttention: () => setOnlyAttn(v => !v),
    onToggleRun: id => setExpandedRunId(v => v === id ? '' : id),
  }, h)
}

// 宿主把 React 作为局部变量传给 mountClient 时，用此工厂绑定，无需全局 React。
function createTaskBoardView(runtime) {
  return function BoundTaskBoardView(props) { return renderTaskBoardView(props, runtime) }
}

function TaskBoardView(props) {
  const runtime = props.ReactRuntime || (typeof React === 'undefined' ? globalThis.React : React)
  return renderTaskBoardView(props, runtime)
}

function MemoryView({ sessionId, call, onActiveChange, embedded = false, mediaSection = null }) {
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

function MemoryLayers({ data, call, sessionId, run, busy }) {
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

function ProfileEditor({ content, call, sessionId, run, busy }) {
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

function ProfileField({ draft, change, label, depth, root = false }) {
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

function ProfileDisplay({ value, depth = 0 }) {
  const h = React.createElement;
  if (value === null) return h('small', null, '未设置');
  if (typeof value !== 'object') return h('p', null, typeof value === 'boolean' ? (value ? '是' : '否') : String(value));
  if (!Object.keys(value).length) return h('small', null, '未设置');
  if (depth > 8) return h('p', null, JSON.stringify(value));
  return Array.isArray(value) ? h('ul', { style: { margin: 0, paddingLeft: 20 } }, ...value.map((item, i) => h('li', { key: i }, h(ProfileDisplay, { value: item, depth: depth + 1 })))) :
    h('dl', { style: { margin: 0, display: 'grid', gap: 6 } }, ...Object.entries(value).map(([key, item]) => h('div', { key, style: { display: 'grid', gridTemplateColumns: 'minmax(60px, 25%) minmax(0, 1fr)', gap: 10 } }, h('dt', null, key), h('dd', { style: { margin: 0, minWidth: 0 } }, h(ProfileDisplay, { value: item, depth: depth + 1 })))));
}


return {inject:["remote","slots"],apply:ctx=>mountUnifiedClient(ctx,"yunshuMemory",remoteSpec("yunshuMemory",z,createTypertRemoteInfo),[{id:"memory",label:"记忆",View:MemoryView},{id:"board",label:"任务",View:TaskBoardView}],React)};
}});