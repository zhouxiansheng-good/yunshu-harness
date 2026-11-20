import PersonaWithMedia from '../persona/media-persona.mjs';
import { requireOwner, dataError } from '../persona/shared/host.mjs';
import { HealthReader } from '../health/reader.mjs';

export default class PersonaWithHealth extends PersonaWithMedia {
  constructor(ctx, config = {}) {
    super(ctx, config);
    this.healthReader = new HealthReader({ ...config.health, mediaEnabled: config.media !== false });
  }
  async request(agent, action, payload, signal) {
    if (action !== 'health-read') return super.request(agent, action, payload, signal);
    // Same owner-only transport as existing panel requests, never a public endpoint.
    requireOwner(this.ctx, signal);
    try {
      if (signal?.aborted) throw signal.reason || new Error('请求已取消');
      return this.healthReader.read({ force: payload?.force === true });
    } catch (error) { throw dataError(error); }
  }
}
