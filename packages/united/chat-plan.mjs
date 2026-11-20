import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const check=(test,message)=>{if(!test)throw Error(message);};
function text(value,max,label){
  check(typeof value==='string' && value.trim().length<=max,label+'格式或长度无效。');
  return value.trim();
}
export function uuidFor(seed){
  const b=createHash('sha256').update(seed).digest();
  b[6]=(b[6]&15)|80;b[8]=(b[8]&63)|128;
  const v=b.subarray(0,16).toString('hex');
  return [v.slice(0,8),v.slice(8,12),v.slice(12,16),v.slice(16,20),v.slice(20)].join('-');
}
function currentUser(session){
  const nodes=session.surface.nodes;
  for(let i=nodes.length-1;i>=0;i--){
    const seq=nodes[i],event=session.eventAt(seq);
    if(!session.isOwnSeq(seq) || event.type!=='user/message' || event.data.source?.kind!=='user')continue;
    check(!event.data.source.rpcId?.startsWith('ys-task:'),'这条旧版自派消息已停用，请等待用户的新指令。');
    return {id:event.data.id,seq};
  }
  throw Error('建单需要当前会话中的用户消息。');
}
function readPlan(root){
  const file=join(root,'chat-plan.json');
  return existsSync(file)?JSON.parse(readFileSync(file,'utf8')):null;
}
function savePlan(root,plan){
  mkdirSync(root,{recursive:true});
  const file=join(root,'chat-plan.json'),tmp=file+'.'+randomUUID()+'.tmp';
  writeFileSync(tmp,JSON.stringify(plan),'utf8');renameSync(tmp,file);
  return plan;
}
function fields(input){
  const goal=text(input.goal,2000,'任务目标'),acceptance=text(input.acceptance??'',2000,'验收标准');
  const target=text(input.target??'',500,'交付路径').replace(/\\/gu,'/');
  check(goal,'请写下本次任务的目标。');
  check(!target || (!/[<>:"|?*\x00-\x1f]/u.test(target) && target.split('/').every(p=>p&&!p.startsWith('.')&&!/^(?:node_modules|credentials?|secrets?)(?:\.|$)/iu.test(p))),'请填写工作区内可交付的相对文件名。');
  const raw=input.questions??[];
  check(Array.isArray(raw)&&raw.length<=6,'待澄清问题最多六个。');
  const questions=raw.map(v=>text(v,300,'待澄清问题')).filter(Boolean);
  const modules=input.modules??[];
  check(Array.isArray(modules) && modules.length<=8 && modules.every(m=>typeof m==='string' && /^[a-z][a-z0-9._-]{1,80}$/u.test(m)),'所选模块无效。');
  return {goal,acceptance,target,questions,modules:[...new Set(modules)].sort()};
}
const same=(a,b)=>a.goal===b.goal&&a.acceptance===b.acceptance&&a.target===b.target&&JSON.stringify(a.modules??[])===JSON.stringify(b.modules??[]);
export function chatPlanBridge(servicePromise){
  const working=new Map();
  const owners=new WeakMap();
  function serial(root,fn){
    const before=working.get(root)??Promise.resolve();
    const next=before.catch(()=>{}).then(fn);
    working.set(root,next);return next.finally(()=>{if(working.get(root)===next)working.delete(root);});
  }
  async function send(api,engine,agent,root,plan,signal){
    savePlan(root,plan);
    const result=await api.action(engine,agent,'create',{requestId:plan.id,goal:plan.goal,acceptance:plan.acceptance,target:plan.target,modules:plan.modules},signal);
    const saved=savePlan(root,{...plan,state:'dispatched',runId:result.id});
    return {...saved,...await api.route(engine,agent,{runId:result.id,action:'dispatch'},signal),id:saved.id};
  }
  return {
    view:readPlan,
    ownsTurn(session){
      const nodes=session.surface.nodes;
      for(let i=nodes.length-1;i>=0;i--){
        const seq=nodes[i],e=session.eventAt(seq);
        if(e.type!=='user/message' || !session.isOwnSeq(seq)) continue;
        const source=e.data.source;
        if(source?.kind==='yunshu-task-board' || source?.rpcId?.startsWith('ys-task:')) return true;
        if(source?.kind==='user')return owners.get(session)===e.data.id;
      }
      return false;
    },
    claimTurn(session){try{owners.set(session,currentUser(session).id);}catch{}},
    async fromChat(engine,agent,input,signal){
      this.claimTurn(agent.session);
      const api=await servicePromise,root=api.scope(engine,agent.session);
      return serial(root,async()=>{
        signal?.throwIfAborted();
        const user=currentUser(agent.session),p=fields(input),old=readPlan(root);
        check(['clarify','dispatch'].includes(input.stage),'需要选择澄清或派单。');
        check(!input.planId || input.planId===old?.id,'这张草案已经更换，请读取当前任务台。');
        if(old?.state==='dispatching'){
          check(same(old,p),'上次派单正在恢复，请先核对原任务。');
          return send(api,engine,agent,root,old,signal);
        }
        if(old?.state==='dispatched' && (old.sourceId===user.id || input.planId===old.id || (input.stage==='dispatch' && same(old,p) && input.newTask!==true))){
          check(same(old,p),'这张任务已经派发，请查看原票并按需纠偏。');
          const board=await api.route(engine,agent,{runId:old.runId,action:'dispatch'},signal);
          return {...old,...board,id:old.id};
        }
        if(old?.state==='manual' && (input.planId===old.id || input.newTask!==true) && input.stage==='dispatch'){
          check(same(old,p) && !p.questions.length,'这张草案已由用户修订。请用 yunshu_task_current 读取原票，按当前版本派发。');
          return send(api,engine,agent,root,{...old,state:'dispatching'},signal);
        }
        const draft=old?.state==='clarifying'?old:null;
        const awaiting=draft?.awaitingReplyTo ?? (draft?.questions.length?draft.sourceId:null);
        if(input.stage==='dispatch'){
          check(p.acceptance && !p.questions.length,'派单前要写明验收标准并解决待澄清问题。');
          check(awaiting!==user.id,'请先在主聊天听取用户对待澄清问题的答复。');
        }else if(awaiting===user.id && !p.questions.length){
          p.questions=draft.questions;
        }
        const id=draft?.id??uuidFor(agent.session.id+'\0'+user.id);
        const plan={...p,id,sourceId:user.id,sourceSeq:user.seq,revision:(draft?.revision??0)+1,
          awaitingReplyTo:input.stage==='clarify' && (!draft || p.questions.length || awaiting===user.id)?user.id:null,
          state:input.stage==='dispatch'?'dispatching':'clarifying',runId:null};
        if(input.stage==='clarify')return savePlan(root,plan);
        return send(api,engine,agent,root,plan,signal);
      });
    },
    async createEdited(engine,agent,input,signal){
      const api=await servicePromise,root=api.scope(engine,agent.session);
      return serial(root,async()=>{
        const old=readPlan(root);
        check(old?.id===input.draftId && old.revision===input.draftRevision,'主聊天已经更新了草案，请先核对最新内容。');
        check(old.state==='clarifying' || old.state==='manual','这张任务已在主聊天派发。');
        const p=fields({...input,modules:input.modules??old.modules});
        check(p.acceptance,'请填写验收标准。');
        if(old.state==='manual'){
          check(same(old,p),'这张草案已被手动采用，请在原任务中修订。');
          return {id:old.runId};
        }
        const result=await api.action(engine,agent,'create',{...p,requestId:old.id},signal);
        savePlan(root,{...old,...p,state:'manual',runId:result.id});
        return result;
      });
    }
  };
}
