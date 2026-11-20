export class OpenAICompatibleEmbedding {
  constructor({url,model,keyEnv,allowRemote=false,timeoutMs=15000}) {
    this.url=new URL(url);if(!['http:','https:'].includes(this.url.protocol))throw new Error('Embedding URL must be HTTP(S)');
    const local=['localhost','127.0.0.1','[::1]'].includes(this.url.hostname);
    if(!local&&!allowRemote)throw new Error('Remote embedding requires explicit allowRemote: true');
    if(!local&&this.url.protocol!=='https:')throw new Error('Remote embedding requires HTTPS');
    if(this.url.username||this.url.password)throw new Error('Use keyEnv, not credentials in URL');
    if(typeof model!=='string'||!model.trim())throw new Error('Embedding model required');
    this.model=model;this.keyEnv=keyEnv;this.timeoutMs=timeoutMs;this.modelKey=this.url.origin+this.url.pathname+'#'+model;
  }
  async embed(input,signal) {
    const key=this.keyEnv?process.env[this.keyEnv]:undefined;
    if(this.keyEnv&&!key)throw new Error('Configured embedding key environment variable is not set');
    const response=await fetch(this.url,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',...(key?{Authorization:'Bearer '+key}:{})},body:JSON.stringify({model:this.model,input}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(this.timeoutMs)]):AbortSignal.timeout(this.timeoutMs)});
    if(!response.ok)throw new Error('Embedding service returned HTTP '+response.status);
    const body=await response.json();const vector=body?.data?.[0]?.embedding;
    if(!Array.isArray(vector)||!vector.length||vector.length>16000||vector.some(v=>!Number.isFinite(v)))throw new Error('Embedding service returned an invalid vector');
    return vector;
  }
}
