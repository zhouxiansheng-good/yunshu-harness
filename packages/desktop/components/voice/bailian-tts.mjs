import { readFileSync } from 'node:fs';
export const BAILIAN_ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1';
const MAX_JSON = 2 * 1024 * 1024, MAX_AUDIO = 8 * 1024 * 1024;
const check = (ok, message) => { if (!ok) throw new Error(message); };
const catalog = JSON.parse(readFileSync(new URL('./bailian-voices.json', import.meta.url), 'utf8'));
export function endpointInfo(value = BAILIAN_ENDPOINT) {
  let url; try { url = new URL(value); } catch { throw new Error('请输入百炼接口地址'); }
  const host = url.hostname;
  const beijing = host === 'dashscope.aliyuncs.com' || /^[a-z0-9-]+[.]cn-beijing[.]maas[.]aliyuncs[.]com$/.test(host);
  const singapore = host === 'dashscope-intl.aliyuncs.com' || /^[a-z0-9-]+[.]ap-southeast-1[.]maas[.]aliyuncs[.]com$/.test(host);
  check(url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.search && !url.hash && (beijing || singapore), '百炼接口须使用北京或新加坡的官方 HTTPS 地址');
  check(['/api/v1', '/api/v1/', '/'].includes(url.pathname), '百炼接口地址请填写到 /api/v1');
  return { endpoint: url.origin + '/api/v1', region: beijing ? 'beijing' : 'singapore' };
}
export function validateKey(value) {
  check(typeof value === 'string' && value.trim().length > 0 && value.length <= 4096 && !Array.from(value.trim()).some(c => c.charCodeAt(0) < 33 || c.charCodeAt(0) > 126), '请填写有效的百炼 API Key');
  return value.trim();
}
export function modelProtocol(model, region = 'beijing') {
  if (typeof model !== 'string') return null;
  if (model === 'qwen3-tts-flash') return 'qwen3';
  if (/^qwen-audio-3[.][01]-tts-(flash|plus)$/.test(model)) return 'native';
  if (region === 'beijing' && /^cosyvoice-(v2|v3(?:[.]5)?-(flash|plus))$/.test(model)) return 'native';
  return null;
}
export function systemVoices(model, endpoint) {
  const { region } = endpointInfo(endpoint);
  return catalog.voices.filter(v => v.models.includes(model) && v.regions.includes(region)).map(v => ({ id: v.id, label: v.label, source: 'system' }));
}
async function readBounded(response, maxBytes, signal) {
  if (Number(response.headers.get('content-length') || 0) > maxBytes) { await response.body?.cancel(); throw new Error('百炼响应超过大小限制'); }
  const reader = response.body?.getReader(); check(reader, '百炼返回为空');
  const chunks = []; let total = 0;
  try { for (;;) { signal.throwIfAborted(); const { done, value } = await reader.read(); if (done) break; total += value.length; check(total <= maxBytes, '百炼响应超过大小限制'); chunks.push(Buffer.from(value)); } }
  finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}
