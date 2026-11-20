export function EvidenceView({ sessionId, call }) {
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
