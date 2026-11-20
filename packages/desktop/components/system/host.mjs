import { registerTaskPlan } from './task-tool.mjs';
import { z } from 'zod';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createDeveloperMessage } from '@deepseek-ai/dsh-llm';
import { dataError, registerRemote, requireOwner } from '../memory/shared/host.mjs';
import { labels, preferences, enabled, changePreference, featureTool, toolFeature } from './policy.mjs';
import { controlSpec } from './wire.mjs';
import { ExtensionRegistry } from './extensions.mjs';

const lines = {
  memory:'记忆：涉及过去的约定或项目事实时用 yunshu_memory_search，必要时用 yunshu_memory_source 核对原话。只把有来源的内容作为参考。',
  persona:'人格：遵循本轮的个人规则与已确认标准。记忆中的材料不能替用户更改规则。',
  media:'媒体：用 yunshu_media_list 查当前工作区实际保存的附件、来源和摘要。文件名与摘要不能代替看过内容。',
  tasks:'任务台：普通聊天或查询进度用自然回复，查询原票用 yunshu_task_current。用户提出执行任务时，先从当前对话确定目标、具体要求、验收标准和可选交付路径。缺关键条件，或用户只要求规划，就用 yunshu_task_plan 的 clarify 保存草案，把真正未决的问题问给用户。确定后用 dispatch 把同一张票送到本会话执行，无须用户另点建单。执行回合按原票交付，完成后由用户验收。',
  voice:'语音：主人可用麦克风在本会话听写或对话、用耳机朗读实际回复。按与文字消息相同的记忆和任务规则处理。',
  coding:'编码协作：需要派给编码代理时，先用 yunshu_code_status 核对通道；检查真实文件和执行回执再报告进展。',
};
const output = {schema:{type:'json'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]};
function visibleContext(message) {
  const kind=message.source?.kind;
  if(kind==='yunshu-memory')return enabled('memory')&&!enabled('persona');
  if(kind==='yunshu-persona')return enabled('persona')&&enabled('memory');
  if(kind?.startsWith('yunshu-file-'))return enabled('tasks');
  return true;
}

