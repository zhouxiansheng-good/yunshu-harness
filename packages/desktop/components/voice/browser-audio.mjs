export class StreamingMicrophone {
  constructor({ onSamples, onError = () => {}, env = globalThis, context = null }) { this.onSamples = onSamples; this.onError = onError; this.env = env; this.sharedContext = context; this.stopped = false; }
  async start() {
    const e = this.env;
    if (!e.navigator?.mediaDevices?.getUserMedia || !e.AudioContext || !e.AudioWorkletNode) throw new Error('无法使用麦克风');
    try {
      const stream = await e.navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (this.stopped) { stream.getTracks().forEach(track => track.stop()); return null; }
      this.echoCancellation = stream.getAudioTracks?.()[0]?.getSettings?.().echoCancellation === true;
      this.trackCleanups = [];
      for (const track of stream.getTracks()) {
        const ended = () => { if (!this.stopped) { this.onError(new Error('麦克风已断开')); void this.stop(); } };
        const muted = () => { if (!this.stopped) { this.onError(new Error('麦克风已静音')); void this.stop(); } };
        track.addEventListener?.('ended', ended); track.addEventListener?.('mute', muted);
        this.trackCleanups.push(() => { track.removeEventListener?.('ended', ended); track.removeEventListener?.('mute', muted); });
      }
      this.stream = stream; const context = this.context = this.sharedContext ?? new e.AudioContext();
      const source = "class YunshuStream extends AudioWorkletProcessor { process(inputs) { const samples=inputs[0]?.[0]; if(samples) this.port.postMessage(samples.slice()); return true; } } registerProcessor('yunshu-stream',YunshuStream);";
      const url = e.URL.createObjectURL(new e.Blob([source], { type: 'text/javascript' }));
      try { await context.audioWorklet.addModule(url); } finally { e.URL.revokeObjectURL(url); }
      if (this.stopped) { await this.stop(); return null; }
      this.input = context.createMediaStreamSource(stream); this.node = new e.AudioWorkletNode(context, 'yunshu-stream');
      this.node.port.onmessage = event => { if (!this.stopped) this.onSamples(new Float32Array(event.data), context.sampleRate); };
      this.node.onprocessorerror = () => { this.onError(new Error('麦克风处理失败')); void this.stop(); };
      this.mute = context.createGain(); this.mute.gain.value = 0;
      this.input.connect(this.node); this.node.connect(this.mute); this.mute.connect(context.destination);
      await context.resume(); return context.sampleRate;
    } catch (error) { await this.stop(); throw error; }
  }
  async stop() {
    this.stopped = true; for (const cleanup of this.trackCleanups ?? []) cleanup(); this.trackCleanups = [];
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = null;
    if (this.node) { this.node.port.onmessage = null; this.node.disconnect(); this.node = null; }
    this.input?.disconnect(); this.input = null; this.mute?.disconnect(); this.mute = null;
    const context = this.context; this.context = null;
    if (context && !this.sharedContext && context.state !== 'closed') await context.close();
  }
}
export class PcmOutput {
  constructor({ env = globalThis, onActive = () => {} } = {}) { this.env = env; this.onActive = onActive; this.sources = new Set(); this.context = null; this.nextTime = 0; this.generation = 0; }
  async ready() {
    if (!this.env.AudioContext) throw new Error('无法使用扬声器');
    if (!this.context) { this.context = new this.env.AudioContext(); this.gain = this.context.createGain(); this.gain.connect(this.context.destination); }
    await this.context.resume();
  }
  setGain(gain, seconds = 0.03) {
    if (!this.context) return;
    this.gain.gain.cancelScheduledValues(this.context.currentTime);
    this.gain.gain.setTargetAtTime(Math.max(0, Math.min(1, gain)), this.context.currentTime, seconds);
  }
  play(bytes, sampleRate) {
    if (!this.context || this.context.state === 'closed') throw new Error('扬声器未就绪');
    if (!(bytes instanceof Uint8Array) || bytes.byteLength % 2 || sampleRate < 8000 || sampleRate > 48000) throw new Error('播放音频格式无效');
    if (!bytes.length) return;
    const context = this.context, start = Math.max(context.currentTime + 0.02, this.nextTime);
    if (start - context.currentTime > 45) throw new Error('播放队列已满');
    const audio = context.createBuffer(1, bytes.length / 2, sampleRate), channel = audio.getChannelData(0);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < channel.length; i++) channel[i] = view.getInt16(i * 2, true) / 32768;
    const source = context.createBufferSource(), generation = this.generation;
    source.buffer = audio; source.connect(this.gain); this.sources.add(source); this.onActive(true);
    source.onended = () => { source.disconnect(); this.sources.delete(source); if (generation === this.generation && !this.sources.size) this.onActive(false); };
    source.start(start); this.nextTime = start + audio.duration;
  }
  stop() {
    this.generation++; for (const source of this.sources) { source.onended = null; try { source.stop(); } catch {} source.disconnect(); }
    this.sources.clear(); this.nextTime = 0; this.setGain(1); this.onActive(false);
  }
  async close() { this.stop(); const context = this.context; this.context = null; if (context && context.state !== 'closed') await context.close(); }
}
export function base64Pcm(value) {
  const binary = atob(value), bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
