import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const BGE_MODEL_KEY = 'bge-m3-int8:a206e10e995aa2a8:tokenizers-0.2.0:cls-l2:chars65536:chunks512-overlap64-mean-l2:limit8192:v1';
const abortError = () => new DOMException('已取消', 'AbortError');

function inferenceProcess() {
  const child = fork(fileURLToPath(new URL('./embedding-worker.mjs', import.meta.url)), [], {
    execArgv: [], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced', windowsHide: true,
  });
  child.postMessage = message => child.send(message);
  const ref = child.ref.bind(child), unref = child.unref.bind(child);
  child.ref = () => { ref(); child.channel?.ref(); };
  child.unref = () => { unref(); child.channel?.unref(); };
  child.terminate = () => new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    child.ref(); child.once('exit', resolve); child.kill();
  });
  return child;
}

// One isolated CPU subprocess: native runtime faults cannot terminate the host.
// Only this local provider is allowed on automatic
// capture/pre-step paths; explicit remote providers never receive those jobs.
export class LocalEmbedding {
  constructor({ timeoutMs = 120000, maxQueue = 32, workerFactory = inferenceProcess } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || !Number.isInteger(maxQueue) || maxQueue < 1) throw new TypeError('Invalid embedding queue configuration');
    this.local = true; this.modelKey = BGE_MODEL_KEY; this.timeoutMs = timeoutMs; this.maxQueue = maxQueue;
    this.workerFactory = workerFactory; this.queue = []; this.active = null; this.worker = null; this.stopping = null; this.closed = false; this.serial = 0;
  }
  embed(input, signal, { priority = 'query' } = {}) {
    if (this.closed) return Promise.reject(new Error('向量模型已关闭'));
    if (signal?.aborted) return Promise.reject(signal.reason ?? abortError());
    if (typeof input !== 'string' || !input.trim()) return Promise.reject(new TypeError('向量文本长度无效'));
    // Complete rounds can legitimately exceed the individual-message limit.
    // Bound tokenization/IPC work instead of poisoning the durable index queue.
    input = input.slice(0, 65536);
    if (this.queue.length >= this.maxQueue) return Promise.reject(new Error('索引繁忙，请稍后重试'));
    return new Promise((resolve, reject) => {
      const job = { id: ++this.serial, input, signal, priority, resolve, reject };
      job.abort = () => {
        if (this.active === job) { this.finish(job, signal.reason ?? abortError()); this.stopWorker(); }
        else { this.queue = this.queue.filter(p => p !== job); this.finish(job, signal.reason ?? abortError()); }
      };
      signal?.addEventListener('abort', job.abort, { once: true });
      this.queue.push(job); this.pump();
    });
  }
  finish(job, error, vector) {
    if (job.done) return;
    job.done = true; clearTimeout(job.timer); job.signal?.removeEventListener('abort', job.abort);
    if (this.active === job) this.active = null;
    if (error) job.reject(error); else job.resolve(vector);
  }
  stopWorker() {
    const worker = this.worker; this.worker = null;
    if (!worker) { queueMicrotask(() => this.pump()); return this.stopping; }
    const stopping = Promise.resolve(worker.terminate()).catch(() => {}).finally(() => {
      if (this.stopping === stopping) this.stopping = null;
      this.pump();
    });
    this.stopping = stopping; return stopping;
  }
  pump() {
    if (this.closed || this.stopping || this.active || !this.queue.length) return;
    clearTimeout(this.idleTimer);
    const query = this.queue.findIndex(job => job.priority !== 'background');
    const job = this.queue.splice(query < 0 ? 0 : query, 1)[0]; this.active = job;
    try {
      if (!this.worker) {
        const worker = this.workerFactory({ execArgv: [] }); this.worker = worker;
        const fail = error => {
          if (this.worker !== worker) return;
          if (this.active) this.finish(this.active, error);
          this.stopWorker();
        };
        worker.on('error', () => fail(new Error('本地向量模型启动失败')));
        worker.on('exit', () => fail(new Error('本地向量模型已退出')));
        worker.on('message', message => {
          if (this.worker !== worker || message.id !== this.active?.id) return;
          if (message.error) { fail(new Error('本地向量计算失败')); return; }
          const vector = message.vector;
          if (!Array.isArray(vector) || vector.length !== 1024 || vector.some(v => !Number.isFinite(v))) { fail(new Error('向量结果无效')); return; }
          this.finish(this.active, null, vector); worker.unref();
          this.idleTimer = setTimeout(() => { if (!this.active) this.stopWorker(); }, 60000); this.idleTimer.unref?.();
          this.pump();
        });
      }
      this.worker.ref();
      job.timer = setTimeout(() => { this.finish(job, new Error('本地向量计算超时')); this.stopWorker(); }, this.timeoutMs);
      this.worker.postMessage({ id: job.id, input: job.input });
    } catch (error) { this.finish(job, error); this.stopWorker(); }
  }
  async close() {
    if (this.closed) { await this.stopping; return; }
    this.closed = true;
    clearTimeout(this.idleTimer);
    if (this.active) this.finish(this.active, abortError());
    for (const job of this.queue.splice(0)) this.finish(job, abortError());
    await this.stopWorker(); await this.stopping;
  }
}
