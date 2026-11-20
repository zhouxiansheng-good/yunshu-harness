import { randomUUID, createHash } from 'node:crypto';
import { MediaError, decodeInlinePart } from './media-vault.mjs';

const check = (ok, code, message) => { if (!ok) throw new MediaError(code, message); };
const mediaTypes = new Set(['image', 'audio', 'video', 'file']);
export const UPLOAD_CHUNK_BYTES = 256 * 1024;

export class MediaUploads {
  constructor({ vault, ttlMs = 120000, maxUploads = 4, maxPendingBytes = Math.max(vault.maxAssetBytes, 32 * 1024 * 1024), now = Date.now }) {
    check(Number.isSafeInteger(ttlMs) && ttlMs >= 100 && ttlMs <= 600000 && Number.isSafeInteger(maxUploads) && maxUploads > 0 && maxUploads <= 32 && Number.isSafeInteger(maxPendingBytes) && maxPendingBytes >= vault.maxAssetBytes && maxPendingBytes <= 1024 * 1024 * 1024, 'INVALID_LIMIT', '上传限额无效');
    this.vault = vault; this.ttlMs = ttlMs; this.maxUploads = maxUploads; this.maxPendingBytes = maxPendingBytes; this.now = now;
    this.sessions = new Map(); this.reservedBytes = 0; this.closed = false;
    this.timer = setInterval(() => this.expire(), Math.min(ttlMs, 10000)); this.timer.unref?.();
  }
  expire() { for (const [id, row] of this.sessions) if (!row.committing && this.now() >= row.expiresAt) this.remove(id); }
  remove(id) { const row = this.sessions.get(id); if (row) { this.reservedBytes -= row.bytes; row.chunks = []; this.sessions.delete(id); } }
  source(scope, sourceId, partIndex) {
    const source = this.vault.source(scope, sourceId, partIndex);
    check(!decodeInlinePart(source.payload.parts[partIndex], { maxBytes: this.vault.maxAssetBytes }), 'INLINE_SOURCE', '内联附件请使用补扫');
    return source;
  }
  parts(scope, { sourceId, offset = 0 } = {}) {
    check(typeof sourceId === 'string' && sourceId.length > 0 && sourceId.length <= 200 && Number.isSafeInteger(offset) && offset >= 0, 'INVALID_INPUT', '附件查询无效');
    const source = this.vault.store.evidence.source(scope, sourceId);
    check(source && source.scope === scope, 'SOURCE_UNAVAILABLE', '来源不存在或已撤回');
    const parts = source.payload.parts, end = Math.min(parts.length, offset + 32), items = [];
    for (let partIndex = offset; partIndex < end; partIndex++) {
      const part = parts[partIndex]; if (!mediaTypes.has(part.type)) continue;
      let canImport = false;
      try { canImport = !decodeInlinePart(part, { maxBytes: this.vault.maxAssetBytes }); } catch {}
      const row = this.vault.row(scope, sourceId, partIndex);
      items.push({ partIndex, type: part.type, name: typeof part.name === 'string' ? part.name.slice(0, 120) : '', canImport, retained: !!row, origin: row?.origin ?? null, mimeType: row?.mime_type ?? null });
    }
    return { sourceId, items, nextOffset: end < parts.length ? end : null };
  }
  begin(scope, payload) {
    check(!this.closed, 'CLOSED', '上传服务已关闭'); this.expire();
    const { sourceId, partIndex, bytes, mimeType = 'application/octet-stream', sha256, confirmed } = payload;
    check(confirmed === true, 'CONFIRM_REQUIRED', '请确认补交附件');
    check(Number.isSafeInteger(bytes) && bytes > 0 && bytes <= this.vault.maxAssetBytes, 'ASSET_TOO_LARGE', '文件为空或超出单文件上限');
    check(typeof sha256 === 'string' && /^[a-f0-9]{64}$/.test(sha256), 'INVALID_DIGEST', '文件校验值无效');
    check(typeof mimeType === 'string' && mimeType.length <= 100 && mimeType.split('/').length === 2 && mimeType.split('/').every(p => /^[a-z0-9][a-z0-9.+-]*$/i.test(p)), 'INVALID_MIME', '媒体类型无效');
    const source = this.source(scope, sourceId, partIndex);
    check(this.sessions.size < this.maxUploads && this.reservedBytes + bytes <= this.maxPendingBytes, 'UPLOAD_CAPACITY', '上传队列已满，请稍后重试');
    const uploadId = randomUUID(), expiresAt = this.now() + this.ttlMs;
    this.sessions.set(uploadId, { scope, sourceId, partIndex, sourceHash: source.content_hash, bytes, mimeType, sha256, expiresAt, chunks: [], received: 0, abort: new AbortController(), committing: false }); this.reservedBytes += bytes;
    return { uploadId, chunkBytes: UPLOAD_CHUNK_BYTES, expiresAt };
  }
  get(scope, uploadId) {
    check(!this.closed, 'CLOSED', '上传服务已关闭'); this.expire();
    const row = this.sessions.get(uploadId);
    check(row && row.scope === scope, 'UPLOAD_UNAVAILABLE', '上传已过期或不存在');
    check(!row.committing, 'UPLOAD_BUSY', '文件正在保存');
    try { check(this.source(scope, row.sourceId, row.partIndex).content_hash === row.sourceHash, 'SOURCE_CHANGED', '附件来源已变更'); }
    catch (error) { this.remove(uploadId); throw error; }
    return row;
  }
  chunk(scope, { uploadId, offset, base64 }) {
    const row = this.get(scope, uploadId);
    check(Number.isSafeInteger(offset) && offset === row.received, 'INVALID_OFFSET', '上传分块顺序不符');
    const decoded = decodeInlinePart({ type: 'file', encoding: 'base64', data: base64 }, { maxBytes: UPLOAD_CHUNK_BYTES });
    check(row.received + decoded.bytes.length <= row.bytes, 'ASSET_TOO_LARGE', '上传内容超过声明大小');
    check(decoded.bytes.length === Math.min(UPLOAD_CHUNK_BYTES, row.bytes - row.received), 'INVALID_CHUNK', '非末尾分块必须使用约定大小');
    row.chunks.push(decoded.bytes); row.received += decoded.bytes.length; row.expiresAt = this.now() + this.ttlMs;
    return { uploadId, received: row.received, total: row.bytes };
  }
  async commit(scope, { uploadId }, signal) {
    const row = this.get(scope, uploadId);
    check(row.received === row.bytes, 'UPLOAD_INCOMPLETE', '文件尚未上传完整');
    const bytes = Buffer.concat(row.chunks, row.bytes);
    // Keep the reservation until persistence settles; concurrent commits stay bounded.
    row.committing = true; row.chunks = [];
    const active = AbortSignal.any([row.abort.signal, ...(signal ? [signal] : [])]);
    try {
      active.throwIfAborted();
      check(createHash('sha256').update(bytes).digest('hex') === row.sha256, 'INTEGRITY_ERROR', '上传文件校验失败');
      return await this.vault.importBytes({ scope, sourceId: row.sourceId, partIndex: row.partIndex, expectedSourceHash: row.sourceHash, bytes, mimeType: row.mimeType, confirmed: true, signal: active });
    } finally { this.remove(uploadId); }
  }
  cancel(scope, { uploadId }) {
    const row = this.sessions.get(uploadId);
    check(!row || row.scope === scope, 'UPLOAD_UNAVAILABLE', '上传已过期或不存在');
    row?.abort.abort(); if (!row?.committing) this.remove(uploadId);
    return { status: row?.committing ? 'cancellation-requested' : 'cancelled' };
  }
  close() { this.closed = true; clearInterval(this.timer); for (const [id, row] of this.sessions) { row.abort.abort(); if (!row.committing) this.remove(id); } }
}
