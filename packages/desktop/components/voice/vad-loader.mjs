let yunshuVadResources = null;
const vadFileNames = ['silero_vad.onnx', 'ort.wasm.min.js', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'];
export async function loadVadResources(request, { signal, env = globalThis } = {}) {
  signal?.throwIfAborted();
  if (!yunshuVadResources) {
    const entry = { urls: [], env, abort: new AbortController() }; yunshuVadResources = entry;
    const lifetime = signal ? AbortSignal.any([signal, entry.abort.signal]) : entry.abort.signal;
    entry.promise = (async () => {
      const manifest = await request('vad-manifest');
      if (manifest.schema !== 1 || manifest.runtimeVersion !== '1.27.0' || manifest.modelVersion !== '6.2.3' || manifest.chunkBytes !== 524288) throw new Error('人声检测资源版本不匹配');
      const read = async name => {
        const info = manifest.files?.[name];
        if (!info || !Number.isSafeInteger(info.bytes) || info.bytes <= 0 || info.bytes > 20000000 || !/^[a-f0-9]{64}$/.test(info.sha256)) throw new Error('人声检测资源格式无效');
        const bytes = new Uint8Array(info.bytes);
        for (let offset = 0; offset < bytes.length; offset += manifest.chunkBytes) {
          lifetime.throwIfAborted(); const packet = await request('vad-asset', { name, offset });
          if (packet.offset !== offset || packet.total !== bytes.length || packet.name !== name) throw new Error('人声检测资源片段不匹配');
          const size = Math.min(manifest.chunkBytes, bytes.length - offset);
          if (typeof packet.base64 !== 'string' || packet.base64.length > Math.ceil(size / 3) * 4) throw new Error('人声检测资源片段无效');
          const binary = env.atob(packet.base64);
          if (binary.length !== size) throw new Error('人声检测资源不完整');
          for (let i = 0; i < size; i++) bytes[offset + i] = binary.charCodeAt(i);
        }
        const digest = Array.from(new Uint8Array(await env.crypto.subtle.digest('SHA-256', bytes))).map(v => v.toString(16).padStart(2, '0')).join('');
        if (digest !== info.sha256) throw new Error('人声检测资源校验失败');
        return bytes;
      };
      const [model, script, module, wasm] = await Promise.all(vadFileNames.map(read));
      lifetime.throwIfAborted();
      const url = (bytes, type) => { const value = env.URL.createObjectURL(new env.Blob([bytes], { type })); entry.urls.push(value); return value; };
      const slot = '__yunshuVadRuntime_' + Math.random().toString(36).slice(2);
      const wrapped = '(()=>{' + new TextDecoder().decode(script) + '\n;globalThis[' + JSON.stringify(slot) + ']=ort;})();';
      const scriptUrl = url(wrapped, 'text/javascript'), moduleUrl = url(module, 'text/javascript');
      const element = env.document.createElement('script');
      try {
        await new Promise((resolve, reject) => {
          const finish = error => { clearTimeout(timer); lifetime.removeEventListener('abort', abort); element.onload = null; element.onerror = null; error ? reject(error) : resolve(); };
          const abort = () => finish(lifetime.reason ?? new Error('人声检测已取消'));
          const timer = setTimeout(() => finish(new Error('人声检测加载超时')), 15000);
          lifetime.addEventListener('abort', abort, { once: true });
          element.src = scriptUrl; element.onload = () => finish(); element.onerror = () => finish(new Error('人声检测运行时加载失败'));
          env.document.head.appendChild(element);
        });
        lifetime.throwIfAborted();
        const ort = env[slot];
        if (!ort?.InferenceSession) throw new Error('人声检测运行时不可用');
        ort.env.wasm.wasmPaths = { mjs: moduleUrl }; ort.env.wasm.wasmBinary = wasm;
        ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false; ort.env.logLevel = 'error';
        return { ort, model, manifest };
      } finally { element.remove(); delete env[slot]; }
    })().catch(error => { entry.abort.abort(); if (yunshuVadResources === entry) yunshuVadResources = null; for (const url of entry.urls.splice(0)) env.URL.revokeObjectURL(url); throw error; });
  }
  const result = await yunshuVadResources.promise; signal?.throwIfAborted(); return result;
}
export function disposeVadResources() { const entry = yunshuVadResources; yunshuVadResources = null; if (!entry) return; entry.abort.abort(); for (const url of entry.urls.splice(0)) entry.env.URL.revokeObjectURL(url); }
