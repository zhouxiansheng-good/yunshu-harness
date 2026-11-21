import { randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { WindowsKeyProtection } from '../voice/key-protection.mjs';

export const workerRoles={codex:['GPT · Codex','按规划执行任务，交回作品和文件'],claude:['Claude Code','前期规划与独立审核']};
const check=(ok,msg)=>{if(!ok)throw Error(msg);};
export function profiles(c){
  return c.workers??Object.entries(workerRoles).map(([provider,[name]])=>({
    id:provider,provider,name,mode:'local',enabled:true,model:'',executable:'',home:'',endpoint:'',stamp:provider
  }));
}
export function selected(c,provider){
  const id=Object.hasOwn(c.selected??{},provider)?c.selected[provider]:provider;
  return profiles(c).find(x=>x.id===id && x.provider===provider)??null;
}
export function settings(row){
  const {secret,stamp,...fields}=row;
  return {...fields,hasKey:Boolean(secret)};
}
function address(raw){
  let u;
  try{u=new URL(raw);}catch{throw Error('请填写完整的接口地址。');}
  check((u.protocol==='https:' || u.protocol==='http:' && ['localhost','127.0.0.1','[::1]'].includes(u.hostname)) &&
    !u.username&&!u.password&&!u.search&&!u.hash,'请使用 HTTPS 或本机 HTTP 地址，密钥单独填写。');
  return u.href.replace(/\/$/u,'');
}
export async function prepareWorker(p,signal){
  if(p.action!=='worker')return p;
  check(['local','api'].includes(p.mode)&&Object.hasOwn(workerRoles,p.provider),'请选择执行器和连接方式。');
  const endpoint=p.mode==='api'?address(p.endpoint):'';
  const key=p.apiKey??'';
  check(typeof key==='string' && key.length<=2048 && !/[^\x21-\x7e]/u.test(key),'密钥含有无效字符。');
  const sealed=key&&p.mode==='api'?await new WindowsKeyProtection().protect(JSON.stringify([p.provider,endpoint,key]),signal):null;
  return {...p,endpoint,apiKey:undefined,sealed};
}
export function editWorkers(c,p){
  const rows=c.workers??=profiles(c),old=rows.find(x=>x.id===p.id);
  c.selected??={};
  if(p.action==='worker'){
    check(!p.id || old?.provider===p.provider,'原渠道已变化，请刷新。');
    const name=p.name?.trim(),model=(p.model??'').trim(),executable=(p.executable??'').trim(),home=p.mode==='local'?(p.home??'').trim():'';
    check(name && name.length<=48 && !rows.some(x=>x.id!==p.id&&x.provider===p.provider&&x.name===name),'请填写唯一的渠道名称。');
    check(model.length<=160 && !/[\r\n\0]/u.test(model) && (p.mode==='local'||model),'请填写有效的模型名称。');
    for(const path of [home,executable])check(!path || isAbsolute(path)&&!/[\r\n\0]/u.test(path),'客户端和配置目录需填写绝对路径。');
    if(executable)check(existsSync(executable)&&statSync(executable).isFile()&&(process.platform!=='win32'||/\.exe$/iu.test(executable)),'请选择已安装的客户端可执行文件。');
    if(home)check(existsSync(home)&&statSync(home).isDirectory(),'找不到客户端配置目录。');
    const auth=p.provider==='claude' && p.auth==='bearer'?'bearer':'key';
    const secret=p.mode==='api'?(p.sealed || (old?.endpoint===p.endpoint && old?.secret)):null;
    check(p.mode==='local'||secret,'新接口或更换地址后需要填写该地址的密钥。');
    const connection={model,executable,home,mode:p.mode,endpoint:p.endpoint};
    if(p.mode==='api')connection.auth=auth;
    const same=old && !p.sealed && Object.entries(connection).every(([k,v])=>old[k]===v);
    const row={id:p.id||'worker-'+randomUUID(),provider:p.provider,name,model,executable,home,mode:p.mode,endpoint:p.endpoint,auth,enabled:old?.enabled??true,secret:secret||null,stamp:same?old.stamp:randomUUID()};
    if(old)Object.assign(old,row);else rows.push(row);
    if(!selected(c,row.provider))c.selected[row.provider]=row.id;
    return;
  }
  check(old,'渠道已移除，请刷新。');
  if(p.action==='use-worker'){check(old.enabled,'请先启用这个渠道。');c.selected[old.provider]=old.id;}
  else if(p.action==='switch-worker'){check(typeof p.value==='boolean','开关值无效。');old.enabled=p.value;}
  else if(p.action==='remove-worker'){
    if(selected(c,old.provider)?.id===old.id)c.selected[old.provider]=null;
    c.workers=rows.filter(x=>x!==old);
  }else throw Error('未知渠道操作。');
}
export function bindings(directory,peer,claude){
  const c=directory.config(),routes={codex:selected(c,'codex'),claude:selected(c,'claude')};
  function config(provider,base){
    const r=routes[provider];
    if(!r?.enabled)return base;
    const value={...base};
    if(r.model)value.model=r.model;
    if(r.executable)value[provider==='codex'?'codexPath':'claudePath']=r.executable;
    const home=r.mode==='api'?join(directory.root,'clients',r.id):r.home;
    if(home)value[provider==='codex'?'codexHome':'home']=home;
    if(r.mode==='api'){
      value.channelRef={file:directory.file,id:r.id,stamp:r.stamp,provider,endpoint:r.endpoint};
      if(provider==='codex')value.extraArgs=['-c','model_provider="yunshu_channel"','-c','model_providers.yunshu_channel.name="Yunshu"','-c','model_providers.yunshu_channel.wire_api="responses"','-c','model_providers.yunshu_channel.env_key="YUNSHU_CHANNEL_KEY"','-c','model_providers.yunshu_channel.base_url='+JSON.stringify(r.endpoint)];
    }
    return value;
  }
  return {routes,peer:{...peer,config:config('codex',peer.config)},claude:config('claude',claude)};
}
export async function connectionEnv(config,signal){
  const ref=config.channelRef;
  if(!ref)return {};
  const current=JSON.parse(readFileSync(ref.file,'utf8'));
  const row=selected(current,ref.provider);
  check(row?.enabled && row.id===ref.id && row.stamp===ref.stamp && row.endpoint===ref.endpoint,'渠道配置已更改，请核对后接续。');
  const [provider,endpoint,key]=JSON.parse(await new WindowsKeyProtection().unprotect(row.secret,signal));
  check(provider===ref.provider && endpoint===ref.endpoint,'密钥与当前接口不匹配。');
  mkdirSync(provider==='codex'?config.codexHome:config.home,{recursive:true});
  return provider==='codex'?{YUNSHU_CHANNEL_KEY:key}:{ANTHROPIC_BASE_URL:endpoint,ANTHROPIC_AUTH_TOKEN:row.auth==='bearer'?key:'',ANTHROPIC_API_KEY:row.auth==='bearer'?'':key,CLAUDE_CODE_OAUTH_TOKEN:'',CLAUDE_CODE_USE_BEDROCK:'0',CLAUDE_CODE_USE_VERTEX:'0',CLAUDE_CODE_USE_FOUNDRY:'0'};
}
