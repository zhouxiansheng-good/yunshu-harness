import { createHash,randomUUID } from 'node:crypto';
import { existsSync,mkdirSync,readFileSync,renameSync,unlinkSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { enabled } from './policy.mjs';
import { channelIssue } from './channel-status.mjs';

import { profiles,selected as selectedWorker,settings,editWorkers,workerRoles } from './worker-profiles.mjs';
const defaults=[
  {id:'agents',name:'协作成员',purpose:'建单、规划、执行与审核'},
  {id:'image',name:'图像生成',purpose:'生成图像'},
  {id:'video',name:'视频生成',purpose:'生成视频'}
];
const need=(ok,msg)=>{if(!ok)throw Error(msg);};
const now=()=>new Date().toISOString();
const text=(value,max)=>typeof value==='string' && value.trim() && value.trim().length<=max && !/[\u0000-\u001f]/u.test(value);
const key=/^[a-z][a-z0-9._-]{1,80}$/u;
const short=(state,label,reason,action='')=>({state,label,reason,action});
const configured=()=>short('unverified','待验证','已找到本机配置，尚无近期成功回执。');
const disconnected=()=>short('unavailable','未接入','没有可调用的适配器。','绑定已安装的扩展，或先安装相应插件。');
const off=()=>short('disabled','已关闭','渠道开关已关闭。');
const read=(p,initial)=>existsSync(p)?JSON.parse(readFileSync(p,'utf8')):initial;
function atom(path,value){
  const tmp=path+'.'+randomUUID()+'.tmp';
  writeFileSync(tmp,JSON.stringify(value),{flag:'wx'});renameSync(tmp,path);
}
export class ChannelDirectory {
  constructor(root=dshHomePath('plugins','yunshu','directory')) {
    this.root=root;this.file=join(root,'modules.json');this.busy=new Map();this.probe=null;this.hostFailures=new WeakMap();
  }
  config(){return read(this.file,{revision:0,modules:[],channels:[]});}
  permits(ext){
    const c=this.config(),ch=c.channels.find(x=>x.binding===ext.id);
    return !(c.removedBindings??[]).includes(ext.id) && c.switches?.[ch?.moduleId??ext.moduleId]!==false && c.switches?.['ext.'+ext.id]!==false;
  }
  edit(p) {
    mkdirSync(this.root,{recursive:true});
    const lock=join(this.root,'edit.lock');
    try{writeFileSync(lock,String(process.pid),{flag:'wx'});}
    catch(e){
      if(e.code!=='EEXIST')throw e;
      const pid=Number(readFileSync(lock,'utf8'));
      try{process.kill(pid,0);}catch(check){if(check.code==='ESRCH'){unlinkSync(lock);return this.edit(p);}}
      throw Error('另一个窗口正在保存，请刷新后重试。');
    }
    try{
      const c=this.config();
      if(p.requestId && c.lastRequest===p.requestId)return {revision:c.revision};
      need(p.revision===c.revision,'模块列表已更新，请刷新后重试。');
      const modules=[...defaults,...c.modules,{id:'extensions',name:'其他扩展'}];
      if(['worker','use-worker','switch-worker','remove-worker'].includes(p.action)){editWorkers(c,p);this.probe=null;}
      else if(p.action==='module'){
        need(text(p.name,40) && text(p.purpose,250),'请填写模块名称和用途。');
        const name=p.name.trim();
        need(!modules.some(m=>m.name===name && m.id!==p.id),'已有同名模块。');
        const value={id:p.id??'module-'+randomUUID(),name,purpose:p.purpose.trim()};
        if(p.id){const old=c.modules.find(m=>m.id===p.id);need(old,'请选择自定义模块。');Object.assign(old,value);}
        else c.modules.push(value);
      } else if(p.action==='channel'){
        need(modules.some(m=>m.id===p.moduleId) && text(p.name,48) && text(p.purpose,250),'请填写渠道名称、职责和所属模块。');
        need(!p.binding || key.test(p.binding),'扩展标识无效。');
        const value={id:p.id??'channel-'+randomUUID(),moduleId:p.moduleId,name:p.name.trim(),purpose:p.purpose.trim(),binding:p.binding||null};
        need(!c.channels.some(ch=>ch.id!==p.id && (ch.moduleId===p.moduleId && ch.name===value.name || value.binding && ch.binding===value.binding)),'该渠道名称或扩展已被使用。');
        const former=c.channels.find(x=>x.id===p.id)?.binding;
        if(former && former!==value.binding)c.removedBindings=[...new Set([...(c.removedBindings??[]),former])];
        if(value.binding)c.removedBindings=(c.removedBindings??[]).filter(id=>id!==value.binding);
        if(p.id){const old=c.channels.find(x=>x.id===p.id);need(old,'渠道已经移除。');Object.assign(old,value);}
        else c.channels.push(value);
      } else if(p.action==='switch'){
        need(typeof p.value==='boolean' && (modules.some(m=>m.id===p.id && m.id!=='agents') || /^ext\.[a-z][a-z0-9._-]{1,80}$/u.test(p.id)),'请选择已登记的模块或扩展。');
        c.switches={...c.switches,[p.id]:p.value};
      } else if(p.action==='remove-channel'){
        const former=c.channels.find(x=>x.id===p.id),binding=former?.binding??(p.id?.startsWith('ext.')?p.id.slice(4):null);
        need(former || binding&&key.test(binding),'渠道不存在。');
        if(binding)c.removedBindings=[...new Set([...(c.removedBindings??[]),binding])];
        c.channels=c.channels.filter(x=>x.id!==p.id);
      } else if(p.action==='remove-module'){
        need(c.modules.some(x=>x.id===p.id) && !c.channels.some(x=>x.moduleId===p.id),'请先移走模块中的渠道。');
        c.modules=c.modules.filter(x=>x.id!==p.id);
      } else throw Error('未知的模块操作。');
      c.revision++;c.lastRequest=p.requestId??null;atom(this.file,c);
      return {revision:c.revision};
    } finally {unlinkSync(lock);}
  }
  hostEvent(session,event) {
    if(event.type==='assistant/message' && !event.data.interrupted)this.hostFailures.delete(session);
    if(event.type==='turn/end' && event.data.reason?.kind==='error'){
      const cause=event.data.reason.error??{},header=session.requestHeader?.()??{};
      this.hostFailures.set(session,{provider:header.provider,model:header.model,issue:channelIssue([cause.code,cause.message,cause.status].join(' '))});
    }
  }
  evidenceFile(id) {return join(this.root,'receipts',createHash('sha256').update(id).digest('hex')+'.json');}
  observe(id,fn) {
    this.busy.set(id,(this.busy.get(id)||0)+1);
    const record=issue=>{
      try {mkdirSync(join(this.root,'receipts'),{recursive:true});atom(this.evidenceFile(id),{at:now(),issue});}
      catch { /* A missing diagnostic receipt never changes the worker's actual outcome. */ }
    };
    return Promise.resolve().then(fn).then(v=>{record(null);return v;},e=>{record(channelIssue(e));throw e;})
      .finally(()=>{const n=this.busy.get(id)-1;if(n)this.busy.set(id,n);else this.busy.delete(id);});
  }
  health(id,base) {
    const receipt=read(this.evidenceFile(id),null);
    let info=base;
    if(base.state==='unverified' && this.busy.has(id))info=short('busy','工作中','正在处理已派发的工序。');
    else if(base.state==='unverified' && receipt && Date.now()-Date.parse(receipt.at)<24*60*60*1000)
      info=receipt.issue??short('available','可用','最近一次调用成功。');
    return {...info,lastObservedAt:receipt?.at??null};
  }
  snapshot(agent,control,refresh=false,owner=false) {
    const config=this.config(), entries=control.catalog();
    const modules=[...defaults,...config.modules].map(x=>({...x,enabled:config.switches?.[x.id]!==false,custom:config.modules.some(m=>m.id===x.id),channels:[]}));
    if(config.channels.some(row=>row.moduleId==='extensions'))modules.push({id:'extensions',name:'其他扩展',custom:false,enabled:true,channels:[]});
    const byId=new Map(modules.map(m=>[m.id,m]));
    const append=(moduleId,row)=>byId.get(moduleId).channels.push(row);
    const selection=agent?.model?.current?.(), selected=selection?.model;
    let host=selection?short('unverified','待验证','主聊天已选择模型，等待当前模型的回复。'):
      short('unavailable','未选择模型','主聊天尚未选择模型。','在输入框右下角选择模型。');
    const recent=agent?.session?.surface?.nodes??[];
    for(let i=recent.length-1;i>=0 && i>=recent.length-80 && selection;i--){
      const ev=agent.session.eventAt(recent[i]);
      if(ev.type!=='assistant/message' || ev.data.interrupted)continue;
      const msg=ev.data.message;
      if((msg.source?.model??msg.model)===selected && (msg.source?.provider??msg.provider)===selection.provider && msg.content?.some(b=>b.type==='text'||b.type==='tool-call')){
        host=short('available','可用','当前所选模型已有本会话的响应。');break;
      }
    }
    let failure=this.hostFailures.get(agent?.session);
    const log=agent?.session;
    if(!failure && selection && Number.isSafeInteger(log?.seq)){
      for(let i=log.seq-1;i>=Math.max(0,log.seq-96);i--){
        const event=log.eventAt(i);
        if(!event || !log.isOwnSeq(i))continue;
        if(event.type==='assistant/message')break;
        if(event.type==='turn/end'){
          const cause=event.data.reason;
          const header=log.requestHeader?.()??{};
          if(cause?.kind==='error' && header.model===selected && header.provider===selection.provider)
            failure={...selection,issue:channelIssue([cause.error?.code,cause.error?.message].join(' '))};
          break;
        }
      }
    }
    if(failure && failure.provider===selection?.provider && failure.model===selected)host=failure.issue;
    else if(host.state==='available' && agent?.status==='running')host=short('busy','工作中','正在处理当前会话。');
    append('agents',{id:'deepseek',name:'DeepSeek · 主聊天',purpose:'澄清、建单、派单、退回重建和最终汇报',...host});
    const coding=enabled('coding') && control.codingConfigured,transport=control.taskWorkers;
    if((refresh || this.probe?.revision!==config.revision || Date.now()-this.probe.at>60000) && coding && transport)
      this.probe={at:Date.now(),revision:config.revision,providers:transport.status().providers};
    for(const row of profiles(config)){
      const active=selectedWorker(config,row.provider)?.id===row.id;
      const provider=this.probe?.providers?.[row.provider];
      const base=!coding||!row.enabled?off():!active?short('unverified','备用','选择后用于下一道工序。'):
        !transport?disconnected():provider?.ready?configured():channelIssue(provider?.reason);
      append('agents',{id:row.id,provider:row.provider,name:row.name,purpose:workerRoles[row.provider][1],active,enabled:row.enabled,
        ...(owner?{settings:settings(row)}:{}),...this.health(row.stamp,base),
        ...(!active&&row.enabled&&coding?base:{})});
    }
    const installed=new Map(entries.map(x=>[x.id,x]));
    const placed=new Set();
    const place=(moduleId,ch,ext,manual)=>{
      if(ext)placed.add(ext.id);
      const base=config.switches?.[moduleId]===false?off():!ext?disconnected():ext.active?configured():off();
      append(moduleId,{...ch,manual,binding:ch.binding??ext?.id??null,tool:ext?.tool??null,enabled:ext?config.switches?.['ext.'+ext.id]!==false:null,...(ext?this.health('ext.'+ext.id,base):base)});
    };
    for(const ch of config.channels)if(byId.has(ch.moduleId))place(ch.moduleId,ch,installed.get(ch.binding),true);
    for(const ext of entries)if(!placed.has(ext.id) && !(config.removedBindings??[]).includes(ext.id)){
      const group=byId.has(ext.moduleId)?ext.moduleId:'extensions';
      if(!byId.has(group)){
        const other={id:group,name:'其他扩展',purpose:'已注册的其他能力',channels:[],custom:false};
        byId.set(group,other);modules.push(other);
      }
      place(group,{id:'ext.'+ext.id,name:ext.label,purpose:ext.description},ext,false);
    }
    for(const m of modules){
      m.counts={total:m.channels.length,available:0,busy:0,unverified:0,unavailable:0,disabled:0};
      for(const channel of m.channels)m.counts[channel.state]++;
    }
    return {revision:config.revision,checkedAt:now(),modules,bindings:entries.map(e=>({id:e.id,name:e.label,tool:e.tool}))};
  }
}
