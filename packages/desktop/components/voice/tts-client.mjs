let lastStandaloneGeneration=0;
export class StandaloneTts {
  constructor({ remote, update }) {
    this.remote=remote;this.update=update;this.abort=new AbortController();this.queue=[];this.closed=false;this.pumping=false;
    this.generation=lastStandaloneGeneration=Math.max(lastStandaloneGeneration+1,Date.now()*1000+Math.floor(Math.random()*1000));this.cursor=0;this.epoch=0;
  }
  call(action,payload={}) { return this.remote(action,{generation:this.generation,...payload},this.abort.signal); }
  async start() {
    if(!this.starting)this.starting=this.call('tts-start');
    await this.starting;this.abort.signal.throwIfAborted();
  }
  enqueue(text) {
    if(this.closed)return;
    const chunks=new StreamingTextQueue().push(text,{final:true}).map(p=>typeof p==='string'?p:p.text).filter(Boolean);
    if(this.queue.length+chunks.length>100)throw new Error('朗读队列已满');
    this.queue.push(...chunks);void this.pump();
  }
  async pump() {
    if(this.pumping || this.closed)return;this.pumping=true;
    try {
      await this.start();
      while(this.queue.length && !this.closed){
        this.update('正在合成','');
        const epoch=this.epoch;const result=await this.call('tts-synthesize',{text:this.queue.shift()});this.abort.signal.throwIfAborted();
        if(epoch!==this.epoch)continue;
        this.update('正在朗读',result.notice||'');await this.play(result);
      }
      if(!this.closed)this.update('朗读完成',null);
    }catch(error){if(!this.closed){this.update('朗读失败',error.message);this.queue=[];}}
    finally{this.pumping=false;}
  }
  play(result) {
    return new Promise((resolve,reject)=>{
      const bytes=Uint8Array.from(atob(result.audioBase64),c=>c.charCodeAt(0));
      const url=URL.createObjectURL(new Blob([bytes],{type:result.mimeType})),audio=new Audio(url);this.audio=audio;
      let done=false;
      const finish=error=>{if(done)return;done=true;clearTimeout(timer);audio.onended=null;audio.onerror=null;audio.pause();audio.removeAttribute('src');URL.revokeObjectURL(url);if(this.audio===audio)this.audio=null;this.cancelPlayback=null;error?reject(error):resolve();};
      const timer=setTimeout(()=>finish(new Error('音频播放超时')),180000);
      this.cancelPlayback=()=>finish();audio.onended=()=>finish();audio.onerror=()=>finish(new Error('音频播放失败，请检查输出设备'));
      audio.play().catch(()=>finish(new Error('播放未启动，请点击试听或检查输出设备')));
    });
  }
  async watch() {
    await this.start();const current=await this.call('tts-watch');this.cursor=current.seq;
    const poll=async()=>{
      if(this.closed)return;
      try{
        const data=await this.call('tts-poll',{after:this.cursor});if(this.closed)return;
        if(data.expired)throw new Error('朗读连接已中断，请重新开启自动朗读');
        this.cursor=data.seq;
        if(data.gap){this.epoch++;this.queue=[];this.cancelPlayback?.();}
        for(const event of data.events??[]){
          if(event.type==='cancel'){this.epoch++;this.queue=[];this.cancelPlayback?.();}
          else if(event.type==='sentence'&&!data.gap)this.enqueue(event.text);
        }
      }catch(error){if(!this.closed){this.update('连接中断',error.message);this.stop();}return;}
      if(!this.closed)this.timer=setTimeout(poll,200);
    };
    void poll();
  }
  stop() {
    if(this.closed)return;this.closed=true;this.abort.abort();this.queue=[];clearTimeout(this.timer);this.cancelPlayback?.();
    const cleanup=()=>this.remote('tts-stop',{generation:this.generation}).catch(()=>{});
    void cleanup();void this.starting?.finally(cleanup).catch(()=>{});
  }
}
export function TtsPanel({sessionId,call,control,beforeStart,onConfigured,onServiceChange}) {
  const h=React.createElement,life=React.useRef(null),player=React.useRef(null),sequence=React.useRef(0),working=React.useRef(false);
  const defaultEndpoint='https://dashscope.aliyuncs.com/api/v1';
  const [settings,setSettings]=React.useState(null),[draft,setDraft]=React.useState(null),[key,setKey]=React.useState(''),[localVoices,setLocalVoices]=React.useState([]);
  const [models,setModels]=React.useState(null),[voiceList,setVoiceList]=React.useState(null),[catalogError,setCatalogError]=React.useState(''),[refresh,setRefresh]=React.useState(0);
  const [message,setMessage]=React.useState(''),[state,setState]=React.useState('待朗读'),[busy,setBusy]=React.useState(false),[auto,setAuto]=React.useState(false);
  const [text,setText]=React.useState('你好，我是云舒。我们把事情一件一件做好。');
  const halt=()=>{sequence.current++;player.current?.stop();player.current=null;setAuto(false);setState('已停止');};
  React.useEffect(()=>{
    const abort=new AbortController();life.current=abort;control.current={stop:halt};
    call(sessionId,'voice-profile',{},abort.signal).then(value=>{if(!abort.signal.aborted){setSettings(value);setDraft(value);}}).catch(e=>{if(!abort.signal.aborted)setMessage(e.message);});
    call(sessionId,'tts-voices',{},abort.signal).then(value=>{if(!abort.signal.aborted)setLocalVoices(value.voices);}).catch(e=>{if(!abort.signal.aborted)setMessage(e.message);});
    return()=>{abort.abort();sequence.current++;player.current?.stop();player.current=null;control.current=null;};
  },[sessionId]);
  const reuseKey=!!(settings?.mode==='bailian'&&settings.hasKey&&settings.endpoint===draft?.endpoint&&!key);
  const hasCredential=!!key.trim()||reuseKey;
  // This identity is in-memory only; it is never rendered, logged or persisted.
  const signature=JSON.stringify([sessionId,draft?.mode,draft?.endpoint,key,reuseKey,refresh]);
  const modelsReady=models?.signature===signature;
  const voicesReady=voiceList?.signature===signature&&voiceList?.model===draft?.model;
  React.useEffect(()=>{
    setModels(null);setVoiceList(null);setCatalogError('');
    if(draft?.mode!=='bailian'||!hasCredential)return;
    const abort=new AbortController();
    const timer=setTimeout(()=>{
      call(sessionId,'tts-models',{endpoint:draft.endpoint,apiKey:key,keepKey:reuseKey},abort.signal).then(result=>{
        if(abort.signal.aborted)return;setModels({...result,signature});
        setDraft(prev=>{const model=result.models.some(row=>row.id===prev.model)?prev.model:result.models[0]?.id||'';return {...prev,model,voice:model===prev.model?prev.voice:''};});
      }).catch(error=>{if(!abort.signal.aborted)setCatalogError(error.message);});
    },key?650:0);
    return()=>{clearTimeout(timer);abort.abort();};
  },[signature]);
  React.useEffect(()=>{
    setVoiceList(null);
    if(draft?.mode!=='bailian'||!modelsReady||!models.models.some(row=>row.id===draft.model))return;
    const abort=new AbortController();
    call(sessionId,'tts-catalog-voices',{endpoint:draft.endpoint,apiKey:key,keepKey:reuseKey,model:draft.model},abort.signal).then(result=>{
      if(abort.signal.aborted)return;setVoiceList({...result,signature});
      setDraft(prev=>{const recommended=['yeqinghe_v3.1','longanlingxin_v3.1','Cherry','longanwenrou','longanhuan'];const id=recommended.find(v=>result.voices.some(row=>row.id===v));return {...prev,voice:result.voices.some(row=>row.id===prev.voice)?prev.voice:id||result.voices[0]?.id||''};});
    }).catch(error=>{if(!abort.signal.aborted){setVoiceList({signature,model:draft.model,voices:[],warnings:[error.message],notice:'音色列表读取失败'});}});
    return()=>abort.abort();
  },[signature,modelsReady,draft?.model]);
  React.useEffect(()=>{onServiceChange?.(draft?.mode??'bailian');},[draft?.mode]);
  const run=async(fn)=>{if(working.current)return false;working.current=true;const signal=life.current.signal;setBusy(true);setMessage('');try{return await fn(signal);}catch(e){if(!signal.aborted)setMessage(e.message);return false;}finally{working.current=false;if(!signal.aborted)setBusy(false);}};
  const configure=(close=true)=>run(async signal=>{
    halt();await beforeStart();
    await call(sessionId,'voice-save',{...draft,apiKey:key,keepKey:!key&&settings?.mode===draft.mode&&settings?.endpoint===draft.endpoint,persist:!!settings.keyStorage?.canSave},signal);
    const value=await call(sessionId,'voice-profile',{},signal);
    if(!signal.aborted){setSettings(value);setDraft(value);setKey('');setMessage('语音设置已连接');await onConfigured?.(value,{close});return true;}
    return false;
  });
  const launch=async automatic=>{
    halt();const epoch=sequence.current;const signal=life.current.signal;setMessage('');
    try{
      await beforeStart();signal.throwIfAborted();if(epoch!==sequence.current)return;
      const current=new StandaloneTts({remote:(action,payload,innerSignal)=>call(sessionId,action,payload,innerSignal),update:(value,error)=>{if(!signal.aborted&&player.current===current){setState(value);if(error!==null)setMessage(error);if(value==='连接中断')setAuto(false);}}});
      player.current=current;
      if(automatic){await current.watch();if(!signal.aborted&&!current.closed&&player.current===current){setAuto(true);setState('等待回复');}}else current.enqueue(text);
    }catch(error){if(!signal.aborted&&epoch===sequence.current){setAuto(false);setMessage(error.message);}}
  };
  const button=(label,fn,disabled=false)=>h('button',{type:'button',onClick:fn,disabled:busy||disabled},label);
  if(!draft)return h('section',{'aria-label':'语音配置'},h('p',{role:'status'},message||'加载中…'));
  const isBailian=draft.mode==='bailian',isRemote=draft.mode!=='system';
  const ready=!isBailian||(modelsReady&&voicesReady&&models.models.some(v=>v.id===draft.model)&&voiceList.voices.some(v=>v.id===draft.voice));
  const dirty=['mode','endpoint','model','voice','systemVoice','rate','fallback'].some(k=>draft[k]!==settings[k])||!!key||settings.activeMode!==draft.mode;
  const fieldStyle={display:'grid',gap:5,marginBottom:10,minWidth:0},controlStyle={width:'100%',minWidth:0,boxSizing:'border-box'};
  const input=(name,field,placeholder)=>h('label',{style:fieldStyle},name,h('input',{'aria-label':name,style:controlStyle,value:draft[field],placeholder,onChange:e=>setDraft({...draft,[field]:e.target.value})}));
  const catalogStatus=!hasCredential?'填写 Key 后自动加载音色':catalogError||(!modelsReady?'正在读取模型…':!draft.model?models.notice:!voicesReady?'正在读取音色…':voiceList.notice);
  const preview=async()=>{if((!dirty||await configure(false))&&!life.current.signal.aborted)await launch(false);};
  return h('fieldset',{role:'region','aria-label':'语音配置',disabled:busy,style:{border:0,margin:0,padding:0,minWidth:0,display:'grid',gap:8}},
    h('strong',null,isBailian?'阿里云百炼':draft.mode==='system'?'本地朗读':'自定义朗读'),
    isRemote&&h('label',{style:fieldStyle},'API Key',h('input',{type:'password',autoComplete:'off','aria-label':'语音 API Key',style:controlStyle,value:key,placeholder:settings.hasKey&&settings.mode===draft.mode&&settings.endpoint===draft.endpoint?'已保存，留空继续使用':isBailian?'填写一次，用于识别和朗读':'服务 API Key（可选）',onChange:e=>setKey(e.target.value)})),
    isBailian&&h('label',{style:fieldStyle},'音色',h('select',{'aria-label':'语音音色',style:controlStyle,value:voicesReady?draft.voice:'',disabled:!voicesReady||!voiceList.voices.length,onChange:e=>setDraft({...draft,voice:e.target.value})},h('option',{value:''},'请选择音色'),...['system','account'].map(source=>h('optgroup',{key:source,label:source==='system'?'系统音色':'我的音色'},...(voicesReady?voiceList.voices:[]).filter(v=>v.source===source).map(v=>h('option',{key:v.id,value:v.id},v.label.replace(/_v[0-9.]+$/,''))))))),
    isBailian&&h('small',{role:'status','aria-label':'百炼列表状态'},catalogStatus),
    isBailian&&voicesReady&&voiceList.warnings.map((s,i)=>h('small',{key:i,role:'status'},s)),
    h('div',{className:'ys-row'},button(busy?'连接中…':'保存并连接',()=>void configure(true),!ready),button('试听音色',()=>void preview(),!ready),button('停止试听',halt)),
    message&&h('p',{role:'status','aria-label':'语音配置提示',style:{overflowWrap:'anywhere'}},message),
    h('details',null,h('summary',null,'高级设置'),
      h('label',{style:fieldStyle},'朗读服务',h('select',{'aria-label':'朗读服务选择',value:draft.mode,style:controlStyle,onChange:e=>{halt();setKey('');const mode=e.target.value;setDraft({...draft,mode,endpoint:mode==='bailian'?defaultEndpoint:'',model:'',voice:''});}},h('option',{value:'bailian'},'阿里云百炼'),h('option',{value:'system'},'本地朗读'),h('option',{value:'custom'},'自定义 TTS'))),
      isRemote&&h('label',{style:fieldStyle},'接口地址',h('input',{'aria-label':'语音接口地址',style:controlStyle,value:draft.endpoint,onChange:e=>{setKey('');setDraft({...draft,endpoint:e.target.value,model:isBailian?'':draft.model,voice:isBailian?'':draft.voice});}})),
      isBailian?h('label',{style:fieldStyle},'朗读模型',h('select',{'aria-label':'语音模型',style:controlStyle,value:modelsReady?draft.model:'',disabled:!modelsReady||!models.models.length,onChange:e=>setDraft({...draft,model:e.target.value,voice:''})},h('option',{value:''},'请选择模型'),...(modelsReady?models.models:[]).map(v=>h('option',{key:v.id,value:v.id},v.label)))):draft.mode==='custom'&&h(React.Fragment,null,input('朗读模型','model','模型 ID'),input('自定义音色','voice','音色 ID')),
      isBailian&&h('small',{style:{display:'block',margin:'8px 0'}},'识别：qwen3-asr-flash-realtime'),
      isBailian&&h('div',{className:'ys-row'},button('刷新模型和音色',()=>setRefresh(v=>v+1),!hasCredential)),
      isBailian&&h('small',{style:{display:'block',margin:'8px 0'}},'系统音色：官方目录；我的音色：当前账号。'),
      isRemote&&h('label',{style:fieldStyle},h('span',null,h('input',{type:'checkbox',checked:draft.fallback,onChange:e=>setDraft({...draft,fallback:e.target.checked})}),' 朗读失败时使用本地语音')),
      h('label',{style:fieldStyle},'本地音色',h('select',{'aria-label':'系统音色',style:controlStyle,value:draft.systemVoice,onChange:e=>setDraft({...draft,systemVoice:e.target.value})},h('option',{value:''},'默认音色'),...localVoices.map(v=>h('option',{key:v.name,value:v.name},(v.displayName||v.name)+' · '+v.language)))),
      h('label',{style:fieldStyle},'本地语速',h('input',{'aria-label':'系统语速',type:'range',min:-5,max:5,value:draft.rate,onChange:e=>setDraft({...draft,rate:Number(e.target.value)})})),
      h('label',{style:fieldStyle},'试听文字',h('textarea',{'aria-label':'朗读内容',value:text,maxLength:2000,onChange:e=>setText(e.target.value)})),
      h('small',{'aria-label':'朗读状态',style:{display:'block',margin:'8px 0'}},state),
      button('清除语音设置',()=>{if(confirm('清除已保存的语音设置与密钥，并停止语音？'))void run(async signal=>{halt();await beforeStart();await call(sessionId,'voice-delete',{},signal);const value=await call(sessionId,'voice-profile',{},signal);if(!signal.aborted){setSettings(value);setDraft(value);setKey('');await onConfigured?.(value,{close:false});setMessage('语音设置已清除');return true;}});},!settings.keyStorage?.canDelete)
    ),
    h('small',null,isRemote?'连接检查不上传录音；开始对话、听写或试听后使用服务额度。':'本地朗读无需 Key。'));
}
