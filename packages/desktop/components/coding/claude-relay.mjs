/** Locate the native Claude Code CLI and check its existing relay settings without returning secrets. */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, delimiter } from 'node:path';

export function claudeHome(configured = '') {
  return resolve(configured || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'));
}

export function locateClaude(config = {}, env = process.env) {
  const candidates = [];
  if (config.claudePath) {
    candidates.push(config.claudePath);
    candidates.push(join(dirname(config.claudePath), 'node_modules', '@anthropic-ai',
      'claude-code', 'bin', 'claude.exe'));
  }
  for (const folder of String(env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)) {
    candidates.push(join(folder, process.platform === 'win32' ? 'claude.exe' : 'claude'));
    if (process.platform === 'win32')
      candidates.push(join(folder, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'));
  }
  for (const candidate of candidates) {
    try {
      const path = resolve(candidate);
      if (existsSync(path) && statSync(path).isFile() && !/\.(cmd|ps1)$/i.test(path))
        return { available: true, path };
    } catch { /* Try the next known location. */ }
  }
  return { available: false, path: null };
}

export function probeClaudeRelay(home) {
  let settings;
  try { settings = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8')); }
  catch { return { ready: false, reason: 'relay-settings-unavailable' }; }
  const env = settings?.env;
  if (!env || typeof env !== 'object')
    return { ready: false, reason: 'relay-provider-not-configured' };
  let endpoint;
  try { endpoint = new URL(env.ANTHROPIC_BASE_URL); }
  catch { return { ready: false, reason: 'relay-endpoint-invalid' }; }
  if (endpoint.protocol !== 'https:' || !endpoint.hostname || endpoint.username || endpoint.password
    || endpoint.search || endpoint.hash)
    return { ready: false, reason: 'relay-endpoint-invalid' };
  const credential = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY;
  if (typeof credential !== 'string' || !credential.trim())
    return { ready: false, reason: 'relay-credential-unavailable' };
  return { ready: true, reason: 'relay-configured-unverified' };
}
