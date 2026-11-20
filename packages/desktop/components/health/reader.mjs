import { collect } from './probes.mjs';
import { healthRows, countHealth } from './model.mjs';
import { resolve } from 'node:path';

// No implicit global fallback: these paths come from the running plugin config.
export class HealthReader {
  constructor(config, sample = collect, now = Date.now) {
    if (!config?.profileId || !config.memoryDb || !config.identityDb) throw new Error('健康检查缺少当前 profile 或存档路径');
    this.config = { ...config, profileId: resolve(config.profileId) };
    this.sample = sample; this.now = now; this.latest = null; this.sampledAt = -Infinity;
  }
  read({ force = false } = {}) {
    if (force === true || !this.latest || this.now() - this.sampledAt >= 30000) {
      this.latest = this.sample(this.config); this.sampledAt = this.now();
    }
    const checks = healthRows(this.latest, this.config.profileId, this.now());
    const counts = countHealth(checks);
    return { ...this.latest, profileId: this.config.profileId, checks, counts };
  }
}
