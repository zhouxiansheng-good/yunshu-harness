// Browser-compatible Silero v6 stateful inference. Model/runtime are injected;
// input is 16 kHz signed PCM, not a speaker identity or biometric embedding.
export const SILERO_INPUT = Object.freeze({ sampleRate: 16000, frameSamples: 512, contextSamples: 64, stateShape: [2, 1, 128] });
export class SileroVad {
  static async create({ ort, model, speechThreshold = 0.5, confirmFrames = 2, signal } = {}) {
    if (!ort?.Tensor || !ort?.InferenceSession || !(model instanceof Uint8Array)) throw new TypeError('人声检测资源无效');
    if (!Number.isFinite(speechThreshold) || speechThreshold <= 0 || speechThreshold >= 1 || !Number.isInteger(confirmFrames) || confirmFrames < 1 || confirmFrames > 10) throw new TypeError('人声检测参数无效');
    signal?.throwIfAborted();
    const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    if (signal?.aborted) { await session.release(); signal.throwIfAborted(); }
    if (!['input', 'state', 'sr'].every(name => session.inputNames.includes(name)) || !['output', 'stateN'].every(name => session.outputNames.includes(name))) { await session.release(); throw new Error('人声检测模型接口不匹配'); }
    const detector = new SileroVad(ort, session, speechThreshold, confirmFrames);
    if (signal) { detector.abortHandler = () => { void detector.dispose().catch(() => {}); }; detector.signal = signal; signal.addEventListener('abort', detector.abortHandler, { once: true }); }
    return detector;
  }
  constructor(ort, session, threshold, confirmFrames) {
    this.ort = ort; this.session = session; this.threshold = threshold; this.confirmFrames = confirmFrames;
    this.queue = Promise.resolve(); this.queuedSamples = 0; this.epoch = 0; this.disposed = false;
    this._clear();
  }
  _clear() { this.state = new Float32Array(256); this.context = new Float32Array(64); this.pending = []; this.voicedRun = 0; }
  reset() { this.epoch++; this._clear(); }
  push(samples) {
    if (this.disposed) return Promise.resolve(null);
    if (!(samples instanceof Int16Array) || samples.length > 16000 || this.queuedSamples + samples.length > 16000 * 2) return Promise.reject(new Error('人声检测队列已满'));
    const epoch = this.epoch, copy = samples.slice(); this.queuedSamples += copy.length;
    const job = this.queue.then(async () => {
      if (this.disposed || epoch !== this.epoch) return null;
      for (const sample of copy) this.pending.push(sample / 32768);
      let result = null;
      while (this.pending.length >= 512 && !this.disposed && epoch === this.epoch) {
        const frame = Float32Array.from(this.pending.splice(0, 512));
        const input = new Float32Array(576); input.set(this.context); input.set(frame, 64);
        const tensors = { input: new this.ort.Tensor('float32', input, [1, 576]), state: new this.ort.Tensor('float32', this.state, [2, 1, 128]), sr: new this.ort.Tensor('int64', BigInt64Array.from([16000n]), []) };
        let output;
        try {
          output = await this.session.run(tensors);
          if (this.disposed || epoch !== this.epoch) return null;
          const score = Number(output.output?.data[0]);
          if (!Number.isFinite(score) || score < 0 || score > 1 || output.stateN?.data.length !== 256) throw new Error('人声检测结果无效');
          this.state = new Float32Array(output.stateN.data); this.context = frame.slice(-64);
          this.voicedRun = score >= this.threshold ? this.voicedRun + 1 : 0;
          result = { speech: this.voicedRun >= this.confirmFrames, score };
        } finally { for (const tensor of [...Object.values(tensors), ...Object.values(output ?? {})]) tensor.dispose?.(); }
      }
      return result;
    }).finally(() => { this.queuedSamples -= copy.length; });
    this.queue = job.catch(() => {}); return job;
  }
  dispose() {
    if (this.disposal) return this.disposal;
    this.disposed = true; this.reset(); this.signal?.removeEventListener('abort', this.abortHandler);
    this.disposal = this.queue.then(() => this.session.release()); return this.disposal;
  }
}
