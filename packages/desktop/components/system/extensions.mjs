import { createHash } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { enabled, preferences, labels, onChange } from './policy.mjs';

const idPattern=/^[a-z][a-z0-9._-]{1,80}$/;
const toolPattern=/^yunshu_ext_[a-z][a-z0-9_]{1,45}$/;
const output={schema:{type:'json'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}],
  presentationMeta:(_args,value)=>({yunshuExtension:{capability:value.capability,artifacts:value.artifacts}})};
const within=(root,name)=>{const r=relative(root,name);return r && r!=='..' && !r.startsWith('..'+sep) && !isAbsolute(r);};

async function receipt(result,cwd,signal) {
  if (!result || typeof result.summary!=='string' || result.summary.length>12000 ||
      !Array.isArray(result.artifacts) || result.artifacts.length>32) throw Error('扩展返回的结果格式无效。');
  const artifacts=[];
  for(const item of result.artifacts){
    signal.throwIfAborted();
    if(!item || typeof item.path!=='string' || !item.path || isAbsolute(item.path) ||
      typeof item.mime!=='string'||!/^[-\w.+]+\/[-\w.+]+$/.test(item.mime))throw Error('扩展产物路径或类型无效。');
    const root=await realpath(cwd),target=await realpath(resolve(root,item.path));
    if(!within(root,target))throw Error('扩展产物超出了当前工作区。');
    const handle=await open(target,'r');
    try{
      const before=await handle.stat(); if(!before.isFile())throw Error('扩展产物不是文件。');
      const hash=createHash('sha256'),buf=Buffer.alloc(65536);let size=0;
      for(;;){signal.throwIfAborted();const {bytesRead}=await handle.read(buf,0,buf.length,size);if(!bytesRead)break;hash.update(buf.subarray(0,bytesRead));size+=bytesRead;}
      const after=await handle.stat();
      if(size!==before.size||before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw Error('扩展产物在核对时变更。');
      artifacts.push({path:relative(root,target).split(sep).join('/'),mime:item.mime,bytes:size,sha256:hash.digest('hex')});
    }finally{await handle.close();}
  }
  return {summary:result.summary,artifacts};
}

export class ExtensionRegistry {
  entries=new Map();
  constructor(observe=(_id,fn)=>fn(),permits=()=>true) {this.observe=observe;this.permits=permits;this.listeners=new Set();}
  refresh(){for(const notify of this.listeners)notify();}
  list(){return [...this.entries.values()].map(x=>({...x,active:this.active(x)}));}
  active(x){return enabled(x.group) && preferences()['ext.'+x.id]!==false && this.permits(x);}
  register(owner,spec) {
    if (!owner?.tools?.register||!owner?.effect||!idPattern.test(spec?.id)||!toolPattern.test(spec.tool)||
        !Object.hasOwn(labels,spec.group)||spec.group==='master'||typeof spec.label!=='string'||!spec.label.trim()||
        spec.label.length>48||typeof spec.description!=='string'||!spec.description.trim()||spec.description.length>400||
        !spec.parameters||typeof spec.run!=='function')throw Error('扩展注册信息不完整。');
    if(this.entries.has(spec.id)||this.list().some(x=>x.tool===spec.tool))throw Error('扩展或工具名已经注册。');
    const entry={id:spec.id,label:spec.label,group:spec.group,description:spec.description,tool:spec.tool,tools:[spec.tool],
      moduleId:idPattern.test(spec.moduleId??'')?spec.moduleId:null};
    const calls=new Set();
    const canRun=()=>this.entries.get(entry.id)===entry && this.active(entry);
    const invoke=async(args,exec)=>{
      if(!canRun())throw Error('扩展已关闭或已卸载。');
      const session=exec.agent?.session;
      if(!session?.id || !isAbsolute(session.header?.cwd||''))throw Error('扩展需要已选定的会话工作区。');
      const abort=new AbortController(),signal=AbortSignal.any([abort.signal,exec.signal]);calls.add(abort);
      try {
        signal.throwIfAborted();
        const value=await spec.run(args,{sessionId:session.id,cwd:session.header.cwd,signal});
        signal.throwIfAborted();if(!canRun())throw Error('扩展已关闭。');
        return {capability:entry.id,...await receipt(value,session.header.cwd,signal)};
      } finally {calls.delete(abort);}
    };
    const definition=defineTool({name:entry.tool,description:entry.description,parameters:spec.parameters,output,
      execute:(args,exec)=>this.observe(entry.id,()=>invoke(args,exec))});
    const unregister=owner.tools.register(definition,{when:canRun});
    this.entries.set(entry.id,entry);
    const stop=()=>{for(const c of calls)c.abort();};
    const check=()=>{if(!canRun())stop();};
    this.listeners.add(check);
    const off=onChange(owner,check);
    const dispose=()=>{if(this.entries.get(entry.id)===entry){this.entries.delete(entry.id);this.listeners.delete(check);stop();off();unregister();}};
    owner.effect(()=>dispose);return dispose;
  }
}
