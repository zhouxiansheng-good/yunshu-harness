import { createHash } from 'node:crypto';
import { open, mkdir, lstat, realpath, link, unlink, rm } from 'node:fs/promises';
import { join, resolve, dirname, basename, relative, sep, isAbsolute } from 'node:path';
import { MemorySystem, MEMORY_DEFAULTS } from '../memory/memory-system.mjs';
import { AutoMemory } from '../memory/auto-memory.mjs';
import { unwrapLineage } from '../memory/recall-lineage.mjs';
import { MediaVault, MediaError, decodeInlinePart } from './media-vault.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const check = (ok, code, message) => { if (!ok) throw new MediaError(code, message); };
const hashPattern = /^[a-f0-9]{64}$/;
const date = v => typeof v === 'string' && Number.isFinite(Date.parse(v));
const validScope = v => typeof v === 'string' && v.trim() && v.length <= 300;
function cleanupError(reason, signal) {
  // AbortController accepts any reason, including null and frozen objects.
  // Cleanup diagnostics must never replace the original failure with TypeError.
  if (reason instanceof Error && Object.isExtensible(reason)) return reason;
  const error = new Error(signal.aborted ? '媒体备份操作已取消' : '媒体备份操作失败', { cause: reason });
  error.name = signal.aborted ? 'AbortError' : 'Error';
  error.code = signal.aborted ? 'ABORT_ERR' : 'BACKUP_FAILED';
  return error;
}
const limits = options => {
  const out = { maxMemoryBytes: 64 * 1024 * 1024, maxManifestBytes: 4 * 1024 * 1024, maxObjects: 10000, maxTotalBytes: 256 * 1024 * 1024, maxAssetBytes: 16 * 1024 * 1024, ...options };
  for (const [key, value] of Object.entries(out)) check(Number.isSafeInteger(value) && value > 0 && value <= (key === 'maxObjects' ? 10000 : key === 'maxTotalBytes' ? 8 * 1024 * 1024 * 1024 : 1024 * 1024 * 1024), 'INVALID_LIMIT', '备份容量配置无效');
  return out;
};
function memoryOptions(value = MEMORY_DEFAULTS) {
  const keys = Object.keys(MEMORY_DEFAULTS);
  check(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(k => Object.hasOwn(value, k)), 'INVALID_BACKUP', '记忆恢复配置字段无效');
  for (const key of keys) check(Number.isSafeInteger(value[key]) && (key === 'contextCapacityTokens' ? value[key] >= 0 && value[key] <= 2000000 : value[key] > 0 && value[key] <= 10000), 'INVALID_BACKUP', '记忆恢复配置值无效');
  check(value.slideCount <= value.shortTermLimit && value.archiveThresholdPercent <= 100, 'INVALID_BACKUP', '记忆恢复配置约束无效');
  return Object.fromEntries(keys.map(k => [k, value[k]]));
}
async function targetPath(path) {
  check(typeof path === 'string' && isAbsolute(path), 'INVALID_PATH', '备份或恢复目标必须为绝对路径');
  path = resolve(path); check(dirname(path) !== path, 'INVALID_PATH', '目标不能为磁盘根目录');
  return join(await realpath(dirname(path)), basename(path));
}
function inside(parent, path) { const child = relative(parent, path); return child === '' || child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child); }
async function plainDirectory(path, identity) {
  const stat = await lstat(path);
  check(stat.isDirectory() && !stat.isSymbolicLink() && await realpath(path) === path && (!identity || stat.dev === identity.dev && stat.ino === identity.ino), 'UNSAFE_PATH', '备份或恢复目录已被替换');
  return stat;
}
async function readBounded(path, maxBytes, signal) {
  signal.throwIfAborted(); const stat = await lstat(path);
  check(stat.isFile() && !stat.isSymbolicLink() && Number.isSafeInteger(stat.size) && stat.size > 0 && stat.size <= maxBytes, 'INVALID_BACKUP', '备份文件类型或大小无效');
  const file = await open(path, 'r');
  try {
    const actual = await file.stat(); check(actual.dev === stat.dev && actual.ino === stat.ino && actual.size === stat.size, 'INVALID_BACKUP', '备份文件发生变化');
    const bytes = Buffer.alloc(stat.size); let offset = 0;
    while (offset < bytes.length) { signal.throwIfAborted(); const chunk = await file.read(bytes, offset, bytes.length - offset, offset); check(chunk.bytesRead > 0, 'INVALID_BACKUP', '备份文件不完整'); offset += chunk.bytesRead; }
    check((await file.read(Buffer.alloc(1), 0, 1, offset)).bytesRead === 0, 'INVALID_BACKUP', '备份文件发生变化'); signal.throwIfAborted(); return bytes;
  } finally { await file.close(); }
}
async function writeNew(path, bytes, signal) {
  signal.throwIfAborted(); const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(bytes, { signal }); await file.sync(); } finally { await file.close(); }
}
async function reserveTarget(path) {
  path = await targetPath(path); const parent = dirname(path);
  try { await mkdir(path); } catch (error) { if (error.code === 'EEXIST') throw new MediaError('TARGET_EXISTS', '目标已存在，未覆盖任何文件'); throw error; }
  const identity = await plainDirectory(path);
  return {
    path, identity,
    check: () => plainDirectory(path, identity),
    async cleanup() {
      try {
        // Only the newly reserved, explicitly supplied directory is removed.
        // Existing targets never enter this branch; reparse-root replacement fails closed.
        await plainDirectory(path, identity); check(resolve(path) === path && dirname(path) === parent, 'UNSAFE_PATH', '恢复清理路径发生变化');
        await rm(path, { recursive: true, force: false }); return true;
      } catch (error) { return error.code === 'ENOENT'; }
    },
  };
}
async function commitMarker(target, name, value, signal) {
  await target.check(); const temporary = join(target.path, '.' + name + '.pending');
  await writeNew(temporary, Buffer.from(JSON.stringify(value, null, 2)), signal); await target.check(); signal.throwIfAborted();
  await link(temporary, join(target.path, name)); await unlink(temporary);
}
function validateMedia(manifest, memory, caps) {
  check(manifest?.format === 'yunshu-media-bundle-v1' && manifest.complete === true && validScope(manifest.scope) && date(manifest.snapshotAt), 'INVALID_BACKUP', '媒体备份格式无效');
  check(memory?.format === 'yunshu-memory-layers' && [3,4].includes(unwrapLineage(memory).packet.schemaVersion) && memory.scope === manifest.scope && memory.evidence?.scope === manifest.scope, 'INVALID_BACKUP', '记忆与媒体范围不匹配');
  check(validScope(manifest.identityScope) && Array.isArray(memory.evidence.sources), 'INVALID_BACKUP', '备份身份范围或来源无效');
  check(Array.isArray(manifest.objects) && manifest.objects.length <= caps.maxObjects && Array.isArray(manifest.refs) && manifest.refs.length <= 10000, 'INVALID_BACKUP', '媒体备份条目超限');
  const objects = new Map(), sources = new Map(memory.evidence.sources.map(s => [s.id, s])), refs = new Set(), used = new Set(); let total = 0;
  for (const o of manifest.objects) {
    check(o && hashPattern.test(o.digest) && !objects.has(o.digest) && o.file === 'objects/' + o.digest + '.blob' && Number.isSafeInteger(o.bytes) && o.bytes > 0 && o.bytes <= caps.maxAssetBytes && date(o.created_at), 'INVALID_BACKUP', '媒体对象索引无效');
    total += o.bytes; check(total <= caps.maxTotalBytes, 'CAPACITY', '媒体备份总大小超限'); objects.set(o.digest, o);
  }
  for (const r of manifest.refs) {
    const source = sources.get(r?.source_id), object = objects.get(r?.digest), key = JSON.stringify([r?.source_id, r?.part_index]);
    check(r && r.scope === manifest.scope && source?.scope === manifest.scope && r.source_hash === source.content_hash && Number.isSafeInteger(r.part_index) && r.part_index >= 0 && !refs.has(key) && object && date(r.created_at), 'INVALID_BACKUP', '媒体来源绑定无效');
    const part = source.payload?.parts?.[r.part_index];
    check(['image', 'audio', 'video', 'file'].includes(part?.type) && ['inline-payload', 'owner-import'].includes(r.origin) && typeof r.mime_type === 'string' && r.mime_type.length <= 100 && /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i.test(r.mime_type), 'INVALID_BACKUP', '媒体来源类型无效');
    const inline = decodeInlinePart(part, { maxBytes: caps.maxAssetBytes });
    check(r.origin === 'inline-payload' ? inline && sha(inline.bytes) === r.digest && inline.bytes.length === object.bytes && inline.mimeType === r.mime_type : !inline, 'PROVENANCE_MISMATCH', '媒体原件与补交来源不一致');
    refs.add(key); used.add(r.digest);
  }
  check(used.size === objects.size, 'INVALID_BACKUP', '备份包含未引用媒体对象');
  return { objects: [...objects.values()], refs: manifest.refs, total };
}
function preflightMemory(store, scope, cap) {
  // Bound source payload before constructing the existing v3 snapshot. The
  // final serialized limit is checked separately; this does not change v3.
  const sum = store.db.prepare('SELECT COALESCE(SUM(length(CAST(payload AS BLOB))),0) AS n FROM yunshu_sources WHERE scope=?').get(scope).n;
  check(sum <= cap, 'CAPACITY', '原始记录超过本批备份容量');
}

