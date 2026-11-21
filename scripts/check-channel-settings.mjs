import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ChannelDirectory } from '../packages/desktop/components/system/channel-directory.mjs';
import { settings,selected,prepareWorker,connectionEnv } from '../packages/desktop/components/system/worker-profiles.mjs';
import { CodingCoordinator } from '../packages/desktop/components/coding/coordinator.mjs';

test('old profiles, alternate clients, protected endpoints and routing', {skip:process.platform!=='win32'},async t=>{
  const root=realpathSync(tmpdir()), dir=mkdtempSync(join(root,'ys-channels-'));
  t.after(()=>{if(dirname(realpathSync(dir))===root)rmSync(dir,{recursive:true,force:true});});
  const d=new ChannelDirectory(dir),co=new CodingCoordinator({enabled:true,stateDir:join(dir,'coding')});
  co.directory=d;
  const edit=async p=>d.edit(await prepareWorker({...p,revision:d.config().revision,requestId:randomUUID()}));
  const original=selected(d.config(),'codex');
  assert.equal(original.id,'codex');
  await edit({...settings(original),action:'worker',name:'本机执行',home:dir,model:'local-model',executable:process.execPath});
  co.withConnections(()=>{assert.equal(co.peer.config.codexHome,dir);assert.equal(co.peer.config.model,'local-model');});
  const key='fixture-'+randomUUID(),endpoint='http://127.0.0.1:19337/v1';
  for(const provider of ['codex','claude']){
    await edit({action:'worker',provider,name:'备用',mode:'api',endpoint,apiKey:key,model:'fixture-model'});
    const row=d.config().workers.find(r=>r.provider===provider&&r.name==='备用');
    assert.ok(!readFileSync(d.file,'utf8').includes(key));
    assert.ok(!Object.hasOwn(settings(row),'secret'));
    assert.equal(selected(d.config(),provider).id,provider);
    await edit({action:'use-worker',id:row.id});
    await co.withConnections(async()=>{
      const cfg=provider==='codex'?co.peer.config:co.claude;
      assert.equal(cfg.model,'fixture-model');
      const env=await connectionEnv(cfg);
      assert.equal(provider==='codex'?env.YUNSHU_CHANNEL_KEY:env.ANTHROPIC_API_KEY,key);
      if(provider==='codex')assert.ok(cfg.extraArgs.includes('model_providers.yunshu_channel.base_url='+JSON.stringify(endpoint)));
      else assert.equal(env.ANTHROPIC_BASE_URL,endpoint);
      await assert.rejects(edit({...settings(row),action:'worker',endpoint:'https://example.invalid/changed'}),/密钥/);
      await edit({action:'switch-worker',id:row.id,value:false});
      await assert.rejects(connectionEnv(cfg),/配置已更改/);
    });
    assert.equal(co.status(false).providers[provider].ready,false);
    await edit({action:'remove-worker',id:row.id});
    assert.equal(selected(d.config(),provider),null);
    assert.equal(co.status(false).providers[provider].reason,'channel-not-selected');
    await edit({action:'use-worker',id:provider});
    assert.equal(selected(new ChannelDirectory(dir).config(),provider).id,provider);
  }
});
