import { defineTool } from '@deepseek-ai/dsh-tools';
import { featureTool } from './policy.mjs';

export function registerTaskPlan(ctx){
  const output={schema:{type:'json'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]};
  featureTool(ctx,defineTool({
    name:'yunshu_task_plan',
    description:'Write the current user’s task into the visible task board. Use clarify for an incomplete brief or a planning-only conversation. Record material open questions and ask the user in the main chat. Use dispatch once the user’s requested work, goal and acceptance criteria are clear. This creates a real task and queues it in the same session. Invoke once per task. Use yunshu_task_current to inspect progress. Do not call from an already dispatched execution turn.',
    parameters:{
      stage:{type:'string',enum:['clarify','dispatch'],required:true},
      goal:{type:'string',required:true,description:'Goal and requirements as agreed in the conversation.'},
      acceptance:{type:'string',description:'Observable acceptance criteria. Required to dispatch.'},
      target:{type:'string',description:'Optional workspace-relative output path. Omit for a chat deliverable.'},
      questions:{type:'array',items:{type:'string'},description:'Only consequential unresolved questions. Empty for dispatch.'},
      planId:{type:'string',description:'The ID of the existing clarification draft when continuing it.'},
      newTask:{type:'boolean',description:'Only set to true for an explicitly separate new task, including an intentional repeat. Otherwise reuse the current brief and respect edits made in the panel.'}
    },output,
    execute:(args,exec)=>ctx.get('yunshuUnited').request(exec.agent,'chat-plan',args,exec.signal),
  }),()=>Boolean(ctx.get('yunshuUnited')?.chatPlans));
}
