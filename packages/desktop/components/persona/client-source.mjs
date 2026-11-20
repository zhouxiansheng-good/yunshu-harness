export function PersonaView({ sessionId, call, onActiveChange, embedded = false }) {
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