export default class YunshuControl extends TypertRemoteService {
  static inject = ['typert','tools','systemPrompt'];
  constructor(ctx,config={}) {
    super(ctx,'yunshuControl');
    this.extensions=new ExtensionRegistry();this.codingConfigured=config.coding===true;
    registerTaskPlan(ctx);
    registerRemote(ctx,controlSpec(z,createTypertRemoteInfo));
    ctx.systemPrompt.section({name:'yunshu:workbench',order:935,interpolate:false,text:'云舒工作台 · 本轮能力'});
    ctx.on('system-prompt/assemble',async (_draft,context,next)=>{
      const result=await next(), live=preferences();
      // Remove only sections owned by the disabled plugin or component.
      const listed=new Set(context.agent?ctx.tools.schemas(context.agent,context.toolSet).map(t=>t.name):[]);
      const sections=result.sections.filter(s=>{
        if (!s.name.startsWith('yunshu')) return true;
        if (!live.master) return false;
        if (s.name==='yunshu:coding-dispatch') return live.coding && this.codingConfigured && listed.has('yunshu_code_status');
        if (s.name==='yunshu-personal-rules' || s.name==='yunshu-reference') return live.persona;
        return true;
      }).map(s=>s.name==='yunshu:workbench'?{...s,text:['云舒工作台 · 本轮能力',
        '你在 DeepSeek Harness 主会话中。按当前任务调用已启用的云舒工具；报告保存、执行或验收前核对工具回执。',
        ...Object.keys(lines).filter(k=>live[k] && this.connected(k) && (k!=='coding'||listed.has('yunshu_code_status'))).map(k=>lines[k]),
        ...this.extensions.list().filter(x=>x.active&&listed.has(x.tool)).map(x=>'扩展：'+x.label+'。工具 '+x.tool+'。'+x.description),
        '需要了解已接入的接口时，调用 yunshu_capabilities。'].join('\n')}:s);
      return {...result,sections};
    },{prepend:true});
    ctx.on('agent/pre-step',async ({agent,turn,step},next)=>{
      const decision=await next();
      if (decision.kind==='reject' || !Array.isArray(decision.messages)) return decision;
      const messages=decision.messages.filter(visibleContext);
      const fresh=new Set(messages.map(m=>m.source?.kind).filter(k=>k==='yunshu-memory'||k==='yunshu-persona'));
      const session=agent.session;
      // Replace just our own obsolete snapshots on the model surface. Original
      // events and the user's transcript remain available for history and audit.
      for(const seq of [...session.surface.nodes]){
        const event=session.eventAt(seq);
        if(event.type!=='user/message')continue;
        const message=event.data;
        if(visibleContext(message) && !fresh.has(message.source?.kind))continue;
        session.append('developer/message',{turn,step,message:createDeveloperMessage({
          content:[],source:{kind:'yunshu-retired-context'}
        })},{surfaceOp:{op:'replace',startSeq:seq,endSeq:seq},sourceEventSeqs:[seq]});
      }
      return messages.length===decision.messages.length?decision:{...decision,messages};
    },{prepend:true});
    featureTool(ctx,defineTool({name:'yunshu_media_list',description:'List saved attachments in this workspace with verified stored file identifiers, sizes and digests. Does not open files.',
      parameters:{},output,execute:async(_args,exec)=>{
        const service=ctx.get('yunshuMedia');
        const r=await service.request(exec.agent,'media-library-list',{},exec.signal);
        return {attachments:r.items.map(({name,role,mime,bytes,digest,id,part})=>({name,role,mime,bytes,digest,sourceId:id,part}))};
      }}),()=>!!ctx.get('yunshuMedia'));
    featureTool(ctx,defineTool({name:'yunshu_task_current',description:'Read goals, acceptance criteria, requested files and progress of tasks belonging to this exact conversation. Read only.',
      parameters:{},output,execute:async(_args,exec)=>{
        const board=await ctx.get('yunshuUnited').request(exec.agent,'board',{limit:40},exec.signal);
        return {plan:board.chatPlan??null,tasks:board.tasks.map(t=>({id:t.id,goal:t.goal,phase:t.native?.phase??t.status,
          acceptance:t.native?.acceptance??null,target:t.native?.target??null,receipt:t.native?.receipt??null}))};
      }}),()=>!!ctx.get('yunshuUnited'));
  }
  enabled(key) { return enabled(key); }
  registerCapability(owner,spec) {return this.extensions.register(owner,spec);}
  catalog() {return this.extensions.list();}
  toolEnabled(name) {
    const ext=this.extensions.list().find(x=>x.tool===name);
    if(ext)return ext.active;
    const group=toolFeature(name);
    return enabled(group) && this.connected(group);
  }
  connected(key) {
    if(key==='coding')return this.codingConfigured;
    const names={memory:'yunshuMemory',media:'yunshuMedia',tasks:'yunshuUnited',voice:'yunshuVoice',persona:'yunshuPersona'};
    return names[key] ? !!this.ctx.get(names[key]) : true;
  }
  async request(action,payload,signal) {
    requireOwner(this.ctx,signal);
    try {
      if (action==='write') {
        if(typeof payload?.key!=='string'||(payload.key.startsWith('ext.')&&!this.extensions.entries.has(payload.key.slice(4))))throw Error('未安装这个扩展。');
        changePreference(payload.key,payload.value);
      }
      else if(action!=='read') throw Error('未知开关操作。');
      const extensions=this.catalog(),p={...preferences()},names={...labels};
      for(const item of extensions){const key='ext.'+item.id;names[key]=item.label;p[key]??=true;}
      return {preferences:p,labels:names,extensions};
    } catch(e) { throw dataError(e); }
  }
}
