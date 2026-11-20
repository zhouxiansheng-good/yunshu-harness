import { createHash } from 'node:crypto';

export class SubmissionNotSentError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

// Ambiguous failures remain terminal for the same id. Never replay followup
// merely because the response disappeared. Bounded for this plugin lifetime;
// no false cross-restart exactly-once promise is made.
export class VoiceSubmissions {
  constructor({ limit = 2048 } = {}) { this.limit = limit; this.entries = new Map(); }
  send(sessionId, requestId, text, operation) {
    if (typeof requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(requestId)) throw new Error('发送标识无效');
    const key = sessionId + '\0' + requestId, hash = createHash('sha256').update(text).digest('hex'), old = this.entries.get(key);
    if (old) { if (old.hash !== hash) throw new Error('发送标识已使用'); return old.promise; }
    if (this.entries.size >= this.limit) throw new Error('发送记录已达上限，请重启语音插件');
    const promise = Promise.resolve().then(operation).catch(error => {
      if (error instanceof SubmissionNotSentError) throw error;
      throw new Error('发送结果未确认，请先核对会话');
    });
    void promise.catch(() => {}); this.entries.set(key, { hash, promise }); return promise;
  }
  close() { this.entries.clear(); }
}
