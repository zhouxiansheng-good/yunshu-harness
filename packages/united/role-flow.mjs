import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { hashFile } from './task-engine/bin/verdict-evidence.mjs';

export const roleVersion = 'claude-codex-claude-v1';
const stages = {plan:'planning', execute:'executing', review:'reviewing'};
const pending = Object.values(stages);
const active = new Map();
const need = (ok,message)=>{ if (!ok) throw Error(message); };
const json = path=>JSON.parse(readFileSync(path,'utf8'));
const read = (path,fallback)=>existsSync(path)?json(path):fallback;
const now = ()=>new Date().toISOString();
const hash = value=>createHash('sha256').update(value).digest('hex');
const flowPath = t=>join(t.dir,'role-flow.json');
const pausePath = t=>join(t.dir,'paused-by-owner.json');
const lockPath = t=>join(t.dir,'role-owner.json');
const reportCode = t=>'YS-'+t.id.slice(-8).toUpperCase()+'-'+t.review.binding.slice(0,6).toUpperCase();

function save(t,flow) {
  const file=flowPath(t),temp=file+'.'+randomUUID()+'.tmp';
  writeFileSync(temp,JSON.stringify({...flow,updatedAt:now()}),{flag:'wx'});
  renameSync(temp,file);
  return flow;
}
function state(t) {
  return read(flowPath(t),{id:t.id,phase:'ready',parentId:t.goal.panel.parentId||null});
}
function live(owner) {
  if (!Number.isInteger(owner?.pid) || owner.pid<=0) return true;
  try { process.kill(owner.pid,0); return true; } catch(e) { return e.code!=='ESRCH'; }
}
function locked(t) {
  if (active.has(t.dir)) return true;
  const owner=read(lockPath(t),null);
  return owner && live(owner);
}
function claim(t) {
  const token=randomUUID();
  try { writeFileSync(lockPath(t),JSON.stringify({pid:process.pid,token}),{flag:'wx'}); }
  catch(e) { if (e.code==='EEXIST') return null; throw e; }
  return ()=>{ if (read(lockPath(t),null)?.token===token) unlinkSync(lockPath(t)); };
}
export function pauseTicket(t,reason='用户已停止此工单。') {
  try { writeFileSync(pausePath(t),JSON.stringify({runId:t.id,reason,at:now()}),{flag:'wx'}); }
  catch(e) { if (e.code!=='EEXIST') throw e; }
  active.get(t.dir)?.abort(Error(reason));
  return {id:t.id,phase:'paused',reason};
}
export function ticketPaused(t) { return existsSync(pausePath(t)); }

function checkDelivery(cwd,evidence) {
  need(evidence?.provider==='codex','缺少 GPT 执行回执。');
  const {digest,...receipt}=evidence;
  need(hash(JSON.stringify(receipt))===digest,'GPT 执行回执已变化。');
  const base=realpathSync(cwd);
  for (const file of evidence.files) {
    const path=resolve(base,file.path),rel=relative(base,path);
    need(rel && !isAbsolute(rel) && rel!=='..' && !rel.startsWith('..'+sep),'交付文件越出工作区。');
    let node=base;
    for (const component of rel.split(sep)) {
      node=join(node,component);
      need(existsSync(node) && !lstatSync(node).isSymbolicLink(),'交付文件已移走或变为链接：'+file.path);
    }
    need(hashFile(path)===file.sha256,'交付文件已变化：'+file.path);
  }
}
export function roleView(t) {
  const flow=state(t);
  const stop=read(pausePath(t),null);
  let phase=stop?'paused':flow.phase, reason=stop?.reason||flow.reason||'';
  if (pending.includes(phase) && !locked(t)) {
    phase='interrupted'; reason='上次运行中断，请核对执行回执后接续。';
  }
  return {id:t.id,workflow:roleVersion,phase,reason,parentId:flow.parentId,childId:flow.childId??null,
    stage:flow.stage??null, plan:flow.plan??null, evidence:flow.evidence??null, review:flow.review??null,
    report:flow.report??null, corrections:flow.corrections??[],receipt:flow.review?.runId??flow.evidence?.runId??null,
    canRetry:phase==='blocked' && flow.retryable===true || phase==='interrupted',
    reportCode:flow.review?.decision==='approved'?reportCode(flow):null};
}
export function approvedDelivery(t,cwd) {
  const flow=state(t);
  need(!ticketPaused(t) && ['approved','reported'].includes(flow.phase) && flow.review?.decision==='approved'
    && flow.review.binding===flow.evidence?.digest,'此工单还没有取得 Claude 对当前交付的通过意见。');
  checkDelivery(cwd,flow.evidence);
  return {code:reportCode(flow),goal:t.title,acceptance:t.goal.acceptance,delivery:flow.evidence,review:flow.review};
}
export function markReported(t,cwd,message) {
  const flow=state(t);
  if (flow.phase!=='approved' || ticketPaused(t)) return;
  const report=approvedDelivery(t,cwd);
  if (!message.text.includes(report.code)) return;
  save(t,{...flow,phase:'reported',report:{seq:message.seq,turn:message.turn,code:report.code,at:now()}});
}
export function linkChild(t,id) {
  const flow=state(t);
  need(!ticketPaused(t) && flow.phase==='changes_requested' && flow.review?.decision==='changes_requested','只有 Claude 已退回的工单可以重开。');
  need(!flow.childId || flow.childId===id,'此审核已有关联的整改工单。');
  if (!flow.childId) save(t,{...flow,childId:id});
}
export function setCorrections(t,parent) {
  const flow=state(t);
  need(t.goal.panel.parentId===parent.id && parent.review?.runId===t.goal.panel.reviewId,'整改工单与原审核意见不匹配。');
  if (flow.phase==='ready' && !flow.corrections) save(t,{...flow,corrections:[parent.review.summary,...parent.review.issues]});
}

