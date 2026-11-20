import {join,isAbsolute,relative} from 'node:path';
import {readFileSync,realpathSync,lstatSync} from 'node:fs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual as same } from 'node:util';
const hash = s => createHash('sha256').update(s).digest('hex');
// Derived under the parent ledger lock. Guardian dispatch/recv is not a change of business requirements.
const check=(v,s)=>{if(!v)throw Error('交付凭据不符：'+s);};
const bytes=(p,max)=>{const s=lstatSync(p);check(realpathSync(p)===p && s.isFile() && s.nlink===1 && s.size<=max,'文件边界');return readFileSync(p);};
export function enrollment(stateDir,cwd){
  check(typeof stateDir==='string'&&typeof cwd==='string'&&isAbsolute(stateDir)&&isAbsolute(cwd)&&realpathSync(stateDir)===stateDir&&realpathSync(cwd)===cwd,'原始目录');
  const apart=(a,b)=>{const r=relative(a,b);return r==='..'||r.startsWith('..\\')||r.startsWith('../')||isAbsolute(r);};
  check([stateDir,cwd].every(p=>lstatSync(p).isDirectory())&&apart(stateDir,cwd)&&apart(cwd,stateDir),'工作区与控制端必须分开');return {stateDir,cwd};
}
export function handoffContract(frames, state, mid) {
  const initial=frames.find(f=>f.op==='new'), ds=frames.filter(f=>f.op==='dispatch'&&f.payload.message_id===mid);
  const revisions=frames.filter(f=>f.op==='revise'), last=revisions.at(-1);
  if(!initial || ds.length!==1 || ds[0].payload.part!=='builder' || ds[0].payload.execution_mode!=='manual' ||
     state.goal_rev!==initial.payload.goal_rev || state.plan_rev!==(last?.payload.rev??null) ||
     (last && last.seq<=ds[0].seq)) throw Error('交付合同与当前账本不符');
  check(ds[0].payload.handoff_host,'未登记的交付合同');
  return {schema:1,enrollmentSha256:hash(JSON.stringify(ds[0].payload.handoff_host)),runId:state.run_id,messageId:mid,goalRev:state.goal_rev,planRev:state.plan_rev,
    revisions:revisions.length,goalSha256:hash(initial.payload.goal),acceptanceSha256:hash(initial.payload.acceptance),
    objectiveSha256:hash(ds[0].payload.objective),dispatchHash:ds[0].hash,revisionHash:last?.hash??null,
    changeSha256:last?hash(last.payload.change):null};
}
export function assertHandoffFinding(envelope,frames,state) {
  const v=envelope.handoff_delivery;
  const frame=frames.find(f=>f.op==='dispatch'&&f.payload.message_id===envelope.parent_id);
  // Select the policy by the original assignment, not an optional field in an incoming result.
  if(!frame?.payload.handoff_host&&!v)return;
  check(v&&frame?.payload.handoff_host,'缺少原派单登记或验收凭据');
  if(!v || v.kind!=='handoff-wasi-v1' || v.parent?.revisions!==1 || v.parent?.planRev!==1 || !same(v.parent,handoffContract(frames,state,envelope.parent_id)) ||
     !/^[0-9a-f]{64}$/.test(v.receiptSha256??'') || envelope.coding_ticket_id!==state.run_id+'_'+envelope.parent_id)
    throw Error('交付所据的业务修订已变化或回执不匹配');
  const h=frame.payload.handoff_host,id=envelope.coding_ticket_id;
  check(/^r-[0-9]{14}-[a-f0-9]{4}_m-[a-f0-9]{10}$/.test(id),'票号');
  const ticketPath=join(h.stateDir,'tickets',id+'.json'),raw=bytes(ticketPath,512*1024),ticket=JSON.parse(raw);
  const gate=ticket.verification,receipt=gate?.handoff, key=receipt?.key;
  check(ticket.ticketId===id&&ticket.cwd===h.cwd&&ticket.status==='promoted'&&ticket.promotion?.status==='promoted'&&gate?.status==='target-files-and-test-passed'&&key?.ticketId===id&&same(key.parent,v.parent)&&key.attemptId===ticket.lastImplementationAttemptId&&key.attemptId===ticket.promotion.attemptId&&key.contractHash===ticket.contractHash,'原票与实施');
  const {receiptSha256,...body}=receipt;
  check(receiptSha256===hash(JSON.stringify(body))&&receiptSha256===v.receiptSha256&&receipt.checkId===gate.checkId&&receipt.checkId===ticket.promotion.checkId&&/^[a-f0-9-]{36}$/.test(receipt.checkId),'正式验收摘要');
  const dir=join(h.stateDir,'verification-checks',receipt.checkId),nativeBytes=bytes(join(dir,'receipt.json'),64*1024),native=JSON.parse(nativeBytes),scoreBytes=bytes(join(dir,'stdout.log'),32768),score=JSON.parse(scoreBytes);
  check(hash(nativeBytes)===receipt.nativeReceipt&&native.rootExitCode===0&&native.terminalVerified===true&&native.activeProcesses===0&&native.checkId===receipt.checkId&&native.requestSha256===hash(bytes(join(dir,'request.json'),65536))&&hash(scoreBytes)===receipt.scoreSha256&&native.outputFiles?.['stdout.log']?.sha256===receipt.scoreSha256&&score.challenge===hash(JSON.stringify({checkId:receipt.checkId,key}))&&score.measurement?.passed===true&&same(score.measurement.files,key.files),'进程及评分');
  const actual=['records.py','handoff.py'].map(n=>{const path=join(h.cwd,n),digest=hash(bytes(path,32768));check(digest===key.files[n],'交付已改变');return {uri:'artifact://'+path,sha256:digest};});actual.push({uri:'artifact://'+ticketPath,sha256:hash(raw)});
  check(same(actual,envelope.evidence)&&same(actual,envelope.claim?.evidence),'已提升文件与原票');
}
