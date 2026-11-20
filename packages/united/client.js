/**
 * 云舒联合体 · 任务台（客户端面板）0.2.0
 *
 * 设计约束（都是踩过的坑）：
 *   1. 不要用 Panel / createPortal —— 嵌套面板会互相判"点外面"，一碰就全关
 *   2. 数据全走 remote 调用，不在客户端读文件
 *   3. 自己刷：任务 4 秒、体检 15 秒，不需要人手动点
 *   4. 面板显示四段：待修 → 后台执行 → 联合体 → 体检明细
 *      待修段是给「我们」看的：每条写清 谁修 + 怎么修，不推给用户
 */
(function () {
  'use strict'

  const NAMESPACE = 'yunshuUnited'

  const CSS = `
.ysu-wrap{position:relative;display:inline-flex;align-items:center;gap:6px;font:inherit;color:inherit}
.ysu-btn{display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 9px;border-radius:8px;
  border:1px solid rgba(127,127,127,.28);background:transparent;color:inherit;font:inherit;font-size:12px;
  cursor:pointer;transition:background .15s ease}
.ysu-btn:hover{background:rgba(127,127,127,.12)}
.ysu-btn[data-hot="1"]{border-color:#9a4a4e}
/* 输入区入口只设置自己的按钮，避免任务台样式影响其他插件。 */
.ysu-wrap button.ysu-chip{appearance:none;box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;
  height:28px;padding:0 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 20%,transparent));
  background:transparent;color:inherit;font:inherit;font-size:12px;line-height:1;white-space:nowrap;cursor:pointer;transition:background .15s ease}
.ysu-wrap button.ysu-chip:hover{background:var(--dsw-alias-bg-layer-2,color-mix(in srgb,currentColor 10%,transparent))}
.ysu-wrap button.ysu-chip:disabled{opacity:.45;cursor:default}
.ysu-wrap button.ysu-chip[data-health="warn"]{border-color:var(--dsw-alias-state-warn-primary,#805e29)}
.ysu-wrap button.ysu-chip[data-health="late"]{border-color:var(--dsw-alias-state-error-primary,#9a4a4e)}
.ysu-wrap button.ysu-chip svg{width:14px;height:14px;flex:0 0 auto;opacity:.85}
.ysu-wrap .ysu-chip-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary,#888);flex:0 0 auto}
.ysu-wrap .ysu-chip-dot[data-s="ok"]{background:var(--dsw-alias-state-success-primary,#2e6b53)}
.ysu-wrap .ysu-chip-dot[data-s="warn"]{background:var(--dsw-alias-state-warn-primary,#805e29)}
.ysu-wrap .ysu-chip-dot[data-s="late"]{background:var(--dsw-alias-state-error-primary,#9a4a4e)}
.ysu-dot{width:6px;height:6px;border-radius:50%;background:#2e6b53;flex:0 0 auto}
.ysu-dot[data-s="work"]{background:#356e75}
.ysu-dot[data-s="late"]{background:#9a4a4e}
.ysu-dot[data-s="warn"]{background:#805e29}
.ysu-panel{position:absolute;left:0;bottom:36px;z-index:60;width:560px;max-height:min(74vh,620px);
  overflow:auto;padding:14px;border-radius:12px;background:var(--dsh-bg-elevated,#1c1f23);
  border:1px solid rgba(127,127,127,.24);box-shadow:0 10px 32px rgba(0,0,0,.28);color:inherit;
  font-size:13px;line-height:1.5}
/* Dock owns positioning and scrolling; an absolute child otherwise has zero flow height. */
.ysu-wrap.ysu-embedded{display:block;width:100%;min-width:0}
.ysu-embedded>.ysu-panel{position:static;inset:auto;z-index:auto;box-sizing:border-box;
  width:100%;min-width:0;max-height:none;overflow:visible;padding:4px 2px;
  border:0;border-radius:0;box-shadow:none;background:transparent}
.ysu-embedded .ysu-sub{opacity:.85;font-size:12px}
.ysu-embedded .ysu-goal,.ysu-embedded .ysu-meta,.ysu-embedded .ysu-check{overflow-wrap:anywhere}
.ysu-embedded .ysu-check>span:first-child{flex:0 0 auto;white-space:nowrap}
.ysu-embedded .ysu-check>span:last-child{min-width:0}
.ysu-embedded .ysu-row{flex-wrap:wrap}
.ysu-embedded .ysu-ask{flex-basis:150px}
.ysu-requirements{font-size:12px;margin:4px 0;overflow-wrap:anywhere}
.ysu-requirements>summary{cursor:pointer;opacity:.75}
.ysu-requirements>div{margin:6px 0;line-height:1.6}
.ysu-embedded .ysu-st[data-s="done"],.ysu-embedded .ysu-ok{
  color:var(--dsw-alias-state-success-primary,light-dark(#236d49,#91c7ab))}
.ysu-embedded .ysu-bad{color:var(--dsw-alias-state-error-primary,light-dark(#963e43,#e5a3a5))}
.ysu-alert{margin:8px 0;padding:8px;border:1px solid #805e29;border-radius:6px;
  font-size:12px;overflow-wrap:anywhere;background:rgba(128,94,41,.08)}
.ysu-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:8px}
.ysu-title{font-size:14px;font-weight:600}
.ysu-sub{font-size:11px;opacity:.6}
.ysu-sec{margin:12px 0 6px;font-size:11px;letter-spacing:.04em;opacity:.55;text-transform:none}
.ysu-toggle{cursor:pointer;user-select:none}
.ysu-toggle:hover{opacity:.85}
.ysu-bar{display:flex;gap:10px;font-size:11px;opacity:.7;flex-wrap:wrap}
.ysu-bar b{font-weight:600;opacity:.95}
.ysu-card{border:1px solid rgba(127,127,127,.18);border-radius:10px;padding:10px 12px;margin-bottom:10px}
.ysu-card:last-child{margin-bottom:0}
.ysu-goal{font-size:13px;font-weight:600;margin-bottom:2px}
.ysu-meta{font-size:11px;opacity:.62;margin-bottom:8px}
.ysu-row{display:flex;gap:8px;align-items:flex-start;padding:5px 0;border-top:1px dashed rgba(127,127,127,.14)}
.ysu-row:first-of-type{border-top:0}
.ysu-who{flex:0 0 auto;font-size:11px;padding:1px 6px;border-radius:5px;background:rgba(127,127,127,.14);white-space:nowrap}
.ysu-who[data-r="builder"]{background:rgba(53,110,117,.22)}
.ysu-who[data-r="explorer"]{background:rgba(46,107,83,.22)}
.ysu-who[data-r="guardian"]{background:rgba(128,94,41,.22)}
.ysu-who[data-r="external"]{background:rgba(154,74,78,.2)}
.ysu-who[data-r="codex"]{background:rgba(96,86,140,.24)}
.ysu-ask{flex:1 1 auto;min-width:0;word-break:break-word}
.ysu-st{flex:0 0 auto;font-size:11px;white-space:nowrap}
.ysu-st[data-s="open"]{color:#83b9c0}
.ysu-st[data-s="running"]{color:#83b9c0}
.ysu-st[data-s="late"]{color:#e5a3a5}
.ysu-st[data-s="stalled"]{color:#e5a3a5}
.ysu-st[data-s="done"]{color:#91c7ab}
.ysu-got{font-size:11px;opacity:.72;margin-top:2px}
.ysu-empty{opacity:.6;font-size:12px;padding:14px 0;text-align:center}
.ysu-prob{border:1px solid rgba(154,74,78,.34);border-left:3px solid #9a4a4e;border-radius:8px;
  padding:8px 10px;margin-bottom:8px;background:rgba(154,74,78,.07)}
.ysu-prob[data-lv="mid"]{border-color:rgba(128,94,41,.34);border-left-color:#805e29;background:rgba(128,94,41,.07)}
.ysu-prob-what{font-size:12px}
.ysu-prob-fix{font-size:11px;opacity:.72;margin-top:4px;font-family:ui-monospace,Consolas,monospace;
  white-space:pre-wrap;word-break:break-all;user-select:text}
.ysu-own{font-size:11px;padding:1px 6px;border-radius:5px;background:rgba(127,127,127,.16);margin-right:6px}
.ysu-check{display:flex;gap:8px;align-items:baseline;font-size:11px;padding:2px 0;opacity:.85}
.ysu-ok{color:#91c7ab}
.ysu-bad{color:#e5a3a5}
.ysu-idle{opacity:.55;font-size:11px;white-space:nowrap}
.ysu-step{font-size:11px;opacity:.7;margin-top:2px}
.ysu-activity{margin:8px 0 4px;padding:8px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.24));border-radius:7px;min-width:0;overflow-wrap:anywhere}
.ysu-activity[data-tone="warn"]{border-left:3px solid var(--dsw-alias-state-warn-primary,#a67a35)}
.ysu-activity[data-tone="ok"]{border-left:3px solid var(--dsw-alias-state-success-primary,#2e6b53)}
.ysu-activity-title{font-weight:600;font-size:12px}
.ysu-activity dl{margin:6px 0;font-size:12px}.ysu-activity dt{opacity:.68;margin-top:4px}.ysu-activity dd{margin:0;white-space:pre-wrap}
.ysu-activity summary{cursor:pointer;font-size:12px}.ysu-activity ol{padding-left:20px;margin:6px 0}
.ysu-activity li{padding:4px 0}.ysu-activity small{display:block;font-size:11px;opacity:.75;white-space:pre-wrap}
`

  function ago(sec) {
    if (sec === null || sec === undefined) return ''
    if (sec < 60) return '刚刚'
    const m = Math.round(sec / 60)
    if (m < 60) return m + ' 分钟前'
    const h = Math.floor(m / 60)
    if (h < 24) return h + ' 小时前'
    return Math.floor(h / 24) + ' 天前'
  }

function TaskArtifact({React,artifact}) {
  const h=React.createElement,url=new URL('api/file',document.baseURI);
  url.searchParams.set('path',artifact.uri);
  const kind=artifact.mime.split('/')[0],src=url.href;
  const style={display:'block',maxWidth:'100%',maxHeight:'240px',objectFit:'contain',marginBlock:'8px'};
  return h('div',null,
    kind==='image' && h('img',{src,alt:artifact.path,style}),
    (kind==='audio'||kind==='video') && h(kind,{src,controls:true,preload:'metadata',style}),
    h('p',null,artifact.path+' · '+artifact.bytes.toLocaleString()+' 字节'),
    h('a',{href:src,download:artifact.path.split('/').at(-1)},'保存交付文件'));
}
function SessionTaskBoard({React,sessionId,data,call,refresh}) {
  const h=React.createElement;
  const [selected,select]=React.useState('');
  const [creating,setCreating]=React.useState(false);
  const [form,setForm]=React.useState({goal:'',acceptance:'',target:''});
  const [read,setRead]=React.useState(null);
  const [revision,setRevision]=React.useState(null);
  const [busy,setBusy]=React.useState(false);
  const [error,setError]=React.useState('');
  const lock=React.useRef(false),request=React.useRef(null);
  const [hiddenDraft,setHiddenDraft]=React.useState(null);
  const edited=React.useRef({}),editVersion=React.useRef(null);
  const plan=data.chatPlan;
  const draft=plan?.state==='clarifying'&&!creating&&hiddenDraft!==plan.id?plan:null;
  const tasks=data.tasks||[],t=tasks.find(row=>row.id===(selected||plan?.runId))||tasks[0],v=t?.native;
  const displayed={...form};
  if(draft)for(const key of Object.keys(form)){if(!edited.current[key])displayed[key]=draft[key]??'';}
  const text=(key,value)=>h('label',{style:{display:'grid',gap:'4px',marginBottom:'8px'}},key,value);
  const button=(label,click,disabled=false)=>h('button',{type:'button',onClick:click,disabled:busy||disabled},label);
  const names={ready:'待执行',queued:'已送入本会话',running:'主聊天执行中',stopped:'回复中断，等待重试',answered:'已收到主聊天答复',stale:'目标已修订，等待重新执行',review:'待你验收',done:'已验收'};
  async function act(action,extra={}){
    if(lock.current)return;
    lock.current=true;setBusy(true);setError('');
    const signature=JSON.stringify([sessionId,action,t?.id,extra]);
    if(request.current?.signature!==signature)request.current={signature,id:crypto.randomUUID()};
    try{
      const value=await call(sessionId,'session-task',{action,runId:t?.id,requestId:request.current.id,...extra});
      if(action==='preview'){setRead({id:t.id,...value});return;}
      if(action==='create'){select(value.id);setCreating(false);edited.current={};editVersion.current=null;setForm({goal:'',acceptance:'',target:''});}
      if(action==='revise')setRevision(null);
      if(action!=='preview')setRead(null);
      await refresh?.();request.current=null;
    }catch(e){setError(e?.message||String(e));}
    finally{lock.current=false;setBusy(false);}
  }
  React.useEffect(()=>{
    if(!['queued','running','answered'].includes(v?.phase))return;
    const timer=setInterval(()=>{if(!lock.current)void refresh?.()},1200);
    return ()=>clearInterval(timer);
  },[t?.id,v?.phase,refresh]);
  const update=(key,value)=>{
    if(draft&&!editVersion.current)editVersion.current={draftId:draft.id,draftRevision:draft.revision};
    edited.current[key]=true;setForm(prev=>({...prev,[key]:value}));
  };
  const resetInput=()=>{edited.current={};editVersion.current=null;setForm({goal:'',acceptance:'',target:''});};
  const input=(key,rows,max,placeholder)=>h('textarea',{'aria-label':key==='goal'?'任务目标':'验收标准',rows,maxLength:max,value:displayed[key],placeholder,
    onChange:e=>update(key,e.target.value),style:{width:'100%',boxSizing:'border-box'}});
  return h('div',{className:'sr-board','data-yunshu-session-tasks':'1'},
    (creating||draft||!t) ? h('form',{className:'sr-editor',onSubmit:e=>{
      e.preventDefault();if(displayed.goal.trim()&&displayed.acceptance.trim())void act('create',{...displayed,...(draft?(editVersion.current??{draftId:draft.id,draftRevision:draft.revision}):{})});
    }},
      draft?h('div',{role:'status'},h('strong',null,'主聊天 · 需求澄清'),draft.questions?.length>0&&h('ul',null,...draft.questions.map((q,i)=>h('li',{key:i},q)))):
        !creating&&h('p',{className:'sr-muted'},'可以在主聊天说明需求，也可以在这里填写。'),
      text('任务目标',input('goal',2,2000,'你要在这个会话完成什么？')),
      text('验收标准',input('acceptance',2,2000,'怎样判断任务完成？')),
      text('交付文件（可选）',h('input',{'aria-label':'交付文件（可选）',value:displayed.target,maxLength:500,placeholder:'工作区相对路径；留空则交付聊天答复',onChange:e=>update('target',e.target.value)})),
      draft&&editVersion.current&&draft.revision!==editVersion.current.draftRevision&&h('div',{role:'status'},'主聊天已更新这张草案。',button('载入最新草案',resetInput)),
      h('div',{className:'sr-actions'},h('button',{type:'submit',className:'sr-primary',disabled:busy||!displayed.goal.trim()||!displayed.acceptance.trim()},'创建任务'),
        t&&button(draft?'查看已有任务':'取消',()=>{if(draft)setHiddenDraft(draft.id);setCreating(false);resetInput();}))) :
    h(React.Fragment,null,
      h('div',{className:'sr-actions'},button('新建任务',()=>{resetInput();setCreating(true);setRead(null);setError('');}),
        plan?.state==='clarifying' && button('查看澄清草案',()=>{resetInput();setHiddenDraft(null);}),
        tasks.length>1 && h('select',{'aria-label':'选择本会话任务',value:t.id,onChange:e=>{select(e.target.value);setRead(null);setError('');}},
          ...tasks.map(row=>h('option',{key:row.id,value:row.id},row.goal)))),
      h('section',{className:'sr-section'},h('span',{className:'sr-meta',role:'status'},names[v.phase]||v.phase),
        h('h2',{className:'sr-goal'},t.goal),h('p',null,'验收标准　'+v.acceptance),
        h('p',{className:'sr-muted'},v.target?'交付文件　'+v.target:'交付形式　聊天答复'),
        h('div',{className:'sr-actions'},
          !['done','queued','running'].includes(v.phase) && button('修改任务目标',()=>setRevision({id:t.id,text:t.goal})),
          v.phase==='ready' && button('在主聊天执行',()=>act('start')),
          v.phase==='stopped' && button('重试执行',()=>act('start')),
          v.phase==='answered' && button('收取交付结果',()=>act('collect')),
          v.phase==='answered' && button('重新执行',()=>act('start')),
          ['stale','review'].includes(v.phase) && button('重新执行',()=>act('redo')),
          ['review','done'].includes(v.phase) && button('查看交付内容',()=>act('preview'))),
        revision?.id===t.id && h('form',{className:'sr-editor',onSubmit:e=>{e.preventDefault();if(revision.text.trim())void act('revise',{goal:revision.text});}},
          text('新任务目标',h('textarea',{value:revision.text,maxLength:2000,onChange:e=>setRevision({id:t.id,text:e.target.value})})),
          h('button',{type:'submit',disabled:busy||!revision.text.trim()},'保存修改'),button('取消',()=>setRevision(null))),
        ['review','done'].includes(v.phase) && read?.id===t.id && h('section',{className:'sr-section'},
          read.artifact ? h(TaskArtifact,{React,artifact:read.artifact}) :
            h('pre',{style:{maxHeight:'190px',overflow:'auto',whiteSpace:'pre-wrap',overflowWrap:'anywhere',userSelect:'text'}},read.text),
          v.phase==='review' && button('已核对，验收通过',()=>act('accept',{receipt:read.receipt,digest:read.digest,reviewed:true}))))),
    error && h('p',{role:'alert',className:'sr-notice'},error));
}

function StarTaskBoard({ React, sessionId, data, call, refresh, renderActivity }) {
  const h = React.createElement
  const [selected, select] = React.useState('')
  const [draft, setDraft] = React.useState(null)
  const [notice, setNotice] = React.useState(null)
  const [busy, setBusy] = React.useState(false)
  const sending = React.useRef(false)
  const tasks = data?.tasks || []
  const task = tasks.find(item => item.id === selected) || tasks[0]
  const steps = task?.assignments || []
  const control = task?.continuation
  const canEdit = control?.canEdit === true
  const returned = steps.filter(step => step.state === 'done').length
  const recent = (data?.actions || []).filter(row => row.runId === task?.id).slice(0, 8)
  const labels = { 'edit-goal': '修改目标', 'edit-step': '修改步骤', continue: '继续推进' }
  const roles = { explorer: '探索', builder: '执行', guardian: '复核' }
  const role = part => roles[part] || part || '待分派'
  const button = (label, action, attrs = {}) => h('button', { type: 'button', onClick: action, ...attrs }, label)
  const time = value => value ? new Date(value).toLocaleString('zh-CN', { month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit', hour12:false }) : ''
  function resultText(row) {
    if (row.status === 'failed') return row.error || '处理失败，请查看任务状态'
    if (row.status === 'processing') return '正在处理'
    if (row.status === 'queued') return row.error || '已排队，等待处理'
    if (row.status !== 'processed') return '状态未知'
    const result = row.result || {}
    if (result.kind === 'dispatch' || result.kind === 'revise+dispatch') return '已派给' + role(result.part) + '，等待交回'
    if (result.deferred === 'pending-dispatch') return '步骤已修订，在途派单保留原指令'
    if (result.deferred && result.reason) return '步骤已修订。' + result.reason
    return row.action === 'edit-goal' ? '目标已修订' : '步骤已修订'
  }
  function edit(action, step) {
    select(task.id)
    setNotice(null)
    setDraft({ action, runId: task.id, stepId: step?.message,
      value: action === 'edit-goal' ? task.goal : step.nextInstruction || step.sentObjective || step.ask })
  }
  async function submit(action) {
    if (sending.current || !task || (action === 'continue' ? !control?.canContinue : !canEdit)) return
    sending.current = true
    setBusy(true)
    const runId = task.id
    select(runId)
    const payload = { action, runId, requestId: crypto.randomUUID() }
    if (action === 'edit-goal') payload.goal = draft.value.trim()
    if (action === 'edit-step') Object.assign(payload, { stepId: draft.stepId, stepText: draft.value.trim() })
    try {
      const receipt = await call(sessionId, 'task-action', payload)
      if (!receipt?.accepted) throw new Error(receipt?.error || '任务操作未被接受')
      setNotice({ runId, kind: receipt.status, text: resultText({ ...receipt, action }) })
      if (receipt.status !== 'failed') setDraft(null)
      await refresh?.()
    } catch (error) {
      setNotice({ runId, kind:'failed', text: error.message || String(error) })
    } finally {
      sending.current = false
      setBusy(false)
    }
  }
  if (!task) return h('div', {className:'sr-board-empty'}, data ? '还没有任务记录' : '正在读取任务…')
  const stateId = 'sr-task-state-' + sessionId + '-' + task.id
  const next = control?.reason || '等待读取原任务记录。'
  const form = draft?.runId === task.id && h('form', { className: 'sr-editor', onSubmit: e => { e.preventDefault(); if (draft.value.trim()) void submit(draft.action) } },
    h('label', null, draft.action === 'edit-goal' ? '新任务目标' : '新步骤内容',
      h('textarea', { autoFocus: true, value: draft.value, maxLength: draft.action === 'edit-goal' ? 2000 : 1200,
        onChange: e => setDraft({ ...draft, value: e.target.value }) })),
    h('div', {className:'sr-actions'}, h('button', { type:'submit', className:'sr-primary', disabled: busy || !canEdit || !draft.value.trim() }, '保存修改'),
      button('取消', () => setDraft(null), { disabled:busy })))
  return h('div', {className:'sr-board'},
    tasks.length > 1 && h('label', {className:'sr-picker'}, '查看任务',
      h('select', { value: task.id, disabled: busy, onChange: e => { select(e.target.value); setDraft(null); setNotice(null) } },
        ...tasks.map(t => h('option', { key:t.id, value:t.id }, t.goal)))),
    h('section', {className:'sr-board-head'},
      h('div', { className:'sr-meta' }, h('span', {id:stateId, 'aria-live':'polite'}, next), h('span', null, time(task.updatedAt))),
      h('h2', { className:'sr-goal' }, task.goal),
      h('div', {className:'sr-actions'}, button('继续推进项目', () => submit('continue'), { className:'sr-primary', disabled: !control?.canContinue || busy || !!draft, 'aria-describedby':stateId }),
        button('修改任务目标', () => edit('edit-goal'), {disabled: !canEdit || busy})),
      form,
      notice?.runId === task.id && h('p', { role: notice.kind === 'failed' ? 'alert' : 'status', className:'sr-notice', 'data-status':notice.kind }, notice.text)),
    h('section', {className:'sr-section'}, h('div', {className:'sr-section-head'}, h('h3', null, '任务步骤'), h('span', null, returned + ' / ' + steps.length + ' 已交回')),
      steps.length ? h('ol', {className:'sr-steps'}, ...steps.map(s => h('li', { key:s.message, 'data-state':s.state },
        h('div', {className:'sr-step-top'}, h('strong', null, role(s.who)), h('span', null, s.stateText),
          !s.external && s.sentObjective && button('修改步骤', () => edit('edit-step', s), {disabled:!canEdit || busy})),
        h('p', null, s.nextInstruction || s.ask),
        s.got && h('blockquote', null, s.got),
        s.sentObjective && h('details', null, h('summary', null, '实际派单'), h('p', null, s.sentObjective),
          s.sentContext && h('p', null, s.sentContext), h('small', null, s.message)),
        s.codingActivity && h('details', null, h('summary', null, s.codingActivity.label || '编码记录'), renderActivity(s.codingActivity)))))
        : h('p', { className:'sr-muted' }, '等待第一张派单')),
    recent.length > 0 && h('section', {className:'sr-section'}, h('h3', null, '最近操作'),
      h('ol', {className:'sr-history'}, ...recent.map(a => h('li', {key:a.id, 'data-status':a.status},
        h('div', null, h('strong', null, labels[a.action]), h('time', null, time(a.processedAt || a.at))),
        h('p', null, resultText(a)))))))
}


  function BoardPanel(props) {
    const { React, sessionId, call, onClose, embedded = false } = props
    const h = React.createElement
    const refreshBoard = React.useRef(null)
    const [data, setData] = React.useState(null)
    const [health, setHealth] = React.useState(null)
    const [err, setErr] = React.useState('')
    const [healthErr, setHealthErr] = React.useState('')
    const [showDone, setShowDone] = React.useState(false)
    const [showArch, setShowArch] = React.useState(false)
    const [openLines, setOpenLines] = React.useState({})
    const toggleLine = id => setOpenLines(v => {
      const current = v[id] === undefined
        ? Boolean(((data && data.lines && data.lines.lines) || []).find(l => l.id === id)?.needsYou)
        : v[id]
      return { ...v, [id]: !current }
    })

    React.useEffect(() => {
      let aborted = false
      const ac = new AbortController()
      let boardRequest = 0, healthRequest = 0

      const pullBoard = async () => {
        const request = ++boardRequest
        try {
          const v = await call(sessionId, 'board', { limit: 8 }, ac.signal)
          if (!aborted && request === boardRequest) { setData(v); setErr('') }
        } catch (e) {
          if (!aborted && request === boardRequest) setErr(e && e.message ? e.message : String(e))
        }
      }
      const pullHealth = async () => {
        const request = ++healthRequest
        try {
          const v = await call(sessionId, 'health', {}, ac.signal)
          if (!aborted && request === healthRequest) { setHealth(v); setHealthErr('') }
        } catch (e) {
          if (!aborted && request === healthRequest) setHealthErr(e && e.message ? e.message : String(e))
        }
      }
      refreshBoard.current = pullBoard
      pullBoard(); pullHealth()
      const t1 = setInterval(pullBoard, 4000)
      const t2 = setInterval(pullHealth, 15000)
      return () => { refreshBoard.current = null; aborted = true; ac.abort(); clearInterval(t1); clearInterval(t2) }
    }, [sessionId])

    const bg = data?.background || { tasks: [], summary: {} }
    const bs = bg.summary || {}
    const s = data?.summary || {}
    const tasks = data?.tasks || []
    const problems = health?.problems || []
    const checks = health?.checks || []

    const head = h('div', { className: 'ysu-head' },
      h('div', null,
        !embedded && h('div', { className: 'ysu-title' }, '任务台'),
        h('div', { className: 'ysu-sub' }, data?.headline || (err ? '任务读取失败' : '正在读…'))
      ),

    )

    const bar = data && h('div', null,
      h('div', { className: 'ysu-bar' },
        h('span', null, '在做 ', h('b', null, s.working ?? 0)),
        h('span', null, '卡住 ', h('b', null, s.attention ?? 0)),
        h('span', null, '已交回 ', h('b', null, s.done ?? 0))),
      (bs.total > 0 || bs.archived > 0) && h('div', { className: 'ysu-bar' },
        h('span', null, '后台：运行 ', h('b', null, bs.running ?? 0)),
        h('span', null, '失败 ', h('b', null, bs.failed ?? 0)),
        h('span', null, '完成 ', h('b', null, bs.done ?? 0)),
        h('span', null, '归档 ', h('b', null, bs.archived ?? 0))))


    const problemNodes = problems.length
      ? h('div', null,
          h('div', { className: 'ysu-sec' }, '待修 · 大的在上，我们自己修'),
          ...problems.slice(0, 6).map((p, i) => h('div', { className: 'ysu-prob', key: p.key || i, 'data-lv': p.level },
            h('div', { className: 'ysu-prob-what' },
              h('span', { className: 'ysu-own' }, '谁修：' + (p.owner || '云舒')),
              p.level === 'high' ? h('span', { className: 'ysu-own', style: { background: 'rgba(154,74,78,.28)' } }, '大') : null,
              p.what
            ),
            p.memoryHint ? h('div', { className: 'ysu-step' }, '记忆线索：' + p.memoryHint) : null,
            p.fix ? h('div', { className: 'ysu-prob-fix' }, p.fix) : null
          ))
        )
      : null

    // ── 归线渲染：一条线＝一个话题，点标题展开/收起；要你拍板的默认展开 ──
    const lineData = data?.lines || {}
    const lines = lineData.lines || []
    const expanded = id => {
      const v = openLines[id]
      if (v !== undefined) return v
      const line = lines.find(l => l.id === id)
      return Boolean(line && line.needsYou)
    }

    const entryRow = e => h('div', { className: 'ysu-row', key: e.id, 'data-lv': e.level },
      h('span', { className: 'ysu-who', 'data-r': e.source === 'run' ? 'builder' : 'codex' }, e.source === 'run' ? '联合体' : 'codex'),
      h('span', { className: 'ysu-ask' },
        h('div', null, e.title),
        e.summary ? h('div', { className: 'ysu-got' }, '↳ ' + e.summary) : null,
        e.resolved ? h('div', { className: 'ysu-step' }, '已处理：' + e.resolved.by + (e.resolved.note ? ' · ' + e.resolved.note : '')) : null
      ),
      h('span', { className: 'ysu-idle' },
        e.idleMinutes === null || e.idleMinutes === undefined ? ''
          : (e.idleMinutes < 1 ? '刚刚' : e.idleMinutes + ' 分钟前')),
      h('span', {
        className: 'ysu-st',
        'data-s': e.state === 'done' ? 'done' : (e.state === 'failed' || e.stalled ? 'stalled' : (e.state === 'running' ? 'running' : 'late')),
      }, e.stateText)
    )

    const lineCard = l => h('div', { className: 'ysu-card', key: l.id, 'data-lv': l.level },
      h('button', { type: 'button', className: 'ysu-goal ysu-toggle', 'aria-expanded': expanded(l.id), onClick: () => toggleLine(l.id) },
        (expanded(l.id) ? '▾ ' : '▸ ') + l.title
        + (l.counts && l.counts.open ? ' · ' + l.counts.open + ' 在办' : '')
        + (l.counts && l.counts.settled ? ' · ' + l.counts.settled + ' 已完成' : '')
      ),
      h('div', { className: 'ysu-meta' },
        l.groupedBy + (l.hidden ? ' · 另有 ' + l.hidden + ' 条' : '')),
      ...(expanded(l.id) ? (l.entries || []).map(entryRow) : [])
    )

    const problemCard = (p, i) => h('div', { className: 'ysu-prob', key: p.key || i, 'data-lv': p.level },
      h('div', { className: 'ysu-prob-what' },
        h('span', { className: 'ysu-own' }, '谁修：' + (p.owner || '云舒')),
        p.level === 'high' ? h('span', { className: 'ysu-own', style: { background: 'rgba(154,74,78,.28)' } }, '大') : null,
        p.what
      ),
      p.memoryHint ? h('div', { className: 'ysu-step' }, '记忆线索：' + p.memoryHint) : null,
      p.fix ? h('div', { className: 'ysu-prob-fix' }, p.fix) : null
    )

    const needsYouLines = lines.filter(l => l.needsYou)
    const fixingLines = lines.filter(l => !l.needsYou && l.state === 'open')
    const settledLines = lines.filter(l => l.state !== 'open')
    const selfProblems = problems.filter(p => p.owner !== 'codex')

    const needsYouNodes = needsYouLines.length
      ? h('div', null,
          h('div', { className: 'ysu-sec' }, '要你拍板 · ' + needsYouLines.length),
          ...needsYouLines.map(lineCard)
        )
      : null

    const fixingNodes = (fixingLines.length || selfProblems.length)
      ? h('div', null,
          h('div', { className: 'ysu-sec' }, '我们在修' + (bg.ledger?.stale ? ' · 台账停更，卡住判定暂停' : '')),
          ...fixingLines.map(lineCard),
          ...selfProblems.slice(0, 4).map(problemCard)
        )
      : null

    const settledNodes = settledLines.length
      ? h('div', null,
          h('button', { type: 'button', className: 'ysu-sec ysu-toggle', 'aria-expanded': showDone, onClick: () => setShowDone(v => !v) },
            (showDone ? '▾ ' : '▸ ') + '已完成 ' + settledLines.length + ' 条线'),
          showDone ? h('div', null, ...settledLines.map(lineCard)) : null
        )
      : null

    const archiveNodes = (bg.archivedCount || 0) > 0
      ? h('div', null,
          h('button', { type: 'button', className: 'ysu-sec ysu-toggle', 'aria-expanded': showArch, onClick: () => setShowArch(v => !v) },
            (showArch ? '▾ ' : '▸ ') + '已归档 ' + bg.archivedCount + ' 条（死会话/已处理）'),
          showArch && bg.archived && bg.archived.length
            ? h('div', null, ...bg.archived.map(t => entryRow({
                id: t.id, source: 'background', title: t.title, state: t.state,
                stateText: t.stateText, summary: t.error || t.result || t.step || '',
                idleMinutes: t.idleMinutes, level: t.level, stalled: t.stalled, resolved: t.resolved,
              })))
            : null)
      : null

    const activityNode = activity => !activity ? null : h('section', {
      className: 'ysu-activity', 'data-state': activity.state, 'data-tone': activity.tone,
      'aria-label': '编码纠偏状态'
    },
      h('div', { className: 'ysu-activity-title' }, activity.label),
      h('dl', null,
        h('dt', null, '依据'), h('dd', null, activity.basis),
        h('dt', null, '下一步'), h('dd', null, activity.next)),
      activity.attemptId && h('small', null, '当前实现：' + activity.attemptId),
      activity.updatedAt && h('small', null, '记录更新时间：' + activity.updatedAt),
      activity.reason && h('small', null, '读取状态：' + activity.reason),
      (activity.rows || []).length > 0 && h('details', null,
        h('summary', null, '纠偏记录（按原票据顺序）'),
        activity.hiddenRows > 0 && h('small', null, '另有 ' + activity.hiddenRows + ' 条较早记录未展示'),
        h('ol', null, ...(activity.rows || []).map(row => h('li', { key: row.id },
          h('div', null, row.label + ' · ' + row.result),
          h('small', null, row.id + ' · ' + row.source),
          (row.startedAt || row.endedAt) && h('small', null, row.startedAt && '开始：' + row.startedAt,
            row.endedAt && ' · 结束：' + row.endedAt),
          row.kind !== 'prepared' && h('small', null,
            '实际请求数：' + (row.requestCount ?? '未知') + ' · tokens：' + (row.totalTokens ?? '未知')
            + ' · 费用（USD）：' + (row.costUsd ?? '未知')),
          row.appliedFiles?.length > 0 && h('small', null, '已应用：' + row.appliedFiles.join('、')
            + (row.hiddenAppliedFiles ? '（另有 ' + row.hiddenAppliedFiles + ' 个）' : '')),
          row.reason && h('small', null, '原因代码：' + row.reason)
        ))))
    )

    const runNodes = h(data?.nativeTasks ? SessionTaskBoard : StarTaskBoard, { key:sessionId, React, sessionId, data, call, renderActivity:activityNode, refresh: () => refreshBoard.current?.() })
    const checkNodes = checks.length
      ? h('div', null,
          h('div', { className: 'ysu-sec' }, '体检'),
          ...checks.map(c => h('div', { className: 'ysu-check', key: c.id },
            h('span', { className: c.ok ? 'ysu-ok' : 'ysu-bad' }, c.ok ? '正常' : '异常'),
            h('span', null, c.label + '：' + c.detail)
          ))
        )
      : null

    const alerts = h(React.Fragment, null,
      err && h('div', { className: 'ysu-alert', role: 'alert' },
        (data ? '任务更新失败，以下保留上次结果：' : '任务读取失败：') + err),
      healthErr && h('div', { className: 'ysu-alert', role: 'alert' },
        (health ? '体检更新失败，以下保留上次结果：' : '体检暂不可用：') + healthErr));

    const empty = (!data?.nativeTasks && !err && !lines.length && !tasks.length && !(bg.done && bg.done.length))
      ? h('div', { className: 'ysu-empty' },
          data ? '还没有任务。派一个活就会出现在这里。' : '正在读…')
      : null

    return h('div', { className: 'ysu-panel', onClick: e => e.stopPropagation() },
      alerts, runNodes, needsYouNodes, fixingNodes, settledNodes, archiveNodes,
      (data || health) && h('details', null, h('summary', null, '统计与体检' + (checks.some(c => !c.ok) ? ' · ' + checks.filter(c => !c.ok).length + ' 项异常' : '')), bar, checkNodes), empty)
  }

  function labelOf(who) {
    const map = { builder: '动手', explorer: '探路', guardian: '把关', external: '外部程序', self: '自己', codex: 'codex' }
    return map[who] || who || '未知'
  }

  /* ───────── Remote 描述：必须在浏览器侧本地构造 ─────────
   * 踩过的坑（评审 B 实测）：浏览器里 `require('@yunshu/dsh-united')` 不会抛错，
   * 而是命中「本模块自己已注册的 factory」，拿回来的是 {inject, apply}，
   * 于是 `.remoteInfo` 是 undefined → $mount(undefined) → TypeError → 整个面板静默不挂。
   * 网关真正要的只有这些字段（client.browser.js: validateContribution / prepareInvocation），
   * 不需要 Zod 校验器，所以这里手写一份即可。wire 名必须和 index.mjs 的 parameter() 一致。
   */
  function makeRemoteInfo(zod) {
    const codec = (type, jsonSchema, schema) => ({
      mode: 'strict',
      typeSymbol: '@yunshu/yunshuUnited#' + type,
      create: () => schema || zod.any(),
      jsonSchema,
    })
    const param = (name, wire, jsonSchema, typeSymbol, schema) => ({
      name,
      wire,
      source: 'json',
      codec: Object.assign(codec(name, jsonSchema, schema), typeSymbol ? { typeSymbol } : {}),
    })
    return {
      package: '@yunshu/dsh-united',
      descriptors: [{
        id: '@yunshu/dsh-united#' + NAMESPACE + '/request',
        namespace: NAMESPACE,
        method: 'request',
        service: NAMESPACE,
        description: '联合体任务台操作',
        invocation: { kind: 'direct' },
        parameters: [
          param('agent', 'agentId', { type: 'string' }, '@deepseek-ai/dsh-session/types#SessionId'),
          param('action', 'action', { type: 'string' }),
          param('payload', 'payload', {}),
        ],
        cancellation: { parameter: 'signal' },
        result: codec('result', {}),
        sourceLocation: { file: 'packages/yunshu-united-plugin/client.js', line: 1, column: 1 },
      }],
    }
  }

  async function mount(ctx, info, React) {
    const disposeRemote = await ctx.remote.$mount(info)
    let ui
    try {
      ui = ctx.inject(['remote.' + NAMESPACE, 'slots'], inner => {
        const style = document.createElement('style')
        style.textContent = CSS
        document.head.append(style)

        const call = async (sessionId, action, payload, signal) => {
          const res = await inner.remote[NAMESPACE].request(sessionId, action, payload || {}, signal)
          // 网关返回的是信封 {ok,value} / {ok:false,error}，面板要的是 value
          if (!res || res.ok !== true) {
            const error = new Error((res && res.error && res.error.message) || '远程调用失败')
            error.code = res && res.error && res.error.code
            throw error
          }
          return res.value
        }

        const Root = props => {
          const h = React.createElement
          // embedded：装进 dock 抽屉时只画面板、不画按钮（输入框左侧不再多一个入口）
          const embedded = props.embedded === true
          const [open, setOpen] = React.useState(embedded)
          const [healthState, setHealthState] = React.useState('idle')
          const [label, setLabel] = React.useState('')

          // 未成功读到体检结果时保留灰灯，不能把未知状态显示成正常。
          React.useEffect(() => {
            setHealthState('idle')
            setLabel('')
            if (embedded || !props.sessionId) return
            let aborted = false
            const tick = async () => {
              try {
                const v = await call(props.sessionId, 'health', {})
                if (aborted) return
                if (!Array.isArray(v?.problems)) throw new Error('health payload missing problems')
                const n = v.problems.length
                setHealthState(n === 0 ? 'ok' : v.problems.some(p => p.level === 'high') ? 'late' : 'warn')
                setLabel(n > 0 ? '任务·' + n + ' 待修' : '任务')
              } catch {
                if (!aborted) { setHealthState('idle'); setLabel('任务·状态未知') }
              }
            }
            tick()
            const t = setInterval(tick, 10000)
            return () => { aborted = true; clearInterval(t) }
          }, [props.sessionId, embedded])

          return h('div', { className: embedded ? 'ysu-wrap ysu-embedded' : 'ysu-wrap' },
            open ? h(BoardPanel, { React, sessionId: props.sessionId, call, embedded, onClose: () => setOpen(false) }) : null,
            !embedded && h('button', {
              type: 'button',
              className: 'ysu-chip',
              'data-health': healthState,
              title: label || '任务台',
              disabled: !props.sessionId,
              'aria-expanded': open,
              onClick: () => setOpen(v => !v),
            },
              h('span', { className: 'ysu-chip-dot', 'data-s': healthState, 'aria-hidden': true }),
              h('svg', { viewBox: '0 0 24 24', width: 14, height: 14, 'aria-hidden': true },
                h('path', {
                  d: 'M4 6.5h16M4 12h16M4 17.5h10',
                  fill: 'none', stroke: 'currentColor', strokeWidth: 1.6,
                  strokeLinecap: 'round',
                })),
              h('span', null, label || '任务')
            )
          )
        }

        // Queue this panel until dock is ready; do not restore the independent button.
        const dockEntry = {
          group: 'panel', id: 'united-board', label: '任务台',
          status: () => 'unknown', describe: () => '',
          render: dockProps => React.createElement(Root, { sessionId: dockProps.sessionId, embedded: true }),
        }
        if (window.__yunshuDock?.register) {
          const dockOff = window.__yunshuDock.register(dockEntry)
          if (dockOff) inner.effect(() => () => { try { dockOff() } catch {} })
        } else {
          const queue = window.__yunshuDockQueue = window.__yunshuDockQueue || []
          queue.push(dockEntry)
          inner.effect(() => () => { const i = queue.indexOf(dockEntry); if (i !== -1) queue.splice(i, 1) })
        }

        inner.effect(() => () => { try { style.remove() } catch {} })
      })
      await ui
    } catch (error) {
      await ui?.dispose?.()
      await disposeRemote?.()
      throw error
    }
    return async () => { await ui.dispose(); await disposeRemote() }
  }

  const factory = require => {
    return {
      inject: ['remote', 'slots'],
      apply: ctx => {
        const React = require('react')
        let dispose = null
        let disposed = false
        ctx.effect(() => {
          // 本地构造 Remote 描述；不要 require 自己的包（会拿回 {inject, apply}）
          const info = makeRemoteInfo(require('zod').z || require('zod'))
          mount(ctx, info, React).then(d => {
            if (disposed) { d?.(); return }
            dispose = d
          }).catch(e => {
            console.error('[yunshu-united] 挂载失败:', e)
          })
          return () => {
            disposed = true
            try { dispose?.() } catch {}
          }
        })
      },
    }
  }

  // 幂等守卫（2026-11-12 二次修正）：这里的 id 已经是包名，正常时序只会注册一次。
  // 不要用 window 级粘性标志——HMR invalidate 之后它会永久挡住重注册，把
  // 「大声的重复注册」换成「无声的不注册」（dock 就是这样把启动搞挂的）。
  // 只吞 duplicate 这一种异常，其它错误照常抛出，不掩盖真问题。
  if (typeof window !== 'undefined' && window.__ModuleLoader__ && window.__ModuleLoader__.load) {
    try {
      window.__ModuleLoader__.load({ id: '@yunshu/dsh-united', factory })
    } catch (error) {
      const message = String(error && error.message)
      if (!/duplicate factory registration/.test(message)) throw error
      try { console.warn('[yunshu-united] duplicate registration ignored:', message) } catch { /* ignore */ }
    }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = factory
})()
