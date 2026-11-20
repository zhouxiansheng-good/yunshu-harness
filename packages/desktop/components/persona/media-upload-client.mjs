export async function uploadMediaFile({ file, sourceId, partIndex, mimeType, sessionId, call, signal, maxBytes, onProgress = () => {} }) {
  if (!file || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > maxBytes) throw new Error('文件为空或超出单文件上限');
  signal.throwIfAborted();
  const bytes = new Uint8Array(await file.arrayBuffer()); signal.throwIfAborted();
  if (bytes.length !== file.size) throw new Error('文件大小已变更，请重新选择');
  const digest = await crypto.subtle.digest('SHA-256', bytes); signal.throwIfAborted();
  const sha256 = [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('');
  let uploadId;
  try {
    const ticket = await call(sessionId, 'media-upload-begin', { sourceId, partIndex, bytes: bytes.length, sha256, mimeType: mimeType || file.type || 'application/octet-stream', confirmed: true }, signal);
    uploadId = ticket.uploadId; signal.throwIfAborted();
    if (!uploadId || !Number.isSafeInteger(ticket.chunkBytes) || ticket.chunkBytes <= 0 || ticket.chunkBytes > 256 * 1024) throw new Error('上传参数无效');
    onProgress({ received: 0, total: bytes.length });
    for (let offset = 0; offset < bytes.length; offset += ticket.chunkBytes) {
      signal.throwIfAborted(); const chunk = bytes.subarray(offset, offset + ticket.chunkBytes); let binary = '';
      for (let i = 0; i < chunk.length; i += 8192) binary += String.fromCharCode(...chunk.subarray(i, i + 8192));
      const progress = await call(sessionId, 'media-upload-chunk', { uploadId, offset, base64: btoa(binary) }, signal);
      signal.throwIfAborted();
      if (progress.received !== offset + chunk.length || progress.total !== bytes.length) throw new Error('上传进度不一致');
      onProgress({ received: progress.received, total: bytes.length });
    }
    const result = await call(sessionId, 'media-upload-commit', { uploadId }, signal);
    signal.throwIfAborted();
    if (result.status !== 'stored' || result.sha256 !== sha256 || result.bytes !== bytes.length) throw new Error('保存结果不一致，请检查附件状态');
    return result;
  } catch (error) {
    if (uploadId) try { await call(sessionId, 'media-upload-cancel', { uploadId }, AbortSignal.timeout(5000)); }
    catch { throw Object.assign(new Error(error.message + '；上传清理未确认，请重新打开附件检查状态'), { cause: error, code: error.code, details: { ...error.details, uploadCleanupConfirmed: false } }); }
    throw error;
  }
}
