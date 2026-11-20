import * as AvalonAssets from './components/avalon/assets.mjs';
import YunshuControl from './components/system/host.mjs';
import * as FileReceipts from './components/file-receipts/host.mjs';
import Memory from './components/memory/index.mjs';
import Voice from './components/voice/index.mjs';
import Persona from './components/persona/index.mjs';
import { storagePaths } from './components/memory/shared/storage-location.mjs';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import CodingTools from './components/coding/host/index.mjs';
import CodingGuidance from './components/coding/guidance.mjs';

export const name = 'yunshu-desktop';
export const inject = ['typert', 'tools', 'agents'];

export function apply(ctx, config = {}) {
  ctx.plugin(AvalonAssets);
  ctx.plugin(YunshuControl,{coding:config.coding?.enabled===true});
  const paths = storagePaths();
  const unitedRoot = config.coding?.unitedRoot ?? config.memory?.unitedDir ?? dshHomePath('yunshu', 'united');
  ctx.plugin(Memory, { ...config.memory, database: config.memory?.database ?? paths.memory, storageError: paths.error, unitedDir: unitedRoot });
  ctx.plugin(Voice, config.voice ?? {});
  const persona = config.persona ?? {};
  ctx.plugin(CodingTools, config.coding ?? {});
  ctx.plugin(CodingGuidance, {});
  ctx.plugin(FileReceipts);
  ctx.plugin(Persona, { ...persona, database: persona.database ?? paths.identity,
    health: { profileId: dshHomePath(), memoryDb: config.memory?.database ?? paths.memory,
      identityDb: persona.database ?? paths.identity, engineDir: unitedRoot,
      craftClient: config.health?.craftClient ?? null },
    media: persona.media === false ? false : { ...persona.media, root: persona.media?.root ?? paths.media } });
}
