import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { uuidFor } from './chat-plan.mjs';
import { roleVersion, roleView, ticketPaused, pauseTicket, runRoleFlow, approvedDelivery, linkChild, setCorrections, markReported } from './role-flow.mjs';
import { runUnited } from './task-engine/bin/task-actions-consumer.mjs';
import { readPanelLedger } from './task-engine/bin/panel-control.mjs';
import { hashFile, readReceived, reviewRefs } from './task-engine/bin/verdict-evidence.mjs';
import { reduce, diffState } from './task-engine/bin/reducer.mjs';
import { readPanelPlan } from './task-engine/bin/panel-plan.mjs';

const cli = fileURLToPath(new URL('./task-engine/bin/united.mjs',import.meta.url));
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/iu;
const runPattern = /^r-ui-[a-f0-9-]{36}$/u;
const taskPrompt = /^ys-task:(r-ui-[a-f0-9-]{36}):(m-[\w-]+):([a-f0-9-]{36})$/u;
const sha = b => createHash('sha256').update(b).digest('hex');
const json = file => JSON.parse(readFileSync(file,'utf8'));
const need = (condition,message) => { if (!condition) throw Error(message); };
function atom(file,bytes) {
  if (existsSync(file) && readFileSync(file).equals(Buffer.from(bytes))) return;
  const temp = file + '.' + randomUUID() + '.part';
  writeFileSync(temp,bytes); renameSync(temp,file);
}
function relativeFile(value) {
  if (value === '') return '';
  need(typeof value === 'string' && value.length<=500 && !isAbsolute(value) && !/[<>:"|?*\x00-\x1f]/u.test(value),'请填写工作区内的相对文件名。');
  const parts=value.replace(/\\/gu,'/').split('/');
  need(parts.every(s=>s && !s.startsWith('.') && !/^(?:node_modules|credentials?|secrets?)(?:\.|$)/iu.test(s)),'请填写工作区内可交付的文件名。');
  return parts.join('/');
}
function scope(engine,session) {
  const cwd=session?.header?.cwd;
  need(engine && typeof cwd==='string' && isAbsolute(cwd) && typeof session.id==='string','请先在工作区打开会话。');
  const key=sha(resolve(cwd)+'\0'+session.id);
  return join(engine,'sessions',key);
}
const initial=(_header,inherited)=>({inherited,turn:null,active:[],other:false,rows:{}});
function queue(s,message,status) {
  const rpc=message?.source?.kind==='user' && message.source.rpcId;
  const m=typeof rpc==='string' && taskPrompt.exec(rpc);
  if(!m) return s;
  const former=s.rows[rpc];
  if(status==='queued' && former) return s;
  const row={rpc,run:m[1],mid:m[2],status,turn:status==='running'?s.turn:null,answerSeq:null};
  return {...s,rows:{...s.rows,[rpc]:row}};
}
export function foldTaskTurn(s,e) {
  if(e.seq<s.inherited)return s;
  const d=e.data;
  if(e.type==='agent/inbox/spliced' && d.target==='next-turn')
    return (d.inserted??[]).reduce((state,msg)=>queue(state,msg,'queued'),s);
  if(e.type==='turn/start')return {...s,turn:d.turn,active:[],other:false};
  if(s.turn==null)return s;
  if(e.type==='user/message' && d.source?.kind==='user'){
    const next=queue(s,d,'running');
    return next===s?{...s,other:true}:{...next,active:[...new Set([...s.active,d.source.rpcId])]};
  }
  if(!s.active.length)return e.type==='turn/end'?{...s,turn:null}:s;
  if(d.turn===s.turn && s.active.length===1 && !s.other && ['tool/call','tool/result'].includes(e.type)){
    const key=s.active[0],row=s.rows[key],calls={...row.extCalls};
    if(e.type==='tool/call'){
      if(!/^yunshu_ext_[a-z][a-z0-9_]{1,45}$/u.test(d.name))return s;
      calls[d.callId]={seq:e.seq,step:d.step,tool:d.name};
      return {...s,rows:{...s.rows,[key]:{...row,extCalls:calls}}};
    }
    const msg=d.message,call=calls[msg?.toolCallId];
    if(!call || call.step!==d.step || msg.source?.kind!=='tool' || msg.source.callId!==msg.toolCallId ||
       e.surfaceOp!=='append' || e.sourceEventSeqs?.length!==1 || e.sourceEventSeqs[0]!==call.seq)return s;
    delete calls[msg.toolCallId];
    const result=d.meta?.yunshuExtension;
    const verified=(!msg.isError && !d.error && typeof result?.capability==='string' && Array.isArray(result.artifacts))
      ? result.artifacts.slice(0,32).filter(a=>typeof a?.path==='string' && typeof a.mime==='string' &&
          Number.isSafeInteger(a.bytes) && a.bytes>=0 && /^[a-f0-9]{64}$/u.test(a.sha256))
        .map(a=>({...a,capability:result.capability,tool:call.tool,resultSeq:e.seq,callSeq:call.seq})) : [];
    return {...s,rows:{...s.rows,[key]:{...row,extCalls:calls,artifacts:[...(row.artifacts??[]),...verified].slice(-128)}}};
  }
  if(d.turn!==s.turn || !['assistant/message','turn/end'].includes(e.type))return s;
  const rows={...s.rows};
  if(e.type==='assistant/message'){
    const blocks=d.message?.content??[];
    if(d.interrupted || blocks.some(b=>b.type==='tool-call') || !blocks.some(b=>b.type==='text' && b.text.trim()))return s;
    for(const key of s.active)rows[key]={...rows[key],answerSeq:e.seq};
    return {...s,rows};
  }
  for(const key of s.active){
    const r=rows[key];
    rows[key]={...r,status:d.reason?.kind==='completed' && !s.other && s.active.length===1 && r.answerSeq!=null?'answered':'stopped'};
  }
  return {...s,rows,turn:null,active:[],other:false};
}

function ticket(root,id) {
  need(runPattern.test(id),'任务编号无效。');
  const dir=join(root,'runs',id);
  const frames=readPanelLedger(root)?.framesOf(id);
  const goal=json(join(dir,'goal.json')), state=json(join(dir,'state.json'));
  need(frames?.[0]?.op==='new' && goal.panel?.requestId && frames[0].payload.panel?.requestId===goal.panel.requestId &&
    ['target','workflow','parentId','reviewId'].every(k=>frames[0].payload.panel[k]===goal.panel[k]) && frames[0].payload.acceptance===goal.acceptance && state.run_id===id,'任务原票不完整，请刷新后重试。');
  const original=frames[0].payload;
  need(JSON.stringify(original.panel.modules??[])===JSON.stringify(goal.panel.modules??[]),'模块清单与原工单不符。');
  need(original.goal===goal.goal && original.goal_id===goal.goal_id && original.goal_rev===goal.revision &&
    diffState(reduce(frames).state,state).length===0,'任务缓存与原始账本不一致，请先核对原票。');
  const plan=readPanelPlan(dir,frames);
  return {id,dir,frames,goal,state,target:goal.panel.target,title:plan.goal||goal.goal,steps:[...plan.steps.values()]};
}
function latest(t,role,op='dispatch'){
  return t.frames.findLast(f=>f.op===op && (op==='dispatch'?f.payload.part:f.payload.from)===role)?.payload;
}
function attemptFor(handle,session,t){
  const m=latest(t,'builder')?.message_id;
  if(!m)return null;
  return Object.values(handle.stateOf(session).rows).filter(r=>r.run===t.id && r.mid===m).at(-1);
}
function currentReceipt(t,role){
  const sent=latest(t,role),received=latest(t,role,'recv');
  return sent && received?.parent_id===sent.message_id?received:null;
}
function staleContract(t){
  const sent=t.frames.findLast(f=>f.op==='dispatch' && f.payload.part==='builder');
  return sent && t.frames.some(f=>f.op==='revise' && f.seq>sent.seq);
}
function status(t,attempt) {
  if(t.state.status==='done')return 'done';
  if(staleContract(t))return 'stale';
  if(currentReceipt(t,'builder'))return 'review';
  return attempt?.status??'ready';
}
function command(root,args,input) { return runUnited(root,args,cli,input); }
function dispatch(root,t,role,label,actionId='main-'+role+'-'+t.id) {
  const prior=latest(t,role);
  if(!prior||prior.action_id!==actionId)command(root,['dispatch','--run',t.id,'--part',role,'--objective',label,'--manual','--action-id',actionId]);
  const sent=latest(ticket(root,t.id),role);
  need(sent?.message_id,'派单未获确认。');
  return sent.message_id;
}
function receive(root,t,role,mid,kind,statement,evidence,origin){
  const prior=currentReceipt(t,role);
  if(prior){need(prior.parent_id===mid,'派单版本已变。');return prior.message_id;}
  const id='m-main-'+sha(mid+role).slice(0,20);
  const env={v:1,id,parent_id:mid,run_id:t.id,goal_id:t.state.goal_id,goal_rev:t.state.goal_rev,from:role,to:'self',
    kind,phase:role==='builder'?'execute':'review',at:new Date().toISOString(),evidence,origin,
    ...(kind==='finding'?{claim:{statement,evidence:[]}}:{statement})};
  const file=join(t.dir,'artifacts',id+'.json');
  atom(file,JSON.stringify(env,null,2)+'\n');
  command(root,['recv','--run',t.id,'--file',file,'--manual']);
  return id;
}
function actualFile(cwd,name){
  const root=realpathSync(cwd),file=realpathSync(resolve(root,relativeFile(name)));
  const rel=relative(root,file);
  need(rel && !isAbsolute(rel) && rel!=='..' && !rel.startsWith('..'+sep) && statSync(file).isFile(),'交付文件已经移出工作区。');
  return file;
}

function roleJournal(root,id,cwd) {
  const current=()=>ticket(root,id);
  return {
    assignWriter(flow) {
      dispatch(root,current(),'builder','按 Claude 规划执行 '+flow.plan.runId,'codex-'+id);
    },
    assignReviewer(flow) {
      const t=current(), proof=join(t.dir,'artifacts','codex-delivery.json');
      atom(proof,JSON.stringify(flow.evidence,null,2)+'\n');
      const refs=[{uri:proof,sha256:hashFile(proof)},...flow.evidence.files.map(f=>({uri:actualFile(cwd,f.path),sha256:f.sha256}))];
      receive(root,t,'builder',latest(t,'builder').message_id,'finding',flow.evidence.text?.slice(0,1600)||'GPT 已交回工单列明的文件。',refs,
        {kind:'codex',runId:flow.evidence.runId,sessionId:flow.evidence.sessionId,digest:flow.evidence.digest});
      dispatch(root,current(),'guardian','独立审核 GPT 交付 '+flow.evidence.digest,'claude-review-'+id);
    },
    finishReview(flow) {
      const t=current();
      if(t.state.status==='done')return;
      const passed=flow.review.decision==='approved';
      const evidence=reviewRefs(t.frames,t.dir,t.state).map(({uri,sha256})=>({uri,sha256}));
      need(evidence.length===flow.evidence.files.length+1,'原账本记录的 GPT 交付与审核范围不匹配。');
      const ack=receive(root,t,'guardian',latest(t,'guardian').message_id,passed?'ack':'decline',flow.review.summary,evidence,
        {kind:'claude-code',runId:flow.review.runId,sessionId:flow.review.sessionId,digest:flow.review.binding,issues:flow.review.issues});
      if(passed)command(root,['verdict','--run',id,'--select',ack,'--rule','Claude 已按原票验收标准独立审核同一份 GPT 交付。','--status','done']);
    }
  };
}
export async function registerSessionTasks(ctx,engineFor) {
  const handle=await ctx.sessionProjections.register({key:'yunshuTaskTurns',stateVersion:2,
    stateSchema:z.object({inherited:z.number(),turn:z.number().nullable(),active:z.array(z.string()),other:z.boolean(),rows:z.record(z.string(),z.json())}),
    init:initial,apply:foldTaskTurn});
  const toReport=new Map();
  function requireTasks() {need(ctx.get('yunshuControl')?.enabled('tasks')!==false,'任务台已关闭。');}
  function create(root,p,parent) {
    need(uuid.test(p.requestId),'创建请求编号无效。');
    const target=relativeFile(p.target??'');
    mkdirSync(join(root,'runs'),{recursive:true});
    const relationship=parent?{parentId:parent.id,reviewId:parent.review.runId}:{};
    command(root,['new','--panel-stdin'],JSON.stringify({workflow:roleVersion,requestId:p.requestId,goal:p.goal,accept:p.acceptance,target,modules:p.modules,...relationship}));
    return {id:'r-ui-'+p.requestId.toLowerCase()};
  }
  function native(t,agent) {
    const contract={acceptance:t.goal.acceptance,target:t.target,modules:t.goal.panel.modules??[]};
    if(t.goal.panel.workflow===roleVersion) return {...contract,...roleView(t)};
    const attempt=attemptFor(handle,agent.session,t),receipt=currentReceipt(t,'builder');
    return {...contract,workflow:null,phase:ticketPaused(t)?'paused':status(t,attempt),receipt:receipt?.message_id??null,
      summary:receipt?.claim_statement??'',reason:ticketPaused(t)?'用户已停止这张工单。':'旧版工单，保留原始记录。'};
  }
  function describe(engine,agent,board) {
    const root=scope(engine,agent.session);
    const tasks=board.tasks.map(row=>{
      const t=ticket(root,row.id),v=native(t,agent);
      return {...row,goal:t.title,status:v.phase,native:v};
    });
    const count=(...phases)=>tasks.filter(t=>phases.includes(t.status)).length;
    const summary={runs:tasks.length,assigned:count('ready'),working:count('planning','executing','reviewing'),
      attention:count('blocked','interrupted','changes_requested','approved'),done:count('reported','done')};
    return {...board,tasks,summary,nativeTasks:true};
  }
  async function route(engine,agent,p,signal) {
    requireTasks();
    const root=scope(engine,agent.session);
    let t=ticket(root,p.runId);
    if(ticketPaused(t))return {runId:t.id,phase:'paused',nextAction:'stop'};
    need(t.goal.panel.workflow===roleVersion,'旧版工单已归档。需要继续时，请根据用户的新要求建单。');
    need(['dispatch','resume','rework','report'].includes(p.action),'未知派单动作。');
    if(p.action==='rework') {
      const parent=roleView(t);
      need(parent.phase==='changes_requested' && parent.review?.issues?.length,'此单没有 Claude 的退回意见。');
      const requestId=uuidFor(t.id+'\0'+parent.review.runId);
      const child=create(root,{requestId,goal:t.title,acceptance:t.goal.acceptance,target:t.target,modules:t.goal.panel.modules},parent);
      linkChild(t,child.id);
      t=ticket(root,child.id);
      setCorrections(t,parent);
    } else if(t.goal.panel.parentId) {
      const parent=ticket(root,t.goal.panel.parentId),view=roleView(parent);
      if(ticketPaused(parent))return pauseTicket(t,'原单已停止。');
      need(view.childId===t.id && view.review?.runId===t.goal.panel.reviewId,'整改工单缺少原审核。');
      setCorrections(t,view);
    }
    const view=p.action==='report'?roleView(t):await runRoleFlow(t,agent,ctx.get('yunshuControl')?.taskWorkers,
      {signal,retry:p.action==='resume',journal:roleJournal(root,t.id,agent.session.header.cwd)});
    const result={id:t.id,runId:t.id,parentId:view.parentId,phase:view.phase,reason:view.reason,childId:view.childId,
      nextAction:view.phase==='changes_requested'?'rework':view.phase==='approved'?'report_to_user':'status_only'};
    if(view.phase==='changes_requested')result.review=view.review;
    if(view.phase==='approved' || p.action==='report' && view.phase==='reported') {
      result.report=approvedDelivery(t,agent.session.header.cwd);
      if(view.phase==='approved'){
        const pending=toReport.get(agent.session.id)??new Set();
        pending.add(t.id);toReport.set(agent.session.id,pending);
      }
    }
    return result;
  }
  async function action(engine,agent,name,p,signal) {
    requireTasks();signal?.throwIfAborted();
    const root=scope(engine,agent.session);
    if(name==='create')return create(root,p);
    const t=ticket(root,p.runId);
    if(name==='pause'){
      let cur=t;
      while(cur){
        const child=cur.goal.panel.workflow===roleVersion?roleView(cur).childId:null;
        pauseTicket(cur);
        cur=child?ticket(root,child):null;
      }
      return {id:t.id,phase:'paused'};
    }
    if(ticketPaused(t))return {id:t.id,phase:'paused'};
    if(t.goal.panel.workflow===roleVersion){
      const v=roleView(t);
      if(name==='revise'){
        need(v.phase==='ready' && uuid.test(p.requestId) && typeof p.goal==='string' && p.goal.trim() && p.goal.length<=2000,'仅待派单的任务可以修改目标。');
        command(root,['panel-action','--run',t.id],JSON.stringify({id:'ta-'+p.requestId,action:'edit-goal',runId:t.id,goal:p.goal.trim()}));
        return {phase:'ready'};
      }
      if(name==='notify'){
        const actions={ready:'dispatch',blocked:'resume',interrupted:'resume',changes_requested:'rework',approved:'report'};
        const next=actions[v.phase];
        need(next && uuid.test(p.requestId),'当前步骤已有负责人。');
        const messageId='ys-board-'+p.requestId;
        const queued=[...agent.inbox.nextTurn,...agent.inbox.nextStep].some(m=>m.source?.noticeId===messageId || (m.source?.kind==='yunshu-task-board' && m.source.runId===t.id));
        if(!queued){
          const content=[{type:'text',text:'用户在任务台请求'+({dispatch:'派单',resume:'接续派单',rework:'按 Claude 的退回意见重建工单',report:'汇报已审核结果'}[next])+'。请调用 yunshu_task_route，action='+next+'，runId='+t.id+'。'}];
          agent.followup(createUserMessage({source:{kind:'yunshu-task-board',runId:t.id,noticeId:messageId},content}));
        }
        return {phase:v.phase,queued:true};
      }
      if(name==='preview')return {text:[
        v.plan&&'Claude 规划\n'+v.plan.steps.join('\n'),
        v.evidence&&'GPT 交付\n'+(v.evidence.text||'')+'\n'+v.evidence.files.map(f=>f.path+'  '+f.sha256).join('\n'),
        v.evidence?.channels?.receipts.map(r=>'使用渠道　'+r.name+'\n'+r.summary).join('\n'),
        v.review&&'Claude 审核\n'+[v.review.summary,...v.review.issues].join('\n'),
        v.report&&'DeepSeek 已汇报　'+v.report.code
      ].filter(Boolean).join('\n\n')};
      throw Error('此工单由主聊天统筹，请使用任务台的派单操作。');
    }
    if(action==='preview'){
      need(['review','done'].includes(status(t,attemptFor(handle,agent.session,t))),'还没有已交回的产物。');
      const refs=reviewRefs(t.frames,t.dir,t.state);
      need(refs.length===1,'交付内容已改变或丢失，请重新核对。');
      const frame=t.frames.findLast(f=>f.op==='recv' && f.payload.from==='builder');
      const artifact=readReceived(t.dir,t.state,frame).origin?.artifact;
      if(artifact){
        const uri=actualFile(session.header.cwd,t.target);
        need(uri===refs[0].uri && artifact.sha256===refs[0].sha256,'交付物与原回执不一致。');
        return {artifact:{path:t.target,mime:artifact.mime,bytes:artifact.bytes,uri},digest:artifact.sha256,receipt:frame.payload.message_id};
      }
      const bytes=readFileSync(refs[0].uri);
      need(sha(bytes)===refs[0].sha256,'读取期间文件已变化。');
      return {text:bytes.toString('utf8'),digest:refs[0].sha256,receipt:latest(t,'builder','recv').message_id};
    }

    throw Error('旧版工单只保留历史结果。');
  }
  ctx.on('session/event',(session,e)=>{
    const ids=toReport.get(session.id);
    if(e.type!=='turn/end' || !ids)return;
    toReport.delete(session.id);
    if(e.data.reason?.kind!=='completed')return;
    const nodes=session.surface.nodes;
    for(let i=nodes.length-1;i>=0;i--){
      const seq=nodes[i],message=session.eventAt(seq);
      if(message.type!=='assistant/message' || !session.isOwnSeq(seq))continue;
      if(message.data.turn!==e.data.turn || message.data.interrupted)break;
      const blocks=message.data.message.content;
      if(blocks.some(b=>b.type==='tool-call'))break;
      const text=blocks.filter(b=>b.type==='text').map(b=>b.text).join('\n');
      for(const id of ids){
        try { markReported(ticket(scope(engineFor(),session),id),session.header.cwd,{text,seq,turn:e.data.turn}); }
        catch(err) {ctx.logger?.warn?.('云舒汇报未入账：'+err.message);}
      }
      break;
    }
  });
  return {scope,describe,action,route};
}
