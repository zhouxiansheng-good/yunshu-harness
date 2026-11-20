import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
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
    frames[0].payload.panel.target===goal.panel.target && frames[0].payload.acceptance===goal.acceptance && state.run_id===id,'任务原票不完整，请刷新后重试。');
  const original=frames[0].payload;
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
function verifyTextFile(cwd,name,receipt){
  const file=actualFile(cwd,name);
  need(statSync(file).size<=2*1024*1024,'这份文件超过可核对的文本大小。');
  const bytes=readFileSync(file);
  need(sha(bytes.toString('utf8').replace(/\r\n/gu,'\n').replace(/\n$/u,''))===receipt.hash,'文件已改变，请回到主聊天重新执行并读回。');
  return {uri:file,sha256:sha(bytes)};
}

export async function registerSessionTasks(ctx, engineFor) {
  const handle=await ctx.sessionProjections.register({key:'yunshuTaskTurns',stateVersion:2,
    stateSchema:z.object({inherited:z.number(),turn:z.number().nullable(),active:z.array(z.string()),other:z.boolean(),rows:z.record(z.string(),z.json())}),
    init:initial,apply:foldTaskTurn});
  const inflight=new Map();
  function describe(engine,agent,board) {
    const root=scope(engine,agent.session);
    const tasks=board.tasks.map(row=>{
      const t=ticket(root,row.id),attempt=attemptFor(handle,agent.session,t);
      const evidence=currentReceipt(t,'builder');
      return {...row,goal:t.title,native:{phase:status(t,attempt),acceptance:t.goal.acceptance,target:t.target,answerSeq:attempt?.answerSeq??null,
        receipt:evidence?.message_id??null,summary:evidence?.claim_statement??'',turn:attempt?.turn??null}};
    });
    return {...board,tasks,nativeTasks:true};
  }
  async function doAction(root,agent,action,p,signal) {
    const session=agent.session;
    if(action==='create'){
      need(uuid.test(p.requestId),'创建请求编号无效。');
      const target=relativeFile(p.target??'');
      mkdirSync(join(root,'runs'),{recursive:true});
      command(root,['new','--panel-stdin'],JSON.stringify({requestId:p.requestId,goal:p.goal,accept:p.acceptance,target}));
      return {id:'r-ui-'+p.requestId.toLowerCase()};
    }
    let t=ticket(root,p.runId);
    let attempt=attemptFor(handle,session,t);
    let phase=status(t,attempt);
    if(action==='revise'){
      need(phase!=='done' && !['queued','running'].includes(phase) && uuid.test(p.requestId) && typeof p.goal==='string' && p.goal.trim() && p.goal.length<=2000,'当前任务暂不可修订。');
      const sent=latest(t,'builder');
      if(sent && !currentReceipt(t,'builder') && !staleContract(t)){
        receive(root,t,'builder',sent.message_id,'decline','用户修订任务，原派单已退回。',[],{kind:'user-revision',sessionId:session.id});
      }
      command(root,['panel-action','--run',t.id],JSON.stringify({id:'ta-'+p.requestId,action:'edit-goal',runId:t.id,goal:p.goal.trim()}));
      return {phase:'ready'};
    }
    if(action==='start' || action==='redo'){
      need(uuid.test(p.requestId),'执行请求编号无效。');
      if(!['ready','stopped','answered','review','stale'].includes(phase))return {phase};
      const old=latest(t,'builder');
      const repeated=Object.values(handle.stateOf(session).rows).find(row=>row.run===t.id && row.rpc.endsWith(':'+p.requestId.toLowerCase()));
      if(repeated)return {phase:repeated.status};
      const needsNew=!!old && (currentReceipt(t,'builder')||staleContract(t));
      if(needsNew && !currentReceipt(t,'builder'))receive(root,t,'builder',old.message_id,'decline','原任务版本已更新。',[],{kind:'superseded'});
      const mid=old && !needsNew?old.message_id:dispatch(root,t,'builder',
        (needsNew?'按当前版本重新执行（'+(t.frames.filter(f=>f.op==='dispatch').length+1)+'）：':'执行当前任务：')+t.title,
        'main-builder-'+p.requestId);
      const rpc='ys-task:'+t.id+':'+mid+':'+p.requestId.toLowerCase();
      if(handle.stateOf(session).rows[rpc])return {phase:handle.stateOf(session).rows[rpc].status};
      const wording=['请执行任务台上的这项工作。',t.title,...t.steps,'验收标准：'+t.goal.acceptance,
        t.target?'交付文件：'+t.target+'。在当前工作区生成指定文件。普通文本用文件工具完整读回，图片、音频或视频等可使用已接入的扩展交回文件回执。':'交付形式：在此会话给出可验收的完整答复。'].join('\n');
      await ctx.sessionController.prompt({sessionId:session.id,requestId:rpc,mode:'followup',content:[{type:'text',text:wording}]},signal??new AbortController().signal);
      return {phase:'queued'};
    }
    if(action==='collect'){
      if(phase==='review'||phase==='done')return {phase};
      need(phase==='answered' && attempt.answerSeq!=null,'本任务还没有可交回的完整答复。');
      const {target:e}=await ctx.sessionQuery.readEvent({sessionId:session.id,seq:attempt.answerSeq,before:0,after:0},signal);
      need(e.type==='assistant/message' && e.data.turn===attempt.turn && !e.data.interrupted,'会话原始答复不匹配。');
      const body=e.data.message.content.filter(b=>b.type==='text').map(b=>b.text).join('\n');
      need(body.trim(),'原回合没有可见答复。');
      const origin={kind:'main-chat',sessionId:session.id,turn:attempt.turn,seq:e.seq,requestId:attempt.rpc};
      let proof;
      if(t.target){
        const artifact=attempt.artifacts?.findLast(a=>a.path===t.target);
        if(artifact){
          const uri=actualFile(session.header.cwd,t.target);
          need(statSync(uri).size===artifact.bytes && hashFile(uri)===artifact.sha256,'扩展交回的文件已改变，请重新执行。');
          origin.artifact=artifact;proof={uri,sha256:artifact.sha256};
        }else{
          const v=ctx.sessionProjections.snapshot(session,['yunshuFileReceipts']).values.yunshuFileReceipts;
          const receipt=v?.turns?.[String(attempt.turn)]?.files.find(f=>f.verification==='matched' && f.relative===t.target);
          need(receipt,'这轮没有完整核对指定的交付文件。可以重新执行，再收取产物。');
          proof=verifyTextFile(session.header.cwd,t.target,receipt);
        }
      }else{
        const file=join(t.dir,'artifacts','answer-'+e.seq+'.md');atom(file,body);proof={uri:file,sha256:sha(Buffer.from(body))};
      }
      receive(root,t,'builder',attempt.mid,'finding',body.slice(0,1600),[proof],origin);
      return {phase:'review'};
    }
    if(action==='preview'){
      need(phase==='review'||phase==='done','还没有已交回的产物。');
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
    if(action==='accept'){
      if(phase==='done')return {phase};
      need(phase==='review' && p.reviewed===true && typeof p.receipt==='string' && p.receipt===latest(t,'builder','recv')?.message_id,'请先核对当前版本的交付物。');
      const evidence=reviewRefs(t.frames,t.dir,t.state);
      need(evidence.length===1 && evidence[0].sha256===p.digest,'交付物已改变或丢失，暂不能验收。');
      const mid=dispatch(root,t,'guardian','由用户核对交付版本 '+p.receipt+'：'+t.goal.acceptance,'main-guardian-'+p.receipt);
      t=ticket(root,t.id);
      const verified=reviewRefs(t.frames,t.dir,t.state);
      need(verified.length && JSON.stringify(verified)===JSON.stringify(evidence),'验收期间文件已变更。');
      const ack=receive(root,t,'guardian',mid,'ack','用户按原验收标准核对并通过。',verified.map(({uri,sha256})=>({uri,sha256})),
        {kind:'user-review',sessionId:session.id,receipt:p.receipt});
      command(root,['verdict','--run',t.id,'--select',ack,'--rule','用户在原会话核对完整交付物并确认符合原验收标准。','--status','done']);
      return {phase:'done'};
    }
    throw Error('不支持的会话任务操作。');
  }
  const api={scope,describe,async action(engine,agent,action,p,signal){
    need(ctx.get?.('yunshuControl')?.enabled('tasks')!==false,'任务台已关闭。');
    const root=scope(engine,agent.session),key=root+'\0'+(p.runId??p.requestId);
    const former=inflight.get(key)??Promise.resolve();
    const next=former.catch(()=>{}).then(()=>doAction(root,agent,action,p,signal));
    inflight.set(key,next);
    try{return await next;}finally{if(inflight.get(key)===next)inflight.delete(key);}
  }};
  ctx.on('session/event',(session,e)=>{
    if(e.type!=='turn/end' || ctx.get?.('yunshuControl')?.enabled('tasks')===false)return;
    queueMicrotask(()=>{
      const rows=Object.values(handle.stateOf(session).rows).filter(r=>r.turn===e.data.turn && r.status==='answered');
      for(const r of rows) void api.action(engineFor(),{session},'collect',{runId:r.run}).catch(()=>{});
    });
  });
  return api;
}
