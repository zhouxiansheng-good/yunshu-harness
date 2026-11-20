/** Narrow model writer for the enrolled two-file contract. No CLI, tools, service discovery or retry. */
import * as http from 'node:http';
import * as https from 'node:https';
import {createHash} from 'node:crypto';
import {mkdirSync,writeFileSync,readFileSync,existsSync,realpathSync,lstatSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {homedir} from 'node:os';
import {spawnSync} from 'node:child_process';
const digest=b=>createHash('sha256').update(b).digest('hex');
const check=(yes,msg)=>{if(!yes)throw Error('handoff-wire-'+msg)};
const goalHash='446b048a7a82586c05955ec6a3fd7e77fb596767c5adeafafc8c279508528058',changeHash='9094510cacafc599717e76cb55e4e0b76f07b63510aebc22eec1fcd3849d6a2f';
export const limits=Object.freeze({maxPosts:2,maxOutputTokens:1800,priorTokensStop:7000,deadlineMs:90000,maxResponseBytes:512*1024});
const routePath={codex:'/v1/responses',claude:'/v1/messages'};
const instruction='Implement the requested single Python module. Return its complete UTF-8 Python source only, without Markdown, explanations or tools. Follow the public task and phase below.';
const file=(p,max)=>{const s=lstatSync(p);check(s.isFile()&&s.nlink===1&&realpathSync(p)===p&&s.size<=max,'file-shape');return readFileSync(p)};
// Only the fixed loopback service in the user's default Codex profile is accepted here.
// Do not inherit CODEX_HOME from a delegating CLI or look for credentials in another profile.
export const localBase='http://127.0.0.1:8317/v1';
export function localCodexProfile(python){
 check(typeof python==='string'&&isAbsolute(python)&&realpathSync(python)===python,'local-profile-interpreter');
 const script=`import json,sys,tomllib\nfrom pathlib import Path\np=Path(sys.argv[1]); assert p.is_file() and p.stat().st_size<=2*1024*1024\no=tomllib.loads(p.read_text(encoding='utf-8-sig')); v=o['model_providers'][o['model_provider']]\nassert v['wire_api']=='responses' and v['base_url'].rstrip('/')==sys.argv[2]\nprint(json.dumps([o['model'],v['experimental_bearer_token']]))`;
 const q=spawnSync(python,['-I','-B','-X','utf8','-c',script,join(homedir(),'.codex','config.toml'),localBase],{cwd:homedir(),encoding:'utf8',windowsHide:true,timeout:5000,maxBuffer:4096});
 check(q.status===0,'local-profile-unavailable');let v;try{v=JSON.parse(q.stdout)}catch{throw Error('handoff-wire-local-profile-unavailable')}
 return configure({mode:'local-codex',provider:'codex',url:localBase+'/responses',model:v[0],token:v[1]});
}
export function configure(c){
 check(c&&Object.hasOwn(routePath,c.provider)&&typeof c.model==='string'&&/^[\w.-]{1,100}$/.test(c.model),'configuration');
 const u=new URL(c.url);check(!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname===routePath[c.provider],'endpoint');
 const fixture=c.mode==='loopback',local=c.mode==='local-codex';
 // Local forwarders may use short opaque access labels; they never authorize a remote HTTP destination.
 const tokenOK=typeof c.token==='string'&&(local?/^[\x21-\x7e]{1,1024}$/:/^[\x21-\x7e]{8,1024}$/).test(c.token)&&c.token!=='test-only';
 check(fixture?u.protocol==='http:'&&u.hostname==='127.0.0.1'&&u.port&&c.token==='test-only':local?c.provider==='codex'&&c.url===localBase+'/responses'&&tokenOK:c.mode==='relay'&&u.protocol==='https:'&&!u.port&&tokenOK,'mode');
 const {mode,model,provider,url,token}=c;return Object.freeze({mode,model,provider,url,token,tag:digest(JSON.stringify([mode,model,provider,url,limits]))});
}
export function packet(c,goal,change,source){
 check(typeof goal==='string'&&digest(goal)===goalHash,'public-contract');const second=change!==undefined;
 check(second?typeof change==='string'&&digest(change)===changeHash&&typeof source==='string'&&Buffer.byteLength(source)<=32768:source===undefined,'public-amendment');
 const material={contract:goal,phase:second?'Implement only handoff.py, retaining records.py unchanged.':'Implement only records.py for the first milestone. Do not implement the exporter yet.',...(second?{amendment:change,'records.py':source}:{})};
 const input=JSON.stringify(material);
 const body=c.provider==='codex'?{model:c.model,instructions:instruction,...(c.mode==='local-codex'?{reasoning:{effort:'low'}}:{}),input:[{role:'user',content:input}],store:false,stream:true,max_output_tokens:limits.maxOutputTokens}:{model:c.model,system:instruction,messages:[{role:'user',content:input}],max_tokens:limits.maxOutputTokens,stream:false};
 const bytes=JSON.stringify(body);check(Buffer.byteLength(bytes)<=65536&&!bytes.includes(c.token),'request-boundary');return bytes;
}
const once=(p,o)=>writeFileSync(p,JSON.stringify(o,null,2)+'\n',{flag:'wx',mode:0o600});
function post(c,body,signal){
 signal?.throwIfAborted();const u=new URL(c.url),driver=u.protocol==='https:'?https:http;
 return new Promise((resolve,reject)=>{let timer;const finish=(fn,v)=>{clearTimeout(timer);fn(v)};
 const headers={'Content-Type':'application/json','Accept':c.provider==='codex'?'text/event-stream, application/json':'application/json','Content-Length':Buffer.byteLength(body),'Authorization':'Bearer '+c.token,...(c.provider==='claude'?{'anthropic-version':'2023-06-01'}:{})};
 const req=driver.request(u,{method:'POST',headers,signal,agent:false},res=>{const blocks=[];let len=0;
  res.on('error',()=>finish(reject,Error('response-interrupted')));res.on('data',b=>{len+=b.length;if(len>limits.maxResponseBytes){req.destroy();finish(reject,Error('response-size'));}else blocks.push(b)});
  res.on('end',()=>finish(resolve,{status:res.statusCode,receiptHeader:res.headers['x-request-id']??res.headers['request-id']??null,raw:Buffer.concat(blocks).toString('utf8')}));});
 req.on('error',e=>finish(reject,Error(signal?.aborted?'aborted':/CERT|TLS/.test(e.code??'')?'tls':'connection')));timer=setTimeout(()=>{req.destroy();finish(reject,Error('deadline'))},limits.deadlineMs);req.end(body);});
}
function decode(c,raw){
 let r;if(raw.trimStart().startsWith('{'))r=JSON.parse(raw);else {check(c.provider==='codex','unexpected-stream');const ends=[];for(const line of raw.split(/\r?\n/)){if(!line.startsWith('data:'))continue;const data=line.slice(5).trim();if(!data||data==='[DONE]')continue;const e=JSON.parse(data);check(!['error','response.failed','response.incomplete'].includes(e.type),'nonterminal-stream');if(e.type==='response.completed')ends.push(e.response)}check(ends.length===1,'missing-final');r=ends[0];}
 const codex=c.provider==='codex';check(codex?r.status==='completed'&&Array.isArray(r.output):r.type==='message'&&r.stop_reason==='end_turn'&&Array.isArray(r.content),'incomplete');
 const items=codex?r.output.filter(i=>i.type!=='reasoning'):r.content;check(codex?items.length===1&&items[0].type==='message'&&items[0].role==='assistant'&&items[0].content.every(i=>i.type==='output_text'):items.every(i=>i.type==='text'||i.type==='thinking'),'non-text-result');
 const blocks=codex?items[0].content:items.filter(i=>i.type==='text');let code=blocks.map(i=>i.text).join('').trim();const fence=code.match(/^```(?:python|py)?\s*\r?\n([\s\S]+?)\r?\n```$/i);if(fence)code=fence[1];code+='\n';check(code.trim()&&!code.includes('\0')&&!code.includes(c.token)&&Buffer.byteLength(code)<=32768,'code-shape');
 const u=r.usage??{},input=u.input_tokens,output=u.output_tokens;check([input,output].every(v=>Number.isSafeInteger(v)&&v>=0)&&output>0,'usage-unknown');const extra=codex?0:(u.cache_read_input_tokens??0)+(u.cache_creation_input_tokens??0);const total=codex?(u.total_tokens??input+output):input+output+extra;
 check(Number.isSafeInteger(extra)&&extra>=0&&Number.isSafeInteger(total)&&total>=input+output&&output<=limits.maxOutputTokens,'usage-invalid');
 check(typeof r.id==='string'&&/^[\w.:-]{1,200}$/.test(r.id)&&typeof r.model==='string'&&r.model.length<=160,'missing-model-receipt');return {code,id:r.id,model:r.model,usage:{inputTokens:input,outputTokens:output,cacheTokens:extra,totalTokens:total}};
}
export async function exchange(c,{id,stage,state,goal,change,signal}){
 check(/^r-\d{14}-[a-f0-9]{4}_m-[a-f0-9]{10}$/.test(id)&&stage===join(state,'stages',id)&&realpathSync(stage)===stage,'original-stage');const second=change!==undefined,phase=second?'amended':'producer',name=second?'handoff.py':'records.py';
 const dir=join(state,'handoff-wire',id);mkdirSync(dir,{recursive:true});const path=k=>join(dir,k+'.json');const prefix=phase+'-';const target=join(stage,name);
 check(!existsSync(target)&&!existsSync(path(prefix+'intent'))&&!existsSync(path(prefix+'result')),'already-attempted-only-read');let source;
 if(second){const prev=JSON.parse(file(path('producer-result'),16384));const initial=JSON.parse(file(path('producer-intent'),65536));const b=file(join(stage,'records.py'),32768);check(prev.status==='received'&&prev.route===c.tag&&prev.requestHash===digest(initial.body)&&prev.fileHash===digest(b)&&prev.usage.totalTokens<limits.priorTokensStop,'prior-not-current-or-budget');source=b.toString('utf8');}
 const body=packet(c,goal,change,source);signal?.throwIfAborted();const requestHash=digest(body);once(path(prefix+'intent'),{id,phase,provider:c.provider,requestedModel:c.model,mode:c.mode,route:c.tag,limits,requestHash,body,at:new Date().toISOString()});
 let reply=null,stageStatus='transport';try{reply=await post(c,body,signal);check(reply.status===200,'http-'+reply.status);stageStatus='decode';const x=decode(c,reply.raw);const done={id,phase,route:c.tag,status:'received',http:reply.status,requestHash,providerRequestId:x.id,requestedModel:c.model,reportedModel:x.model,usage:x.usage,settledCurrency:null,fileHash:digest(x.code),responseHash:digest(reply.raw),at:new Date().toISOString()};once(path(prefix+'result'),done);
 // Keep the receipt if applying the returned source fails; never send again to reconstruct it.
 writeFileSync(target,x.code,{flag:'wx'});return {kind:'run',outcome:{status:'completed',threadId:null,runId:x.id,usage:x.usage,costUsd:null,answer:'Received '+name+' from the configured '+c.provider+' relay.',wire:{phase,requestHash,fileHash:done.fileHash,providerRequestId:x.id,route:c.tag,continuity:'original-ticket-public-snapshot'}}};
 }catch(err){if(!existsSync(path(prefix+'result')))once(path(prefix+'result'),{id,phase,route:c.tag,status:'unresolved',at:new Date().toISOString(),requestHash,http:reply?.status??null,reason:stageStatus+':'+(/^[a-z0-9-]+$/.test(err.message)?err.message:'unrecognized-response'),responseHash:reply?digest(reply.raw):null,usage:null,settledCurrency:null});throw Error('handoff-wire-outcome-requires-readback');}
}
export function receipts(state,t,route){const dir=join(state,'handoff-wire',t.ticketId);return ['producer','amended'].map((phase,i)=>{const a=t.runs[i],w=a?.wire;const intent=JSON.parse(file(join(dir,phase+'-intent.json'),98304)),r=JSON.parse(file(join(dir,phase+'-result.json'),16384));
 check(w&&w.phase===phase&&w.route===route&&r.id===t.ticketId&&intent.id===t.ticketId&&intent.phase===phase&&intent.route===route&&r.route===route&&r.phase===phase&&r.status==='received'&&r.providerRequestId===a.runId&&r.fileHash===a.after[i?'handoff.py':'records.py']&&r.fileHash===w.fileHash&&w.requestHash===r.requestHash&&digest(intent.body)===r.requestHash&&JSON.stringify(r.usage)===JSON.stringify(a.usage),'unbound-receipt');return digest(JSON.stringify([intent,r]));});}