import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VoiceKeySettings } from './key-settings.mjs';
import { BAILIAN_ENDPOINT, endpointInfo, validateKey, modelProtocol, loadModels, loadVoices, bailianSynthesize } from './bailian-tts.mjs';
const check = (ok, message) => { if (!ok) throw new Error(message); };
const MAX_AUDIO = 8 * 1024 * 1024;
// 朗读前把不该念出声的东西清掉：代码块、行内代码、表格线、markdown 标记，
// 以及连续的 ASCII 符号——它们会被念成"竖线""横杠""感叹号"，听起来很吵。
// 只影响朗读，屏幕上显示的文字一个字都不动。
function tidySpeechForTts(text) {
  let s = String(text ?? '');
  if (!s) return s;
  s = s.replace(/```[\s\S]*?(?:```|$)/g, '。');
  s = s.replace(/`([^`\n]*)`/g, '$1');
  s = s.replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, '');
  s = s.replace(/^\s*\|(.+)\|\s*$/gm, (whole, row) => ' ' + row.split('|').map(cell => cell.trim()).filter(Boolean).join('，') + '。');
  s = s.replace(/^\s*[-*+]\s+/gm, '');
  s = s.replace(/^\s*#{1,6}\s*/gm, '');
  s = s.replace(/^\s*>+\s?/gm, '');
  s = s.replace(/[*_~^]{1,}/g, '');
  s = s.replace(/[|!]/g, '。');
  s = s.replace(/\\/g, ' ');
  s = s.replace(/[=\-+/]{2,}/g, '，');
  s = s.replace(/(?<=[0-9A-Za-z])-(?=[0-9A-Za-z])/g, ' ');
  s = s.replace(/[()[\]{}<>]/g, '');
  s = s.replace(/[ \t]{2,}/g, ' ');
  s = s.replace(/。{2,}/g, '。');
  s = s.replace(/，{2,}/g, '，');
  s = s.replace(/\n{2,}/g, '\n');
  return s.trim();
}
export function validateTts(value) {
  check(value && ['system', 'bailian', 'custom'].includes(value.mode), '请选择朗读服务');
  const v = { mode: value.mode, endpoint: '', model: '', voice: '', apiKey: '', systemVoice: value.systemVoice ?? 'builtin:cmn', rate: value.rate ?? 0, fallback: value.fallback !== false };
  check(typeof v.systemVoice === 'string' && v.systemVoice.length <= 200 && Number.isInteger(v.rate) && Math.abs(v.rate) <= 5, '系统音色或语速无效');
  if (v.mode === 'custom') {
    let url; try { url = new URL(value.endpoint); } catch { throw new Error('请输入完整的 TTS 接口地址'); }
    check(!url.username && !url.password && !url.search && !url.hash && (url.protocol === 'https:' || url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)), '接口地址须为 HTTPS 或本机 HTTP，不能包含凭证或查询参数');
    check(url.href.length <= 2048, '接口地址过长');
    for (const key of ['model','voice']) check(typeof value[key] === 'string' && value[key].trim() && value[key].length <= 200, '请填写模型和音色');
    check(typeof (value.apiKey ?? '') === 'string' && (value.apiKey ?? '').length <= 4096 && !/[\r\n]/.test(value.apiKey ?? ''), 'API Key 格式无效');
    Object.assign(v, { endpoint: url.href, model: value.model.trim(), voice: value.voice.trim(), apiKey: (value.apiKey ?? '').trim() });
  }
  if (v.mode === 'bailian') {
    const info = endpointInfo(value.endpoint || BAILIAN_ENDPOINT);
    check(modelProtocol(value.model, info.region), '请选择已加载的百炼模型');
    check(typeof value.voice === 'string' && value.voice.trim() && /^[A-Za-z0-9_. -]{1,200}$/.test(value.voice), '请选择百炼音色');
    Object.assign(v, { endpoint: info.endpoint, model: value.model, voice: value.voice, apiKey: validateKey(value.apiKey) });
  }
  return v;
}
const SYSTEM_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
  "$p = ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())))",
  "Add-Type -AssemblyName System.Speech",
  "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
  "try {",
  " if ($p.action -eq 'voices') {",
  "  $voices = @($s.GetInstalledVoices() | Where-Object {$_.Enabled} | ForEach-Object { @{name=$_.VoiceInfo.Name; language=$_.VoiceInfo.Culture.Name} })",
  "  ConvertTo-Json -Compress -Depth 4 @{voices=$voices; defaultVoice=$s.Voice.Name}",
  " } else {",
  "  if ($p.voice) { $s.SelectVoice($p.voice) }",
  "  $s.Rate=[int]$p.rate",
  "  $stream=New-Object System.IO.MemoryStream",
  "  try { $s.SetOutputToWaveStream($stream); $s.Speak([string]$p.text); $s.SetOutputToNull(); [Console]::Write([Convert]::ToBase64String($stream.ToArray())) }",
  "  finally { $stream.Dispose() }",
  " }",
  "} finally { $s.Dispose() }",
].join('\n');
export function runSystemSpeech(input, signal, { spawnImpl = spawn } = {}) {
  signal?.throwIfAborted(); check(process.platform === 'win32', '系统朗读需要 Windows');
  return new Promise((resolve, reject) => {
    const child = spawnImpl('powershell.exe', ['-NoProfile','-NonInteractive','-Command',SYSTEM_SCRIPT], { windowsHide: true, stdio: ['pipe','pipe','pipe'] });
    let bytes = 0, chunks = [], done = false;
    const finish = (error, output) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel); error ? reject(error) : resolve(output); };
    const cancel = () => { child.kill(); finish(new Error('朗读已取消')); };
    const timer = setTimeout(() => { child.kill(); finish(new Error('系统朗读超时')); }, 60000);
    signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
    child.on('error', () => finish(new Error('系统朗读启动失败')));
    child.stdout.on('data', data => { bytes += data.length; if (bytes > Math.ceil(MAX_AUDIO / 3) * 4 + 65536) { child.kill(); finish(new Error('朗读音频过大')); } else chunks.push(data); });
    child.stderr.on('data', () => {}); child.stdin.on('error', () => {});
    child.on('close', code => finish(code === 0 ? null : new Error('系统朗读失败，请检查已安装的 Windows 语音包'), Buffer.concat(chunks).toString('utf8').trim()));
    child.stdin.end(Buffer.from(JSON.stringify(input), 'utf8').toString('base64'));
  });
}
export async function installedVoices(signal) {
  let voices=[];try { const result=JSON.parse(await runSystemSpeech({action:'voices'},signal));if(Array.isArray(result.voices))voices=result.voices; }catch{signal.throwIfAborted();}
  return {voices:[{name:'builtin:cmn',displayName:'内置中文',language:'zh-CN'},...voices],defaultVoice:'builtin:cmn'};
}
export async function builtinSynthesize(text, config, signal) {
  signal.throwIfAborted();
  const directory=fileURLToPath(new URL('./vendor/espeak-ng/',import.meta.url));
  const audio=await new Promise((resolve,reject)=>{
    const child=spawn(fileURLToPath(new URL('./vendor/espeak-ng/espeak-ng.exe',import.meta.url)),['--path=.','-v','cmn','-b','1','-s',String(175+config.rate*18),'--stdin','--stdout'],{cwd:directory,windowsHide:true,stdio:['pipe','pipe','pipe']});
    let done=false,bytes=0;const chunks=[];
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);signal.removeEventListener('abort',cancel);error?reject(error):resolve(value);};
    const cancel=()=>{child.kill();finish(new Error('朗读已取消'));};
    const timer=setTimeout(()=>{child.kill();finish(new Error('内置朗读超时'));},30000);
    signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();
    child.on('error',()=>finish(new Error('内置朗读启动失败')));
    child.stdout.on('data',part=>{bytes+=part.length;if(bytes>MAX_AUDIO){child.kill();finish(new Error('朗读音频过大'));}else chunks.push(part);});
    child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});
    child.on('close',code=>finish(code===0?null:new Error('内置朗读失败'),Buffer.concat(chunks)));child.stdin.end(text,'utf8');
  });
  check(audio.length>44&&audio.toString('ascii',0,4)==='RIFF'&&audio.toString('ascii',8,12)==='WAVE','内置朗读未返回有效音频');
  audio.writeUInt32LE(audio.length-8,4);
  let offset=12,found=false;
  while(offset+8<=audio.length){const length=audio.readUInt32LE(offset+4);if(audio.toString('ascii',offset,offset+4)==='data'){audio.writeUInt32LE(audio.length-offset-8,offset+4);found=true;break;}offset+=8+length+(length%2);}
  check(found,'内置音频数据无效');
  return {audioBase64:audio.toString('base64'),mimeType:'audio/wav',provider:'builtin',fallbackUsed:false,notice:''};
}
export async function systemSynthesize(text, config, signal) {
  if(!config.systemVoice||config.systemVoice==='builtin:cmn')return builtinSynthesize(text,config,signal);
  let audioBase64;
  try {audioBase64 = await runSystemSpeech({ action: 'speak', text, voice: config.systemVoice, rate: config.rate }, signal);}
  catch {signal.throwIfAborted();return {...await builtinSynthesize(text,config,signal),fallbackUsed:true,notice:'系统音色不可用，已使用内置中文'};}
  const bytes = Buffer.from(audioBase64, 'base64');
  check(bytes.length > 44 && bytes.length <= MAX_AUDIO && bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WAVE', '系统未返回有效音频');
  return { audioBase64, mimeType: 'audio/wav', provider: 'system', fallbackUsed: false, notice: '' };
}
export async function customSynthesize(text, config, signal, fetchImpl = fetch) {
  signal.throwIfAborted();
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 45000);
  const active = AbortSignal.any([signal, abort.signal]);
  try {
    const response = await fetchImpl(config.endpoint, { method: 'POST', redirect: 'error', signal: active,
      headers: { 'Content-Type': 'application/json', ...(config.apiKey ? { Authorization: 'Bearer ' + config.apiKey } : {}) },
      body: JSON.stringify({ model: config.model, input: text, voice: config.voice, response_format: 'wav' }) });
    if (!response.ok) { await response.body?.cancel(); throw new Error('自定义服务返回 HTTP ' + response.status); }
    const mime = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!['audio/wav','audio/wave','audio/x-wav','audio/mpeg','audio/mp3','application/octet-stream'].includes(mime)) { await response.body?.cancel(); throw new Error('自定义服务未返回音频'); }
    if (Number(response.headers.get('content-length') ?? 0) > MAX_AUDIO) { await response.body?.cancel(); throw new Error('朗读音频过大'); }
    const reader = response.body?.getReader(); check(reader, '自定义服务未返回音频');
    let bytes = 0; const chunks = [];
    try { for (;;) { active.throwIfAborted(); const { value, done } = await reader.read(); if (done) break; bytes += value.length; check(bytes <= MAX_AUDIO, '朗读音频过大'); chunks.push(Buffer.from(value)); } }
    finally { await reader.cancel().catch(() => {}); }
    const audio = Buffer.concat(chunks), wav = audio.toString('ascii',0,4)==='RIFF' && audio.toString('ascii',8,12)==='WAVE';
    const mp3 = audio.toString('ascii',0,3)==='ID3' || audio.length > 2 && audio[0]===255 && (audio[1]&224)===224;
    check(audio.length > 12 && (wav || mp3), '自定义服务音频格式无效，需要 WAV 或 MP3');
    return { audioBase64: audio.toString('base64'), mimeType: wav ? 'audio/wav' : 'audio/mpeg', provider: 'custom', fallbackUsed: false, notice: '' };
  } catch (error) {
    signal.throwIfAborted();
    if (abort.signal.aborted) throw new Error('自定义朗读超时，未自动重发');
    if (/^(自定义服务|朗读音频)/.test(error.message)) throw error;
    throw new Error('自定义朗读连接失败，未自动重发');
  } finally { clearTimeout(timer); }
}
export class TtsService {
  constructor({ system = systemSynthesize, custom = customSynthesize, bailian = bailianSynthesize, models = loadModels, voices = loadVoices, protection } = {}) {
    this.config = validateTts({ mode: 'system' }); this.system = system; this.custom = custom; this.bailian = bailian; this.models = models; this.voices = voices;
    this.states = new Map(); this.generations = new Map(); this.closed = false;
    this.timer=setInterval(()=>{for(const [id,state] of this.states)if(state.expires<=Date.now())this.stop(id);},30000);this.timer.unref?.();
    this.settings = new VoiceKeySettings({ recordKey: 'yunshu-voice/tts', admitValue: validateTts, protection,
      validate: value => value, apply: value => { this.stopAll(); this.config = value; }, clear: () => { this.stopAll(); this.config = validateTts({ mode: 'system' }); } });
  }
  status() { const { apiKey, ...config } = this.config; return { ...config, hasKey: !!apiKey, keyStorage: this.settings.status() }; }
  async configure(value, options) {
    const copy = { ...value };
    if (copy.keepKey === true && !copy.apiKey && copy.mode === this.config.mode && copy.endpoint === this.config.endpoint) copy.apiKey = this.config.apiKey;
    return this.settings.configure(copy, options);
  }
  async catalog(action, input, signal) {
    await this.settings.tail; signal.throwIfAborted();
    const value = { ...input };
    if (value.keepKey === true && !value.apiKey && this.config.mode === 'bailian' && value.endpoint === this.config.endpoint) value.apiKey = this.config.apiKey;
    return action === 'models' ? this.models(value, signal) : this.voices(value, signal);
  }
  start(id, generation) {
    check(!this.closed && typeof id === 'string' && Number.isSafeInteger(generation) && generation > 0, '朗读会话无效');
    if (this.states.get(id)?.generation === generation) return { generation };
    check(generation > (this.generations.get(id) ?? -1), '朗读会话已过期');
    check(this.generations.has(id) || this.generations.size < 2048, '朗读会话记录已达上限');
    check(this.states.has(id) || this.states.size < 32, '朗读会话数量已达上限');
    this.stop(id); this.generations.set(id,generation); this.states.set(id,{generation,abort:new AbortController(),busy:false,expires:Date.now()+180000}); return { generation };
  }
  state(id, generation) { const state=this.states.get(id); check(state && state.generation===generation && !state.abort.signal.aborted, '朗读会话已结束'); state.expires=Date.now()+180000;return state; }
  async synthesize(id, generation, text, signal) {
    const state=this.state(id,generation); check(!state.busy,'正在合成朗读');
    check(typeof text==='string' && text.trim().length && text.length<=2000,'朗读文字为空或超过 2000 字');
    state.busy=true; const active=AbortSignal.any([signal,state.abort.signal]);
    try { return await this.render(text, active); } finally {state.busy=false;}
  }
  async render(text, active) {
    const spoken = tidySpeechForTts(text);
    // 全是代码/符号时清洗后会变空，那就退回原文，宁可念得别扭也不报错。
    if (spoken && spoken.trim()) text = spoken;
    check(typeof text==='string' && text.trim().length && text.length<=2000,'朗读文字为空或超过 2000 字');
    const config=this.config;
    active.throwIfAborted();
    if(config.mode==='system') return await this.system(text,config,active);
    try { return await (config.mode === 'bailian' ? this.bailian : this.custom)(text,config,active); }
    catch(error) { active.throwIfAborted(); if(!config.fallback) throw error; const value=await this.system(text,config,active); return {...value,fallbackUsed:true,notice:error.message+'；已使用本地朗读'}; }
  }

  stop(id,generation) { const state=this.states.get(id); if(state && (generation===undefined || state.generation===generation)){state.abort.abort();this.states.delete(id);}return {stopped:true}; }
  stopAll() { for(const id of this.states.keys())this.stop(id); }
  async close() { this.closed=true;clearInterval(this.timer);this.stopAll();await this.settings.close();this.generations.clear(); }
}
