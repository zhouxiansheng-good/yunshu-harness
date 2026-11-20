// The journal orders receipts. The outbox supplies their contents, not their authority.
import {assertHandoffFinding} from './handoff-contract.mjs';
import {createHash} from 'node:crypto';
import {closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, statSync} from 'node:fs';
import {isAbsolute, join, resolve} from 'node:path';
import {isDeepStrictEqual as same} from 'node:util';
const list=v=>v==null?[]:Array.isArray(v)?v:[v];
const need=(v,msg)=>{if(!v)throw Error(msg);};
const read=p=>JSON.parse(readFileSync(p,'utf8').replace(/^\uFEFF/,''));
const sha=b=>createHash('sha256').update(b).digest('hex');
export function readReceived(dir,state,frame){
 const p=frame.payload;need(/^m-[\w-]+$/.test(p.message_id),'非法收件编号');
 const c=read(join(dir,'out',p.message_id+'.json'));
 const evidence=[...list(c.evidence),...list(c.claim?.evidence)];
 need(c.id===p.message_id&&c.parent_id===p.parent_id&&c.from===p.from&&c.to==='self'&&p.to==='self'&&c.kind===p.kind&&c.run_id===state.run_id&&c.goal_id===state.goal_id&&c.goal_rev===state.goal_rev&&state.pending?.[c.parent_id]?.part===c.from&&state.pending[c.parent_id].status==='settled','回执与原派单或目标版本不符');
 need(same(evidence,p.evidence)&&evidence.length===p.evidence_count&&(c.claim?.statement??null)===p.claim_statement,'收件投影与权威账本不符');
 if(p.envelope_sha256)need(sha(JSON.stringify(c))===p.envelope_sha256,'收件投影与已提交的回执摘要不符');
 return c;
}
function entries(raw){
 const map=new Map();
 for(const e of raw){
  const path=String(e?.uri??'').replace(/^artifact:\/\//,'');
  need(isAbsolute(path)&&/^[a-f0-9]{64}$/i.test(e?.sha256??''),'证据缺少本地绝对路径或有效 SHA-256');
  const key=resolve(path),sum=e.sha256.toLowerCase();need(!map.has(key)||map.get(key)===sum,'同一文件有不一致的证据摘要');map.set(key,sum);
 }return map;
}
export function hashFile(path){
 const fd=openSync(path,'r');
 try{
  const before=fstatSync(fd),hash=createHash('sha256'),chunk=Buffer.allocUnsafe(128*1024);
  need(before.isFile(),'交付物必须是文件。');
  let total=0,count;
  while((count=readSync(fd,chunk,0,chunk.length,null))>0){hash.update(chunk.subarray(0,count));total+=count;}
  const after=fstatSync(fd);
  need(total===before.size && after.size===total && before.mtimeMs===after.mtimeMs,'核对期间文件已改变。');
  return hash.digest('hex');
 }finally{closeSync(fd);}
}
function live(map){for(const [path,sum] of map){need(existsSync(path)&&statSync(path).isFile(),'证据文件不存在，不能判 done：'+path);need(hashFile(path)===sum,'证据哈希不符，不能判 done：'+path);}}
const latest=(frames,role)=>frames.findLast(f=>f.op==='recv'&&f.payload.from===role);
function builderEvidence(frames,dir,state){const frame=latest(frames,'builder');need(frame,'要判 done，必须先有 builder 回执');const c=readReceived(dir,state,frame);need(c.kind==='finding','当前 builder 没有提交产物');
 const files=entries([...list(c.evidence),...list(c.claim?.evidence)]);need(files.size,'当前 builder 产物清单为空');live(files);return {frame,c,files};}
export function reviewRefs(frames,dir,state){
 if(!latest(frames,'builder'))return [];
 // A damaged/partial delivery may still need investigation; never substitute older bytes.
 try{const {c,files}=builderEvidence(frames,dir,state);return [...files].map(([uri,sha256])=>({uri,sha256,from_message:c.id}));}catch{return [];}
}
export function completionBasis(frames,dir,state,selected){
 const {frame:bf,c:b,files}=builderEvidence(frames,dir,state),gf=latest(frames,'guardian');need(gf,'判 done 缺 guardian 复核回执');
 const sent=frames.find(f=>f.op==='dispatch'&&f.payload.message_id===b.parent_id&&f.payload.part==='builder');
 need(sent&&!frames.some(f=>f.op==='revise'&&f.seq>sent.seq),'任务已在派单后修订，请按当前版本重新执行和复核');
 assertHandoffFinding(b,frames,state);
 if(b.rank_delivery)need(b.rank_delivery.kind==='rank-list-v1'&&b.rank_delivery.planRev===null&&state.plan_rev===null&&!frames.some(f=>f.op==='revise'),'固定合同已有修订，旧回执不能终裁');
 const g=readReceived(dir,state,gf);need(['finding','ack'].includes(g.kind),'当前 guardian 没有通过复核');need(selected===b.id||selected===g.id,'终裁只可选当前 builder 或对应 guardian 的回执');
 const gd=frames.find(f=>f.op==='dispatch'&&f.payload.part==='guardian'&&f.payload.message_id===g.parent_id);
 need(gd&&bf.seq<gd.seq&&gd.seq<gf.seq,'guardian 派单不是针对当前 builder 版本');
 need(Object.values(state.pending||{}).every(p=>!['pending','outcome_unknown'].includes(p.status)),'仍有未处理或结果未知的派单');
 // New dispatches bind both the receipt ID and the full URI/digest set in the immutable frame.
 // For pre-upgrade dispatches use the old ordered frame's paths AND the original task envelope.
 const p=gd.payload;let frozen=p.artifact_evidence;
 if(!Object.hasOwn(p,'artifact_evidence')){
  const name='guardian-'+g.parent_id+'.json',paths=['in','claimed'].map(sub=>join(dir,sub,name)).filter(existsSync);need(paths.length>=1,'旧 guardian 派单缺原始依据');
  const task=read(paths[0]);need(task.id===g.parent_id&&task.run_id===state.run_id&&task.goal_rev===state.goal_rev&&task.goal_id===state.goal_id&&task.to==='guardian','旧 guardian 派单绑定不符');
  frozen=task.context?.artifact_evidence;need(Array.isArray(frozen)&&same(frozen.map(e=>e.uri),p.artifact_refs),'旧 guardian 派单与已提交的文件位置不符');
 }
 need(Array.isArray(frozen)&&frozen.length===files.size&&frozen.every(e=>e.from_message===b.id)&&same(entries(frozen),files),'guardian 派单缺当前完整 builder 产物版本');
 const reviewed=entries(list(g.evidence)),all=entries([...list(g.evidence),...list(g.claim?.evidence)]);
 for(const [path,sum] of files)need(reviewed.get(path)===sum,'guardian 未复核当前完整产物：'+path);
 live(all);return {builder_receipt:b.id,guardian_receipt:g.id};
}
