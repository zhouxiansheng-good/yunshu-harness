import { WindowsKeyProtection } from './key-protection.mjs';

export const VOICE_CREDENTIAL_KEY = 'yunshu-voice/bailian';
const error = message => Object.assign(new Error(message), { code: 'voice-key-settings' });
function admit(value) {
  if (!value || !['beijing', 'singapore'].includes(value.region) || typeof value.apiKey !== 'string' ||
      !value.apiKey.trim() || value.apiKey.length > 1024 || /[^\x21-\x7e]/.test(value.apiKey.trim())) throw error('语音配置无效');
  return { region: value.region, apiKey: value.apiKey.trim() };
}

// Serializes startup restore, explicit changes and deletion. Only this plugin's
// encrypted record is read; the provider never receives a plaintext API key.
export class VoiceKeySettings {
  constructor({ validate, apply, clear, protection = new WindowsKeyProtection(), restore = true, source = 'none', recordKey = VOICE_CREDENTIAL_KEY, admitValue = admit }) {
    this.recordKey = recordKey; this.admitValue = admitValue; this.validate = validate; this.apply = apply; this.clear = clear; this.protection = protection; this.restore = restore;
    this.source = source; this.saved = 'unavailable'; this.tail = Promise.resolve(); this.revision = 0;
    this.lifetime = new AbortController(); this.binding = null;
  }
  status() { return { saved: this.saved, source: this.source, canSave: !!this.binding && this.protection.supported, canDelete: !!this.binding }; }
  enqueue(operation) {
    const task = this.tail.then(() => { this.lifetime.signal.throwIfAborted(); return operation(); });
    this.tail = task.catch(() => {}); return task;
  }
  attach(provider) {
    const binding = { provider, abort: new AbortController() }; this.binding?.abort.abort(); this.binding = binding;
    const revision = this.revision; this.saved = 'loading';
    this.enqueue(async () => {
      const signal = AbortSignal.any([this.lifetime.signal, binding.abort.signal]);
      try {
        signal.throwIfAborted();
        const record = await provider.readRecord(this.recordKey); signal.throwIfAborted();
        if (record === undefined) { this.saved = 'empty'; return; }
        this.saved = 'saved';
        if (record.kind !== 'grant' || record.payload?.schema !== 1 || record.payload?.protection !== 'windows-dpapi-user') throw error('保存的密钥格式无效');
        if (!this.restore || this.revision !== 0 || revision !== 0) return;
        const value = this.admitValue(JSON.parse(await this.protection.unprotect(record.payload.ciphertext, signal)));
        signal.throwIfAborted();
        if (this.revision !== revision) return;
        const candidate = this.validate(value); this.apply(value, candidate); this.source = 'saved';
      } catch { if (!signal.aborted) this.saved = 'error'; }
    }).catch(() => {});
    return () => { binding.abort.abort(); if (this.binding === binding) { this.binding = null; this.saved = 'unavailable'; } };
  }
  configure(value, { persist = false, signal } = {}) {
    value = this.admitValue(value); this.revision++;
    return this.enqueue(async () => {
      const active = AbortSignal.any([this.lifetime.signal, ...(signal ? [signal] : [])]); active.throwIfAborted();
      const candidate = this.validate(value);
      if (persist) {
        const binding = this.binding;
        if (!binding || !this.protection.supported) throw error('密钥保存不可用');
        const operation = AbortSignal.any([active, binding.abort.signal]);
        try {
          const ciphertext = await this.protection.protect(JSON.stringify(value), operation); operation.throwIfAborted();
          await binding.provider.modifyRecord(this.recordKey, () => {
            operation.throwIfAborted();
            return { kind: 'grant', payload: { schema: 1, protection: 'windows-dpapi-user', ciphertext } };
          });
        } catch { throw error('密钥保存未确认，请重试'); }
        // The durable commit is not undone by a lost response or closed panel.
        // Disposal/provider loss must still prevent activation of a new adapter.
        this.lifetime.signal.throwIfAborted(); binding.abort.signal.throwIfAborted(); this.saved = 'saved';
      } else {
        active.throwIfAborted();
      }
      this.apply(value, candidate); this.source = persist ? 'saved' : 'session';
      return { configured: true, persisted: persist };
    });
  }
  remove(signal) {
    this.revision++;
    return this.enqueue(async () => {
      const binding = this.binding; if (!binding) throw error('密钥存储不可用');
      const active = AbortSignal.any([this.lifetime.signal, binding.abort.signal, ...(signal ? [signal] : [])]);
      try { active.throwIfAborted(); await binding.provider.deleteRecord(this.recordKey); }
      catch { throw error('密钥删除未确认，请重试'); }
      // Deletion already committed: do not retain the active secret merely
      // because its initiating UI went away before the acknowledgement.
      this.clear(); if (this.binding === binding) this.saved = 'empty'; this.source = 'none'; return { deleted: true };
    });
  }
  async close() { this.lifetime.abort(); this.binding?.abort.abort(); this.binding = null; this.clear(); this.source = 'none'; await this.tail; }
}
