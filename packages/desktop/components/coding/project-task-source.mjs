/** Bounded optimistic read transaction for original task files. No writes/locks/commands. */
import { open, lstat } from 'node:fs/promises';
import { isAbsolute, resolve, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { noLinks, sourcePath, ReviewError } from './project-review-source.mjs';
import { parseDiagnosisJson } from './diagnosis-json.mjs';

export const TASK_READ_LIMITS = Object.freeze({ fileBytes: 4 * 1024 * 1024, totalBytes: 16 * 1024 * 1024,
  depth: 32, attempts: 256, files: 1024 });
export const taskHash = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw new ReviewError(code); };
const inside = (root, path) => {
  const part = relative(root, path);
  return part === '' || (part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part));
};
const identity = s => [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs, s.nlink];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export async function allowedTaskWorkspace(workspace, allowedRoots) {
  if (typeof workspace !== 'string' || !isAbsolute(workspace)) fail('task-workspace-invalid');
  if (!Array.isArray(allowedRoots) || !allowedRoots.length) fail('allowed-roots-required');
  const allowed = allowedRoots.find(r => typeof r === 'string' && isAbsolute(r) && inside(resolve(r), resolve(workspace)));
  if (!allowed) fail('task-workspace-not-allowed');
  const realAllowed = await noLinks(allowed), realWorkspace = await noLinks(workspace);
  if (!inside(realAllowed, realWorkspace) || !(await lstat(workspace)).isDirectory()) fail('task-workspace-not-allowed');
  return realWorkspace;
}

/** O(total bytes + path components); second reads count against the same budget.
 * This detects observed drift, not an atomic filesystem snapshot or a runtime lease.
 */
export function taskReadSession(config = {}, signal) {
  const limits = { ...TASK_READ_LIMITS }, configured = config.limits ?? {};
  if (!configured || typeof configured !== 'object' || Array.isArray(configured)
    || Object.keys(configured).some(k => !Object.hasOwn(limits, k))) fail('task-limits-invalid');
  for (const k of Object.keys(limits)) {
    const v = configured[k] ?? limits[k];
    if (!Number.isSafeInteger(v) || v < 1 || v > limits[k]) fail('task-limits-invalid');
    limits[k] = v;
  }
  let used = 0;
  const entries = new Map();
  async function read(root, name, { optional = false, marker = false } = {}) {
    signal?.throwIfAborted();
    if (typeof root !== 'string' || !isAbsolute(root)) fail('task-source-root-required');
    const path = resolve(root, sourcePath(name));
    let handle;
    try {
      const realRoot = await noLinks(root);
      let named;
      try { named = await lstat(path); }
      catch (e) {
        if (e.code === 'ENOENT' && optional) {
          // Check existing parents too: a dangling/reparse directory is not absence.
          let parent = resolve(path, '..');
          while (inside(resolve(root), parent)) {
            try { await noLinks(parent); break; }
            catch (p) { if (p.code !== 'ENOENT') throw p; }
            parent = resolve(parent, '..');
          }
          return { absent: true };
        }
        throw e;
      }
      const real = await noLinks(path);
      if (!inside(realRoot, real)) fail('task-source-outside-root');
      // Lock contents are never read. Even a malformed marker means mutation held.
      if (marker) return { marker: true, identity: identity(named) };
      if (!named.isFile() || named.nlink !== 1) fail('task-source-not-single-file');
      handle = await open(path, 'r');
      const before = await handle.stat();
      if (!same(identity(before), identity(named))) fail('task-source-changed');
      const budget = Math.min(limits.fileBytes, limits.totalBytes - used);
      if (before.size > budget) fail('task-source-byte-limit');
      const bytes = Buffer.alloc(before.size + 1);
      let offset = 0;
      while (offset < bytes.length) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const after = await handle.stat(), current = await lstat(path);
      if (offset !== before.size || !same(identity(before), identity(after))
        || !same(identity(before), identity(current)) || await noLinks(path) !== real) fail('task-source-changed');
      used += offset;
      const body = bytes.subarray(0, offset);
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(body); }
      catch { fail('task-source-utf8'); }
      if (text.includes('\0')) fail('task-source-binary');
      return { sha256: taskHash(body), identity: identity(before), text };
    } catch (error) {
      if (signal?.aborted || error instanceof ReviewError) throw error;
      fail(error.code === 'ENOENT' ? 'task-source-missing' : 'task-source-read-failed');
    } finally { await handle?.close(); }
  }
  async function observe(root, name, options) {
    const key = JSON.stringify([root, name]);
    if (!entries.has(key)) {
      if (entries.size >= 8) fail('task-source-count-limit');
      entries.set(key, { root, name, options, value: await read(root, name, options) });
    }
    return entries.get(key).value;
  }
  return {
    limits,
    get readBytes() { return used; },
    async json(root, name, optional = false) {
      const value = await observe(root, name, { optional });
      if (value.absent) return undefined;
      try { return parseDiagnosisJson(value.text, limits.depth); }
      catch { fail('task-source-json'); }
    },
    async marker(root, name) { return !(await observe(root, name, { optional: true, marker: true })).absent; },
    digest() {
      return taskHash(JSON.stringify([...entries.values()].map(({ root, name, value: { text, ...value } }) => ({ root, name, ...value }))));
    },
    async recheck() {
      for (const { root, name, options, value } of entries.values()) {
        const after = await read(root, name, options);
        if (!same(value, after)) fail('task-snapshot-changed');
      }
      signal?.throwIfAborted();
    },
  };
}
