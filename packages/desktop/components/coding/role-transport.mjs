import { randomUUID } from 'node:crypto';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { ToolExecutionPipeline, executeToolBatch } from '@deepseek-ai/dsh-tools/pipeline';
import { enabled, requireFeature } from '../system/policy.mjs';
import { toolFailure } from '../system/channel-status.mjs';
import { makeRoleWorker } from './role-worker.mjs';
import { taskChannels } from './task-channels.mjs';

// The same host approval pipeline as a normal tool call. Only the task router can
// admit this internal tool, and it supplies the ticket itself, never model arguments.
export function installRoleTransport(ctx, coordinator) {
  const pipeline = new ToolExecutionPipeline(ctx);
  const channels=taskChannels(ctx,pipeline,coordinator);
  const worker=makeRoleWorker(coordinator,channels);
  const admissions = new WeakSet();
  const calls = new Map();
  const name = 'yunshu_code_stage';
  ctx.tools.register(defineTool({
    name, description:'Run the specific Claude planning/review or Codex execution stage bound by the Yunshu task router.',
    timeoutMs:coordinator.peer.config.runTimeoutMs + 45000,
    parameters:{runId:{type:'string',required:true},stage:{type:'string',required:true}},
    output:{schema:{type:'json'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
    execute:({runId,stage},exec)=>{
      requireFeature('tasks'); requireFeature('coding');
      const input = calls.get(exec.callId);
      if (!input || input.agent!==exec.agent || input.task.id!==runId || input.stage!==stage) throw Error('此步骤需要任务台的原始派单。');
      calls.delete(exec.callId);
      return worker.run(stage,input.task,exec);
    }
  }),{when:context=>admissions.has(context) && enabled('tasks') && enabled('coding')});
  return {
    authorizedChannel:channels.authorized,
    status:()=>coordinator.status(true),
    preflight:stage=>worker.preflight(stage),
    async run(agent,stage,task,signal) {
      requireFeature('tasks'); requireFeature('coding');
      const context = {agent,modelSelection:agent.model.current(),signal};
      admissions.add(context);
      const id = randomUUID();
      let toolSet;
      try {
        toolSet = await ctx.tools.resolve(context);
        calls.set(id,{agent,stage,task});
        const {results} = await executeToolBatch({agent,toolSet,signal,calls:[
          {type:'tool-call',id,name,arguments:JSON.stringify({runId:task.id,stage})}
        ]},pipeline,()=>1);
        const result = results.find(entry=>entry.callId===id)?.result;
        if (!result || result.isError || !result.value) {
          throw toolFailure(result,'执行器没有交回结果，请核对权限与连接。');
        }
        return result.value;
      } finally { calls.delete(id); admissions.delete(context); toolSet?.dispose(); }
    }
  };
}