export function exportMediaBundle({ vault, scope, directory, signal, options = {} }) {
  return vault.run(signal, async active => {
    check(validScope(scope), 'INVALID_SCOPE', '备份范围无效');
    directory = await targetPath(directory);
    check(!inside(vault.root, directory) && !inside(directory, vault.root), 'OVERLAPPING_PATH', '备份目标不能与活跃媒体保管目录重叠');
    const caps = limits({ maxTotalBytes: vault.maxTotalBytes, maxAssetBytes: vault.maxAssetBytes, ...options });
    const unlock = await vault.acquireWriter(active); let target;
    try {
      const snapshot = vault.store.transaction(() => {
        preflightMemory(vault.store, scope, caps.maxMemoryBytes);
        const memory = vault.store.layeredExport(scope);
        const refs = vault.store.db.prepare('SELECT * FROM yunshu_media_refs WHERE scope=? ORDER BY source_id,part_index').all(scope);
        const objects = vault.store.db.prepare('SELECT o.* FROM yunshu_media_objects o WHERE o.scope=? AND EXISTS(SELECT 1 FROM yunshu_media_refs r WHERE r.scope=o.scope AND r.digest=o.digest) ORDER BY digest').all(scope).map(o => ({ digest: o.digest, bytes: o.bytes, created_at: o.created_at, file: 'objects/' + o.digest + '.blob' }));
        return { memory, refs, objects };
      });
      const memoryBytes = Buffer.from(JSON.stringify(snapshot.memory)); check(memoryBytes.length <= caps.maxMemoryBytes, 'CAPACITY', '记忆备份元数据超限');
      const manifest = { format: 'yunshu-media-bundle-v1', complete: true, scope, identityScope: vault.store.identityScope, memoryOptions: memoryOptions(Object.fromEntries(Object.keys(MEMORY_DEFAULTS).map(k => [k, vault.store.options[k]]))), snapshotAt: new Date().toISOString(), memory: { file: 'memory.json', bytes: memoryBytes.length, sha256: sha(memoryBytes) }, objects: snapshot.objects, refs: snapshot.refs, includesWithdrawn: true, excludes: ['persona identity', 'vectors', 'complete prior audit history', 'unbound media files'], hashPurpose: 'integrity, not authenticity' };
      validateMedia(manifest, snapshot.memory, caps);
      check(Buffer.byteLength(JSON.stringify(manifest, null, 2)) <= caps.maxManifestBytes, 'CAPACITY', '媒体备份清单超限');
      target = await reserveTarget(directory); await mkdir(join(target.path, 'objects'));
      await target.check(); const targetObjects = join(target.path, 'objects'), targetObjectsIdentity = await plainDirectory(targetObjects);
      await writeNew(join(target.path, 'memory.json'), memoryBytes, active);
      const sourceDir = await vault.directory('objects', sha(scope)), sourceIdentity = await vault.directoryIdentity(sourceDir);
      for (const object of manifest.objects) {
        active.throwIfAborted(); await vault.directoryIdentity(sourceDir, sourceIdentity); await target.check(); await plainDirectory(targetObjects, targetObjectsIdentity);
        const bytes = await vault.readObject(join(sourceDir, object.digest + '.blob'), object.digest, object.bytes, active);
        await vault.directoryIdentity(sourceDir, sourceIdentity); await target.check(); await plainDirectory(targetObjects, targetObjectsIdentity);
        await writeNew(join(targetObjects, object.digest + '.blob'), bytes, active); await plainDirectory(targetObjects, targetObjectsIdentity);
      }
      await plainDirectory(targetObjects, targetObjectsIdentity);
      await commitMarker(target, 'manifest.json', manifest, active);
      return { complete: true, directory: target.path, scope, snapshotAt: manifest.snapshotAt, mediaObjects: manifest.objects.length, mediaReferences: manifest.refs.length, memorySha256: manifest.memory.sha256, includesWithdrawn: true };
    } catch (reason) {
      const error = cleanupError(reason, active);
      if (target) { error.cleanupComplete = await target.cleanup(); if (!error.cleanupComplete) error.incompleteDirectory = target.path; }
      throw error;
    } finally { await unlock(); }
  }, true);
}

