import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {isDeepStrictEqual as same} from 'node:util';
// Dedicated offline assessment, not the daily tool and never a promote/submit receipt.
export const objective='交付 rank-list-v1 双文件：candidate.json 包含原票号 ticket 和 priority 数组；order.txt 为同一顺序的逐行导出。';
export const acceptance='顺序为 urgent、normal、defer；导出使用 LF，每项一行，含末尾换行。';
const contractSha256=createHash('sha256').update(objective+'\n\n验收：'+acceptance).digest('hex');
function measure(stage){return new Promise((resolve,reject)=>{
  const p=execFile('python',['-I','-B','-X','utf8',join(import.meta.dirname,'quality-stage-grade.py')],
    {cwd:import.meta.dirname,windowsHide:true,timeout:60000,maxBuffer:128*1024,encoding:'utf8'},(err,out)=>{
      if(err){reject(err);return;}try{resolve(JSON.parse(out));}catch(e){reject(e);}});
  p.stdin.on('error',reject);p.stdin.end(JSON.stringify(stage));
});}
export async function assessRankTicket(co,ticketId){
  const stage=await co.initialTextStage(ticketId);if(!stage.ready)return {status:'held',reason:stage.reason};
  if(stage.contractSha256!==contractSha256 || !same(Object.keys(stage.files).sort(),['candidate.json','order.txt']))return {status:'held',reason:'grader-contract-mismatch'};
  const measurement=await measure(stage);
  if(typeof measurement?.passed!=='boolean' || !same(measurement.files,stage.files) ||
     (measurement.passed && (measurement.reason!=='measured' || measurement.proofs?.length!==2 ||
      !measurement.proofs.every((v,i)=>v.passed===true && v.readSha256===stage.files[['candidate.json','order.txt'][i]]))))
    throw Error('invalid independent measurement');
  const current=await co.initialTextStage(ticketId,'read');
  if(!same(current,stage))return {status:'held',reason:current.reason??'stage-no-longer-current'};
  return {status:measurement.passed?'passed':'failed',ticketId,requestSha256:stage.requestSha256,candidateSha256:stage.candidateSha256,measurement};
}
