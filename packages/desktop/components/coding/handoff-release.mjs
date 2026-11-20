/** Opt-in isolation-host policy for one frozen handoff contract. No sender, provider or independent ticket store. */
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {lstatSync,readFileSync,realpathSync} from 'node:fs';
import {basename,dirname,join} from 'node:path';
import {isDeepStrictEqual as same} from 'node:util';
import {receipts as wireReceipts} from './handoff-wire.mjs';
import {readVerificationReceipt} from './verification-process.mjs';
export const kind='handoff-wasi-v1', names=['records.py','handoff.py'];
export const acceptance='按原票验证记录归并；更正导出版本后独立验证两份文件。允许显式提升到本隔离工作区、交回一次，再由父任务裁决。';
const goalHash='446b048a7a82586c05955ec6a3fd7e77fb596767c5adeafafc8c279508528058';
const changeHash='9094510cacafc599717e76cb55e4e0b76f07b63510aebc22eec1fcd3849d6a2f';
const freeze='3ff3700e3888b52eb7f566d5ba7036547ca2c970b5b62c823e9fb8b5c0479a37';
export const sha=v=>createHash('sha256').update(v).digest('hex');
const sum=v=>sha(JSON.stringify(v));
function need(v,reason){if(!v)throw Error('handoff-'+reason);}
const deps=['handoff-release-check.py','quality-pilot-b-grade.py','wasi_pilot_supervisor.py','quality-wasi-guest.py','prepare_wasi_pilot.py'];
function file(p,limit){const st=lstatSync(p);need(realpathSync(p)===p&&st.isFile()&&st.nlink===1&&st.size<=limit,'file-not-regular');return readFileSync(p);}
export function hostPolicy(cfg,co,wire=null){
  if(!cfg)return null;
  need(co.enabled&&co.united&&/^r-\d{14}-[a-f0-9]{4}_m-[a-f0-9]{10}$/.test(cfg.ticketId)&&co.allowedRoots.length===1&&co.allowedRoots[0]===cfg.cwd,'host-config');
  need(realpathSync(cfg.python)===cfg.python&&realpathSync(cfg.checker)===cfg.checker&&basename(cfg.checker)==='handoff-release-check.py'&&Array.isArray(cfg.digests)&&cfg.digests.length===deps.length,'controller-config');
  // A verifier must not be supplied by the staged writer. The caller installs its controller out of band.
  for(const p of [cfg.python,dirname(cfg.checker)])for(const root of [cfg.cwd,co.stateDir]){const a=p.toLowerCase(),b=root.toLowerCase();need(a!==b&&!a.startsWith(b+'\\'),'controller-in-writer-scope');}
  for(const [i,n] of deps.entries())need(sha(file(join(dirname(cfg.checker),n),256*1024))===cfg.digests[i],'controller-drift');
  return Object.freeze({ticketId:cfg.ticketId,cwd:cfg.cwd,python:cfg.python,checker:cfg.checker,...(wire?{wireTag:wire.tag,provider:wire.provider}:{}),policyHash:sum([kind,cfg.ticketId,cfg.cwd,cfg.python,cfg.checker,cfg.digests,...(wire?[wire.tag]:[])])});
}
export function marked(t){return t?.handoffPolicy!=null||t?.contractSnapshot?.deliverable===kind;}
export function assignment(co,id){
  const [run,msg]=id.split('_'),u=co.united;
  const q=spawnSync(process.execPath,[u.cli,'rebuild','--verify','--json','--handoff-message',msg,'--run',run],{encoding:'utf8',timeout:8000,windowsHide:true,maxBuffer:128*1024,env:{...process.env,UNITED_RUNS_DIR:u.runs,UNITED_LEDGER:join(u.root,'ledger.ndjson'),UNITED_LEDGER_V2:join(u.root,'ledger-v2.ndjson')}});
  need(q.status===0,'parent-unverified');const d=JSON.parse(q.stdout),p=d.handoff_contract;
  need(d.verdict==='VERIFIED'&&p?.schema===1&&p.enrollmentSha256===sum({stateDir:co.stateDir,cwd:co.allowedRoots[0]})&&p.runId===run&&p.messageId===msg&&p.goalRev===1&&p.objectiveSha256===goalHash&&p.goalSha256===goalHash&&p.acceptanceSha256===sha(acceptance),'parent-contract');
  return p;
}
export function admit(co,h,args){
  need(h&&h.ticketId===args.ticketId&&h.cwd===args.cwd&&args.deliverable===kind&&same(args.expectedFiles,names)&&args.workspaceMode==='git-worktree'&&args.unitedRunId+'_'+args.unitedMessageId===h.ticketId&&args.acceptance===acceptance&&sha(String(args.goal))===goalHash,'admission');
  need(args.checkProgram===undefined&&args.checkArgs===undefined&&(args.provider??'codex')===(h.provider??'codex'),'caller-command-or-provider');
  const p=assignment(co,h.ticketId);
  need(args.resume===true?p.planRev===1&&p.revisions===1&&p.changeSha256===changeHash&&sha(String(args.followup))===changeHash:p.planRev===null&&p.revisions===0,'implementation-revision');
}
export const argv=h=>['-I','-B','-X','utf8',h.checker];
export function keyFor(co,h,t){
  need(h&&h.ticketId===t.ticketId&&t.cwd===h.cwd&&t.handoffPolicy===h.policyHash&&t.contractSnapshot?.deliverable===kind&&sum(t.contractSnapshot)===t.contractHash&&t.checkProgram===h.python&&same(t.checkArgs,argv(h))&&same(t.files,names),'policy-or-contract');
  const p=assignment(co,t.ticketId),task=co.united.task(p.runId,p.messageId);
  need(p.planRev===1&&p.revisions===1&&p.changeSha256===changeHash&&task.state.plan_rev===1&&task.envelope.task.objective===t.contractSnapshot.goal&&task.envelope.task.acceptance===acceptance,'current-revision');
  need((task.pending.status==='pending' && task.state.status==='running' && Date.parse(task.pending.deadline_at)>Date.now()) || (task.pending.status==='settled' && ['running','done'].includes(task.state.status)),'inactive-assignment');
  const first=t.runs[0],last=t.runs.at(-1),bi=last.businessInput;
  need(first!==last&&first.attemptId===t.ticketId&&first.outcomeKnown===true&&first.status==='completed'&&first.businessInput?.planRev===null&&first.businessInput?.followupSha256===null&&first.after['handoff.py']===null&&first.after['records.py']===last.after['records.py']&&first.businessInput.envelopeSha256===sum(task.envelope),'producer-not-retained');
  need(last.kind==='implement'&&last.attemptId===t.lastImplementationAttemptId&&last.outcomeKnown===true&&last.status==='completed'&&!last.cancellationRequested&&bi?.goalRev===p.goalRev&&bi?.planRev===p.planRev&&bi.followupSha256===p.changeSha256&&bi.envelopeSha256===sum(task.envelope),'attempt-revision');
  for(const [r,initial] of [[first,true],[last,false]]){
    const text=r.businessInput?.adapterText;need(typeof text==='string'&&sha(text)===r.businessInput.promptSha256,'adapter-text');
    if(initial)need(text.startsWith('Goal: '+t.contractSnapshot.goal+'\n\nObservable deliverable: '+kind+'\n\n'),'initial-prompt');
    else {const prefix=(h.wireTag?'Continue the same original ticket ':'Continue the same native session and unchanged ticket ')+t.ticketId+'. Apply this correction: ',end=text.indexOf('\n\nAllowed files (relative to workspace):');need(text.startsWith(prefix)&&end>prefix.length&&sha(text.slice(prefix.length,end))===changeHash,'amendment-text');}
  }
  const stage=join(co.stateDir,'stages',t.ticketId);need(t.stage?.path===stage&&realpathSync(stage)===stage,'stage');
  const files=Object.fromEntries(names.map(n=>[n,sha(file(join(stage,n),32768))]));need(same(files,last.after),'stage-drift');
  return {schema:1,kind,...(h.wireTag?{wireReceipts:wireReceipts(co.stateDir,t,h.wireTag)}:{}),ticketId:t.ticketId,attemptId:last.attemptId,contractHash:t.contractHash,policyHash:h.policyHash,parent:p,envelopeSha256:bi.envelopeSha256,adapterPromptSha256:bi.promptSha256,producerPromptSha256:first.businessInput.promptSha256,files};
}
export function witness(key,checkId){return sum({checkId,key});}
export function qualify(co,h,t,checkMeta){
  const key=keyFor(co,h,t),v=checkMeta,proof=readVerificationReceipt(co.stateDir,v.container),challenge=witness(key,v.checkId);
  need(v.status==='target-files-and-test-passed'&&v.checkId===v.container.checkId&&v.attemptId===key.attemptId&&same(v.observedTargets,key.files)&&proof.rootExitCode===0&&proof.reason==='completed'&&proof.terminalVerified&&proof.activeProcesses===0&&proof.receiptSha256===v.processReceipt.sha256,'native-receipt');
  const dir=join(co.stateDir,'verification-checks',v.checkId),req=JSON.parse(file(join(dir,'request.json'),65536));
  need(req.checkId===v.checkId&&req.program===h.python&&req.cwd===t.stage.path&&req.environmentPolicy==='fresh-no-injection-v1'&&same(req.args,[...argv(h),'--witness',challenge]),'command-binding');
  const bytes=file(join(dir,'stdout.log'),32*1024),o=JSON.parse(bytes);need(proof.outputFiles?.['stdout.log']?.sha256===sha(bytes)&&o.schema===1&&o.challenge===challenge,'score-binding');
  const m=o.measurement,labels=['scrambled','foreign','withdrawn','empty','revived'].flatMap(s=>['producer/'+s,'consumer/'+s]).concat('delegates-to-producer');
  need(m?.schema===1&&m.phase==='amended'&&m.contractFreeze===freeze&&m.passed===true&&m.releaseAuthority===false&&same(m.files,key.files)&&same(Object.keys(m.checks).sort(),[...labels].sort())&&labels.every(k=>m.checks[k]===true)&&same(m.runs.map(r=>r.label),labels)&&m.runs.every(r=>r.reason==='exit'&&r.exitCode===0&&r.jsonDecoded===true),'behavioral-score');
  const body={key,checkId:v.checkId,nativeReceipt:proof.receiptSha256,scoreSha256:sha(bytes),checks:labels.length};return {...body,receiptSha256:sum(body)};
}
export function requireQualification(co,h,t){const r=qualify(co,h,t,t.verification);need(same(r,t.verification.handoff),'receipt-invalid');return r;}
