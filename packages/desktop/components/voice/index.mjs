import { requireFeature } from '../system/policy.mjs';
import { TtsService, installedVoices, validateTts } from './tts.mjs';
import { sharedKey, asrConfig, profileView, canStreamNative, legacyUpdate, nativeWithFallback } from './voice-profile.mjs';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import SpeechToText from '@deepseek-ai/dsh-experimental-speech-to-text';
import * as SenseVoice from '@deepseek-ai/dsh-experimental-speech-to-text-sensevoice';
import { z } from 'zod';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info';
import { validateWave } from '@deepseek-ai/dsh-experimental-speech-to-text/wave';
import { remoteSpec } from './shared/remote-spec.mjs';
import { requireOwner, registerRemote, dataError } from './shared/host.mjs';
import WebSocket from './vendor/ws/wrapper.mjs';
import { BailianVoiceAdapter } from './bailian.mjs';
import { VoiceSessions } from './voice-sessions.mjs';
import { VadAssets } from './vad-assets.mjs';
import { ReplyStreamBridge } from './reply-stream.mjs';
import { VoiceKeySettings } from './key-settings.mjs';
import { VoiceSubmissions } from './submissions.mjs';
import { randomUUID } from 'node:crypto';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
export const remoteInfo = remoteSpec('yunshuVoice', z, createTypertRemoteInfo);
export default class YunshuVoice extends TypertRemoteService {
  static inject = ['typert', 'agents'];
  constructor(ctx, config = {}) {
    super(ctx, 'yunshuVoice');
    this.allowCloud = config.allowCloudASR === true;
    this.asrMode = config.asrMode ?? 'bailian';
    if (!['bailian', 'private-local', 'host'].includes(this.asrMode)) throw new Error('asrMode must be bailian, private-local or host');
    this.bailianConfig = { ...(config.bailian?.apiKey === undefined ? { keyEnv: 'DASHSCOPE_API_KEY' } : {}), ...config.bailian };
    this.legacyBailianConfig = this.bailianConfig;
    this.profileStamp = null;
    this.profileTail = Promise.resolve();
    this.socketFactory = (url, options) => new WebSocket(url, { ...options, perMessageDeflate: false, maxPayload: 4 * 1024 * 1024 });
    this.voice = null;
    this.bailianError = null;
    if (this.asrMode === 'bailian') this.configureBailian(this.bailianConfig);
    this.submissions = new VoiceSubmissions();
    this.keySettings = new VoiceKeySettings({
      restore: this.asrMode === 'bailian' && config.bailian?.apiKey === undefined,
      source: this.voice ? (config.bailian?.apiKey === undefined ? 'environment' : 'session') : 'none',
      validate: value => {
        const config = legacyUpdate(this.legacyBailianConfig, value);
        return { config, adapter: new BailianVoiceAdapter(config, { webSocketFactory: this.socketFactory }) };
      },
      apply: (_value, { config, adapter }) => {
        this.voice?.close(); this.voice = new VoiceSessions(adapter); this.bailian = adapter;
        this.bailianConfig = config; this.legacyBailianConfig = config; this.profileStamp = null; this.bailianError = null; this.asrMode = 'bailian';
      },
      clear: () => {
        this.voice?.close(); this.voice = null; this.bailian = null;
        delete this.bailianConfig.apiKey; delete this.bailianConfig.keyEnv; delete this.legacyBailianConfig.apiKey; delete this.legacyBailianConfig.keyEnv; this.profileStamp = null; this.bailianError = '未设置 API Key';
      },
    });
    this.tts = new TtsService();
    this.ttsReplies = new ReplyStreamBridge(ctx, { speakCommittedText: true });
    this.credentialsSetup = ctx.inject(['credentials'], dependency => {
      const detach = this.keySettings.attach(dependency.credentials); const detachTts = this.tts.settings.attach(dependency.credentials); dependency.effect(() => () => { detach(); detachTts(); });
    });
    this.speechContext = this.asrMode === 'host' ? ctx : null;
    this.asrError = null;
    if (this.asrMode === 'private-local') {
      this.asrSetup = ctx.inject(['subprocess'], async dependencyContext => {
        const local = dependencyContext.isolate('speechToText');
        this.speechContext = local;
        this.asrError = null;
        dependencyContext.effect(() => () => { this.speechContext = null; });
        try {
          await local.plugin(SpeechToText, { defaultProvider: 'sensevoice-local', language: 'auto' });
          await local.plugin(SenseVoice, { dataRoot: config.asrDataRoot ?? dshHomePath('plugins', 'yunshu-voice', 'sensevoice') });
        } catch (error) { this.asrError = error instanceof Error ? error.message : String(error); throw error; }
      });
    }
    this.replyBridge = new ReplyStreamBridge(ctx, { speakCommittedText: true });
    this.lifetime = new AbortController();
    this.vadAssets = new VadAssets();
    ctx.effect(() => () => { this.lifetime.abort(); this.replyBridge.close(); this.voice?.close(); this.vadAssets.close(); this.submissions.close(); this.ttsReplies.close(); return Promise.all([this.keySettings.close(), this.tts.close()]); });
    registerRemote(ctx, remoteInfo);
  }
  async syncVoiceProfile() {
    await Promise.all([this.tts.settings.tail, this.keySettings.tail]);
    const config = this.tts.config;
    if (this.asrMode !== 'bailian' && !(config.mode === 'bailian' && config.apiKey)) return;
    const source = config.mode === 'bailian' && config.apiKey ? asrConfig(config) : this.legacyBailianConfig;
    const stamp = JSON.stringify([source, config]);
    if (stamp === this.profileStamp) return;
    this.profileStamp = stamp;
    this.voice?.close(); this.voice = null;
    try {
      const adapter = new BailianVoiceAdapter(source, { webSocketFactory: this.socketFactory });
      this.bailian = adapter;
      this.bailianConfig = source;
      if (!adapter.capabilities().configured) { this.bailianError = '请先保存语音设置'; return; }
      this.voice = new VoiceSessions({
        createAsrSession: options => adapter.createAsrSession(options),
        synthesize: async (text, options) => {
          if (canStreamNative(this.tts.config)) {
            const native = new BailianVoiceAdapter({ ...asrConfig(this.tts.config), voice: this.tts.config.voice }, { webSocketFactory: this.socketFactory });
            return nativeWithFallback(this.tts, native, text, options);
          }
          if (this.tts.settings.status().source === 'none') return adapter.synthesize(text, options);
          return this.tts.render(text, options.signal);
        },
      });
      this.asrMode = 'bailian'; this.bailianError = null;
    } catch { this.bailianError = '语音识别配置无效'; }
  }
  async saveVoiceProfile(input, signal) {
    const config = validateTts(sharedKey(input, this.tts.config, this.legacyBailianConfig));
    if (config.mode === 'bailian') {
      const adapter = new BailianVoiceAdapter(asrConfig(config), { webSocketFactory: this.socketFactory });
      const session = adapter.createAsrSession({ sampleRate: 16000, signal });
      try { await session.ready; signal.throwIfAborted(); } finally { session.cancel(); }
    }
    const result = await this.tts.configure(config, { persist: input.persist !== false, signal });
    await this.syncVoiceProfile();
    return result;
  }
  changeVoiceProfile(operation, signal) {
    const active = AbortSignal.any([signal, this.lifetime.signal]);
    const task = this.profileTail.then(() => { active.throwIfAborted(); return operation(active); });
    this.profileTail = task.catch(() => {});
    return task;
  }
  async deleteVoiceProfile(signal) {
    try {
      await this.keySettings.remove(signal);
      await this.tts.settings.remove(signal);
      return { deleted: true };
    } catch {
      throw new Error('语音设置未全部清除，请重试');
    } finally { await this.syncVoiceProfile(); }
  }
  speech() { return this.speechContext?.get('speechToText'); }
  health() {
    const configured = this.asrMode === 'bailian' ? !!this.voice : !!this.speech();
    return { id: 'voice', state: configured ? 'unverified' : 'unconfigured', configured, evidence: 'configuration-only', checkedAt: new Date().toISOString(), asrMode: this.asrMode, microphone: 'unknown', speaker: 'unknown', endpoint: 'unverified', error: configured ? null : '语音尚未配置完成' };
  }
  configureBailian(config) {
    try {
      const adapter = new BailianVoiceAdapter(config, { webSocketFactory: this.socketFactory });
      if (!adapter.capabilities().configured) { this.bailianError = '未设置 API Key'; return false; }
      const voice = new VoiceSessions(adapter);
      this.voice?.close(); this.voice = voice; this.bailian = adapter; this.bailianError = null; return true;
    } catch { this.bailianError = '语音配置无效'; return false; }
  }
  async request(agent, action, payload, signal) {
    requireOwner(this.ctx, signal);
    if(!['tts-stop','voice-stop','unwatch'].includes(action))requireFeature('voice');
    const id = agent.session.header.id;
    try {
      const p = z.record(z.string(), z.json()).parse(payload);
      await this.syncVoiceProfile();
      if (action === 'voice-profile') return { ...profileView(this.tts, this.legacyBailianConfig), recordingAvailable: !!this.voice };
      if (action === 'voice-save') return await this.changeVoiceProfile(active => this.saveVoiceProfile(p, active), signal);
      if (action === 'voice-delete') return await this.changeVoiceProfile(active => this.deleteVoiceProfile(active), signal);
      if (action === 'tts-status') { await this.tts.settings.tail; return this.tts.status(); }
      if (action === 'tts-models' || action === 'tts-catalog-voices') return await this.tts.catalog(action === 'tts-models' ? 'models' : 'voices', sharedKey({mode:'bailian',...p},this.tts.config,this.legacyBailianConfig), AbortSignal.any([signal,this.lifetime.signal]));
      if (action === 'tts-voices') return await installedVoices(AbortSignal.any([signal,this.lifetime.signal]));
      if (action === 'tts-configure') return await this.tts.configure(p,{persist:p.persist===true,signal});
      if (action === 'tts-delete') return await this.tts.settings.remove(signal);
      if (action.startsWith('tts-')) {
        const generation=z.number().int().positive().parse(p.generation);
        if(action==='tts-start') return this.tts.start(id,generation);
        if(action==='tts-stop') {this.ttsReplies.unwatch(agent,{generation});return this.tts.stop(id,generation);}
        this.tts.state(id,generation);
        if(action==='tts-synthesize')return await this.tts.synthesize(id,generation,p.text,AbortSignal.any([signal,this.lifetime.signal]));
        if(action==='tts-watch')return this.ttsReplies.watch(agent,{generation});
        if(action==='tts-poll')return this.ttsReplies.poll(agent,{generation,after:p.after??0});
      }
      if (action === 'health') return this.health();
      if (action === 'vad-manifest') return this.vadAssets.manifest();
      if (action === 'vad-asset') return this.vadAssets.chunk(p.name, p.offset);
      if (action === 'status') { await this.keySettings.tail; return this.asrMode === 'bailian'
        ? { available: !!this.voice, asrMode: 'bailian', provider: '阿里云百炼', region: this.bailianConfig.region ?? 'beijing', maxSeconds: 20, setupError: this.bailianError, keyStorage: this.keySettings.status(), capabilities: this.bailian?.capabilities() ?? null }
        : { available: !!this.speech(), catalog: this.speech()?.snapshot() ?? null, maxSeconds: 60, allowCloud: this.allowCloud, asrMode: this.asrMode, setupError: this.asrError }; }
      if (action === 'configure-bailian') {
        return await this.keySettings.configure(p, { persist: z.boolean().optional().parse(p.persist) ?? false, signal });
      }
      if (action === 'delete-bailian-key') return await this.keySettings.remove(signal);
      if (['voice-start', 'voice-stop', 'asr-start', 'asr-append', 'asr-finish', 'asr-cancel', 'speak', 'stop-playback', 'audio-poll'].includes(action)) {
        if (!this.voice) throw new Error('请先设置百炼 API Key');
        const generation = z.number().int().nonnegative().parse(p.generation);
        if (action === 'voice-start') return this.voice.start(id, generation);
        if (action === 'voice-stop') { this.voice.state(id, generation); this.replyBridge.unwatch(agent, { generation }); this.voice.stop(id); return { stopped: true }; }
        if (action === 'asr-start') return await this.voice.beginTurn(id, generation, p.turnId);
        if (action === 'asr-append') return await this.voice.append(id, generation, p);
        if (action === 'asr-finish') return await this.voice.finish(id, generation, p.turnId);
        if (action === 'asr-cancel') return this.voice.cancelTurn(id, generation, p.turnId);
        if (action === 'speak') return this.voice.speak(id, generation, p.text);
        if (action === 'stop-playback') {
          this.voice.state(id, generation);
          if (!p.speechId && p.cancelReply !== false) this.replyBridge.cancel(agent, { generation, reason: 'user_stop' });
          return this.voice.stopSpeech(id, generation, p.speechId);
        }
        if (action === 'audio-poll') return this.voice.poll(id, generation, p.after);
      }
      if (action === 'prepare' || action === 'cancel-preparation') {
        const speech = this.speech();
        if (!speech) throw new Error('Local ASR service is not ready');
        const provider = speech.snapshot().providers.find(item => item.id === p.providerId);
        if (!provider || provider.location !== 'host-local') throw new Error('Choose a host-local provider');
        if (action === 'cancel-preparation') { await speech.cancelPreparation(provider.id); return { cancelled: true }; }
        const options = p.downloadSource ? { downloadSource: z.string().parse(p.downloadSource) } : {};
        speech.prepare(provider.id, options);
        return { started: true };
      }
      if (['watch', 'poll', 'unwatch'].includes(action)) {
        const generation = z.number().int().nonnegative().parse(p.generation ?? 0);
        if (generation > 0 && action !== 'unwatch') {
          if (!this.voice) throw new Error('语音会话已结束');
          this.voice.state(id, generation);
        }
        return this.replyBridge[action](agent, { generation, ...(action === 'poll' ? { after: p.after } : {}) });
      }
      if (action === 'transcribe') {
        const speech = this.speech();
        if (!speech) throw new Error('Local speech recognizer is not ready. Check plugin setup status and prepare its model.');
        const encoded = z.string().max(2600000).parse(p.audioBase64);
        const audio = Buffer.from(encoded, 'base64');
        if (audio.toString('base64') !== encoded || audio.length > 1920044) throw new Error('Invalid or oversized WAV');
        validateWave(audio, 60);
        const snapshot = speech.snapshot();
        const provider = snapshot.providers.find(item => item.id === snapshot.selection.providerId);
        if (!provider || (!this.allowCloud && provider.location !== 'host-local')) throw new Error('Select an available host-local ASR provider; cloud ASR is disabled');
        const spec = speech.resolve({ audio, providerId: provider.id, language: snapshot.selection.language });
        const result = await speech.transcribe(spec, AbortSignal.any([signal, this.lifetime.signal]));
        signal.throwIfAborted(); this.lifetime.signal.throwIfAborted();
        return { text: result.text, audioSeconds: result.audioSeconds, inferenceSeconds: result.inferenceSeconds };
      }
      if (action === 'send') {
        const text = z.string().trim().min(1).max(12000).parse(p.text);
        if (p.generation !== undefined) {
          if (!this.voice) throw new Error('语音会话已结束');
          this.voice.state(id, z.number().int().nonnegative().parse(p.generation));
        }
        signal.throwIfAborted();
        this.lifetime.signal.throwIfAborted();
        return await this.submissions.send(id, p.requestId ?? randomUUID(), text, async () => {
          signal.throwIfAborted(); this.lifetime.signal.throwIfAborted();
          if (p.generation !== undefined) {
            if (!this.voice) throw new Error('语音会话已结束');
            this.voice.state(id, p.generation);
          }
          await agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }));
          return { submitted: true, sessionId: id };
        });
      }
      throw new Error('Unknown voice action');
    } catch (error) { throw dataError(error); }
  }
}
