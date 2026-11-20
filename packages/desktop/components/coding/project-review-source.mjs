/** Bounded read-only evidence adapter. No network, child processes or state writes. */
import { open, lstat, realpath } from 'node:fs/promises';
import { isAbsolute, resolve, relative, parse, join, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';

export class ReviewError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new ReviewError(code); };
const canonical = value => process.platform === 'win32' ? value.toLowerCase() : value;
const inside = (root, path) => {
  const part = relative(root, path);
  return part === '' || (part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part));
};

export function sourcePath(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || !value.isWellFormed() || /[:\0]/.test(value)
    || /^[\\/]/.test(value)) fail('source-path-invalid');
  const parts = value.split(/[\\/]/);
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)
    || /[<>"|?*\x00-\x1f]/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))
    fail('source-path-invalid');
  return parts.join('/');
}

export async function noLinks(path) {
  const absolute = resolve(path), base = parse(absolute).root;
  let current = base;
  for (const part of relative(base, absolute).split(sep).filter(Boolean)) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) fail('source-link-refused');
  }
  // Windows TEMP commonly uses an 8.3 alias. It is not a junction; compare the
  // resolved identities at the allowlist boundary instead of rejecting its spelling.
  return await realpath(absolute);
}

/** O(total bytes read + path components); memory <= one source budget + 1 byte. */
export async function checkSources(sources, workspace, { allowedRoots = [], limits, nowMs, signal } = {}) {
  if (!isAbsolute(workspace ?? '')) fail('workspace-absolute-required');
  if (!Array.isArray(allowedRoots) || !allowedRoots.length) fail('allowed-roots-required');
  // Lexical allowlist check precedes filesystem reads. No cwd/HOME/global fallback.
  const root = resolve(workspace);
  const allowed = allowedRoots.find(value => typeof value === 'string' && isAbsolute(value) && inside(resolve(value), root));
  if (!allowed) fail('workspace-not-allowed');
  try {
    const realAllowed = await noLinks(allowed), realRoot = await noLinks(root);
    if (!inside(realAllowed, realRoot)) fail('workspace-not-allowed');
    if (!(await lstat(root)).isDirectory()) fail('workspace-not-directory');
    const results = [], paths = new Set(), identities = new Set();
    let used = 0;
    for (const source of sources) {
      signal?.throwIfAborted();
      const path = resolve(root, sourcePath(source.path));
      if (!inside(root, path)) fail('source-outside-workspace');
      const key = canonical(path);
      if (paths.has(key)) fail('source-path-duplicate');
      paths.add(key);
      let file;
      try {
        const realSource = await noLinks(path);
        if (!inside(realRoot, realSource)) fail('source-outside-workspace');
        if (identities.has(canonical(realSource))) fail('source-path-duplicate');
        identities.add(canonical(realSource));
        const named = await lstat(path);
        if (!named.isFile() || named.nlink !== 1) fail('source-not-single-regular-file');
        file = await open(path, 'r');
        const before = await file.stat();
        if (!before.isFile() || before.dev !== named.dev || before.ino !== named.ino) fail('source-changed');
        const budget = Math.min(limits.fileBytes, limits.totalBytes - used);
        if (before.size > budget) fail('source-byte-limit');
        const bytes = Buffer.alloc(Math.min(before.size + 1, budget + 1));
        let offset = 0;
        while (offset < bytes.length) {
          signal?.throwIfAborted();
          const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, null);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        const after = await file.stat();
        if (canonical(await noLinks(path)) !== canonical(realSource)) fail('source-changed');
        const current = await lstat(path);
        if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
          || after.ctimeMs !== before.ctimeMs || current.dev !== before.dev || current.ino !== before.ino
          || current.size !== after.size || current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs)
          fail('source-changed');
        const body = bytes.subarray(0, offset);
        let text;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(body); }
        catch { fail('source-invalid-utf8'); }
        if (text.includes('\0')) fail('source-binary-text');
        used += offset;
        const sha256 = createHash('sha256').update(body).digest('hex');
        const lineCount = text.split(/\r?\n/).length;
        const issues = [];
        if (sha256 !== source.sha256) issues.push('hash-mismatch');
        const checkedAt = new Date().toISOString();
        if (source.validUntil && Date.parse(source.validUntil) <= Date.parse(checkedAt)) issues.push('expired');
        if (source.endLine > lineCount) issues.push('line-range-missing');
        results.push({ id: source.id, sha256, bytes: offset, checkedAt, issues });
      } catch (error) {
        if (signal?.aborted) throw error;
        if (error instanceof ReviewError) throw error;
        if (error.code === 'ENOENT') results.push({ id: source.id, issues: ['missing'] });
        else fail('source-read-failed'); // Never echo native errors containing paths/content.
      } finally { await file?.close(); }
    }
    signal?.throwIfAborted();
    return { sources: results, readBytes: used };
  } catch (error) {
    if (signal?.aborted || error instanceof ReviewError) throw error;
    fail('source-read-failed');
  }
}
