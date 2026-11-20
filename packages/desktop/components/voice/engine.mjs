export function pcmWave(samples, sampleRate, targetRate = 16000) {
  if (!(samples instanceof Float32Array) || !Number.isFinite(sampleRate) || sampleRate < targetRate) throw new Error('Invalid audio sample rate');
  const length = Math.floor(samples.length * targetRate / sampleRate);
  const out = new ArrayBuffer(44 + length * 2), view = new DataView(out);
  const ascii = (at, s) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  ascii(0, 'RIFF'); view.setUint32(4, 36 + length * 2, true); ascii(8, 'WAVE'); ascii(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, targetRate, true); view.setUint32(28, targetRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  ascii(36, 'data'); view.setUint32(40, length * 2, true);
  // Average each input interval before downsampling, avoiding nearest-neighbour aliasing.
  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * sampleRate / targetRate), end = Math.floor((i + 1) * sampleRate / targetRate);
    let sum = 0; for (let j = start; j < end; j++) sum += Number.isFinite(samples[j]) ? samples[j] : 0;
    const v = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
    view.setInt16(44 + i * 2, Math.round(v * (v < 0 ? 32768 : 32767)), true);
  }
  return new Uint8Array(out);
}
export function waveBase64(bytes) {
  let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
export class Recording {
  constructor({ onLimit = () => {}, onError = () => {}, autoStop = false, env = globalThis } = {}) {
    this.env = env; this.onLimit = onLimit; this.onError = onError; this.autoStop = autoStop;
    this.parts = []; this.frames = 0; this.cancelled = false; this.finished = false; this.voiced = 0; this.quiet = 0;
  }
  async start() {
    const e = this.env;
    if (!e.navigator?.mediaDevices?.getUserMedia || !e.AudioContext || !e.AudioWorkletNode) throw new Error('This desktop webview does not expose microphone AudioWorklet support');
    try {
      const stream = await e.navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (this.cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
      this.stream = stream; this.context = new e.AudioContext();
      const source = "class YunshuCapture extends AudioWorkletProcessor { process(inputs) { const c=inputs[0]?.[0]; if(c) this.port.postMessage(c.slice()); return true; } } registerProcessor('yunshu-capture',YunshuCapture);";
      const url = e.URL.createObjectURL(new e.Blob([source], { type: 'text/javascript' }));
      try { await this.context.audioWorklet.addModule(url); } finally { e.URL.revokeObjectURL(url); }
      if (this.cancelled) { await this.dispose(); return; }
      this.sampleRate = this.context.sampleRate;
      this.node = new e.AudioWorkletNode(this.context, 'yunshu-capture');
      this.node.port.onmessage = event => {
        if (this.cancelled || this.finished) return;
        const part = new Float32Array(event.data); this.parts.push(part); this.frames += part.length;
        let energy = 0; for (const v of part) energy += v * v;
        if (Math.sqrt(energy / part.length) > 0.012) { this.voiced += part.length; this.quiet = 0; } else this.quiet += part.length;
        if (this.frames >= this.sampleRate * 60 || (this.autoStop && this.voiced > this.sampleRate * 0.25 && this.quiet > this.sampleRate * 1.1)) {
          this.finished = true; this.onLimit();
        }
      };
      this.node.onprocessorerror = () => { this.onError(new Error('Microphone audio processor failed')); void this.dispose(); };
      this.source = this.context.createMediaStreamSource(stream);
      this.gain = this.context.createGain(); this.gain.gain.value = 0;
      this.source.connect(this.node); this.node.connect(this.gain); this.gain.connect(this.context.destination);
      await this.context.resume();
    } catch (error) { await this.dispose(); throw error; }
  }
  async finish() {
    this.finished = true;
    const samples = new Float32Array(this.frames); let offset = 0;
    for (const part of this.parts) { samples.set(part, offset); offset += part.length; }
    const rate = this.sampleRate;
    await this.dispose();
    if (!rate || !samples.length) throw new Error('No audio recorded');
    return pcmWave(samples.subarray(0, rate * 60), rate);
  }
  async dispose() {
    this.cancelled = true;
    this.stream?.getTracks().forEach(t => t.stop()); this.stream = null;
    if (this.node) { this.node.port.onmessage = null; this.node.disconnect(); this.node = null; }
    this.source?.disconnect(); this.source = null; this.gain?.disconnect(); this.gain = null;
    const context = this.context; this.context = null;
    if (context && context.state !== 'closed') await context.close();
    this.parts = [];
  }
}
export class LocalSpeaker {
  constructor(env = globalThis) { this.env = env; this.generation = 0; this.queue = []; this.speaking = false; this.owned = false; }
  stop() { this.generation++; this.queue = []; this.speaking = false; if (this.owned) this.env.speechSynthesis?.cancel(); this.owned = false; }
  speak(text) {
    const synth = this.env.speechSynthesis;
    const voices = synth?.getVoices().filter(v => v.localService) ?? [];
    const voice = voices.find(v => /^zh/i.test(v.lang)) ?? voices[0];
    if (!voice) throw new Error('No local system voice is available; install a Windows speech voice first');
    this.queue.push(...String(text).slice(0, 12000).match(/[^。！？.!?\n]{1,180}[。！？.!?\n]?/g) ?? []);
    if (this.queue.length > 150) this.queue = this.queue.slice(-150);
    const generation = this.generation;
    const next = () => {
      if (generation !== this.generation || !this.queue.length) { if (generation === this.generation) this.speaking = false; return; }
      const utterance = new this.env.SpeechSynthesisUtterance(this.queue.shift());
      utterance.voice = voice; utterance.lang = voice.lang;
      utterance.onend = next; utterance.onerror = () => this.stop();
      this.owned = true; this.speaking = true; synth.speak(utterance);
    };
    if (!this.speaking) next();
  }
}
