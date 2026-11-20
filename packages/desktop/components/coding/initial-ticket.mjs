/** First-attempt probe against one actual pending United assignment. Not a tool or task store. */
import {isDeepStrictEqual as equal} from 'node:util';
import {storeInitialCandidate,loadInitialCandidate} from './initial-candidate.mjs';
import { createHash } from 'node:crypto';
import { lstatSync,realpathSync } from 'node:fs';
import { isAbsolute,join } from 'node:path';
import { linkedTicketId } from './united-task.mjs';
import { readDiagnosisSource } from './diagnosis-input.mjs';
import { parseDiagnosisJson } from './diagnosis-json.mjs';
import { prepareInitialLoopback,readInitialManifest } from './initial-transport.mjs';

const sha = b => createHash('sha256').update(b).digest('hex');
const fail = code => {throw new Error(code);};
const exact = (v,keys) => v && typeof v==='object' && !Array.isArray(v) && Object.keys(v).length===keys.length && keys.every(k=>Object.hasOwn(v,k));
const digest = s => typeof s==='string' && s.length===64 && !/[^a-f0-9]/.test(s);
export function approvedInitialAssignment(co,host,id) {
  if (!exact(host,['catalogText','catalogSha256','port']) || typeof host.catalogText!=='string' ||
      Buffer.byteLength(host.catalogText)>256*1024 || !digest(host.catalogSha256) || sha(host.catalogText)!==host.catalogSha256 ||
      !Number.isInteger(host.port) || host.port<1 || host.port>65535) fail('initial-host-authority-invalid');
  const cat=parseDiagnosisJson(host.catalogText);
  if (!exact(cat,['schema','stateRoot','unitedRoot','assignments']) || cat.schema!==1 || !Array.isArray(cat.assignments) ||
      cat.assignments.length<1 || cat.assignments.length>32) fail('initial-catalog-invalid');
  if (typeof cat.stateRoot!=='string' || typeof cat.unitedRoot!=='string' ||
      realpathSync(co.stateDir)!==cat.stateRoot || co.stateDir!==cat.stateRoot || co.united.root!==cat.unitedRoot) fail('initial-authority-root-mismatch');
  const ids=new Set(); let selected;
  for (const row of cat.assignments) {
    if (!exact(row,['runId','messageId','workspace','envelopeSha256','manifestText','manifestSha256']) ||
        typeof row.workspace!=='string' || !isAbsolute(row.workspace) || !digest(row.envelopeSha256)) fail('initial-assignment-invalid');
    const key=linkedTicketId(row.runId,row.messageId), fold=key.toLowerCase();
    const manifest=readInitialManifest(row.manifestText,row.manifestSha256);
    // Normal first implementation uses the ticket ID as attempt ID; later generations are never eligible.
    if (ids.has(fold) || manifest.ticketId!==key || manifest.attemptId!==key) fail('initial-assignment-binding-mismatch');
    ids.add(fold); if(key===id) selected={row,manifest};
  }
  return selected ?? fail('initial-ticket-not-approved');
}
function readAssignment(co,id,host,{row,manifest}) {
  const {runId,messageId}=row;
  const {envelope:e,state,pending}=co.united.task(runId,messageId);
  if (state._watch?.verdict==='STALE' || Object.values(state.pending??{}).some(x=>x?.status==='outcome_unknown'))
    fail('initial-united-reconciliation-required');
  if (sha(JSON.stringify(e))!==row.envelopeSha256 || !Number.isSafeInteger(e.goal_rev) || e.goal_rev<1 ||
      !['open','running'].includes(state.status) || pending.status!=='pending' || pending.part!=='builder' ||
      e.execution_mode!=='manual' || typeof e.task?.objective!=='string' ||
      typeof e.task.acceptance!=='string' || !Number.isFinite(Date.parse(pending.deadline_at)) || Date.parse(pending.deadline_at)<=Date.now())
    fail('initial-united-assignment-changed');
  const cwd=co.resolveWorkspace(row.workspace,{});
  if (cwd!==row.workspace || realpathSync(row.workspace)!==row.workspace) fail('initial-workspace-not-canonical');
  const contract=e.task.objective+'\n\n验收：'+e.task.acceptance;
  if (sha(contract)!==manifest.contractSha256) fail('initial-united-contract-mismatch');
  // No discovery, recursive scan, or caller path. Check existence without following links.
  const files=manifest.files.map(({name,sha256})=>{
    const path=join(cwd,name);const st=lstatSync(path,{throwIfNoEntry:false});
    if (!st && sha256===null) return {name,text:null};
    if (!st || !st.isFile() || st.isSymbolicLink() || st.nlink!==1 || sha256===null) fail('initial-file-baseline-changed');
    const read=readDiagnosisSource(path,32*1024);if(read.sha256!==sha256) fail('initial-file-baseline-changed');
    return {name,text:read.text};
  });
  const plan=prepareInitialLoopback({port:host.port,manifestText:row.manifestText,manifestSha256:row.manifestSha256},JSON.stringify({contract,files}));
  const united={runId,messageId,goalId:e.goal_id,goalRev:e.goal_rev,part:'builder',phase:e.phase};
  const binding={ticketId:id,attemptId:id,generation:1,united,cwd,envelopeSha256:row.envelopeSha256,manifestSha256:row.manifestSha256,
    catalogSha256:host.catalogSha256,requestSha256:plan.requestSha256,planRev:state.plan_rev??null};
  if(binding.planRev===null)delete binding.planRev;
  return {plan,binding,files:manifest.files.map(f=>f.name),sources:files};
}
export async function inspectOriginalTicket(co,host,ticketId,admit=null) {
  const approvedRow=approvedInitialAssignment(co,host,ticketId);const unlock=co.acquireTicketLock(ticketId,'initial-loopback');
  if(!unlock) return co.locked(ticketId);
  try {
    const existing=co.readTicket(ticketId);
    if(existing) return {ticketId,accepted:false,reason:existing.initialProbe?'initial-ticket-consumed; no-replay':'initial-first-attempt-required'};
    const {plan,binding,files}=readAssignment(co,ticketId,host,approvedRow), now=new Date().toISOString();
    const admission=admit?.({binding,files,manifest:approvedRow.manifest});
    const record={...(admission?{rankAdmission:admission}:{}),ticketId,provider:'loopback-fixture',cwd:binding.cwd,workspaceMode:'direct',files,united:binding.united,
      runs:[{attemptId:ticketId,kind:'implement',outcomeKnown:false,status:'outcome-unknown',usage:null,costUsd:null,startedAt:now}],
      status:'needs-review',scopeAudit:'not-run',reason:'initial-outcome-unknown; no-replay',createdAt:now,updatedAt:now,
      initialProbe:{phase:'intent',binding,providerOutcomeKnown:false,requestCount:null}};
    // Write-ahead intent on the ordinary ticket path. No lease or timeout can turn it back into dispatch permission.
    co.saveTicket(record);co.assertMutationOwner(ticketId);
    const result=await plan.sendOnce();co.assertMutationOwner(ticketId);
    const stillCurrent=()=>{
      try {return equal(readAssignment(co,ticketId,host,approvedRow).binding,binding);} catch {return false;}
    };
    let current=stillCurrent(),ref;
    const known=result.providerOutcomeKnown===true;
    if(current && known && result.accepted===true) {
      ref=storeInitialCandidate(co.stateDir,binding,result.candidate);
      // Storage and ticket publication are separate. If material changed, leave the bytes unreferenced.
      current=stillCurrent();
    }
    const phase=!current?'stale':known?'observed':'unknown', ok=current && !!ref;
    const reason=!current?'initial-material-changed-during-request':result.reason;
    record.updatedAt=new Date().toISOString(); record.reason=reason;
    Object.assign(record.initialProbe,{phase,providerOutcomeKnown:known,requestCount:result.requestCount,responseSha256:result.responseSha256,
      candidateSha256:ok?ref.sha256:null,...(ok?{candidateRef:ref}:{})});
    Object.assign(record.runs[0],{endedAt:record.updatedAt,outcomeKnown:known,status:'needs-review',usage:result.usage});
    co.saveTicket(record);
    return {ticketId,accepted:ok,phase,reason,requestSha256:binding.requestSha256,candidateSha256:record.initialProbe.candidateSha256,applied:false};
  } finally {unlock();}
}

