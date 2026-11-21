import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import { ToolExecutionPipeline, executeToolBatch } from '@deepseek-ai/dsh-tools/pipeline';
import { registerTaskPlan } from '../packages/desktop/components/system/task-tool.mjs';
import { installRoleTransport } from '../packages/desktop/components/coding/role-transport.mjs';
import { runClaudeRequest } from '../packages/desktop/components/coding/claude-runner.mjs';
import { workflowReason } from '../packages/desktop/components/system/channel-status.mjs';

test('read incomplete tickets and deliver the complete planning brief through the host', async t => {
  const parent=realpathSync(tmpdir()), dir=mkdtempSync(join(parent,'yunshu-task-check-'));
  const prior=process.env.DSH_HOME;
  process.env.DSH_HOME=dir;
  const ctx=new Context();
  t.after(async()=>{
    await ctx.fiber.dispose();
    if(prior===undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME=prior;
    if(dirname(realpathSync(dir))===parent) rmSync(dir,{recursive:true,force:true});
  });
  await ctx.plugin(SystemPrompt,{});
  await ctx.plugin(Tools,{});
  const board={tasks:[
    {id:'legacy',goal:'旧工单',status:'paused'},
    {id:'new',goal:'规划',status:'blocked',native:{phase:'blocked',stage:'plan',acceptance:'七项',canRetry:true}},
    {id:'done',goal:'交付',status:'approved',native:{plan:{steps:['核对']},evidence:{files:[{path:'a.txt'}]},review:{decision:'approved'}}}
  ]};
  ctx.provide('yunshuUnited',{request:async(_agent,action)=>{assert.equal(action,'board');return board;}});
  ctx.provide('yunshuControl',{catalog:()=>[],directory:{config:()=>({channels:[]})}});
  registerTaskPlan(ctx);
  const pipeline=new ToolExecutionPipeline(ctx);
  const agent={session:{header:{cwd:dir}},model:{current:()=>({})}};
  const signal=new AbortController().signal;
  async function call(name,args={}) {
    const toolSet=await ctx.tools.resolve({agent,modelSelection:agent.model.current(),signal});
    try{
      const {results}=await executeToolBatch({agent,toolSet,signal,calls:[{
        type:'tool-call',id:randomUUID(),name,arguments:JSON.stringify(args)
      }]},pipeline,()=>1);
      return results[0].result;
    }finally{toolSet.dispose();}
  }
  const current=await call('yunshu_task_current');
  assert.ok(!current.isError,current.error?.message);
  assert.equal(current.value.plan,null);
  const [legacy,blocked,approved]=current.value.tasks;
  assert.deepEqual(legacy.plan,[]);
  assert.equal(legacy.parentId,null);
  assert.deepEqual(blocked.deliverables,[]);
  assert.equal(blocked.stage,'plan');
  assert.equal(blocked.canRetry,true);
  assert.deepEqual(approved.review,{decision:'approved'});
  assert.deepEqual(approved.deliverables,[{path:'a.txt'}]);

  const fixture=join(dir,'claude-fixture.cjs');
  writeFileSync(fixture,[
    "const fs=require('node:fs'), {randomUUID}=require('node:crypto');",
    "const lines=fs.readFileSync(0,'utf8').trimEnd().split('\\n');",
    "const {binding,material}=JSON.parse(lines.at(-1));",
    "if(!material.goal.endsWith('\\n末尾保留') || process.argv.some(v=>v.includes('末尾保留'))) process.exit(2);",
    "const plan={binding,steps:['按约定核对'],files:[],channels:[]};",
    "process.stdout.write(JSON.stringify({type:'result',subtype:'success',session_id:randomUUID(),result:JSON.stringify(plan)}));"
  ].join('\n'));
  const coordinator={peer:{config:{runTimeoutMs:6000}},claude:{argvPrefix:[fixture],home:dir,runTimeoutMs:6000},
    claudeRunner:runClaudeRequest,resolveWorkspace:()=>dir,
    status:()=>({enabled:true,providers:{claude:{ready:true,executable:process.execPath}}})};
  const workers=installRoleTransport(ctx,coordinator);
  const task={id:'test',goal:'--'+ '含空格的正文 '.repeat(7000)+'\n末尾保留',acceptance:'完整读入',target:''};
  const direct=await call('yunshu_code_stage',{stage:'plan',runId:task.id});
  assert.equal(direct.isError,true);
  const plan=await workers.run(agent,'plan',task,signal);
  assert.equal(plan.provider,'claude');
  assert.deepEqual(plan.steps,['按约定核对']);
  const release=ctx.tools.guard(exec=>exec.name==='yunshu_code_stage'?'本次工序需要用户授权。':undefined);
  try{
    await assert.rejects(workers.run(agent,'plan',task,signal),error=>workflowReason(error)==='本次工序需要用户授权。');
  }finally{release();}
});
