import Persona from './base-persona.mjs';
import { requireOwner, dataError } from './shared/host.mjs';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import Media from './media-service.mjs';

export default class PersonaWithMedia extends Persona {
  constructor(ctx, config = {}) {
    super(ctx, config);
    this.mediaFiber = config.media === false ? null : ctx.plugin(Media, config.media ?? {});
  }
  componentHealth() {
    const health = super.componentHealth(), media = this.ctx.get('yunshuMedia');
    health.push(media ? media.health() : { id: 'media', state: 'not_installed', configured: false, checkedAt: new Date().toISOString() }); return health;
  }
  async request(agent, action, payload, signal) {
    try {
      if (!action.startsWith('media-')) return await super.request(agent, action, payload, signal);
      requireOwner(this.ctx, signal);
      const media = this.ctx.get('yunshuMedia'); if (!media) throw new Error('请启用记忆和媒体功能');
      return await media.request(agent, action, payload, signal);
    } catch (error) {
      const remote = dataError(error), details = { ...(remote.details ?? {}) };
      if (typeof error?.cleanupComplete === 'boolean') details.cleanupComplete = error.cleanupComplete;
      if (typeof error?.incompleteDirectory === 'string') details.incompleteDirectory = error.incompleteDirectory;
      // The browser wire decoder requires a details record, even when empty.
      throw new RemoteError(remote.code, remote.message + (details.incompleteDirectory ? '；残留目录：' + details.incompleteDirectory : ''), details);
    }
  }
}
