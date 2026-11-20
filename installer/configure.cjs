'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const [operation, cli, home, release] = process.argv.slice(2);
const YAML = createRequire(cli)('yaml');
const profile = path.join(home, 'profiles', 'desktop');
const layers = path.join(profile, 'cordis.patch.yml');
const original = fs.existsSync(layers) ? fs.readFileSync(layers, 'utf8') : '[]\n';
const doc = YAML.parseDocument(original, {uniqueKeys: true});
if (doc.errors.length) throw new Error('Cannot read existing desktop profile YAML: ' + doc.errors[0].message);
if (!doc.contents) doc.contents = doc.createNode([]);
if (!YAML.isSeq(doc.contents)) throw new Error('Expected a list of desktop overrides');
const manifest = JSON.parse(fs.readFileSync(path.join(release, 'release-manifest.json')));
function digest(file) {
  const buf = Buffer.alloc(1024 * 1024), fd = fs.openSync(file, 'r'), hash = crypto.createHash('sha256');
  try { for (;;) { const bytes = fs.readSync(fd, buf, 0, buf.length, null); if (!bytes) break; hash.update(buf.subarray(0, bytes)); } }
  finally { fs.closeSync(fd); }
  return hash.digest('hex');
}
const rows = doc.toJS();
function existing(id) { return [...rows].reverse().find(row => row?.id === id)?.config ?? {}; }
const dt = existing('yunshu-desktop'), ut = existing('yunshu-united');
const historical = path.join(os.homedir(), '.yunshu', 'united');
const isEngine = ['runs', 'bin/united.mjs'].some(name => fs.existsSync(path.join(historical, name)));
const engine = ut.engineDir ?? dt.coding?.unitedRoot ?? dt.memory?.unitedDir ??
  (process.env.YUNSHU_UNITED_HOME || (isEngine ? historical : path.join(home, 'yunshu', 'united')));
const code = ut.codingStateDir ?? dt.coding?.stateDir ?? path.join(home, 'yunshu', 'coding');
const speech = dt.voice?.asrDataRoot ?? path.join(home, 'speech-to-text', 'sensevoice');
for (const dir of [engine, code, speech]) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('Use absolute paths in the Yunshu desktop profile.');
}
let dirty = false;
function defaults(id, name, values) {
  let index = rows.findLastIndex(row => row?.id === id);
  if (index < 0) { doc.add({ id, name, config: values }); dirty = true; return; }
  function merge(keys, data) {
    const node = doc.getIn(keys, true);
    if (node === undefined) { doc.setIn(keys, doc.createNode(data)); dirty = true; return; }
    if (!YAML.isMap(node) || typeof data !== 'object' || data === null) return;
    for (const [key, value] of Object.entries(data)) merge([...keys, key], value);
  }
  merge([index, 'config'], values);
}
defaults('yunshu-desktop', '@yunshu/dsh-desktop', {
  memory: { unitedDir: engine }, persona: { media: {} },
  voice: { asrMode: 'private-local', asrDataRoot: speech, allowCloudASR: false },
  coding: { enabled: true, unitedRoot: engine, stateDir: code, unitedCli: path.join(profile, 'node_modules', '@yunshu', 'dsh-united', 'task-engine', 'bin', 'united.mjs') }
});
defaults('yunshu-united', '@yunshu/dsh-united', {engineDir: engine, codingStateDir: code, healthMode: 'engine-only'});
if (!['verify', 'apply'].includes(operation)) throw new Error('Specify verify or apply');
const models = manifest.speech.map(entry => {
  if (!/^(sensevoice-onnx|silero)\/[a-z0-9_.-]+$/i.test(entry.path)) throw new Error('Invalid speech asset name');
  const source = path.join(release, 'models', entry.path);
  if (!fs.existsSync(source) || digest(source) !== entry.sha256) throw new Error('Speech asset failed verification: ' + entry.path);
  return {...entry, source, dest: path.join(speech, 'models', entry.path)};
});
if (operation === 'apply') {
  for (const dir of [path.join(engine, 'runs'), path.join(engine, '_report'), code]) fs.mkdirSync(dir, { recursive: true });
  for (const asset of models) {
    if (fs.existsSync(asset.dest) && digest(asset.dest) === asset.sha256) continue;
    fs.mkdirSync(path.dirname(asset.dest), {recursive: true});
    const staged = asset.dest + '.yunshu-' + crypto.randomUUID();
    try {
      fs.copyFileSync(asset.source, staged, fs.constants.COPYFILE_EXCL);
      if (digest(staged) !== asset.sha256) throw new Error('Incomplete speech asset copy');
      if (fs.existsSync(asset.dest)) fs.copyFileSync(asset.dest, asset.dest + '.before-yunshu-' + Date.now());
      fs.renameSync(staged, asset.dest);
    } finally { if (fs.existsSync(staged)) fs.unlinkSync(staged); }
  }
  if (dirty) {
    const staged = layers + '.yunshu-' + crypto.randomUUID();
    try {
      if (fs.existsSync(layers)) {
        if (fs.readFileSync(layers, 'utf8') !== original) throw new Error('Desktop profile changed; retry after closing Harness.');
        fs.copyFileSync(layers, layers + '.before-yunshu-' + Date.now());
      }
      fs.writeFileSync(staged, doc.toString({lineWidth: 0}), {flag: 'wx'});
      fs.renameSync(staged, layers);
    } finally { if (fs.existsSync(staged)) fs.unlinkSync(staged); }
  }
}
console.log(operation === 'apply' ? 'Yunshu configuration and speech assets are installed.' : 'Yunshu configuration and speech assets passed verification.');

