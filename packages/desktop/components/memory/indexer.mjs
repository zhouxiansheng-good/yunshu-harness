// Durable work is derived from missing/stale database vectors, not an in-memory
// list. Restarting or changing the model therefore resumes without lost jobs.
export class EmbeddingIndexer {
  constructor(store, provider, { delayMs = 250, batchSize = 8 } = {}) {
    if (!provider?.local || typeof provider.embed !== 'function') throw new TypeError('自动索引需要本地模型');
    if (!Number.isInteger(delayMs) || delayMs < 0 || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) throw new TypeError('Invalid indexing schedule');
    this.store=store;this.provider=provider;this.delayMs=delayMs;this.batchSize=batchSize;
    this.abort=new AbortController();this.closed=false;this.paused=false;this.error=null;this.timer=null;this.running=null;
  }
  notify() {
    if(this.running){this.dirty=true;return;}
    if(this.closed||this.paused||this.error||this.timer)return;
    this.timer=setTimeout(()=>{this.timer=null;void this.flush();},this.delayMs);this.timer.unref?.();
  }
  flush() {
    if(this.running)return this.running;
    if(this.closed||this.paused)return Promise.resolve();
    clearTimeout(this.timer);this.timer=null;this.error=null;this.dirty=false;
    const signal=this.abort.signal;
    this.running=(async()=>{
      while(!this.closed&&!this.paused&&!signal.aborted){
        const rows=this.store.indexCandidates(this.provider.modelKey,this.batchSize);
        if(!rows.length)break;
        for(const row of rows){
          if(this.closed||this.paused||signal.aborted)return;
          const vector=await this.provider.embed(row.content,signal,{priority:'background'});
          if(this.closed||this.paused||signal.aborted)return;
          try{this.store.setArchiveVector(row.scope,row.id,this.provider.modelKey,vector,{expectedHash:row.content_hash});}
          catch(error){if(error.code!=='NOT_FOUND')throw error;}
        }
        await new Promise(resolve=>setTimeout(resolve,0));
      }
    })().catch(error=>{if(!signal.aborted&&!this.closed){this.error='索引失败，请重试';this.failureCode=error.code??'INDEX_FAILED';}}).finally(()=>{this.running=null;if(this.dirty)this.notify();});
    return this.running;
  }
  status(scope) { return {enabled:true,local:true,model:this.provider.modelKey,state:this.closed?'closed':this.paused?'paused':this.error?'error':this.running?'indexing':'idle',error:this.error,...this.store.indexProgress(scope,this.provider.modelKey)}; }
  async pause(){this.paused=true;clearTimeout(this.timer);this.timer=null;this.abort.abort();await this.running;}
  resume(){if(this.closed)return;this.paused=false;this.error=null;if(this.abort.signal.aborted)this.abort=new AbortController();this.notify();}
  async rebuild(scope){await this.pause();this.store.clearRoundVectors(scope);this.resume();return this.status(scope);}
  async close(){if(this.closed)return;this.closed=true;await this.pause();await this.provider.close?.();}
}
