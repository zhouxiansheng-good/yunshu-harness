// Browser-only orchestration primitives. Capture, VAD loading, transport and
// AudioContext scheduling are injected/owned by the host, not hidden here.
export const VOICE_TIMING = Object.freeze({
  sampleRate: 16000, frameSamples: 320, frameMs: 20, preRollFrames: 20,
  activityIntervalMs: 50, speechThreshold: 0.025, bargeInThreshold: 0.06,
  speechStartFrames: 2, silenceMs: 650, minimumUtteranceMs: 180,
  maximumUtteranceMs: 20000, playbackGapMs: 2600,
  duckGain: 0.3, holdMs: 400, releaseAfterQuietMs: 300, rampSeconds: 0.03,
});

const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const generationValid = value => Number.isSafeInteger(value) && value >= 0;
const normalized = value => Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
const quantize = value => Math.round(normalized(value) * (value < 0 ? 32768 : 32767));

/** Stateful linear resampling: chunk boundaries cannot drop interpolation samples. */
export class PcmFramer {
  constructor({ inputSampleRate = 16000, sampleRate = 16000, frameSamples = 320, maxInputSamples = 1048576 } = {}) {
    if (!Number.isFinite(inputSampleRate) || inputSampleRate < 8000 || inputSampleRate > 192000) throw new RangeError('Invalid input sample rate');
    if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 48000) throw new RangeError('Invalid output sample rate');
    if (!Number.isInteger(frameSamples) || frameSamples < 1 || frameSamples > 48000) throw new RangeError('Invalid frame size');
    if (!Number.isInteger(maxInputSamples) || maxInputSamples < 1) throw new RangeError('Invalid input bound');
    this.inputSampleRate = inputSampleRate; this.sampleRate = sampleRate;
    this.frameSamples = frameSamples; this.maxInputSamples = maxInputSamples;
    this.reset();
  }
  reset() {
    this.inputSamples = 0; this.outputSamples = 0; this.tail = 0;
    this.partial = new Int16Array(this.frameSamples); this.partialLength = 0;
  }
  push(samples) {
    if (!(samples instanceof Float32Array)) throw new TypeError('Expected Float32Array microphone samples');
    if (samples.length > this.maxInputSamples) throw new RangeError('Microphone chunk exceeds bound');
    if (!samples.length) return [];
    const before = this.inputSamples, end = before + samples.length, frames = [];
    const read = absolute => absolute < before ? this.tail : normalized(samples[absolute - before]);
    const ratio = this.inputSampleRate / this.sampleRate;
    while (true) {
      let position = this.outputSamples * ratio;
      const nearest = Math.round(position);
      if (Math.abs(position - nearest) < 1e-8) position = nearest;
      const left = Math.floor(position), fraction = position - left;
      if (left >= end || (fraction > 0 && left + 1 >= end)) break;
      const a = read(left), value = fraction ? a + (read(left + 1) - a) * fraction : a;
      this.partial[this.partialLength++] = quantize(value); this.outputSamples++;
      if (this.partialLength === this.frameSamples) {
        frames.push(this.partial); this.partial = new Int16Array(this.frameSamples); this.partialLength = 0;
      }
    }
    this.tail = normalized(samples[samples.length - 1]); this.inputSamples = end;
    return frames;
  }
  snapshot() { return { inputSamples: this.inputSamples, outputSamples: this.outputSamples, pendingSamples: this.partialLength }; }
}

