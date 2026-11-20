/** Only the fixed data contract in a catalog-approved loopback host. No user-selected grader/CLI. */
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {lstatSync,mkdirSync,realpathSync,readdirSync,writeFileSync,renameSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {isDeepStrictEqual as same} from 'node:util';
import {approvedInitialAssignment,inspectOriginalTicket} from './initial-ticket.mjs';
import {loadInitialCandidate} from './initial-candidate.mjs';
import {readDiagnosisSource} from './diagnosis-input.mjs';
import {publishCodingFinding} from './united-bridge.mjs';
import {objective,acceptance,assessRankTicket} from './rank-grader/quality-stage-assessment.mjs';
const kind='rank-list-v1',names=['candidate.json','order.txt'];
const hash=x=>createHash('sha256').update(x).digest('hex'),sum=x=>hash(JSON.stringify(x));
const contractSha256=hash(objective+'\n\n验收：'+acceptance);
function need(ok,why){if(!ok)throw Error('rank-'+why);}
function file(path){const s=lstatSync(path,{throwIfNoEntry:false});if(!s)return null;
  need(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1,'not-single-regular-file');return readDiagnosisSource(path,32768);}
// Require a matching parent CLI and ledger projection. In particular, a revise frame may
// have committed immediately before its process died without updating state.json.
function authoritative(co,link){
  const u=co.united,result=spawnSync(process.execPath,[u.cli,'rebuild','--verify','--json','--rank-contract','--run',link.runId],
    {encoding:'utf8',windowsHide:true,timeout:8000,maxBuffer:128*1024,env:{...process.env,UNITED_RUNS_DIR:u.runs,UNITED_LEDGER:join(u.root,'ledger.ndjson'),UNITED_LEDGER_V2:join(u.root,'ledger-v2.ndjson')}});
  need(result.status===0,'parent-projection-not-verified');const a=JSON.parse(result.stdout);
  need(a.verdict==='VERIFIED'&&a.run_id===link.runId&&same(a.rank_contract,{version:1,goal_rev:link.goalRev,plan_rev:null,revisions:0}),'parent-contract-not-current');
}
export function dispatchRank(co,host,args){
  const {ticketId:id}=args,{row,manifest}=approvedInitialAssignment(co,host,id);
  const expected={ticketId:id,unitedRunId:row.runId,unitedMessageId:row.messageId,cwd:row.workspace,
    goal:objective,acceptance,deliverable:kind,expectedFiles:names};
  need(same(args,expected),'dispatch-arguments-differ');
  return inspectOriginalTicket(co,host,id,({binding,files})=>{
    need(manifest.contractSha256===contractSha256 && same(files,names) && binding.planRev===undefined,'contract-or-revision-differs');
    authoritative(co,binding.united);return {kind,planRev:null};
  });
}
// Recompute identity and every final file from the host's frozen manifest and the published response.
// After promotion the source no longer equals its preimage. Do not pretend it is still a fresh attempt.
function identity(co,host,id,settledOK){
  co.assertMutationOwner(id);
  const {row,manifest}=approvedInitialAssignment(co,host,id),task=co.united.task(row.runId,row.messageId),{state,pending,envelope}=task;
  const r=co.readTicket(id),p=r?.initialProbe,b=p?.binding;
  need(same(r?.rankAdmission,{kind,planRev:null}) && r.ticketId===id && p.phase==='observed' && p.providerOutcomeKnown===true && p.requestCount===1 && b.generation===1,'published-admission-required');
  need(state.plan_rev===null && (b.planRev??null)===null && !state.revisions && state._watch?.verdict!=='STALE' && !Object.values(state.pending).some(v=>v.status==='outcome_unknown'),'business-revision-changed');
  const link={runId:row.runId,messageId:row.messageId,goalId:envelope.goal_id,goalRev:envelope.goal_rev,part:'builder',phase:envelope.phase};
  need(pending.part==='builder' && envelope.execution_mode==='manual' && envelope.task.objective===objective && envelope.task.acceptance===acceptance &&
    ((pending.status==='pending' && ['open','running'].includes(state.status) && Date.parse(pending.deadline_at)>Date.now()) || (settledOK&&pending.status==='settled'&&['running','done'].includes(state.status))),'assignment-no-longer-current');
  need(same(r.united,link)&&same(b.united,link)&&b.attemptId===id&&b.ticketId===id&&r.runs?.length===1&&r.runs[0].attemptId===id&&r.runs[0].outcomeKnown===true&&r.provider==='loopback-fixture','original-attempt-mismatch');
  need(sum(envelope)===row.envelopeSha256 && b.envelopeSha256===row.envelopeSha256 && b.catalogSha256===host.catalogSha256 && b.manifestSha256===row.manifestSha256 && manifest.contractSha256===contractSha256,'authority-mismatch');
  const cwd=co.resolveWorkspace(row.workspace,{});need(cwd===realpathSync(cwd)&&cwd===row.workspace&&r.cwd===cwd&&b.cwd===cwd&&same(r.files,names)&&same(manifest.files.map(f=>f.name),names),'target-mismatch');
  const candidate=loadInitialCandidate(co.stateDir,b,manifest,p),repls=new Map(candidate.replacements.map(v=>[v.name,hash(v.text)]));
  const base=Object.fromEntries(manifest.files.map(f=>[f.name,f.sha256])),files=Object.fromEntries(names.map(n=>[n,repls.get(n)??base[n]]));
  const key={kind,ticketId:id,attemptId:id,generation:b.generation,united:link,planRev:null,contractSha256,manifestSha256:b.manifestSha256,requestSha256:b.requestSha256,candidateSha256:p.candidateSha256,responseSha256:p.responseSha256,files};
  authoritative(co,link);return {r,key,base,cwd,task};
}
function checked(dir,expected){need(realpathSync(dir)===dir,'directory-changed');const result={};
  for(const n of names){const v=file(join(dir,n));need((v?.sha256??null)===expected[n],'file-changed:'+n);result[n]=v;}
  return result;
}
function receiptOK(receipt,key){if(!receipt)return false;const {checkId,...body}=receipt;
  return checkId===sum(body)&&same(body.key,key)&&body.result==='passed'&&body.measurement?.passed===true&&same(body.measurement.files,key.files)&&
    same(body.measurement.proofs?.map(p=>[p.role,p.passed,p.readSha256]),[['judge',true,key.files[names[0]]],['role_export_judge',true,key.files[names[1]]]]);}
function stageDir(co,key){return join(co.stateDir,'initial-text-stages',key.ticketId+'.'+key.candidateSha256);}
function replaceFile(dst,text){const temp=dst+'.'+randomUUID()+'.rank-new';writeFileSync(temp,text,{flag:'wx'});
  try{renameSync(temp,dst);}finally{if(lstatSync(temp,{throwIfNoEntry:false}))unlinkSync(temp);}}
export async function rankStep(co,host,id,op,save,signal){
  signal?.throwIfAborted();const now=()=>identity(co,host,id,op==='submit'||op==='promote');
  const {r,key,base,cwd,task}=now(),current=r.rankDelivery,receipt=current?.receipt;
  const answer=(name,v,extras={})=>({ticketId:id,[name]:v,...extras});
  if(op==='verify'&&!current){
    const result=await assessRankTicket(co,id);signal?.throwIfAborted();need(same(now().key,key),'changed-during-grading');
    if(result.status==='held')return answer('verified',false,{reason:result.reason});
    need(result.requestSha256===key.requestSha256&&result.candidateSha256===key.candidateSha256&&same(result.measurement.files,key.files),'measurement-mismatch');
    const body={key,result:result.status,measurement:result.measurement},receipt={...body,checkId:sum(body)};
    if(body.result==='passed')need(receiptOK(receipt,key),'invalid-proof');
    save({phase:body.result==='passed'?'verified':'failed',receipt});return answer('verified',body.result==='passed',{checkId:receipt.checkId,reason:result.measurement.reason});
  }
  need(receiptOK(receipt,key),'current-passing-receipt-required');
  need(current.phase!=='applying','partial-promotion-reconcile');
  if(op==='verify'){need(current.phase==='verified','not-at-verification-stage');checked(cwd,base);checked(stageDir(co,key),key.files);return answer('verified',true,{checkId:receipt.checkId,alreadyVerified:true});}
  if(op==='promote'&&current.phase==='verified'){
    const dir=stageDir(co,key);need(same(readdirSync(dir).sort(),names),'stage-inventory-changed');const data=checked(dir,key.files);
    const originals=checked(cwd,base);need(same(now().key,key),'changed-before-promotion');
    // A crash between two atomic renames leaves an explicit non-replayable state, not an inferred success.
    const backupDir=join(co.stateDir,'rank-preimages');mkdirSync(backupDir,{recursive:true});need(realpathSync(backupDir)===backupDir,'preimage-directory-invalid');
    const backupPath=join(backupDir,id+'.json'),preimage=JSON.stringify({checkId:receipt.checkId,files:Object.fromEntries(names.map(n=>[n,originals[n]?.text??null]))});
    writeFileSync(backupPath,preimage,{flag:'wx',flush:true});const backup={sha256:hash(preimage),path:backupPath};
    save({phase:'applying',receipt,backup});
    for(const n of names){if(key.files[n]===base[n])continue;need((file(join(cwd,n))?.sha256??null)===base[n],'base-changed:'+n);replaceFile(join(cwd,n),data[n].text);}
    checked(cwd,key.files);need(same(now().key,key),'changed-during-promotion');
    save({phase:'promoted',receipt,backup,promotedAt:new Date().toISOString()});return answer('promoted',true,{checkId:receipt.checkId});
  }
  need(current.phase==='promoted','explicit-promotion-required');checked(cwd,key.files);
  if(op==='promote')return answer('promoted',false,{reason:'already-promoted',checkId:receipt.checkId});
  const receiptId='m-'+hash('coding:'+id).slice(0,10),statement='固定数据合同双读通过：'+receipt.checkId;
  const evidence=names.map(n=>({uri:'artifact://'+join(cwd,n),sha256:key.files[n]}));
  // The ticket is immutable after this promotion. Include it as evidence, not as another task ledger.
  evidence.push({uri:'artifact://'+co.ticketPath(id),sha256:readDiagnosisSource(co.ticketPath(id),256*1024).sha256});
  const l=key.united,reply={v:1,id:receiptId,parent_id:l.messageId,run_id:l.runId,goal_id:l.goalId,goal_rev:l.goalRev,from:'builder',to:'self',kind:'finding',phase:l.phase,at:current.promotedAt,
    coding_ticket_id:id,rank_delivery:{kind,planRev:key.planRev,checkId:receipt.checkId},statement,claim:{statement,evidence},evidence};
  return {ticketId:id,...publishCodingFinding(co.united,{dir:task.dir,pending:task.pending,reply,changed:names,tokens:null})};
}
