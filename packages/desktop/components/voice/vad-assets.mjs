import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const names = ['silero_vad.onnx', 'ort.wasm.min.js', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'];
export class VadAssets {
  constructor(base = new URL('./assets/vad/', import.meta.url)) { this.base = base; this.cache = new Map(); }
  manifest() {
    const value = JSON.parse(readFileSync(new URL('manifest.json', this.base), 'utf8'));
    return { schema: 1, modelVersion: value.modelVersion, runtimeVersion: value.runtimeVersion, chunkBytes: 524288, files: Object.fromEntries(names.map(name => [name, value.files[name]])) };
  }
  chunk(name, offset) {
    if (!names.includes(name) || !Number.isSafeInteger(offset) || offset < 0) throw new Error('人声检测资源请求无效');
    const info = this.manifest().files[name];
    if (!this.cache.has(name)) {
      const value = readFileSync(new URL(name, this.base));
      if (value.length !== info.bytes || createHash('sha256').update(value).digest('hex') !== info.sha256) throw new Error('人声检测资源校验失败');
      this.cache.set(name, value);
    }
    const buffer = this.cache.get(name);
    if (offset >= buffer.length || offset % 524288) throw new Error('人声检测资源偏移无效');
    const chunk = buffer.subarray(offset, offset + 524288);
    return { name, offset, total: buffer.length, base64: chunk.toString('base64') };
  }
  close() { this.cache.clear(); }
}