export async function runRoleFlow(t,agent,workers,{signal,retry=false,journal}={}) {
  const previous=roleView(t);
  if (previous.phase==='paused' || previous.phase==='reported' || previous.phase==='approved' || previous.phase==='changes_requested') return previous;
  if (pending.includes(previous.phase) || (['blocked','interrupted'].includes(previous.phase) && !retry)) return previous;
  if (previous.phase==='blocked' && !previous.canRetry) return previous;
  if (previous.phase==='interrupted') {
    if (locked(t)) return roleView(t);
    // Only an explicit resume may inspect/retire an abandoned stage. A writer with
    // unknown outcome must supply its existing native receipt before we continue.
    if (existsSync(lockPath(t))) renameSync(lockPath(t),join(t.dir,'abandoned-'+randomUUID()+'.json'));
  }
  const release=claim(t);
  if (!release) return roleView(t);
  const controller=new AbortController();
  active.set(t.dir,controller);
  const onAbort=()=>pauseTicket(t,'主聊天已停止，此工单已暂停。');
  signal?.addEventListener('abort',onAbort,{once:true});
  const watch=setInterval(()=>{ if (ticketPaused(t)) controller.abort(); },800);
  watch.unref?.();
  let flow=state(t);
  const cwd=agent.session.header.cwd;
  try {
    if (signal?.aborted) onAbort();
    controller.signal.throwIfAborted();
    if (!workers && !flow.review) throw Error('请在云舒启用编码协作并连接 Claude Code 和 Codex。');
    // Preflight is purely local. A missing channel does not spend another worker's run.
    if (!flow.review) workers.preflight(flow.evidence?'review':null);
    for (const stage of ['plan','execute','review']) {
      if (stage==='plan' && flow.plan || stage==='execute' && flow.evidence || stage==='review' && flow.review) continue;
      if (stage==='execute') journal.assignWriter(flow);
      if (stage==='review') { checkDelivery(cwd,flow.evidence); journal.assignReviewer(flow); }
      controller.signal.throwIfAborted();
      const recovering = stage==='execute' && flow.writerStarted===true;
      flow=save(t,{...flow,stage,phase:stages[stage],reason:null,retryable:false,...(stage==='execute'?{writerStarted:true}:{})});
      const input={...flow,id:t.id,goal:t.title,target:t.target,acceptance:t.goal.acceptance,modules:t.goal.panel.modules??[],recovering};
      const receipt=await workers.run(agent,stage,input,controller.signal);
      controller.signal.throwIfAborted();
      if (ticketPaused(t)) return roleView(t);
      need(receipt?.runId && receipt.sessionId && receipt.provider===(stage==='execute'?'codex':'claude'),'执行器身份或原生回执缺失。');
      if (stage==='plan') {
        need(Array.isArray(receipt.steps) && receipt.steps.length && Array.isArray(receipt.files),'规划回执缺少步骤或交付范围。');
        flow=save(t,{...flow,plan:receipt});
      } else if (stage==='execute') {
        checkDelivery(cwd,receipt);
        flow=save(t,{...flow,evidence:receipt});
      } else {
        need(receipt.sessionId!==flow.plan.sessionId && receipt.binding===flow.evidence.digest &&
          ['approved','changes_requested'].includes(receipt.decision),'审核回执与当前交付不一致。');
        checkDelivery(cwd,flow.evidence);
        need(!(receipt.decision==='approved' && flow.evidence.missing?.length),'GPT 尚有缺失的交付文件，请 Claude 明确退回整改。');
        flow=save(t,{...flow,review:receipt});
      }
    }
    checkDelivery(cwd,flow.evidence);
    journal.finishReview(flow);
    flow=save(t,{...flow,phase:flow.review.decision,reason:null});
  } catch(e) {
    if (!ticketPaused(t)) {
      const reason=workers?.explain?.(e)??String(e.message||e).slice(0,300);
      save(t,{...flow,phase:'blocked',reason,retryable:true});
    }
  } finally {
    clearInterval(watch);signal?.removeEventListener('abort',onAbort);
    active.delete(t.dir);release();
  }
  return roleView(t);
}

