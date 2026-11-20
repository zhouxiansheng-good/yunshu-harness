import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, realpath, open, link, unlink, readdir } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';

export class MediaError extends Error {
  constructor(code, message) { super(message); this.name = 'MediaError'; this.code = code; }
}
const check = (ok, code, message) => { if (!ok) throw new MediaError(code, message); };
const sha = value => createHash('sha256').update(value).digest('hex');
const mediaTypes = new Set(['image', 'audio', 'video', 'file']);
const validText = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const integer = (n, max) => Number.isSafeInteger(n) && n > 0 && n <= max;
const mime = value => {
  const result = value ?? 'application/octet-stream';
  check(typeof result === 'string' && result.length <= 100 && /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/i.test(result), 'INVALID_MIME', '媒体类型无效');
  return result.toLowerCase();
};

// Explicit encodings only: never fetch a URL, open a path, or guess raw strings.
export function decodeInlinePart(part, { maxBytes = 16 * 1024 * 1024 } = {}) {
  check(part && mediaTypes.has(part.type), 'INVALID_PART', '不是公开媒体附件');
  check(integer(maxBytes, 1024 * 1024 * 1024), 'INVALID_LIMIT', '媒体大小上限无效');
  const candidates = [];
  const dataUrl = value => {
    if (typeof value !== 'string' || !value.startsWith('data:')) return;
    const match = /^data:([^;,]+)?;base64,([\s\S]*)$/.exec(value);
    check(match, 'INVALID_ENCODING', '只接收明确的base64 data URL');
    candidates.push({ data: match[2], mimeType: mime(match[1]) });
  };
  dataUrl(part.url); dataUrl(part.image_url?.url);
  if (part.encoding === 'base64') candidates.push({ data: part.data, mimeType: mime(part.mimeType ?? part.mediaType) });
  else dataUrl(part.data);
  if (part.source?.type === 'base64') candidates.push({ data: part.source.data, mimeType: mime(part.source.mediaType ?? part.source.media_type) });
  if (!candidates.length) return null;
  check(candidates.length === 1, 'AMBIGUOUS_PAYLOAD', '附件包含多个内联载荷，不能猜测原件');
  const candidate = candidates[0], encoded = candidate.data;
  check(typeof encoded === 'string' && encoded.length > 0, 'INVALID_ENCODING', '媒体base64不能为空');
  check(encoded.length <= 4 * Math.ceil(maxBytes / 3), 'ASSET_TOO_LARGE', '媒体超出单件上限');
  // Repeated capture groups can exhaust the RegExp stack on multi-MiB input.
  // Scan characters once, check terminal padding, then re-encode for pad bits.
  const padding = encoded.indexOf('=');
  check(encoded.length % 4 === 0 && !/[^A-Za-z0-9+/=]/.test(encoded) && (padding < 0 || padding >= encoded.length - 2 && ['=', '=='].includes(encoded.slice(padding))), 'INVALID_ENCODING', '媒体base64格式无效');
  const bytes = Buffer.from(encoded, 'base64');
  check(bytes.length > 0 && bytes.toString('base64') === encoded, 'INVALID_ENCODING', '媒体base64不是规范编码');
  check(bytes.length <= maxBytes, 'ASSET_TOO_LARGE', '媒体超出单件上限');
  return { bytes, mimeType: candidate.mimeType };
}

