/** Runs only inside the original native writer Job. One HTTP call, then bounded writes. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, relative, sep } from 'node:path';
import { readDiagnosisSource } from './diagnosis-input.mjs';
import { parseDiagnosisJson } from './diagnosis-json.mjs';
import { freshLimits, planFreshRequest, requestFreshCandidate } from './fresh-transport.mjs';
import { assertWriterLaunch } from './writer-authority.mjs';
import { workspaceSnapshot, scopeFingerprint } from './coordinator.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function readFreshSettings(path,expectedHash=null){
  try{
    if(typeof path!=='string'||!isAbsolute(path))throw new Error();
    const source=readDiagnosisSource(path,16*1024);
    if(expectedHash&&source.sha256!==expectedHash)throw new Error();
    return {settings:parseDiagnosisJson(source.text),sha256:source.sha256};
  }catch{throw new Error('fresh-settings-unavailable-or-changed');}
}
export async function executeFreshWriter(input){
  const {identity:id,config,request}=input;
  const {settings}=readFreshSettings(config.settingsFile,config.settingsSha256);
  const packet=request.freshPacket,plan=planFreshRequest(packet,settings,config.limits);
  if(plan.requestSha256!==config.requestSha256||request.resumeThreadId!=null||request.continueFromLast
    ||!same(plan.binding,config.binding))throw new Error('fresh-execution-request-mismatch');
  const ticketPath=join(input.stateDir,'tickets',id.ticketId+'.json'),version=sha(readFileSync(ticketPath));
  const baseline=new Map(input.scopeEntries),expected=new Map(input.scopeEntries),limits=config.auditLimits;
  const scopeKey=name=>{const canonical=relative(id.cwd,resolve(id.cwd,name)).split(sep).join('/');
    const matches=[...expected.keys()].filter(key=>key.toLowerCase()===canonical.toLowerCase());
    if(matches.length!==1)throw new Error('fresh-target-scope-key-invalid');return matches[0];};
  const audit=()=>{
    assertWriterLaunch(input.stateDir,id);
    if(sha(readFileSync(ticketPath))!==version)throw new Error('fresh-ticket-version-changed');
    const ticket=parseDiagnosisJson(readFileSync(ticketPath,'utf8')),attempt=ticket.runs.at(-1);
    if(attempt.attemptId!==id.attemptId||attempt.fresh?.inputSha256!==packet.sha256
      ||ticket.freshContext?.status!=='consumed'||ticket.freshContext.packet.sha256!==packet.sha256)
      throw new Error('fresh-current-intent-mismatch');
    const now=workspaceSnapshot(id.cwd,limits.maxFiles,limits.maxHashBytes,limits.hashFileLimit);
    if(scopeFingerprint(now)!==scopeFingerprint(expected))throw new Error('fresh-scope-changed');
    // Full original source check for staged work, not only targets.
    if(config.source){const current=workspaceSnapshot(config.source.cwd,limits.maxFiles,limits.maxHashBytes,limits.hashFileLimit,true);
      if(scopeFingerprint(current)!==config.source.fingerprint)throw new Error('fresh-source-workspace-changed');}
    for(const file of plan.files){
      const source=readDiagnosisSource(resolve(id.cwd,file.name),32*1024);
      if(expected.get(scopeKey(file.name))!=='file:'+source.sha256)throw new Error('fresh-target-changed');
    }
  };
  if(scopeFingerprint(baseline)!==id.scopeHash)throw new Error('fresh-scope-baseline-mismatch');
  audit();
  const directory=dirname(config.inputPath);
  writeFileSync(join(directory,'fresh-request.json'),JSON.stringify({requestSha256:plan.requestSha256,url:plan.url,body:plan.body})+'\n',{flag:'wx'});
  const startedAt=new Date().toISOString(),result=await requestFreshCandidate(packet,settings,freshLimits(config.limits));
  const {candidate,accepted,...metadata}=result;
  const fresh={transport:'responses-scoped-v1',inputSha256:packet.sha256,...metadata,candidateAccepted:accepted,appliedFiles:[],applyStatus:'not-applied'};
  let status='failed';
  if(result.accepted){
    try{
      audit();
      const backups=join(directory,'fresh-backups');mkdirSync(backups);
      const rows=candidate.replacements.map((row,index)=>{
        const source=readDiagnosisSource(resolve(id.cwd,row.name),32*1024);
        if(source.sha256!==row.baseSha256)throw new Error('fresh-replacement-base-changed');
        const path=join(backups,String(index)+'.before');writeFileSync(path,source.text,{flag:'wx'});
        return {name:row.name,beforeSha256:source.sha256,afterSha256:sha(row.text),backup:path};
      });
      // All replacements were schema-validated before any workspace write.
      // All backups and manifest precede the first atomic replacement.
      writeFileSync(join(directory,'fresh-candidate.json'),JSON.stringify(candidate)+'\n',{flag:'wx'});
      writeFileSync(join(directory,'fresh-apply-manifest.json'),JSON.stringify({schema:1,identity:id,packetSha256:packet.sha256,files:rows})+'\n',{flag:'wx'});
      for(const [index,row]of candidate.replacements.entries()){
        audit();const target=resolve(id.cwd,row.name),temporary=join(dirname(target),'.yunshu-fresh-'+id.token+'-'+index+'.new');
        let owned=false;
        try{writeFileSync(temporary,row.text,{flag:'wx'});owned=true;
          assertWriterLaunch(input.stateDir,id);
          if(sha(readFileSync(ticketPath))!==version||readDiagnosisSource(target,32*1024).sha256!==row.baseSha256)
            throw new Error('fresh-apply-version-conflict');
          renameSync(temporary,target);owned=false;
        }finally{if(owned&&existsSync(temporary))rmSync(temporary);}
        expected.set(scopeKey(row.name),'file:'+sha(row.text));fresh.appliedFiles.push(row.name);
      }
      audit();fresh.applyStatus='applied';status='completed';
    }catch(error){fresh.applyStatus='failed-or-partial';fresh.reason=error.message.startsWith('fresh-')?error.message:'fresh-apply-failed';}
  }
  // Only structured local observations survive. No model completion credit.
  writeFileSync(join(directory,'fresh-result.json'),JSON.stringify(fresh)+'\n',{flag:'wx'});
  return {kind:'run',outcome:{status,runId:'fresh-'+id.token,threadId:null,resumedThreadId:null,
    usage:result.usage,costUsd:null,answer:'',startedAt,endedAt:new Date().toISOString(),fresh}};
}