/** Read a published result even when a crashed writer left a lock. Never acquire/retire the lock or call sendOnce. */
export function recoverOriginalCandidate(co,host,ticketId) {
  const held=reason=>({ticketId,recovered:false,reason});
  const authority=approvedInitialAssignment(co,host,ticketId), path=co.ticketPath(ticketId);
  const stat=lstatSync(path,{throwIfNoEntry:false});
  if(!stat) return held('initial-candidate-not-published');
  if(!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==1) return held('initial-candidate-ticket-invalid');
  const source=readDiagnosisSource(path,256*1024),record=JSON.parse(source.text),p=record.initialProbe;
  if(!p || !Object.hasOwn(p,'candidateRef')) return held(p?.phase==='observed' && digest(p.candidateSha256)?
    'initial-candidate-legacy-digest-only':'initial-candidate-not-published');
  const {binding,files}=readAssignment(co,ticketId,host,authority);
  if(record.ticketId!==ticketId || record.provider!=='loopback-fixture' || record.status!=='needs-review' ||
    record.reason!=='initial-candidate-received' || record.cwd!==binding.cwd || !equal(record.united,binding.united) ||
    !equal(record.files,files) || record.runs?.length!==1 || record.runs[0]?.attemptId!==binding.attemptId ||
    record.runs[0]?.kind!=='implement' || record.runs[0]?.outcomeKnown!==true || !equal(p.binding,binding) ||
    p.phase!=='observed' || p.providerOutcomeKnown!==true || p.requestCount!==1 || !digest(p.responseSha256))
    return held('initial-candidate-ticket-mismatch');
  const candidate=loadInitialCandidate(co.stateDir,binding,authority.manifest,p);
  if(!equal(readAssignment(co,ticketId,host,authority).binding,binding) || readDiagnosisSource(path,256*1024).sha256!==source.sha256)
    return held('initial-candidate-changed-during-read');
  return {ticketId,recovered:true,candidate,candidateSha256:p.candidateSha256,applied:false};
}

// Only a trusted host consumes this view. Non-replaced declared files keep their verified base bytes;
// an absent declared target remains absent. The candidate cannot select extra paths.
export function originalTextMaterial(co,host,ticketId) {
  const r=recoverOriginalCandidate(co,host,ticketId);if(!r.recovered)return r;
  const {binding,sources}=readAssignment(co,ticketId,host,approvedInitialAssignment(co,host,ticketId));
  if(!sources.every(row=>/\.(json|txt)$/.test(row.name)))fail('initial-stage-text-only');
  const changes=new Map(r.candidate.replacements.map(v=>[v.name,v.text]));
  return {recovered:true,contractSha256:r.candidate.binding.contractSha256,candidateSha256:r.candidateSha256,requestSha256:binding.requestSha256,
    files:sources.map(({name,text})=>({name,text:changes.get(name)??text}))};
}
