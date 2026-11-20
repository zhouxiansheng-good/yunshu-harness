import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';

export const BAILIAN_REGIONS = Object.freeze({
  beijing: Object.freeze({ asr: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime', tts: 'wss://dashscope.aliyuncs.com/api-ws/v1/inference', workspaceDomain: 'cn-beijing.maas.aliyuncs.com', voice: 'yeqinghe_v3.1' }),
  singapore: Object.freeze({ asr: 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime', tts: 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/inference', workspaceDomain: 'ap-southeast-1.maas.aliyuncs.com', voice: 'longanlingxin_v3.1' }),
});
export const BAILIAN_DEFAULTS = Object.freeze({
  region: 'beijing', asrModel: 'qwen3-asr-flash-realtime', ttsModel: 'qwen-audio-3.1-tts-flash', voice: 'yeqinghe_v3.1',
  ttsSampleRate: 24000, connectTimeoutMs: 15000, timeoutMs: 120000,
  limits: Object.freeze({ maxAudioSeconds: 60, chunkBytes: 3200, maxQueuedBytes: 512 * 1024, maxBufferedBytes: 256 * 1024,
    maxServerEventBytes: 256 * 1024, maxInboundQueueBytes: 1024 * 1024, maxInboundMessages: 64,
    maxTextChars: 12000, maxTranscriptChars: 65536, maxTranscriptItems: 128, maxOutputBytes: 24 * 1024 * 1024, maxConcurrentSessions: 4 }),
});
const MESSAGES = Object.freeze({
  INVALID_CONFIG: '语音配置无效。', NOT_CONFIGURED: '尚未配置百炼 API Key。',
  WEBSOCKET_FACTORY_REQUIRED: '需要支持握手请求头的 WebSocket 工厂。',
  UNSUPPORTED_MODEL: '该模型尚未由此协议适配器支持。', UNSUPPORTED_VOICE_REGION: '该音色尚未确认支持所选地域。',
  INVALID_PCM: '需要单声道、有符号 16 位小端 PCM 字节。', INVALID_TEXT: '合成文本必须为非空字符串。',
  INPUT_LIMIT: '输入超过语音适配器限制。', QUEUE_LIMIT: '待发送语音数据超过队列限制。', OUTPUT_LIMIT: '语音服务响应超过大小限制。',
  SESSION_LIMIT: '并发语音任务已达上限。', INVALID_STATE: '语音任务已结束或正在结束。',
  CONNECTION_FAILED: '无法建立语音服务连接。', CONNECTION_CLOSED: '语音服务连接在任务完成前关闭。', SEND_FAILED: '无法发送语音数据。',
  TIMEOUT: '语音服务响应超时。', CANCELLED: '语音任务已取消。', REMOTE_ERROR: '语音服务返回错误，请检查模型、地域和账户配置。',
  PROTOCOL_ERROR: '语音服务响应不符合当前协议。', CALLBACK_ERROR: '语音结果回调执行失败。',
  INCOMPLETE_RESULT: '语音服务结束但未确认完整结果。', EMPTY_AUDIO: '语音服务未返回音频。',
});
// Never expose arbitrary server errors, causes, request text or credentials.
export class BailianError extends Error {
  constructor(code, delivery, stage) {
    const safe = Object.hasOwn(MESSAGES, code) ? code : 'PROTOCOL_ERROR';
    const interrupted = ['CONNECTION_FAILED', 'CONNECTION_CLOSED', 'SEND_FAILED', 'TIMEOUT'].includes(safe);
    super(MESSAGES[safe] + (interrupted && delivery ? delivery === 'not-sent' ? '请求尚未发出。' : '请求可能已处理，不会自动重发。' : ''));
    this.name = 'BailianError'; this.code = safe;
    const stages = { 'server-json': '服务事件解析', 'asr-binary-json': '识别二进制事件解析', 'asr-fields': '识别文本字段', 'asr-item': '识别轮次标识', 'asr-order': '识别事件顺序' };
    if (Object.hasOwn(stages, stage)) { this.stage = stage; this.message += '（' + stages[stage] + '）'; }
    if (delivery) this.delivery = delivery;
  }
  toJSON() { return { name: this.name, code: this.code, message: this.message, ...(this.delivery ? { delivery: this.delivery } : {}), ...(this.stage ? { stage: this.stage } : {}) }; }
}
const fail = code => new BailianError(code);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (v, low, high) => Number.isSafeInteger(v) && v >= low && v <= high;
// Deliberately limited to the four verified multilingual/dialect voices.
const BOTH_REGION_VOICES = new Set(['longanhuan_v3.1', 'longanlingxin_v3.1', 'longanfengyue_v3.1', 'xunanchuan_v3.1']);
function deferred() {
  let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {}); return { promise, resolve, reject };
}
function bytesOf(v) {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  throw fail('INVALID_PCM');
}
function validateOptions(o, names) {
  if (!record(o)) throw fail('INVALID_CONFIG');
  if (o.signal !== undefined && (typeof o.signal?.aborted !== 'boolean' || typeof o.signal.addEventListener !== 'function' || typeof o.signal.removeEventListener !== 'function')) throw fail('INVALID_CONFIG');
  for (const name of names) if (o[name] !== undefined && typeof o[name] !== 'function') throw fail('INVALID_CONFIG');
}
// 识别上下文（contextual biasing）：把领域词表和记忆库里已确认的事实
// 作为 input_audio_transcription.corpus.text 发给服务端，
// 让模型按我们的正确写法纠正同音字，而不是只靠声学判断。
const ASR_CORPUS_TTL_MS = 60000;
let asrCorpusCache = { at: 0, key: '', text: '' };
function readCorpusText(file) {
  try { return readFileSync(file, 'utf8'); } catch { return ''; }
}
function memoryCorpusText() {
  try {
    const db = new DatabaseSync(dshHomePath('plugins', 'yunshu-memory', 'memory.sqlite'), { readOnly: true });
    try {
      const rows = db.prepare("SELECT kind,subject,predicate,value FROM yunshu_observations WHERE state='confirmed' AND kind<>'observation' ORDER BY observed_at DESC LIMIT 120").all();
      const words = [];
      for (const row of rows) {
        let value;
        try { value = JSON.parse(row.value); } catch { continue; }
        // 只取短词：句子里夹带的口误会反过来污染识别，
        // 所以长文本、含空白的片段一律不要。
        if (typeof value !== 'string') continue;
        const word = value.trim();
        if (!word || word.length > 12 || /\s/.test(word)) continue;
        if (!words.includes(word)) words.push(word);
      }
      return words.join(' ');
    } finally { db.close(); }
  } catch { return ''; }
}
function asrCorpusText(settings) {
  const custom = settings?.asrCorpusPath || dshHomePath('plugins', 'yunshu-voice', 'asr-corpus.txt');
  const now = Date.now();
  if (asrCorpusCache.key === custom && now - asrCorpusCache.at < ASR_CORPUS_TTL_MS) return asrCorpusCache.text;
  const parts = [];
  const words = readCorpusText(custom).trim();
  if (words) parts.push(words);
  const facts = memoryCorpusText();
  if (facts) parts.push('已知领域词汇：' + facts);
  const text = parts.join('\n').slice(0, 40000);
  asrCorpusCache = { at: now, key: custom, text };
  return text;
}
// 口语清洗：只做最保守的三件事——合并整词重复、去掉句首纯语气词、
// 去掉被标点夹住的"嗯/啊/呃"。不动单字叠词（刚刚/看看/谢谢），也不改语义，
// 说错的内容仍然原样保留，靠对话层理解，不在这一层替用户改口。
const SPEECH_FILLER_HEAD = /^(?:嗯+|啊+|呃+|哦+|唉+|哎+|唉呀)[，,。、\s]*/;
function tidySpeech(text) {
  let s = String(text ?? '').replace(/[ \t]+/g, ' ').trim();
  if (!s) return s;
  s = s.replace(/([我你他她它这那就是在有的了吧])\1{2,}/g, '$1');
  s = s.replace(/([\u4e00-\u9fa5]{2,4})\1+/g, '$1');
  let previous;
  do { previous = s; s = s.replace(SPEECH_FILLER_HEAD, ''); } while (s !== previous && s);
  s = s.replace(/([，,、])\s*(?:嗯+|啊+|呃+|哦+|唉+|哎+)\s*[，,、]/g, '$1');
  return s.trim();
}
function configure(config) {
  if (!record(config) || (config.limits !== undefined && !record(config.limits))) throw fail('INVALID_CONFIG');
  const region = config.region ?? BAILIAN_DEFAULTS.region;
  if (!Object.hasOwn(BAILIAN_REGIONS, region)) throw fail('INVALID_CONFIG');
  const s = { ...BAILIAN_DEFAULTS, ...config, region, voice: config.voice ?? BAILIAN_REGIONS[region].voice, limits: { ...BAILIAN_DEFAULTS.limits, ...config.limits } };
  delete s.apiKey; delete s.keyEnv;
  if (s.asrModel !== BAILIAN_DEFAULTS.asrModel || s.ttsModel !== BAILIAN_DEFAULTS.ttsModel) throw fail('UNSUPPORTED_MODEL');
  if (!integer(s.timeoutMs, 1, 600000) || !integer(s.connectTimeoutMs, 1, 600000) || ![8000, 16000, 22050, 24000, 44100, 48000].includes(s.ttsSampleRate)) throw fail('INVALID_CONFIG');
  if (typeof s.voice !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(s.voice)) throw fail('INVALID_CONFIG');
  if (region === 'singapore' && !BOTH_REGION_VOICES.has(s.voice)) throw fail('UNSUPPORTED_VOICE_REGION');
  if (s.workspaceId !== undefined && (typeof s.workspaceId !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(s.workspaceId))) throw fail('INVALID_CONFIG');
  if (s.language !== undefined && (typeof s.language !== 'string' || !/^[a-z]{2,3}(?:-[A-Za-z]{2,8})?$/.test(s.language))) throw fail('INVALID_CONFIG');
  const l = s.limits;
  for (const name of Object.keys(l)) {
    if (!Object.hasOwn(BAILIAN_DEFAULTS.limits, name)) throw fail('INVALID_CONFIG');
    if (name === 'maxAudioSeconds') { if (!Number.isFinite(l[name]) || l[name] <= 0 || l[name] > 600) throw fail('INVALID_CONFIG'); }
    else if (!integer(l[name], 1, 256 * 1024 * 1024)) throw fail('INVALID_CONFIG');
  }
  if (l.chunkBytes % 2 || l.chunkBytes > 65536 || l.maxTextChars > 20000 || l.maxTranscriptItems > 1024 || l.maxConcurrentSessions > 32 ||
      l.maxBufferedBytes < Math.max(1024, Math.ceil(l.chunkBytes / 3) * 4 + 256) || l.maxQueuedBytes < l.maxBufferedBytes || l.maxInboundQueueBytes < l.maxServerEventBytes) throw fail('INVALID_CONFIG');
  return s;
}

// One bounded connection, with no implicit retries, remote fallback or logging.
class Operation {
  constructor(context, options) {
    this.context = context; this.options = options; this.settings = context.settings;
    this.readyState = deferred(); this.result = deferred(); this.queue = []; this.queuedBytes = 0; this.inbox = []; this.inboxBytes = 0;
    this.listeners = []; this.opened = false; this.protocolReady = false; this.terminal = false; this.pumping = false; this.reading = false;
    this.abortHandler = () => this.cancel();
  }
  start(url) {
    if (this.options.signal?.aborted) { this.cancel(); return; }
    this.options.signal?.addEventListener('abort', this.abortHandler, { once: true });
    this.deadline = setTimeout(() => this.reject('TIMEOUT'), this.settings.timeoutMs);
    this.handshake = setTimeout(() => this.reject('TIMEOUT'), this.settings.connectTimeoutMs);
    try {
      this.ws = this.context.connect(url);
      if (!this.ws || typeof this.ws.send !== 'function' || typeof this.ws.close !== 'function') throw fail('INVALID_CONFIG');
      this.emitter = typeof this.ws.on === 'function' && (typeof this.ws.off === 'function' || typeof this.ws.removeListener === 'function');
      if (!this.emitter && (typeof this.ws.addEventListener !== 'function' || typeof this.ws.removeEventListener !== 'function')) throw fail('INVALID_CONFIG');
      if (this.terminal) { this.cleanup(); return; }
      try { this.ws.binaryType = 'arraybuffer'; } catch {}
      const open = () => {
        if (this.terminal || this.opened) return;
        this.opened = true;
        try { this.onOpen(); this.pump(); } catch { this.reject('PROTOCOL_ERROR'); }
      };
      this.listen('open', open);
      this.listen('message', (event, binary) => this.receive(this.emitter ? event : event.data, this.emitter ? binary : undefined));
      this.listen('error', () => this.reject('CONNECTION_FAILED'));
      this.listen('close', () => this.reject('CONNECTION_CLOSED'));
      if (this.ws.readyState === 1) queueMicrotask(open);
      if (this.ws.readyState === 2 || this.ws.readyState === 3) this.reject('CONNECTION_CLOSED');
    } catch { this.reject('CONNECTION_FAILED'); }
  }
  listen(name, fn) { if (this.emitter) this.ws.on(name, fn); else this.ws.addEventListener(name, fn); this.listeners.push([name, fn]); }
  markReady() { if (this.terminal || this.protocolReady) return; this.protocolReady = true; clearTimeout(this.handshake); this.readyState.resolve(); this.pump(); }
  enqueue(event, { requiresReady = true, first = false } = {}) {
    const d = deferred();
    if (this.terminal) { d.reject(this.error ?? fail('INVALID_STATE')); return d.promise; }
    const text = JSON.stringify(event), size = Buffer.byteLength(text);
    if (size > this.settings.limits.maxBufferedBytes || this.queuedBytes + size > this.settings.limits.maxQueuedBytes) { this.reject('QUEUE_LIMIT'); d.reject(this.error); return d.promise; }
    const item = { text, size, requiresReady, ...d };
    if (first) this.queue.unshift(item); else this.queue.push(item);
    this.queuedBytes += size; this.pump(); return d.promise;
  }
  pump() {
    if (this.pumping || this.terminal || !this.opened) return;
    clearTimeout(this.pumpTimer); this.pumpTimer = undefined; this.pumping = true;
    try {
      while (!this.terminal && this.queue.length) {
        const item = this.queue[0];
        if (item.requiresReady && !this.protocolReady) break;
        if (this.ws.readyState !== 1) { this.reject('CONNECTION_CLOSED'); break; }
        if ((Number(this.ws.bufferedAmount) || 0) + item.size > this.settings.limits.maxBufferedBytes) { this.pumpTimer = setTimeout(() => this.pump(), 5); break; }
        this.queue.shift(); this.queuedBytes -= item.size;
        try {
          // A failing send callback cannot prove the peer did not consume it.
          this.sendAttempted = true;
          if (this.emitter) this.ws.send(item.text, error => { if (error) this.reject('SEND_FAILED'); }); else this.ws.send(item.text);
          if (this.error) item.reject(this.error); else item.resolve();
        } catch { this.reject('SEND_FAILED'); item.reject(this.error); }
      }
    } finally { this.pumping = false; }
  }
  receive(data, binary) {
    if (this.terminal || this.cancelling) return;
    const size = typeof data === 'string' ? Buffer.byteLength(data) : data?.byteLength ?? data?.size;
    if (!Number.isSafeInteger(size) || size < 0) { this.reject('PROTOCOL_ERROR'); return; }
    const l = this.settings.limits;
    if (size > l.maxServerEventBytes || this.inboxBytes + size > l.maxInboundQueueBytes || this.inbox.length >= l.maxInboundMessages) { this.reject('OUTPUT_LIMIT'); return; }
    this.inbox.push({ data, size, binary: binary === undefined ? typeof data !== 'string' : Boolean(binary) });
    this.inboxBytes += size; void this.readInbox();
  }
  async readInbox() {
    if (this.reading || this.terminal) return;
    this.reading = true;
    try {
      while (this.inbox.length && !this.terminal) {
        const item = this.inbox.shift(); let data = item.data;
        if (typeof data !== 'string' && !(data instanceof Uint8Array) && !(data instanceof ArrayBuffer)) {
          if (typeof data?.arrayBuffer !== 'function') { this.reject('PROTOCOL_ERROR'); break; }
          data = await data.arrayBuffer();
        }
        if (this.terminal) break;
        this.inboxBytes -= item.size;
        if (item.binary) {
          const bytes = bytesOf(data);
          if (bytes.byteLength !== item.size) { this.reject('PROTOCOL_ERROR'); break; }
          await this.onBinary(bytes);
        } else {
          const str = typeof data === 'string' ? data : Buffer.from(bytesOf(data)).toString('utf8');
          const message = JSON.parse(str);
          if (!record(message)) { this.reject('PROTOCOL_ERROR'); break; }
          await this.onMessage(message);
        }
      }
    } catch { this.reject('PROTOCOL_ERROR', 'server-json'); } finally { this.reading = false; }
  }
  async call(name, ...args) { try { await this.options[name]?.(...args); } catch { this.reject('CALLBACK_ERROR'); } }
  onBinary() { this.reject('PROTOCOL_ERROR'); }
  cancel() { if (this.terminal) return; this.cancelling = true; try { this.beforeCancel?.(); } catch {} this.reject('CANCELLED'); }
  reject(code, stage) { if (this.terminal) return; this.error = new BailianError(code, this.sendAttempted ? 'possibly-sent' : 'not-sent', stage); this.terminal = true; this.readyState.reject(this.error); this.result.reject(this.error); this.cleanup(); }
  complete(value) { if (this.terminal) return; this.terminal = true; this.result.resolve(value); this.cleanup(); }
  cleanup() {
    clearTimeout(this.deadline); clearTimeout(this.handshake); clearTimeout(this.pumpTimer);
    this.options.signal?.removeEventListener('abort', this.abortHandler);
    for (const item of this.queue) item.reject(this.error ?? fail('INVALID_STATE'));
    this.queue = []; this.queuedBytes = 0; this.inbox = []; this.inboxBytes = 0;
    const ws = this.ws;
    if (ws) {
      for (const [name, fn] of this.listeners) { if (this.emitter) (ws.off ?? ws.removeListener).call(ws, name, fn); else ws.removeEventListener?.(name, fn); }
      // ws emits an error when terminating a CONNECTING socket. Drain only
      // shutdown events without retaining the operation or its credentials.
      if (this.emitter && ws.readyState !== 3) {
        const ignore = () => {};
        const remove = () => { (ws.off ?? ws.removeListener).call(ws, 'error', ignore); (ws.off ?? ws.removeListener).call(ws, 'close', remove); };
        ws.on('error', ignore); ws.on('close', remove);
      }
      try { if (this.error && typeof ws.terminate === 'function') ws.terminate(); else if (ws.readyState !== 3) ws.close(1000); } catch {}
    }
    this.listeners = []; this.context.release();
  }
}

class AsrOperation extends Operation {
  constructor(context, options, rate) { super(context, options); this.sampleRate = rate; this.audioBytes = 0; this.items = new Map(); this.itemHints = new Set(); this.unboundPreview = null; this.localFinal = null; this.singleLocalFinal = false; this.localIdentity = null; this.finishing = false; this.start(context.asrUrl); }
  event(type, extra = {}) { return { event_id: randomUUID(), type, ...extra }; }
  async onBinary(bytes) {
    let message;
    try { message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { this.reject('PROTOCOL_ERROR', 'asr-binary-json'); return; }
    if (!record(message)) { this.reject('PROTOCOL_ERROR', 'asr-binary-json'); return; }
    await this.onMessage(message);
  }
  onOpen() {
    const session = { modalities: ['text'], input_audio_format: 'pcm', sample_rate: this.sampleRate, turn_detection: null };
    const transcription = {};
    if (this.settings.language) transcription.language = this.settings.language;
    const corpus = asrCorpusText(this.settings);
    if (corpus) transcription.corpus = { text: corpus };
    if (Object.keys(transcription).length) session.input_audio_transcription = transcription;
    void this.enqueue(this.event('session.update', { session }), { requiresReady: false, first: true });
  }
  appendPcm(input) {
    if (this.terminal || this.finishing) throw this.error ?? fail('INVALID_STATE');
    let bytes; try { bytes = bytesOf(input); } catch { this.reject('INVALID_PCM'); throw this.error; }
    if (bytes.length % 2) { this.reject('INVALID_PCM'); throw this.error; }
    // Bound the bookkeeping for a single append even with tiny custom chunks.
    // transcribePcm handles larger recordings using sequential bounded appends.
    if (Math.ceil(bytes.length / this.settings.limits.chunkBytes) > 1024) { this.reject('INPUT_LIMIT'); throw this.error; }
    if (this.audioBytes + bytes.length > this.settings.limits.maxAudioSeconds * this.sampleRate * 2) { this.reject('INPUT_LIMIT'); throw this.error; }
    const sent = []; this.audioBytes += bytes.length;
    for (let at = 0; at < bytes.length && !this.terminal; at += this.settings.limits.chunkBytes) {
      sent.push(this.enqueue(this.event('input_audio_buffer.append', { audio: Buffer.from(bytes.subarray(at, at + this.settings.limits.chunkBytes)).toString('base64') })));
    }
    const promise = Promise.all(sent).then(() => { if (this.error) throw this.error; }); void promise.catch(() => {}); return promise;
  }
  finish() {
    if (!this.terminal && !this.finishing) {
      this.finishing = true;
      if (this.audioBytes) void this.enqueue(this.event('input_audio_buffer.commit'));
      if (!this.terminal) void this.enqueue(this.event('session.finish'));
    }
    return this.result.promise;
  }
  async onMessage(m) {
    if (m.type === 'error' || m.type === 'conversation.item.input_audio_transcription.failed') { this.reject('REMOTE_ERROR'); return; }
    if (m.type === 'session.updated') { this.markReady(); return; }
    if (m.type === 'input_audio_buffer.committed' || m.type === 'conversation.item.created') {
      const id = m.type === 'input_audio_buffer.committed' ? m.item_id : m.item?.id;
      if (typeof id === 'string' && id && id.length <= 256) {
        if (this.localIdentity && this.localIdentity !== id) { this.reject('PROTOCOL_ERROR', 'asr-item'); return; }
        if (this.singleLocalFinal && ([...this.items.keys(), ...this.itemHints].some(key => key !== id))) { this.reject('PROTOCOL_ERROR', 'asr-item'); return; }
        if (!this.itemHints.has(id) && this.itemHints.size >= this.settings.limits.maxTranscriptItems) { this.reject('OUTPUT_LIMIT'); return; }
        this.itemHints.add(id);
        if (this.localFinal != null) { this.items.set(id, { final: true, text: this.localFinal }); this.localFinal = null; }
      }
      return;
    }
    if (m.type === 'session.finished') {
      if (!this.protocolReady || !this.finishing) { this.reject('PROTOCOL_ERROR', 'asr-order'); return; }
      if (this.unboundPreview !== null || [...this.items.values()].some(item => !item.final) || [...this.itemHints].some(id => !this.items.get(id)?.final)) { this.reject('INCOMPLETE_RESULT'); return; }
      if (this.items.size > 1 && [...this.items.keys()].some(id => !this.itemHints.has(id))) { this.reject('PROTOCOL_ERROR', 'asr-order'); return; }
      const ordered = this.localFinal != null ? [{ final: true, text: this.localFinal }] : this.items.size > 1 ? [...this.itemHints].map(id => this.items.get(id)) : [...this.items.values()];
      this.complete({ text: tidySpeech(ordered.filter(item => item.final).map(item => item.text).join('\n')), sampleRate: this.sampleRate, audioSeconds: this.audioBytes / (this.sampleRate * 2) });
      this.items.clear(); return;
    }
    const partial = m.type === 'conversation.item.input_audio_transcription.text', final = m.type === 'conversation.item.input_audio_transcription.completed';
    if (!partial && !final) return;
    if (!this.protocolReady) { this.reject('PROTOCOL_ERROR', 'asr-order'); return; }
    if ((final && typeof m.transcript !== 'string') || (partial && ((m.text != null && typeof m.text !== 'string') || (m.stash != null && typeof m.stash !== 'string')))) { this.reject('PROTOCOL_ERROR', 'asr-fields'); return; }
    const text = final ? m.transcript : (m.text ?? '') + (m.stash ?? '');
    let id = typeof m.item_id === 'string' && m.item_id && m.item_id.length <= 256 ? m.item_id : null;
    if (partial && this.singleLocalFinal) {
      if (id) {
        if (this.localIdentity && this.localIdentity !== id || [...this.items.keys(), ...this.itemHints].some(key => key !== id)) { this.reject('PROTOCOL_ERROR', 'asr-item'); return; }
        this.localIdentity = id;
      }
      return;
    }
    if (partial && !id) {
      // Preview belongs to this local recording, not a fabricated server item.
      // Never append previews to final results or use per-event IDs as item IDs.
      if (this.items.size && [...this.items.values()].every(item => item.final) && [...this.itemHints].every(key => this.items.get(key)?.final)) return;
      const total = [...this.items.values()].reduce((n, item) => n + item.text.length, 0) + text.length;
      if (total > this.settings.limits.maxTranscriptChars) { this.reject('OUTPUT_LIMIT'); return; }
      this.unboundPreview = text;
      if (text) await this.call('onPartial', text);
      return;
    }
    if (final && !id) {
      // Only an unambiguous server commit/created association can fill a
      // missing final ID. An arbitrary last preview is not sufficient.
      if (m.item_id != null && m.item_id !== '') { this.reject('PROTOCOL_ERROR', 'asr-item'); return; }
      if (this.itemHints.size === 1) id = [...this.itemHints][0];
      else if (this.singleLocalFinal && this.items.size === 1) id = [...this.items.keys()][0];
      else if (this.finishing && this.audioBytes > 0 && !this.items.size && !this.itemHints.size) {
        // This adapter opens a distinct socket and commits once per local turn.
        // Keep an ID-less final local; do not fabricate a remote item identity.
        if (text.length > this.settings.limits.maxTranscriptChars) { this.reject('OUTPUT_LIMIT'); return; }
        if (this.localFinal != null) { if (this.localFinal !== text) this.reject('PROTOCOL_ERROR', 'asr-item'); return; }
        this.singleLocalFinal = true; this.localFinal = text; this.unboundPreview = null;
        await this.call('onFinal', text); return;
      }
      else { this.reject('PROTOCOL_ERROR', 'asr-item'); return; }
    }
    if (this.singleLocalFinal) {
      if (this.localIdentity && this.localIdentity !== id) { this.reject('PROTOCOL_ERROR', 'asr-item'); return; }
      if ([...this.items.keys(), ...this.itemHints].some(key => key !== id)) { this.reject('PROTOCOL_ERROR', 'asr-item'); return; }
      if (this.localFinal != null) {
        if (this.localFinal !== text) { this.reject('PROTOCOL_ERROR', 'asr-item'); return; }
        this.items.set(id, { final: true, text }); this.localFinal = null; return;
      }
    }
    const old = this.items.get(id);
    if (old?.final) {
      if (final && (!m.item_id || this.singleLocalFinal) && old.text !== text) this.reject('PROTOCOL_ERROR', 'asr-item');
      return;
    }
    if (!old && this.items.size >= this.settings.limits.maxTranscriptItems) { this.reject('OUTPUT_LIMIT'); return; }
    const total = [...this.items.values()].reduce((n, item) => n + item.text.length, 0) - (old?.text.length ?? 0) + text.length;
    if (total > this.settings.limits.maxTranscriptChars) { this.reject('OUTPUT_LIMIT'); return; }
    this.unboundPreview = null;
    this.items.set(id, { final, text }); await this.call(final ? 'onFinal' : 'onPartial', text);
  }
  cleanup() { this.items?.clear(); this.itemHints?.clear(); this.unboundPreview = null; this.localFinal = null; this.localIdentity = null; this.singleLocalFinal = false; super.cleanup(); }
}

class TtsOperation extends Operation {
  constructor(context, options, text) { super(context, options); this.taskId = randomUUID(); this.text = text; this.chunks = []; this.outputBytes = 0; this.started = false; this.finishing = false; this.start(context.ttsUrl); }
  event(action, payload) { return { header: { action, task_id: this.taskId, streaming: 'duplex' }, payload }; }
  onOpen() {
    void this.enqueue(this.event('run-task', { task_group: 'audio', task: 'tts', function: 'SpeechSynthesizer', model: this.settings.ttsModel,
      parameters: { text_type: 'PlainText', voice: this.settings.voice, format: 'pcm', sample_rate: this.settings.ttsSampleRate, enable_ssml: false }, input: {} }), { requiresReady: false, first: true });
  }
  onMessage(m) {
    if (!record(m.header)) { this.reject('PROTOCOL_ERROR'); return; }
    if (m.header.task_id !== this.taskId) return;
    if (m.header.event === 'task-failed') { this.reject('REMOTE_ERROR'); return; }
    if (m.header.event === 'task-started') {
      if (this.started) return;
      this.started = true; this.markReady(); this.finishing = true;
      void this.enqueue(this.event('continue-task', { input: { text: this.text } })); this.text = '';
      if (!this.terminal) void this.enqueue(this.event('finish-task', { input: {} }));
    } else if (m.header.event === 'task-finished') {
      if (!this.started || !this.finishing) { this.reject('PROTOCOL_ERROR'); return; }
      if (!this.outputBytes) { this.reject('EMPTY_AUDIO'); return; }
      if (this.outputBytes % 2) { this.reject('PROTOCOL_ERROR'); return; }
      const audio = new Uint8Array(this.outputBytes); let at = 0;
      for (const chunk of this.chunks) { audio.set(chunk, at); at += chunk.length; }
      this.complete({ audio, format: 'pcm', sampleRate: this.settings.ttsSampleRate, channels: 1 });
    }
  }
  async onBinary(bytes) {
    if (!this.started) { this.reject('PROTOCOL_ERROR'); return; }
    if (this.outputBytes + bytes.length > this.settings.limits.maxOutputBytes) { this.reject('OUTPUT_LIMIT'); return; }
    if (!bytes.length) return;
    this.outputBytes += bytes.length; this.chunks.push(Uint8Array.from(bytes));
    await this.call('onAudio', Uint8Array.from(bytes), { sampleRate: this.settings.ttsSampleRate, format: 'pcm', channels: 1 });
  }
  beforeCancel() {
    if (this.started && this.ws?.readyState === 1) {
      const message = JSON.stringify(this.event('finish-task', { input: { directive: 'cancel' } }));
      if ((Number(this.ws.bufferedAmount) || 0) + Buffer.byteLength(message) <= this.settings.limits.maxBufferedBytes) this.ws.send(message);
    }
  }
  cleanup() { this.text = ''; this.chunks = []; super.cleanup(); }
}

export class BailianVoiceAdapter {
  #settings; #apiKey; #factory; #active = 0;
  constructor(config = {}, { webSocketFactory, env = process.env } = {}) {
    this.#settings = configure(config); this.#factory = webSocketFactory;
    if (webSocketFactory !== undefined && typeof webSocketFactory !== 'function') throw fail('INVALID_CONFIG');
    if (config.apiKey !== undefined && config.keyEnv !== undefined) throw fail('INVALID_CONFIG');
    if (config.keyEnv !== undefined && (typeof config.keyEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(config.keyEnv))) throw fail('INVALID_CONFIG');
    let key;
    try { key = config.apiKey !== undefined ? config.apiKey : config.keyEnv ? env?.[config.keyEnv] : undefined; } catch { throw fail('INVALID_CONFIG'); }
    if (key !== undefined && (typeof key !== 'string' || !key.trim() || key.length > 4096 || /[\r\n\x00-\x1f\x7f]/.test(key))) throw fail('INVALID_CONFIG');
    this.#apiKey = key?.trim();
  }
  capabilities() {
    const s = this.#settings;
    return { provider: 'bailian', configured: Boolean(this.#apiKey), transportConfigured: typeof this.#factory === 'function', region: s.region,
      asr: { model: s.asrModel, protocol: 'qwen-asr-realtime-websocket', inputFormat: 'pcm_s16le', channels: 1, sampleRates: [8000, 16000], streamingInput: true, partialTranscripts: true, turnDetection: 'manual' },
      tts: { model: s.ttsModel, protocol: 'dashscope-task-websocket', voice: s.voice, format: 'pcm', sampleRate: s.ttsSampleRate, channels: 1, streamingAudio: true, streamingText: false },
      limits: { ...s.limits }, unsupported: ['server-vad', 'qwen3-tts-realtime', 'http-tts', 'cosyvoice', 'voice-cloning', 'ssml', 'webrtc', 'automatic-reconnect'] };
  }
  #context() {
    if (!this.#apiKey) throw fail('NOT_CONFIGURED');
    if (!this.#factory) throw fail('WEBSOCKET_FACTORY_REQUIRED');
    if (this.#active >= this.#settings.limits.maxConcurrentSessions) throw fail('SESSION_LIMIT');
    this.#active++; let released = false;
    const s = this.#settings, region = BAILIAN_REGIONS[s.region], base = s.workspaceId ? 'wss://' + s.workspaceId + '.' + region.workspaceDomain : null;
    return { settings: s, asrUrl: (base ? base + '/api-ws/v1/realtime' : region.asr) + '?model=' + encodeURIComponent(s.asrModel),
      ttsUrl: base ? base + '/api-ws/v1/inference' : region.tts,
      connect: url => this.#factory(url, { headers: { Authorization: 'Bearer ' + this.#apiKey }, maxPayload: s.limits.maxServerEventBytes, perMessageDeflate: false }),
      release: () => { if (!released) { released = true; this.#active--; } } };
  }
  createAsrSession(options = {}) {
    validateOptions(options, ['onPartial', 'onFinal']);
    const rate = options.sampleRate ?? 16000; if (![8000, 16000].includes(rate)) throw fail('INVALID_PCM');
    const context = this.#context();
    try {
      const operation = new AsrOperation(context, options, rate);
      return Object.freeze({ ready: operation.readyState.promise, appendPcm: bytes => operation.appendPcm(bytes), finish: () => operation.finish(), cancel: () => operation.cancel() });
    } catch { context.release(); throw fail('CONNECTION_FAILED'); }
  }
  async transcribePcm(pcm, options = {}) {
    validateOptions(options, ['onPartial', 'onFinal']);
    const rate = options.sampleRate ?? 16000, bytes = bytesOf(pcm);
    if (![8000, 16000].includes(rate) || bytes.length % 2) throw fail('INVALID_PCM');
    if (bytes.length > this.#settings.limits.maxAudioSeconds * rate * 2) throw fail('INPUT_LIMIT');
    const session = this.createAsrSession(options);
    try {
      await session.ready;
      for (let at = 0; at < bytes.length; at += this.#settings.limits.chunkBytes) await session.appendPcm(bytes.subarray(at, at + this.#settings.limits.chunkBytes));
      return await session.finish();
    } catch (error) { session.cancel(); throw error instanceof BailianError ? error : fail('PROTOCOL_ERROR'); }
  }
  async synthesize(text, options = {}) {
    validateOptions(options, ['onAudio']);
    if (typeof text !== 'string' || !text.trim()) throw fail('INVALID_TEXT');
    if (text.length > this.#settings.limits.maxTextChars || Buffer.byteLength(JSON.stringify(text)) + 256 > this.#settings.limits.maxBufferedBytes) throw fail('INPUT_LIMIT');
    const context = this.#context();
    try { return await new TtsOperation(context, options, text).result.promise; }
    catch (error) { context.release(); throw error instanceof BailianError ? error : fail('CONNECTION_FAILED'); }
  }
}
