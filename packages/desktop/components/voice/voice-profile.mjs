import { BAILIAN_ENDPOINT, endpointInfo } from './bailian-tts.mjs';
import { BAILIAN_DEFAULTS, BAILIAN_REGIONS } from './bailian.mjs';

export function legacyEndpoint(config = {}) {
  const region = BAILIAN_REGIONS[config.region ?? 'beijing'];
  if (!region) return '';
  return config.workspaceId ? 'https://' + config.workspaceId + '.' + region.workspaceDomain + '/api/v1'
    : config.region === 'singapore' ? 'https://dashscope-intl.aliyuncs.com/api/v1' : BAILIAN_ENDPOINT;
}
export function sharedKey(input, current, legacy = {}) {
  const result = { ...input };
  if (result.mode !== 'bailian' || result.apiKey || result.keepKey !== true) return result;
  const endpoint = endpointInfo(result.endpoint).endpoint;
  if (current.mode === 'bailian' && current.endpoint === endpoint) result.apiKey = current.apiKey;
  else if (legacy.apiKey && legacyEndpoint(legacy) === endpoint) result.apiKey = legacy.apiKey;
  return result;
}
export function asrConfig(config) {
  const info = endpointInfo(config.endpoint), host = new URL(info.endpoint).hostname;
  const workspaceId = host.endsWith('.maas.aliyuncs.com') ? host.split('.')[0] : undefined;
  return { region: info.region, apiKey: config.apiKey, asrModel: BAILIAN_DEFAULTS.asrModel,
    ...(workspaceId ? { workspaceId } : {}), voice: BAILIAN_REGIONS[info.region].voice };
}
export function profileView(tts, legacy = {}) {
  const value = tts.status();
  if (value.keyStorage.source !== 'none' || !legacy.apiKey) return { ...value, activeMode: value.mode };
  const endpoint = legacy.apiKey ? legacyEndpoint(legacy) : BAILIAN_ENDPOINT;
  const region = endpointInfo(endpoint).region;
  return { ...value, mode: 'bailian', endpoint, model: BAILIAN_DEFAULTS.ttsModel,
    voice: BAILIAN_REGIONS[region].voice, hasKey: !!legacy.apiKey, activeMode: value.mode };
}
export function canStreamNative(config) {
  if (config.mode !== 'bailian' || config.model !== BAILIAN_DEFAULTS.ttsModel) return false;
  const { region } = endpointInfo(config.endpoint);
  return region === 'beijing' || ['longanhuan_v3.1','longanlingxin_v3.1','longanfengyue_v3.1','xunanchuan_v3.1'].includes(config.voice);
}

export function legacyUpdate(previous, value) {
  const config = { ...previous, ...value };
  delete config.keyEnv;
  if (previous.region !== value.region) { delete config.workspaceId; delete config.voice; }
  return config;
}

export async function nativeWithFallback(tts, adapter, text, options) {
  const config = tts.config;
  let emitted = false;
  try {
    return await adapter.synthesize(text, { ...options, onAudio: (...args) => {
      emitted = true;
      options.onAudio?.(...args);
    } });
  } catch (error) {
    options.signal?.throwIfAborted();
    if (emitted || !config.fallback) throw error;
    const value = await tts.system(text, config, options.signal);
    return { ...value, fallbackUsed: true, notice: '云端朗读未返回音频，已使用本地语音' };
  }
}
