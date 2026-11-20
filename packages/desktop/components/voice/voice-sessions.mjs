import { randomUUID } from 'node:crypto';
import { BailianError } from './bailian.mjs';

const valid = (condition, message) => { if (!condition) throw new Error(message); };
export function decodePcm(base64, limit = 128000) {
  valid(typeof base64 === 'string' && base64.length <= Math.ceil(limit / 3) * 4, '音频片段过大');
  const bytes = Buffer.from(base64, 'base64');
  valid(bytes.length > 0 && bytes.length % 2 === 0 && bytes.length <= limit && bytes.toString('base64') === base64, '音频片段格式无效');
  return bytes;
}
export class VoiceSessions {
  constructor(adapter, { now = Date.now, maxSessions = 32, ttlMs = 120000, maxQueuedBytes = 2097152 } = {}) {
    this.adapter = adapter; this.now = now; this.maxSessions = maxSessions; this.ttlMs = ttlMs; this.maxQueuedBytes = maxQueuedBytes;
    this.states = new Map(); this.generations = new Map(); this.closed = false;
    this.timer = setInterval(() => this.sweep(), Math.min(ttlMs, 30000)); this.timer.unref?.();
  }
  sweep() { for (const [id, state] of this.states) if (state.expires <= this.now()) this.stop(id); }
  start(id, generation) {
    valid(!this.closed, '语音已停用'); valid(Number.isSafeInteger(generation) && generation >= 0, '语音会话标识无效');
    this.sweep();
    const previous = this.generations.get(id), existing = this.states.get(id);
    if (existing?.generation === generation) return { generation };
    valid(previous === undefined || generation > previous, '语音会话已过期');
    valid(previous !== undefined || this.generations.size < this.maxSessions * 64, '语音会话记录已达上限');
    valid(!!existing || this.states.size < this.maxSessions, '语音会话数量已达上限');
    this.stop(id); this.generations.set(id, generation);
    const state = { id, generation, abort: new AbortController(), turns: new Map(), speech: null, seq: 0, events: [], bytes: 0, expires: this.now() + this.ttlMs };
    this.states.set(id, state); return { generation };
  }
  state(id, generation) {
    this.sweep(); const state = this.states.get(id);
    valid(state && state.generation === generation && !state.abort.signal.aborted, '语音会话已结束');
    state.expires = this.now() + this.ttlMs; return state;
  }
  emit(state, event) {
    if (this.states.get(state.id) !== state || state.abort.signal.aborted) return false;
    const bytes = event.audioBase64?.length ?? 0;
    valid(state.bytes + bytes <= this.maxQueuedBytes && state.events.length < 1000, '音频播放队列已满');
    state.events.push({ seq: ++state.seq, generation: state.generation, ...event }); state.bytes += bytes;
    return true;
  }
  async beginTurn(id, generation, turnId) {
    const state = this.state(id, generation);
    valid(typeof turnId === 'string' && turnId.length > 0 && turnId.length < 200 && !state.turns.has(turnId), '识别轮次无效');
    valid(state.turns.size < 2, '识别处理中');
    const abort = new AbortController(), signal = AbortSignal.any([state.abort.signal, abort.signal]);
    const turn = { abort, sequence: 0, bytes: 0, finishing: false };
    state.turns.set(turnId, turn);
    try {
      turn.asr = this.adapter.createAsrSession({ sampleRate: 16000, signal, onPartial: text => { try { this.emit(state, { type: 'transcript-partial', turnId, text }); } catch { abort.abort(); } } });
      await turn.asr.ready; signal.throwIfAborted(); return { turnId, ready: true };
    } catch (error) { abort.abort(); state.turns.delete(turnId); throw error; }
  }
  async append(id, generation, { turnId, sequence, audioBase64 }) {
    const state = this.state(id, generation), turn = state.turns.get(turnId);
    valid(turn && !turn.finishing && !turn.abort.signal.aborted, '识别轮次已结束');
    valid(sequence === turn.sequence, '音频片段顺序错误');
    const pcm = decodePcm(audioBase64); valid(turn.bytes + pcm.length <= 16000 * 2 * 30, '录音超过时长限制');
    turn.sequence++; turn.bytes += pcm.length;
    try { await turn.asr.appendPcm(pcm); turn.abort.signal.throwIfAborted(); return { accepted: sequence }; }
    catch (error) { turn.abort.abort(); turn.asr.cancel(); state.turns.delete(turnId); throw error; }
  }
  async finish(id, generation, turnId) {
    const state = this.state(id, generation), turn = state.turns.get(turnId);
    valid(turn && !turn.finishing, '识别轮次已结束'); turn.finishing = true;
    try { const result = await turn.asr.finish(); this.state(id, generation); turn.abort.signal.throwIfAborted(); return { turnId, ...result }; }
    finally { turn.abort.abort(); state.turns.delete(turnId); }
  }
  cancelTurn(id, generation, turnId) {
    const state = this.state(id, generation), turn = state.turns.get(turnId);
    if (turn) { turn.abort.abort(); turn.asr?.cancel(); state.turns.delete(turnId); }
    return { cancelled: true };
  }
  speak(id, generation, text) {
    const state = this.state(id, generation);
    valid(typeof text === 'string' && text.trim().length > 0 && text.length <= 6000, '朗读文字为空或过长');
    valid(!state.speech, '正在朗读');
    const job = { id: randomUUID(), abort: new AbortController(), sequence: 0 };
    state.speech = job;
    const signal = AbortSignal.any([state.abort.signal, job.abort.signal]);
    let emitted = false;
    const onAudio = (chunk, metadata = {}) => {
      if (signal.aborted || state.speech !== job) return;
      const pcm = chunk?.audio ?? chunk?.pcm ?? chunk;
      const bytes = Buffer.from(pcm);
      const sampleRate = metadata.sampleRate ?? chunk?.sampleRate ?? this.adapter.config?.ttsSampleRate ?? 24000;
      for (let offset = 0; offset < bytes.length; offset += 16000) {
        this.emit(state, { type: 'audio', speechId: job.id, speechJobId: job.id, sequence: job.sequence++, sampleRate, channels: 1, encoding: 'pcm_s16le', audioBase64: bytes.subarray(offset, offset + 16000).toString('base64') }); emitted = true;
      }
    };
    job.promise = this.adapter.synthesize(text, { signal, onAudio }).then(result => {
      if (signal.aborted || state.speech !== job) return;
      if (!emitted && typeof result.audioBase64 === 'string') {
        const bytes = Buffer.from(result.audioBase64, 'base64');
        valid(bytes.length > 0 && bytes.length <= 8 * 1024 * 1024 && ['audio/wav','audio/mpeg'].includes(result.mimeType), '朗读音频格式无效');
        valid(Math.ceil(bytes.length / 3) * 4 <= this.maxQueuedBytes, '单句朗读音频过大，请缩短文字');
        for (let offset = 0; offset < bytes.length; offset += 16000) {
          this.emit(state, { type: 'encoded-audio', speechId: job.id, speechJobId: job.id, sequence: job.sequence++, mimeType: result.mimeType, audioBase64: bytes.subarray(offset, offset + 16000).toString('base64') });
        }
        if (result.notice) this.emit(state, { type: 'audio-notice', speechId: job.id, message: result.notice });
      } else if (!emitted) onAudio(result.audio, result);
      this.emit(state, { type: 'audio-end', speechId: job.id, speechJobId: job.id, sequence: job.sequence });
    }).catch(error => {
      if (!signal.aborted && state.speech === job) { try { this.emit(state, { type: 'audio-error', speechId: job.id, message: error instanceof BailianError ? error.message : '朗读已中断', delivery: error instanceof BailianError ? error.delivery ?? 'unknown' : 'unknown' }); } catch { this.stop(id); } }
    }).finally(() => { if (state.speech === job) state.speech = null; });
    return { speechId: job.id, speechJobId: job.id };
  }
  stopSpeech(id, generation, speechId) {
    const state = this.state(id, generation);
    if (!speechId || state.speech?.id === speechId) { state.speech?.abort.abort(); state.speech = null; }
    state.events = state.events.filter(e => !(e.type.startsWith('audio') || e.type === 'encoded-audio') || (speechId && e.speechId !== speechId));
    state.bytes = state.events.reduce((sum, e) => sum + (e.audioBase64?.length ?? 0), 0);
    return { stopped: true };
  }
  poll(id, generation, after = 0) {
    const state = this.state(id, generation); valid(Number.isSafeInteger(after) && after >= 0 && after <= state.seq, '播放游标无效');
    state.events = state.events.filter(e => e.seq > after); state.bytes = state.events.reduce((sum, e) => sum + (e.audioBase64?.length ?? 0), 0);
    const events = state.events.slice(0, 32); return { events, seq: events.at(-1)?.seq ?? after };
  }
  stop(id) {
    const state = this.states.get(id); if (!state) return;
    state.abort.abort(); for (const turn of state.turns.values()) { turn.abort.abort(); turn.asr?.cancel(); }
    state.events = []; state.speech?.abort.abort(); this.states.delete(id);
  }
  close() { this.closed = true; clearInterval(this.timer); for (const id of this.states.keys()) this.stop(id); this.generations.clear(); }
}
