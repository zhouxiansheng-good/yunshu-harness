export function* decodedPcmFrames(decoded) {
  const rate = decoded.sampleRate, count = decoded.numberOfChannels;
  if (!Number.isInteger(rate) || rate < 8000 || rate > 192000 || !Number.isInteger(count) || count < 1 || count > 8 || decoded.length <= 0 || decoded.length > rate * 60) throw new Error('单句朗读音频格式或时长无效');
  const sampleRate = Math.min(rate, 48000), ratio = rate / sampleRate;
  const channels = Array.from({ length: count }, (_, i) => decoded.getChannelData(i));
  const length = Math.floor(decoded.length / ratio);
  let sequence = 0;
  for (let offset = 0; offset < length; offset += 6400) {
    const size = Math.min(6400, length - offset), pcm = new Uint8Array(size * 2), view = new DataView(pcm.buffer);
    for (let i = 0; i < size; i++) {
      const start = (offset + i) * ratio, end = Math.min(decoded.length, start + ratio);
      let value = 0;
      for (let j = Math.floor(start); j < Math.ceil(end); j++) {
        const weight = Math.min(end, j + 1) - Math.max(start, j);
        for (const channel of channels) value += channel[j] * weight;
      }
      value = Math.max(-1, Math.min(1, value / ((end - start) * count)));
      if (!Number.isFinite(value)) throw new Error('朗读音频采样无效');
      view.setInt16(i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
    }
    yield { sequence: sequence++, sampleRate, channels: 1, encoding: 'pcm_s16le', pcm };
  }
}

export function VoiceView({ sessionId, call, locked, onActiveChange, target }) {
  const h = React.createElement, anchor = React.useRef(null), runtime = React.useRef(null), life = React.useRef(null);
  const [open, setOpen] = React.useState(false), [status, setStatus] = React.useState(null), [phase, setPhase] = React.useState('idle');
  const [error, setError] = React.useState(''), [draft, setDraft] = React.useState(''), [readReplies, setReadReplies] = React.useState(false);
  const [autoSend, setAutoSend] = React.useState(false), [apiKey, setApiKey] = React.useState(''), [region, setRegion] = React.useState('beijing');
  const [vadStatus, setVadStatus] = React.useState('未启动');
  const [reply, setReply] = React.useState(''); const replyAttempt = React.useRef(null);
  const [settingsOpen,setSettingsOpen]=React.useState(false),[voiceMode,setVoiceMode]=React.useState('conversation'),[serviceMode,setServiceMode]=React.useState('bailian');
  const [busy, setBusy] = React.useState(false), [sending, setSending] = React.useState(false), [uncertain, setUncertain] = React.useState(false);
  const cleanup = React.useRef(Promise.resolve()), settingsBusy = React.useRef(false), submission = React.useRef(null), generation = React.useRef(0);
  const startEpoch = React.useRef(0), ttsControl = React.useRef(null);
  const preferences = React.useRef({}); preferences.current = { readReplies, autoSend, locked };
  const stop = async ({ interrupted = false } = {}) => {
    startEpoch.current++;
    const state = runtime.current; runtime.current = null;
    setPhase(interrupted ? 'interrupted' : 'idle'); setReadReplies(false); setVadStatus('未启动');
    if (interrupted) { setAutoSend(false); preferences.current = { ...preferences.current, autoSend: false, readReplies: false }; }
    if (state) {
      state.abort.abort(); clearTimeout(state.timer); state.speechQueue = [];
      void call(state.sessionId, 'voice-stop', { generation: state.generation }).catch(() => {});
      void call(state.sessionId, 'unwatch', { generation: state.generation }).catch(() => {});
      cleanup.current = Promise.allSettled([cleanup.current, state.mic?.stop(), state.player.close(), state.engine.stop('closed'), state.vad?.dispose()]);
    }
    await cleanup.current;
  };
  React.useEffect(() => {
    const abort = new AbortController(); life.current = abort;
    void stop(); submission.current = null; settingsBusy.current = false; setBusy(false); setSending(false); setUncertain(false);
    setDraft(''); setReply(''); replyAttempt.current = null;
    setError(''); setStatus(null); setApiKey(''); setReadReplies(false); setAutoSend(false);
    if (sessionId) call(sessionId, 'status', {}, abort.signal).then(value => { if (!abort.signal.aborted) { setStatus(value); setRegion(value.region ?? 'beijing');setSettingsOpen(!value.available); } }).catch(e => { if (!abort.signal.aborted) setError(e.message); });
    return () => { abort.abort(); void stop(); };
  }, [sessionId]);
  React.useEffect(() => { onActiveChange?.(!['idle','interrupted'].includes(phase)); }, [phase]);
  React.useEffect(() => { if (locked) void stop(); }, [locked]);
  React.useEffect(() => { const close = () => { void stop(); }; window.addEventListener('pagehide', close); return () => window.removeEventListener('pagehide', close); }, []);
  const sendText = async (text, remote, signal, { fresh = false } = {}) => {
    const viewSignal = life.current?.signal;
    if (submission.current?.pending) throw new Error('正在发送');
    signal?.throwIfAborted(); viewSignal?.throwIfAborted();
    if (submission.current?.pending) throw new Error('正在发送');
    const previous = submission.current;
    const job = !fresh && previous?.text === text && !previous.completed ? previous : { text, requestId: globalThis.crypto?.randomUUID?.() ?? String(Date.now()) + '-' + Math.random().toString(36).slice(2) };
    job.pending = true; submission.current = job; setSending(true);
    try {
      await remote('send', { text, requestId: job.requestId });
      job.completed = true;
      if (!viewSignal?.aborted && submission.current === job) { setDraft(current => current === text ? '' : current); setUncertain(false); }
    } catch (error) {
      if (!viewSignal?.aborted && submission.current === job) setUncertain(true);
      throw new Error('发送结果未确认，请先核对会话');
    } finally { job.pending = false; if (!viewSignal?.aborted && submission.current === job) setSending(false); }
  };
  const ready = async ({ recovering = false } = {}) => {
    if (phase === 'interrupted' && !recovering) throw new Error('请先恢复连接');
    const lifeSignal = life.current?.signal, requestedEpoch = startEpoch.current;
    await cleanup.current; lifeSignal?.throwIfAborted();
    if (requestedEpoch !== startEpoch.current) throw new Error('语音启动已取消');
    if (runtime.current) { const existing = runtime.current; await existing.ready; return existing; }
    if (!status?.available || status.asrMode !== 'bailian') throw new Error('请先设置百炼 API Key');
    generation.current = Math.max(generation.current + 1, Date.now() * 1000 + Math.floor(Math.random() * 1000));
    const state = { sessionId, generation: generation.current, abort: new AbortController(), sequence: 0, replySequence: 0, outbound: Promise.resolve(), queued: 0, turns: new Map(), speechQueue: [], speaking: false, mic: null, speechComplete: false, speechEpoch: 0 };
    runtime.current = state;
    const alive = () => runtime.current === state && !state.abort.signal.aborted;
    const remote = (action, payload = {}) => call(sessionId, action, { generation: state.generation, ...payload }, state.abort.signal).catch(error => { const labels = { 'voice-start': '启动语音', 'asr-start': '连接百炼识别', 'asr-append': '上传录音', 'asr-finish': '完成识别', speak: '连接百炼朗读', watch: '订阅回复', poll: '接收回复', 'audio-poll': '接收语音' }; const wrapped = new Error((labels[action] ?? action) + '：' + error.message); wrapped.code = error?.code; throw wrapped; });
    const fail = e => { if (alive()) { setError(e.message); void stop({ interrupted: true }); } };
    const enqueue = operation => {
      if (!alive()) return;
      if (++state.queued > 100) { fail(new Error('上传队列已满，请重试')); return; }
      state.outbound = state.outbound.then(async () => { if (alive()) await operation(); }).catch(fail).finally(() => state.queued--);
    };
    const flush = turn => {
      if (!turn?.frames.length) return;
      const bytes = new Uint8Array(turn.frames.length * 640), view = new DataView(bytes.buffer);
      turn.frames.forEach((frame, frameIndex) => { for (let i = 0; i < frame.length; i++) view.setInt16(frameIndex * 640 + i * 2, frame[i], true); });
      turn.frames = []; const sequence = turn.sequence++;
      enqueue(() => remote('asr-append', { turnId: turn.id, sequence, audioBase64: waveBase64(bytes) }));
    };
    const nextSpeech = async () => {
      if (!alive() || state.speaking || !state.speechQueue.length) return;
      state.speaking = true; state.speechComplete = false; state.encoded = null;
      const speechEpoch = ++state.speechEpoch;
      try {
        if (state.playbackStopped) await state.playbackStopped;
        if (!alive() || speechEpoch !== state.speechEpoch) return;
        if (!state.speechQueue.length) { state.speaking = false; return; }
        state.activeSpeech = state.speechQueue.shift();
        state.speechRequest = remote('speak', { text: state.activeSpeech.text });
        const job = await state.speechRequest;
        if (alive() && speechEpoch === state.speechEpoch) { state.speechId = job.speechId; state.engine.acceptSpeech({ sessionId, generation: state.generation, speechId: job.speechId }); }
      } catch (e) { if (speechEpoch === state.speechEpoch) { state.speaking = false; fail(e); } }
      finally { if (speechEpoch === state.speechEpoch) state.speechRequest = null; }
    };
    state.say = (text, metadata = {}) => {
      const pieces = new StreamingTextQueue().push(text, { final: true });
      const sentences = pieces.map(piece => typeof piece === 'string' ? piece : piece.text).filter(Boolean);
      if (state.speechQueue.length + sentences.length > 100) throw new Error('朗读队列已满');
      state.speechQueue.push(...sentences.map(text => ({ text, attemptId: metadata.attemptId ?? null, turn: metadata.turn ?? null }))); void nextSpeech();
    };
    state.stopPlayback = ({ notifyReply = true, keepQueue = false } = {}) => {
      state.speechEpoch++;
      state.engine.stopPlayback('user_stop');
      if (!keepQueue) state.speechQueue = [];
      state.speaking = false; state.speechComplete = false; state.encoded = null; state.speechId = null; state.activeSpeech = null; state.player.stop();
      const pending = state.speechRequest; state.speechRequest = null;
      state.playbackStopped = (async () => {
        await remote('stop-playback', { cancelReply: notifyReply });
        if (pending) { const job = await pending.catch(() => null); if (job && alive()) await remote('stop-playback', { speechId: job.speechId }); }
      })().catch(e => { if (alive()) setError(e.message); }).finally(() => { if (keepQueue && alive()) void nextSpeech(); });
    };
    state.cancelReply = event => {
      const matches = value => !!value && (event.attemptId ? value.attemptId === event.attemptId : event.turn != null ? value.turn === event.turn : true);
      state.speechQueue = state.speechQueue.filter(value => !matches(value));
      if (matches(state.activeSpeech)) state.stopPlayback({ notifyReply: false, keepQueue: true });
    };
    state.player = new PcmOutput({ onActive: value => { state.engine?.setPlaybackActive(value); if (!value && state.speechComplete) { state.speaking = false; void nextSpeech(); } } });
    state.engine = new StreamingVoiceEngine({ onEvent: event => {
      if (!alive()) return;
      if (event.type === 'turn_start') {
        const turn = { id: event.turnId, sequence: 0, frames: [] }; state.turns.set(turn.id, turn);
        enqueue(() => remote('asr-start', { turnId: turn.id }));
      } else if (event.type === 'audio_frame') {
        const turn = state.turns.get(event.turnId); if (!turn) return; turn.frames.push(event.pcm); if (turn.frames.length >= 5) flush(turn);
      } else if (event.type === 'turn_end') {
        const turn = state.turns.get(event.turnId); flush(turn); state.turns.delete(event.turnId);
        enqueue(async () => {
          const result = await remote('asr-finish', { turnId: event.turnId }); if (!alive()) return;
          state.engine.confirmTranscript?.({ sessionId, generation: state.generation, turnId: event.turnId, text: result.text });
          setDraft(result.text);
          if (result.text.trim() && preferences.current.autoSend && !preferences.current.locked) await sendText(result.text, remote, state.abort.signal);
        });
      } else if (event.type === 'turn_discarded') {
        const turn = state.turns.get(event.turnId); if (turn) { state.turns.delete(event.turnId); enqueue(() => remote('asr-cancel', { turnId: event.turnId })); }
      } else if (event.type === 'playback_gain') state.player.setGain(event.gain, event.rampSeconds);
      else if (event.type === 'playback_stop') { if (event.notifyRemote) state.stopPlayback(); else state.player.stop(); }
      else if (event.type === 'playback_audio') { try { state.player.play(event.pcm, event.sampleRate); } catch (e) { fail(e); } }
      else if (event.type === 'warning' && event.code?.startsWith('vad_')) setVadStatus('识别确认');
    } });
    state.ready = (async () => {
      await state.player.ready();
      state.abort.signal.throwIfAborted();
      if (!alive()) throw new Error('语音启动已取消');
      setVadStatus('加载中');
      try {
        const resources = await loadVadResources(remote, { signal: state.abort.signal });
        state.vad = await SileroVad.create({ ...resources, signal: state.abort.signal });
        state.engine.vad = state.vad;
        if (alive()) setVadStatus('人声检测');
      } catch (error) {
        state.abort.signal.throwIfAborted();
        if (alive()) { setVadStatus('识别确认'); setError('人声检测不可用，已切换识别确认'); }
      }
      state.abort.signal.throwIfAborted();
      state.engine.start({ sessionId, generation: state.generation, inputSampleRate: state.player.context.sampleRate });
      await remote('voice-start'); const watch = await remote('watch'); state.replySequence = watch.seq;
      const poll = async () => {
        try {
          const result = await remote('audio-poll', { after: state.sequence });
          if (state.speechRequest) await state.speechRequest;
          if (!alive()) return; state.sequence = result.seq;
          for (const event of result.events) {
            if (event.type === 'transcript-partial') setDraft(event.text);
            else if (event.type === 'audio' && event.speechId === state.speechId) state.engine.acceptAudio({ ...event, sessionId, generation: state.generation, pcm: base64Pcm(event.audioBase64) });
            else if (event.type === 'encoded-audio' && event.speechId === state.speechId) {
              const bytes=Uint8Array.from(atob(event.audioBase64),c=>c.charCodeAt(0));
              const encoded=state.encoded??{parts:[],bytes:0,next:0,mimeType:event.mimeType};
              if(event.sequence!==encoded.next||encoded.bytes+bytes.length>8*1024*1024||!['audio/wav','audio/mpeg'].includes(event.mimeType)||encoded.mimeType!==event.mimeType)throw new Error('朗读音频片段无效');
              encoded.parts.push(bytes);encoded.bytes+=bytes.length;encoded.next++;state.encoded=encoded;
            }
            else if (event.type === 'audio-notice' && event.speechId === state.speechId) setError(event.message);
            else if (event.type === 'audio-error' && event.speechId === state.speechId) { fail(new Error(event.message)); return; }
            else if (event.type === 'audio-end' && event.speechId === state.speechId) {
              if(state.encoded){
                const encoded=state.encoded;state.encoded=null;
                if(event.sequence!==encoded.next)throw new Error('朗读音频不完整');
                const bytes=new Uint8Array(encoded.bytes);let at=0;for(const part of encoded.parts){bytes.set(part,at);at+=part.length;}
                const decodingEpoch=state.speechEpoch;
                let decoded;
                try { decoded=await state.player.context.decodeAudioData(bytes.buffer); }
                catch(error) {
                  if(!alive()||event.speechId!==state.speechId||decodingEpoch!==state.speechEpoch)continue;
                  throw error;
                }
                if(!alive()||event.speechId!==state.speechId||decodingEpoch!==state.speechEpoch)continue;
                for(const frame of decodedPcmFrames(decoded)) {
                  state.engine.acceptAudio({sessionId,generation:state.generation,speechId:event.speechId,speechJobId:event.speechId,...frame});
                }
              }
              state.speechComplete = true; if (!state.player.sources.size) { state.speaking = false; void nextSpeech(); }
            }
          }
          const replies = await remote('poll', { after: state.replySequence }); if (!alive()) return;
          if (replies.expired) { state.stopPlayback({ notifyReply: false }); throw new Error('回复连接已结束，请重新开启语音'); }
          else {
            state.replySequence = replies.seq;
            if (replies.gap) state.stopPlayback({ notifyReply: false });
            for (const event of replies.events ?? []) {
              if (event.type === 'error') setError(event.message);
              else if (event.type === 'cancel') state.cancelReply(event);
              else if (event.type === 'sentence' && !replies.gap) {
                if (replyAttempt.current !== event.attemptId) { replyAttempt.current = event.attemptId; setReply(event.text); }
                else setReply(value => (value + event.text).slice(-12000));
                if (preferences.current.readReplies) state.say(event.text, event);
              }
            }
          }
        } catch (e) { fail(e); }
        if (alive()) { state.engine.tick(); state.timer = setTimeout(poll, 160); }
      };
      if (alive()) void poll();
    })();
    try { await state.ready; return state; } catch (e) { fail(e); throw e; }
  };
  const start = async ({recovering=false}={}) => {
    if (locked || (phase !== 'idle' && !(recovering && phase==='interrupted'))) return;
    const conversation=voiceMode==='conversation';setAutoSend(conversation);setReadReplies(conversation);preferences.current={...preferences.current,autoSend:conversation,readReplies:conversation};
    ttsControl.current?.stop();
    const attempt = ++startEpoch.current, lifeSignal = life.current?.signal; let state;
    const current = () => attempt === startEpoch.current && !lifeSignal?.aborted && (!state || runtime.current === state && !state.abort.signal.aborted);
    setError(''); setPhase('requesting');
    try {
      state = await ready({recovering}); if (!state || !current()) return;
      state.stopPlayback();
      state.mic = new StreamingMicrophone({ context: state.player.context, onSamples: samples => {
        if (!current()) return;
        if (!state.mic.echoCancellation && state.player.sources.size) return;
        try { state.engine.push(samples); } catch (e) { if (current()) { setError(e.message); void stop({ interrupted: true }); } }
      }, onError: e => { if (current()) { setError(e.message); void stop({ interrupted: true }); } } });
      await state.mic.start(); if (current()) { setPhase('listening'); if (!state.mic.echoCancellation) setError('回声消除未启用，朗读期间暂停采音'); }
    } catch (e) { if (current()) { setError(e.message); void stop({ interrupted: true }); } }
  };
  const recover = async () => {
    const signal = life.current.signal; setError('');
    const stopped = stop({ interrupted: true }), attempt = startEpoch.current;
    setPhase('recovering');
    try {
      await stopped; signal.throwIfAborted(); if (attempt !== startEpoch.current) return;
      const state = await ready({ recovering: true });
      if (attempt === startEpoch.current && runtime.current === state && !signal.aborted) setPhase('idle');
    } catch (error) { if (attempt === startEpoch.current && !signal.aborted) { setError(error.message); setPhase('interrupted'); } }
  };
  const command = async (action, payload = {}) => {
    const signal = life.current.signal; setError('');
    try {
      if (action === 'send') await sendText(payload.text, (action, value) => call(sessionId, action, value, signal), signal, { fresh: payload.fresh === true });
      else await call(sessionId, action, payload, signal);
    }
    catch (e) { if (!signal.aborted) setError(e.message); }
  };
  const configure = async (persist = false, remove = false) => {
    if (settingsBusy.current) return;
    settingsBusy.current = true; setBusy(true);
    const signal = life.current.signal; setError('');
    try {
      await stop(); await call(sessionId, remove ? 'delete-bailian-key' : 'configure-bailian', remove ? {} : { apiKey, region, persist }, signal);
      const value = await call(sessionId, 'status', {}, signal); if (!signal.aborted) { setStatus(value); setApiKey(''); }
    } catch (e) { if (!signal.aborted) setError(e.message); }
    finally { if (!signal.aborted) { settingsBusy.current = false; setBusy(false); } }
  };
  const checkVad = async () => {
    const signal = life.current.signal; setError(''); setVadStatus('检查中'); let detector;
    try {
      const resources = await loadVadResources((action, payload = {}) => call(sessionId, action, payload, signal), { signal });
      detector = await SileroVad.create({ ...resources, signal });
      await detector.push(new Int16Array(512));
      if (!signal.aborted) setVadStatus('人声检测就绪');
    } catch (error) { if (!signal.aborted) { setVadStatus('不可用'); setError(error.message); } }
    finally { await detector?.dispose(); }
  };
  const configured=async(_value,{close=false}={})=>{
    const signal=life.current.signal;
    const value=await call(sessionId,'status',{},signal);
    if(!signal.aborted){setStatus(value);setRegion(value.region??'beijing');setError('');if(close)setSettingsOpen(false);}
  };
  const button = (label, onClick, disabled = false, props={}) => h('button', { type: 'button', onClick, disabled, ...props }, label);
  const active=phase==='listening'||phase==='requesting',title=voiceMode==='conversation'?'对话':'听写';
  return ReactDOM.createPortal(h('div', { className: 'ys-plugin', ref: anchor }, button(active ? '语音 · 聆听中' : '语音', () => setOpen(!open), !sessionId, {'aria-label':'语音', 'aria-pressed':active}), open && h(Panel, { anchor, label: '云舒语音', onClose: () => setOpen(false) },
    h('div', { className: 'ys-row' }, h('h3', null, '云舒语音'), button('设置',()=>setSettingsOpen(value=>!value),active),button('收起面板', () => setOpen(false))),
    h('div',{className:'ys-row',role:'group','aria-label':'语音模式'},button('对话',()=>{setVoiceMode('conversation');},active,{'aria-pressed':voiceMode==='conversation'}),button('听写',()=>{setVoiceMode('dictation');},active,{'aria-pressed':voiceMode==='dictation'})),
    h('div',{className:'ys-row'},button(active?(phase==='requesting'?'停止启动':'关闭语音'):'开始'+title,()=>active?void stop():void start({recovering:phase==='interrupted'}),locked||(!active&&!status?.available),{className:'ys-primary'}),button('停止朗读',()=>{ttsControl.current?.stop();runtime.current?.stopPlayback();})),
    h('small',{'aria-label':'语音状态'},phase==='listening'?'正在聆听':phase==='requesting'?'正在准备麦克风':phase==='interrupted'?'连接已中断，可重新开始':status?.available?'已就绪':'请先填写 API Key'),
    voiceMode==='conversation'&&h('small',null,'语音识别 → DeepSeek → 回复朗读'),
    reply && h('p', {'aria-label':'聊天回复',style:{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}, reply),
    error && h('div', { className: 'ys-error', role: 'alert' }, error),
    settingsOpen&&h(TtsPanel,{sessionId,call,control:ttsControl,beforeStart:()=>stop(),onConfigured:configured,onServiceChange:setServiceMode}),
    settingsOpen&&serviceMode!=='bailian'&&h('details',null,h('summary',null,'百炼识别设置'),
      h('label',null,'地域',h('select',{'aria-label':'识别地域',value:region,onChange:e=>setRegion(e.target.value)},h('option',{value:'beijing'},'北京'),h('option',{value:'singapore'},'新加坡'))),
      h('input',{type:'password',autoComplete:'off','aria-label':'识别 API Key',placeholder:'识别 API Key',value:apiKey,onChange:e=>setApiKey(e.target.value)}),
      button('保存识别设置',()=>void configure(true),busy||!apiKey.trim()||!status?.keyStorage?.canSave)),
    (voiceMode==='dictation'||draft||uncertain)&&h(React.Fragment,null,
      h('textarea', { 'aria-label': '识别结果', value: draft, maxLength: 12000, placeholder: '识别文本', onChange: e => { setDraft(e.target.value); if (submission.current?.text !== e.target.value) setUncertain(false); } }),
      uncertain ? button('核对后重新发送', () => { if (confirm('会话中没有这条消息，重新发送？')) void command('send', { text: draft, fresh: true }); }, sending || !draft.trim() || locked)
        :button('发送文字',()=>void command('send',{text:draft}),sending||!draft.trim()||locked)),
    h('details',null,h('summary',null,'诊断'),h('small',{'aria-label':'检测状态'},vadStatus),button('检查人声检测',()=>void checkVad(),!!runtime.current||vadStatus==='检查中'))
  )), target);
}