export async function restoreMediaBundle({ directory, destination, confirmed, signal = new AbortController().signal, options = {} }) {
  check(confirmed === true, 'CONFIRM_REQUIRED', '恢复媒体备份需要明确确认');
  check(typeof directory === 'string' && isAbsolute(directory), 'INVALID_PATH', '备份来源必须为绝对路径');
  directory = resolve(directory); check(!(await lstat(directory)).isSymbolicLink(), 'UNSAFE_PATH', '备份根目录不能为符号链接');
  directory = await realpath(directory); const identity = await plainDirectory(directory), caps = limits(options);
  destination = await targetPath(destination);
  check(!inside(directory, destination) && !inside(destination, directory), 'OVERLAPPING_PATH', '恢复目标不能与备份目录重叠');
  const manifestBytes = await readBounded(join(directory, 'manifest.json'), caps.maxManifestBytes, signal);
  let manifest, memory;
  try { manifest = JSON.parse(manifestBytes.toString('utf8')); } catch { throw new MediaError('INVALID_BACKUP', '媒体备份清单无法解析'); }
  check(manifest?.memory?.file === 'memory.json' && hashPattern.test(manifest.memory.sha256) && Number.isSafeInteger(manifest.memory.bytes) && manifest.memory.bytes > 0 && manifest.memory.bytes <= caps.maxMemoryBytes, 'INVALID_BACKUP', '记忆备份索引无效');
  const memoryBytes = await readBounded(join(directory, 'memory.json'), caps.maxMemoryBytes, signal);
  check(memoryBytes.length === manifest.memory.bytes && sha(memoryBytes) === manifest.memory.sha256, 'INTEGRITY_ERROR', '记忆备份哈希不匹配');
  try { memory = JSON.parse(memoryBytes.toString('utf8')); } catch { throw new MediaError('INVALID_BACKUP', '记忆备份无法解析'); }
  const media = validateMedia(manifest, memory, caps);
  const restoredOptions = memoryOptions(manifest.memoryOptions);
  await plainDirectory(directory, identity); await plainDirectory(join(directory, 'objects'));
  let target, store, vault;
  try {
    target = await reserveTarget(destination);
    store = new MemorySystem(join(target.path, 'memory.sqlite'), { ...restoredOptions, identityScope: manifest.identityScope });
    if(unwrapLineage(memory).packet.schemaVersion===4) store.autoMemory=new AutoMemory(store,async()=>{throw Error('恢复期间不提取新记忆');});
    const restoredMemory = store.restoreLayers(manifest.scope, memory);
    vault = await MediaVault.create({ store, root: join(target.path, 'media'), maxAssetBytes: caps.maxAssetBytes, maxTotalBytes: caps.maxTotalBytes });
    const scopeDir = await vault.directory('objects', sha(manifest.scope)), scopeIdentity = await vault.directoryIdentity(scopeDir);
    for (const object of media.objects) {
      signal.throwIfAborted(); await plainDirectory(directory, identity); await plainDirectory(join(directory, 'objects')); await target.check(); await vault.directoryIdentity(scopeDir, scopeIdentity);
      const bytes = await readBounded(join(directory, 'objects', object.digest + '.blob'), object.bytes, signal);
      check(bytes.length === object.bytes && sha(bytes) === object.digest, 'INTEGRITY_ERROR', '媒体备份字节哈希不匹配');
      await target.check(); await vault.directoryIdentity(scopeDir, scopeIdentity);
      await writeNew(join(scopeDir, object.digest + '.blob'), bytes, signal);
      await vault.readObject(join(scopeDir, object.digest + '.blob'), object.digest, object.bytes, signal);
    }
    await vault.directoryIdentity(scopeDir, scopeIdentity); signal.throwIfAborted();
    store.transaction(() => {
      for (const o of media.objects) store.db.prepare('INSERT INTO yunshu_media_objects VALUES(?,?,?,?)').run(manifest.scope, o.digest, o.bytes, o.created_at);
      for (const r of media.refs) store.db.prepare('INSERT INTO yunshu_media_refs VALUES(?,?,?,?,?,?,?,?)').run(r.scope, r.source_id, r.part_index, r.source_hash, r.digest, r.mime_type, r.origin, r.created_at);
    });
    await vault.close(); vault = null; store.close(); store = null;
    const receipt = { complete: true, format: 'yunshu-media-restore-v1', scope: manifest.scope, identityScope: manifest.identityScope, memoryOptions: restoredOptions, backupManifestSha256: sha(manifestBytes), database: 'memory.sqlite', mediaDirectory: 'media', mediaObjects: media.objects.length, mediaReferences: media.refs.length, restoredMemory };
    await commitMarker(target, 'RESTORED.json', receipt, signal);
    return { ...receipt, directory: target.path };
  } catch (reason) {
    const error = cleanupError(reason, signal);
    if (vault) await vault.close(); if (store) store.close();
    if (target) { error.cleanupComplete = await target.cleanup(); if (!error.cleanupComplete) error.incompleteDirectory = target.path; }
    throw error;
  }
}
