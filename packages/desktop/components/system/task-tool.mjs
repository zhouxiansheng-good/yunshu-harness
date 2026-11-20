import { defineTool } from '@deepseek-ai/dsh-tools';
import { featureTool } from './policy.mjs';

export function registerTaskPlan(ctx){
  const output={schema:{type:'json'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]};
  featureTool(ctx,defineTool({
    name:'yunshu_task_plan',
    description:'DeepSeek is the dispatcher. Save an incomplete brief with clarify. When the requested work and acceptance criteria are clear, dispatch once. Claude Code plans, GPT via Codex executes, and a fresh Claude Code session reviews the actual delivery. Follow the returned nextAction. For changes_requested call yunshu_task_route with rework and this runId. For report_to_user give the reviewed deliverables, findings and report.code in a visible reply. A blocked or paused ticket stays with its assigned worker.',
    timeoutMs:3600000,
    parameters:{
      stage:{type:'string',enum:['clarify','dispatch'],required:true},
      modules:{type:'array',items:{type:'string'},description:'Requested specialist module IDs from yunshu_task_channels, e.g. image or video. Required for work expressly asking to use a generation channel. Omit for ordinary writing and coding.'},
      goal:{type:'string',required:true,description:'Goal and requirements as agreed in the conversation.'},
      acceptance:{type:'string',description:'Observable acceptance criteria. Required to dispatch.'},
      target:{type:'string',description:'Optional workspace-relative output path. Omit for a chat deliverable.'},
      questions:{type:'array',items:{type:'string'},description:'Only consequential unresolved questions. Empty for dispatch.'},
      planId:{type:'string',description:'The ID of the existing clarification draft when continuing it.'},
      newTask:{type:'boolean',description:'Only set to true for an explicitly separate new task, including an intentional repeat. Otherwise reuse the current brief and respect edits made in the panel.'}
    },output,
    execute:(args,exec)=>ctx.get('yunshuUnited').planFromChat(exec.agent,args,exec.signal),
  }),()=>Boolean(ctx.get('yunshuUnited')?.chatPlans));
  featureTool(ctx,defineTool({
    name:'yunshu_task_route',description:'DeepSeek dispatches an existing board ticket without doing the work. rework creates one linked replacement from the real Claude rejection and routes it, keeping the original requirements. Use resume for a user-requested retry, report for a verified delivery. Continue rework on changes_requested. On report_to_user deliver the actual result and include report.code.',
    timeoutMs:3600000,
    parameters:{action:{type:'string',enum:['dispatch','resume','rework','report','pause'],required:true},runId:{type:'string',required:true}},
    output,execute:({action,runId},exec)=>action==='pause'
      ?ctx.get('yunshuUnited').request(exec.agent,'session-task',{action:'pause',runId},exec.signal)
      :ctx.get('yunshuUnited').routeFromChat(exec.agent,{action,runId},exec.signal)
  }),()=>Boolean(ctx.get('yunshuUnited')?.routeFromChat));
}
