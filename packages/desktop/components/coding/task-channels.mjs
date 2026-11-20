import { randomUUID } from 'node:crypto';
import { existsSync,mkdirSync,readFileSync,renameSync,writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { executeToolBatch } from '@deepseek-ai/dsh-tools/pipeline';

const need=(ok,msg)=>{if(!ok)throw Error(msg);};
const read=file=>JSON.parse(readFileSync(file,'utf8'));
function save(file,data){
  const tmp=file+'.'+randomUUID()+'.tmp';writeFileSync(tmp,JSON.stringify(data),{flag:'wx'});renameSync(tmp,file);
}
export function taskChannels(ctx,pipeline,coordinator) {
  const control=ctx.get('yunshuControl'),active=new Map();
  function catalog(agent) {
    const available=control.catalog().filter(ch=>ch.active);
    const config=control.directory.config();
    return available.map(ch=>{
      const mapping=config.channels.find(row=>row.binding===ch.id);
      const tool=ctx.tools.get(ch.tool,agent);
      return tool?{id:ch.id,name:mapping?.name||ch.label,role:mapping?.purpose||ch.description,
        moduleId:mapping?.moduleId||ch.moduleId,tool:ch.tool,parameters:tool.parameters}:null;
    }).filter(Boolean);
  }
  return {
    catalog,
    authorized:exec=>active.get(exec.callId)?.agent===exec.agent && active.get(exec.callId)?.tool===exec.name,
    async run(task,exec,askGPT) {
      const choices=task.plan.channels??[];
      if(!choices.length)return null;
      const dir=join(coordinator.stateDir,'role-channels',task.id);
      mkdirSync(dir,{recursive:true});
      const channels=catalog(exec.agent);
      const selected=choices.map(id=>{
        const channel=channels.find(x=>x.id===id);
        need(channel,'规划中指定的渠道尚未接入或已关闭。请在能力与渠道中检查。');return channel;
      });
      const requestFile=join(dir,'gpt-requests.json');
      let commands;
      if(existsSync(requestFile)) commands=read(requestFile);
      else{
        const prompt=['你是 GPT 执行员。为这张单选择的每个工具填写真实调用参数。只能使用给出的渠道，遵守其参数格式及约定的文件范围。不要填写凭据。每个渠道请求一次。只输出 JSON {"requests":[{"id":"渠道标识","args":{}}]}。',
          JSON.stringify({goal:task.goal,acceptance:task.acceptance,steps:task.plan.steps,files:task.plan.files,corrections:task.corrections,channels:selected})].join('\n');
        const response=await askGPT(prompt);
        const requests=JSON.parse(response.text.replace(/^```(?:json)?\s*|\s*```$/giu,'')).requests;
        need(Array.isArray(requests) && requests.length===choices.length &&
          choices.every(id=>requests.filter(x=>x.id===id).length===1) &&
          requests.every(x=>x.args && typeof x.args==='object'&&!Array.isArray(x.args)),'GPT 未交回可执行的渠道参数。');
        commands={runId:response.runId,sessionId:response.sessionId,requests};save(requestFile,commands);
      }
      const receipts=[];
      for(const [i,request] of commands.requests.entries()){
        exec.signal.throwIfAborted();
        const tool=selected.find(x=>x.id===request.id)?.tool;
        need(tool,'渠道与本单规划不一致。');
        const output=join(dir,i+'.json'),intent=join(dir,i+'.started');
        if(existsSync(output)){receipts.push(read(output));continue;}
        need(!existsSync(intent),'该渠道已收到请求，回执尚未确认。请核对原请求后继续。');
        const toolSet=await ctx.tools.resolve({agent:exec.agent,modelSelection:exec.agent.model.current(),signal:exec.signal});
        const id=randomUUID();
        try{
          need(ctx.tools.get(tool,exec.agent,toolSet),'当前会话不能调用这个渠道。');
          writeFileSync(intent,JSON.stringify({id,channel:request.id}),{flag:'wx'});
          active.set(id,{agent:exec.agent,tool});
          const {results}=await executeToolBatch({agent:exec.agent,signal:exec.signal,toolSet,calls:[
            {type:'tool-call',id,name:tool,arguments:JSON.stringify(request.args)}
          ]},pipeline,()=>1);
          const reply=results[0]?.result;
          if(reply?.isError)throw Error(reply.content?.find(x=>x.type==='text')?.text||'渠道调用失败。');
          const value=reply?.value;
          need(value?.capability===request.id && Array.isArray(value.artifacts),'渠道没有交回可核对的产物回执。');
          const receipt={channel:request.id,name:selected.find(x=>x.id===request.id).name,callId:id,summary:value.summary,artifacts:value.artifacts};
          save(output,receipt);receipts.push(receipt);
        } finally {active.delete(id);toolSet.dispose();}
      }
      return {provider:'codex',runId:commands.runId,sessionId:commands.sessionId,receipts};
    }
  };
}

