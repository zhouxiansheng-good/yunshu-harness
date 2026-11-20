/** Internal single-request transport shared by candidate planners. Not a registered host tool. */
import { createHash } from 'node:crypto';
import { request as http } from 'node:http';
import { request as https } from 'node:https';
import { TextDecoder } from 'node:util';
import { parseDiagnosisJson } from './diagnosis-json.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const shape = (value,keys) => { if (!value || typeof value !== 'object' || Array.isArray(value)
  || !same(Object.keys(value).sort(),[...keys].sort())) throw new Error('fresh-schema-invalid'); };
const reflects = (v,key) => typeof v === 'string' ? v.includes(key) : v && typeof v === 'object'
  && Object.entries(v).some(([k,x])=>k.includes(key)||reflects(x,key));
const text = (v,max) => {if(typeof v!=='string'||!v.trim()||v.length>max||v.includes('\0'))throw new Error('fresh-text-invalid');};
const object = properties => ({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
const string = {type:'string'};
export function freshLimits(options={}) {
  if(!options||typeof options!=='object'||Array.isArray(options)
    ||Object.keys(options).some(k=>!['timeoutMs','maxOutputTokens'].includes(k)))throw new Error('fresh-limits-invalid');
  const limits={timeoutMs:options.timeoutMs??60000,maxOutputTokens:options.maxOutputTokens??4096};
  if(!Number.isSafeInteger(limits.timeoutMs)||limits.timeoutMs<1||limits.timeoutMs>300000
    ||!Number.isSafeInteger(limits.maxOutputTokens)||limits.maxOutputTokens<16||limits.maxOutputTokens>32768)
    throw new Error('fresh-limits-invalid');
  return limits;
}
export function candidateEndpoint(settings) {
  shape(settings,['baseUrl','model','apiKey']);text(settings.model,200);text(settings.apiKey,8192);
  if(/[\r\n]/.test(settings.apiKey))throw new Error('fresh-settings-invalid');
  let url;try{url=new URL(settings.baseUrl);}catch{throw new Error('fresh-endpoint-invalid');}
  if((url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)))
    ||!url.hostname||url.username||url.password||url.search||url.hash)throw new Error('fresh-endpoint-invalid');
  url.pathname=url.pathname.replace(/\/$/,'')+'/responses';
  return url;
}
export function scopedCandidateWire({settings,url,limits,binding,material,instructions,initial=false}, send) {
  const schema=object({schema:{type:'integer',enum:[1]},binding:object(Object.fromEntries(Object.keys(binding).map(k=>[k,string]))),
    result:{type:'string',enum:['candidate','insufficient_evidence']},
    replacements:{type:'array',items:object({name:string,baseSha256:initial?{type:['string','null']}:string,text:string})}});
  const body={model:settings.model,store:false,background:false,stream:false,tools:[],tool_choice:'none',parallel_tool_calls:false,
    truncation:'disabled',max_output_tokens:limits.maxOutputTokens,
    input:[{role:'developer',content:[{type:'input_text',text:instructions}]},
      {role:'user',content:[{type:'input_text',text:JSON.stringify({binding,material})}]}],
    text:{format:{type:'json_schema',name:initial?'yunshu_initial_candidate_v1':'yunshu_fresh_candidate_v1',strict:true,schema}}};
  const bytes=Buffer.from(JSON.stringify(body));
  if(bytes.length>256*1024)throw new Error('fresh-request-byte-budget');
  if(reflects(body,settings.apiKey)||url.href.includes(settings.apiKey))throw new Error('fresh-credential-in-material');
  const plan={url:url.href,body,binding,files:material.files,requestSha256:sha(bytes),requestBytes:bytes.length,limits};
  // A caller cannot post a hand-built plan. Send the same bytes that passed the budget and digest checks.
  return send ? postCandidateOnce(plan,settings.apiKey,bytes) : plan;
}
export function validateFreshCandidate(value,plan) {
  shape(value,['schema','binding','result','replacements']);shape(value.binding,Object.keys(plan.binding));
  if(value.schema!==1||!Object.keys(plan.binding).every(k=>value.binding[k]===plan.binding[k]))throw new Error('fresh-binding-mismatch');
  if(!['candidate','insufficient_evidence'].includes(value.result)||!Array.isArray(value.replacements)
    ||value.replacements.length>plan.files.length)throw new Error('fresh-candidate-invalid');
  if(value.result==='insufficient_evidence'){if(value.replacements.length)throw new Error('fresh-candidate-invalid');return value;}
  if(!value.replacements.length)throw new Error('fresh-empty-candidate');
  const used=new Set();let total=0;
  for(const row of value.replacements){
    shape(row,['name','baseSha256','text']);const file=plan.files.find(f=>f.name===row.name);
    if(!file||used.has(row.name.toLowerCase())||row.baseSha256!==file.sha256)throw new Error('fresh-replacement-binding-mismatch');
    used.add(row.name.toLowerCase());
    if(typeof row.text!=='string'||row.text.includes('\0')||Buffer.from(row.text).toString('utf8')!==row.text
      ||Buffer.byteLength(row.text)>32*1024||(total+=Buffer.byteLength(row.text))>128*1024)
      throw new Error('fresh-replacement-text-budget');
    if(sha(row.text)===row.baseSha256)throw new Error('fresh-replacement-unchanged');
  }
  return value;
}
function usage(parsed){const u=parsed?.usage;return u&&['input_tokens','output_tokens','total_tokens'].every(k=>Number.isSafeInteger(u[k])&&u[k]>=0)
  &&Number.isSafeInteger(u.input_tokens+u.output_tokens)&&u.total_tokens===u.input_tokens+u.output_tokens
  ?{inputTokens:u.input_tokens,outputTokens:u.output_tokens,totalTokens:u.total_tokens}:null;}