/** Incremental text DELTAS, not cumulative transcript snapshots. */
export class StreamingTextQueue {
  constructor({ maxSentence = 180, maxBuffered = 12000, maxQueued = 128 } = {}) {
    for (const value of [maxSentence, maxBuffered, maxQueued]) {
      if (!Number.isInteger(value) || value < 1) throw new RangeError('Invalid text queue bound');
    }
    this.maxSentence = maxSentence; this.maxBuffered = maxBuffered; this.maxQueued = maxQueued;
    this.clear();
  }
  clear() { this.buffer = ''; this.queue = []; this.closed = false; }
  push(delta, { final = false } = {}) {
    if (typeof delta !== 'string') throw new TypeError('Expected a text delta');
    if (this.closed) {
      if (!delta && final) return [];
      throw new Error('Speech text stream is already final');
    }
    const combined = this.buffer + delta, lastCode = combined.charCodeAt(combined.length - 1);
    const pendingSurrogate = !final && lastCode >= 0xd800 && lastCode <= 0xdbff ? combined.slice(-1) : '';
    const chars = Array.from(pendingSurrogate ? combined.slice(0, -1) : combined), produced = [];
    if (chars.length + pendingSurrogate.length > this.maxBuffered) throw new RangeError('Speech text buffer exceeds bound');
    let start = 0, i = 0;
    while (i < chars.length) {
      const ch = chars[i];
      let terminal = /[。！？!?；;\n]/u.test(ch);
      if (ch === '.') {
        const decimal = /[0-9]/u.test(chars[i - 1] || '') && /[0-9]/u.test(chars[i + 1] || '');
        terminal = !decimal && (i + 1 < chars.length || final);
      }
      if (terminal || i - start + 1 >= this.maxSentence) {
        let end = i + 1;
        if (terminal) {
          while (end < chars.length && /[。！？!?；;”’」』）)]/u.test(chars[end]) && end - start < this.maxSentence) end++;
        }
        const text = chars.slice(start, end).join('').trim();
        if (text) produced.push(text);
        start = end; i = end;
      } else i++;
    }
    let buffer = chars.slice(start).join('') + pendingSurrogate;
    if (final) { if (buffer.trim()) produced.push(buffer.trim()); buffer = ''; }
    if (this.queue.length + produced.length > this.maxQueued) throw new RangeError('Speech sentence queue exceeds bound');
    // Bounds fail atomically: existing text/queue is untouched until here.
    this.buffer = buffer; this.queue.push(...produced); this.closed = Boolean(final);
    return produced.slice();
  }
  shift() { return this.queue.shift(); }
  drain() { const result = this.queue; this.queue = []; return result; }
  snapshot() { return { bufferedCharacters: Array.from(this.buffer).length, queued: this.queue.length, closed: this.closed }; }
}

function copyPcmBytes(pcm) {
  if (pcm instanceof Int16Array) {
    const out = new Uint8Array(pcm.length * 2), view = new DataView(out.buffer);
    for (let i = 0; i < pcm.length; i++) view.setInt16(i * 2, pcm[i], true);
    return out;
  }
  if (pcm instanceof Uint8Array) return pcm.slice();
  if (pcm instanceof ArrayBuffer) return new Uint8Array(pcm.slice(0));
  throw new TypeError('Expected PCM bytes or Int16Array');
}

