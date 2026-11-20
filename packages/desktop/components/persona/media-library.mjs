import { stableJson, contentHash } from '../memory/shared/context-contract.mjs';

const fail = message => { throw Error(message); };
const maxChunk = 96*1024;
function sourceForFile(store,scope,p) {
  const name=p.name;
  if(typeof name!=='string'||!name.trim()||name.length>240||/[\\/\x00-\x1f]/u.test(name) ||
    !/^[a-f0-9]{64}$/u.test(p.sha256) || !Number.isSafeInteger(p.bytes) || p.bytes<1) fail('文件标识无效。');
  const type=typeof p.mimeType==='string' && /^[\w.+-]+\/[\w.+-]+$/u.test(p.mimeType)?p.mimeType:'application/octet-stream';
  if(!/^[a-f0-9-]{36}$/iu.test(p.requestId))fail('导入请求无效。');
  const sessionId='owner-import:'+p.requestId, id=contentHash([scope,sessionId,0]);
  const part={type:'file',filename:name,mimeType:type,bytes:p.bytes,sha256:p.sha256,capture:'owner-selected-file',mediaBytesVerified:false};
  const payload={format:'yunshu-public-source-v1',type:'owner/attachment',parts:[part],timestamp:null,interrupted:false,omittedTypes:[],coverage:'owner-selected-file'};
  const body=stableJson(payload),hash=contentHash(body);
  return store.transaction(()=>{
    const existing=store.db.prepare('SELECT content_hash,withdrawn FROM yunshu_sources WHERE id=? AND scope=?').get(id,scope);
    if(existing && (existing.withdrawn||existing.content_hash!==hash))fail('此导入请求已撤回或对应其他文件。');
    if(!existing)store.evidence._insertSource({id,scope,session_id:sessionId,event_seq:0,role:'owner',payload:body,content_hash:hash,captured_at:new Date().toISOString(),withdrawn:false});
    return id;
  });
}

export async function libraryRequest(service,scope,action,p,signal) {
  const store=service.memory.store,vault=service.vault;
  if(action==='media-library-begin'){
    if(p.bytes>vault.maxAssetBytes)fail('超过单文件容量。');
    const sourceId=sourceForFile(store,scope,p);
    return service.uploads.begin(scope,{...p,sourceId,partIndex:0,confirmed:true});
  }
  if(action==='media-library-list'){
    const rows=store.db.prepare('SELECT r.source_id AS id,r.part_index AS part,r.digest,r.mime_type AS mime,o.bytes,s.role FROM yunshu_media_refs r JOIN yunshu_sources s ON s.id=r.source_id AND s.scope=r.scope JOIN yunshu_media_objects o ON o.scope=r.scope AND o.digest=r.digest WHERE r.scope=? AND s.withdrawn=0 ORDER BY s.captured_at DESC,r.part_index LIMIT 200').all(scope);
    const total=store.db.prepare('SELECT COUNT(*) AS n FROM yunshu_media_refs r JOIN yunshu_sources s ON s.id=r.source_id AND s.scope=r.scope WHERE r.scope=? AND s.withdrawn=0').get(scope).n;
    return {total,items:rows.map(r=>{const part=store.evidence.source(scope,r.id).payload.parts[r.part];
      return {...r,name:part.filename||part.name||('附件 '+r.digest.slice(0,8))};})};
  }
  const source=store.evidence.source(scope,p.id);
  if(!source || !Number.isSafeInteger(p.part)||p.part<0) fail('这个附件已移除或不属于当前工作区。');
  if(action==='media-library-remove'){
    if(source.role!=='owner'||p.part!==0||source.payload.type!=='owner/attachment')fail('只能移除从媒体页导入的附件。');
    const row=vault.row(scope,p.id,p.part);
    if(!row||row.digest!==p.digest)fail('附件已经改变，请刷新。');
    store.evidence.withdrawSource(scope,p.id);service.libraryRead=null;return {removed:true};
  }
  if(action==='media-library-read'){
    if(!Number.isSafeInteger(p.offset)||p.offset<0)fail('读取位置无效。');
    const row=vault.row(scope,p.id,p.part);
    if(!row||row.digest!==p.digest||p.offset>=row.bytes)fail('附件版本已变，请刷新。');
    let def=service.libraryRead;
    if(!def || def.scope!==scope || def.id!==p.id || def.part!==p.part || def.sha!==row.digest || Date.now()>def.expires || p.offset===0){
      const saved=await vault.run(signal,active=>vault.verified(scope,p.id,p.part,active));
      def={scope,id:p.id,part:p.part,sha:row.digest,bytes:saved.bytes,expires:Date.now()+20000};
      service.libraryRead=def;
    }
    const end=Math.min(row.bytes,p.offset+maxChunk);
    const base64=def.bytes.subarray(p.offset,end).toString('base64');
    if(end===row.bytes)service.libraryRead=null;
    return {base64,next:end,total:row.bytes,digest:row.digest};
  }
  fail('未知附件操作。');
}
