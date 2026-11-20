import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { availableParallelism } from 'node:os';

const root = new URL('./', import.meta.url);
async function initialize() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('此模型包仅支持 Windows x64');
  const manifest = JSON.parse(await readFile(new URL('assets/embedding-manifest.json', root), 'utf8'));
  for (const file of manifest.files) {
    if (!/^(assets|vendor)\//.test(file.path) || file.path.includes('..') || file.path.includes('\\')) throw new Error('Invalid asset path');
    const hash = createHash('sha256');
    for await (const data of createReadStream(new URL(file.path, root))) hash.update(data);
    if (hash.digest('hex') !== file.sha256) throw new Error('模型资源校验失败');
  }
  const { Tokenizer } = await import('./vendor/tokenizers/dist/tokenizers.mjs');
  const tokenizer = new Tokenizer(JSON.parse(await readFile(new URL('assets/bge-m3/tokenizer.json', root), 'utf8')), JSON.parse(await readFile(new URL('assets/bge-m3/tokenizer_config.json', root), 'utf8')));
  const ort = createRequire(import.meta.url)('./vendor/onnxruntime-node/dist/index.js');
  const session = await ort.InferenceSession.create(fileURLToPath(new URL('assets/bge-m3/onnx/model_int8.onnx', root)), {
    executionProviders: ['cpu'], intraOpNumThreads: Math.max(1, Math.min(4, availableParallelism() - 1)), interOpNumThreads: 1,
    executionMode: 'sequential', graphOptimizationLevel: 'all',
  });
  if (session.inputNames.some(name => !['input_ids', 'attention_mask'].includes(name)) || !session.outputNames.includes('last_hidden_state')) throw new Error('Unsupported embedding model contract');
  return { tokenizer, ort, session };
}
let initialized;
function normalize(values) {
  const norm = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
  if (!Number.isFinite(norm) || norm === 0) throw new Error('Invalid embedding norm');
  return values.map(v => v / norm);
}
process.on('disconnect', () => process.exit(0));
process.on('message', async ({ id, input }) => {
  try {
    const { tokenizer, ort, session } = await (initialized ??= initialize());
    const encoded = tokenizer.encode(input).ids;
    if (encoded[0] !== 0 || encoded.at(-1) !== 2) throw new Error('Unexpected tokenizer special tokens');
    // Public model supports 8192 tokens. Bounded overlapping windows avoid
    // quadratic 8192-token CPU attention. This aggregation is our local policy,
    // not a claim about the unavailable original application's tokenizer path.
    const body = encoded.slice(1, -1).slice(0, 8190), sum = new Array(1024).fill(0);
    for (let start = 0; start < Math.max(1, body.length); start += 446) {
      const ids = [0, ...body.slice(start, start + 510), 2];
      const feeds = { input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]), attention_mask: new ort.Tensor('int64', BigInt64Array.from(ids, () => 1n), [1, ids.length]) };
      const outputs = await session.run(feeds);
      const hidden = outputs.last_hidden_state;
      if (hidden.dims[0] !== 1 || hidden.dims[1] !== ids.length || hidden.dims[2] !== 1024) throw new Error('Invalid embedding shape');
      const cls = normalize(Array.from(hidden.data.slice(0, 1024)));
      const weight = Math.min(510, Math.max(1, body.length - start));
      for (let i = 0; i < 1024; i++) sum[i] += cls[i] * weight;
      for (const tensor of Object.values(feeds)) tensor.dispose();
      for (const tensor of Object.values(outputs)) tensor.dispose();
      if (start + 510 >= body.length) break;
    }
    process.send({ id, vector: normalize(sum) });
  } catch (error) { process.send({ id, error: error.message }); }
});
