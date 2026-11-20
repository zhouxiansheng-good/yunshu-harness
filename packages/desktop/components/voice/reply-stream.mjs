import { StreamingTextQueue } from './streaming-engine.mjs';

export const REPLY_STREAM_EVENT = 'agent/assistant-stream';
const positive = value => Number.isSafeInteger(value) && value > 0;
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
const sessionIdOf = agent => agent?.session?.header?.id;

/**
 * Subscribes to public Harness assistant frames. A speech consumer may also
 * request finalized public text for models that deliver a complete reply in
 * one block. That text is emitted only on a successful commit. This bridge neither invokes TTS nor cancels an
 * agent task. Consumers must honor cancellation controls in poll().events.
 */
export class ReplyStreamBridge {
  constructor(ctx, {
    clock = () => Date.now(), onEvent = () => {}, maxSessions = 100,
    ttlMs = 120000, maxQueued = 128, maxQueuedChars = 24000,
    maxTextChars = 12000, maxSentence = 180, maxBlocks = 256, speakCommittedText = false,
  } = {}) {
    if (typeof ctx?.on !== 'function' || typeof ctx?.effect !== 'function') throw new TypeError('Expected a Cordis-compatible context');
    if (typeof clock !== 'function' || typeof onEvent !== 'function') throw new TypeError('Expected clock and event callback');
    for (const value of [maxSessions, ttlMs, maxQueued, maxQueuedChars, maxTextChars, maxSentence, maxBlocks]) {
      if (!positive(value)) throw new RangeError('Reply stream bounds must be positive safe integers');
    }
    this.ctx = ctx; this.clock = clock; this.onEvent = onEvent; this.speakCommittedText = speakCommittedText;
    this.limits = { maxSessions, ttlMs, maxQueued, maxQueuedChars, maxTextChars, maxSentence, maxBlocks };
    this.states = new Map(); this.disposers = []; this.closed = false; this.listenerFailures = 0;
    try {
      this.disposers.push(ctx.on(REPLY_STREAM_EVENT, payload => this._frame(payload)));
      this.disposers.push(ctx.on('session/event', (session, event) => this._sessionEvent(session, event)));
      this.disposers.push(ctx.on('agent/error', payload => this._agentError(payload)));
      this.disposers.push(ctx.on('agent/status', payload => this._agentStatus(payload)));
      ctx.effect(() => () => this.close());
    } catch (error) { this.close(); throw error; }
  }
  _now() { const now = this.clock(); if (!Number.isFinite(now)) throw new TypeError('Reply stream clock must be finite'); return now; }
  _requireOpen() { if (this.closed) throw new Error('Reply stream bridge is closed'); }
  _identity(agent, generation) {
    const sessionId = sessionIdOf(agent);
    if (!agent || !id(sessionId) || !id(agent.id) || !nonnegative(generation)) throw new TypeError('Invalid reply stream identity');
    return sessionId;
  }
  _find(agent, generation) {
    const state = this.states.get(sessionIdOf(agent));
    if (!state || state.agent !== agent || (generation !== undefined && state.generation !== generation)) return null;
    if (state.expires <= this._now()) { this._retire(state, 'expired'); return null; }
    return state;
  }
  _base(state, attempt = state.current) {
    return {
      sessionId: state.sessionId, agentId: state.agent.id, generation: state.generation,
      attemptId: attempt?.attemptId ?? null, turn: attempt?.turn ?? null, step: attempt?.step ?? null,
    };
  }
  _notify(event) {
    try {
      const result = this.onEvent({ ...event });
      if (result && typeof result.then === 'function') Promise.resolve(result).catch(() => { this.listenerFailures++; });
    } catch { this.listenerFailures++; }
  }
  _append(state, event) {
    const record = { ...this._base(state), ...event, seq: ++state.seq };
    state.events.push(record); state.queuedChars += record.text?.length ?? 0;
    this._notify(record); return record;
  }
  _prune(state, predicate) {
    state.events = state.events.filter(event => !predicate(event));
    state.queuedChars = state.events.reduce((n, event) => n + (event.text?.length ?? 0), 0);
  }
  _cancelAttempt(state, reason, { all = false, turn } = {}) {
    const attempt = state.current, metadata = this._base(state, attempt);
    if (turn !== undefined && attempt?.turn !== turn) { metadata.attemptId = null; metadata.turn = turn; metadata.step = null; }
    if (all) this._prune(state, () => true);
    else if (turn !== undefined) this._prune(state, event => event.turn === turn);
    else if (attempt) this._prune(state, event => event.attemptId === attempt.attemptId);
    if (attempt && (turn === undefined || attempt.turn === turn)) {
      attempt.text.clear(); state.current = null;
    }
    // Reserve one explicit control even when a consumer has stopped polling.
    if (state.events.length >= this.limits.maxQueued) this._prune(state, () => true);
    return this._append(state, { ...metadata, ...(turn === undefined ? {} : { turn }), type: 'cancel', reason });
  }
  _overflow(state, reason = 'queue_overflow') {
    state.gap = true; this._cancelAttempt(state, reason, { all: true });
  }
  watch(agent, { generation = 0, signal } = {}) {
    this._requireOpen(); const sessionId = this._identity(agent, generation); this.sweep();
    if (signal?.aborted) throw new Error('Reply stream watch aborted');
    const existing = this.states.get(sessionId);
    if (existing?.agent === agent && existing.generation === generation) {
      existing.expires = this._now() + this.limits.ttlMs;
      return { seq: existing.seq, generation, live: true, expired: false };
    }
    if (existing) this._retire(existing, 'watch_replaced');
    if (this.states.size >= this.limits.maxSessions) throw new RangeError('Too many reply stream sessions');
    const state = {
      agent, sessionId, generation, expires: this._now() + this.limits.ttlMs,
      seq: 0, acknowledged: 0, events: [], queuedChars: 0, current: null,
      lastRevision: 0, lastAttemptId: null, gap: false, abortCleanup: null,
    };
    this.states.set(sessionId, state);
    if (signal) {
      if (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function') {
        this.states.delete(sessionId); throw new TypeError('Invalid watch abort signal');
      }
      const abort = () => { if (this.states.get(sessionId) === state) this._retire(state, 'watch_aborted'); };
      signal.addEventListener('abort', abort, { once: true });
      state.abortCleanup = () => signal.removeEventListener('abort', abort);
      if (signal.aborted) abort();
    }
    return { seq: state.seq, generation, live: true, expired: !this.states.has(sessionId) };
  }
  poll(agent, { generation = 0, after = 0 } = {}) {
    this._requireOpen(); this._identity(agent, generation);
    if (!nonnegative(after)) throw new TypeError('Invalid reply cursor');
    const state = this._find(agent, generation);
    if (!state) return { seq: 0, replies: [], events: [], expired: true, gap: false };
    if (after > state.seq) throw new RangeError('Reply cursor is ahead of the stream');
    state.expires = this._now() + this.limits.ttlMs;
    if (after < state.acknowledged) return { seq: state.seq, replies: [], events: [], expired: false, gap: true };
    state.acknowledged = after; this._prune(state, event => event.seq <= after);
    const events = state.events.map(event => ({ ...event }));
    const gap = state.gap; state.gap = false;
    return { seq: state.seq, replies: events.filter(event => event.type === 'sentence'), events, expired: false, gap };
  }
  cancel(agent, { generation = 0, reason = 'cancelled' } = {}) {
    this._requireOpen(); this._identity(agent, generation);
    const state = this._find(agent, generation); if (!state) return { cancelled: false };
    // Only finite reason codes, never raw model/error text, enter controls.
    this._cancelAttempt(state, typeof reason === 'string' && /^[a-z_]{1,64}$/u.test(reason) ? reason : 'cancelled', { all: true });
    return { cancelled: true, seq: state.seq };
  }
  unwatch(agent, { generation = 0 } = {}) {
    if (this.closed) return { stopped: false };
    this._identity(agent, generation); const state = this._find(agent, generation);
    if (!state) return { stopped: false };
    this._retire(state, 'unwatch'); return { stopped: true };
  }
  _retire(state, reason) {
    if (this.states.get(state.sessionId) !== state) return;
    this.states.delete(state.sessionId); state.abortCleanup?.(); state.abortCleanup = null;
    const event = { ...this._base(state), type: 'cancel', reason, seq: ++state.seq };
    state.current?.text.clear(); state.current = null; state.events = []; state.queuedChars = 0;
    this._notify(event);
  }
  sweep() {
    if (this.closed) return;
    const now = this._now();
    for (const state of [...this.states.values()]) if (state.expires <= now) this._retire(state, 'expired');
  }
  _frame({ agent, frame } = {}) {
    if (this.closed) return;
    const state = this._find(agent); if (!state || !frame || typeof frame !== 'object') return;
    if (!positive(frame.revision) || !id(frame.attemptId)) {
      if (state.current) this._cancelAttempt(state, 'invalid_frame'); return;
    }
    if (frame.revision <= state.lastRevision) return;
    if (frame.type === 'start') {
      if (!positive(frame.turn) || !positive(frame.step) || frame.attemptId === state.lastAttemptId) return;
      if (state.current) this._cancelAttempt(state, 'attempt_replaced');
      state.lastRevision = frame.revision; state.lastAttemptId = frame.attemptId;
      state.current = {
        attemptId: frame.attemptId, turn: frame.turn, step: frame.step, nextIndex: 0,
        sentenceIndex: 0, characters: 0, textIndex: null, blocks: new Map(), finished: false,
        // Stage one bounded text delta atomically; the external queue budget is
        // enforced by _sentences so overflow has an explicit cancel contract.
        text: new StreamingTextQueue({ maxSentence: this.limits.maxSentence, maxBuffered: this.limits.maxTextChars, maxQueued: this.limits.maxTextChars }),
      };
      return;
    }
    const attempt = state.current;
    if (!attempt || attempt.attemptId !== frame.attemptId) return;
    if (frame.revision !== state.lastRevision + 1) {
      state.lastRevision = frame.revision; this._cancelAttempt(state, 'stream_revision_gap'); return;
    }
    state.lastRevision = frame.revision;
    if (!nonnegative(frame.index) || frame.index !== attempt.nextIndex) { this._cancelAttempt(state, 'stream_index_gap'); return; }
    if (frame.type === 'chunk') {
      attempt.nextIndex++;
      try { this._chunk(state, attempt, frame.chunk); }
      catch { if (state.current === attempt) this._cancelAttempt(state, 'invalid_text_stream'); }
      return;
    }
    if (frame.type !== 'end') { this._cancelAttempt(state, 'invalid_frame'); return; }
    if (frame.outcome?.kind !== 'committed' || frame.outcome.eventType !== 'assistant/message' || !nonnegative(frame.outcome.seq)) {
      this._cancelAttempt(state, frame.outcome?.kind === 'abandoned' ? 'attempt_abandoned' : 'attempt_not_message'); return;
    }
    if (this.speakCommittedText && !attempt.characters) {
      const body = attempt.finalSeq === frame.outcome.seq ? attempt.finalBody :
        [...attempt.blocks.values()].map(block => block.publicText || '').filter(Boolean).join('\n');
      if (body) {
        if (body.length > this.limits.maxTextChars) { this._cancelAttempt(state, 'text_limit'); return; }
        const sentences = attempt.text.push(body);
        attempt.text.drain();
        this._sentences(state, attempt, sentences, false);
        if (state.current !== attempt) return;
      }
    }
    this._flushText(state, attempt, true);
    if (state.current !== attempt) return;
    if (state.events.length >= this.limits.maxQueued) { this._overflow(state); return; }
    const metadata = this._base(state, attempt);
    state.current = null;
    this._append(state, { ...metadata, type: 'end', final: true, sentenceCount: attempt.sentenceIndex, committedSeq: frame.outcome.seq });
  }
  _block(state, attempt, index, type) {
    if (!nonnegative(index)) throw new TypeError('Invalid block index');
    let block = attempt.blocks.get(index);
    if (!block) {
      if (attempt.blocks.size >= this.limits.maxBlocks) { this._cancelAttempt(state, 'block_limit'); return null; }
      block = { type, closed: false }; attempt.blocks.set(index, block);
    }
    return block;
  }
  _chunk(state, attempt, chunk) {
    if (!chunk || typeof chunk !== 'object' || typeof chunk.type !== 'string') throw new TypeError('Invalid chunk');
    if (chunk.type === 'text-delta') {
      const block = this._block(state, attempt, chunk.index, 'text');
      if (!block || block.closed || block.type !== 'text') return;
      if (attempt.finished || typeof chunk.text !== 'string') throw new TypeError('Invalid public delta');
      if (attempt.characters + chunk.text.length > this.limits.maxTextChars) { this._cancelAttempt(state, 'text_limit'); return; }
      if (attempt.textIndex !== null && attempt.textIndex !== chunk.index) this._flushText(state, attempt, false);
      if (state.current !== attempt) return;
      attempt.textIndex = chunk.index; attempt.characters += chunk.text.length;
      const sentences = attempt.text.push(chunk.text); attempt.text.drain();
      this._sentences(state, attempt, sentences, false);
    } else if (chunk.type === 'block-start') {
      this._block(state, attempt, chunk.index, chunk.blockType);
    } else if (chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta') {
      // No inspection, concatenation or logging of these chunk bodies.
      this._block(state, attempt, chunk.index, chunk.type === 'reasoning-delta' ? 'reasoning' : 'tool-call');
    } else if (chunk.type === 'block-end') {
      const block = this._block(state, attempt, chunk.index, chunk.block?.type);
      if (!block || block.closed) return;
      block.closed = true;
      if (this.speakCommittedText && !attempt.characters && block.type === 'text' && chunk.block?.type === 'text') {
        const value = chunk.block.text;
        if (typeof value === 'string') {
          attempt.finalChars = (attempt.finalChars || 0) + value.length;
          if (attempt.finalChars > this.limits.maxTextChars) { this._cancelAttempt(state, 'text_limit'); return; }
          block.publicText = value;
        }
      }
      if (block.type === 'text' && attempt.textIndex === chunk.index) this._flushText(state, attempt, false);
    } else if (chunk.type === 'finish') {
      const kind = chunk.reason?.kind;
      if (kind === 'error' || kind === 'aborted') this._cancelAttempt(state, 'model_' + kind);
      else attempt.finished = true;
    }
  }
  _sentences(state, attempt, sentences, final) {
    if (!sentences.length || state.current !== attempt) return;
    const chars = sentences.reduce((sum, text) => sum + text.length, 0);
    if (state.events.length + sentences.length > this.limits.maxQueued || state.queuedChars + chars > this.limits.maxQueuedChars) { this._overflow(state); return; }
    for (let i = 0; i < sentences.length; i++) {
      if (this.closed || this.states.get(state.sessionId) !== state || state.current !== attempt) break;
      this._append(state, { type: 'sentence', text: sentences[i], sentenceIndex: attempt.sentenceIndex++, final: Boolean(final && i === sentences.length - 1) });
    }
  }
  _flushText(state, attempt, final) {
    if (state.current !== attempt) return;
    const sentences = attempt.text.push('', { final: true }); attempt.text.drain();
    this._sentences(state, attempt, sentences, final);
    attempt.text.clear(); attempt.textIndex = null;
  }
  _sessionEvent(session, event) {
    if (this.closed) return;
    const state = this.states.get(session?.header?.id);
    if (!state || state.agent.session !== session || !this._find(state.agent, state.generation)) return;
    const attempt = state.current, data = event?.data;
    if (!data || typeof data !== 'object') return;
    if (event.type === 'turn/end' && (data.reason?.kind === 'aborted' || data.reason?.kind === 'error')) {
      if (attempt?.turn === data.turn || state.events.some(record => record.turn === data.turn)) this._cancelAttempt(state, 'turn_' + data.reason.kind, { turn: data.turn });
    } else if (attempt && data.turn === attempt.turn && data.step === attempt.step) {
      if (event.type === 'assistant/message' && data.interrupted === true) this._cancelAttempt(state, 'message_interrupted');
      else if (event.type === 'assistant/attempt') this._cancelAttempt(state, 'attempt_not_message');
      else if (this.speakCommittedText && event.type === 'assistant/message' && !attempt.characters && Array.isArray(data.message?.content)) {
        const parts = []; let length = 0;
        for (const block of data.message.content) {
          if (block.type !== 'text' || typeof block.text !== 'string') continue;
          length += block.text.length + (parts.length ? 1 : 0);
          if (length > this.limits.maxTextChars) { this._cancelAttempt(state, 'text_limit'); return; }
          parts.push(block.text);
        }
        attempt.finalSeq = event.seq; attempt.finalBody = parts.join('\n');
      }
    }
  }
  _agentError({ agent, turn } = {}) {
    if (this.closed) return;
    const state = this._find(agent); if (!state) return;
    if (state.current && (turn === undefined || state.current.turn === turn)) this._cancelAttempt(state, 'agent_error');
  }
  _agentStatus({ agent, status } = {}) {
    if (this.closed || status !== 'idle') return;
    const state = this._find(agent); if (state?.current) this._cancelAttempt(state, 'agent_idle_before_end');
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const state of [...this.states.values()]) this._retire(state, 'bridge_closed');
    for (const dispose of this.disposers.splice(0).reverse()) { try { if (typeof dispose === 'function') dispose(); } catch {} }
  }
  snapshot() {
    return { closed: this.closed, sessions: this.states.size, listenerFailures: this.listenerFailures,
      queued: [...this.states.values()].reduce((n, state) => n + state.events.length, 0),
      queuedCharacters: [...this.states.values()].reduce((n, state) => n + state.queuedChars, 0),
      activeAttempts: [...this.states.values()].filter(state => state.current).length };
  }
}