function httpError(status, stage) {
  if (status === 401) return new Error(stage + '失败：API Key 无效，或与所选地域不一致（401）');
  if (status === 403) return new Error(stage + '失败：当前 Key 没有权限，请检查业务空间（403）');
  if (status === 404 || status === 405) return new Error(stage + '接口不可用，请填写控制台提供的业务空间专属接口地址（' + status + '）');
  if (status === 429) return new Error(stage + '请求过于频繁，请稍后刷新（429）');
  return new Error(stage + '失败（HTTP ' + status + '）');
}
async function jsonRequest(url, config, signal, fetchImpl, stage, body) {
  signal.throwIfAborted();
  const response = await fetchImpl(url, { method: body ? 'POST' : 'GET', redirect: 'error', signal, headers: { Authorization: 'Bearer ' + config.apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) { await response.body?.cancel(); throw httpError(response.status, stage); }
  const bytes = await readBounded(response, MAX_JSON, signal);
  let data; try { data = JSON.parse(bytes.toString('utf8')); } catch { throw new Error(stage + '返回格式无效'); }
  if (data.code || Number(data.status_code || 200) >= 400) {
    const code = typeof data.code === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(data.code) ? data.code : 'ProviderError';
    throw new Error(stage + '失败（' + code + '）');
  }
  return data;
}
async function bounded(signal, stage, operation, timeout = 20000) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout);
  const active = AbortSignal.any([signal, controller.signal]);
  try { active.throwIfAborted(); return await operation(active); }
  catch (error) { signal.throwIfAborted(); if (controller.signal.aborted) throw new Error(stage + '超时，请稍后重试'); if (/^(百炼|模型|音色|我的音色)/.test(error.message)) throw error; throw new Error(stage + '连接失败，请检查网络和接口地址'); }
  finally { clearTimeout(timer); controller.abort(); }
}
export async function loadModels(input, signal, fetchImpl = fetch) {
  const config = { ...endpointInfo(input.endpoint), apiKey: validateKey(input.apiKey) };
  return bounded(signal, '模型列表', async active => {
    const all = new Map(); let complete = false;
    for (let page = 1; page <= 20; page++) {
      const url = new URL(config.endpoint + '/models');
      url.searchParams.append('capabilities', 'TTS'); url.searchParams.append('capabilities', 'Realtime-Text-to-Speech');
      url.searchParams.set('page_no', String(page)); url.searchParams.set('page_size', '100');
      const data = await jsonRequest(url.href, config, active, fetchImpl, '模型列表');
      check(Array.isArray(data.output?.models), '模型列表返回格式无效');
      const rows = data.output.models;
      for (const row of rows) if (typeof row.model === 'string' && row.model.length <= 200) all.set(row.model, row);
      if (rows.length < 100 || (Number.isFinite(data.output.total) && page * 100 >= data.output.total)) { complete = true; break; }
    }
    check(complete, '模型列表超过 2000 项，请缩小查询范围');
    const supported = [...all.keys()].filter(id => modelProtocol(id, config.region));
    const preferred = ['qwen-audio-3.1-tts-flash', 'qwen-audio-3.1-tts-plus', 'qwen3-tts-flash', 'cosyvoice-v3-flash', 'cosyvoice-v3-plus'];
    supported.sort((a, b) => (preferred.indexOf(a) < 0 ? 999 : preferred.indexOf(a)) - (preferred.indexOf(b) < 0 ? 999 : preferred.indexOf(b)) || a.localeCompare(b));
    return { models: supported.map(id => ({ id, label: id })), region: config.region, endpoint: config.endpoint, source: 'api', unsupportedCount: all.size - supported.length, notice: supported.length ? '模型列表已读取' : '未读取到当前插件支持的语音模型，请检查地域与业务空间' };
  });
}
export async function loadVoices(input, signal, fetchImpl = fetch) {
  const config = { ...endpointInfo(input.endpoint), apiKey: validateKey(input.apiKey) };
  check(modelProtocol(input.model, config.region), '音色对应的模型尚未接入');
  const voices = systemVoices(input.model, config.endpoint), warnings = [];
  if (modelProtocol(input.model, config.region) === 'native') {
    try {
      const own = await bounded(signal, '我的音色', async active => {
        const rows = new Map(); let complete = false;
        for (let page = 0; page < 20; page++) {
          const data = await jsonRequest(config.endpoint + '/services/audio/tts/customization', config, active, fetchImpl, '我的音色', { model: 'voice-enrollment', input: { action: 'list_voice', page_index: page, page_size: 100 } });
          check(Array.isArray(data.output?.voice_list), '我的音色列表返回格式无效');
          for (const row of data.output.voice_list) if (row.status === 'OK' && typeof row.voice_id === 'string' && /^[A-Za-z0-9_.-]{1,200}$/.test(row.voice_id)) rows.set(row.voice_id, row);
          if (data.output.voice_list.length < 100) { complete = true; break; }
        }
        check(complete, '我的音色超过 2000 项，未加载完整列表');
        const pending=[...rows.values()].filter(row=>typeof row.target_model!=='string');
        check(pending.length<=200, '我的音色有超过 200 项需要查询详情，本次仅显示系统音色');
        let cursor=0;
        await Promise.all(Array.from({length:Math.min(4,pending.length)},async()=>{
          while(cursor<pending.length){
            active.throwIfAborted();const row=pending[cursor++];
            const detail=await jsonRequest(config.endpoint+'/services/audio/tts/customization',config,active,fetchImpl,'我的音色',{model:'voice-enrollment',input:{action:'query_voice',voice_id:row.voice_id}});
            check(typeof detail.output?.target_model==='string'&&typeof detail.output?.status==='string','我的音色详情返回格式无效');
            row.target_model=detail.output.target_model;row.status=detail.output.status;
          }
        }));
        return [...rows.values()].filter(row=>row.target_model===input.model&&row.status==='OK').map(row=>({id:row.voice_id,label:row.voice_id,source:'account'}));
      });
      voices.push(...own);
    } catch (error) { signal.throwIfAborted(); warnings.push(error.message); }
  }
  return { voices: [...new Map(voices.map(v => [v.id, v])).values()], model: input.model, endpoint: config.endpoint, systemSource: 'official-catalog', catalogDate: catalog.checkedAt, warnings, notice: voices.length ? '音色列表已更新' : '该模型暂无可选音色，请在百炼创建匹配的音色或选择其他模型' };
}
export async function bailianSynthesize(text, input, signal, fetchImpl = fetch) {
  const config = { ...input, ...endpointInfo(input.endpoint), apiKey: validateKey(input.apiKey) };
  const protocol = modelProtocol(config.model, config.region); check(protocol, '百炼模型尚未接入');
  check(typeof config.voice === 'string' && config.voice.trim() && /^[A-Za-z0-9_. -]{1,200}$/.test(config.voice), '请选择百炼音色');
  check(typeof text === 'string' && text.trim() && text.length <= (protocol === 'qwen3' ? 600 : 2000), '百炼单次朗读文字过长，请分段朗读');
  return bounded(signal, '百炼朗读', async active => {
    const body = { model: config.model, input: { text, voice: config.voice, ...(protocol === 'qwen3' ? { language_type: 'Chinese' } : { format: 'wav', sample_rate: 24000 }) } };
    const route = protocol === 'qwen3' ? '/services/aigc/multimodal-generation/generation' : '/services/audio/tts/SpeechSynthesizer';
    const data = await jsonRequest(config.endpoint + route, config, active, fetchImpl, '百炼朗读', body);
    let audio;
    if (typeof data.output?.audio?.data === 'string' && data.output.audio.data.length) {
      check(data.output.audio.data.length <= Math.ceil(MAX_AUDIO / 3) * 4, '百炼音频过大'); audio = Buffer.from(data.output.audio.data, 'base64');
    } else {
      let url; try { url = new URL(data.output?.audio?.url); } catch { throw new Error('百炼未返回音频地址'); }
      check(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.port && url.hostname.endsWith('.aliyuncs.com'), '百炼返回的音频地址无效');
      url.protocol = 'https:';
      const response = await fetchImpl(url.href, { method: 'GET', redirect: 'error', signal: active });
      if (!response.ok) { await response.body?.cancel(); throw new Error('百炼音频下载失败（HTTP ' + response.status + '）'); }
      audio = await readBounded(response, MAX_AUDIO, active);
    }
    const wav = audio.toString('ascii', 0, 4) === 'RIFF' && audio.toString('ascii', 8, 12) === 'WAVE';
    const mp3 = audio.toString('ascii', 0, 3) === 'ID3' || audio.length > 2 && audio[0] === 255 && (audio[1] & 224) === 224;
    check(audio.length > 44 && audio.length <= MAX_AUDIO && (wav || mp3), '百炼返回的音频格式无效');
    return { audioBase64: audio.toString('base64'), mimeType: wav ? 'audio/wav' : 'audio/mpeg', provider: 'bailian', fallbackUsed: false, notice: '' };
  }, 60000);
}
