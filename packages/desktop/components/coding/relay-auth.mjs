/** Read only the selected Codex provider's readiness flags; never return credentials. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function scalar(raw) {
  let quote = null, escaped = false, end = raw.length;
  for (let n = 0; n < raw.length; n++) {
    const char = raw[n];
    if (escaped) { escaped = false; continue; }
    if (char === '\\' && quote === '"') { escaped = true; continue; }
    if (quote) { if (char === quote) quote = null; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '#') { end = n; break; }
  }
  const value = raw.slice(0, end).trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value.startsWith('"')) {
    try { return JSON.parse(value); } catch { return null; }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return null;
}

function selectedProvider(text) {
  let section = '';
  const top = {};
  const providers = new Map();
  for (const line of text.split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (header) { section = header[1]; continue; }
    const assignment = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/);
    if (!assignment) continue;
    const value = scalar(assignment[2]);
    if (section === '') top[assignment[1]] = value;
    else if (section.startsWith('model_providers.')) {
      const name = section.slice('model_providers.'.length);
      if (!providers.has(name)) providers.set(name, {});
      providers.get(name)[assignment[1]] = value;
    }
  }
  const name = top.model_provider;
  return { name, config: providers.get(name) };
}

export function probeRelay(codexHome) {
  let provider;
  try { provider = selectedProvider(readFileSync(join(codexHome, 'config.toml'), 'utf8')); }
  catch { return { ready: false, reason: 'relay-config-unavailable' }; }
  if (!provider.name || provider.name === 'openai') return { ready: false, reason: 'official-provider' };
  if (typeof provider.name !== 'string' || !provider.config)
    return { ready: false, reason: 'relay-provider-not-configured' };
  const config = provider.config;
  if (config.requires_openai_auth !== false)
    return { ready: false, reason: 'relay-requires-openai-auth' };
  if (config.wire_api !== 'responses')
    return { ready: false, reason: 'relay-responses-api-required' };
  let endpoint;
  try { endpoint = new URL(config.base_url); }
  catch { return { ready: false, reason: 'relay-endpoint-invalid' }; }
  // Local CLI proxy services legitimately speak HTTP on loopback. Do not extend
  // that exception to LAN, wildcard or lookalike DNS names.
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname);
  const supportedTransport = endpoint.protocol === 'https:'
    || (endpoint.protocol === 'http:' && loopback);
  if (!supportedTransport || !endpoint.hostname || endpoint.username || endpoint.password
    || endpoint.search || endpoint.hash)
    return { ready: false, reason: 'relay-endpoint-invalid' };
  if (typeof config.env_key === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(config.env_key) && process.env[config.env_key]?.trim())return {ready:true,reason:'relay-configured-unverified',provider:provider.name};
  if (typeof config.experimental_bearer_token !== 'string'
    || !config.experimental_bearer_token.trim())
    return { ready: false, reason: 'relay-credential-unavailable' };
  // Static preflight: the first real run still determines network/API compatibility.
  return { ready: true, reason: 'relay-configured-unverified', provider: provider.name };
}