function decode(parsed,plan){
  if(parsed?.object!=='response'||parsed.status!=='completed'||parsed.error!=null||parsed.incomplete_details!=null
    ||!Array.isArray(parsed.output)||parsed.output.some(i=>!['reasoning','message'].includes(i?.type)
      ||(i.type==='reasoning'&&i.status!=null&&i.status!=='completed')))throw new Error('fresh-response-incomplete');
  const messages=parsed.output.filter(i=>i.type==='message'),m=messages[0];
  if(messages.length!==1||m.role!=='assistant'||m.status!=='completed'||!Array.isArray(m.content)||m.content.length!==1
    ||m.content[0].type!=='output_text'||typeof m.content[0].text!=='string'
    ||(Object.hasOwn(m.content[0],'annotations')&&(!Array.isArray(m.content[0].annotations)||m.content[0].annotations.length)))
    throw new Error('fresh-response-message-invalid');
  return validateFreshCandidate(parseDiagnosisJson(m.content[0].text),plan);
}
function postCandidateOnce(plan,credential,bytes) {
  const base={accepted:false,candidate:null,requestCount:0,providerOutcomeKnown:false,usage:null,costUsd:null,
    responseId:null,reportedModel:null,requestedModel:plan.body.model,requestSha256:plan.requestSha256,responseSha256:null};
  return new Promise(resolveResult=>{
    let req,incoming,settled=false,timer,count=0;const chunks=[];
    const finish=patch=>{if(settled)return;settled=true;clearTimeout(timer);resolveResult({...base,...patch});incoming?.destroy();req?.destroy();};
    timer=setTimeout(()=>finish({requestCount:req?1:0,reason:'fresh-timeout-outcome-unknown'}),plan.limits.timeoutMs);
    try{const url=new URL(plan.url);
      req=(url.protocol==='https:'?https:http)(url,{method:'POST',agent:false,headers:{Authorization:'Bearer '+credential,
        'Content-Type':'application/json',Accept:'application/json','Accept-Encoding':'identity','Content-Length':bytes.length}},res=>{
        incoming=res;
        if(res.headers['content-encoding']&&res.headers['content-encoding']!=='identity')return finish({requestCount:1,reason:'fresh-encoding-rejected'});
        res.on('error',()=>finish({requestCount:1,reason:'fresh-network-outcome-unknown'}));res.on('aborted',()=>finish({requestCount:1,reason:'fresh-network-outcome-unknown'}));
        res.on('data',chunk=>{count+=chunk.length;if(count>512*1024)return finish({requestCount:1,reason:'fresh-response-byte-budget'});chunks.push(chunk);});
        res.on('end',()=>{if(settled)return;let parsed;const bytes=Buffer.concat(chunks);
          try{parsed=parseDiagnosisJson(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{return finish({requestCount:1,reason:'fresh-provider-json-invalid'});}
          const meta={requestCount:1,usage:usage(parsed),responseSha256:sha(bytes),
            providerOutcomeKnown:['completed','failed','incomplete','cancelled'].includes(parsed?.status),
            responseId:typeof parsed?.id==='string'&&/^resp_[A-Za-z0-9_-]{1,150}$/.test(parsed.id)?parsed.id:null,
            reportedModel:typeof parsed?.model==='string'&&/^[A-Za-z0-9_.:/-]{1,200}$/.test(parsed.model)?parsed.model:null};
          if(reflects(parsed,credential))return finish({...meta,responseId:null,reportedModel:null,reason:'fresh-credential-reflection-rejected'});
          if(res.statusCode!==200)return finish({...meta,reason:'fresh-provider-http-error'});
          try{const candidate=decode(parsed,plan);finish({...meta,accepted:candidate.result==='candidate',candidate,
            reason:candidate.result==='candidate'?'fresh-candidate-received':'fresh-insufficient-evidence'});}
          catch(error){finish({...meta,reason:error.message.startsWith('fresh-')?error.message:'fresh-output-invalid'});}
        });
      });req.on('error',()=>finish({requestCount:1,reason:'fresh-network-outcome-unknown'}));req.end(bytes);
    }catch{finish({requestCount:req?1:0,reason:'fresh-request-setup-failed'});}
  });
}
