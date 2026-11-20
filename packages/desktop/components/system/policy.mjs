import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';

export const labels = {master:'云舒总开关',tasks:'任务台',memory:'记忆',voice:'语音',persona:'人格',media:'媒体',coding:'编码协作'};
const path = () => dshHomePath('plugins','yunshu','features.json');
const defaults = Object.fromEntries(Object.keys(labels).map(key=>[key,true]));
const subscribers = new Set();
let current;

export function preferences() {
  if (current) return current;
  let prefs = {};
  try { prefs = JSON.parse(readFileSync(path(),'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') throw Error('功能设置无法读取，请检查云舒工作台的存档。'); }
  for (const key of Object.keys(defaults))
    if (key in prefs && typeof prefs[key] !== 'boolean') throw Error('功能设置中的开关值无效。');
  const extensions=Object.fromEntries(Object.entries(prefs).filter(([k,v])=>/^ext\.[a-z][a-z0-9._-]{1,80}$/.test(k)&&typeof v==='boolean'));
  return current = Object.freeze({...defaults,...Object.fromEntries(Object.keys(defaults).map(k=>[k,prefs[k] ?? defaults[k]])),...extensions});
}
export function enabled(key) { const p=preferences(); return p.master && p[key] === true; }
export function requireFeature(key) { if (!enabled(key)) throw Error(labels[key]+'已关闭，可在云舒的功能开关中启用。'); }
export function changePreference(key,value) {
  if ((!Object.hasOwn(defaults,key) && !/^ext\.[a-z][a-z0-9._-]{1,80}$/.test(key)) || typeof value !== 'boolean') throw Error('无效的功能设置。');
  if (preferences()[key] === value) return current;
  const next = {...current,[key]:value}, target = path(), temp = target+'.'+randomUUID()+'.tmp';
  mkdirSync(dirname(target),{recursive:true});
  try { writeFileSync(temp,JSON.stringify(next,null,2)+'\n',{flag:'wx'}); renameSync(temp,target); }
  finally { try { unlinkSync(temp); } catch(e) { if(e.code!=='ENOENT') throw e; } }
  current = Object.freeze(next);
  for (const notify of subscribers) notify(current);
  return current;
}
export function onChange(ctx,notify) {
  subscribers.add(notify);
  const off=()=>subscribers.delete(notify);
  ctx.effect(()=>off);
  return off;
}
export function toolFeature(name) {
  if (name.startsWith('yunshu_memory_') || name.startsWith('yunshu_observation_')) return 'memory';
  if (name.startsWith('yunshu_media_')) return 'media';
  if (name.startsWith('yunshu_task_')) return 'tasks';
  if (name.startsWith('yunshu_code_') || name==='yunshu_project_review') return 'coding';
  if (name==='yunshu_context_status' || name.startsWith('yunshu_affect_')) return 'persona';
  return 'master';
}
export function featureTool(ctx,definition,available=()=>true) {
  const key=toolFeature(definition.name);
  const canRun=()=>enabled(key) && available();
  return ctx.tools.register({...definition, execute:(...args)=>{
    requireFeature(key);
    if (!available()) throw Error('当前工作台尚未连接这项服务。');
    return definition.execute(...args);
  }},{when:canRun});
}