export class MediaVault {
  static async create({ store, root, maxAssetBytes = 16 * 1024 * 1024, maxTotalBytes = 256 * 1024 * 1024 }) {
    check(store?.db && store?.evidence && typeof store.transaction === 'function', 'INVALID_STORE', '需要现有记忆库');
    check(typeof root === 'string' && isAbsolute(root), 'INVALID_PATH', '媒体目录必须为宿主指定的绝对路径');
    check(integer(maxAssetBytes, 1024 * 1024 * 1024) && integer(maxTotalBytes, 8 * 1024 * 1024 * 1024) && maxTotalBytes >= maxAssetBytes, 'INVALID_LIMIT', '媒体容量配置无效');
    await mkdir(root, { recursive: true });
    check(!(await lstat(root)).isSymbolicLink(), 'UNSAFE_PATH', '媒体目录不能是符号链接');
    const canonical = await realpath(root), stat = await lstat(canonical);
    const vault = new MediaVault(store, canonical, maxAssetBytes, maxTotalBytes, stat);
    await vault.directory('objects'); await vault.directory('staging');
    store.open();
    store.db.exec([
      'CREATE TABLE IF NOT EXISTS yunshu_media_objects(scope TEXT NOT NULL,digest TEXT NOT NULL,bytes INTEGER NOT NULL CHECK(bytes>0),created_at TEXT NOT NULL,PRIMARY KEY(scope,digest));',
      'CREATE TABLE IF NOT EXISTS yunshu_media_refs(scope TEXT NOT NULL,source_id TEXT NOT NULL,part_index INTEGER NOT NULL,source_hash TEXT NOT NULL,digest TEXT NOT NULL,mime_type TEXT NOT NULL,origin TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(scope,source_id,part_index),FOREIGN KEY(scope,digest) REFERENCES yunshu_media_objects(scope,digest),FOREIGN KEY(source_id) REFERENCES yunshu_sources(id));',
    ].join('\n'));
    return vault;
  }
  constructor(store, root, maxAssetBytes, maxTotalBytes, rootStat) {
    this.store = store; this.root = root; this.maxAssetBytes = maxAssetBytes; this.maxTotalBytes = maxTotalBytes;
    this.rootStat = rootStat; this.closed = false; this.lifetime = new AbortController();
    this.tail = Promise.resolve(); this.operations = new Set();
  }
  async directory(...segments) {
    const current = await lstat(this.root);
    check(current.isDirectory() && !current.isSymbolicLink() && current.dev === this.rootStat.dev && current.ino === this.rootStat.ino && await realpath(this.root) === this.root, 'UNSAFE_PATH', '媒体根目录被替换');
    let path = this.root;
    for (const segment of segments) {
      check(/^[a-z0-9-]+$/.test(segment), 'UNSAFE_PATH', '内部目录标识无效');
      path = join(path, segment); await mkdir(path).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const stat = await lstat(path);
      check(stat.isDirectory() && !stat.isSymbolicLink(), 'UNSAFE_PATH', '媒体子目录不是普通目录');
    }
    return path;
  }
  async directoryIdentity(path, expected) {
    await this.directory();
    const stat = await lstat(path);
    check(stat.isDirectory() && !stat.isSymbolicLink() && await realpath(path) === path && (!expected || stat.dev === expected.dev && stat.ino === expected.ino), 'UNSAFE_PATH', '媒体目录在操作期间被替换');
    return stat;
  }
  async removeOwned(path, directory, directoryStat, fileStat) {
    try {
      await this.directoryIdentity(directory, directoryStat);
      const current = await lstat(path);
      // Never follow a moved directory to erase a different file during cleanup.
      if (current.isFile() && !current.isSymbolicLink() && current.dev === fileStat.dev && current.ino === fileStat.ino) await unlink(path);
    } catch (error) { if (!['ENOENT', 'UNSAFE_PATH'].includes(error.code)) throw error; }
  }
  source(scope, sourceId, partIndex) {
    this.store.open();
    check(validText(scope, 300) && validText(sourceId, 200) && Number.isSafeInteger(partIndex) && partIndex >= 0, 'INVALID_INPUT', '媒体来源标识无效');
    const source = this.store.evidence.source(scope, sourceId);
    check(source && source.scope === scope, 'SOURCE_UNAVAILABLE', '来源不存在或已撤回');
    check(mediaTypes.has(source.payload.parts[partIndex]?.type), 'INVALID_PART', '来源中没有这个媒体附件');
    return source;
  }
  row(scope, sourceId, partIndex) {
    return this.store.db.prepare('SELECT r.*,o.bytes FROM yunshu_media_refs r JOIN yunshu_media_objects o ON o.scope=r.scope AND o.digest=r.digest WHERE r.scope=? AND r.source_id=? AND r.part_index=?').get(scope, sourceId, partIndex);
  }
  run(signal, fn, serialized = false) {
    if (this.closed) return Promise.reject(new MediaError('CLOSED', '媒体组件已关闭'));
    const combined = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]);
    const start = () => { combined.throwIfAborted(); return fn(combined); };
    const result = serialized ? this.tail.then(start) : Promise.resolve().then(start);
    if (serialized) this.tail = result.catch(() => {});
    this.operations.add(result);
    result.then(() => this.operations.delete(result), () => this.operations.delete(result));
    return result;
  }
  async acquireWriter(signal) {
    await this.directory(); signal.throwIfAborted();
    const path = join(this.root, 'writer.lock'); let handle, identity;
    try { handle = await open(path, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw new MediaError('VAULT_BUSY', '媒体库写入锁存在；等待当前写入，异常退出后需显式检查锁'); throw error; }
    try {
      identity = await handle.stat();
      await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      signal.throwIfAborted();
    } catch (error) { await handle.close(); if (identity) await this.removeOwned(path, this.root, this.rootStat, identity); throw error; }
    let released = false;
    return async () => { if (!released) { released = true; await handle.close(); await this.removeOwned(path, this.root, this.rootStat, identity); } };
  }
  async usage() {
    let bytes = 0;
    const objects = await this.directory('objects'), staging = await this.directory('staging');
    for (const entry of await readdir(objects)) {
      check(/^[a-f0-9]{64}$/.test(entry), 'UNSAFE_PATH', '保管目录包含未知条目');
      const dir = await this.directory('objects', entry);
      for (const file of await readdir(dir)) {
        check(/^[a-f0-9]{64}\.blob$/.test(file), 'UNSAFE_PATH', '保管目录包含未知文件');
        const stat = await lstat(join(dir, file));
        check(stat.isFile() && !stat.isSymbolicLink(), 'UNSAFE_PATH', '保管对象不是普通文件');
        bytes += stat.size;
      }
    }
    // Interrupted staging files also consume quota; never silently ignore them.
    for (const file of await readdir(staging)) {
      const stat = await lstat(join(staging, file));
      check(stat.isFile() && !stat.isSymbolicLink(), 'UNSAFE_PATH', '暂存对象不是普通文件'); bytes += stat.size;
    }
    return bytes;
  }
  async readObject(path, digest, expectedBytes, signal) {
    const stat = await lstat(path);
    check(stat.isFile() && !stat.isSymbolicLink() && stat.size === expectedBytes && stat.size <= this.maxAssetBytes, 'INTEGRITY_ERROR', '媒体文件类型或大小不匹配');
    const handle = await open(path, 'r');
    try {
      const actual = await handle.stat();
      check(actual.dev === stat.dev && actual.ino === stat.ino && actual.size === expectedBytes, 'INTEGRITY_ERROR', '媒体文件已变更');
      const bytes = Buffer.alloc(expectedBytes); let offset = 0;
      while (offset < bytes.length) { signal.throwIfAborted(); const result = await handle.read(bytes, offset, bytes.length - offset, offset); check(result.bytesRead > 0, 'INTEGRITY_ERROR', '媒体文件已截断'); offset += result.bytesRead; }
      const extra = await handle.read(Buffer.alloc(1), 0, 1, offset);
      signal.throwIfAborted(); check(extra.bytesRead === 0 && sha(bytes) === digest, 'INTEGRITY_ERROR', '媒体内容哈希不匹配');
      return bytes;
    } finally { await handle.close(); }
  }
  receipt(row) {
    return { sourceId: row.source_id, partIndex: row.part_index, sourceHash: row.source_hash, sha256: row.digest, bytes: row.bytes, mimeType: row.mime_type, mimeVerified: false, origin: row.origin, sourcePayloadMatch: row.origin === 'inline-payload' ? true : null, mediaBytesVerified: true, verifiedAt: new Date().toISOString(), codecVerified: false };
  }
  captureInline({ scope, sourceId, partIndex, signal }) {
    return this.run(signal, async active => {
      const source = this.source(scope, sourceId, partIndex), decoded = decodeInlinePart(source.payload.parts[partIndex], { maxBytes: this.maxAssetBytes });
      if (!decoded) return { status: 'reference-only', sourceId, partIndex, mediaBytesVerified: false, networkAccessed: false };
      return this.persist({ scope, sourceId, partIndex, sourceHash: source.content_hash, bytes: decoded.bytes, mimeType: decoded.mimeType, origin: 'inline-payload' }, active);
    }, true);
  }
  importBytes({ scope, sourceId, partIndex, bytes, mimeType, confirmed, expectedSourceHash, signal }) {
    // Snapshot the caller's buffer before any await or queue to prevent mutation.
    try {
      check(confirmed === true, 'CONFIRM_REQUIRED', '补交媒体需要明确确认');
      check(bytes instanceof Uint8Array && bytes.length > 0 && bytes.length <= this.maxAssetBytes, 'ASSET_TOO_LARGE', '补交媒体为空或超出单件上限');
      const copy = Buffer.from(bytes), declaredMime = mime(mimeType);
      return this.run(signal, async active => {
        const source = this.source(scope, sourceId, partIndex);
        check(expectedSourceHash === undefined || source.content_hash === expectedSourceHash, 'SOURCE_CHANGED', '补交来源发生变化');
        check(!decodeInlinePart(source.payload.parts[partIndex], { maxBytes: this.maxAssetBytes }), 'INLINE_SOURCE', '已有内联原件，请保管原载荷，不用补交文件替换');
        return this.persist({ scope, sourceId, partIndex, sourceHash: source.content_hash, bytes: copy, mimeType: declaredMime, origin: 'owner-import' }, active);
      }, true);
    } catch (error) { return Promise.reject(error); }
  }
  async persist(input, signal) {
    const { scope, sourceId, partIndex, sourceHash, bytes, mimeType, origin } = input, digest = sha(bytes);
    const unlock = await this.acquireWriter(signal);
    let stage, stageDirectory, stageIdentity, stageFileIdentity, objectPath, objectDirectory, objectIdentity, published = false, committed = false;
    try {
      const source = this.source(scope, sourceId, partIndex);
      check(source.content_hash === sourceHash, 'SOURCE_CHANGED', '原始来源发生变化');
      const old = this.row(scope, sourceId, partIndex);
      check(!old || old.digest === digest && old.source_hash === sourceHash && old.origin === origin && old.mime_type === mimeType, 'BINDING_CONFLICT', '这个原件位置已经绑定不同媒体');
      const indexed = this.store.db.prepare('SELECT bytes FROM yunshu_media_objects WHERE scope=? AND digest=?').get(scope, digest);
      check(!indexed || indexed.bytes === bytes.length, 'INTEGRITY_ERROR', '媒体索引大小不匹配');
      objectDirectory = await this.directory('objects', sha(scope)); objectIdentity = await this.directoryIdentity(objectDirectory); objectPath = join(objectDirectory, digest + '.blob');
      let present = true;
      try { await this.readObject(objectPath, digest, bytes.length, signal); } catch (error) { if (error.code === 'ENOENT') present = false; else throw error; }
      if (!present) {
        check(await this.usage() + bytes.length <= this.maxTotalBytes, 'CAPACITY', '媒体保管容量不足，未截断保存');
        stageDirectory = await this.directory('staging'); stageIdentity = await this.directoryIdentity(stageDirectory);
        stage = join(stageDirectory, randomUUID() + '.tmp');
        const handle = await open(stage, 'wx', 0o600);
        try { stageFileIdentity = await handle.stat(); await handle.writeFile(bytes, { signal }); await handle.sync(); } finally { await handle.close(); }
        signal.throwIfAborted();
        // Hard-link publication is atomic and never overwrites an existing blob.
        await this.directoryIdentity(stageDirectory, stageIdentity);
        await this.directoryIdentity(objectDirectory, objectIdentity);
        await link(stage, objectPath); published = true;
        await this.readObject(objectPath, digest, bytes.length, signal);
      }
      await this.directoryIdentity(objectDirectory, objectIdentity);
      signal.throwIfAborted();
      const row = this.store.transaction(() => {
        check(this.source(scope, sourceId, partIndex).content_hash === sourceHash, 'SOURCE_CHANGED', '保存时来源发生变化');
        const current = this.row(scope, sourceId, partIndex);
        check(!current || current.digest === digest && current.source_hash === sourceHash && current.origin === origin && current.mime_type === mimeType, 'BINDING_CONFLICT', '媒体绑定发生冲突');
        const now = new Date().toISOString();
        this.store.db.prepare('INSERT OR IGNORE INTO yunshu_media_objects VALUES(?,?,?,?)').run(scope, digest, bytes.length, now);
        this.store.db.prepare('INSERT OR IGNORE INTO yunshu_media_refs VALUES(?,?,?,?,?,?,?,?)').run(scope, sourceId, partIndex, sourceHash, digest, mimeType, origin, now);
        return this.row(scope, sourceId, partIndex);
      });
      committed = true;
      return { status: 'stored', duplicate: !!old, ...this.receipt(row) };
    } finally {
      try {
        if (stage && stageFileIdentity) await this.removeOwned(stage, stageDirectory, stageIdentity, stageFileIdentity);
        if (published && !committed) await this.removeOwned(objectPath, objectDirectory, objectIdentity, stageFileIdentity);
      } finally { await unlock(); }
    }
  }
  verify({ scope, sourceId, partIndex, signal }) {
    return this.run(signal, async active => {
      try { return (await this.verified(scope, sourceId, partIndex, active)).receipt; }
      catch (error) {
        if (['SOURCE_UNAVAILABLE', 'SOURCE_CHANGED', 'NOT_RETAINED', 'ENOENT', 'INTEGRITY_ERROR'].includes(error.code)) return { status: ({ SOURCE_UNAVAILABLE: 'source-unavailable', SOURCE_CHANGED: 'source-changed', NOT_RETAINED: 'not-retained', ENOENT: 'missing', INTEGRITY_ERROR: 'corrupt' })[error.code], mediaBytesVerified: false };
        throw error;
      }
    });
  }
  async verified(scope, sourceId, partIndex, signal) {
    const source = this.source(scope, sourceId, partIndex), row = this.row(scope, sourceId, partIndex);
    check(row, 'NOT_RETAINED', '附件字节尚未保管');
    check(row.source_hash === source.content_hash, 'SOURCE_CHANGED', '绑定不再对应原始来源');
    check(/^[a-f0-9]{64}$/.test(row.digest), 'INTEGRITY_ERROR', '媒体索引哈希无效');
    const directory = await this.directory('objects', sha(scope)), identity = await this.directoryIdentity(directory);
    const path = join(directory, row.digest + '.blob');
    const bytes = await this.readObject(path, row.digest, row.bytes, signal);
    await this.directoryIdentity(directory, identity);
    signal.throwIfAborted(); check(this.source(scope, sourceId, partIndex).content_hash === row.source_hash, 'SOURCE_CHANGED', '读取时来源发生变化');
    return { bytes, receipt: { status: 'verified', ...this.receipt(row) } };
  }
  readChunk({ scope, sourceId, partIndex, offset = 0, length = 256 * 1024, signal }) {
    return this.run(signal, async active => {
      check(Number.isSafeInteger(offset) && offset >= 0 && integer(length, 256 * 1024), 'INVALID_RANGE', '媒体分段读取位置或长度无效');
      const { bytes, receipt } = await this.verified(scope, sourceId, partIndex, active);
      check(offset <= bytes.length, 'INVALID_RANGE', '读取位置超过媒体长度');
      const end = Math.min(bytes.length, offset + length);
      return { ...receipt, offset, total: bytes.length, base64: bytes.subarray(offset, end).toString('base64'), nextOffset: end < bytes.length ? end : null };
    });
  }
  async close() {
    this.closed = true; this.lifetime.abort(); await Promise.allSettled([...this.operations]);
    // The host owns the main MemorySystem and closes it after this component.
  }
}