/** Validates order and ownership; does not itself schedule audible output. */
export class OrderedPcmPlayback {
  constructor({ maxJobs = 256, maxSpeeches = 4096, maxChunkBytes = 1048576 } = {}) {
    for (const value of [maxJobs, maxSpeeches, maxChunkBytes]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('Invalid playback bound');
    }
    this.maxJobs = maxJobs; this.maxSpeeches = maxSpeeches; this.maxChunkBytes = maxChunkBytes;
    this.stop();
  }
  start({ sessionId, generation = 0 } = {}) {
    if (!identifier(sessionId) || !generationValid(generation)) throw new TypeError('Invalid playback session identity');
    this.stop(); this.sessionId = sessionId; this.generation = generation; this.running = true;
  }
  matches(meta) { return this.running && meta?.sessionId === this.sessionId && meta?.generation === this.generation; }
  acceptSpeech(meta) {
    if (!this.matches(meta) || !identifier(meta.speechId)) return false;
    if (meta.speechId === this.speechId) return true;
    if (this.retired.has(meta.speechId) || this.retired.size >= this.maxSpeeches) return false;
    if (this.speechId) this.retired.add(this.speechId);
    this.speechId = meta.speechId; this.jobs.clear(); this.activeJob = null;
    return true;
  }
  invalidateSpeech() {
    if (this.speechId) this.retired.add(this.speechId);
    this.speechId = null; this.jobs.clear(); this.activeJob = null;
  }
  stop() {
    this.running = false; this.sessionId = null; this.generation = null; this.speechId = null;
    this.jobs = new Map(); this.retired = new Set(); this.activeJob = null;
  }
  acceptAudio(meta) {
    if (!this.matches(meta)) return { accepted: false, reason: 'stale_session' };
    if (!this.speechId || meta.speechId !== this.speechId) return { accepted: false, reason: 'stale_speech' };
    const fail = reason => { this.invalidateSpeech(); return { accepted: false, reason, stop: true }; };
    if (!identifier(meta.speechJobId) || !Number.isSafeInteger(meta.sequence) || meta.sequence < 0) return fail('invalid_audio_identity');
    if (meta.encoding !== 'pcm_s16le' || meta.channels !== 1 || !Number.isInteger(meta.sampleRate) || meta.sampleRate < 8000 || meta.sampleRate > 48000) return fail('invalid_audio_format');
    const bytes = meta.pcm?.byteLength;
    if (!Number.isSafeInteger(bytes) || !bytes || bytes % 2 || bytes > this.maxChunkBytes) return fail('invalid_audio_size');
    let pcm;
    try { pcm = copyPcmBytes(meta.pcm); } catch { return fail('invalid_audio_format'); }
    const previous = this.jobs.get(meta.speechJobId);
    if (previous?.final) return fail('finalized_job');
    if (meta.sequence !== (previous?.nextSequence ?? 0)) return fail('audio_sequence');
    if (previous && previous.sampleRate !== meta.sampleRate) return fail('audio_format_changed');
    if (!previous && this.jobs.size >= this.maxJobs) return fail('audio_job_limit');
    if (this.activeJob && this.activeJob !== meta.speechJobId) return fail('audio_job_interleaving');
    const final = meta.final === true;
    this.jobs.set(meta.speechJobId, { nextSequence: meta.sequence + 1, sampleRate: meta.sampleRate, final });
    this.activeJob = final ? null : meta.speechJobId;
    const chunk = {
      sessionId: this.sessionId, generation: this.generation, speechId: this.speechId,
      speechJobId: meta.speechJobId, sequence: meta.sequence, sampleRate: meta.sampleRate,
      channels: 1, encoding: 'pcm_s16le', pcm, final,
    };
    return { accepted: true, chunk };
  }
  accept(meta) { return this.acceptAudio(meta); }
  snapshot() { return { running: this.running, speechId: this.speechId, jobs: this.jobs.size, retiredSpeeches: this.retired.size }; }
}

/**
 * Event-driven capture/turn/speech orchestration. VAD recognizes speech, not a
 * person's identity. With no VAD, RMS candidates require ASR confirmation to
 * interrupt playback. No provider, microphone, timer or network is created here.
 */
export class StreamingVoiceEngine {
  constructor({ onEvent = () => {}, vad = null, clock = () => globalThis.performance?.now() ?? Date.now(), timing = {}, maxVadQueue = 256, maxPendingTurns = 8, playback = {} } = {}) {
    if (typeof onEvent !== 'function' || typeof clock !== 'function') throw new TypeError('Expected event callback and clock');
    if (vad !== null && typeof vad?.push !== 'function') throw new TypeError('VAD must expose push(Int16Array)');
    this.timing = Object.freeze({ ...VOICE_TIMING, ...timing });
    for (const value of Object.values(this.timing)) if (!Number.isFinite(value) || value < 0) throw new RangeError('Invalid voice timing');
    if (this.timing.sampleRate !== 16000 || this.timing.frameSamples !== 320 || this.timing.frameMs !== 20) throw new RangeError('Capture contract is 16 kHz / 320 samples / 20 ms');
    if (!Number.isInteger(this.timing.preRollFrames) || this.timing.preRollFrames < 1 || this.timing.preRollFrames > 200 || this.timing.activityIntervalMs < 20 || !Number.isInteger(this.timing.speechStartFrames) || this.timing.speechStartFrames < 1 || this.timing.maximumUtteranceMs < this.timing.minimumUtteranceMs || this.timing.duckGain > 1) throw new RangeError('Invalid segmentation timing');
    if (!Number.isSafeInteger(maxVadQueue) || maxVadQueue < 1 || !Number.isSafeInteger(maxPendingTurns) || maxPendingTurns < 1) throw new RangeError('Invalid VAD queue bound');
    this.onEvent = onEvent; this.vad = vad; this.clock = clock;
    this.maxVadQueue = maxVadQueue; this.maxPendingTurns = maxPendingTurns;
    this.playback = new OrderedPcmPlayback(playback); this.text = new StreamingTextQueue();
    this.running = false; this.sessionId = null; this.generation = null;
    this._epoch = 0; this._nextGeneration = 0; this._identities = new Set();
    this._cleanups = new Set(); this._vadQueue = []; this._vadBusy = null;
    this._preroll = []; this._turns = new Map(); this._recentTurns = new Map();
    this._turn = null; this._duck = null; this._playbackActive = false; this._lastPlaybackAt = null;
    this._capturedMs = 0; this._startAt = 0; this._frameCounter = 0;
  }
  _emit(type, data = {}) {
    const event = { type, sessionId: this.sessionId, generation: this.generation, ...data };
    // A UI exception must not corrupt capture ownership or leak resources.
    try { this.onEvent(event); } catch (error) { this.lastListenerError = error; }
    return event;
  }
  _now() {
    const value = this.clock();
    return Math.max(Number.isFinite(value) ? value : this._startAt, this._startAt + this._capturedMs);
  }
  _owned(turn) { return this.running && turn?.epoch === this._epoch && !turn.closed; }
  start({ sessionId, inputSampleRate = 16000, generation = this._nextGeneration } = {}) {
    if (!identifier(sessionId) || !generationValid(generation)) throw new TypeError('Invalid voice session identity');
    const key = JSON.stringify([sessionId, generation]);
    if (this._identities.has(key)) throw new Error('Cannot reuse a voice session generation');
    if (this._identities.size >= 4096) throw new RangeError('Session identity history exhausted; create a new engine');
    const framer = new PcmFramer({ inputSampleRate });
    const now = this.clock(); if (!Number.isFinite(now)) throw new TypeError('Clock must return finite milliseconds');
    if (this.running) void this.stop('restart');
    this._epoch++; this._identities.add(key); this._nextGeneration = Math.max(this._nextGeneration, generation + 1);
    this.sessionId = sessionId; this.generation = generation; this.running = true; this.framer = framer;
    this._startAt = now; this._capturedMs = 0; this._frameCounter = 0; this._turnCounter = 0;
    this._nextActivityAt = this.timing.activityIntervalMs; this._activityEnergy = 0; this._activitySamples = 0; this._loudStreak = 0;
    this._preroll = []; this._turns = new Map(); this._recentTurns = new Map(); this._turn = null;
    this._vadEnabled = Boolean(this.vad); this._vadQueue = [];
    this._duck = null; this._playbackActive = false; this._lastPlaybackAt = null;
    this._textSequence = 0; this._textEnded = false; this.text.clear();
    this.playback.start({ sessionId, generation });
    this._emit('session_start', { sampleRate: 16000, inputSampleRate, frameMs: 20, humanVad: this._vadEnabled });
    if (!this._vadEnabled) this._emit('warning', { code: 'vad_unavailable', message: 'RMS candidates use ASR confirmation; no human-speech VAD is loaded.' });
    return { sessionId, generation, sampleRate: 16000, frameMs: 20 };
  }
  push(samples) {
    if (!this.running) return 0;
    const epoch = this._epoch, frames = this.framer.push(samples); let count = 0;
    if (frames.length) {
      // A session may be opened for TTS long before microphone permission is
      // granted. Anchor capture at its first PCM frame, not at session creation.
      const wallNow = this.clock(), expected = this._startAt + this._capturedMs;
      if (Number.isFinite(wallNow) && !this._frameCounter) this._startAt = Math.max(this._startAt, wallNow);
      else if (Number.isFinite(wallNow) && wallNow - expected > 250) {
        // A suspended device cannot splice old preroll or a half-utterance into
        // a new live capture interval. Pending VAD remains owned by its old turn.
        this._endTurn('capture_gap'); this._preroll = [];
        this._loudStreak = 0; this._activityEnergy = 0; this._activitySamples = 0;
        this._startAt += wallNow - expected;
        this._emit('warning', { code: 'capture_gap', message: 'A capture gap ended the previous audio turn.' });
      }
    }
    for (const pcm of frames) {
      if (!this.running || epoch !== this._epoch) break;
      this._processFrame(pcm); count++;
    }
    return count;
  }
  _isAudible(now = this._now()) {
    return Boolean(this.playback.speechId && (this._playbackActive || (this._lastPlaybackAt !== null && now - this._lastPlaybackAt <= this.timing.playbackGapMs)));
  }
  setPlaybackActive(active) {
    if (!this.running) return;
    if (active || this._playbackActive) this._lastPlaybackAt = this._now();
    this._playbackActive = Boolean(active);
  }
  tick(now = this._now()) {
    if (!this.running || !Number.isFinite(now)) return;
    if (this._duck && now - this._duck.lastAt >= this.timing.releaseAfterQuietMs) this._restoreGain();
  }
  _processFrame(pcm) {
    const epoch = this._epoch; this._capturedMs += 20; this._frameCounter++;
    const at = this._startAt + this._capturedMs;
    let energy = 0; for (const sample of pcm) energy += (sample / 32768) ** 2;
    const rms = Math.sqrt(energy / pcm.length);
    const threshold = this._isAudible(at) ? this.timing.bargeInThreshold : this.timing.speechThreshold;
    const frame = { pcm, at, index: this._frameCounter, loud: rms >= threshold, pending: this._vadEnabled, human: false, turn: null };
    this.tick(at);
    if (!this.running || epoch !== this._epoch) return;
    if (this._turn) this._attachFrame(this._turn, frame);
    else {
      this._preroll.push(frame);
      if (this._preroll.length > this.timing.preRollFrames) this._preroll.shift();
    }
    this._activityEnergy += energy; this._activitySamples += pcm.length;
    if (this._capturedMs >= this._nextActivityAt) {
      const activityRms = Math.sqrt(this._activityEnergy / this._activitySamples);
      this._activityEnergy = 0; this._activitySamples = 0;
      while (this._nextActivityAt <= this._capturedMs) this._nextActivityAt += this.timing.activityIntervalMs;
      this._loudStreak = activityRms >= threshold ? this._loudStreak + 1 : 0;
      if (!this._turn && this._loudStreak >= this.timing.speechStartFrames) this._beginTurn();
    }
    if (!this.running || epoch !== this._epoch) return;
    if (this._vadEnabled) this._enqueueVad(frame);
    else frame.pending = false;
    const turn = this._turn;
    if (!this._owned(turn)) return;
    this._flushTurn(turn);
    const duration = at - turn.firstAt + 20;
    if (duration >= this.timing.maximumUtteranceMs) this._endTurn('max_duration');
    else if (at - turn.lastLoudAt >= this.timing.silenceMs) this._endTurn('silence');
  }
  _attachFrame(turn, frame) {
    frame.turn = turn; turn.held.push(frame); turn.frameCount++; turn.lastAt = frame.at;
    if (frame.pending) turn.pendingVad++;
    if (frame.loud) { turn.voicedMs += 20; turn.lastLoudAt = frame.at; }
  }
  _beginTurn() {
    if (this._turns.size >= this.maxPendingTurns) this._fallbackVad('vad_pending_turn_limit');
    const frames = this._preroll; this._preroll = [];
    const turn = {
      epoch: this._epoch, turnId: 'turn-' + this.generation + '-' + (++this._turnCounter),
      firstAt: frames[0]?.at ?? this._now(), lastAt: this._now(), lastLoudAt: this._now(),
      frameCount: 0, voicedMs: 0, sequence: 0, held: [], pendingVad: 0,
      confirmed: false, fallback: !this._vadEnabled, ended: false, closed: false,
      interruptSpeechId: this._isAudible() ? this.playback.speechId : null,
    };
    this._turn = turn; this._turns.set(turn.turnId, turn);
    for (const frame of frames) this._attachFrame(turn, frame);
    this._emit('turn_start', { turnId: turn.turnId, sampleRate: 16000, frameMs: 20, preRollFrames: frames.length, humanVad: false });
    if (!this._owned(turn)) return;
    const humanFrame = frames.find(frame => frame.human);
    if (humanFrame) this._confirmVad(turn, humanFrame);
    this._flushTurn(turn);
  }
  _flushTurn(turn) {
    if (!this._owned(turn) || (!turn.confirmed && !turn.fallback)) return;
    while (turn.held.length && this._owned(turn)) {
      const frame = turn.held.shift();
      this._emit('audio_frame', {
        turnId: turn.turnId, sequence: turn.sequence++, pcm: frame.pcm.slice(),
        sampleRate: 16000, channels: 1, encoding: 'pcm_s16le', frameMs: 20, humanVad: turn.confirmed,
      });
    }
  }
  _endTurn(reason) {
    const turn = this._turn;
    if (!this._owned(turn)) return;
    this._turn = null; this._loudStreak = 0; turn.ended = true; turn.reason = reason;
    this._tryFinalize(turn);
  }
  _tryFinalize(turn) {
    if (!this._owned(turn) || !turn.ended) return;
    if (turn.voicedMs < this.timing.minimumUtteranceMs) return this._finalize(turn, 'too_short');
    if (turn.confirmed || turn.fallback) { this._flushTurn(turn); return this._finalize(turn); }
    if (!turn.pendingVad) this._finalize(turn, 'no_human_speech');
  }
  _finalize(turn, discarded = null) {
    if (!this._owned(turn)) return;
    turn.closed = true; turn.held = []; this._turns.delete(turn.turnId);
    this._recentTurns.set(turn.turnId, { ...turn, discarded, held: [] });
    while (this._recentTurns.size > 16) this._recentTurns.delete(this._recentTurns.keys().next().value);
    this._emit(discarded ? 'turn_discarded' : 'turn_end', {
      turnId: turn.turnId, frameCount: turn.frameCount, emittedFrames: turn.sequence,
      durationMs: turn.lastAt - turn.firstAt + 20, voicedMs: turn.voicedMs,
      reason: discarded || turn.reason, humanVad: turn.confirmed,
    });
  }
  _enqueueVad(frame) {
    if (this._vadQueue.length >= this.maxVadQueue) { this._fallbackVad('vad_backlog'); return; }
    this._vadQueue.push({ frame, epoch: this._epoch }); this._pumpVad();
  }
  _pumpVad() {
    if (this._vadBusy || !this.running || !this._vadEnabled) return;
    while (this._vadQueue.length && !this._vadBusy && this.running && this._vadEnabled) {
      const job = this._vadQueue.shift();
      if (job.epoch !== this._epoch || !job.frame) continue;
      let result;
      try { result = this.vad.push(job.frame.pcm.slice()); }
      catch { this._fallbackVad('vad_failed'); return; }
      if (result && typeof result.then === 'function') {
        this._vadBusy = job;
        Promise.resolve(result).then(value => this._settleVad(job, value), () => {
          if (this.running && job.epoch === this._epoch) this._fallbackVad('vad_failed');
        }).finally(() => {
          if (this._vadBusy === job) this._vadBusy = null;
          this._pumpVad();
        });
      } else this._settleVad(job, result);
    }
  }
  _settleVad(job, result) {
    if (!this.running || job.epoch !== this._epoch || !job.frame || !this._vadEnabled) return;
    if (result != null && (typeof result !== 'object' || typeof result.speech !== 'boolean')) { this._fallbackVad('vad_invalid_result'); return; }
    const frame = job.frame, turn = frame.turn;
    frame.pending = false; frame.human = result?.speech === true;
    frame.score = Number.isFinite(result?.score) ? result.score : null;
    if (turn && !turn.closed) {
      turn.pendingVad = Math.max(0, turn.pendingVad - 1);
      if (frame.human) this._confirmVad(turn, frame);
      this._tryFinalize(turn);
    }
  }
  _confirmVad(turn, frame) {
    if (!this._owned(turn)) return;
    if (!turn.confirmed) {
      turn.confirmed = true;
      this._emit('turn_confirmed', { turnId: turn.turnId, source: 'human_vad', score: frame.score ?? null, humanVad: true });
      this._flushTurn(turn);
    }
    // Delayed or ended-turn classifications may authorize ASR buffering, never
    // stop a newer response. A decision > 250 ms behind capture is not live.
    const now = this._now();
    if (!this._owned(turn) || turn !== this._turn || turn.ended || now - frame.at > 250 || !turn.interruptSpeechId || turn.interruptSpeechId !== this.playback.speechId || !this._isAudible(now)) return;
    if (!this._duck || this._duck.turnId !== turn.turnId || now - this._duck.lastAt >= this.timing.releaseAfterQuietMs) {
      this._restoreGain();
      this._duck = { turnId: turn.turnId, speechId: this.playback.speechId, firstAt: now, lastAt: now };
      this._emit('playback_gain', { gain: this.timing.duckGain, rampSeconds: this.timing.rampSeconds, speechId: this.playback.speechId });
    } else this._duck.lastAt = now;
    if (this._duck && now - this._duck.firstAt >= this.timing.holdMs) this._interruptPlayback('human_speech', turn.interruptSpeechId);
  }
  _fallbackVad(code) {
    if (!this._vadEnabled) return;
    this._vadEnabled = false; this._vadQueue = [];
    this._restoreGain();
    this._emit('warning', { code, message: 'Human-speech VAD unavailable; using ASR-confirmed candidates.', humanVad: false });
    for (const turn of [...this._turns.values()]) {
      turn.pendingVad = 0; turn.fallback = true;
      this._flushTurn(turn); this._tryFinalize(turn);
    }
  }
  _restoreGain() {
    if (!this._duck) return;
    const speechId = this._duck.speechId; this._duck = null;
    this._emit('playback_gain', { gain: 1, rampSeconds: this.timing.rampSeconds, speechId });
  }
  _interruptPlayback(reason, speechId = this.playback.speechId, notifyRemote = true) {
    if (!speechId || speechId !== this.playback.speechId) return false;
    this.playback.invalidateSpeech(); this.text.clear(); this._textSequence = 0; this._textEnded = false;
    this._playbackActive = false; this._lastPlaybackAt = null;
    this._emit('playback_stop', { reason, speechId, intent: 'stop_playback', notifyRemote });
    this._restoreGain(); return true;
  }
  stopPlayback(reason = 'user_stop') {
    if (!this.running) return false;
    return this._interruptPlayback(reason, this.playback.speechId, false);
  }
  confirmTranscript({ sessionId, generation, turnId, text } = {}) {
    if (!this.running || sessionId !== this.sessionId || generation !== this.generation || typeof text !== 'string' || !text.trim()) return false;
    const turn = this._turns.get(turnId) || this._recentTurns.get(turnId);
    if (!turn || turn.epoch !== this._epoch || turn.discarded) return false;
    this._emit('transcript_confirmed', { turnId, source: 'asr', humanVad: turn.confirmed });
    if (turn.interruptSpeechId === this.playback.speechId && this._isAudible()) this._interruptPlayback('asr_confirmed', turn.interruptSpeechId);
    return true;
  }
  acceptSpeech(meta) {
    if (!this.running) return false;
    const previous = this.playback.speechId;
    if (!this.playback.acceptSpeech(meta)) return false;
    if (previous === meta.speechId) return true;
    this.text.clear(); this._textSequence = 0; this._textEnded = false;
    this._playbackActive = false; this._lastPlaybackAt = null; this._restoreGain();
    if (previous) this._emit('playback_stop', { reason: 'speech_replaced', speechId: previous, intent: 'stop_playback', notifyRemote: false });
    return true;
  }
  acceptAudio(meta) {
    if (!this.running) return { accepted: false, reason: 'session_stopped' };
    const speechId = this.playback.speechId, result = this.playback.acceptAudio(meta);
    if (result.accepted) {
      this._lastPlaybackAt = this._now();
      this._emit('playback_audio', { ...result.chunk, pcm: result.chunk.pcm.slice() });
    } else if (result.stop) {
      this._playbackActive = false; this._lastPlaybackAt = null; this.text.clear(); this._restoreGain();
      this._emit('playback_stop', { reason: result.reason, speechId, intent: 'stop_playback', notifyRemote: false });
    }
    return result;
  }
  pushText(delta, { final = false, sessionId = this.sessionId, generation = this.generation, speechId = this.playback.speechId } = {}) {
    if (!this.running || sessionId !== this.sessionId || generation !== this.generation || !speechId || speechId !== this.playback.speechId) return [];
    const sentences = this.text.push(delta, { final }); this.text.drain();
    const epoch = this._epoch, events = [];
    for (let i = 0; i < sentences.length; i++) {
      if (!this.running || epoch !== this._epoch || speechId !== this.playback.speechId) break;
      events.push(this._emit('speech_text', { speechId, sequence: this._textSequence++, text: sentences[i], final: Boolean(final && i === sentences.length - 1) }));
    }
    if (final && !this._textEnded && this.running && epoch === this._epoch && speechId === this.playback.speechId) {
      this._textEnded = true; this._emit('speech_text_end', { speechId, sentenceCount: this._textSequence });
    }
    return events;
  }
  ownCleanup(fn) {
    if (typeof fn !== 'function') throw new TypeError('Expected cleanup function');
    this._cleanups.add(fn); return () => this._cleanups.delete(fn);
  }
  stop(reason = 'stopped') {
    const wasRunning = this.running, sessionId = this.sessionId, generation = this.generation, speechId = this.playback.speechId;
    this.running = false; this._epoch++;
    this._preroll = []; this._vadQueue = [];
    if (this._vadBusy) this._vadBusy.frame = null;
    for (const turn of this._turns.values()) { turn.closed = true; turn.held = []; }
    this._turns.clear(); this._recentTurns.clear(); this._turn = null;
    this.framer?.reset(); this.text.clear(); this.playback.stop();
    this._vadEnabled = false; this._capturedMs = 0; this._frameCounter = 0;
    this._activityEnergy = 0; this._activitySamples = 0; this._loudStreak = 0;
    this._playbackActive = false; this._lastPlaybackAt = null; this._restoreGain();
    if (wasRunning) {
      this._emit('playback_stop', { reason, speechId, intent: 'stop_playback', notifyRemote: false });
      this._emit('session_stop', { reason });
    }
    const cleanups = [...this._cleanups]; this._cleanups.clear();
    return Promise.allSettled(cleanups.map(fn => Promise.resolve().then(fn))).then(results => {
      for (const result of results) if (result.status === 'rejected') this._emit('warning', { sessionId, generation, code: 'cleanup_failed', message: 'An owned resource failed to clean up.' });
      return results;
    });
  }
  snapshot() {
    return {
      running: this.running, sessionId: this.sessionId, generation: this.generation,
      capturedFrames: this._frameCounter, preRollFrames: this._preroll.length,
      activeTurnId: this._turn?.turnId ?? null, pendingTurns: this._turns.size,
      vadEnabled: this._vadEnabled === true, queuedVadFrames: this._vadQueue.length,
      vadInFlight: Boolean(this._vadBusy?.epoch === this._epoch),
      gain: this._duck ? this.timing.duckGain : 1,
      text: this.text.snapshot(), playback: this.playback.snapshot(),
    };
  }
}
