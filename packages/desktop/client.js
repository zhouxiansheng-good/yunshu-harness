(() => {
  if(window.__yunshuControlUI)return;
  const listeners=new Set();
  let snapshot={preferences:null,labels:{},extensions:[],busy:false,error:''}, endpoint=null,revision=0,refreshing=false;
  function emit(change){snapshot={...snapshot,...change};for(const notify of listeners)notify();}
  async function invoke(action,payload) {
    const target=endpoint;
    if(!target || snapshot.busy)return;
    ++revision;
    emit({busy:true,error:''});
    try {
      const result=await target(action,payload);
      if(target===endpoint)emit({...result,busy:false});
    } catch(e) {if(target===endpoint)emit({busy:false,error:e.message||'无法读取功能设置。'});}
  }
  window.__yunshuControlUI={
    snapshot:()=>snapshot,subscribe:fn=>{listeners.add(fn);return ()=>listeners.delete(fn);},
    connect(fn){endpoint=fn;void invoke('read',{});return ()=>{if(endpoint===fn){endpoint=null;emit({preferences:null,busy:false});}};},
    update:(key,value)=>invoke('write',{key,value}),read:()=>invoke('read',{}),
    async refresh(){
      const target=endpoint,seen=revision;
      if(!target||snapshot.busy||refreshing)return;
      refreshing=true;
      try{const result=await target('read',{});
        if(target===endpoint&&seen===revision)emit({...result,error:''});
      }catch(e){if(target===endpoint&&seen===revision)emit({error:e.message||'无法读取功能设置。'});}
      finally{refreshing=false;}
    },
  };
})();

window.__ModuleLoader__.load({id:"@yunshu/dsh-desktop/file-receipts",factory:require=>{
  const h = require("react").createElement;
  const muted = {color:"var(--color-text-secondary,inherit)",fontSize:"0.85em"};
  const button = {background:"transparent",color:"var(--color-text-link,inherit)",border:"0",padding:"2px 0",cursor:"pointer",textDecoration:"underline",textUnderlineOffset:"3px",font:"inherit",overflowWrap:"anywhere",textAlign:"start"};
  function source(label,s) {
    return h("div",{key:label,style:{marginTop:"4px",overflowWrap:"anywhere"}},h("strong",null,label+"　"),s.path,
      s.domainId ? " · "+s.domainId : "", " · "+s.subjectId+" · "+s.sourceId+" / "+s.revisionId,
      s.recordedAt ? " · 记录时间 "+s.recordedAt : "", s.effectiveAt ? " · 生效时间 "+s.effectiveAt : "");
  }
  function Receipt({turn,useProjection,openFile}) {
    const entry = useProjection("yunshuFileReceipts")?.turns?.[String(turn.turn)];
    if (!entry?.end || !entry.files.length) return null;
    const contents = entry.files.filter(f=>!f.linked || f.basis);
    if (!contents.length) return null;
    return h("div",{style:{display:"grid",gap:"6px",margin:"6px 0 4px"}},
      contents.map(f=>h("div",{key:f.key,"data-yunshu-file-receipt":f.relative,style:{borderInlineStart:"2px solid var(--color-border,rgba(128,128,128,.45))",paddingInlineStart:"10px"}},
        !f.linked && h("div",null,h("span",{style:muted},(entry.end==="interrupted"?"回复中断，":"")+
          (f.verification==="read-after-edit"?"编辑后曾读回文件　":"文件已写入并读回　")),
          h("button",{type:"button",style:button,"data-yunshu-open-file":f.relative,onClick:()=>openFile(f.relative),"aria-label":"打开文件 "+f.relative},f.relative)),
        f.basis && h("details",{"data-yunshu-basis":f.relative,style:muted},
          h("summary",{style:{cursor:"pointer"}},f.linked ? f.relative+" 的文件依据" : "查看文件依据"),
          source("本次引用",f.basis),f.previous && source("上次引用",f.previous))
      )));
  }
  return {inject:["slots"],apply(ctx){ctx.slots.inject("conversation.chat.turnTail",()=>ctx.slots.register({
    name:"conversation.chat.turnTail",id:"@yunshu/dsh-desktop/file-receipts"
  },Receipt));}};
}});

(function(){
const HEALTH_CHECKS = {
  memory: { label: '记忆', nextAction: '打开记忆，验证跨会话召回与更正' },
  persona: { label: '人格', nextAction: '打开人格，验证档案保存与情绪线索' },
  media: { label: '媒体', nextAction: '打开媒体，检查附件保存与读取' },
  task: { label: '任务台', nextAction: '核对原派单与回执再继续' },
  voice: { label: '语音', nextAction: '打开语音，试听并检查麦克风设备' },
  deep: { label: '深度模式', nextAction: '核对切换前后的实际能力', visibleInDock: false },
};
const HEALTH_TTL_MS = 300_000;
const CHECK_IDS = Object.keys(HEALTH_CHECKS);
const NEXT_ACTION = Object.fromEntries(Object.entries(HEALTH_CHECKS).map(([id, entry]) => [id, entry.nextAction]));
const STATES = new Set(['ok', 'warn', 'late', 'unknown', 'idle']);
function countHealth(checks) {
  const counts = Object.fromEntries([...STATES].map(state => [state, 0]));
  for (const row of checks) counts[STATES.has(row.state) ? row.state : 'unknown']++;
  return counts;
}
function healthRows(snapshot, expectedProfileId, now = Date.now()) {
  let invalid = null;
  if (!snapshot) invalid = '尚无健康快照';
  else if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.checks) ||
    typeof snapshot.profileId !== 'string' || !snapshot.profileId) invalid = '健康快照格式无效';
  else if (!expectedProfileId || snapshot.profileId !== expectedProfileId) invalid = '健康快照与当前 profile 不符';
  const checks = invalid ? [] : snapshot.checks;
  return CHECK_IDS.map(id => {
    const matches = checks.filter(row => row?.id === id);
    const row = matches[0];
    let reason = invalid || (matches.length !== 1 ? '本项尚无唯一健康结果' : null);
    let state = 'unknown';
    if (!reason) {
      const at = Date.parse(row.checkedAt), ttl = Number(row.staleAfterMs);
      if (!STATES.has(row.state) || typeof row.reason !== 'string' || !Number.isFinite(at) ||
          !Number.isFinite(ttl) || ttl <= 0 || at > now + 5000) reason = '健康结果格式或时间无效';
      else if (now - at > ttl) { state = 'late'; reason = '健康结果已过期；' + row.reason; }
      else { state = row.state; reason = row.reason; }
    }
    const disabled = state === 'idle' && row?.facets?.availability === 'disabled';
    return { id, label: HEALTH_CHECKS[id].label, visibleInDock: HEALTH_CHECKS[id].visibleInDock !== false,
      state, reason, checkedAt: row?.checkedAt ?? null,
      staleAfterMs: row?.staleAfterMs ?? null, facets: invalid ? {} : row?.facets ?? {},
      evidence: invalid ? '' : row?.evidence ?? '',
      nextAction: disabled ? '需要保存附件时，可在当前配置启用媒体功能' : NEXT_ACTION[id] };
  });
}


function createHealthClient({ now = Date.now, every = setInterval, stopEvery = clearInterval,
  later = setTimeout, stopLater = clearTimeout, notify = () => {},
  visibilityTarget = typeof document === 'undefined' ? null : document,
  focusTarget = typeof window === 'undefined' ? null : window } = {}) {
  const listeners = new Set();
  let latest = null, profileId = null, sessionId = null, transport = null, token = 0;
  let controller = null, timer = null, deadline = null, disposed = false, error = null;
  // Small in-memory diagnostics distinguish a suspended renderer timer from a
  // stalled transport. No messages, credentials or archive contents are logged.
  const diag = { trigger: null, attempts: 0, successes: 0, ticks: 0, skipped: 0,
    lastTickAt: null, lastAttemptAt: null, lastSuccessAt: null };
  const isoNow = () => new Date(now()).toISOString();
  const rows = () => healthRows(latest, profileId, now()).map(row => error ? { ...row, state: 'unknown', reason: error } : row);
  const publish = () => { for (const fn of [...listeners]) { try { fn(rows()); } catch {} } notify(); };
  const cancel = () => { token++; controller?.abort(); controller = null; if (deadline !== null) stopLater(deadline); deadline = null; };
  async function refresh({ force = true, trigger = 'manual' } = {}) {
    if (disposed || controller || !transport || !sessionId) { diag.skipped++; publish(); return; }
    const epoch = token, call = transport, session = sessionId;
    const abort = new AbortController(); controller = abort;
    diag.trigger = trigger; diag.attempts++; diag.lastAttemptAt = isoNow();
    deadline = later(() => { abort.abort(new Error('健康状态读取超时')); }, 5000);
    try {
      const value = await Promise.race([
        call(session, 'health-read', { force: force === true }, abort.signal),
        new Promise((_, reject) => abort.signal.addEventListener('abort', () => reject(abort.signal.reason), { once: true })),
      ]);
      if (disposed || epoch !== token) return;
      if (!profileId && value?.schemaVersion === 1 && typeof value.profileId === 'string' && value.profileId) profileId = value.profileId;
      latest = value; error = null; diag.successes++; diag.lastSuccessAt = isoNow();
    } catch (failure) {
      if (disposed || epoch !== token) return;
      latest = null; error = '健康状态读取失败：' + (failure?.message || String(failure));
    } finally {
      if (epoch === token) { controller = null; if (deadline !== null) stopLater(deadline); deadline = null; publish(); }
    }
  }
  const onForeground = () => {
    if (disposed || visibilityTarget?.visibilityState === 'hidden') return;
    // Browser intervals can be throttled while hidden. Catch up on visibility
    // and focus without claiming that hidden-window 30-second timing is fixed.
    void refresh({ force: true, trigger: 'foreground' });
  };
  visibilityTarget?.addEventListener?.('visibilitychange', onForeground);
  focusTarget?.addEventListener?.('focus', onForeground);
  return {
    get: id => rows().find(row => row.id === id),
    snapshot: rows,
    diagnostics: () => ({ ...diag, timerActive: timer !== null, connected: !!transport,
      sessionBound: !!sessionId, inFlight: !!controller, disposed }),
    describe(id) { const row = rows().find(row => row.id === id); return row ? row.reason + '；下一步：' + row.nextAction : '健康项目未注册'; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    connect(call) {
      cancel(); latest = null; profileId = null; error = null; transport = call;
      void refresh({ force: true, trigger: 'connect' });
      if (timer === null) timer = every(() => {
        diag.ticks++; diag.lastTickAt = isoNow();
        // Avoid a 30s client timer aliasing a 30s host cache after transport delay.
        void refresh({ force: true, trigger: 'periodic' });
      }, 30000);
      return () => {
        if (transport !== call) return;
        cancel(); transport = null; latest = null; profileId = null; error = '健康服务已断开';
        if (timer !== null) stopEvery(timer); timer = null; publish();
      };
    },
    bindSession(id) {
      if (sessionId !== id) { cancel(); sessionId = id || null; latest = null; error = null;
        void refresh({ force: true, trigger: 'session-change' }); publish(); }
      return () => { if (sessionId === id) { cancel(); sessionId = null; latest = null; publish(); } };
    },
    refresh,
    dispose() { disposed = true; cancel(); if (timer !== null) stopEvery(timer); timer = null;
      visibilityTarget?.removeEventListener?.('visibilitychange', onForeground);
      focusTarget?.removeEventListener?.('focus', onForeground);
      listeners.clear(); transport = null; latest = null; },
  };
}

window.__yunshuHealth?.dispose?.();
window.__yunshuHealth = createHealthClient();
window.dispatchEvent(new Event("yunshu-health-ready"));
})();
// 云舒抽屉 · client 半边
//
// 输入框左侧只留「云舒」一个入口。点开是一个向上生长的抽屉，按
// 01 状态 / 02 面板 / 03 模式 / 04 更多 分组，一级只看摘要，点进去看二级。
//
// 其他插件不再各挂一个按钮，改为向 window.__yunshuDock 注册条目：
//
//   window.__yunshuDock?.register({
//     group: 'panel',            // status | panel | mode | more
//     id: 'united-board',
//     label: '打开任务台',
//     status: () => 'unknown',   // ok | warn | late | unknown | idle
//     describe: () => '0 待修',
//     run: () => openBoard(),
//   })
//
// 注册表必须在浏览器里：条目里的 status/describe/run 是函数，过不了进程边界。

// 注册 id 必须是**包名**（2026-11-12 二次修正）
//
// client-modules 给 browser module 建的键是包名：
//   package name → graphRow(packageName) → factories.set(id, ...)
// 它按行 id（= '@yunshu/dsh-dock'）去 factories 里找工厂，找不到就报
//   could not load "@yunshu/dsh-dock": ... loaded without registering ...
// 而这条错误被 cordis 的 Entry._init 的 catch 吞掉（只写 logger），
// entry.fiber 保持 undefined → web boot 收尾报
//   web boot: 1 entry did not activate
//   @yunshu/dsh-dock: import failed (see console for the import error)
//
// 之前用短名 'yunshu-dock' 注册，于是永远查不到；arrive() 还会回退到单资源 URL
// 把同一个 bundle 再执行一次。第一次没有守卫时第二次 register() 抛
//   duplicate factory registration for "yunshu-dock"
// （20:47 三次崩溃）；加了 window 级粘性守卫后又变成"静默不注册"（21:20 崩溃）。
//
// 正确做法：id 用包名；重复注册（HMR 重载 / 回退二跑）只吞 duplicate，别用
// 粘性标志挡住重注册，否则 invalidate 之后永远装不回来。
if (typeof window !== 'undefined' && window.__ModuleLoader__) {
  try {
  window.__ModuleLoader__.load({
    id: '@yunshu/dsh-dock',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement
// One owned root, no observer or global page mutation. React owns disposal.
function mountQuiet(root, css) {
  if (!root) return () => {};
  const previous = root.getAttribute('data-yunshu-theme');
  const style = root.ownerDocument.createElement('style');
  style.dataset.yunshuQuietSource = '1';
  style.textContent = css;
  root.prepend(style);
  root.setAttribute('data-yunshu-theme', 'quiet');
  const document = root.ownerDocument;
  const visibility = () => root.setAttribute('data-quiet-hidden', String(document.hidden));
  document.addEventListener('visibilitychange', visibility);
  visibility();
  return () => {
    document.removeEventListener('visibilitychange', visibility);
    style.remove();
    root.removeAttribute('data-quiet-hidden');
    if (previous === null) root.removeAttribute('data-yunshu-theme');
    else root.setAttribute('data-yunshu-theme', previous);
  };
}

let cachedDockMotion
function dockMotionLibrary(){
  if (cachedDockMotion) return cachedDockMotion
  const host = globalThis.window
  const window = { document: host.document, matchMedia: host.matchMedia.bind(host), getComputedStyle: host.getComputedStyle.bind(host), GreenSockGlobals: {} }
  const exports = {}, module = { exports }
/*!
 * GSAP 3.15.0
 * https://gsap.com
 * 
 * @license Copyright 2026, GreenSock. All rights reserved.
 * Subject to the terms at https://gsap.com/standard-license.
 * @author: Jack Doyle, jack@greensock.com
 */

!function(t,e){"object"==typeof exports&&"undefined"!=typeof module?e(exports):"function"==typeof define&&define.amd?define(["exports"],e):e((t=t||self).window=t.window||{})}(this,function(e){"use strict";function _inheritsLoose(t,e){t.prototype=Object.create(e.prototype),(t.prototype.constructor=t).__proto__=e}function _assertThisInitialized(t){if(void 0===t)throw new ReferenceError("this hasn't been initialised - super() hasn't been called");return t}function r(t){return"string"==typeof t}function s(t){return"function"==typeof t}function t(t){return"number"==typeof t}function u(t){return void 0===t}function v(t){return"object"==typeof t}function w(t){return!1!==t}function x(){return"undefined"!=typeof window}function y(t){return s(t)||r(t)}function R(t){return(i=bt(t,ht))&&Fe}function S(t,e){return console.warn("Invalid property",t,"set to",e,"Missing plugin? gsap.registerPlugin()")}function T(t,e){return!e&&console.warn(t)}function U(t,e){return t&&(ht[t]=e)&&i&&(i[t]=e)||ht}function V(){return 0}function ga(t){var e,r,i=t[0];if(v(i)||s(i)||(t=[t]),!(e=(i._gsap||{}).harness)){for(r=yt.length;r--&&!yt[r].targetTest(i););e=yt[r]}for(r=t.length;r--;)t[r]&&(t[r]._gsap||(t[r]._gsap=new Xt(t[r],e)))||t.splice(r,1);return t}function ha(t){return t._gsap||ga(Pt(t))[0]._gsap}function ia(t,e,r){return(r=t[e])&&s(r)?t[e]():u(r)&&t.getAttribute&&t.getAttribute(e)||r}function ja(t,e){return(t=t.split(",")).forEach(e)||t}function ka(t){return Math.round(1e5*t)/1e5||0}function la(t){return Math.round(1e7*t)/1e7||0}function ma(t,e){var r=e.charAt(0),i=parseFloat(e.substr(2));return t=parseFloat(t),"+"===r?t+i:"-"===r?t-i:"*"===r?t*i:t/i}function na(t,e){for(var r=e.length,i=0;t.indexOf(e[i])<0&&++i<r;);return i<r}function oa(){var t,e,r=pt.length,i=pt.slice(0);for(_t={},t=pt.length=0;t<r;t++)(e=i[t])&&e._lazy&&(e.render(e._lazy[0],e._lazy[1],!0)._lazy=0)}function pa(t){return!!(t._initted||t._startAt||t.add)}function qa(t,e,r,i){pt.length&&!I&&oa(),t.render(e,r,i||!!(I&&e<0&&pa(t))),pt.length&&!I&&oa()}function ra(t){var e=parseFloat(t);return(e||0===e)&&(t+"").match(ot).length<2?e:r(t)?t.trim():t}function sa(t){return t}function ta(t,e){for(var r in e)r in t||(t[r]=e[r]);return t}function wa(t,e){for(var r in e)"__proto__"!==r&&"constructor"!==r&&"prototype"!==r&&(t[r]=v(e[r])?wa(t[r]||(t[r]={}),e[r]):e[r]);return t}function xa(t,e){var r,i={};for(r in t)r in e||(i[r]=t[r]);return i}function ya(t){var e=t.parent||L,r=t.keyframes?function _setKeyframeDefaults(i){return function(t,e){for(var r in e)r in t||"duration"===r&&i||"ease"===r||(t[r]=e[r])}}(K(t.keyframes)):ta;if(w(t.inherit))for(;e;)r(t,e.vars.defaults),e=e.parent||e._dp;return t}function Aa(t,e,r,i,n){void 0===r&&(r="_first"),void 0===i&&(i="_last");var a,s=t[i];if(n)for(a=e[n];s&&s[n]>a;)s=s._prev;return s?(e._next=s._next,s._next=e):(e._next=t[r],t[r]=e),e._next?e._next._prev=e:t[i]=e,e._prev=s,e.parent=e._dp=t,e}function Ba(t,e,r,i){void 0===r&&(r="_first"),void 0===i&&(i="_last");var n=e._prev,a=e._next;n?n._next=a:t[r]===e&&(t[r]=a),a?a._prev=n:t[i]===e&&(t[i]=n),e._next=e._prev=e.parent=null}function Ca(t,e){t.parent&&(!e||t.parent.autoRemoveChildren)&&t.parent.remove&&t.parent.remove(t),t._act=0}function Da(t,e){if(t&&(!e||e._end>t._dur||e._start<0))for(var r=t;r;)r._dirty=1,r=r.parent;return t}function Fa(t,e,r,i){return t._startAt&&(I?t._startAt.revert(ft):t.vars.immediateRender&&!t.vars.autoRevert||t._startAt.render(e,!0,i))}function Ha(t){return t._repeat?wt(t._tTime,t=t.duration()+t._rDelay)*t:0}function Ja(t,e){return(t-e._start)*e._ts+(0<=e._ts?0:e._dirty?e.totalDuration():e._tDur)}function Ka(t){return t._end=la(t._start+(t._tDur/Math.abs(t._ts||t._rts||q)||0))}function La(t,e){var r=t._dp;return r&&r.smoothChildTiming&&t._ts&&(t._start=la(r._time-(0<t._ts?e/t._ts:((t._dirty?t.totalDuration():t._tDur)-e)/-t._ts)),Ka(t),r._dirty||Da(r,t)),t}function Ma(t,e){var r;if((e._time||!e._dur&&e._initted||e._start<t._time&&(e._dur||!e.add))&&(r=Ja(t.rawTime(),e),(!e._dur||Mt(0,e.totalDuration(),r)-e._tTime>q)&&e.render(r,!0)),Da(t,e)._dp&&t._initted&&t._time>=t._dur&&t._ts){if(t._dur<t.duration())for(r=t;r._dp;)0<=r.rawTime()&&r.totalTime(r._tTime),r=r._dp;t._zTime=-q}}function Na(e,r,i,n){return r.parent&&Ca(r),r._start=la((t(i)?i:i||e!==L?Ot(e,i,r):e._time)+r._delay),r._end=la(r._start+(r.totalDuration()/Math.abs(r.timeScale())||0)),Aa(e,r,"_first","_last",e._sort?"_start":0),xt(r)||(e._recent=r),n||Ma(e,r),e._ts<0&&La(e,e._tTime),e}function Oa(t,e){return(ht.ScrollTrigger||S("scrollTrigger",e))&&ht.ScrollTrigger.create(e,t)}function Pa(t,e,r,i,n){return Ht(t,e,n),t._initted?!r&&t._pt&&!I&&(t._dur&&!1!==t.vars.lazy||!t._dur&&t.vars.lazy)&&f!==It.frame?(pt.push(t),t._lazy=[n,i],1):void 0:1}function Ua(t,e,r,i){var n=t._repeat,a=la(e)||0,s=t._tTime/t._tDur;return s&&!i&&(t._time*=a/t._dur),t._dur=a,t._tDur=n?n<0?1e10:la(a*(n+1)+t._rDelay*n):a,0<s&&!i&&La(t,t._tTime=t._tDur*s),t.parent&&Ka(t),r||Da(t.parent,t),t}function Va(t){return t instanceof Gt?Da(t):Ua(t,t._dur)}function Ya(e,r,i){var n,a,s=t(r[1]),o=(s?2:1)+(e<2?0:1),u=r[o];if(s&&(u.duration=r[1]),u.parent=i,e){for(n=u,a=i;a&&!("immediateRender"in n);)n=a.vars.defaults||{},a=w(a.vars.inherit)&&a.parent;u.immediateRender=w(n.immediateRender),e<2?u.runBackwards=1:u.startAt=r[o-1]}return new te(r[0],u,r[1+o])}function Za(t,e){return t||0===t?e(t):e}function _a(t,e){return r(t)&&(e=ut.exec(t))?e[1]:""}function cb(t,e){return t&&v(t)&&"length"in t&&(!e&&!t.length||t.length-1 in t&&v(t[0]))&&!t.nodeType&&t!==h}function fb(r){return r=Pt(r)[0]||T("Invalid scope")||{},function(t){var e=r.current||r.nativeElement||r;return Pt(t,e.querySelectorAll?e:e===r?T("Invalid scope")||a.createElement("div"):r)}}function gb(t){return t.sort(function(){return.5-Math.random()})}function hb(t){if(s(t))return t;var p=v(t)?t:{each:t},_=jt(p.ease),m=p.from||0,g=parseFloat(p.base)||0,y={},e=0<m&&m<1,T=isNaN(m)||e,b=p.axis,w=m,x=m;return r(m)?w=x={center:.5,edges:.5,end:1}[m]||0:!e&&T&&(w=m[0],x=m[1]),function(t,e,r){var i,n,a,s,o,u,h,l,f,c=(r||p).length,d=y[c];if(!d){if(!(f="auto"===p.grid?0:(p.grid||[1,X])[1])){for(h=-X;h<(h=r[f++].getBoundingClientRect().left)&&f<c;);f<c&&f--}for(d=y[c]=[],i=T?Math.min(f,c)*w-.5:m%f,n=f===X?0:T?c*x/f-.5:m/f|0,l=X,u=h=0;u<c;u++)a=u%f-i,s=n-(u/f|0),d[u]=o=b?Math.abs("y"===b?s:a):$(a*a+s*s),h<o&&(h=o),o<l&&(l=o);"random"===m&&gb(d),d.max=h-l,d.min=l,d.v=c=(parseFloat(p.amount)||parseFloat(p.each)*(c<f?c-1:b?"y"===b?c/f:f:Math.max(f,c/f))||0)*("edges"===m?-1:1),d.b=c<0?g-c:g,d.u=_a(p.amount||p.each)||0,_=_&&c<0?Yt(_):_}return c=(d[t]-d.min)/d.max||0,la(d.b+(_?_(c):c)*d.v)+d.u}}function ib(i){var n=Math.pow(10,((i+"").split(".")[1]||"").length);return function(e){var r=la(Math.round(parseFloat(e)/i)*i*n);return(r-r%1)/n+(t(e)?0:_a(e))}}function jb(h,e){var l,f,r=K(h);return!r&&v(h)&&(l=r=h.radius||X,h.values?(h=Pt(h.values),(f=!t(h[0]))&&(l*=l)):h=ib(h.increment)),Za(e,r?s(h)?function(t){return f=h(t),Math.abs(f-t)<=l?f:t}:function(e){for(var r,i,n=parseFloat(f?e.x:e),a=parseFloat(f?e.y:0),s=X,o=0,u=h.length;u--;)(r=f?(r=h[u].x-n)*r+(i=h[u].y-a)*i:Math.abs(h[u]-n))<s&&(s=r,o=u);return o=!l||s<=l?h[o]:e,f||o===e||t(e)?o:o+_a(e)}:ib(h))}function kb(t,e,r,i){return Za(K(t)?!e:!0===r?!!(r=0):!i,function(){return K(t)?t[~~(Math.random()*t.length)]:(r=r||1e-5)&&(i=r<1?Math.pow(10,(r+"").length-2):1)&&Math.floor(Math.round((t-r/2+Math.random()*(e-t+.99*r))/r)*r*i)/i})}function ob(e,r,t){return Za(t,function(t){return e[~~r(t)]})}function rb(t){return t.replace(tt,function(t){var e=t.indexOf("[")+1,r=t.substring(e||7,e?t.indexOf("]"):t.length-1).split(et);return kb(e?r:+r[0],e?0:+r[1],+r[2]||1e-5)})}function ub(t,e,r){var i,n,a,s=t.labels,o=X;for(i in s)(n=s[i]-e)<0==!!r&&n&&o>(n=Math.abs(n))&&(a=i,o=n);return a}function wb(t){return Ca(t),t.scrollTrigger&&t.scrollTrigger.kill(!!I),t.progress()<1&&At(t,"onInterrupt"),t}function zb(t){if(t)if(t=!t.name&&t.default||t,x()||t.headless){var e=t.name,r=s(t),i=e&&!r&&t.init?function(){this._props=[]}:t,n={init:V,render:_e,add:$t,kill:Te,modifier:ve,rawVars:0},a={targetTest:0,get:0,getSetter:ue,aliases:{},register:0};if(Lt(),t!==i){if(mt[e])return;ta(i,ta(xa(t,n),a)),bt(i.prototype,bt(n,xa(t,a))),mt[i.prop=e]=i,t.targetTest&&(yt.push(i),dt[e]=1),e=("css"===e?"CSS":e.charAt(0).toUpperCase()+e.substr(1))+"Plugin"}U(e,i),t.register&&t.register(Fe,i,we)}else Dt.push(t)}function Cb(t,e,r){return(6*(t+=t<0?1:1<t?-1:0)<1?e+(r-e)*t*6:t<.5?r:3*t<2?e+(r-e)*(2/3-t)*6:e)*zt+.5|0}function Db(e,r,i){var n,a,s,o,u,h,l,f,c,d,p=e?t(e)?[e>>16,e>>8&zt,e&zt]:0:Rt.black;if(!p){if(","===e.substr(-1)&&(e=e.substr(0,e.length-1)),Rt[e])p=Rt[e];else if("#"===e.charAt(0)){if(e.length<6&&(e="#"+(n=e.charAt(1))+n+(a=e.charAt(2))+a+(s=e.charAt(3))+s+(5===e.length?e.charAt(4)+e.charAt(4):"")),9===e.length)return[(p=parseInt(e.substr(1,6),16))>>16,p>>8&zt,p&zt,parseInt(e.substr(7),16)/255];p=[(e=parseInt(e.substr(1),16))>>16,e>>8&zt,e&zt]}else if("hsl"===e.substr(0,3))if(p=d=e.match(rt),r){if(~e.indexOf("="))return p=e.match(it),i&&p.length<4&&(p[3]=1),p}else o=+p[0]%360/360,u=p[1]/100,n=2*(h=p[2]/100)-(a=h<=.5?h*(u+1):h+u-h*u),3<p.length&&(p[3]*=1),p[0]=Cb(o+1/3,n,a),p[1]=Cb(o,n,a),p[2]=Cb(o-1/3,n,a);else p=e.match(rt)||Rt.transparent;p=p.map(Number)}return r&&!d&&(n=p[0]/zt,a=p[1]/zt,s=p[2]/zt,h=((l=Math.max(n,a,s))+(f=Math.min(n,a,s)))/2,l===f?o=u=0:(c=l-f,u=.5<h?c/(2-l-f):c/(l+f),o=l===n?(a-s)/c+(a<s?6:0):l===a?(s-n)/c+2:(n-a)/c+4,o*=60),p[0]=~~(o+.5),p[1]=~~(100*u+.5),p[2]=~~(100*h+.5)),i&&p.length<4&&(p[3]=1),p}function Eb(t){var r=[],i=[],n=-1;return t.split(Et).forEach(function(t){var e=t.match(nt)||[];r.push.apply(r,e),i.push(n+=e.length+1)}),r.c=i,r}function Fb(t,e,r){var i,n,a,s,o="",u=(t+o).match(Et),h=e?"hsla(":"rgba(",l=0;if(!u)return t;if(u=u.map(function(t){return(t=Db(t,e,1))&&h+(e?t[0]+","+t[1]+"%,"+t[2]+"%,"+t[3]:t.join(","))+")"}),r&&(a=Eb(t),(i=r.c).join(o)!==a.c.join(o)))for(s=(n=t.replace(Et,"1").split(nt)).length-1;l<s;l++)o+=n[l]+(~i.indexOf(l)?u.shift()||h+"0,0,0,0)":(a.length?a:u.length?u:r).shift());if(!n)for(s=(n=t.split(Et)).length-1;l<s;l++)o+=n[l]+u[l];return o+n[s]}function Ib(t){var e,r=t.join(" ");if(Et.lastIndex=0,Et.test(r))return e=Ft.test(r),t[1]=Fb(t[1],e),t[0]=Fb(t[0],e,Eb(t[1])),!0}function Rb(t){var e=(t+"").split("("),r=Bt[e[0]];return r&&1<e.length&&r.config?r.config.apply(null,~t.indexOf("{")?[function _parseObjectInString(t){for(var e,r,i,n={},a=t.substr(1,t.length-3).split(":"),s=a[0],o=1,u=a.length;o<u;o++)r=a[o],e=o!==u-1?r.lastIndexOf(","):r.length,i=r.substr(0,e),n[s]=isNaN(i)?i.replace(Ut,"").trim():+i,s=r.substr(e+1).trim();return n}(e[1])]:function _valueInParentheses(t){var e=t.indexOf("(")+1,r=t.indexOf(")"),i=t.indexOf("(",e);return t.substring(e,~i&&i<r?t.indexOf(")",r+1):r)}(t).split(",").map(ra)):Bt._CE&&Nt.test(t)?Bt._CE("",t):r}function Ub(t,e,r,i){void 0===r&&(r=function easeOut(t){return 1-e(1-t)}),void 0===i&&(i=function easeInOut(t){return t<.5?e(2*t)/2:1-e(2*(1-t))/2});var n,a={easeIn:e,easeOut:r,easeInOut:i};return ja(t,function(t){for(var e in Bt[t]=ht[t]=a,Bt[n=t.toLowerCase()]=r,a)Bt[n+("easeIn"===e?".in":"easeOut"===e?".out":".inOut")]=Bt[t+"."+e]=a[e]}),a}function Vb(e){return function(t){return t<.5?(1-e(1-2*t))/2:.5+e(2*(t-.5))/2}}function Wb(r,t,e){function Gm(t){return 1===t?1:i*Math.pow(2,-10*t)*Q((t-a)*n)+1}var i=1<=t?t:1,n=(e||(r?.3:.45))/(t<1?t:1),a=n/G*(Math.asin(1/i)||0),s="out"===r?Gm:"in"===r?function(t){return 1-Gm(1-t)}:Vb(Gm);return n=G/n,s.config=function(t,e){return Wb(r,t,e)},s}function Xb(e,r){function Om(t){return t?--t*t*((r+1)*t+r)+1:0}void 0===r&&(r=1.70158);var t="out"===e?Om:"in"===e?function(t){return 1-Om(1-t)}:Vb(Om);return t.config=function(t){return Xb(e,t)},t}var F,I,l,L,h,n,a,i,o,f,c,d,p,_,m,g,b,k,O,M,C,P,A,D,z,E,B,N,Y={autoSleep:120,force3D:"auto",nullTargetWarn:1,units:{lineHeight:""}},j={duration:.5,overwrite:!1,delay:0},X=1e8,q=1/X,G=2*Math.PI,Z=G/4,W=0,$=Math.sqrt,H=Math.cos,Q=Math.sin,J="function"==typeof ArrayBuffer&&ArrayBuffer.isView||function(){},K=Array.isArray,tt=/random\([^)]+\)/g,et=/,\s*/g,rt=/(?:-?\.?\d|\.)+/gi,it=/[-+=.]*\d+[.e\-+]*\d*[e\-+]*\d*/g,nt=/[-+=.]*\d+[.e-]*\d*[a-z%]*/g,at=/[-+=.]*\d+\.?\d*(?:e-|e\+)?\d*/gi,st=/[+-]=-?[.\d]+/,ot=/[^,'"\[\]\s]+/gi,ut=/^[+\-=e\s\d]*\d+[.\d]*([a-z]*|%)\s*$/i,ht={},lt={suppressEvents:!0,isStart:!0,kill:!1},ft={suppressEvents:!0,kill:!1},ct={suppressEvents:!0},dt={},pt=[],_t={},mt={},gt={},vt=30,yt=[],Tt="",bt=function _merge(t,e){for(var r in e)t[r]=e[r];return t},wt=function _animationCycle(t,e){var r=Math.floor(t=la(t/e));return t&&r===t?r-1:r},xt=function _isFromOrFromStart(t){var e=t.data;return"isFromStart"===e||"isStart"===e},kt={_start:0,endTime:V,totalDuration:V},Ot=function _parsePosition(t,e,i){var n,a,s,o=t.labels,u=t._recent||kt,h=t.duration()>=X?u.endTime(!1):t._dur;return r(e)&&(isNaN(e)||e in o)?(a=e.charAt(0),s="%"===e.substr(-1),n=e.indexOf("="),"<"===a||">"===a?(0<=n&&(e=e.replace(/=/,"")),("<"===a?u._start:u.endTime(0<=u._repeat))+(parseFloat(e.substr(1))||0)*(s?(n<0?u:i).totalDuration()/100:1)):n<0?(e in o||(o[e]=h),o[e]):(a=parseFloat(e.charAt(n-1)+e.substr(n+1)),s&&i&&(a=a/100*(K(i)?i[0]:i).totalDuration()),1<n?_parsePosition(t,e.substr(0,n-1),i)+a:h+a)):null==e?h:+e},Mt=function _clamp(t,e,r){return r<t?t:e<r?e:r},Ct=[].slice,Pt=function toArray(t,e,i){return l&&!e&&l.selector?l.selector(t):!r(t)||i||!n&&Lt()?K(t)?function _flatten(t,e,i){return void 0===i&&(i=[]),t.forEach(function(t){return r(t)&&!e||cb(t,1)?i.push.apply(i,Pt(t)):i.push(t)})||i}(t,i):cb(t)?Ct.call(t,0):t?[t]:[]:Ct.call((e||a).querySelectorAll(t),0)},St=function mapRange(e,t,r,i,n){var a=t-e,s=i-r;return Za(n,function(t){return r+((t-e)/a*s||0)})},At=function _callback(t,e,r){var i,n,a,s=t.vars,o=s[e],u=l,h=t._ctx;if(o)return i=s[e+"Params"],n=s.callbackScope||t,r&&pt.length&&oa(),h&&(l=h),a=i?o.apply(n,i):o.call(n),l=u,a},Dt=[],zt=255,Rt={aqua:[0,zt,zt],lime:[0,zt,0],silver:[192,192,192],black:[0,0,0],maroon:[128,0,0],teal:[0,128,128],blue:[0,0,zt],navy:[0,0,128],white:[zt,zt,zt],olive:[128,128,0],yellow:[zt,zt,0],orange:[zt,165,0],gray:[128,128,128],purple:[128,0,128],green:[0,128,0],red:[zt,0,0],pink:[zt,192,203],cyan:[0,zt,zt],transparent:[zt,zt,zt,0]},Et=function(){var t,e="(?:\\b(?:(?:rgb|rgba|hsl|hsla)\\(.+?\\))|\\B#(?:[0-9a-f]{3,4}){1,2}\\b";for(t in Rt)e+="|"+t+"\\b";return new RegExp(e+")","gi")}(),Ft=/hsl[a]?\(/,It=(O=Date.now,M=500,C=33,P=O(),A=P,z=D=1e3/240,g={time:0,frame:0,tick:function tick(){zl(!0)},deltaRatio:function deltaRatio(t){return b/(1e3/(t||60))},wake:function wake(){o&&(!n&&x()&&(h=n=window,a=h.document||{},ht.gsap=Fe,(h.gsapVersions||(h.gsapVersions=[])).push(Fe.version),R(i||h.GreenSockGlobals||!h.gsap&&h||{}),Dt.forEach(zb)),m="undefined"!=typeof requestAnimationFrame&&requestAnimationFrame,p&&g.sleep(),_=m||function(t){return setTimeout(t,z-1e3*g.time+1|0)},d=1,zl(2))},sleep:function sleep(){(m?cancelAnimationFrame:clearTimeout)(p),d=0,_=V},lagSmoothing:function lagSmoothing(t,e){M=t||1/0,C=Math.min(e||33,M)},fps:function fps(t){D=1e3/(t||240),z=1e3*g.time+D},add:function add(n,t,e){var a=t?function(t,e,r,i){n(t,e,r,i),g.remove(a)}:n;return g.remove(n),E[e?"unshift":"push"](a),Lt(),a},remove:function remove(t,e){~(e=E.indexOf(t))&&E.splice(e,1)&&e<=k&&k--},_listeners:E=[]}),Lt=function _wake(){return!d&&It.wake()},Bt={},Nt=/^[\d.\-M][\d.\-,\s]/,Ut=/["']/g,Yt=function _invertEase(e){return function(t){return 1-e(1-t)}},jt=function _parseEase(t,e){return t&&(s(t)?t:Bt[t]||Rb(t))||e};function zl(t){var e,r,i,n,a=O()-A,s=!0===t;if((M<a||a<0)&&(P+=a-C),(0<(e=(i=(A+=a)-P)-z)||s)&&(n=++g.frame,b=i-1e3*g.time,g.time=i/=1e3,z+=e+(D<=e?4:D-e),r=1),s||(p=_(zl)),r)for(k=0;k<E.length;k++)E[k](i,b,n,t)}function dn(t){return t<N?B*t*t:t<.7272727272727273?B*Math.pow(t-1.5/2.75,2)+.75:t<.9090909090909092?B*(t-=2.25/2.75)*t+.9375:B*Math.pow(t-2.625/2.75,2)+.984375}ja("Linear,Quad,Cubic,Quart,Quint,Strong",function(t,e){var r=e<5?e+1:e;Ub(t+",Power"+(r-1),e?function(t){return Math.pow(t,r)}:function(t){return t},function(t){return 1-Math.pow(1-t,r)},function(t){return t<.5?Math.pow(2*t,r)/2:1-Math.pow(2*(1-t),r)/2})}),Bt.Linear.easeNone=Bt.none=Bt.Linear.easeIn,Ub("Elastic",Wb("in"),Wb("out"),Wb()),B=7.5625,N=1/2.75,Ub("Bounce",function(t){return 1-dn(1-t)},dn),Ub("Expo",function(t){return Math.pow(2,10*(t-1))*t+t*t*t*t*t*t*(1-t)}),Ub("Circ",function(t){return-($(1-t*t)-1)}),Ub("Sine",function(t){return 1===t?1:1-H(t*Z)}),Ub("Back",Xb("in"),Xb("out"),Xb()),Bt.SteppedEase=Bt.steps=ht.SteppedEase={config:function config(t,e){void 0===t&&(t=1);var r=1/t,i=t+(e?0:1),n=e?1:0;return function(t){return((i*Mt(0,.99999999,t)|0)+n)*r}}},j.ease=Bt["quad.out"],ja("onComplete,onUpdate,onStart,onRepeat,onReverseComplete,onInterrupt",function(t){return Tt+=t+","+t+"Params,"});var Vt,Xt=function GSCache(t,e){this.id=W++,(t._gsap=this).target=t,this.harness=e,this.get=e?e.get:ia,this.set=e?e.getSetter:ue},qt=((Vt=Animation.prototype).delay=function delay(t){return t||0===t?(this.parent&&this.parent.smoothChildTiming&&this.startTime(this._start+t-this._delay),this._delay=t,this):this._delay},Vt.duration=function duration(t){return arguments.length?this.totalDuration(0<this._repeat?t+(t+this._rDelay)*this._repeat:t):this.totalDuration()&&this._dur},Vt.totalDuration=function totalDuration(t){return arguments.length?(this._dirty=0,Ua(this,this._repeat<0?t:(t-this._repeat*this._rDelay)/(this._repeat+1))):this._tDur},Vt.totalTime=function totalTime(t,e){if(Lt(),!arguments.length)return this._tTime;var r=this._dp;if(r&&r.smoothChildTiming&&this._ts){for(La(this,t),!r._dp||r.parent||Ma(r,this);r&&r.parent;)r.parent._time!==r._start+(0<=r._ts?r._tTime/r._ts:(r.totalDuration()-r._tTime)/-r._ts)&&r.totalTime(r._tTime,!0),r=r.parent;!this.parent&&this._dp.autoRemoveChildren&&(0<this._ts&&t<this._tDur||this._ts<0&&0<t||!this._tDur&&!t)&&Na(this._dp,this,this._start-this._delay)}return(this._tTime!==t||!this._dur&&!e||this._initted&&Math.abs(this._zTime)===q||!this._initted&&this._dur&&t||!t&&!this._initted&&(this.add||this._ptLookup))&&(this._ts||(this._pTime=t),qa(this,t,e)),this},Vt.time=function time(t,e){return arguments.length?this.totalTime(Math.min(this.totalDuration(),t+Ha(this))%(this._dur+this._rDelay)||(t?this._dur:0),e):this._time},Vt.totalProgress=function totalProgress(t,e){return arguments.length?this.totalTime(this.totalDuration()*t,e):this.totalDuration()?Math.min(1,this._tTime/this._tDur):0<=this.rawTime()&&this._initted?1:0},Vt.progress=function progress(t,e){return arguments.length?this.totalTime(this.duration()*(!this._yoyo||1&this.iteration()?t:1-t)+Ha(this),e):this.duration()?Math.min(1,this._time/this._dur):0<this.rawTime()?1:0},Vt.iteration=function iteration(t,e){var r=this.duration()+this._rDelay;return arguments.length?this.totalTime(this._time+(t-1)*r,e):this._repeat?wt(this._tTime,r)+1:1},Vt.timeScale=function timeScale(t,e){if(!arguments.length)return this._rts===-q?0:this._rts;if(this._rts===t)return this;var r=this.parent&&this._ts?Ja(this.parent._time,this):this._tTime;return this._rts=+t||0,this._ts=this._ps||t===-q?0:this._rts,this.totalTime(Mt(-Math.abs(this._delay),this.totalDuration(),r),!1!==e),Ka(this),function _recacheAncestors(t){for(var e=t.parent;e&&e.parent;)e._dirty=1,e.totalDuration(),e=e.parent;return t}(this)},Vt.paused=function paused(t){return arguments.length?(this._ps!==t&&((this._ps=t)?(this._pTime=this._tTime||Math.max(-this._delay,this.rawTime()),this._ts=this._act=0):(Lt(),this._ts=this._rts,this.totalTime(this.parent&&!this.parent.smoothChildTiming?this.rawTime():this._tTime||this._pTime,1===this.progress()&&Math.abs(this._zTime)!==q&&(this._tTime-=q)))),this):this._ps},Vt.startTime=function startTime(t){if(arguments.length){this._start=la(t);var e=this.parent||this._dp;return!e||!e._sort&&this.parent||Na(e,this,this._start-this._delay),this}return this._start},Vt.endTime=function endTime(t){return this._start+(w(t)?this.totalDuration():this.duration())/Math.abs(this._ts||1)},Vt.rawTime=function rawTime(t){var e=this.parent||this._dp;return e?t&&(!this._ts||this._repeat&&this._time&&this.totalProgress()<1)?this._tTime%(this._dur+this._rDelay):this._ts?Ja(e.rawTime(t),this):this._tTime:this._tTime},Vt.revert=function revert(t){void 0===t&&(t=ct);var e=I;return I=t,pa(this)&&(this.timeline&&this.timeline.revert(t),this.totalTime(-.01,t.suppressEvents)),"nested"!==this.data&&!1!==t.kill&&this.kill(),I=e,this},Vt.globalTime=function globalTime(t){for(var e=this,r=arguments.length?t:e.rawTime();e;)r=e._start+r/(Math.abs(e._ts)||1),e=e._dp;return!this.parent&&this._sat?this._sat.globalTime(t):r},Vt.repeat=function repeat(t){return arguments.length?(this._repeat=t===1/0?-2:t,Va(this)):-2===this._repeat?1/0:this._repeat},Vt.repeatDelay=function repeatDelay(t){if(arguments.length){var e=this._time;return this._rDelay=t,Va(this),e?this.time(e):this}return this._rDelay},Vt.yoyo=function yoyo(t){return arguments.length?(this._yoyo=t,this):this._yoyo},Vt.seek=function seek(t,e){return this.totalTime(Ot(this,t),w(e))},Vt.restart=function restart(t,e){return this.play().totalTime(t?-this._delay:0,w(e)),this._dur||(this._zTime=-q),this},Vt.play=function play(t,e){return null!=t&&this.seek(t,e),this.reversed(!1).paused(!1)},Vt.reverse=function reverse(t,e){return null!=t&&this.seek(t||this.totalDuration(),e),this.reversed(!0).paused(!1)},Vt.pause=function pause(t,e){return null!=t&&this.seek(t,e),this.paused(!0)},Vt.resume=function resume(){return this.paused(!1)},Vt.reversed=function reversed(t){return arguments.length?(!!t!==this.reversed()&&this.timeScale(-this._rts||(t?-q:0)),this):this._rts<0},Vt.invalidate=function invalidate(){return this._initted=this._act=0,this._zTime=-q,this},Vt.isActive=function isActive(){var t,e=this.parent||this._dp,r=this._start;return!(e&&!(this._ts&&this._initted&&e.isActive()&&(t=e.rawTime(!0))>=r&&t<this.endTime(!0)-q))},Vt.eventCallback=function eventCallback(t,e,r){var i=this.vars;return 1<arguments.length?(e?(i[t]=e,r&&(i[t+"Params"]=r),"onUpdate"===t&&(this._onUpdate=e)):delete i[t],this):i[t]},Vt.then=function then(t){var i=this,n=i._prom;return new Promise(function(e){function Ao(){var t=i.then;i.then=null,n&&n(),s(r)&&(r=r(i))&&(r.then||r===i)&&(i.then=t),e(r),i.then=t}var r=s(t)?t:sa;i._initted&&1===i.totalProgress()&&0<=i._ts||!i._tTime&&i._ts<0?Ao():i._prom=Ao})},Vt.kill=function kill(){wb(this)},Animation);function Animation(t){this.vars=t,this._delay=+t.delay||0,(this._repeat=t.repeat===1/0?-2:t.repeat||0)&&(this._rDelay=t.repeatDelay||0,this._yoyo=!!t.yoyo||!!t.yoyoEase),this._ts=1,Ua(this,+t.duration,1,1),this.data=t.data,l&&(this._ctx=l).data.push(this),d||It.wake()}ta(qt.prototype,{_time:0,_start:0,_end:0,_tTime:0,_tDur:0,_dirty:0,_repeat:0,_yoyo:!1,parent:null,_initted:!1,_rDelay:0,_ts:1,_dp:0,ratio:0,_zTime:-q,_prom:0,_ps:!1,_rts:1});var Gt=function(i){function Timeline(t,e){var r;return void 0===t&&(t={}),(r=i.call(this,t)||this).labels={},r.smoothChildTiming=!!t.smoothChildTiming,r.autoRemoveChildren=!!t.autoRemoveChildren,r._sort=w(t.sortChildren),L&&Na(t.parent||L,_assertThisInitialized(r),e),t.reversed&&r.reverse(),t.paused&&r.paused(!0),t.scrollTrigger&&Oa(_assertThisInitialized(r),t.scrollTrigger),r}_inheritsLoose(Timeline,i);var e=Timeline.prototype;return e.to=function to(t,e,r){return Ya(0,arguments,this),this},e.from=function from(t,e,r){return Ya(1,arguments,this),this},e.fromTo=function fromTo(t,e,r,i){return Ya(2,arguments,this),this},e.set=function set(t,e,r){return e.duration=0,e.parent=this,ya(e).repeatDelay||(e.repeat=0),e.immediateRender=!!e.immediateRender,new te(t,e,Ot(this,r),1),this},e.call=function call(t,e,r){return Na(this,te.delayedCall(0,t,e),r)},e.staggerTo=function staggerTo(t,e,r,i,n,a,s){return r.duration=e,r.stagger=r.stagger||i,r.onComplete=a,r.onCompleteParams=s,r.parent=this,new te(t,r,Ot(this,n)),this},e.staggerFrom=function staggerFrom(t,e,r,i,n,a,s){return r.runBackwards=1,ya(r).immediateRender=w(r.immediateRender),this.staggerTo(t,e,r,i,n,a,s)},e.staggerFromTo=function staggerFromTo(t,e,r,i,n,a,s,o){return i.startAt=r,ya(i).immediateRender=w(i.immediateRender),this.staggerTo(t,e,i,n,a,s,o)},e.render=function render(t,e,r){var i,n,a,s,o,u,h,l,f,c,d,p,_=this._time,m=this._dirty?this.totalDuration():this._tDur,g=this._dur,v=t<=0?0:la(t),y=this._zTime<0!=t<0&&(this._initted||!g);if(this!==L&&m<v&&0<=t&&(v=m),v!==this._tTime||r||y){if(_!==this._time&&g&&(v+=this._time-_,t+=this._time-_),i=v,f=this._start,u=!(l=this._ts),y&&(g||(_=this._zTime),!t&&e||(this._zTime=t)),this._repeat){if(d=this._yoyo,o=g+this._rDelay,this._repeat<-1&&t<0)return this.totalTime(100*o+t,e,r);if(i=la(v%o),v===m?(s=this._repeat,i=g):((s=~~(c=la(v/o)))&&s===c&&(i=g,s--),g<i&&(i=g)),c=wt(this._tTime,o),!_&&this._tTime&&c!==s&&this._tTime-c*o-this._dur<=0&&(c=s),d&&1&s&&(i=g-i,p=1),s!==c&&!this._lock){var T=d&&1&c,b=T===(d&&1&s);if(s<c&&(T=!T),_=T?0:v%g?g:v,this._lock=1,this.render(_||(p?0:la(s*o)),e,!g)._lock=0,this._tTime=v,!e&&this.parent&&At(this,"onRepeat"),this.vars.repeatRefresh&&!p&&(this.invalidate()._lock=1,c=s),_&&_!==this._time||u!=!this._ts||this.vars.onRepeat&&!this.parent&&!this._act)return this;if(g=this._dur,m=this._tDur,b&&(this._lock=2,_=T?g:-1e-4,this.render(_,!0),this.vars.repeatRefresh&&!p&&this.invalidate()),this._lock=0,!this._ts&&!u)return this}}if(this._hasPause&&!this._forcing&&this._lock<2&&(h=function _findNextPauseTween(t,e,r){var i;if(e<r)for(i=t._first;i&&i._start<=r;){if("isPause"===i.data&&i._start>e)return i;i=i._next}else for(i=t._last;i&&i._start>=r;){if("isPause"===i.data&&i._start<e)return i;i=i._prev}}(this,la(_),la(i)))&&(v-=i-(i=h._start)),this._tTime=v,this._time=i,this._act=!!l,this._initted||(this._onUpdate=this.vars.onUpdate,this._initted=1,this._zTime=t,_=0),!_&&v&&g&&!e&&!c&&(At(this,"onStart"),this._tTime!==v))return this;if(_<=i&&0<=t)for(n=this._first;n;){if(a=n._next,(n._act||i>=n._start)&&n._ts&&h!==n){if(n.parent!==this)return this.render(t,e,r);if(n.render(0<n._ts?(i-n._start)*n._ts:(n._dirty?n.totalDuration():n._tDur)+(i-n._start)*n._ts,e,r),i!==this._time||!this._ts&&!u){h=0,a&&(v+=this._zTime=-q);break}}n=a}else{n=this._last;for(var w=t<0?t:i;n;){if(a=n._prev,(n._act||w<=n._end)&&n._ts&&h!==n){if(n.parent!==this)return this.render(t,e,r);if(n.render(0<n._ts?(w-n._start)*n._ts:(n._dirty?n.totalDuration():n._tDur)+(w-n._start)*n._ts,e,r||I&&pa(n)),i!==this._time||!this._ts&&!u){h=0,a&&(v+=this._zTime=w?-q:q);break}}n=a}}if(h&&!e&&(this.pause(),h.render(_<=i?0:-q)._zTime=_<=i?1:-1,this._ts))return this._start=f,Ka(this),this.render(t,e,r);this._onUpdate&&!e&&At(this,"onUpdate",!0),(v===m&&this._tTime>=this.totalDuration()||!v&&_)&&(f!==this._start&&Math.abs(l)===Math.abs(this._ts)||this._lock||(!t&&g||!(v===m&&0<this._ts||!v&&this._ts<0)||Ca(this,1),e||t<0&&!_||!v&&!_&&m||(At(this,v===m&&0<=t?"onComplete":"onReverseComplete",!0),!this._prom||v<m&&0<this.timeScale()||this._prom())))}return this},e.add=function add(e,i){var n=this;if(t(i)||(i=Ot(this,i,e)),!(e instanceof qt)){if(K(e))return e.forEach(function(t){return n.add(t,i)}),this;if(r(e))return this.addLabel(e,i);if(!s(e))return this;e=te.delayedCall(0,e)}return this!==e?Na(this,e,i):this},e.getChildren=function getChildren(t,e,r,i){void 0===t&&(t=!0),void 0===e&&(e=!0),void 0===r&&(r=!0),void 0===i&&(i=-X);for(var n=[],a=this._first;a;)a._start>=i&&(a instanceof te?e&&n.push(a):(r&&n.push(a),t&&n.push.apply(n,a.getChildren(!0,e,r)))),a=a._next;return n},e.getById=function getById(t){for(var e=this.getChildren(1,1,1),r=e.length;r--;)if(e[r].vars.id===t)return e[r]},e.remove=function remove(t){return r(t)?this.removeLabel(t):s(t)?this.killTweensOf(t):(t.parent===this&&Ba(this,t),t===this._recent&&(this._recent=this._last),Da(this))},e.totalTime=function totalTime(t,e){return arguments.length?(this._forcing=1,!this._dp&&this._ts&&(this._start=la(It.time-(0<this._ts?t/this._ts:(this.totalDuration()-t)/-this._ts))),i.prototype.totalTime.call(this,t,e),this._forcing=0,this):this._tTime},e.addLabel=function addLabel(t,e){return this.labels[t]=Ot(this,e),this},e.removeLabel=function removeLabel(t){return delete this.labels[t],this},e.addPause=function addPause(t,e,r){var i=te.delayedCall(0,e||V,r);return i.data="isPause",this._hasPause=1,Na(this,i,Ot(this,t))},e.removePause=function removePause(t){var e=this._first;for(t=Ot(this,t);e;)e._start===t&&"isPause"===e.data&&Ca(e),e=e._next},e.killTweensOf=function killTweensOf(t,e,r){for(var i=this.getTweensOf(t,r),n=i.length;n--;)Zt!==i[n]&&i[n].kill(t,e);return this},e.getTweensOf=function getTweensOf(e,r){for(var i,n=[],a=Pt(e),s=this._first,o=t(r);s;)s instanceof te?na(s._targets,a)&&(o?(!Zt||s._initted&&s._ts)&&s.globalTime(0)<=r&&s.globalTime(s.totalDuration())>r:!r||s.isActive())&&n.push(s):(i=s.getTweensOf(a,r)).length&&n.push.apply(n,i),s=s._next;return n},e.tweenTo=function tweenTo(t,e){e=e||{};var r,i=this,n=Ot(i,t),a=e.startAt,s=e.onStart,o=e.onStartParams,u=e.immediateRender,h=te.to(i,ta({ease:e.ease||"none",lazy:!1,immediateRender:!1,time:n,overwrite:"auto",duration:e.duration||Math.abs((n-(a&&"time"in a?a.time:i._time))/i.timeScale())||q,onStart:function onStart(){if(i.pause(),!r){var t=e.duration||Math.abs((n-(a&&"time"in a?a.time:i._time))/i.timeScale());h._dur!==t&&Ua(h,t,0,1).render(h._time,!0,!0),r=1}s&&s.apply(h,o||[])}},e));return u?h.render(0):h},e.tweenFromTo=function tweenFromTo(t,e,r){return this.tweenTo(e,ta({startAt:{time:Ot(this,t)}},r))},e.recent=function recent(){return this._recent},e.nextLabel=function nextLabel(t){return void 0===t&&(t=this._time),ub(this,Ot(this,t))},e.previousLabel=function previousLabel(t){return void 0===t&&(t=this._time),ub(this,Ot(this,t),1)},e.currentLabel=function currentLabel(t){return arguments.length?this.seek(t,!0):this.previousLabel(this._time+q)},e.shiftChildren=function shiftChildren(t,e,r){void 0===r&&(r=0);var i,n=this._first,a=this.labels;for(t=la(t);n;)n._start>=r&&(n._start+=t,n._end+=t),n=n._next;if(e)for(i in a)a[i]>=r&&(a[i]+=t);return Da(this)},e.invalidate=function invalidate(t){var e=this._first;for(this._lock=0;e;)e.invalidate(t),e=e._next;return i.prototype.invalidate.call(this,t)},e.clear=function clear(t){void 0===t&&(t=!0);for(var e,r=this._first;r;)e=r._next,this.remove(r),r=e;return this._dp&&(this._time=this._tTime=this._pTime=0),t&&(this.labels={}),Da(this)},e.totalDuration=function totalDuration(t){var e,r,i,n=0,a=this,s=a._last,o=X;if(arguments.length)return a.timeScale((a._repeat<0?a.duration():a.totalDuration())/(a.reversed()?-t:t));if(a._dirty){for(i=a.parent;s;)e=s._prev,s._dirty&&s.totalDuration(),o<(r=s._start)&&a._sort&&s._ts&&!a._lock?(a._lock=1,Na(a,s,r-s._delay,1)._lock=0):o=r,r<0&&s._ts&&(n-=r,(!i&&!a._dp||i&&i.smoothChildTiming)&&(a._start+=la(r/a._ts),a._time-=r,a._tTime-=r),a.shiftChildren(-r,!1,-Infinity),o=0),s._end>n&&s._ts&&(n=s._end),s=e;Ua(a,a===L&&a._time>n?a._time:n,1,1),a._dirty=0}return a._tDur},Timeline.updateRoot=function updateRoot(t){if(L._ts&&(qa(L,Ja(t,L)),f=It.frame),It.frame>=vt){vt+=Y.autoSleep||120;var e=L._first;if((!e||!e._ts)&&Y.autoSleep&&It._listeners.length<2){for(;e&&!e._ts;)e=e._next;e||It.sleep()}}},Timeline}(qt);ta(Gt.prototype,{_lock:0,_hasPause:0,_forcing:0});function cc(t,e,i,n,a,o){var u,h,l,f;if(mt[t]&&!1!==(u=new mt[t]).init(a,u.rawVars?e[t]:function _processVars(t,e,i,n,a){if(s(t)&&(t=Qt(t,a,e,i,n)),!v(t)||t.style&&t.nodeType||K(t)||J(t))return r(t)?Qt(t,a,e,i,n):t;var o,u={};for(o in t)u[o]=Qt(t[o],a,e,i,n);return u}(e[t],n,a,o,i),i,n,o)&&(i._pt=h=new we(i._pt,a,t,0,1,u.render,u,0,u.priority),i!==c))for(l=i._ptLookup[i._targets.indexOf(a)],f=u._props.length;f--;)l[u._props[f]]=h;return u}function ic(t,r,e,i){var n,a,s=r.ease||i||"power1.inOut";if(K(r))a=e[t]||(e[t]=[]),r.forEach(function(t,e){return a.push({t:e/(r.length-1)*100,v:t,e:s})});else for(n in r)a=e[n]||(e[n]=[]),"ease"===n||a.push({t:parseFloat(t),v:r[n],e:s})}var Zt,Wt,$t=function _addPropTween(t,e,i,n,a,o,u,h,l,f){s(n)&&(n=n(a||0,t,o));var c,d=t[e],p="get"!==i?i:s(d)?l?t[e.indexOf("set")||!s(t["get"+e.substr(3)])?e:"get"+e.substr(3)](l):t[e]():d,_=s(d)?l?se:ae:ie;if(r(n)&&(~n.indexOf("random(")&&(n=rb(n)),"="===n.charAt(1)&&(!(c=ma(p,n)+(_a(p)||0))&&0!==c||(n=c))),!f||p!==n||Wt)return isNaN(p*n)||""===n?(d||e in t||S(e,n),function _addComplexStringPropTween(t,e,r,i,n,a,s){var o,u,h,l,f,c,d,p,_=new we(this._pt,t,e,0,1,pe,null,n),m=0,g=0;for(_.b=r,_.e=i,r+="",(d=~(i+="").indexOf("random("))&&(i=rb(i)),a&&(a(p=[r,i],t,e),r=p[0],i=p[1]),u=r.match(at)||[];o=at.exec(i);)l=o[0],f=i.substring(m,o.index),h?h=(h+1)%5:"rgba("===f.substr(-5)&&(h=1),l!==u[g++]&&(c=parseFloat(u[g-1])||0,_._pt={_next:_._pt,p:f||1===g?f:",",s:c,c:"="===l.charAt(1)?ma(c,l)-c:parseFloat(l)-c,m:h&&h<4?Math.round:0},m=at.lastIndex);return _.c=m<i.length?i.substring(m,i.length):"",_.fp=s,(st.test(i)||d)&&(_.e=0),this._pt=_}.call(this,t,e,p,n,_,h||Y.stringFilter,l)):(c=new we(this._pt,t,e,+p||0,n-(p||0),"boolean"==typeof d?de:fe,0,_),l&&(c.fp=l),u&&c.modifier(u,this,t),this._pt=c)},Ht=function _initTween(t,e,r){var i,n,a,s,o,u,h,l,f,c,d,p,_,m=t.vars,g=m.ease,v=m.startAt,y=m.immediateRender,T=m.lazy,b=m.onUpdate,x=m.runBackwards,k=m.yoyoEase,O=m.keyframes,M=m.autoRevert,C=t._dur,P=t._startAt,S=t._targets,A=t.parent,D=A&&"nested"===A.data?A.vars.targets:S,z="auto"===t._overwrite&&!F,R=t.timeline,E=m.easeReverse||k;if(!R||O&&g||(g="none"),t._ease=jt(g,j.ease),t._rEase=E&&(jt(E)||t._ease),t._from=!R&&!!m.runBackwards,t._from&&(t.ratio=1),!R||O&&!m.stagger){if(p=(l=S[0]?ha(S[0]).harness:0)&&m[l.prop],i=xa(m,dt),P&&(P._zTime<0&&P.progress(1),e<0&&x&&y&&!M?P.render(-1,!0):P.revert(x&&C?ft:lt),P._lazy=0),v){if(Ca(t._startAt=te.set(S,ta({data:"isStart",overwrite:!1,parent:A,immediateRender:!0,lazy:!P&&w(T),startAt:null,delay:0,onUpdate:b&&function(){return At(t,"onUpdate")},stagger:0},v))),t._startAt._dp=0,t._startAt._sat=t,e<0&&(I||!y&&!M)&&t._startAt.revert(ft),y&&C&&e<=0&&r<=0)return void(e&&(t._zTime=e))}else if(x&&C&&!P)if(e&&(y=!1),a=ta({overwrite:!1,data:"isFromStart",lazy:y&&!P&&w(T),immediateRender:y,stagger:0,parent:A},i),p&&(a[l.prop]=p),Ca(t._startAt=te.set(S,a)),t._startAt._dp=0,t._startAt._sat=t,e<0&&(I?t._startAt.revert(ft):t._startAt.render(-1,!0)),t._zTime=e,y){if(!e)return}else _initTween(t._startAt,q,q);for(t._pt=t._ptCache=0,T=C&&w(T)||T&&!C,n=0;n<S.length;n++){if(h=(o=S[n])._gsap||ga(S)[n]._gsap,t._ptLookup[n]=c={},_t[h.id]&&pt.length&&oa(),d=D===S?n:D.indexOf(o),l&&!1!==(f=new l).init(o,p||i,t,d,D)&&(t._pt=s=new we(t._pt,o,f.name,0,1,f.render,f,0,f.priority),f._props.forEach(function(t){c[t]=s}),f.priority&&(u=1)),!l||p)for(a in i)mt[a]&&(f=cc(a,i,t,d,o,D))?f.priority&&(u=1):c[a]=s=$t.call(t,o,a,"get",i[a],d,D,0,m.stringFilter);t._op&&t._op[n]&&t.kill(o,t._op[n]),z&&t._pt&&(Zt=t,L.killTweensOf(o,c,t.globalTime(e)),_=!t.parent,Zt=0),t._pt&&T&&(_t[h.id]=1)}u&&be(t),t._onInit&&t._onInit(t)}t._onUpdate=b,t._initted=(!t._op||t._pt)&&!_,O&&e<=0&&R.render(X,!0,!0)},Qt=function _parseFuncOrString(t,e,i,n,a){return s(t)?t.call(e,i,n,a):r(t)&&~t.indexOf("random(")?rb(t):t},Jt=Tt+"repeat,repeatDelay,yoyo,repeatRefresh,yoyoEase,easeReverse,autoRevert",Kt={};ja(Jt+",id,stagger,delay,duration,paused,scrollTrigger",function(t){return Kt[t]=1});var te=function(E){function Tween(e,r,i,n){var a;"number"==typeof r&&(i.duration=r,r=i,i=null);var s,o,u,h,l,f,c,d,p=(a=E.call(this,n?r:ya(r))||this).vars,_=p.duration,m=p.delay,g=p.immediateRender,b=p.stagger,x=p.overwrite,k=p.keyframes,O=p.defaults,M=p.scrollTrigger,C=r.parent||L,P=(K(e)||J(e)?t(e[0]):"length"in r)?[e]:Pt(e);if(a._targets=P.length?ga(P):T("GSAP target "+e+" not found. https://gsap.com",!Y.nullTargetWarn)||[],a._ptLookup=[],a._overwrite=x,k||b||y(_)||y(m)){var S=(r=a.vars).easeReverse||r.yoyoEase;if((s=a.timeline=new Gt({data:"nested",defaults:O||{},targets:C&&"nested"===C.data?C.vars.targets:P})).kill(),s.parent=s._dp=_assertThisInitialized(a),s._start=0,b||y(_)||y(m)){if(h=P.length,c=b&&hb(b),v(b))for(l in b)~Jt.indexOf(l)&&((d=d||{})[l]=b[l]);for(o=0;o<h;o++)(u=xa(r,Kt)).stagger=0,S&&(u.easeReverse=S),d&&bt(u,d),f=P[o],u.duration=+Qt(_,_assertThisInitialized(a),o,f,P),u.delay=(+Qt(m,_assertThisInitialized(a),o,f,P)||0)-a._delay,!b&&1===h&&u.delay&&(a._delay=m=u.delay,a._start+=m,u.delay=0),s.to(f,u,c?c(o,f,P):0),s._ease=Bt.none;s.duration()?_=m=0:a.timeline=0}else if(k){ya(ta(s.vars.defaults,{ease:"none"})),s._ease=jt(k.ease||r.ease||"none");var A,D,z,R=0;if(K(k))k.forEach(function(t){return s.to(P,t,">")}),s.duration();else{for(l in u={},k)"ease"===l||"easeEach"===l||ic(l,k[l],u,k.easeEach);for(l in u)for(A=u[l].sort(function(t,e){return t.t-e.t}),o=R=0;o<A.length;o++)(z={ease:(D=A[o]).e,duration:(D.t-(o?A[o-1].t:0))/100*_})[l]=D.v,s.to(P,z,R),R+=z.duration;s.duration()<_&&s.to({},{duration:_-s.duration()})}}_||a.duration(_=s.duration())}else a.timeline=0;return!0!==x||F||(Zt=_assertThisInitialized(a),L.killTweensOf(P),Zt=0),Na(C,_assertThisInitialized(a),i),r.reversed&&a.reverse(),r.paused&&a.paused(!0),(g||!_&&!k&&a._start===la(C._time)&&w(g)&&function _hasNoPausedAncestors(t){return!t||t._ts&&_hasNoPausedAncestors(t.parent)}(_assertThisInitialized(a))&&"nested"!==C.data)&&(a._tTime=-q,a.render(Math.max(0,-m)||0)),M&&Oa(_assertThisInitialized(a),M),a}_inheritsLoose(Tween,E);var e=Tween.prototype;return e.render=function render(t,e,r){var i,n,a,s,o,u,h,l,f=this._time,c=this._tDur,d=this._dur,p=t<0,_=c-q<t&&!p?c:t<q?0:t;if(d){if(_!==this._tTime||!t||r||!this._initted&&this._tTime||this._startAt&&this._zTime<0!=p||this._lazy){if(i=_,l=this.timeline,this._repeat){if(s=d+this._rDelay,this._repeat<-1&&p)return this.totalTime(100*s+t,e,r);if(i=la(_%s),_===c?(a=this._repeat,i=d):(a=~~(o=la(_/s)))&&a===o?(i=d,a--):d<i&&(i=d),(u=this._yoyo&&1&a)&&(i=d-i),o=wt(this._tTime,s),i===f&&!r&&this._initted&&a===o)return this._tTime=_,this;a!==o&&this.vars.repeatRefresh&&!u&&!this._lock&&i!==s&&this._initted&&(this._lock=r=1,this.render(la(s*a),!0).invalidate()._lock=0)}if(!this._initted){if(Pa(this,p?t:i,r,e,_))return this._tTime=0,this;if(!(f===this._time||r&&this.vars.repeatRefresh&&a!==o))return this;if(d!==this._dur)return this.render(t,e,r)}if(this._rEase){var m=i<f;if(m!==this._inv){var g=m?f:d-f;this._inv=m,this._from&&(this.ratio=1-this.ratio),this._invRatio=this.ratio,this._invTime=f,this._invRecip=g?(m?-1:1)/g:0,this._invScale=m?-this.ratio:1-this.ratio,this._invEase=m?this._rEase:this._ease}this.ratio=h=this._invRatio+this._invScale*this._invEase((i-this._invTime)*this._invRecip)}else this.ratio=h=this._ease(i/d);if(this._from&&(this.ratio=h=1-h),this._tTime=_,this._time=i,!this._act&&this._ts&&(this._act=1,this._lazy=0),!f&&_&&!e&&!o&&(At(this,"onStart"),this._tTime!==_))return this;for(n=this._pt;n;)n.r(h,n.d),n=n._next;l&&l.render(t<0?t:l._dur*l._ease(i/this._dur),e,r)||this._startAt&&(this._zTime=t),this._onUpdate&&!e&&(p&&Fa(this,t,0,r),At(this,"onUpdate")),this._repeat&&a!==o&&this.vars.onRepeat&&!e&&this.parent&&At(this,"onRepeat"),_!==this._tDur&&_||this._tTime!==_||(p&&!this._onUpdate&&Fa(this,t,0,!0),!t&&d||!(_===this._tDur&&0<this._ts||!_&&this._ts<0)||Ca(this,1),e||p&&!f||!(_||f||u)||(At(this,_===c?"onComplete":"onReverseComplete",!0),!this._prom||_<c&&0<this.timeScale()||this._prom()))}}else!function _renderZeroDurationTween(t,e,r,i){var n,a,s,o=t.ratio,u=e<0||!e&&(!t._start&&function _parentPlayheadIsBeforeStart(t){var e=t.parent;return e&&e._ts&&e._initted&&!e._lock&&(e.rawTime()<0||_parentPlayheadIsBeforeStart(e))}(t)&&(t._initted||!xt(t))||(t._ts<0||t._dp._ts<0)&&!xt(t))?0:1,h=t._rDelay,l=0;if(h&&t._repeat&&(l=Mt(0,t._tDur,e),a=wt(l,h),t._yoyo&&1&a&&(u=1-u),a!==wt(t._tTime,h)&&(o=1-u,t.vars.repeatRefresh&&t._initted&&t.invalidate())),u!==o||I||i||t._zTime===q||!e&&t._zTime){if(!t._initted&&Pa(t,e,i,r,l))return;for(s=t._zTime,t._zTime=e||(r?q:0),r=r||e&&!s,t.ratio=u,t._from&&(u=1-u),t._time=0,t._tTime=l,n=t._pt;n;)n.r(u,n.d),n=n._next;e<0&&Fa(t,e,0,!0),t._onUpdate&&!r&&At(t,"onUpdate"),l&&t._repeat&&!r&&t.parent&&At(t,"onRepeat"),(e>=t._tDur||e<0)&&t.ratio===u&&(u&&Ca(t,1),r||I||(At(t,u?"onComplete":"onReverseComplete",!0),t._prom&&t._prom()))}else t._zTime||(t._zTime=e)}(this,t,e,r);return this},e.targets=function targets(){return this._targets},e.invalidate=function invalidate(t){return t&&this.vars.runBackwards||(this._startAt=0),this._pt=this._op=this._onUpdate=this._lazy=this.ratio=0,this._ptLookup=[],this.timeline&&this.timeline.invalidate(t),E.prototype.invalidate.call(this,t)},e.resetTo=function resetTo(t,e,r,i,n){d||It.wake(),this._ts||this.play();var a,s=Math.min(this._dur,(this._dp._time-this._start)*this._ts);return this._initted||Ht(this,s),a=this._ease(s/this._dur),function _updatePropTweens(t,e,r,i,n,a,s,o){var u,h,l,f,c=(t._pt&&t._ptCache||(t._ptCache={}))[e];if(!c)for(c=t._ptCache[e]=[],l=t._ptLookup,f=t._targets.length;f--;){if((u=l[f][e])&&u.d&&u.d._pt)for(u=u.d._pt;u&&u.p!==e&&u.fp!==e;)u=u._next;if(!u)return Wt=1,t.vars[e]="+=0",Ht(t,s),Wt=0,o?T(e+" not eligible for reset. Try splitting into individual properties"):1;c.push(u)}for(f=c.length;f--;)(u=(h=c[f])._pt||h).s=!i&&0!==i||n?u.s+(i||0)+a*u.c:i,u.c=r-u.s,h.e&&(h.e=ka(r)+_a(h.e)),h.b&&(h.b=u.s+_a(h.b))}(this,t,e,r,i,a,s,n)?this.resetTo(t,e,r,i,1):(La(this,0),this.parent||Aa(this._dp,this,"_first","_last",this._dp._sort?"_start":0),this.render(0))},e.kill=function kill(t,e){if(void 0===e&&(e="all"),!(t||e&&"all"!==e))return this._lazy=this._pt=0,this.parent?wb(this):this.scrollTrigger&&this.scrollTrigger.kill(!!I),this;if(this.timeline){var i=this.timeline.totalDuration();return this.timeline.killTweensOf(t,e,Zt&&!0!==Zt.vars.overwrite)._first||wb(this),this.parent&&i!==this.timeline.totalDuration()&&Ua(this,this._dur*this.timeline._tDur/i,0,1),this}var n,a,s,o,u,h,l,f=this._targets,c=t?Pt(t):f,d=this._ptLookup,p=this._pt;if((!e||"all"===e)&&function _arraysMatch(t,e){for(var r=t.length,i=r===e.length;i&&r--&&t[r]===e[r];);return r<0}(f,c))return"all"===e&&(this._pt=0),wb(this);for(n=this._op=this._op||[],"all"!==e&&(r(e)&&(u={},ja(e,function(t){return u[t]=1}),e=u),e=function _addAliasesToVars(t,e){var r,i,n,a,s=t[0]?ha(t[0]).harness:0,o=s&&s.aliases;if(!o)return e;for(i in r=bt({},e),o)if(i in r)for(n=(a=o[i].split(",")).length;n--;)r[a[n]]=r[i];return r}(f,e)),l=f.length;l--;)if(~c.indexOf(f[l]))for(u in a=d[l],"all"===e?(n[l]=e,o=a,s={}):(s=n[l]=n[l]||{},o=e),o)(h=a&&a[u])&&("kill"in h.d&&!0!==h.d.kill(u)||Ba(this,h,"_pt"),delete a[u]),"all"!==s&&(s[u]=1);return this._initted&&!this._pt&&p&&wb(this),this},Tween.to=function to(t,e,r){return new Tween(t,e,r)},Tween.from=function from(t,e){return Ya(1,arguments)},Tween.delayedCall=function delayedCall(t,e,r,i){return new Tween(e,0,{immediateRender:!1,lazy:!1,overwrite:!1,delay:t,onComplete:e,onReverseComplete:e,onCompleteParams:r,onReverseCompleteParams:r,callbackScope:i})},Tween.fromTo=function fromTo(t,e,r){return Ya(2,arguments)},Tween.set=function set(t,e){return e.duration=0,e.repeatDelay||(e.repeat=0),new Tween(t,e)},Tween.killTweensOf=function killTweensOf(t,e,r){return L.killTweensOf(t,e,r)},Tween}(qt);ta(te.prototype,{_targets:[],_lazy:0,_startAt:0,_op:0,_onInit:0}),ja("staggerTo,staggerFrom,staggerFromTo",function(r){te[r]=function(){var t=new Gt,e=Ct.call(arguments,0);return e.splice("staggerFromTo"===r?5:4,0,0),t[r].apply(t,e)}});function qc(t,e,r){return t.setAttribute(e,r)}function yc(t,e,r,i){i.mSet(t,e,i.m.call(i.tween,r,i.mt),i)}var ie=function _setterPlain(t,e,r){return t[e]=r},ae=function _setterFunc(t,e,r){return t[e](r)},se=function _setterFuncWithParam(t,e,r,i){return t[e](i.fp,r)},ue=function _getSetter(t,e){return s(t[e])?ae:u(t[e])&&t.setAttribute?qc:ie},fe=function _renderPlain(t,e){return e.set(e.t,e.p,Math.round(1e6*(e.s+e.c*t))/1e6,e)},de=function _renderBoolean(t,e){return e.set(e.t,e.p,!!(e.s+e.c*t),e)},pe=function _renderComplexString(t,e){var r=e._pt,i="";if(!t&&e.b)i=e.b;else if(1===t&&e.e)i=e.e;else{for(;r;)i=r.p+(r.m?r.m(r.s+r.c*t):Math.round(1e4*(r.s+r.c*t))/1e4)+i,r=r._next;i+=e.c}e.set(e.t,e.p,i,e)},_e=function _renderPropTweens(t,e){for(var r=e._pt;r;)r.r(t,r.d),r=r._next},ve=function _addPluginModifier(t,e,r,i){for(var n,a=this._pt;a;)n=a._next,a.p===i&&a.modifier(t,e,r),a=n},Te=function _killPropTweensOf(t){for(var e,r,i=this._pt;i;)r=i._next,i.p===t&&!i.op||i.op===t?Ba(this,i,"_pt"):i.dep||(e=1),i=r;return!e},be=function _sortPropTweensByPriority(t){for(var e,r,i,n,a=t._pt;a;){for(e=a._next,r=i;r&&r.pr>a.pr;)r=r._next;(a._prev=r?r._prev:n)?a._prev._next=a:i=a,(a._next=r)?r._prev=a:n=a,a=e}t._pt=i},we=(PropTween.prototype.modifier=function modifier(t,e,r){this.mSet=this.mSet||this.set,this.set=yc,this.m=t,this.mt=r,this.tween=e},PropTween);function PropTween(t,e,r,i,n,a,s,o,u){this.t=e,this.s=i,this.c=n,this.p=r,this.r=a||fe,this.d=s||this,this.set=o||ie,this.pr=u||0,(this._next=t)&&(t._prev=this)}ja(Tt+"parent,duration,ease,delay,overwrite,runBackwards,startAt,yoyo,immediateRender,repeat,repeatDelay,data,paused,reversed,lazy,callbackScope,stringFilter,id,yoyoEase,stagger,inherit,repeatRefresh,keyframes,autoRevert,scrollTrigger,easeReverse",function(t){return dt[t]=1}),ht.TweenMax=ht.TweenLite=te,ht.TimelineLite=ht.TimelineMax=Gt,L=new Gt({sortChildren:!1,defaults:j,autoRemoveChildren:!0,id:"root",smoothChildTiming:!0}),Y.stringFilter=Ib;function Gc(t){return(Oe[t]||Me).map(function(t){return t()})}function Hc(){var t=Date.now(),o=[];2<t-Ce&&(Gc("matchMediaInit"),ke.forEach(function(t){var e,r,i,n,a=t.queries,s=t.conditions;for(r in a)(e=h.matchMedia(a[r]).matches)&&(i=1),e!==s[r]&&(s[r]=e,n=1);n&&(t.revert(),i&&o.push(t))}),Gc("matchMediaRevert"),o.forEach(function(e){return e.onMatch(e,function(t){return e.add(null,t)})}),Ce=t,Gc("matchMedia"))}var xe,ke=[],Oe={},Me=[],Ce=0,Pe=0,Se=((xe=Context.prototype).add=function add(t,i,n){function Gw(){var t,e=l,r=a.selector;return e&&e!==a&&e.data.push(a),n&&(a.selector=fb(n)),l=a,t=i.apply(a,arguments),s(t)&&a._r.push(t),l=e,a.selector=r,a.isReverted=!1,t}s(t)&&(n=i,i=t,t=s);var a=this;return a.last=Gw,t===s?Gw(a,function(t){return a.add(null,t)}):t?a[t]=Gw:Gw},xe.ignore=function ignore(t){var e=l;l=null,t(this),l=e},xe.getTweens=function getTweens(){var e=[];return this.data.forEach(function(t){return t instanceof Context?e.push.apply(e,t.getTweens()):t instanceof te&&!(t.parent&&"nested"===t.parent.data)&&e.push(t)}),e},xe.clear=function clear(){this._r.length=this.data.length=0},xe.kill=function kill(i,t){var n=this;if(i?function(){for(var t,e=n.getTweens(),r=n.data.length;r--;)"isFlip"===(t=n.data[r]).data&&(t.revert(),t.getChildren(!0,!0,!1).forEach(function(t){return e.splice(e.indexOf(t),1)}));for(e.map(function(t){return{g:t._dur||t._delay||t._sat&&!t._sat.vars.immediateRender?t.globalTime(0):-1/0,t:t}}).sort(function(t,e){return e.g-t.g||-1/0}).forEach(function(t){return t.t.revert(i)}),r=n.data.length;r--;)(t=n.data[r])instanceof Gt?"nested"!==t.data&&(t.scrollTrigger&&t.scrollTrigger.revert(),t.kill()):t instanceof te||!t.revert||t.revert(i);n._r.forEach(function(t){return t(i,n)}),n.isReverted=!0}():this.data.forEach(function(t){return t.kill&&t.kill()}),this.clear(),t)for(var e=ke.length;e--;)ke[e].id===this.id&&ke.splice(e,1)},xe.revert=function revert(t){this.kill(t||{})},Context);function Context(t,e){this.selector=e&&fb(e),this.data=[],this._r=[],this.isReverted=!1,this.id=Pe++,t&&this.add(t)}var De,Re=((De=MatchMedia.prototype).add=function add(t,e,r){v(t)||(t={matches:t});var i,n,a,s=new Se(0,r||this.scope),o=s.conditions={};for(n in l&&!s.selector&&(s.selector=l.selector),this.contexts.push(s),e=s.add("onMatch",e),s.queries=t)"all"===n?a=1:(i=h.matchMedia(t[n]))&&(ke.indexOf(s)<0&&ke.push(s),(o[n]=i.matches)&&(a=1),i.addListener?i.addListener(Hc):i.addEventListener("change",Hc));return a&&e(s,function(t){return s.add(null,t)}),this},De.revert=function revert(t){this.kill(t||{})},De.kill=function kill(e){this.contexts.forEach(function(t){return t.kill(e,!0)})},MatchMedia);function MatchMedia(t){this.contexts=[],this.scope=t,l&&l.data.push(this)}var Ee={registerPlugin:function registerPlugin(){for(var t=arguments.length,e=new Array(t),r=0;r<t;r++)e[r]=arguments[r];e.forEach(function(t){return zb(t)})},timeline:function timeline(t){return new Gt(t)},getTweensOf:function getTweensOf(t,e){return L.getTweensOf(t,e)},getProperty:function getProperty(i,t,e,n){r(i)&&(i=Pt(i)[0]);var a=ha(i||{}).get,s=e?sa:ra;return"native"===e&&(e=""),i?t?s((mt[t]&&mt[t].get||a)(i,t,e,n)):function(t,e,r){return s((mt[t]&&mt[t].get||a)(i,t,e,r))}:i},quickSetter:function quickSetter(r,e,i){if(1<(r=Pt(r)).length){var n=r.map(function(t){return Fe.quickSetter(t,e,i)}),a=n.length;return function(t){for(var e=a;e--;)n[e](t)}}r=r[0]||{};var s=mt[e],o=ha(r),u=o.harness&&(o.harness.aliases||{})[e]||e,h=s?function(t){var e=new s;c._pt=0,e.init(r,i?t+i:t,c,0,[r]),e.render(1,e),c._pt&&_e(1,c)}:o.set(r,u);return s?h:function(t){return h(r,u,i?t+i:t,o,1)}},quickTo:function quickTo(t,i,e){function $x(t,e,r){return n.resetTo(i,t,e,r)}var r,n=Fe.to(t,ta(((r={})[i]="+=0.1",r.paused=!0,r.stagger=0,r),e||{}));return $x.tween=n,$x},isTweening:function isTweening(t){return 0<L.getTweensOf(t,!0).length},defaults:function defaults(t){return t&&t.ease&&(t.ease=jt(t.ease,j.ease)),wa(j,t||{})},config:function config(t){return wa(Y,t||{})},registerEffect:function registerEffect(t){var i=t.name,n=t.effect,e=t.plugins,a=t.defaults,r=t.extendTimeline;(e||"").split(",").forEach(function(t){return t&&!mt[t]&&!ht[t]&&T(i+" effect requires "+t+" plugin.")}),gt[i]=function(t,e,r){return n(Pt(t),ta(e||{},a),r)},r&&(Gt.prototype[i]=function(t,e,r){return this.add(gt[i](t,v(e)?e:(r=e)&&{},this),r)})},registerEase:function registerEase(t,e){Bt[t]=jt(e)},parseEase:function parseEase(t,e){return arguments.length?jt(t,e):Bt},getById:function getById(t){return L.getById(t)},exportRoot:function exportRoot(t,e){void 0===t&&(t={});var r,i,n=new Gt(t);for(n.smoothChildTiming=w(t.smoothChildTiming),L.remove(n),n._dp=0,n._time=n._tTime=L._time,r=L._first;r;)i=r._next,!e&&!r._dur&&r instanceof te&&r.vars.onComplete===r._targets[0]||Na(n,r,r._start-r._delay),r=i;return Na(L,n,0),n},context:function context(t,e){return t?new Se(t,e):l},matchMedia:function matchMedia(t){return new Re(t)},matchMediaRefresh:function matchMediaRefresh(){return ke.forEach(function(t){var e,r,i=t.conditions;for(r in i)i[r]&&(i[r]=!1,e=1);e&&t.revert()})||Hc()},addEventListener:function addEventListener(t,e){var r=Oe[t]||(Oe[t]=[]);~r.indexOf(e)||r.push(e)},removeEventListener:function removeEventListener(t,e){var r=Oe[t],i=r&&r.indexOf(e);0<=i&&r.splice(i,1)},utils:{wrap:function wrap(e,t,r){var i=t-e;return K(e)?ob(e,wrap(0,e.length),t):Za(r,function(t){return(i+(t-e)%i)%i+e})},wrapYoyo:function wrapYoyo(e,t,r){var i=t-e,n=2*i;return K(e)?ob(e,wrapYoyo(0,e.length-1),t):Za(r,function(t){return e+(i<(t=(n+(t-e)%n)%n||0)?n-t:t)})},distribute:hb,random:kb,snap:jb,normalize:function normalize(t,e,r){return St(t,e,0,1,r)},getUnit:_a,clamp:function clamp(e,r,t){return Za(t,function(t){return Mt(e,r,t)})},splitColor:Db,toArray:Pt,selector:fb,mapRange:St,pipe:function pipe(){for(var t=arguments.length,e=new Array(t),r=0;r<t;r++)e[r]=arguments[r];return function(t){return e.reduce(function(t,e){return e(t)},t)}},unitize:function unitize(e,r){return function(t){return e(parseFloat(t))+(r||_a(t))}},interpolate:function interpolate(e,i,t,n){var a=isNaN(e+i)?0:function(t){return(1-t)*e+t*i};if(!a){var s,o,u,h,l,f=r(e),c={};if(!0===t&&(n=1)&&(t=null),f)e={p:e},i={p:i};else if(K(e)&&!K(i)){for(u=[],h=e.length,l=h-2,o=1;o<h;o++)u.push(interpolate(e[o-1],e[o]));h--,a=function func(t){t*=h;var e=Math.min(l,~~t);return u[e](t-e)},t=i}else n||(e=bt(K(e)?[]:{},e));if(!u){for(s in i)$t.call(c,e,s,"get",i[s]);a=function func(t){return _e(t,c)||(f?e.p:e)}}}return Za(t,a)},shuffle:gb},install:R,effects:gt,ticker:It,updateRoot:Gt.updateRoot,plugins:mt,globalTimeline:L,core:{PropTween:we,globals:U,Tween:te,Timeline:Gt,Animation:qt,getCache:ha,_removeLinkedListItem:Ba,reverting:function reverting(){return I},context:function context(t){return t&&l&&(l.data.push(t),t._ctx=l),l},suppressOverwrites:function suppressOverwrites(t){return F=t}}};ja("to,from,fromTo,delayedCall,set,killTweensOf",function(t){return Ee[t]=te[t]}),It.add(Gt.updateRoot),c=Ee.to({},{duration:0});function Lc(t,e){for(var r=t._pt;r&&r.p!==e&&r.op!==e&&r.fp!==e;)r=r._next;return r}function Nc(t,a){return{name:t,headless:1,rawVars:1,init:function init(t,n,e){e._onInit=function(t){var e,i;if(r(n)&&(e={},ja(n,function(t){return e[t]=1}),n=e),a){for(i in e={},n)e[i]=a(n[i]);n=e}!function _addModifiers(t,e){var r,i,n,a=t._targets;for(r in e)for(i=a.length;i--;)(n=(n=t._ptLookup[i][r])&&n.d)&&(n._pt&&(n=Lc(n,r)),n&&n.modifier&&n.modifier(e[r],t,a[i],r))}(t,n)}}}}var Fe=Ee.registerPlugin({name:"attr",init:function init(t,e,r,i,n){var a,s,o;for(a in this.tween=r,e)o=t.getAttribute(a)||"",(s=this.add(t,"setAttribute",(o||0)+"",e[a],i,n,0,0,a)).op=a,s.b=o,this._props.push(a)},render:function render(t,e){for(var r=e._pt;r;)I?r.set(r.t,r.p,r.b,r):r.r(t,r.d),r=r._next}},{name:"endArray",headless:1,init:function init(t,e){for(var r=e.length;r--;)this.add(t,r,t[r]||0,e[r],0,0,0,0,0,1)}},Nc("roundProps",ib),Nc("modifiers"),Nc("snap",jb))||Ee;te.version=Gt.version=Fe.version="3.15.0",o=1,x()&&Lt();function xd(t,e){return e.set(e.t,e.p,Math.round(1e4*(e.s+e.c*t))/1e4+e.u,e)}function yd(t,e){return e.set(e.t,e.p,1===t?e.e:Math.round(1e4*(e.s+e.c*t))/1e4+e.u,e)}function zd(t,e){return e.set(e.t,e.p,t?Math.round(1e4*(e.s+e.c*t))/1e4+e.u:e.b,e)}function Ad(t,e){return e.set(e.t,e.p,1===t?e.e:t?Math.round(1e4*(e.s+e.c*t))/1e4+e.u:e.b,e)}function Bd(t,e){var r=e.s+e.c*t;e.set(e.t,e.p,~~(r+(r<0?-.5:.5))+e.u,e)}function Cd(t,e){return e.set(e.t,e.p,t?e.e:e.b,e)}function Dd(t,e){return e.set(e.t,e.p,1!==t?e.b:e.e,e)}function Ed(t,e,r){return t.style[e]=r}function Fd(t,e,r){return t.style.setProperty(e,r)}function Gd(t,e,r){return t._gsap[e]=r}function Hd(t,e,r){return t._gsap.scaleX=t._gsap.scaleY=r}function Id(t,e,r,i,n){var a=t._gsap;a.scaleX=a.scaleY=r,a.renderTransform(n,a)}function Jd(t,e,r,i,n){var a=t._gsap;a[e]=r,a.renderTransform(n,a)}function Md(t,e){var r=this,i=this.target,n=i.style,a=i._gsap;if(t in ur&&n){if(this.tfm=this.tfm||{},"transform"===t)return _r.transform.split(",").forEach(function(t){return Md.call(r,t,e)});if(~(t=_r[t]||t).indexOf(",")?t.split(",").forEach(function(t){return r.tfm[t]=wr(i,t)}):this.tfm[t]=a.x?a[t]:wr(i,t),t===gr&&(this.tfm.zOrigin=a.zOrigin),0<=this.props.indexOf(mr))return;a.svg&&(this.svgo=i.getAttribute("data-svg-origin"),this.props.push(gr,e,"")),t=mr}(n||e)&&this.props.push(t,e,n[t])}function Nd(t){t.translate&&(t.removeProperty("translate"),t.removeProperty("scale"),t.removeProperty("rotate"))}function Od(){var t,e,r=this.props,i=this.target,n=i.style,a=i._gsap;for(t=0;t<r.length;t+=3)r[t+1]?2===r[t+1]?i[r[t]](r[t+2]):i[r[t]]=r[t+2]:r[t+2]?n[r[t]]=r[t+2]:n.removeProperty("--"===r[t].substr(0,2)?r[t]:r[t].replace(cr,"-$1").toLowerCase());if(this.tfm){for(e in this.tfm)a[e]=this.tfm[e];a.svg&&(a.renderTransform(),i.setAttribute("data-svg-origin",this.svgo||"")),(t=je())&&t.isStart||n[mr]||(Nd(n),a.zOrigin&&n[gr]&&(n[gr]+=" "+a.zOrigin+"px",a.zOrigin=0,a.renderTransform()),a.uncache=1)}}function Pd(t,e){var r={target:t,props:[],revert:Od,save:Md};return t._gsap||Fe.core.getCache(t),e&&t.style&&t.nodeType&&e.split(",").forEach(function(t){return r.save(t)}),r}function Rd(t,e){var r=Le.createElementNS?Le.createElementNS((e||"http://www.w3.org/1999/xhtml").replace(/^https/,"http"),t):Le.createElement(t);return r&&r.style?r:Le.createElement(t)}function Sd(t,e,r){var i=getComputedStyle(t);return i[e]||i.getPropertyValue(e.replace(cr,"-$1").toLowerCase())||i.getPropertyValue(e)||!r&&Sd(t,yr(e)||e,1)||""}function Vd(){(function _windowExists(){return"undefined"!=typeof window})()&&window.document&&(Ie=window,Le=Ie.document,Be=Le.documentElement,Ue=Rd("div")||{style:{}},Rd("div"),mr=yr(mr),gr=mr+"Origin",Ue.style.cssText="border-width:0;line-height:0;position:absolute;padding:0",Ve=!!yr("perspective"),je=Fe.core.reverting,Ne=1)}function Wd(t){var e,r=t.ownerSVGElement,i=Rd("svg",r&&r.getAttribute("xmlns")||"http://www.w3.org/2000/svg"),n=t.cloneNode(!0);n.style.display="block",i.appendChild(n),Be.appendChild(i);try{e=n.getBBox()}catch(t){}return i.removeChild(n),Be.removeChild(i),e}function Xd(t,e){for(var r=e.length;r--;)if(t.hasAttribute(e[r]))return t.getAttribute(e[r])}function Yd(e){var r,i;try{r=e.getBBox()}catch(t){r=Wd(e),i=1}return r&&(r.width||r.height)||i||(r=Wd(e)),!r||r.width||r.x||r.y?r:{x:+Xd(e,["x","cx","x1"])||0,y:+Xd(e,["y","cy","y1"])||0,width:0,height:0}}function Zd(t){return!(!t.getCTM||t.parentNode&&!t.ownerSVGElement||!Yd(t))}function $d(t,e){if(e){var r,i=t.style;e in ur&&e!==gr&&(e=mr),i.removeProperty?("ms"!==(r=e.substr(0,2))&&"webkit"!==e.substr(0,6)||(e="-"+e),i.removeProperty("--"===r?e:e.replace(cr,"-$1").toLowerCase())):i.removeAttribute(e)}}function _d(t,e,r,i,n,a){var s=new we(t._pt,e,r,0,1,a?Dd:Cd);return(t._pt=s).b=i,s.e=n,t._props.push(r),s}function ce(t,e,r,i){var n,a,s,o,u=parseFloat(r)||0,h=(r+"").trim().substr((u+"").length)||"px",l=Ue.style,f=dr.test(e),c="svg"===t.tagName.toLowerCase(),d=(c?"client":"offset")+(f?"Width":"Height"),p="px"===i,_="%"===i;if(i===h||!u||Tr[i]||Tr[h])return u;if("px"===h||p||(u=ce(t,e,r,"px")),o=t.getCTM&&Zd(t),(_||"%"===h)&&(ur[e]||~e.indexOf("adius")))return n=o?t.getBBox()[f?"width":"height"]:t[d],ka(_?u/n*100:u/100*n);if(l[f?"width":"height"]=100+(p?h:i),a="rem"!==i&&~e.indexOf("adius")||"em"===i&&t.appendChild&&!c?t:t.parentNode,o&&(a=(t.ownerSVGElement||{}).parentNode),a&&a!==Le&&a.appendChild||(a=Le.body),(s=a._gsap)&&_&&s.width&&f&&s.time===It.time&&!s.uncache)return ka(u/s.width*100);if(!_||"height"!==e&&"width"!==e)!_&&"%"!==h||br[Sd(a,"display")]||(l.position=Sd(t,"position")),a===t&&(l.position="static"),a.appendChild(Ue),n=Ue[d],a.removeChild(Ue),l.position="absolute";else{var m=t.style[e];t.style[e]=100+i,n=t[d],m?t.style[e]=m:$d(t,e)}return f&&_&&((s=ha(a)).time=It.time,s.width=a[d]),ka(p?n*u/100:n&&u?100/n*u:0)}function ee(t,e,r,i){if(!r||"none"===r){var n=yr(e,t,1),a=n&&Sd(t,n,1);a&&a!==r?(e=n,r=a):"borderColor"===e&&(r=Sd(t,"borderTopColor"))}var s,o,u,h,l,f,c,d,p,_,m,g=new we(this._pt,t.style,e,0,1,pe),v=0,y=0;if(g.b=r,g.e=i,r+="","var(--"===(i+="").substring(0,6)&&(i=Sd(t,i.substring(4,i.indexOf(")")))),"auto"===i&&(f=t.style[e],t.style[e]=i,i=Sd(t,e)||i,f?t.style[e]=f:$d(t,e)),Ib(s=[r,i]),i=s[1],u=(r=s[0]).match(nt)||[],(i.match(nt)||[]).length){for(;o=nt.exec(i);)c=o[0],p=i.substring(v,o.index),l?l=(l+1)%5:"rgba("!==p.substr(-5)&&"hsla("!==p.substr(-5)||(l=1),c!==(f=u[y++]||"")&&(h=parseFloat(f)||0,m=f.substr((h+"").length),"="===c.charAt(1)&&(c=ma(h,c)+m),d=parseFloat(c),_=c.substr((d+"").length),v=nt.lastIndex-_.length,_||(_=_||Y.units[e]||m,v===i.length&&(i+=_,g.e+=_)),m!==_&&(h=ce(t,e,f,_)||0),g._pt={_next:g._pt,p:p||1===y?p:",",s:h,c:d-h,m:l&&l<4||"zIndex"===e?Math.round:0});g.c=v<i.length?i.substring(v,i.length):""}else g.r="display"===e&&"none"===i?Dd:Cd;return st.test(i)&&(g.e=0),this._pt=g}function ge(t){var e=t.split(" "),r=e[0],i=e[1]||"50%";return"top"!==r&&"bottom"!==r&&"left"!==i&&"right"!==i||(t=r,r=i,i=t),e[0]=xr[r]||r,e[1]=xr[i]||i,e.join(" ")}function he(t,e){if(e.tween&&e.tween._time===e.tween._dur){var r,i,n,a=e.t,s=a.style,o=e.u,u=a._gsap;if("all"===o||!0===o)s.cssText="",i=1;else for(n=(o=o.split(",")).length;-1<--n;)r=o[n],ur[r]&&(i=1,r="transformOrigin"===r?gr:mr),$d(a,r);i&&($d(a,mr),u&&(u.svg&&a.removeAttribute("transform"),s.scale=s.rotate=s.translate="none",Cr(a,1),u.uncache=1,Nd(s)))}}function le(t){return"matrix(1, 0, 0, 1, 0, 0)"===t||"none"===t||!t}function me(t){var e=Sd(t,mr);return le(e)?Or:e.substr(7).match(it).map(ka)}function ne(t,e){var r,i,n,a,s=t._gsap||ha(t),o=t.style,u=me(t);return s.svg&&t.getAttribute("transform")?"1,0,0,1,0,0"===(u=[(n=t.transform.baseVal.consolidate().matrix).a,n.b,n.c,n.d,n.e,n.f]).join(",")?Or:u:(u!==Or||t.offsetParent||t===Be||s.svg||(n=o.display,o.display="block",(r=t.parentNode)&&(t.offsetParent||t.getBoundingClientRect().width)||(a=1,i=t.nextElementSibling,Be.appendChild(t)),u=me(t),n?o.display=n:$d(t,"display"),a&&(i?r.insertBefore(t,i):r?r.appendChild(t):Be.removeChild(t))),e&&6<u.length?[u[0],u[1],u[4],u[5],u[12],u[13]]:u)}function oe(t,e,r,i,n,a){var s,o,u,h=t._gsap,l=n||ne(t,!0),f=h.xOrigin||0,c=h.yOrigin||0,d=h.xOffset||0,p=h.yOffset||0,_=l[0],m=l[1],g=l[2],v=l[3],y=l[4],T=l[5],b=e.split(" "),w=parseFloat(b[0])||0,x=parseFloat(b[1])||0;r?l!==Or&&(o=_*v-m*g)&&(u=w*(-m/o)+x*(_/o)-(_*T-m*y)/o,w=w*(v/o)+x*(-g/o)+(g*T-v*y)/o,x=u):(w=(s=Yd(t)).x+(~b[0].indexOf("%")?w/100*s.width:w),x=s.y+(~(b[1]||b[0]).indexOf("%")?x/100*s.height:x)),i||!1!==i&&h.smooth?(y=w-f,T=x-c,h.xOffset=d+(y*_+T*g)-y,h.yOffset=p+(y*m+T*v)-T):h.xOffset=h.yOffset=0,h.xOrigin=w,h.yOrigin=x,h.smooth=!!i,h.origin=e,h.originIsAbsolute=!!r,t.style[gr]="0px 0px",a&&(_d(a,h,"xOrigin",f,w),_d(a,h,"yOrigin",c,x),_d(a,h,"xOffset",d,h.xOffset),_d(a,h,"yOffset",p,h.yOffset)),t.setAttribute("data-svg-origin",w+" "+x)}function re(t,e,r){var i=_a(e);return ka(parseFloat(e)+parseFloat(ce(t,"x",r+"px",i)))+i}function ye(t,e,i,n,a){var s,o,u=360,h=r(a),l=parseFloat(a)*(h&&~a.indexOf("rad")?hr:1)-n,f=n+l+"deg";return h&&("short"===(s=a.split("_")[1])&&(l%=u)!==l%180&&(l+=l<0?u:-u),"cw"===s&&l<0?l=(l+36e9)%u-~~(l/u)*u:"ccw"===s&&0<l&&(l=(l-36e9)%u-~~(l/u)*u)),t._pt=o=new we(t._pt,e,i,n,l,yd),o.e=f,o.u="deg",t._props.push(i),o}function ze(t,e){for(var r in e)t[r]=e[r];return t}function Ae(t,e,r){var i,n,a,s,o,u,h,l=ze({},r._gsap),f=r.style;for(n in l.svg?(a=r.getAttribute("transform"),r.setAttribute("transform",""),f[mr]=e,i=Cr(r,1),$d(r,mr),r.setAttribute("transform",a)):(a=getComputedStyle(r)[mr],f[mr]=e,i=Cr(r,1),f[mr]=a),ur)(a=l[n])!==(s=i[n])&&"perspective,force3D,transformOrigin,svgOrigin".indexOf(n)<0&&(o=_a(a)!==(h=_a(s))?ce(r,n,a,h):parseFloat(a),u=parseFloat(s),t._pt=new we(t._pt,i,n,o,u-o,xd),t._pt.u=h||0,t._props.push(n));ze(i,l)}var Ie,Le,Be,Ne,Ue,Ye,je,Ve,Xe=Bt.Power0,qe=Bt.Power1,Ge=Bt.Power2,Ze=Bt.Power3,We=Bt.Power4,$e=Bt.Linear,He=Bt.Quad,Qe=Bt.Cubic,Je=Bt.Quart,Ke=Bt.Quint,tr=Bt.Strong,er=Bt.Elastic,rr=Bt.Back,ir=Bt.SteppedEase,nr=Bt.Bounce,ar=Bt.Sine,sr=Bt.Expo,or=Bt.Circ,ur={},hr=180/Math.PI,lr=Math.PI/180,fr=Math.atan2,cr=/([A-Z])/g,dr=/(left|right|width|margin|padding|x)/i,pr=/[\s,\(]\S/,_r={autoAlpha:"opacity,visibility",scale:"scaleX,scaleY",alpha:"opacity"},mr="transform",gr=mr+"Origin",vr="O,Moz,ms,Ms,Webkit".split(","),yr=function _checkPropPrefix(t,e,r){var i=(e||Ue).style,n=5;if(t in i&&!r)return t;for(t=t.charAt(0).toUpperCase()+t.substr(1);n--&&!(vr[n]+t in i););return n<0?null:(3===n?"ms":0<=n?vr[n]:"")+t},Tr={deg:1,rad:1,turn:1},br={grid:1,flex:1},wr=function _get(t,e,r,i){var n;return Ne||Vd(),e in _r&&"transform"!==e&&~(e=_r[e]).indexOf(",")&&(e=e.split(",")[0]),ur[e]&&"transform"!==e?(n=Cr(t,i),n="transformOrigin"!==e?n[e]:n.svg?n.origin:Pr(Sd(t,gr))+" "+n.zOrigin+"px"):(n=t.style[e])&&"auto"!==n&&!i&&!~(n+"").indexOf("calc(")||(n=kr[e]&&kr[e](t,e,r)||Sd(t,e)||ia(t,e)||("opacity"===e?1:0)),r&&!~(n+"").trim().indexOf(" ")?ce(t,e,n,r)+r:n},xr={top:"0%",bottom:"100%",left:"0%",right:"100%",center:"50%"},kr={clearProps:function clearProps(t,e,r,i,n){if("isFromStart"!==n.data){var a=t._pt=new we(t._pt,e,r,0,0,he);return a.u=i,a.pr=-10,a.tween=n,t._props.push(r),1}}},Or=[1,0,0,1,0,0],Mr={},Cr=function _parseTransform(t,e){var r=t._gsap||new Xt(t);if("x"in r&&!e&&!r.uncache)return r;var i,n,a,s,o,u,h,l,f,c,d,p,_,m,g,v,y,T,b,w,x,k,O,M,C,P,S,A,D,z,R,E,F=t.style,I=r.scaleX<0,L="deg",B=getComputedStyle(t),N=Sd(t,gr)||"0";return i=n=a=u=h=l=f=c=d=0,s=o=1,r.svg=!(!t.getCTM||!Zd(t)),B.translate&&("none"===B.translate&&"none"===B.scale&&"none"===B.rotate||(F[mr]=("none"!==B.translate?"translate3d("+(B.translate+" 0 0").split(" ").slice(0,3).join(", ")+") ":"")+("none"!==B.rotate?"rotate("+B.rotate+") ":"")+("none"!==B.scale?"scale("+B.scale.split(" ").join(",")+") ":"")+("none"!==B[mr]?B[mr]:"")),F.scale=F.rotate=F.translate="none"),m=ne(t,r.svg),r.svg&&(M=r.uncache?(C=t.getBBox(),N=r.xOrigin-C.x+"px "+(r.yOrigin-C.y)+"px",""):!e&&t.getAttribute("data-svg-origin"),oe(t,M||N,!!M||r.originIsAbsolute,!1!==r.smooth,m)),p=r.xOrigin||0,_=r.yOrigin||0,m!==Or&&(T=m[0],b=m[1],w=m[2],x=m[3],i=k=m[4],n=O=m[5],6===m.length?(s=Math.sqrt(T*T+b*b),o=Math.sqrt(x*x+w*w),u=T||b?fr(b,T)*hr:0,(f=w||x?fr(w,x)*hr+u:0)&&(o*=Math.abs(Math.cos(f*lr))),r.svg&&(i-=p-(p*T+_*w),n-=_-(p*b+_*x))):(E=m[6],z=m[7],S=m[8],A=m[9],D=m[10],R=m[11],i=m[12],n=m[13],a=m[14],h=(g=fr(E,D))*hr,g&&(M=k*(v=Math.cos(-g))+S*(y=Math.sin(-g)),C=O*v+A*y,P=E*v+D*y,S=k*-y+S*v,A=O*-y+A*v,D=E*-y+D*v,R=z*-y+R*v,k=M,O=C,E=P),l=(g=fr(-w,D))*hr,g&&(v=Math.cos(-g),R=x*(y=Math.sin(-g))+R*v,T=M=T*v-S*y,b=C=b*v-A*y,w=P=w*v-D*y),u=(g=fr(b,T))*hr,g&&(M=T*(v=Math.cos(g))+b*(y=Math.sin(g)),C=k*v+O*y,b=b*v-T*y,O=O*v-k*y,T=M,k=C),h&&359.9<Math.abs(h)+Math.abs(u)&&(h=u=0,l=180-l),s=ka(Math.sqrt(T*T+b*b+w*w)),o=ka(Math.sqrt(O*O+E*E)),g=fr(k,O),f=2e-4<Math.abs(g)?g*hr:0,d=R?1/(R<0?-R:R):0),r.svg&&(M=t.getAttribute("transform"),r.forceCSS=t.setAttribute("transform","")||!le(Sd(t,mr)),M&&t.setAttribute("transform",M))),90<Math.abs(f)&&Math.abs(f)<270&&(I?(s*=-1,f+=u<=0?180:-180,u+=u<=0?180:-180):(o*=-1,f+=f<=0?180:-180)),e=e||r.uncache,r.x=i-((r.xPercent=i&&(!e&&r.xPercent||(Math.round(t.offsetWidth/2)===Math.round(-i)?-50:0)))?t.offsetWidth*r.xPercent/100:0)+"px",r.y=n-((r.yPercent=n&&(!e&&r.yPercent||(Math.round(t.offsetHeight/2)===Math.round(-n)?-50:0)))?t.offsetHeight*r.yPercent/100:0)+"px",r.z=a+"px",r.scaleX=ka(s),r.scaleY=ka(o),r.rotation=ka(u)+L,r.rotationX=ka(h)+L,r.rotationY=ka(l)+L,r.skewX=f+L,r.skewY=c+L,r.transformPerspective=d+"px",(r.zOrigin=parseFloat(N.split(" ")[2])||!e&&r.zOrigin||0)&&(F[gr]=Pr(N)),r.xOffset=r.yOffset=0,r.force3D=Y.force3D,r.renderTransform=r.svg?Er:Ve?Rr:Sr,r.uncache=0,r},Pr=function _firstTwoOnly(t){return(t=t.split(" "))[0]+" "+t[1]},Sr=function _renderNon3DTransforms(t,e){e.z="0px",e.rotationY=e.rotationX="0deg",e.force3D=0,Rr(t,e)},Ar="0deg",Dr="0px",zr=") ",Rr=function _renderCSSTransforms(t,e){var r=e||this,i=r.xPercent,n=r.yPercent,a=r.x,s=r.y,o=r.z,u=r.rotation,h=r.rotationY,l=r.rotationX,f=r.skewX,c=r.skewY,d=r.scaleX,p=r.scaleY,_=r.transformPerspective,m=r.force3D,g=r.target,v=r.zOrigin,y="",T="auto"===m&&t&&1!==t||!0===m;if(v&&(l!==Ar||h!==Ar)){var b,w=parseFloat(h)*lr,x=Math.sin(w),k=Math.cos(w);w=parseFloat(l)*lr,b=Math.cos(w),a=re(g,a,x*b*-v),s=re(g,s,-Math.sin(w)*-v),o=re(g,o,k*b*-v+v)}_!==Dr&&(y+="perspective("+_+zr),(i||n)&&(y+="translate("+i+"%, "+n+"%) "),!T&&a===Dr&&s===Dr&&o===Dr||(y+=o!==Dr||T?"translate3d("+a+", "+s+", "+o+") ":"translate("+a+", "+s+zr),u!==Ar&&(y+="rotate("+u+zr),h!==Ar&&(y+="rotateY("+h+zr),l!==Ar&&(y+="rotateX("+l+zr),f===Ar&&c===Ar||(y+="skew("+f+", "+c+zr),1===d&&1===p||(y+="scale("+d+", "+p+zr),g.style[mr]=y||"translate(0, 0)"},Er=function _renderSVGTransforms(t,e){var r,i,n,a,s,o=e||this,u=o.xPercent,h=o.yPercent,l=o.x,f=o.y,c=o.rotation,d=o.skewX,p=o.skewY,_=o.scaleX,m=o.scaleY,g=o.target,v=o.xOrigin,y=o.yOrigin,T=o.xOffset,b=o.yOffset,w=o.forceCSS,x=parseFloat(l),k=parseFloat(f);c=parseFloat(c),d=parseFloat(d),(p=parseFloat(p))&&(d+=p=parseFloat(p),c+=p),c||d?(c*=lr,d*=lr,r=Math.cos(c)*_,i=Math.sin(c)*_,n=Math.sin(c-d)*-m,a=Math.cos(c-d)*m,d&&(p*=lr,s=Math.tan(d-p),n*=s=Math.sqrt(1+s*s),a*=s,p&&(s=Math.tan(p),r*=s=Math.sqrt(1+s*s),i*=s)),r=ka(r),i=ka(i),n=ka(n),a=ka(a)):(r=_,a=m,i=n=0),(x&&!~(l+"").indexOf("px")||k&&!~(f+"").indexOf("px"))&&(x=ce(g,"x",l,"px"),k=ce(g,"y",f,"px")),(v||y||T||b)&&(x=ka(x+v-(v*r+y*n)+T),k=ka(k+y-(v*i+y*a)+b)),(u||h)&&(s=g.getBBox(),x=ka(x+u/100*s.width),k=ka(k+h/100*s.height)),s="matrix("+r+","+i+","+n+","+a+","+x+","+k+")",g.setAttribute("transform",s),w&&(g.style[mr]=s)};ja("padding,margin,Width,Radius",function(e,r){var t="Right",i="Bottom",n="Left",o=(r<3?["Top",t,i,n]:["Top"+n,"Top"+t,i+t,i+n]).map(function(t){return r<2?e+t:"border"+t+e});kr[1<r?"border"+e:e]=function(e,t,r,i,n){var a,s;if(arguments.length<4)return a=o.map(function(t){return wr(e,t,r)}),5===(s=a.join(" ")).split(a[0]).length?a[0]:s;a=(i+"").split(" "),s={},o.forEach(function(t,e){return s[t]=a[e]=a[e]||a[(e-1)/2|0]}),e.init(t,s,n)}});var Fr,Ir,Lr,Br={name:"css",register:Vd,targetTest:function targetTest(t){return t.style&&t.nodeType},init:function init(t,e,i,n,a){var s,o,u,h,l,f,c,d,p,_,m,g,v,y,T,b,w,x=this._props,k=t.style,O=i.vars.startAt;for(c in Ne||Vd(),this.styles=this.styles||Pd(t),b=this.styles.props,this.tween=i,e)if("autoRound"!==c&&(o=e[c],!mt[c]||!cc(c,e,i,n,t,a)))if(l=typeof o,f=kr[c],"function"===l&&(l=typeof(o=o.call(i,n,t,a))),"string"===l&&~o.indexOf("random(")&&(o=rb(o)),f)f(this,t,c,o,i)&&(T=1);else if("--"===c.substr(0,2))s=(getComputedStyle(t).getPropertyValue(c)+"").trim(),o+="",Et.lastIndex=0,Et.test(s)||(d=_a(s),(p=_a(o))?d!==p&&(s=ce(t,c,s,p)+p):d&&(o+=d)),this.add(k,"setProperty",s,o,n,a,0,0,c),x.push(c),b.push(c,0,k[c]);else if("undefined"!==l){if(O&&c in O?(s="function"==typeof O[c]?O[c].call(i,n,t,a):O[c],r(s)&&~s.indexOf("random(")&&(s=rb(s)),_a(s+"")||"auto"===s||(s+=Y.units[c]||_a(wr(t,c))||""),"="===(s+"").charAt(1)&&(s=wr(t,c))):s=wr(t,c),h=parseFloat(s),(_="string"===l&&"="===o.charAt(1)&&o.substr(0,2))&&(o=o.substr(2)),u=parseFloat(o),c in _r&&("autoAlpha"===c&&(1===h&&"hidden"===wr(t,"visibility")&&u&&(h=0),b.push("visibility",0,k.visibility),_d(this,k,"visibility",h?"inherit":"hidden",u?"inherit":"hidden",!u)),"scale"!==c&&"transform"!==c&&~(c=_r[c]).indexOf(",")&&(c=c.split(",")[0])),m=c in ur){if(this.styles.save(c),w=o,"string"===l&&"var(--"===o.substring(0,6)){if("calc("===(o=Sd(t,o.substring(4,o.indexOf(")")))).substring(0,5)){var M=t.style.perspective;t.style.perspective=o,o=Sd(t,"perspective"),M?t.style.perspective=M:$d(t,"perspective")}u=parseFloat(o)}if(g||((v=t._gsap).renderTransform&&!e.parseTransform||Cr(t,e.parseTransform),y=!1!==e.smoothOrigin&&v.smooth,(g=this._pt=new we(this._pt,k,mr,0,1,v.renderTransform,v,0,-1)).dep=1),"scale"===c)this._pt=new we(this._pt,v,"scaleY",v.scaleY,(_?ma(v.scaleY,_+u):u)-v.scaleY||0,xd),this._pt.u=0,x.push("scaleY",c),c+="X";else{if("transformOrigin"===c){b.push(gr,0,k[gr]),o=ge(o),v.svg?oe(t,o,0,y,0,this):((p=parseFloat(o.split(" ")[2])||0)!==v.zOrigin&&_d(this,v,"zOrigin",v.zOrigin,p),_d(this,k,c,Pr(s),Pr(o)));continue}if("svgOrigin"===c){oe(t,o,1,y,0,this);continue}if(c in Mr){ye(this,v,c,h,_?ma(h,_+o):o);continue}if("smoothOrigin"===c){_d(this,v,"smooth",v.smooth,o);continue}if("force3D"===c){v[c]=o;continue}if("transform"===c){Ae(this,o,t);continue}}}else c in k||(c=yr(c)||c);if(m||(u||0===u)&&(h||0===h)&&!pr.test(o)&&c in k)u=u||0,(d=(s+"").substr((h+"").length))!==(p=_a(o)||(c in Y.units?Y.units[c]:d))&&(h=ce(t,c,s,p)),this._pt=new we(this._pt,m?v:k,c,h,(_?ma(h,_+u):u)-h,m||"px"!==p&&"zIndex"!==c||!1===e.autoRound?xd:Bd),this._pt.u=p||0,m&&w!==o?(this._pt.b=s,this._pt.e=w,this._pt.r=Ad):d!==p&&"%"!==p&&(this._pt.b=s,this._pt.r=zd);else if(c in k)ee.call(this,t,c,s,_?_+o:o);else if(c in t)this.add(t,c,s||t[c],_?_+o:o,n,a);else if("parseTransform"!==c){S(c,o);continue}m||(c in k?b.push(c,0,k[c]):"function"==typeof t[c]?b.push(c,2,t[c]()):b.push(c,1,s||t[c])),x.push(c)}T&&be(this)},render:function render(t,e){if(e.tween._time||!je())for(var r=e._pt;r;)r.r(t,r.d),r=r._next;else e.styles.revert()},get:wr,aliases:_r,getSetter:function getSetter(t,e,r){var i=_r[e];return i&&i.indexOf(",")<0&&(e=i),e in ur&&e!==gr&&(t._gsap.x||wr(t,"x"))?r&&Ye===r?"scale"===e?Hd:Gd:(Ye=r||{})&&("scale"===e?Id:Jd):t.style&&!u(t.style[e])?Ed:~e.indexOf("-")?Fd:ue(t,e)},core:{_removeProperty:$d,_getMatrix:ne}};Fe.utils.checkPrefix=yr,Fe.core.getStyleSaver=Pd,Lr=ja((Fr="x,y,z,scale,scaleX,scaleY,xPercent,yPercent")+","+(Ir="rotation,rotationX,rotationY,skewX,skewY")+",transform,transformOrigin,svgOrigin,force3D,smoothOrigin,transformPerspective",function(t){ur[t]=1}),ja(Ir,function(t){Y.units[t]="deg",Mr[t]=1}),_r[Lr[13]]=Fr+","+Ir,ja("0:translateX,1:translateY,2:translateZ,8:rotate,8:rotationZ,8:rotateZ,9:rotateX,10:rotateY",function(t){var e=t.split(":");_r[e[1]]=Lr[e[0]]}),ja("x,y,z,top,right,bottom,left,width,height,fontSize,padding,margin,perspective",function(t){Y.units[t]="px"}),Fe.registerPlugin(Br);var Nr=Fe.registerPlugin(Br)||Fe,Ur=Nr.core.Tween;e.Back=rr,e.Bounce=nr,e.CSSPlugin=Br,e.Circ=or,e.Cubic=Qe,e.Elastic=er,e.Expo=sr,e.Linear=$e,e.Power0=Xe,e.Power1=qe,e.Power2=Ge,e.Power3=Ze,e.Power4=We,e.Quad=He,e.Quart=Je,e.Quint=Ke,e.Sine=ar,e.SteppedEase=ir,e.Strong=tr,e.TimelineLite=Gt,e.TimelineMax=Gt,e.TweenLite=te,e.TweenMax=Ur,e.default=Nr,e.gsap=Nr;if (typeof(window)==="undefined"||window!==e){Object.defineProperty(e,"__esModule",{value:!0})} else {delete e.default}});


  cachedDockMotion = module.exports.gsap
  return cachedDockMotion
}

    const QUIET_CSS = "/* Layout follows the active DeepSeek composer; the lake is the one illustrated surface. */\n.ysd-wrap[data-yunshu-theme=\"quiet\"] > .ysd-btn {\n  height:32px; gap:6px; padding:0 11px; border-radius:999px; font:inherit; font-size:13px;\n  background:transparent; color:var(--dsw-alias-label-secondary,currentColor);\n  border:1px solid var(--dsw-alias-border-l2, transparent);\n}\n.ysd-wrap[data-yunshu-theme=\"quiet\"] > .ysd-btn[aria-expanded=\"true\"],\n.ysd-wrap[data-yunshu-theme=\"quiet\"] > .ysd-btn:hover { background:var(--dsw-alias-bg-layer-2,Canvas); color:var(--dsw-alias-label-primary,CanvasText); }\n.ysd-portal[data-yunshu-theme=\"integrated\"] {\n  --surface:var(--dsw-alias-bg-layer-1, Canvas); --raised:var(--dsw-alias-bg-layer-2, Canvas);\n  --ink:var(--dsw-alias-label-primary, CanvasText); --muted:var(--dsw-alias-label-secondary, GrayText);\n  --line:var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 16%,transparent));\n  --focus:var(--dsw-alias-brand-primary,#6a95d7);\n  position:fixed; inset:0; display:block; z-index:100; pointer-events:none;\n  color:var(--ink); font-family:var(--dsh-font-family-text-default,inherit); font-size:14px; line-height:1.5;\n}\n.ysd-portal[data-yunshu-theme=\"integrated\"] .ysd-panel {\n  position:fixed; left:var(--dock-left); top:var(--dock-top); bottom:auto; right:auto;\n  width:var(--dock-width); height:var(--dock-height); max-height:none; display:flex; flex-direction:column;\n  border:1px solid var(--line); border-radius:var(--dsw-radius-lg,16px); color:var(--ink);\n  background:var(--surface); box-shadow:0 8px 28px rgba(0,0,0,.16); pointer-events:auto; animation:none;\n  container-type:inline-size; min-width:0; isolation:isolate;\n}\n.ysd-portal[data-yunshu-theme=\"integrated\"] .ysd-panel::before { display:none; }\n.ysd-portal[data-yunshu-theme=\"integrated\"] .ysd-panel[data-closing=\"1\"] { opacity:0; transition:opacity .12s ease; pointer-events:none; }\n.ysd-portal[data-yunshu-theme=\"integrated\"] .ysd-backdrop { display:none; }\n.ysd-panel > .ysd-head {\n  height:44px; min-height:36px; padding:0 12px 0 15px; display:flex; align-items:center; gap:8px;\n  flex:0 0 auto; z-index:3; background:var(--surface);\n}\n.ysd-panel .ysd-title { margin:0; font:inherit; font-weight:600; font-size:14px; letter-spacing:0; color:var(--ink); }\n.ysd-panel .dock-mark, .ysd-panel .ysq-icon { display:inline-flex; align-items:center; justify-content:center; }\n.ysd-panel .dock-mark { width:20px; color:var(--muted); }\n.ysd-panel :is(.dock-mark,.ysq-icon,.dock-menu,.dock-modules,.dock-check) svg { width:17px; height:17px; flex-shrink:0; }\n.ysd-panel .dock-tools { margin-left:auto; display:flex; align-items:center; gap:3px; }\n.ysd-panel .ysq-icon {\n  appearance:none; width:32px; height:32px; padding:0; border:0; border-radius:8px; cursor:pointer;\n  color:var(--muted); background:transparent; font:inherit;\n}\n.ysd-panel .ysq-icon[aria-pressed=\"true\"], .ysd-panel .ysq-icon:hover, .ysd-panel .ysq-icon[aria-expanded=\"true\"] { background:var(--raised); color:var(--ink); }\n.ysd-panel .sr-music span { font-size:19px; line-height:1; }\n.ysd-panel .dock-back { margin-left:-7px; }\n.ysd-panel .dock-more { position:relative; }\n.ysd-panel .dock-menu {\n  position:absolute; right:0; top:calc(100% + 5px); z-index:4; min-width:144px; padding:4px; display:grid;\n  background:var(--raised); border:1px solid var(--line); border-radius:11px; box-shadow:0 6px 18px #0003;\n}\n.ysd-panel .dock-menu button, .ysd-panel .dock-modules button, .ysd-panel .dock-list button {\n  background:transparent; cursor:pointer; color:var(--muted); border:0; border-radius:8px;\n  font:inherit; font-size:13px; display:flex; align-items:center; gap:7px; min-width:0;\n}\n.ysd-panel .dock-menu button { padding:8px 10px; color:var(--ink); }\n.ysd-panel .dock-menu button:hover, .ysd-panel .dock-menu button:focus-visible { background:var(--surface); }\n.ysd-panel .ysq-art {\n  position:relative; min-height:0; flex:0 0 min(54px,10%); overflow:hidden;\n  background-image:var(--lake-poster); background-position:center 42%; background-size:cover; pointer-events:none;\n}\n.ysd-panel[data-scene=\"home\"] .ysq-art { flex:1 1 auto; background-position:center; }\n.ysd-panel .sr-lake-film { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; object-position:center 42%; }\n.ysd-panel[data-scene=\"home\"] .sr-lake-film { object-position:center; }\n.ysd-panel .sr-veil { position:absolute; inset:0; background:linear-gradient(90deg,rgba(15,21,32,.27),transparent); }\n.ysd-panel[data-scene=\"home\"] .sr-veil { display:none; }\n.ysd-panel .dock-modules {\n  box-sizing:border-box; flex:0 0 auto; max-height:none; display:flex; align-items:center; justify-content:flex-start;\n  padding:6px 10px; gap:4px; min-height:47px; overflow:auto; scrollbar-width:thin; background:var(--surface);\n}\n.ysd-panel .dock-modules .ysd-item { width:auto; min-height:34px; justify-content:center; padding:5px clamp(8px,2.1cqw,16px); white-space:nowrap; }\n.ysd-panel .dock-modules button:hover, .ysd-panel .dock-list button:hover { background:var(--raised); color:var(--ink); }\n.ysd-panel .dock-modules :is(small,svg) { color:var(--muted); }\n.ysd-panel .ysd-pbody { flex:1 1 auto; min-height:0; max-height:none; padding:16px 20px 20px; overflow:auto; overscroll-behavior:contain; scrollbar-width:thin; color:var(--ink); }\n.ysd-panel .ysd-pbody :is(h2,h3) { color:var(--ink); line-height:1.45; font-weight:600; letter-spacing:0; }\n.ysd-panel .ysd-pbody h2 { font-size:19px; margin:5px 0 11px; }\n.ysd-panel .ysd-pbody h3 { font-size:14px; margin:0 0 7px; }\n.ysd-panel .ysd-pbody p { overflow-wrap:anywhere; line-height:1.55; }\n.ysd-panel .ysd-pbody :is(button,input,textarea,select) {\n  font:inherit; font-size:13px; color:var(--ink); background:var(--raised); border:1px solid var(--line); border-radius:8px; box-sizing:border-box;\n}\n.ysd-panel .ysd-pbody :is(input:not([type=\"checkbox\"]):not([type=\"range\"]),textarea,select) { max-width:100%; padding:6px 8px; }\n.ysd-panel .ysd-pbody textarea { display:block; width:100%; min-height:64px; resize:vertical; }\n.ysd-panel .ysd-pbody button { padding:5px 10px; min-height:30px; cursor:pointer; }\n.ysd-panel .ysd-pbody button:hover:not(:disabled) { border-color:var(--muted); }\n.ysd-panel .ysd-pbody button:disabled { opacity:.48; cursor:default; }\n.ysd-panel .ysd-pbody :is(button.sr-primary,button.ysq-primary-action) { color:var(--surface); background:var(--ink); border-color:var(--ink); }\n.ysd-panel .ysd-pbody :is(.ys-plugin,.ys-embedded-panel,.sr-board) { color:var(--ink); font:inherit; font-size:13px; min-width:0; }\n.ysd-panel .ysd-pbody :is(.ysq-memory-section,.sr-section,.ysq-memory-details,.ysq-memory-record) { border-top:1px solid var(--line); margin:12px 0 0; padding:12px 0 0; }\n.ysd-panel .ysd-pbody :is(.ysq-memory-actions,.ysq-memory-search,.sr-actions) { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }\n.ysd-panel .ysq-memory-search input { flex:1; min-width:90px; }\n.ysd-panel .ysq-memory-stats { display:flex; flex-wrap:wrap; gap:14px; margin:6px 0 12px; }\n.ysd-panel .ysq-memory-stats > div { display:flex; gap:4px; align-items:baseline; color:var(--muted); }\n.ysd-panel .ysq-memory-stats strong { color:var(--ink); }\n.ysd-panel :is(.sr-meta,.sr-section-head,.sr-step-top,.sr-history li>div,.dock-diagnostic-tools) { display:flex; gap:10px; align-items:center; justify-content:space-between; }\n.ysd-panel :is(.sr-meta,.sr-section-head span,.sr-history time,.sr-muted,.ysq-memory-status,.ysq-memory-record-meta,.dock-diagnostic-tools,.sr-step-top span) { font-size:12px; color:var(--muted); }\n.ysd-panel :is(.sr-steps,.sr-history) { list-style:none; padding:0; margin:6px 0 0; }\n.ysd-panel :is(.sr-steps li,.sr-history li) { border-top:1px solid var(--line); padding:8px 0; overflow-wrap:anywhere; }\n.ysd-panel .sr-step-top { justify-content:flex-start; }\n.ysd-panel .sr-step-top button { margin-left:auto; }\n.ysd-panel .sr-board :is(p,blockquote) { margin:6px 0; white-space:pre-wrap; }\n.ysd-panel .sr-board blockquote { padding-left:10px; border-left:2px solid var(--line); }\n.ysd-panel .sr-picker, .ysd-panel .sr-editor label { display:grid; gap:4px; margin:8px 0; }\n.ysd-panel .sr-editor { margin:10px 0; }\n.ysd-panel .ysd-pbody :is(summary,label) { color:var(--ink); }\n.ysd-panel summary { cursor:pointer; }\n.ysd-panel .dock-check { border-bottom:1px solid var(--line); }\n.ysd-panel .dock-check > summary { list-style:none; display:flex; align-items:center; gap:8px; min-height:43px; padding:0 2px; }\n.ysd-panel .dock-check > summary::-webkit-details-marker { display:none; }\n.ysd-panel .dock-check-state { margin-left:auto; color:var(--muted); font-size:12px; }\n.ysd-panel .dock-check > summary svg { width:13px; height:13px; color:var(--muted); }\n.ysd-panel .dock-check[open] > summary svg { transform:rotate(90deg); }\n.ysd-panel .dock-check-detail { color:var(--muted); padding:0 16px 10px 2px; font-size:13px; }\n.ysd-panel .dock-check-detail p { margin:0 0 6px; }\n.ysd-panel .dock-check-detail :is(code,time) { display:block; overflow-wrap:anywhere; margin-top:4px; font-size:11px; }\n.ysd-panel .dock-check[data-state=\"warn\"] .dock-check-state, .ysd-panel .dock-warning { color:var(--dsw-alias-state-warn-primary,var(--ink)); }\n.ysd-panel :focus-visible, .ysd-wrap > .ysd-btn:focus-visible { outline:2px solid var(--focus,Highlight); outline-offset:-2px; }\n@container (max-width:430px) {\n  .ysd-panel .dock-modules { padding:5px; gap:1px; }\n  .ysd-panel .dock-modules .ysd-item { flex:1; padding:4px 2px; gap:3px; font-size:12px; }\n  .ysd-panel .dock-modules .ysd-item svg { width:14px; height:14px; }\n  .ysd-panel .ysd-pbody { padding:10px 12px 14px; }\n}\n@media (prefers-reduced-motion: reduce) {\n  .ysd-panel .sr-lake-film[data-motion=\"off\"] { display:none; }\n  .ysd-portal[data-yunshu-theme=\"integrated\"] .ysd-panel[data-closing=\"1\"] { transition:none; }\n}\n\n.ysd-portal[data-yunshu-theme=\"integrated\"]{--lake-poster:url(\"/api/yunshu/avalon-r39/poster.webp\")}\n\n.ysd-panel .ys-avalon-arrival{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:center 42%;pointer-events:none}\n.ysd-panel[data-scene=\"home\"] .ysq-art{background-position:center 66%}\n.ysd-panel[data-scene=\"home\"] .ys-avalon-arrival,.ysd-panel[data-scene=\"home\"] .sr-lake-film{object-position:center 66%}\n.ys-master-switch.ys-just-enabled .ys-switch-track{animation:ys-awakening .85s ease-out both}\n.ys-activation-film{position:fixed;z-index:1000;aspect-ratio:7/3;object-fit:cover;border-radius:12px;box-shadow:0 10px 34px #080c2470;pointer-events:none;animation:ys-activation-film 2.25s ease-in-out both}\n@keyframes ys-activation-film{0%{opacity:0}12%,85%{opacity:1}100%{opacity:0}}\n@keyframes ys-awakening{0%{box-shadow:0 0 0 0 #d8bd7988}65%{box-shadow:0 0 0 6px #d8bd7925}100%{box-shadow:0 0 0 10px transparent}}\n@media(prefers-reduced-motion:reduce){.ys-master-switch.ys-just-enabled .ys-switch-track{animation:none}}\n";
    const lakePreferenceKey = 'yunshu.lake.motion';
const lakePreferenceEvent = 'yunshu:lake-motion';
let lakeOverride;
function lakeMotionEnabled() {
  let choice = lakeOverride;
  try { choice = localStorage.getItem(lakePreferenceKey) || choice; } catch {}
  if (choice === 'play' || choice === 'pause') return choice === 'play';
  return !matchMedia('(prefers-reduced-motion: reduce)').matches;
}
function watchLakeMotion(notify) {
  const media = matchMedia('(prefers-reduced-motion: reduce)');
  media.addEventListener('change', notify);
  window.addEventListener(lakePreferenceEvent, notify);
  window.addEventListener('storage', notify);
  return () => {
    media.removeEventListener('change', notify);
    window.removeEventListener(lakePreferenceEvent, notify);
    window.removeEventListener('storage', notify);
  };
}
function LakeButton() {
  const moving = React.useSyncExternalStore(watchLakeMotion, lakeMotionEnabled);
  const label = moving ? '暂停动态背景' : '播放动态背景';
  const toggle = () => {
    lakeOverride = lakeMotionEnabled() ? 'pause' : 'play';
    try { localStorage.setItem(lakePreferenceKey, lakeOverride); } catch {}
    window.dispatchEvent(new Event(lakePreferenceEvent));
  };
  return h('button', {type:'button', className:'ysq-icon', title:label, 'aria-label':label, 'aria-pressed':moving, onClick:toggle},
    h('svg', {viewBox:'0 0 20 20', width:16, height:16, fill:'none', stroke:'currentColor', strokeWidth:1.6, strokeLinecap:'round', strokeLinejoin:'round', 'aria-hidden':true},
      moving ? h('path', {d:'M7.1 4.9v10.2m5.8-10.2v10.2'}) : h('path', {d:'m6.1 3.9 9 6.1-9 6.1z'})));
}
const avalonUrl=name=>new URL('api/yunshu/avalon-r39/'+name,document.baseURI).href;
function ActivationFilm({enabled,open,anchor}){
  const previous=React.useRef(enabled),[geometry,setGeometry]=React.useState(null);
  React.useEffect(()=>{
    const justEnabled=previous.current===false && enabled===true;
    previous.current=enabled;
    if(open||!enabled){setGeometry(null);return;}
    if(!justEnabled||!lakeMotionEnabled()||document.hidden||!anchor.current)return;
    const r=anchor.current.getBoundingClientRect(),width=Math.min(412,window.innerWidth-24);
    const left=Math.max(12,Math.min(window.innerWidth-width-12,r.left+r.width*.5-width*.5));
    setGeometry({left,top:Math.max(12,r.top-52-width*3/7),width});
    const timer=setTimeout(()=>setGeometry(null),4300);
    return ()=>clearTimeout(timer);
  },[enabled,open,anchor]);
  if(!geometry||open||!enabled)return null;
  return ReactDOM.createPortal(h('video',{className:'ys-activation-film','aria-hidden':true,style:geometry,src:avalonUrl('arrival.webm'),
    muted:true,autoPlay:true,playsInline:true,disablePictureInPicture:true,onEnded:()=>setGeometry(null),onError:()=>setGeometry(null)}),document.body);
}
function StarLake(){
  const moving=React.useSyncExternalStore(watchLakeMotion,lakeMotionEnabled);
  const video=React.useRef(null),intro=React.useRef(null);
  const visible=()=>!document.hidden && window.outerWidth>200 && window.outerHeight>40;
  const [onScreen,setOnScreen]=React.useState(visible);
  const [enter,setEnter]=React.useState(()=>lakeMotionEnabled() && visible());
  const [gif,setGif]=React.useState(false);
  const reached=React.useRef(0);
  const filmSrc=avalonUrl('meadow.webm'),entrySrc=avalonUrl('arrival.webm');
  React.useEffect(()=>{
    const sync=()=>setOnScreen(visible());
    document.addEventListener('visibilitychange',sync);window.addEventListener('resize',sync);sync();
    return ()=>{document.removeEventListener('visibilitychange',sync);window.removeEventListener('resize',sync);};
  },[]);
  const playing=moving&&onScreen;
  React.useEffect(()=>{
    const node=video.current;
    if(!playing){setEnter(false);node?.pause();return;}
    if(!node||gif||enter)return;
    let active=true,last=node.currentTime,lastAdvance=performance.now(),repairs=0,inPlay=false;
    function resume(rewind){
      if(!active||!visible()||inPlay)return;
      if(rewind||node.ended){try{node.currentTime=0;}catch{}}
      inPlay=true;
      node.play().catch(e=>{if(active && e.name!=='AbortError')setGif(true);}).finally(()=>{inPlay=false;});
    }
    const again=()=>resume(true),buffered=()=>{
      if(reached.current){node.currentTime=reached.current;reached.current=0;}
      resume(false);
    };
    node.loop=true;node.muted=true;
    node.addEventListener('ended',again);node.addEventListener('canplay',buffered);resume(false);
    const monitor=setInterval(()=>{
      if(!visible())return;
      const now=performance.now();
      if(Math.abs(node.currentTime-last)>.001){last=node.currentTime;lastAdvance=now;repairs=0;return;}
      if(node.ended||node.paused){resume(node.ended);}
      if(now-lastAdvance>3200){
        lastAdvance=now;
        if(++repairs>=3){setGif(true);return;}
        if(node.readyState>=2)resume(!Number.isFinite(node.duration)||node.duration-node.currentTime<.35);
        else{node.load();resume(false);}
      }
    },500);
    return ()=>{active=false;clearInterval(monitor);node.removeEventListener('ended',again);node.removeEventListener('canplay',buffered);node.pause();};
  },[playing,gif,enter,filmSrc]);
  React.useEffect(()=>{
    if(!enter||!playing)return;
    const movie=intro.current;
    let active=true;
    movie?.play().catch(()=>{if(active)setEnter(false);});
    // A rejected or interrupted opening may never produce an ended event.
    const timer=setTimeout(()=>{if(active)setEnter(false)},5500);
    return ()=>{active=false;clearTimeout(timer);};
  },[enter,playing,entrySrc]);
  return h('div',{className:'ysq-art','aria-hidden':true},
    gif ? (playing&&h('img',{className:'sr-lake-film',src:avalonUrl('meadow.gif'),alt:'','data-motion':'on'})):
      !enter&&h('video',{className:'sr-lake-film',ref:video,src:filmSrc,poster:avalonUrl('poster.webp'),muted:true,autoPlay:playing,loop:true,playsInline:true,
        preload:playing?'auto':'none','data-motion':moving?'on':'off',onError:()=>setGif(true)}),
    enter&&playing&&h('video',{className:'ys-avalon-arrival',ref:intro,src:entrySrc,muted:true,autoPlay:true,playsInline:true,preload:'auto',
      onEnded:e=>{reached.current=e.currentTarget.duration;setEnter(false);},onError:()=>setEnter(false)}),
    h('div',{className:'sr-veil'}));
}

function MusicButton({closing}){
  const track=React.useRef(null),context=React.useRef({closing,mic:Boolean(window.__yunshuLakeMicActive)});
  const [state,setState]=React.useState('off');
  context.current.closing=closing;
  function volume(){const a=track.current;if(a)a.volume=context.current.closing||document.hidden ? 0 : context.current.mic ? .12 : .59;}
  function stop(){const a=track.current;track.current=null;if(a){a.onerror=null;a.pause();a.removeAttribute('src');a.load();}}
  async function toggle(){
    if(track.current){stop();setState('off');return;}
    const a=new Audio(avalonUrl('lake-nocturne.mp3'));track.current=a;a.loop=true;a.preload='auto';volume();
    const failed=()=>{if(track.current===a){stop();setState('failed');}};a.onerror=failed;setState('on');
    try{await a.play();}catch{failed();}
  }
  React.useEffect(()=>{
    const voice=e=>{context.current.mic=Boolean(e.detail?.mic);volume();};
    window.addEventListener('yunshu:voice-state',voice);document.addEventListener('visibilitychange',volume);
    return ()=>{window.removeEventListener('yunshu:voice-state',voice);document.removeEventListener('visibilitychange',volume);stop();};
  },[]);
  React.useEffect(volume,[closing]);
  const label=state==='on'?'关闭背景音乐':state==='failed'?'音乐未能播放，点击重试':'播放背景音乐';
  return h('button',{type:'button',className:'ysq-icon sr-music','aria-label':label,title:label+' · 湖畔夜曲 · 云舒','aria-pressed':state==='on',onClick:toggle},h('span',{'aria-hidden':true},state==='on'?'♫':'♪'));
}

function sceneName(panel, level) {
  if (!panel) return level || 'home'
  const id = panel.key.toLowerCase()
  if (id.includes('united')) return 'tasks'
  if (id.includes('voice')) return 'voice'
  if (id.includes('memory')) return 'memory'
  if (id.includes('persona')) return 'persona'
  return 'status'
}

function composerFor(button) {
  return button?.closest('[data-composer-card="true"]') ||
    [...document.querySelectorAll('[data-composer-card="true"]')].find(el => el.getBoundingClientRect().width) ||
    button?.closest('form') || button?.parentElement
}

function fitDock(drawer, card) {
  if (!card) return
  const anchor = card.getBoundingClientRect()
  const view = window.visualViewport
  const vx = view?.offsetLeft || 0, vy = view?.offsetTop || 0
  const right = vx + (view?.width || window.innerWidth) - 8
  const bottom = vy + (view?.height || window.innerHeight) - 8
  const content = card.closest('[data-conversation-content]') || card.closest('main,[role="main"]')
  const nativeMenu = document.querySelector('[data-windows-menu]')
  const ceiling = Math.max(vy + 12, (nativeMenu?.getBoundingClientRect().bottom || 0) + 8,
    (content?.getBoundingClientRect().top || 0) + 4)
  const left = Math.max(vx + 8, anchor.left)
  const width = Math.max(1, Math.min(anchor.right, right) - left)
  const topEdge = anchor.top - 8, bottomEdge = anchor.bottom + 8
  const above = Math.max(0, topEdge - ceiling), below = Math.max(0, bottom - bottomEdge)
  const home = drawer.dataset.scene === 'home'
  const wanted = home ? Math.round(width * 0.398) + 93 : 548
  const up = above >= Math.min(wanted, 250) || above >= below
  const height = Math.max(1, Math.min(wanted, up ? above : below))
  drawer.style.setProperty('--dock-left', left + 'px')
  drawer.style.setProperty('--dock-top', (up ? topEdge - height : bottomEdge) + 'px')
  drawer.style.setProperty('--dock-width', width + 'px')
  drawer.style.setProperty('--dock-height', height + 'px')
}

function useDockLayout(open, scene, panelRef, buttonRef) {
  React.useLayoutEffect(() => {
    if (!open || !panelRef.current) return
    const drawer = panelRef.current, card = composerFor(buttonRef.current)
    const update = () => fitDock(drawer, card)
    update()
    let frame = 0
    const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; update() }) }
    const observer = new ResizeObserver(schedule)
    if (card) {
      observer.observe(card)
      const content = card.closest('[data-conversation-content]') || card.closest('main,[role="main"]')
      if (content) observer.observe(content)
    }
    observer.observe(document.documentElement)
    window.addEventListener('resize', schedule)
    document.addEventListener('scroll', schedule, true)
    window.visualViewport?.addEventListener('resize', schedule)
    window.visualViewport?.addEventListener('scroll', schedule)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', schedule)
      document.removeEventListener('scroll', schedule, true)
      window.visualViewport?.removeEventListener('resize', schedule)
      window.visualViewport?.removeEventListener('scroll', schedule)
    }
  }, [open, scene, panelRef, buttonRef])
}

function useDockMotion(open, scene, panelRef) {
  React.useLayoutEffect(() => {
    if (!open || !panelRef.current) return
    const target = panelRef.current.querySelector('.ysd-pbody, .ysd-body')
    const gsap = dockMotionLibrary()
    const media = gsap.matchMedia()
    media.add('(prefers-reduced-motion: no-preference)', () => {
      if (target) gsap.fromTo(target, { opacity: 0, y: 4 }, { opacity: 1, y: 0, duration: .19, ease: 'power2.out', clearProps: 'opacity,transform' })
    })
    return () => media.revert()
  }, [open, scene, panelRef])
}

    /* ------------------------------------------------------------------ *
     * 注册表
     * ------------------------------------------------------------------ */

    const GROUPS = [
      { id: 'status', no: '01', label: '状态' },
      { id: 'panel', no: '02', label: '面板' },
      { id: 'mode', no: '03', label: '模式' },
      { id: 'more', no: '04', label: '更多' },
    ]
    const GROUP_IDS = new Set(GROUPS.map(g => g.id))

    const listeners = new Set()
    const entries = window.__yunshuDockRegistry || (window.__yunshuDockRegistry = new Map()) // key = group + '/' + id

    function register(entry) {
      if (!entry || typeof entry !== 'object') return () => {}
      const group = GROUP_IDS.has(entry.group) ? entry.group : 'more'
      const id = String(entry.id || '')
      if (!id) return () => {}
      const key = group + '/' + id
      const current = { ...entry, group, id }
      entries.set(key, current)
      notify()
      return () => {
        // 热更新时旧插件的清理晚于新注册；旧清理不得删掉新条目。
        if (entries.get(key) !== current) return
        entries.delete(key)
        notify()
      }
    }

    function notify() {
      for (const fn of [...listeners]) {
        try { fn() } catch { /* 单个订阅者出错不影响别人 */ }
      }
    }

    function subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    }

    function snapshot() {
      const out = []
      for (const e of entries.values()) {
        let status = 'unknown'
        let describe = ''
        try { status = e.status?.() || 'unknown' } catch { status = 'unknown' }
        try { describe = e.describe?.() || '' } catch { describe = '' }
        out.push({ ...e, status, describe })
      }
      return out
    }

    // 全局可发现，别的插件在 apply 时用可选链注册，dock 没加载也不会炸
    const dockApi = {
      register,
      version: 2,
    }
    window.__yunshuDock = dockApi

const healthText = { ok: '检查通过', warn: '需要检查', late: '检查已过期', unknown: '待验证', idle: '空闲' }

function Diagnostics({ extraEntries, activate }) {
  useSnapshot()
  const health = window.__yunshuHealth
  const rows = (health?.snapshot() || []).filter(row => row.visibleInDock)
  const [refreshing, setRefreshing] = React.useState(false)
  async function refresh() {
    setRefreshing(true)
    try { await health?.refresh({ force: true, trigger: 'diagnostics' }) }
    finally { setRefreshing(false) }
  }
  return h('section', { className: 'dock-diagnostics', 'aria-label': '运行诊断' },
    h('div', { className: 'dock-diagnostic-tools' },
      h('span', null, '当前工作区'), h('button', { type: 'button', disabled: !health || refreshing, onClick: refresh }, refreshing ? '正在检查…' : '重新检查')),
    !rows.length && h('p', { role: 'status' }, '正在连接检查服务…'),
    ...rows.map(row => h('details', { key: row.id, className: 'dock-check', 'data-health': row.id, 'data-state': row.state },
      h('summary', null, h('span', null, row.label),
        h('span', { className: 'dock-check-state' }, row.state === 'idle' && row.facets?.availability === 'disabled' ? '未启用' : healthText[row.state]),
        h(ChevronIcon, {})),
      h('div', { className: 'dock-check-detail' }, h('p', null, row.reason), h('p', null, row.nextAction),
        row.checkedAt && h('time', { dateTime: row.checkedAt }, '采样时间 ' + new Date(row.checkedAt).toLocaleString('zh-CN', { hour12: false })),
        row.evidence && h('code', null, row.evidence)))),
    ...extraEntries.filter(entry => !rows.some(row => entry.id === 'health-' + row.id)).map(row =>
      h('button', { key: row.id, type: 'button', onClick: () => activate({ kind: 'entry', key: row.group + '/' + row.id, row }) }, row.label || row.id)))
}

function DockGlyph({ name }) {
  const path = {
    '任务台': 'M5 5h14v14H5z M8 10l1 1 2-3 M13 10h3 M8 15h8',
    '记忆': 'M4 5.5c3-1 5.5-.5 8 1 2.5-1.5 5-2 8-1V18c-3-1-5.5-.5-8 1-2.5-1.5-5-2-8-1z M12 6.5v12',
    '语音': 'M4 10v4 M8 7v10 M12 4v16 M16 8v8 M20 10v4',
    '人格': 'M8.5 8a3.5 3.5 0 1 0 7 0 3.5 3.5 0 0 0-7 0 M5.5 19c.6-3 2.8-5 6.5-5s5.9 2 6.5 5',
    '媒体': 'M4 5h16v14H4z M5 16l4-4 3 3 3-4 4 5 M8 8.5h.1',
    '运行诊断': 'M3 12h4l2-5 4 10 2-5h6',
    '更多': 'M5 12h.5 M11.75 12h.5 M18.5 12h.5',
  }
  return h('svg', { ...ICON_CLOUD, 'aria-hidden': true, focusable: false }, h('path', { d: path[name] || 'M5 6h14v12H5z', strokeWidth: name === '更多' ? 3 : 1.55 }))
}

function useFeatures() {
  const hub=window.__yunshuControlUI;
  return React.useSyncExternalStore(hub.subscribe,hub.snapshot);
}
function FeatureSwitch({id,state,compact=false}) {
  const value=state.preferences?.[id]===true;
  const previous=React.useRef(value), pulse=React.useRef(null);
  React.useEffect(()=>{
    const el=pulse.current;
    if(compact && el && value && !previous.current){el.classList.remove('ys-just-enabled');void el.offsetWidth;el.classList.add('ys-just-enabled');}
    previous.current=value;
  },[value,compact]);
  const label=state.labels[id] || (id==='master'?'云舒总开关':id);
  return h('button',{type:'button',role:'switch','aria-checked':value,'aria-label':label,
    title:label+' · '+(value?'已开启':'已关闭'),disabled:state.busy||!state.preferences,
    ref:pulse,className:'ys-feature-switch'+(compact?' ys-master-switch':''),onClick:()=>void window.__yunshuControlUI.update(id,!value)},
    !compact&&h('span',null,label),h('span',{className:'ys-switch-track','aria-hidden':true},h('i')));
}
function FeatureSettings({state}) {
  React.useEffect(()=>{
    const refresh=()=>void window.__yunshuControlUI.refresh();
    refresh();
    const timer=setInterval(refresh,3000);
    return ()=>clearInterval(timer);
  },[]);
  return h('section',{className:'ys-features','aria-label':'功能开关'},
    state.error && h('p',{role:'alert'},state.error,' ',h('button',{type:'button',onClick:()=>window.__yunshuControlUI.read()},'重试')),
    state.preferences ? h(React.Fragment,null,
      !state.preferences.master && h('p',null,'云舒已暂停。输入框旁的总开关可以恢复这些功能。'),
      Object.keys(state.labels).filter(key=>key!=='master').map(key=>h(FeatureSwitch,{key,id:key,state})),
      state.extensions?.length>0&&h('details',null,h('summary',null,'已接入的扩展'),...state.extensions.map(ext=>h('p',{key:ext.id},ext.label+' · '+ext.tools.join('、'))))) :
        !state.error&&h('p',{role:'status'},'正在连接功能设置…'));
}

function DockMore({ groups, activate, openDiagnostics, openFeatures }) {
  const [shown, setShown] = React.useState(false)
  const area = React.useRef(null), trigger = React.useRef(null)
  React.useLayoutEffect(() => {
    if (!shown) return
    area.current?.querySelector('[role="menuitem"]')?.focus()
    const outside = event => { if (!area.current?.contains(event.target)) setShown(false) }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('focusin', outside)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('focusin', outside)
    }
  }, [shown])
  function choose(callback) { setShown(false); callback() }
  function keys(event) {
    if (!shown) return
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); setShown(false); trigger.current?.focus(); return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const buttons = [...area.current.querySelectorAll('[role="menuitem"]')]
    event.preventDefault(); event.stopPropagation()
    let i = buttons.indexOf(document.activeElement)
    if (event.key === 'Home') i = 0
    else if (event.key === 'End') i = buttons.length - 1
    else i = (i + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length
    buttons[i]?.focus()
  }
  return h('div', { className: 'dock-more', ref: area, onKeyDown: keys },
    h('button', { type: 'button', ref: trigger, className: 'ysq-icon', title: '更多', 'aria-label': '更多', 'aria-haspopup': 'menu', 'aria-expanded': shown, onClick: () => setShown(v => !v) }, h(DockGlyph, { name: '更多' })),
    shown && h('div', { className: 'dock-menu', role: 'menu', 'aria-label': '更多操作' },
      h('button',{type:'button',role:'menuitem',onClick:()=>choose(openFeatures)},'功能开关'),
      h('button', { type: 'button', role: 'menuitem', onClick: () => choose(openDiagnostics) }, h(DockGlyph, { name: '运行诊断' }), '运行诊断'),
      ...groups.map(it => h('button', { key: it.key, type: 'button', role: 'menuitem', onClick: () => choose(() => activate(it)) }, it.group.label))))
}

    // 补放早到者：profile 的 bundle 顺序里 desktop 排在 dock 前面，它 apply 时
    // __yunshuDock 还不存在，只能把条目推进 __yunshuDockQueue。这里排空队列，
    // 否则那些插件会一直挂在队列里、面板永远不出现。
    try {
      const early = window.__yunshuDockQueue
      if (Array.isArray(early)) {
        window.__yunshuDockQueue = []
        for (const entry of early) {
          try { register(entry) } catch (error) {
            try { console.error('[yunshu-dock] queued entry failed:', entry && entry.id, error) } catch { /* ignore */ }
          }
        }
      }
    } catch { /* ignore */ }

    /* ------------------------------------------------------------------ *
     * 样式（全部走主题变量，深浅色都成立）
     * ------------------------------------------------------------------ */

    const CSS = `
.ys-feature-switch{display:flex;gap:14px;align-items:center;justify-content:space-between;background:transparent;color:inherit;border:0;cursor:pointer;font:inherit;min-height:36px;text-align:left}
.ys-features{max-width:520px;margin:0 auto;color:inherit}.ys-features>.ys-feature-switch{width:100%;padding:6px 4px;border-bottom:1px solid var(--line,rgba(128,128,128,.24))}
.ys-features details{margin-top:12px}.ys-switch-track{display:inline-flex;align-items:center;box-sizing:border-box;width:28px;height:16px;border:1px solid var(--dsw-alias-border-l2,#777);border-radius:20px;background:var(--dsw-alias-bg-layer-2,#484b4e);padding:2px}
.ys-switch-track i{display:block;width:10px;height:10px;border-radius:50%;background:var(--dsw-alias-label-secondary,#bbb)}.ys-feature-switch[aria-checked=true] .ys-switch-track{background:#6689aa;border-color:#6689aa}.ys-feature-switch[aria-checked=true] i{margin-left:auto;background:white}
.ys-master-switch{min-height:28px;padding:2px 3px;margin-inline-start:2px}.ys-master-switch .ys-switch-track{width:24px;height:14px}.ys-master-switch i{width:8px;height:8px}
.ysd-panel [aria-label="编辑个人规则"] textarea{box-sizing:border-box}.ysd-panel .ys-history{padding:7px 0}.ysd-panel .ys-history summary{cursor:pointer;min-height:26px}.ysd-panel .ys-history article{margin:5px 0}

.ysd-wrap{position:relative;display:inline-flex;align-items:center}
.ysd-btn{appearance:none;box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;
  height:28px;padding:0 9px;border-radius:8px;white-space:nowrap;cursor:pointer;font:inherit;
  font-size:12px;line-height:1;color:inherit;background:transparent;
  border:1px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 20%,transparent));
  transition:background .15s ease,border-color .15s ease}
.ysd-btn:hover{background:var(--dsw-alias-bg-layer-2,color-mix(in srgb,currentColor 10%,transparent))}
.ysd-btn:disabled{opacity:.45;cursor:default}
.ysd-btn svg{width:14px;height:14px;flex:0 0 auto;opacity:.85}
.ysd-dots{display:inline-flex;align-items:center;gap:3px}
.ysd-dot{width:6px;height:6px;border-radius:50%;flex:0 0 auto;
  background:var(--dsw-alias-state-idle-primary,#888)}
.ysd-dot[data-s="ok"]{background:var(--dsw-alias-state-success-primary,#2e6b53)}
.ysd-dot[data-s="warn"]{background:var(--dsw-alias-state-warn-primary,#805e29)}
.ysd-dot[data-s="late"]{background:var(--dsw-alias-state-error-primary,#9a4a4e)}
.ysd-dot[data-s="unknown"]{box-sizing:border-box;background:transparent;
  border:1px solid var(--dsw-alias-label-tertiary,#8c9098)}

.ysd-panel{position:absolute;bottom:calc(100% + 8px);left:0;z-index:60;width:330px;box-sizing:border-box;
  transform-origin:bottom left;display:flex;flex-direction:column;gap:0;overflow:hidden;
  border-radius:12px;
  border:1px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 20%,transparent));
  background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-base,Canvas));
  color:var(--dsw-alias-label-primary,CanvasText);
  box-shadow:0 2px 6px rgba(0,0,0,.18),0 12px 32px rgba(0,0,0,.22);
  animation:ysd-grow .16s ease-out}
@keyframes ysd-grow{from{opacity:0;transform:translateY(4px) scaleY(.94)}
  to{opacity:1;transform:translateY(0) scaleY(1)}}
.ysd-panel::before{content:"";position:absolute;inset:0;pointer-events:none;border-radius:12px;
  background:linear-gradient(to bottom,var(--dsw-alias-border-l2,transparent),transparent 22%)}
.ysd-head{position:relative;display:flex;flex:0 0 auto;align-items:center;gap:8px;padding:10px 12px 8px}
.ysd-title{font-size:12px;font-weight:600;letter-spacing:.02em;flex:1 1 auto}
.ysd-kbd{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;opacity:.5}
.ysd-body{position:relative;flex:1 1 auto;min-height:0;max-height:min(58vh,420px);overflow:auto;padding-bottom:6px}
.ysd-pbody{position:relative;flex:1 1 auto;min-height:0;max-height:min(64vh,520px);overflow:auto;padding:2px 10px 10px}
.ysd-group{padding:6px 6px 2px}
.ysd-gtitle{display:flex;align-items:baseline;gap:8px;padding:4px 6px;font-size:11px;opacity:.75}
.ysd-gno{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;opacity:.55}
.ysd-gsum{margin-left:auto;font-size:11px;opacity:.55;max-width:60%;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.ysd-item{appearance:none;box-sizing:border-box;display:flex;width:100%;align-items:center;gap:8px;
  padding:7px 8px;border:0;border-radius:7px;background:transparent;color:inherit;font:inherit;
  font-size:12.5px;text-align:left;cursor:pointer}
.ysd-item:hover,.ysd-item[data-active="1"]{background:var(--dsw-alias-bg-layer-2,color-mix(in srgb,currentColor 10%,transparent))}
.ysd-item:disabled{opacity:.45;cursor:default}
.ysd-item svg{width:14px;height:14px;flex:0 0 auto;opacity:.8}
.ysd-ilabel{flex:0 0 auto;max-width:45%;overflow-wrap:anywhere}
.ysd-idesc{margin-left:auto;min-width:0;flex:1 1 auto;font-size:11px;opacity:.55;overflow-wrap:anywhere}
.ysd-badge{font-size:10px;padding:1px 6px;border-radius:99px;
  border:1px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 25%,transparent));opacity:.7}
.ysd-sep{height:1px;flex:0 0 auto;margin:2px 12px;
  background:linear-gradient(to right,transparent,var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 18%,transparent)),transparent)}
.ysd-empty{padding:18px 12px;text-align:center;font-size:12px;opacity:.55}
.ysd-nav{display:flex;flex:0 0 auto;align-items:center;gap:6px;padding:6px 12px 8px;font-size:11px;opacity:.6}
`

    /* ------------------------------------------------------------------ *
     * 图标（24 网格，1.6 描边，和其余入口同一规格）
     * ------------------------------------------------------------------ */

    const ICON_CLOUD = {
      viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
      strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
    }
    const ICON_CHEVRON = {
      viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
      strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
    }

    function CloudIcon() {
      return h('svg', ICON_CLOUD,
        h('path', { d: 'M7 18h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.1 9 4.5 4.5 0 0 0 7 18Z' }))
    }
    function QuickVoiceIcon({kind}) {
      const d = kind === 'mic' ? 'M10 3.5a2.6 2.6 0 0 0-2.6 2.6v3.8a2.6 2.6 0 0 0 5.2 0V6.1A2.6 2.6 0 0 0 10 3.5Zm-5 6.4a5 5 0 0 0 10 0M10 15v2.5M7 17.5h6' : 'M3 11.5V10a7 7 0 0 1 14 0v1.5M3 11.5h2.4v4.4H4.8A1.8 1.8 0 0 1 3 14.1v-2.6Zm14 0h-2.4v4.4h.6a1.8 1.8 0 0 0 1.8-1.8v-2.6Z';
      return h('svg', {viewBox:'0 0 20 20', fill:'none', stroke:'currentColor', strokeWidth:1.5, strokeLinecap:'round', strokeLinejoin:'round', 'aria-hidden':true}, h('path',{d}));
    }
    function QuickVoiceControls({sessionId}) {
      const snapshot = () => {
        const current = window.__yunshuVoiceState;
        return current?.sessionId === sessionId ? current : {mic:false,output:false};
      };
      const [state,setState] = React.useState(snapshot);
      React.useEffect(() => {
        const sync = () => setState(snapshot());
        window.addEventListener('yunshu:voice-state',sync);sync();
        return () => window.removeEventListener('yunshu:voice-state',sync);
      },[sessionId]);
      const dispatch = action => window.dispatchEvent(new CustomEvent('yunshu:voice-action', { detail: { action, sessionId } }));
      return h('div', { role:'group', 'aria-label':'语音快捷开关', style:{display:'inline-flex', gap:2, marginLeft:'auto'} },
        h('button', { type:'button', className:'ysq-icon', 'aria-label':state.mic?'关闭麦克风':'开启麦克风', 'aria-pressed':state.mic, onClick:()=>dispatch('mic') }, h(QuickVoiceIcon,{kind:'mic'})),
        h('button', { type:'button', className:'ysq-icon', 'aria-label':state.output?'关闭语音输出':'开启语音输出', 'aria-pressed':state.output, onClick:()=>dispatch('output') }, h(QuickVoiceIcon,{kind:'output'}))
      );
    }
    function ChevronIcon({ dir = 'right' }) {
      const d = dir === 'left' ? 'M14.5 6 9 12l5.5 6' : 'M9.5 6 15 12l-5.5 6'
      return h('svg', ICON_CHEVRON, h('path', { d }))
    }

    /* ------------------------------------------------------------------ *
     * 组件
     * ------------------------------------------------------------------ */

    function useSnapshot() {
      const [rows, setRows] = React.useState(() => snapshot())
      React.useEffect(() => {
        const off = subscribe(() => setRows(snapshot()))
        let offHealth = () => {}
        const connectHealth = () => {
          offHealth()
          offHealth = window.__yunshuHealth?.subscribe?.(() => setRows(snapshot())) || (() => {})
          setRows(snapshot())
        }
        window.addEventListener('yunshu-health-ready', connectHealth)
        connectHealth()
        setRows(snapshot())
        return () => { off(); offHealth(); window.removeEventListener('yunshu-health-ready', connectHealth) }
      }, [])
      return rows
    }

    // loader 的静态探针不渲染面板；边界等面板首次使用时再创建，避免提前要求 React.Component。
    let PanelErrorBoundary = null
    function getPanelErrorBoundary() {
      if (PanelErrorBoundary) return PanelErrorBoundary
      // 只隔离当前面板；条目换掉或返回列表时，React 会卸载这个边界并重置错误态。
      PanelErrorBoundary = class extends React.Component {
        constructor(props) {
          super(props)
          this.state = { error: null }
        }
        static getDerivedStateFromError(error) { return { error } }
        componentDidCatch(error, info) {
          try { console.error('[yunshu-dock] panel crashed:', this.props.panelId, error, info) } catch { /* ignore */ }
        }
        render() {
          return this.state.error
            ? h('div', { className: 'ysd-empty', role: 'alert' }, '面板出错，请返回后重试')
            : this.props.children
        }
      }
      return PanelErrorBoundary
    }

    function DockEntry(props) {
      React.useEffect(() => {
        window.__yunshuHealth?.bindSession?.(props.sessionId)
        window.__yunshuLakeSession = { sessionId:props.sessionId, locked:!!props.locked }
        window.dispatchEvent(new CustomEvent('yunshu:dock-session', {detail:window.__yunshuLakeSession}))
      }, [props.sessionId, props.locked])
      const rows = useSnapshot()
      const [open, setOpen] = React.useState(false)
      const [closing, setClosing] = React.useState(false)
      const [level, setLevel] = React.useState(null) // null=根，否则 group id
      const [cursor, setCursor] = React.useState(0)
      // 面板层：条目若带 render()，点它不执行 run、也不关抽屉，而是在抽屉里就地渲染该面板
      const [panel, setPanel] = React.useState(null)
      const rootRef = React.useRef(null)
      React.useLayoutEffect(() => mountQuiet(rootRef.current, QUIET_CSS), [])
      const btnRef = React.useRef(null)
      const panelRef = React.useRef(null)
      const closeTimer = React.useRef(null)
      React.useEffect(() => () => window.clearTimeout(closeTimer.current), [])
      const control=useFeatures(),prefs=control.preferences;
      const moduleKey={任务台:'tasks',记忆:'memory',语音:'voice',人格:'persona',媒体:'media'};
      const featurePage=level==='features'||prefs?.master===false||(panel&&prefs?.[moduleKey[panel.label]]===false);
      const scene=featurePage?'features':sceneName(panel,level)
      useDockLayout(open, scene, panelRef, btnRef)
      useDockMotion(open, scene, panelRef)

      const activePanelRef = React.useRef(null)
      activePanelRef.current = panel

      React.useLayoutEffect(() => {
        if (!open) return
        const body = panelRef.current?.querySelector('.ysd-pbody, .ysd-body')
        if (body) body.scrollTop = 0
        const target = body?.querySelector('input,button:not(:disabled),summary') || panelRef.current?.querySelector('button')
        target?.focus({ preventScroll: true })
      }, [open, level, panel])

      const sessionId = props?.sessionId

      // 关掉抽屉：焦点回到按钮
      const close = React.useCallback((restoreFocus = true) => {
        window.clearTimeout(closeTimer.current)
        setClosing(true)
        closeTimer.current = window.setTimeout(() => {
          setOpen(false)
          setClosing(false)
          setLevel(null)
          setCursor(0)
          setPanel(null)
        }, window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 120)
        if (restoreFocus) { try { btnRef.current?.focus() } catch { /* ignore */ } }
      }, [])

      // A panel node captures sessionId; discard it before a different session paints.
      React.useLayoutEffect(() => {
        window.clearTimeout(closeTimer.current)
        setOpen(false); setClosing(false); setPanel(null); setLevel(null); setCursor(0)
      }, [sessionId])

      // 全局快捷键
      React.useEffect(() => {
        const onKey = (e) => {
          if (!(e.ctrlKey || e.metaKey) || !e.shiftKey) return
          if (String(e.key).toLowerCase() !== 'y') return
          e.preventDefault()
          setOpen(v => {
            if (v) { setLevel(null); setPanel(null); setCursor(0); return false }
            return true
          })
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [])

      // 点外面关掉（但不抢输入框的焦点）
      React.useEffect(() => {
        if (!open) return
        const onDown = (e) => {
          const root = rootRef.current
          if (!root || root.contains(e.target) || panelRef.current?.contains(e.target)) return
          const activePanel = activePanelRef.current
          // 只有当前面板能声明额外的 portal DOM；其他条目仍保持点外关闭。
          if (typeof activePanel?.ownsTarget === 'function') {
            try { if (activePanel.ownsTarget(e.target)) return } catch (error) {
              try { console.error('[yunshu-dock] ownsTarget failed:', activePanel.key, error) } catch { /* ignore */ }
            }
          }
          // 旧语音条目只有 ysd-embedded-voice 锚点，实际 Panel 又 portal 到 body。
          // 未改语音插件时，按它独有的 aria-label 认领可见面板，而非放宽所有外部点击。
          const className = activePanel?.node?.props?.className
          if (typeof className === 'string' && className.split(/\s+/).includes('ysd-embedded-voice')
            && e.target?.closest?.('section.ys-plugin.ys-panel[aria-label="云舒语音"]')) return
          close(false)
        }
        document.addEventListener('mousedown', onDown)
        return () => document.removeEventListener('mousedown', onDown)
      }, [open, close])

      const grouped = React.useMemo(() => {
        const map = new Map(GROUPS.map(g => [g.id, []]))
        for (const r of rows) {
          if (!map.has(r.group)) map.set(r.group, [])
          map.get(r.group).push(r)
        }
        return map
      }, [rows])

      // 当前层可选项（根层是分组，子层是条目）
      const items = React.useMemo(() => {
        if (level) {
          const list = (grouped.get(level) || []).filter(r => !r.hidden)
          return list.map(r => ({ kind: 'entry', key: r.group + '/' + r.id, row: r }))
        }
        const panels = (grouped.get('panel') || []).filter(row => !row.hidden)
        const rank = row => ({'任务台':0,'记忆':1,'语音':2,'人格':3}[row.label] ?? 4)
        const direct = panels.sort((a,b) => rank(a) - rank(b)).map(row => ({kind:'entry', key:row.group + '/' + row.id, row}))
        return direct
      }, [level, grouped])

      const activate = React.useCallback((it) => {
        if (!it) return
        if (it.kind === 'group') { setLevel(it.group.id); setCursor(0); return }
        const row = it.row
        if (row.disabled) return
        // 带 render() 的条目：在抽屉内就地渲染面板，不执行 run、不关抽屉。
        // 这是「输入框左边只留一个按钮」的落地点——其余插件把面板搬进这里。
        if (typeof row.render === 'function') {
          try {
            const node = row.render({ sessionId, close: () => setPanel(null) })
            setPanel({ key: it.key, label: row.label || row.id, node, ownsTarget: row.ownsTarget })
            return
          } catch (error) {
            try { console.error('[yunshu-dock] panel render failed:', it.key, error) } catch { /* ignore */ }
            setPanel({ key: it.key, label: row.label || row.id,
              node: h('div', { className: 'ysd-empty', role: 'alert' }, '面板出错，请返回后重试') })
            return
          }
        }
        try { row.run?.() } catch { /* 条目自己出错不连累抽屉 */ }
        close()
      }, [close, sessionId])

      const onPanelKey = (e) => {
        if (e.defaultPrevented || e.isComposing || e.nativeEvent?.isComposing) return
        if (e.key === 'Escape') { e.preventDefault(); close(); return }
        if (e.key === 'Tab') {
          const nodes = [...(panelRef.current?.querySelectorAll('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary,a[href],[tabindex="0"]') || [])]
            .filter(el => {
              if (el.tabIndex < 0 || !el.getClientRects().length || getComputedStyle(el).visibility === 'hidden') return false
              // Chromium can return layout rects for closed-details descendants.
              for (let parent = el.parentElement; parent && parent !== panelRef.current; parent = parent.parentElement) {
                if (parent.tagName === 'DETAILS' && !parent.open && !parent.querySelector(':scope > summary')?.contains(el)) return false
              }
              return true
            })
          if (!nodes.length) return
          const first = nodes[0], last = nodes[nodes.length - 1]
          if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
          else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
          return
        }
        // Native form controls and summaries own their keys. Do not reopen a
        // stale menu item when Enter bubbles out of the active child panel.
        if (panel || e.target?.closest?.('input,textarea,select,summary,[contenteditable="true"]')) return
        const choices = [...(panelRef.current?.querySelectorAll('.ysd-body button.ysd-item:not(:disabled)') || [])]
        const selected = choices.indexOf(document.activeElement)
        if (e.key === 'Backspace' && level) { e.preventDefault(); setLevel(null); setCursor(0); return }
        if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key) && choices.length && selected >= 0) {
          e.preventDefault()
          const next = Math.max(0, Math.min((selected < 0 ? 0 : selected) + (['ArrowDown', 'ArrowRight'].includes(e.key) ? 1 : -1), choices.length - 1))
          choices[next]?.focus(); setCursor(next); return
        }
        if (e.key === 'Enter' && !e.target?.closest?.('button')) { e.preventDefault(); activate(items[cursor]) }
      }


      const disabled = false

      const home = !panel && !level && !featurePage
      const diagnostics = level === 'status' && !panel
      const title = featurePage ? '功能开关' : panel?.label || (diagnostics ? '运行诊断' : GROUPS.find(g => g.id === level)?.label) || '云舒'
      const modules = items.filter(it => it.kind === 'entry' && prefs?.[moduleKey[it.row?.label]]!==false)
      const extraGroups = GROUPS.filter(g => !['panel', 'status'].includes(g.id) && grouped.get(g.id)?.some(row => !row.hidden))
        .map(group => ({ kind: 'group', key: group.id, group }))
      const openDiagnostics = () => { setPanel(null); setLevel('status'); setCursor(0) }
      function back() {
        if (panel) setPanel(null)
        else setLevel(null)
        setCursor(0)
      }
      function moduleButton(it) {
        const row = it.row
        return h('button', { key: it.key, type: 'button', className: 'ysd-item', disabled: !!row.disabled,
          'aria-label': row.label || row.id, onClick: () => activate(it) },
          h(DockGlyph, { name: row.label }), h('span', null, row.label || row.id),
          row.badge ? h('small', null, row.badge) : null)
      }
      const check = panel && window.__yunshuHealth?.snapshot().find(row => row.visibleInDock && row.label === panel.label && row.state === 'warn')
      const panelNode = open ? h('div', { className: 'ysd-panel', 'data-scene': scene, 'data-closing': closing ? '1' : '0',
        ref: panelRef, role: 'dialog', 'aria-label': '云舒工作台', onKeyDown: onPanelKey },
        h('header', { className: 'ysd-head' },
          home ? h('span', { className: 'dock-mark', 'aria-hidden': true }, h(CloudIcon)) :
            h('button', { type: 'button', className: 'ysq-icon dock-back', title: '返回', 'aria-label': '返回', onClick: back }, h(ChevronIcon, { dir: 'left' })),
          h('span', { className: 'ysd-title' }, title),
          h('div', { className: 'dock-tools' }, prefs?.master!==false&&h(LakeButton), prefs?.master!==false&&h(MusicButton,{closing}), prefs?.master!==false&&prefs?.voice!==false&&h(QuickVoiceControls,{sessionId}),
            h(DockMore, { groups: extraGroups, activate, openDiagnostics, openFeatures:()=>{setPanel(null);setLevel('features');setCursor(0)} }))),
        (prefs?.master!==false)&&h(StarLake),
        home ? h('nav', { className: 'ysd-body dock-modules', 'aria-label': '云舒模块' },
          modules.length ? modules.map(moduleButton) : h('span', { className: 'ysd-empty' }, '暂无可用模块')) :
        h('div', { className: 'ysd-pbody', key: panel?.key || level },
          check && h('button', { className: 'dock-warning', type: 'button', onClick: openDiagnostics }, check.reason),
          featurePage ? h(FeatureSettings,{state:control}) : panel ? h(getPanelErrorBoundary(), { key: panel.key, panelId: panel.key }, panel.node) :
          diagnostics ? h(Diagnostics, { extraEntries: (grouped.get('status') || []).filter(row => !row.hidden), activate }) :
          h('nav', { className: 'dock-list', 'aria-label': title }, modules.length ? modules.map(moduleButton) : h('span', null, '暂无可用操作'))))
        : null

      const portal = open && typeof document !== 'undefined' ? ReactDOM.createPortal(h('div', { className: 'ysd-portal ysd-wrap', 'data-yunshu-theme': 'integrated' },
        h('div', { className: 'ysd-backdrop', onMouseDown: () => close(false), 'aria-hidden': true }), panelNode), document.body) : null
      return h('div', { className: 'ysd-wrap', ref: rootRef },
        h(ActivationFilm,{enabled:control.preferences?.master,open,anchor:rootRef}),
        portal,

        h('button', {
          type: 'button', className: 'ysd-btn', ref: btnRef,
          disabled,
          'aria-expanded': open,
          'aria-haspopup': 'dialog',
          title: '云舒', 'aria-label': '云舒',
          onClick: () => { if (open) close(); else { setClosing(false); setOpen(true) } },
        },
          h(CloudIcon),
          h('span', null, '云舒')),h(FeatureSwitch,{id:'master',state:control,compact:true}))
    }

    /* ------------------------------------------------------------------ *
     * 挂载
     * ------------------------------------------------------------------ */

    let styleEl = null
    function ensureStyle() {
      if (styleEl && styleEl.isConnected) return styleEl
      styleEl = document.createElement('style')
      styleEl.textContent = CSS
      document.head.append(styleEl)
      return styleEl
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = ctx.slots
        ensureStyle()
        const dispose = slots.inject('conversation.input.left', () => slots.register({
          name: 'conversation.input.left',
          id: 'yunshu-dock',
          order: 100,
          label: () => '云舒',
        }, DockEntry))
        ctx.effect?.(() => () => {
          try { dispose?.() } catch { /* ignore */ }
          try { styleEl?.remove() } catch { /* ignore */ }
          styleEl = null
          // 仅卸载自己发布的 API，避免旧实例清理抹掉新实例。
          if (window.__yunshuDock === dockApi) {
            try { delete window.__yunshuDock } catch { /* ignore */ }
          }
        })
      },
    }
  },
  })
  } catch (error) {
    const message = String(error && error.message)
    if (!/duplicate factory registration for ["']@yunshu\/dsh-dock["']/.test(message)) throw error
    // 可见痕迹：出现这条就说明 bundle 被重复执行（HMR invalidate 或 arrive 回退）。
    // 必须能在 console 看到 —— 静默吞会把崩溃藏成「entry 未激活」那种无声失败。
    try { console.warn('[yunshu-dock] duplicate registration ignored:', message) } catch { /* ignore */ }
  }
}

window.__ModuleLoader__.load({id:"@yunshu/dsh-desktop/internal-memory",factory:require=>{
const React=require("react");const ReactDOM=require("react-dom");const {z}=require("zod");
/** Lazy assembly of generated Remote definitions using caller-supplied Zod; no runtime imports. */
/**
 * Retain one generated definition per endpoint without constructing parsers or projections.
 * The class instance builds its shared descriptor/method index on first access;
 * input schemas and JSON Schema projections are cached only when requested.
 * @param spec - compiler-produced method facts and Zod factories.
 * @param zod - the generated artifact's Zod runtime for named-input parsers.
 * @returns a lazy, mountable info instance with no registration or transport effects.
 */
function createTypertRemoteInfo(spec, zod) {
    return new RemoteInfo(spec, zod);
}
class RemoteInfo {
    spec;
    zod;
    index;
    constructor(spec, zod) {
        this.spec = spec;
        this.zod = zod;
    }
    get package() { return this.spec.package; }
    get descriptors() { return this.resolve().descriptors; }
    get methods() { return this.resolve().methods; }
    resolve() {
        if (this.index !== undefined)
            return this.index;
        const zod = this.zod;
        const descriptors = [];
        const methods = Object.create(null);
        for (const [endpoint, definition] of Object.entries(this.spec.methods)) {
            const separator = endpoint.indexOf('/');
            const namespace = endpoint.slice(0, separator);
            const method = endpoint.slice(separator + 1);
            const parameters = definition.parameters.map(parameter => ({ ...parameter, wire: parameter.wire ?? parameter.name }));
            const descriptor = {
                ...definition,
                id: `${this.spec.package}#${endpoint}`,
                namespace,
                method,
                parameters,
                result: definition.result.description === undefined ? definition.result : new ResultValue(definition.result),
            };
            if (definition.invocation.kind === 'direct') {
                const inputs = [];
                const direct = Object.assign(descriptor, {
                    input(options) {
                        const strict = options?.strict === true;
                        return inputs[strict ? 1 : 0] ??= new NamedInput(parameters, strict, zod);
                    },
                    invoke(remote, input, signal) {
                        const named = input;
                        const values = parameters.map(parameter => named[parameter.wire]);
                        if (definition.cancellation !== undefined)
                            values.push(signal);
                        // Namespace access retains the Gateway's mount checks and scoped receiver policy.
                        const receiver = Reflect.get(remote, namespace);
                        const call = Reflect.get(receiver, method);
                        return call.apply(receiver, values);
                    },
                });
                // The generated namespace return type is selected by this same descriptor's mode.
                methods[endpoint] = direct;
            }
            descriptors.push(descriptor);
        }
        return this.index = { descriptors, methods };
    }
}
/**
 * Narrow a Registry descriptor to its generated direct-method capabilities.
 * @param descriptor - a live descriptor, including possible source fallback or Context-only receivers.
 * @returns whether generated named input and direct invocation are available.
 */
function isTypertRemoteMethod(descriptor) {
    return descriptor.invocation.kind === 'direct' && descriptor.result.mode === 'strict'
        && 'input' in descriptor && typeof descriptor.input === 'function'
        && 'invoke' in descriptor && typeof descriptor.invoke === 'function';
}
function optional(parameter) {
    return parameter.source === 'json' && parameter.acceptsUndefined === true;
}
class NamedInput {
    parameters;
    strict;
    zod;
    schema;
    projection;
    constructor(parameters, strict, zod) {
        this.parameters = parameters;
        this.strict = strict;
        this.zod = zod;
    }
    codec(parameter) {
        return this.strict ? parameter.strictCodec : parameter.codec;
    }
    create = () => this.schema ??= this.zod.strictObject(Object.fromEntries(this.parameters.map((parameter) => {
        const value = this.codec(parameter).create();
        return [parameter.wire, optional(parameter) ? value.optional() : value.nonoptional()];
    })));
    get jsonSchema() { return this.project().jsonSchema; }
    get jsonSchemaError() { return this.project().jsonSchemaError; }
    project() {
        if (this.projection !== undefined)
            return this.projection;
        const unavailable = this.parameters.find(parameter => this.codec(parameter).jsonSchema === undefined);
        if (unavailable !== undefined) {
            return this.projection = { jsonSchemaError: this.codec(unavailable).jsonSchemaError ?? `No JSON Schema for parameter ${unavailable.wire}` };
        }
        return this.projection = {
            jsonSchema: {
                type: 'object',
                properties: Object.fromEntries(this.parameters.map(parameter => [parameter.wire, {
                        ...this.codec(parameter).jsonSchema,
                        ...(parameter.description === undefined ? {} : { description: parameter.description }),
                    }])),
                required: this.parameters.filter(parameter => !optional(parameter)).map(parameter => parameter.wire),
                additionalProperties: false,
            },
        };
    }
}
class ResultValue {
    spec;
    projection;
    constructor(spec) {
        this.spec = spec;
    }
    get mode() { return this.spec.mode; }
    get typeSymbol() { return this.spec.typeSymbol; }
    get create() { return this.spec.create; }
    get decode() { return this.spec.decode; }
    get encode() { return this.spec.encode; }
    get description() { return this.spec.description; }
    get jsonSchemaError() { return this.spec.jsonSchemaError; }
    get jsonSchema() {
        if (this.projection === undefined) {
            const schema = this.spec.jsonSchema;
            this.projection = { value: schema === undefined ? undefined : { ...schema, description: this.spec.description } };
        }
        return this.projection.value;
    }
}
//# sourceMappingURL=remote-info.js.map
// One source of truth for both Host and browser Remote descriptions.
function remoteSpec(namespace, z, createTypertRemoteInfo) {
  // z.json() validates correctly but its parsed record strips __proto__ keys.
  // Preserve arbitrary user JSON as data after validation, including backups.
  const json = z.custom(value => z.json().safeParse(value).success, { message: 'Invalid JSON' });
  const codec = (type, schema, jsonSchema) => ({ mode: 'strict', typeSymbol: '@yunshu/' + namespace + '#' + type, create: () => schema, jsonSchema });
  const parameter = (name, schema, jsonSchema, extras = {}) => {
    const c = codec(name, schema, jsonSchema);
    if (extras.source === 'lookup') c.typeSymbol = '@deepseek-ai/dsh-session/types#SessionId';
    return { name, source: 'json', codec: c, strictCodec: c, ...extras };
  };
  return createTypertRemoteInfo({
    package: ({ yunshuMemory: '@yunshu/dsh-memory', yunshuVoice: '@yunshu/dsh-voice', yunshuPersona: '@yunshu/dsh-persona' })[namespace],
    methods: { [namespace + '/request']: {
      service: namespace, description: 'User-owned Yunshu plugin operation', invocation: { kind: 'direct' },
      parameters: [
        parameter('agent', z.string(), { type: 'string' }, { wire: 'agentId', source: 'lookup', lookup: 'agent' }),
        parameter('action', z.string(), { type: 'string' }),
        parameter('payload', json, {}),
      ],
      cancellation: { parameter: 'signal' },
      result: codec('result', json, {}),
      sourceLocation: { file: 'packages/shared/remote-spec.mjs', line: 1, column: 1 },
    } },
  }, z);
}

const entryChipStyles = ".ys-plugin button.ysu-chip{appearance:none;box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 20%,transparent));background:transparent;color:inherit;font:inherit;font-size:12px;line-height:1;white-space:nowrap;cursor:pointer;transition:background .15s ease}.ys-plugin button.ysu-chip:hover{background:var(--dsw-alias-bg-layer-2,color-mix(in srgb,currentColor 10%,transparent))}.ys-plugin button.ysu-chip:disabled{opacity:.45;cursor:default}.ys-plugin button.ysu-chip svg{width:14px;height:14px;flex:0 0 auto;opacity:.85}.ys-plugin .ysu-chip-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary,#888);flex:0 0 auto}.ys-plugin .ysu-chip-dot[data-s=\"ok\"]{background:var(--dsw-alias-state-success-primary,#2e6b53)}.ys-plugin .ysu-chip-dot[data-s=\"work\"]{background:var(--dsw-alias-brand-primary,#356e75)}.ys-plugin .ysu-chip-dot[data-s=\"late\"]{background:var(--dsw-alias-state-error-primary,#9a4a4e)}";
const styles = '.ys-plugin{position:relative;display:inline-flex;color:inherit;font:inherit}.ys-plugin button,.ys-plugin input,.ys-plugin textarea,.ys-plugin select{font:inherit;color:inherit}.ys-plugin button{padding:6px 10px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:9px;background:transparent;cursor:pointer}.ys-plugin button:hover{background:color-mix(in srgb,currentColor 8%,transparent)}.ys-plugin button:disabled{opacity:.45;cursor:default}.ys-panel{position:absolute;bottom:calc(100% + 10px);left:0;z-index:40;width:min(520px,80vw);max-height:65vh;overflow:auto;padding:16px;border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:14px;background:Canvas;color:CanvasText;box-shadow:0 12px 36px #0003;display:grid;gap:10px}.ys-panel h3{font-size:15px;margin:0}.ys-panel small{opacity:.72}.ys-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}.ys-panel textarea,.ys-panel input,.ys-panel select{box-sizing:border-box;border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:8px;padding:8px;background:transparent}.ys-panel textarea{width:100%;min-height:72px}.ys-card{padding:10px;border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-radius:10px;display:grid;gap:7px}.ys-card p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.ys-error{color:#b74435;white-space:pre-wrap}.ys-muted{opacity:.6}.ys-primary{font-weight:600}.ys-panel :focus-visible{outline:2px solid #687cf6;outline-offset:2px}' + ".ys-plugin select,\n.ys-panel select,\n.ys-plugin select option,\n.ys-panel select option,\n.ys-plugin select optgroup,\n.ys-panel select optgroup {\n  background-color: Canvas;\n  color: CanvasText;\n}\n\n.ys-plugin select:disabled,\n.ys-panel select:disabled,\n.ys-plugin select option:disabled,\n.ys-panel select option:disabled,\n.ys-plugin select optgroup:disabled,\n.ys-panel select optgroup:disabled {\n  color: GrayText;\n}\n" + entryChipStyles;

function Panel({ anchor, label, onClose, children }) {
  const ref = React.useRef(null), [position, setPosition] = React.useState(null);
  React.useLayoutEffect(() => {
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect(); if (!rect) return;
      const width = Math.min(540, window.innerWidth - 32), height = Math.min(600, Math.max(160, rect.top - 80), window.innerHeight - 96);
      setPosition({ position: 'fixed', left: Math.max(16, Math.min(rect.left, window.innerWidth - width - 16)), bottom: Math.max(16, window.innerHeight - rect.top + 10), width, maxHeight: height, boxSizing: 'border-box', zIndex: 900, fontFamily: 'inherit', fontSize: 13, background: 'var(--dsw-alias-bg-base, Canvas)', color: 'var(--dsw-alias-label-primary, CanvasText)' });
    };
    place(); window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    const key = event => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } };
    const outside = event => { if (!ref.current?.contains(event.target) && !anchor.current?.contains(event.target)) onClose(); };
    document.addEventListener('keydown', key); document.addEventListener('pointerdown', outside);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); document.removeEventListener('keydown', key); document.removeEventListener('pointerdown', outside); };
  }, []);
  return ReactDOM.createPortal(React.createElement('section', { ref, className: 'ys-plugin ys-panel', role: 'region', 'aria-label': label, style: position ?? { visibility: 'hidden' } }, children), document.body);
}
async function mountClient(ctx, namespace, info, View, React) {
  const disposeRemote = await ctx.remote.$mount(info);
  let ui;
  try {
    ui = ctx.inject(['remote.' + namespace, 'slots'], inner => {
      const style = document.createElement('style'); style.textContent = styles; document.head.append(style);
      inner.effect(() => () => style.remove());
      const call = async (sessionId, action, payload = {}, signal) => {
        const result = await inner.remote[namespace].request(sessionId, action, payload, signal);
        if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code, details: result.error.details });
        return result.value;
      };
      // 收进 dock 抽屉（embedded：只画面板、不画按钮）。dock 可能晚于本 bundle apply，先排队。
      const __dysEntry = { group: 'panel', id: namespace, label: ({ yunshuMemory: '记忆', yunshuPersona: '人格', yunshuVoice: '语音' })[namespace] || namespace, status: () => window.__yunshuHealth?.get(({ yunshuMemory: 'memory', yunshuPersona: 'persona', yunshuVoice: 'voice' })[namespace])?.state ?? 'unknown', describe: () => window.__yunshuHealth?.describe(({ yunshuMemory: 'memory', yunshuPersona: 'persona', yunshuVoice: 'voice' })[namespace]) ?? '健康状态未接通', render: dockProps => React.createElement(View, { sessionId: dockProps.sessionId, call, embedded: true }) };
      if (window.__yunshuDock?.register) { window.__yunshuDock.register(__dysEntry); } else { (window.__yunshuDockQueue = window.__yunshuDockQueue || []).push(__dysEntry); }
    });
    await ui;
  } catch (error) { await ui?.dispose(); await disposeRemote(); throw error; }
  return async () => { await ui.dispose(); await disposeRemote(); };
}

// Lossless JSON drafts: numeric input stays text until validation at Save.
// Objects/arrays retain their shape, unknown fields and explicit nulls.
function profileDraft(value) {
  if (value === null) return { type: 'null', text: '' };
  if (Array.isArray(value)) return { type: 'array', children: value.map(v => ({ key: '', value: profileDraft(v) })) };
  if (typeof value === 'object') return { type: 'object', children: Object.entries(value).map(([key, v]) => ({ key, value: profileDraft(v) })) };
  return { type: typeof value, text: String(value) };
}
function profileValue(draft) {
  switch (draft.type) {
    case 'string': return draft.text;
    case 'null': return null;
    case 'boolean': if (!['true','false'].includes(draft.text)) throw new Error('开关值无效'); return draft.text === 'true';
    case 'number': {
      if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(draft.text) || !Number.isFinite(Number(draft.text))) throw new Error('请输入有效数字');
      return Number(draft.text);
    }
    case 'array': return draft.children.map(row => profileValue(row.value));
    case 'object': {
      const keys = draft.children.map(row => row.key);
      if (new Set(keys).size !== keys.length) throw new Error('字段名重复');
      return Object.fromEntries(draft.children.map(row => [row.key, profileValue(row.value)]));
    }
    default: throw new Error('字段类型无效');
  }
}
function emptyProfileField(type) {
  return ['object','array'].includes(type) ? { type, children: [] } : { type, text: type === 'number' ? '0' : type === 'boolean' ? 'false' : '' };
}

function EvidenceView({ sessionId, call }) {
  const h=React.createElement,life=React.useRef(null);
  const [open,setOpen]=React.useState(false),[sources,setSources]=React.useState([]),[rows,setRows]=React.useState([]),[error,setError]=React.useState(''),[busy,setBusy]=React.useState(false),[raw,setRaw]=React.useState('');
  const blank=()=>({subject:'',predicate:'',value:'',modality:'text',source_mode:'user_report',source_id:'',quote:''});
  const [draft,setDraft]=React.useState(blank),[editing,setEditing]=React.useState(null);
  const refresh=async signal=>{const [s,r]=await Promise.all([call(sessionId,'sources',{},signal),call(sessionId,'observations',{},signal)]);if(!signal.aborted){setSources(s);setRows(r);}};
  React.useEffect(()=>{const abort=new AbortController();life.current=abort;setSources([]);setRows([]);setError('');setBusy(false);setRaw('');setDraft(blank());setEditing(null);if(open&&sessionId)refresh(abort.signal).catch(e=>{if(!abort.signal.aborted)setError(e.message);});return()=>abort.abort();},[open,sessionId]);
  const run=async action=>{const signal=life.current.signal;setBusy(true);setError('');try{await action(signal);if(!signal.aborted)await refresh(signal);}catch(e){if(!signal.aborted)setError(e.message);}finally{if(!signal.aborted)setBusy(false);}};
  const button=(name,action,disabled=false)=>h('button',{type:'button',onClick:action,disabled:busy||disabled},name);
  const input=(label,key,max=300)=>h('input',{'aria-label':label,placeholder:label,maxLength:max,value:draft[key],onChange:e=>setDraft({...draft,[key]:e.target.value}),disabled:!!editing&&['subject','predicate'].includes(key)});
  const viewSource=id=>run(async signal=>{const source=await call(sessionId,'source-read',{id},signal);if(signal.aborted)return;if(!source)throw new Error('原始记录已撤回或不存在');const texts=source.payload.parts.filter(p=>p.type==='text').map(p=>p.text).join('\n');setRaw(JSON.stringify(source.payload,null,2));setDraft(d=>({...d,source_id:id,quote:texts.slice(0,4000),source_mode:source.role==='user'?'user_report':'model_inference'}));});
  const stateLabel={proposed:'待确认',confirmed:'已确认',superseded:'已更正',withdrawn:'已撤回'};
  return h('details',{open,onToggle:e=>setOpen(e.currentTarget.open)},h('summary',null,'原始记录与观察'),open&&h(React.Fragment,null,
    error&&h('div',{role:'alert',className:'ys-error'},error),button('刷新记录',()=>run(async()=>{})),
    h('h3',null,'原始记录'),sources.length===0&&h('small',null,'暂无原始记录'),
    ...sources.slice(0,20).map(s=>h('article',{className:'ys-card',key:s.id},h('small',null,(s.role==='user'?'我':'回复')+' · '+s.captured_at),h('div',{className:'ys-row'},button('查看原话',()=>viewSource(s.id)),button('撤回来源',()=>{if(confirm('撤回此来源及关联记忆？保留历史和对话。'))void run(async signal=>{await call(sessionId,'source-withdraw',{id:s.id},signal);if(!signal.aborted){setRaw('');setDraft(blank());setEditing(null);}});})) )),
    sources.length>20&&h('small',null,'显示最近20条'),raw&&h('textarea',{'aria-label':'原始记录详情',value:raw,readOnly:true}),raw&&h('small',null,'附件：已接收内容与引用；外部文件未保存'),
    h('h3',null,'观察'),rows.length===0&&h('small',null,'暂无观察'),
    ...rows.map(row=>h('article',{className:'ys-card',key:row.id,'data-observation':row.id},h('small',null,stateLabel[row.state]+' · '+(row.source_mode==='user_report'?'用户口述':'推断')),h('p',null,row.subject+' · '+row.predicate+'：'+row.value),h('small',null,'依据：'+row.quote),
      h('div',{className:'ys-row'},button('查看依据',()=>viewSource(row.source_id)),row.state==='proposed'&&button('确认观察',()=>run(signal=>call(sessionId,'observation-accept',{id:row.id,version:row.version},signal))),row.state==='proposed'&&button('拒绝观察',()=>run(signal=>call(sessionId,'observation-reject',{id:row.id,version:row.version},signal))),row.state==='confirmed'&&button('更正观察',()=>{setEditing({id:row.id,version:row.version});setDraft({subject:row.subject,predicate:row.predicate,value:row.value,modality:row.modality,source_mode:row.source_mode,source_id:row.source_id,quote:row.quote});}),['confirmed','proposed'].includes(row.state)&&button('撤回观察',()=>{if(confirm('撤回这条观察？'))void run(signal=>call(sessionId,'observation-withdraw',{id:row.id,version:row.version},signal));})))),
    h('h3',null,editing?'更正记录':'记录观察'),h('small',null,'选择原话，填写观察'),
    input('观察对象','subject'),input('观察属性','predicate',200),input('观察内容','value',4000),
    h('select',{'aria-label':'观察模态',value:draft.modality,onChange:e=>setDraft({...draft,modality:e.target.value})},...Object.entries({text:'文字',image:'图像',audio:'声音',taste:'味道',smell:'气味',touch:'触感',tool:'工具'}).map(([v,label])=>h('option',{key:v,value:v},label))),
    h('select',{'aria-label':'依据类型',value:draft.source_mode,onChange:e=>setDraft({...draft,source_mode:e.target.value})},h('option',{value:'user_report'},'用户口述'),h('option',{value:'model_inference'},'推断')),
    h('textarea',{'aria-label':'观察依据',value:draft.quote,maxLength:4000,onChange:e=>setDraft({...draft,quote:e.target.value})}),
    h('div',{className:'ys-row'},button(editing?'确认更正':'确认记录',()=>run(async signal=>{await call(sessionId,editing?'observation-correct':'observation-add',{...(editing??{}),observation:draft,confirmed:true},signal);if(!signal.aborted){setEditing(null);setDraft(blank());}}),!draft.source_id||!draft.subject.trim()||!draft.predicate.trim()||!draft.value.trim()||!draft.quote.trim()),button('清空观察',()=>{setEditing(null);setDraft(blank());}))
  ));
}

function createUnifiedHub() {
  const providers = new Map(), listeners = new Set();
  let snapshot = { owner: null, sections: [] }, epoch = 0;
  const publish = () => {
    const rows = [...providers.values()].sort((a, b) => (a.id === 'yunshuPersona' ? -1 : b.id === 'yunshuPersona' ? 1 : a.id.localeCompare(b.id)));
    const order = ['memory', 'persona', 'media'];
    snapshot = { owner: rows[0]?.id ?? null, sections: rows.flatMap(row => row.sections.map(section => ({ ...section, provider: row.id, call: row.call, epoch: row.epoch }))).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)) };
    for (const listener of listeners) listener(snapshot);
  };
  return {
    snapshot: () => snapshot,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    register(id, sections, call) {
      const token = Symbol(id); providers.set(id, { id, sections, call, token, epoch: ++epoch }); publish();
      return () => { if (providers.get(id)?.token === token) { providers.delete(id); publish(); } };
    },
  };
}
function getUnifiedHub() {
  const key = Symbol.for('@yunshu/unified-panel/v1');
  return globalThis[key] ??= createUnifiedHub();
}
function EmbeddedPanel({ label, children }) {
  return React.createElement('section', { role: 'region', 'aria-label': label, style: { display: 'grid', gap: 10, minWidth: 0 } }, children);
}
function UnifiedView({ sessionId, providerId, hub, onActiveChange }) {
  const h = React.createElement, anchor = React.useRef(null);
  const [snapshot, setSnapshot] = React.useState(hub.snapshot()), [open, setOpen] = React.useState(false), [tab, setTab] = React.useState('memory');
  React.useEffect(() => { const off = hub.subscribe(setSnapshot); setSnapshot(hub.snapshot()); return off; }, [hub]);
  const owned = snapshot.owner === providerId, tabs = snapshot.sections.filter(row => row.id !== 'media');
  const selected = tabs.find(row => row.id === tab) ?? tabs[0], media = snapshot.sections.find(row => row.id === 'media');
  React.useEffect(() => { if (!owned) setOpen(false); }, [owned]);
  React.useEffect(() => { setOpen(false); setTab('memory'); }, [sessionId]);
  React.useEffect(() => { if (!owned) return; onActiveChange?.(open); return () => onActiveChange?.(false); }, [open, owned]);
  if (!owned) return null;
  const tabId = id => 'yunshu-' + providerId + '-tab-' + id, contentId = 'yunshu-' + providerId + '-content';
  const move = (event, index) => {
    const n = tabs.length; let next;
    if (event.key === 'ArrowRight') next = (index + 1) % n;
    else if (event.key === 'ArrowLeft') next = (index + n - 1) % n;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = n - 1;
    else return;
    event.preventDefault(); const id = tabs[next].id; setTab(id); document.getElementById(tabId(id))?.focus();
  };
  return h('div', { className: 'ys-plugin', ref: anchor },
    h('button', { type: 'button', className: 'ysu-chip', disabled: !sessionId, onClick: () => setOpen(value => !value), 'aria-expanded': open, 'aria-label': sessionId ? '云舒：会话已连接' : '云舒：未连接', title: sessionId ? '云舒：会话已连接' : '云舒：未连接', 'data-yunshu-entry': true },
      h('span', { className: 'ysu-chip-dot', 'data-s': sessionId ? 'ok' : 'idle', 'aria-hidden': true }),
      h('svg', { viewBox: '0 0 24 24', width: 14, height: 14, 'aria-hidden': true },
        h('path', { d: 'M7 18h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.1 9 4.5 4.5 0 0 0 7 18Z', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' })),
      h('span', null, '云舒')),
    open && h(Panel, { anchor, label: '云舒', onClose: () => setOpen(false) },
      h('div', { className: 'ys-row', style: { justifyContent: 'space-between' } }, h('h3', null, '云舒'), h('button', { type: 'button', onClick: () => setOpen(false) }, '关闭')),
      h('div', { role: 'tablist', 'aria-label': '云舒功能', className: 'ys-row', style: { borderBottom: '1px solid color-mix(in srgb,currentColor 18%,transparent)', paddingBottom: 8 } },
        ...tabs.map((row, index) => h('button', { key: row.id, id: tabId(row.id), type: 'button', role: 'tab', 'aria-selected': row.id === selected?.id, 'aria-controls': contentId, tabIndex: row.id === selected?.id ? 0 : -1, onClick: () => setTab(row.id), onKeyDown: event => move(event, index), style: row.id === selected?.id ? { fontWeight: 600, background: 'color-mix(in srgb,currentColor 9%,transparent)' } : undefined }, row.label))),
      selected && h('div', { role: 'tabpanel', id: contentId, 'aria-labelledby': tabId(selected.id), style: { minWidth: 0 } },
        h(selected.View, { key: selected.id + ':' + sessionId + ':' + selected.epoch, sessionId, call: selected.call, embedded: true,
          mediaSection: selected.id === 'memory' && media ? h(media.View, { key: 'media:' + sessionId + ':' + media.epoch, sessionId, call: media.call, embedded: true }) : null }))));
}
async function mountUnifiedClient(ctx, namespace, info, sections, React) {
  const disposeRemote = await ctx.remote.$mount(info), hub = getUnifiedHub(); let ui;
  try {
    ui = ctx.inject(['remote.' + namespace, 'slots'], inner => {
      const style = document.createElement('style'); style.textContent = styles; document.head.append(style);
      inner.effect(() => () => style.remove());
      const call = async (sessionId, action, payload = {}, signal) => {
        const result = await inner.remote[namespace].request(sessionId, action, payload, signal);
        if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code, details: result.error.details });
        return result.value;
      };
      if (namespace === 'yunshuPersona') { const disconnect = window.__yunshuHealth.connect(call); inner.effect(() => disconnect); }
      const unregister = hub.register(namespace, sections, call); inner.effect(() => unregister);
      // UnifiedView 不能直接塞抽屉：它的面板由内部 open 状态控制，且非 hub owner 会 return null。
      // 改成把它手里的每个 section 摊成一个 dock 面板，直接渲染 section.View(embedded)。
      for (const __dysSection of sections) {
        const __dysEntry = { group: 'panel', id: namespace + '/' + __dysSection.id, label: __dysSection.label, status: () => window.__yunshuHealth?.get(__dysSection.id)?.state ?? 'unknown', describe: () => window.__yunshuHealth?.describe(__dysSection.id) ?? '健康状态未接通', render: dockProps => React.createElement(__dysSection.View, { sessionId: dockProps.sessionId, call, embedded: true }) };
        if (window.__yunshuDock?.register) { window.__yunshuDock.register(__dysEntry); } else { (window.__yunshuDockQueue = window.__yunshuDockQueue || []).push(__dysEntry); }
      }
    });
    await ui;
  } catch (error) { await ui?.dispose(); await disposeRemote(); throw error; }
  return async () => { await ui.dispose(); await disposeRemote(); };
}

// Templates stay in the editor until the user saves them.
const CORE_TEMPLATES = Object.freeze([
  Object.freeze({ id: 'language', label: '交流语言', content: '默认用中文交流，专业术语附简短说明。' }),
  Object.freeze({ id: 'reply', label: '回复方式', content: '先给结论，再列操作步骤；回答简洁直接。' }),
  Object.freeze({ id: 'collaboration', label: '协作偏好', content: '修改前保留已有内容，完成后说明结果和未完成项。' }),
]);
function profileTemplate() {
  return { identity: { 称呼: '', 职业: '', 所在地: '' }, preferences: { 交流语言: '中文', 回复方式: '先给结论，再给步骤', 篇幅: '简洁' }, personality: { 协作方式: '', 需要避免: '' }, current_state: { 当前项目: '', 近期目标: '' }, notes: [] };
}
function hasProfileContent(value) {
  if (value === null || value === undefined || value === '') return false;
  return typeof value === 'object' ? Object.values(value).some(hasProfileContent) : true;
}
function supplementProfile(value, template = profileTemplate()) {
  const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!object(value) || !object(template)) return structuredClone(value);
  const result = structuredClone(value);
  for (const [key, item] of Object.entries(template)) {
    const next = Object.hasOwn(value, key) ? supplementProfile(value[key], item) : structuredClone(item);
    Object.defineProperty(result, key, { value: next, enumerable: true, writable: true, configurable: true });
  }
  return result;
}

function MemoryView({ sessionId, call, onActiveChange, embedded = false, mediaSection = null }) {
  const anchor = React.useRef(null);
  const h = React.createElement, [open, setOpen] = React.useState(embedded), [data, setData] = React.useState(null);
  const [error, setError] = React.useState(''), [busy, setBusy] = React.useState(false), [query, setQuery] = React.useState('');
  const [draft, setDraft] = React.useState({ kind: 'long_term', content: '', version: 0 }), [packet, setPacket] = React.useState(''), [details, setDetails] = React.useState('');
  const [storageDraft, setStorageDraft] = React.useState('');
  const life = React.useRef();
  React.useEffect(() => {
    const abort = new AbortController(); life.current = abort;
    setData(null); setError(''); setBusy(false); setPacket(''); setDetails(''); setQuery(''); setDraft({ kind: 'long_term', content: '', version: 0 });
    if (open && sessionId) call(sessionId, 'list', {}, abort.signal).then(v => { if (!abort.signal.aborted) { setData(v); setStorageDraft(v.storage?.pending ?? v.storage?.active ?? ''); } }).catch(e => { if (!abort.signal.aborted) setError(e.message); });
    return () => abort.abort();
  }, [sessionId, open]);
  React.useEffect(() => { onActiveChange?.(open); return () => onActiveChange?.(false); }, [open]);
  React.useEffect(() => {
    if (!open || !sessionId) return;
    const abort = new AbortController(); let timer;
    const refresh = async () => {
      try {
        const [indexing, autoMemory] = await Promise.allSettled([
          call(sessionId, 'index-status', {}, abort.signal),
          call(sessionId, 'auto-memory-status', {}, abort.signal),
        ]);
        if (!abort.signal.aborted) setData(value => value ? {
          ...value,
          ...(indexing.status === 'fulfilled' ? { indexing: indexing.value } : {}),
          ...(autoMemory.status === 'fulfilled' ? { autoMemory: autoMemory.value } : {}),
        } : value);
      }
      catch { /* main refresh shows connection errors; polling never replaces edits */ }
      if (!abort.signal.aborted) timer = setTimeout(refresh, 2000);
    };
    timer = setTimeout(refresh, 2000);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [open, sessionId]);
  const run = async operation => {
    const signal = life.current.signal; setBusy(true); setError('');
    try { await operation(signal); if (!signal.aborted) { const fresh = await call(sessionId, 'list', {}, signal); if (!signal.aborted) setData(fresh); } }
    catch (e) { if (!signal.aborted) setError(e.message); }
    finally { if (!signal.aborted) setBusy(false); }
  };
  const button = (label, action, disabled = false) => h('button', { type: 'button', disabled: busy || disabled, onClick: action }, label);
  const labels = { core: '旧版核心记录', profile: '旧版档案记录', long_term: '笔记', experience: '经验' };
  const records = data?.records.filter(r => !query || r.content.toLowerCase().includes(query.toLowerCase())) ?? [];
  const projectCount = data?.records?.length ?? 0;
  const usableCount = data?.records?.filter(r => !r.deleted).length ?? 0;
  const sourceLabel = r => ({ user: '手动记录', 'model-proposal': '对话建议', 'model-autosave': '自动整理', import: '导入' }[r?.source?.type] ?? '其他');
  const triggerLabel = data?.recall?.matched ?? data?.matching?.count ?? data?.otherProjects ?? 0;
  const memoryState = data?.autoMemory?.enabled === true ? '自动整理已开启' : data?.autoMemory?.enabled === false ? '自动整理已关闭' : '自动整理状态未知';
  const editor = React.useRef(null)
  const searchBox = React.useRef(null)
  const archive = React.useRef(null)
  const autoLabel = '自动整理'
  function editRecord(row) {
    setDraft({id:row.id, kind:row.kind, content:row.content, version:row.version})
    if (editor.current) {
      editor.current.open = true
      editor.current.querySelector('textarea')?.focus()
    }
  }
  function openArchive() {
    if (archive.current) {
      archive.current.open = true
      archive.current.querySelector('summary')?.focus()
      archive.current.scrollIntoView({block:'nearest'})
    }
  }
  function searchMemory() {
    if (!query.trim()) { searchBox.current?.focus(); return }
    return run(async signal => {
      const result = await call(sessionId, 'search', {query:query.trim()}, signal)
      if (!signal.aborted) setDetails(JSON.stringify(result, null, 2))
    })
  }

  return h('div', { className: 'ys-plugin', ref: anchor, style: embedded ? { display: 'contents' } : undefined },
    !embedded && h('button', { type: 'button', disabled: !sessionId, onClick: () => setOpen(!open), 'aria-expanded': open }, '记忆'),
    open && h(embedded ? EmbeddedPanel : Panel, { anchor, label: '云舒记忆', onClose: () => setOpen(false) },
      h('section', { className: 'ysq-memory-hero', 'aria-labelledby': 'ysq-memory-title' },
        h('h2', { id: 'ysq-memory-title' }, '当前项目记忆'),
        h('div', { className: 'ysq-memory-stats' },
          h('div', null, h('strong', null, String(projectCount)), h('span', null, '条记录')),
          h('div', null, h('strong', null, String(usableCount)), h('span', null, '条可引用')),
          h('div', null, h('strong', null, String(triggerLabel)), h('span', null, '个同类匹配'))
        ),
        h('div', { className: 'ysq-memory-actions' },
          h('button', { type: 'button', className: 'ysq-primary-action', onClick:searchMemory, disabled:busy }, '搜索可用记忆'),
          h('button', { type: 'button', onClick:openArchive }, '打开归档')
        )
      ),
      error && h('div', { role: 'alert', className: 'ys-error' }, error),
      data?.storage?.pending && h('div', { role: 'status', style: { overflowWrap: 'anywhere' } }, '待启用：' + data.storage.pending + ' · 完整退出并重启 DeepSeek 后生效'),
      data?.storage?.error && h('div', { role: 'alert', className: 'ys-error' }, data.storage.error),
      data?.captureError && h('div', { role: 'alert', className: 'ys-error' }, data.captureError),
      data?.autoMemory?.captureFailures > 0 && h('div', { role: 'alert', className: 'ys-error' }, '原话保存失败 ' + data.autoMemory.captureFailures + ' 条'),
      (data?.autoMemory?.workerError || data?.autoMemory?.jobs?.some(job => job.status === 'failed')) && h('div', { role: 'alert', className: 'ys-error' }, '自动记忆写入异常，打开自动整理查看'),
      data?.indexing?.error && h('div', { role: 'alert', className: 'ys-error' }, '索引异常：' + data.indexing.error),
      h('section', { className: 'ysq-memory-section', 'aria-label': '记忆搜索' },
        h('div', { className: 'ysq-memory-search' }, h('input', { ref:searchBox, 'aria-label': '筛选记忆', placeholder: '查找任务经验、来源或关键词', value: query, onChange: e => setQuery(e.target.value) }), h('button', { type: 'button', onClick:searchMemory, disabled:busy || !query.trim() }, '搜索')),
        h('p', { className: 'ysq-memory-status' }, memoryState, data?.autoMemory?.lastRunAt ? ' · 最近整理 ' + data.autoMemory.lastRunAt : '')
      ),
      data?.proposals?.length > 0 && h('section', { className: 'ysq-memory-section' }, h('div', { className: 'ysq-task-section-head' }, h('div', null, h('h3', null, '待确认记忆'), h('p', null, '确认后才会进入长期记忆')), h('span', { className: 'ysq-task-updated' }, data.proposals.length + ' 条')), ...data.proposals.map(p => h('article', { className: 'ysq-memory-record ysq-memory-proposal', key: p.id }, h('strong', null, p.kind === 'core' ? '核心事实' : labels[p.kind]), h('p', null, p.content), h('div', { className: 'ys-row' }, button('确认写入', () => run(signal => call(sessionId, p.kind === 'core' ? 'accept-core' : 'accept', { id: p.id, version: data.core.version }, signal))), button('暂不采用', () => run(signal => call(sessionId, 'reject', { id: p.id }, signal))))))),
      h('section', { className: 'ysq-memory-section' },
        h('div', { className: 'ysq-task-section-head' }, h('div', null, h('h3', null, '最近可引用'), h('p', null, '每条记录都保留来源、版本和撤回链')), h('span', { className: 'ysq-task-updated' }, records.length ? '显示 ' + Math.min(records.length, 12) + ' 条' : '暂无记录')),
        records.slice(0, 12).map(r => h('article', { className: 'ysq-memory-record', key: r.id, 'data-record-id': r.id },
          h('div', { className: 'ysq-memory-record-head' }, h('strong', null, r.deleted ? '已撤回' : (labels[r.kind] || r.kind)), h('span', null, 'v' + r.version + ' · ' + sourceLabel(r))),
          h('p', null, r.content),
          h('div', { className: 'ysq-memory-record-meta' }, '来源：' + sourceLabel(r), r.project ? ' · 项目：' + r.project : '', r.updatedAt ? ' · 更新：' + r.updatedAt : ''),
          h('div', { className: 'ys-row' }, button('编辑', () => editRecord(r), r.deleted), button('撤回', () => { if (confirm('撤回这条记忆并保留历史？')) void run(signal => call(sessionId, 'withdraw', { id: r.id, version: r.version }, signal)); }, r.deleted), button('历史', () => run(async signal => { const result = await call(sessionId, 'history', { id: r.id }, signal); if (!signal.aborted) setDetails(JSON.stringify(result, null, 2)); })))
        )),
        data && !records.length && h('p', { className: 'ysu-empty' }, query ? '没有匹配的记忆' : '还没有工作区笔记'),
        records.length > 12 && h('p', { className: 'ysq-memory-status' }, '还有 ' + (records.length - 12) + ' 条，输入关键词继续查找')
      ),
      h('details', { className: 'ysq-memory-details' }, h('summary', null, autoLabel), h(AutoMemoryControl, { data, call, sessionId, run, busy })),
      h('details', { className: 'ysq-memory-details' }, h('summary', null, '个人档案与对话'), h(MemoryLayers, { key: sessionId, data, call, sessionId, run, busy })),
      h(EvidenceView, { key: 'evidence:' + sessionId, sessionId, call }),
      data?.otherProjects > 0 && h('details', { className: 'ysq-memory-details' }, h('summary', null, '其他项目记忆 · ' + data.otherProjects + ' 个项目'), ...data.otherRecords.map(row => h('article', { className: 'ysq-memory-record', key: row.id }, h('p', null, labels[row.kind] ?? row.kind), h('p', null, row.content)))),
      h('details', { ref:archive, className:'ysq-memory-details' }, h('summary', null, '存档与备份'),
        h('p', { style: { overflowWrap: 'anywhere' }, 'aria-label': '当前存档位置' }, data?.storage?.active ?? '加载中…'),
        h('label', null, '切换存档区', h('input', { 'aria-label': '选择存档文件夹', value: storageDraft, placeholder: '输入文件夹完整路径', onChange: e => setStorageDraft(e.target.value) })),
        button('使用此存档区', () => run(async signal => { const result = await call(sessionId, 'storage-select', { path: storageDraft }, signal); if (!signal.aborted) setData(value => value ? { ...value, storage: result } : value); }), !storageDraft.trim()),
        data?.storage?.paths && h('details', null, h('summary', null, '详细文件位置'), ...Object.entries({ '记忆': data.storage.paths.memory, '身份': data.storage.paths.identity, '媒体': data.storage.paths.media }).map(([name, path]) => h('p', { key: name }, name + '：' + path))),
        mediaSection && h('details', null, h('summary', null, '附件与备份'), mediaSection),
        button('导出记录', () => run(async signal => { const result = await call(sessionId, 'export', {}, signal); if (signal.aborted) return; const content = JSON.stringify(result, null, 2); setPacket(content); const url = URL.createObjectURL(new Blob([content], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = 'yunshu-memory.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); })),
        h('textarea', { 'aria-label': '导入数据', value: packet, onChange: e => setPacket(e.target.value), placeholder: '粘贴 JSON 记录' }),
        button('确认导入', () => { if (confirm('恢复备份或导入笔记？已有内容保持不变。')) void run(signal => call(sessionId, JSON.parse(packet).format === 'yunshu-memory-layers' ? 'layered-restore' : 'import', { packet: JSON.parse(packet) }, signal)); }, !packet.trim())
      ),
      h('details', { ref: editor, className: 'ysq-editor' }, h('summary', null, draft.id ? '编辑记忆' : '添加记忆'),
        h('select', { value: draft.kind, 'aria-label': '记忆层级', onChange: e => setDraft({ ...draft, kind: e.target.value }) }, ...Object.entries(labels).filter(([v]) => !['core', 'profile'].includes(v) || draft.kind === v).map(([v, label]) => h('option', { key: v, value: v }, label))),
        h('textarea', { value: draft.content, 'aria-label': '记忆内容', maxLength: 12000, placeholder: '输入记忆内容', onChange: e => setDraft({ ...draft, content: e.target.value }) }),
        h('div', { className: 'ys-row' }, button('确认保存', () => run(async signal => { await call(sessionId, 'save', draft, signal); if (!signal.aborted) setDraft({ kind: 'long_term', content: '', version: 0 }); }), !draft.content.trim()), button('清空', () => setDraft({ kind: 'long_term', content: '', version: 0 })))),
      details && h('details', { open: true, className: 'ysq-memory-details' }, h('summary', null, '查询结果'), h('textarea', { 'aria-label': '详情结果', readOnly: true, value: details }))
  ));

}

function AutoMemoryControl({ data, call, sessionId, run, busy }) {
  const h = React.createElement;
  if (!data) return null;
  const auto = data.autoMemory;
  const autoError = auto?.jobs?.findLast(job => job.status === 'failed')?.last_error ?? auto?.workerError;
  const autoErrorLabels = { MODEL_UNAVAILABLE: '等待回答模型', SOURCE_INCOMPLETE: '原话未完整保存', SOURCE_CORRUPT: '原话校验失败', SOURCE_CHANGED: '提炼时原话已变更', EXTRACTION_INVALID: '提取结果格式错误', PROVENANCE_MISMATCH: '来源校验失败', WINDOW_TOO_LARGE: '原话超过自动提炼调用上限', MODEL_FAILED: '模型返回失败', EXTRACTION_FAILED: '提取失败', ABORTED: '已中断' };
  return h(React.Fragment, null,
    h('h3', null, '自动记忆'),
    auto?.available !== false && h('button', { type: 'button', disabled: busy || typeof auto?.enabled !== 'boolean', 'aria-label': auto?.enabled ? '关闭自动记忆' : '开启自动记忆', 'aria-pressed': auto?.enabled === true, onClick: () => run(signal => call(sessionId, 'auto-memory-set-enabled', { enabled: !auto?.enabled }, signal)) }, auto?.enabled ? '关闭自动记忆' : '开启自动记忆'),
    h('div', { className: 'ys-card', role: 'status', 'aria-label': '自动记忆状态' }, auto?.available === false ? '自动记忆不可用' : typeof auto?.enabled !== 'boolean' ? '自动记忆状态未知' : auto.enabled === false ? '自动记忆已关闭' : '自动记忆已启用 · 已保存 ' + (auto?.counts?.done ?? 0) + ' 轮 · 等待 ' + (auto?.counts?.pending ?? 0) + ' 轮 · 重试 ' + (auto?.counts?.failed ?? 0) + ' 轮'),
    data.captureError && h('div', { role: 'alert', className: 'ys-error' }, data.captureError),
    auto && h('details', null, h('summary', null, '写入详情'),
      auto.cachedSegments > 0 && h('div', { role: 'status' }, '已保留 ' + auto.cachedSegments + ' 段 · 下次接续'),
      auto.captureFailures > 0 && h('div', { role: 'alert', className: 'ys-error' }, '原话保存失败 ' + auto.captureFailures + ' 条'),
      autoError && h('div', { role: 'alert', className: 'ys-error' }, autoErrorLabels[autoError] ?? '自动记忆暂不可用')));
}

function MemoryLayers({ data, call, sessionId, run, busy }) {
  const h = React.createElement;
  const [fact, setFact] = React.useState(''), [editing, setEditing] = React.useState(null);
  const button = (label, onClick, disabled = false) => h('button', { type: 'button', onClick, disabled: busy || disabled }, label);
  if (!data) return null;
  const saveFact = () => run(async signal => {
    const stamp = new Date().toISOString(), current = data.core.content;
    const entry = { id: editing ?? crypto.randomUUID(), content: fact.trim(), created_at: current.find(r => r.id === editing)?.created_at ?? stamp, updated_at: stamp };
    const content = editing ? current.map(r => r.id === editing ? entry : r) : [...current, entry];
    await call(sessionId, 'core-save', { content, version: data.core.version }, signal);
    if (!signal.aborted) { setFact(''); setEditing(null); }
  });
  return h(React.Fragment, null,
    h('h3', null, '个人记忆'),
    h('details', null, h('summary', null, '核心事实 · ' + data.core.content.length),
      ...data.core.content.map(entry => h('article', { className: 'ys-card', key: entry.id }, h('p', null, entry.content), h('div', { className: 'ys-row' },
        button('编辑', () => { setEditing(entry.id); setFact(entry.content); }),
        button('撤回', () => { if (confirm('撤回这条核心事实？')) void run(signal => call(sessionId, 'core-save', { content: data.core.content.filter(r => r.id !== entry.id), version: data.core.version }, signal)); })))),
      h('details', { open: data.core.content.length === 0 }, h('summary', null, '事实模板 · 保存后生效'),
        ...CORE_TEMPLATES.map(item => h('article', { className: 'ys-card', key: item.id }, h('strong', null, item.label), h('p', null, item.content),
          button('使用' + item.label + '模板', () => { if (fact.trim() && !confirm('替换尚未保存的事实草稿？')) return; setEditing(null); setFact(item.content); })))),
      h('textarea', { 'aria-label': '核心事实内容', value: fact, maxLength: 12000, placeholder: '输入核心事实', onChange: e => setFact(e.target.value) }),
      h('div', { className: 'ys-row' }, button(editing ? '保存事实' : '添加事实', saveFact, !fact.trim()), button('清空', () => { setFact(''); setEditing(null); }))),
    h('details', null, h('summary', null, '个人档案'),
      h(ProfileEditor, { content: data.master.content, call, sessionId, run, busy })),
    data.indexing?.enabled && h('details', null, h('summary', null, '本地索引'),
      h('div', { role: 'status', 'aria-label': '索引状态' }, ({ idle: data.indexing.pending ? '等待索引' : '已就绪', indexing: '正在索引', paused: '已暂停', error: '索引失败', closed: '已停止' })[data.indexing.state] + ' · ' + data.indexing.indexed + ' / ' + data.indexing.total),
      data.indexing.error && h('div', { role: 'alert', className: 'ys-error' }, data.indexing.error),
      h('div', { className: 'ys-row' },
        button(data.indexing.state === 'paused' ? '继续索引' : data.indexing.state === 'error' ? '重试索引' : '暂停索引', () => run(signal => call(sessionId, ['paused','error'].includes(data.indexing.state) ? 'index-resume' : 'index-pause', {}, signal))),
        button('重建当前工作区索引', () => { if (confirm('重建当前工作区索引？记忆内容保持不变。')) void run(signal => call(sessionId, 'index-rebuild', {}, signal)); }))),
    h('details', null, h('summary', null, '对话记录 · ' + data.window.length + ' 条'),
      ...data.window.slice(-10).map(r => h('article', { className: 'ys-card', key: r.id }, h('small', null, r.role === 'user' ? '我' : '回复'), h('p', null, r.content))),
      button('归档当前记录', () => { if (confirm('归档当前对话记录？')) void run(signal => call(sessionId, 'archive', {}, signal)); }, !data.window.length)),
    h('details', null, h('summary', null, '长期归档 · ' + data.archives.length + ' 条'),
      ...data.archives.slice(0, 30).map(r => h('article', { className: 'ys-card', key: r.id }, h('p', null, r.content), h('div', { className: 'ys-row' },
        button('撤回', () => { if (confirm('撤回这条归档？')) void run(signal => call(sessionId, 'archive-withdraw', { id: r.id }, signal)); }),
        data.embedding && button('建立向量', () => run(signal => call(sessionId, 'archive-index', { id: r.id }, signal))))))),
    button('导出记忆 JSON', () => run(async signal => {
      const packet = await call(sessionId, 'layered-export', {}, signal); if (signal.aborted) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify(packet, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = 'yunshu-memory-backup.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }))
  );
}

function ProfileEditor({ content, call, sessionId, run, busy }) {
  const h = React.createElement, [draft, setDraft] = React.useState(null), [advanced, setAdvanced] = React.useState(null), [error, setError] = React.useState('');
  const button = (label, onClick) => h('button', { type: 'button', disabled: busy, onClick }, label);
  const end = () => { setDraft(null); setAdvanced(null); setError(''); };
  const save = () => {
    let value;
    try { value = advanced === null ? profileValue(draft) : JSON.parse(advanced); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('档案须为对象'); }
    catch (e) { setError(e.message === '字段名重复' || e.message === '请输入有效数字' ? e.message : '档案格式无效'); return; }
    void run(async signal => { await call(sessionId, 'master-save', { content: value }, signal); if (!signal.aborted) end(); });
  };
  if (draft === null) return h(React.Fragment, null,
    !hasProfileContent(content) && h('small', { 'aria-label': '档案模板状态' }, '默认档案 · 未保存'),
    ...Object.entries(hasProfileContent(content) ? content : supplementProfile(content)).map(([key, value]) => h('article', { className: 'ys-card', key }, h('strong', null, ({ __proto__: null, identity: '身份', preferences: '偏好', personality: '性格', current_state: '近况', notes: '备注' })[key] ?? key), h(ProfileDisplay, { value }))),
    button('编辑档案', () => { setDraft(profileDraft(hasProfileContent(content) ? content : supplementProfile(content))); setError(''); }),
    hasProfileContent(content) && button('补充默认字段', () => { setDraft(profileDraft(supplementProfile(content))); setError(''); }));
  return h('div', { className: 'ys-profile-editor' },
    h('fieldset', { disabled: busy, style: { border: 0, margin: 0, padding: 0, minWidth: 0 } },
      advanced === null && h(ProfileField, { draft, change: setDraft, label: '档案', depth: 0, root: true }),
      h('details', { onToggle: e => {
        if (e.currentTarget.open && advanced === null) { try { setAdvanced(JSON.stringify(profileValue(draft), null, 2)); setError(''); } catch (error) { e.currentTarget.open = false; setError(error.message); } }
        if (!e.currentTarget.open && advanced !== null) { try { const value = JSON.parse(advanced); if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(); setDraft(profileDraft(value)); setAdvanced(null); setError(''); } catch { e.currentTarget.open = true; setError('档案格式无效'); } }
      } }, h('summary', null, '高级 JSON'), advanced !== null && h('textarea', { 'aria-label': '个人档案内容', value: advanced, maxLength: 50000, onChange: e => setAdvanced(e.target.value) }))),
    error && h('div', { role: 'alert', className: 'ys-error' }, error),
    h('div', { className: 'ys-row', style: { position: 'sticky', bottom: -16, padding: '10px 0', background: 'var(--dsw-alias-bg-base, Canvas)', borderTop: '1px solid color-mix(in srgb,currentColor 15%,transparent)' } }, button('保存档案', save), button('取消编辑', end)));
}

function ProfileField({ draft, change, label, depth, root = false }) {
  const h = React.createElement, [newKey, setNewKey] = React.useState(''), [newType, setNewType] = React.useState('string'), [error, setError] = React.useState('');
  const types = { string: '文本', number: '数字', boolean: '开关', array: '列表', object: '分组', null: '空值' };
  const names = { __proto__: null, identity: '身份', preferences: '偏好', personality: '性格', current_state: '近况', notes: '备注' };
  const group = ['object','array'].includes(draft.type);
  const select = (value, action, name) => h('select', { 'aria-label': name, value, onChange: e => action(e.target.value) }, ...Object.entries(types).map(([key, title]) => h('option', { key, value: key }, title)));
  const update = (i, patch) => change({ ...draft, children: draft.children.map((row, j) => j === i ? { ...row, ...patch } : row) });
  const add = () => {
    if (draft.type === 'object' && (!newKey.trim() || draft.children.some(row => row.key === newKey.trim()))) { setError('请输入未使用的字段名'); return; }
    change({ ...draft, children: [...draft.children, { key: draft.type === 'object' ? newKey.trim() : '', value: emptyProfileField(newType) }] }); setNewKey(''); setError('');
  };
  // Deep custom values remain lossless and editable through Advanced JSON.
  if (depth > 8) return h('div', { className: 'ys-card' }, label, h('pre', null, JSON.stringify(profileValue(draft), null, 2)));
  return h('div', { className: root ? '' : 'ys-card', style: { display: 'grid', gap: 8, minWidth: 0 } },
    !root && h('div', { className: 'ys-row' }, h('strong', null, label), select(draft.type, value => { if (confirm('更改字段类型并清空原值？')) change(emptyProfileField(value)); }, label + '类型')),
    group ? h(React.Fragment, null,
      ...draft.children.map((row, i) => h('div', { key: i, style: { display: 'grid', gap: 5 } },
        h('div', { className: 'ys-row' }, draft.type === 'object' && !Object.hasOwn(names, row.key) && h('input', { 'aria-label': label + '字段名' + (i + 1), value: row.key, onChange: e => update(i, { key: e.target.value }) }),
          h('button', { type: 'button', onClick: () => change({ ...draft, children: draft.children.filter((_, j) => j !== i) }), 'aria-label': '删除' + (names[row.key] ?? (row.key || label + (i + 1))) }, root ? '删除' + (names[row.key] ?? row.key) : '删除')),
        h(ProfileField, { draft: row.value, change: value => update(i, { value }), label: names[row.key] ?? (row.key || label + (i + 1)), depth: depth + 1 }))),
      h('div', { className: 'ys-row' }, draft.type === 'object' && h('input', { 'aria-label': label + '新字段名', value: newKey, placeholder: '字段名', onChange: e => setNewKey(e.target.value) }), select(newType, setNewType, label + '新字段类型'), h('button', { type: 'button', onClick: add }, draft.type === 'array' ? '添加' + label : '添加' + label + '字段')),
      error && h('div', { role: 'alert', className: 'ys-error' }, error)) :
      draft.type === 'boolean' ? h('label', null, h('input', { type: 'checkbox', 'aria-label': label, checked: draft.text === 'true', onChange: e => change({ ...draft, text: String(e.target.checked) }) }), '启用') :
      draft.type === 'null' ? h('span', null, '空值') :
      h(draft.type === 'string' ? 'textarea' : 'input', { 'aria-label': label, value: draft.text, inputMode: draft.type === 'number' ? 'decimal' : undefined, maxLength: 50000, onChange: e => change({ ...draft, text: e.target.value }) }));
}

function ProfileDisplay({ value, depth = 0 }) {
  const h = React.createElement;
  if (value === null) return h('small', null, '未设置');
  if (typeof value !== 'object') return h('p', null, typeof value === 'boolean' ? (value ? '是' : '否') : String(value));
  if (!Object.keys(value).length) return h('small', null, '未设置');
  if (depth > 8) return h('p', null, JSON.stringify(value));
  return Array.isArray(value) ? h('ul', { style: { margin: 0, paddingLeft: 20 } }, ...value.map((item, i) => h('li', { key: i }, h(ProfileDisplay, { value: item, depth: depth + 1 })))) :
    h('dl', { style: { margin: 0, display: 'grid', gap: 6 } }, ...Object.entries(value).map(([key, item]) => h('div', { key, style: { display: 'grid', gridTemplateColumns: 'minmax(60px, 25%) minmax(0, 1fr)', gap: 10 } }, h('dt', null, key), h('dd', { style: { margin: 0, minWidth: 0 } }, h(ProfileDisplay, { value: item, depth: depth + 1 })))));
}


function controlSpec(z, createInfo) {
  const codec = (name, schema, jsonSchema) => ({mode:'strict',typeSymbol:'@yunshu/dsh-desktop/control#'+name,create:()=>schema,jsonSchema});
  const string = codec('action',z.string(),{type:'string'}), json = codec('json',z.json(),{});
  return createInfo({package:'@yunshu/dsh-desktop/control',methods:{'yunshuControl/request':{
    service:'yunshuControl',description:'工作台本机功能开关',invocation:{kind:'direct'},
    parameters:[{name:'action',source:'json',codec:string,strictCodec:string},{name:'payload',source:'json',codec:json,strictCodec:json}],
    cancellation:{parameter:'signal'},result:json,sourceLocation:{file:'components/system/wire.mjs',line:1,column:1},
  }}},z);
}

async function mountControls(ctx){
  const remote=await ctx.remote.$mount(controlSpec(z,createTypertRemoteInfo));
  const link=ctx.inject(['remote.yunshuControl'],inner=>{
    const off=window.__yunshuControlUI.connect(async(action,payload)=>{
      const r=await inner.remote.yunshuControl.request(action,payload);
      if(!r.ok)throw Error(r.error.message);return r.value;
    });
    inner.effect(()=>off);
  });
  ctx.effect(()=>async()=>{await link.dispose();await remote();});
}
return {inject:["remote","slots"],apply:async ctx=>{await mountControls(ctx);return mountUnifiedClient(ctx,"yunshuMemory",remoteSpec("yunshuMemory",z,createTypertRemoteInfo),[{id:"memory",label:"记忆",View:MemoryView}],React)}};
}});
window.__ModuleLoader__.load({id:"@yunshu/dsh-desktop/internal-persona",factory:require=>{
const React=require("react");const ReactDOM=require("react-dom");const {z}=require("zod");
/** Lazy assembly of generated Remote definitions using caller-supplied Zod; no runtime imports. */
/**
 * Retain one generated definition per endpoint without constructing parsers or projections.
 * The class instance builds its shared descriptor/method index on first access;
 * input schemas and JSON Schema projections are cached only when requested.
 * @param spec - compiler-produced method facts and Zod factories.
 * @param zod - the generated artifact's Zod runtime for named-input parsers.
 * @returns a lazy, mountable info instance with no registration or transport effects.
 */
function createTypertRemoteInfo(spec, zod) {
    return new RemoteInfo(spec, zod);
}
class RemoteInfo {
    spec;
    zod;
    index;
    constructor(spec, zod) {
        this.spec = spec;
        this.zod = zod;
    }
    get package() { return this.spec.package; }
    get descriptors() { return this.resolve().descriptors; }
    get methods() { return this.resolve().methods; }
    resolve() {
        if (this.index !== undefined)
            return this.index;
        const zod = this.zod;
        const descriptors = [];
        const methods = Object.create(null);
        for (const [endpoint, definition] of Object.entries(this.spec.methods)) {
            const separator = endpoint.indexOf('/');
            const namespace = endpoint.slice(0, separator);
            const method = endpoint.slice(separator + 1);
            const parameters = definition.parameters.map(parameter => ({ ...parameter, wire: parameter.wire ?? parameter.name }));
            const descriptor = {
                ...definition,
                id: `${this.spec.package}#${endpoint}`,
                namespace,
                method,
                parameters,
                result: definition.result.description === undefined ? definition.result : new ResultValue(definition.result),
            };
            if (definition.invocation.kind === 'direct') {
                const inputs = [];
                const direct = Object.assign(descriptor, {
                    input(options) {
                        const strict = options?.strict === true;
                        return inputs[strict ? 1 : 0] ??= new NamedInput(parameters, strict, zod);
                    },
                    invoke(remote, input, signal) {
                        const named = input;
                        const values = parameters.map(parameter => named[parameter.wire]);
                        if (definition.cancellation !== undefined)
                            values.push(signal);
                        // Namespace access retains the Gateway's mount checks and scoped receiver policy.
                        const receiver = Reflect.get(remote, namespace);
                        const call = Reflect.get(receiver, method);
                        return call.apply(receiver, values);
                    },
                });
                // The generated namespace return type is selected by this same descriptor's mode.
                methods[endpoint] = direct;
            }
            descriptors.push(descriptor);
        }
        return this.index = { descriptors, methods };
    }
}
/**
 * Narrow a Registry descriptor to its generated direct-method capabilities.
 * @param descriptor - a live descriptor, including possible source fallback or Context-only receivers.
 * @returns whether generated named input and direct invocation are available.
 */
function isTypertRemoteMethod(descriptor) {
    return descriptor.invocation.kind === 'direct' && descriptor.result.mode === 'strict'
        && 'input' in descriptor && typeof descriptor.input === 'function'
        && 'invoke' in descriptor && typeof descriptor.invoke === 'function';
}
function optional(parameter) {
    return parameter.source === 'json' && parameter.acceptsUndefined === true;
}
class NamedInput {
    parameters;
    strict;
    zod;
    schema;
    projection;
    constructor(parameters, strict, zod) {
        this.parameters = parameters;
        this.strict = strict;
        this.zod = zod;
    }
    codec(parameter) {
        return this.strict ? parameter.strictCodec : parameter.codec;
    }
    create = () => this.schema ??= this.zod.strictObject(Object.fromEntries(this.parameters.map((parameter) => {
        const value = this.codec(parameter).create();
        return [parameter.wire, optional(parameter) ? value.optional() : value.nonoptional()];
    })));
    get jsonSchema() { return this.project().jsonSchema; }
    get jsonSchemaError() { return this.project().jsonSchemaError; }
    project() {
        if (this.projection !== undefined)
            return this.projection;
        const unavailable = this.parameters.find(parameter => this.codec(parameter).jsonSchema === undefined);
        if (unavailable !== undefined) {
            return this.projection = { jsonSchemaError: this.codec(unavailable).jsonSchemaError ?? `No JSON Schema for parameter ${unavailable.wire}` };
        }
        return this.projection = {
            jsonSchema: {
                type: 'object',
                properties: Object.fromEntries(this.parameters.map(parameter => [parameter.wire, {
                        ...this.codec(parameter).jsonSchema,
                        ...(parameter.description === undefined ? {} : { description: parameter.description }),
                    }])),
                required: this.parameters.filter(parameter => !optional(parameter)).map(parameter => parameter.wire),
                additionalProperties: false,
            },
        };
    }
}
class ResultValue {
    spec;
    projection;
    constructor(spec) {
        this.spec = spec;
    }
    get mode() { return this.spec.mode; }
    get typeSymbol() { return this.spec.typeSymbol; }
    get create() { return this.spec.create; }
    get decode() { return this.spec.decode; }
    get encode() { return this.spec.encode; }
    get description() { return this.spec.description; }
    get jsonSchemaError() { return this.spec.jsonSchemaError; }
    get jsonSchema() {
        if (this.projection === undefined) {
            const schema = this.spec.jsonSchema;
            this.projection = { value: schema === undefined ? undefined : { ...schema, description: this.spec.description } };
        }
        return this.projection.value;
    }
}
//# sourceMappingURL=remote-info.js.map
// One source of truth for both Host and browser Remote descriptions.
function remoteSpec(namespace, z, createTypertRemoteInfo) {
  // z.json() validates correctly but its parsed record strips __proto__ keys.
  // Preserve arbitrary user JSON as data after validation, including backups.
  const json = z.custom(value => z.json().safeParse(value).success, { message: 'Invalid JSON' });
  const codec = (type, schema, jsonSchema) => ({ mode: 'strict', typeSymbol: '@yunshu/' + namespace + '#' + type, create: () => schema, jsonSchema });
  const parameter = (name, schema, jsonSchema, extras = {}) => {
    const c = codec(name, schema, jsonSchema);
    if (extras.source === 'lookup') c.typeSymbol = '@deepseek-ai/dsh-session/types#SessionId';
    return { name, source: 'json', codec: c, strictCodec: c, ...extras };
  };
  return createTypertRemoteInfo({
    package: ({ yunshuMemory: '@yunshu/dsh-memory', yunshuVoice: '@yunshu/dsh-voice', yunshuPersona: '@yunshu/dsh-persona' })[namespace],
    methods: { [namespace + '/request']: {
      service: namespace, description: 'User-owned Yunshu plugin operation', invocation: { kind: 'direct' },
      parameters: [
        parameter('agent', z.string(), { type: 'string' }, { wire: 'agentId', source: 'lookup', lookup: 'agent' }),
        parameter('action', z.string(), { type: 'string' }),
        parameter('payload', json, {}),
      ],
      cancellation: { parameter: 'signal' },
      result: codec('result', json, {}),
      sourceLocation: { file: 'packages/shared/remote-spec.mjs', line: 1, column: 1 },
    } },
  }, z);
}

const entryChipStyles = ".ys-plugin button.ysu-chip{appearance:none;box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 20%,transparent));background:transparent;color:inherit;font:inherit;font-size:12px;line-height:1;white-space:nowrap;cursor:pointer;transition:background .15s ease}.ys-plugin button.ysu-chip:hover{background:var(--dsw-alias-bg-layer-2,color-mix(in srgb,currentColor 10%,transparent))}.ys-plugin button.ysu-chip:disabled{opacity:.45;cursor:default}.ys-plugin button.ysu-chip svg{width:14px;height:14px;flex:0 0 auto;opacity:.85}.ys-plugin .ysu-chip-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary,#888);flex:0 0 auto}.ys-plugin .ysu-chip-dot[data-s=\"ok\"]{background:var(--dsw-alias-state-success-primary,#2e6b53)}.ys-plugin .ysu-chip-dot[data-s=\"work\"]{background:var(--dsw-alias-brand-primary,#356e75)}.ys-plugin .ysu-chip-dot[data-s=\"late\"]{background:var(--dsw-alias-state-error-primary,#9a4a4e)}";
const styles = '.ys-plugin{position:relative;display:inline-flex;color:inherit;font:inherit}.ys-plugin button,.ys-plugin input,.ys-plugin textarea,.ys-plugin select{font:inherit;color:inherit}.ys-plugin button{padding:6px 10px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:9px;background:transparent;cursor:pointer}.ys-plugin button:hover{background:color-mix(in srgb,currentColor 8%,transparent)}.ys-plugin button:disabled{opacity:.45;cursor:default}.ys-panel{position:absolute;bottom:calc(100% + 10px);left:0;z-index:40;width:min(520px,80vw);max-height:65vh;overflow:auto;padding:16px;border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:14px;background:Canvas;color:CanvasText;box-shadow:0 12px 36px #0003;display:grid;gap:10px}.ys-panel h3{font-size:15px;margin:0}.ys-panel small{opacity:.72}.ys-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}.ys-panel textarea,.ys-panel input,.ys-panel select{box-sizing:border-box;border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:8px;padding:8px;background:transparent}.ys-panel textarea{width:100%;min-height:72px}.ys-card{padding:10px;border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-radius:10px;display:grid;gap:7px}.ys-card p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.ys-error{color:#b74435;white-space:pre-wrap}.ys-muted{opacity:.6}.ys-primary{font-weight:600}.ys-panel :focus-visible{outline:2px solid #687cf6;outline-offset:2px}' + ".ys-plugin select,\n.ys-panel select,\n.ys-plugin select option,\n.ys-panel select option,\n.ys-plugin select optgroup,\n.ys-panel select optgroup {\n  background-color: Canvas;\n  color: CanvasText;\n}\n\n.ys-plugin select:disabled,\n.ys-panel select:disabled,\n.ys-plugin select option:disabled,\n.ys-panel select option:disabled,\n.ys-plugin select optgroup:disabled,\n.ys-panel select optgroup:disabled {\n  color: GrayText;\n}\n" + entryChipStyles;
function Panel({ anchor, label, onClose, children }) {
  const ref = React.useRef(null), [position, setPosition] = React.useState(null);
  React.useLayoutEffect(() => {
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect(); if (!rect) return;
      const width = Math.min(540, window.innerWidth - 32), height = Math.min(600, Math.max(160, rect.top - 80), window.innerHeight - 96);
      setPosition({ position: 'fixed', left: Math.max(16, Math.min(rect.left, window.innerWidth - width - 16)), bottom: Math.max(16, window.innerHeight - rect.top + 10), width, maxHeight: height, boxSizing: 'border-box', zIndex: 900, fontFamily: 'inherit', fontSize: 13, background: 'var(--dsw-alias-bg-base, Canvas)', color: 'var(--dsw-alias-label-primary, CanvasText)' });
    };
    place(); window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    const key = event => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } };
    const outside = event => { if (!ref.current?.contains(event.target) && !anchor.current?.contains(event.target)) onClose(); };
    document.addEventListener('keydown', key); document.addEventListener('pointerdown', outside);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); document.removeEventListener('keydown', key); document.removeEventListener('pointerdown', outside); };
  }, []);
  return ReactDOM.createPortal(React.createElement('section', { ref, className: 'ys-plugin ys-panel', role: 'region', 'aria-label': label, style: position ?? { visibility: 'hidden' } }, children), document.body);
}
async function mountClient(ctx, namespace, info, View, React) {
  const disposeRemote = await ctx.remote.$mount(info);
  let ui;
  try {
    ui = ctx.inject(['remote.' + namespace, 'slots'], inner => {
      const style = document.createElement('style'); style.textContent = styles; document.head.append(style);
      inner.effect(() => () => style.remove());
      const call = async (sessionId, action, payload = {}, signal) => {
        const result = await inner.remote[namespace].request(sessionId, action, payload, signal);
        if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code, details: result.error.details });
        return result.value;
      };
      // 收进 dock 抽屉（embedded：只画面板、不画按钮）。dock 可能晚于本 bundle apply，先排队。
      const __dysEntry = { group: 'panel', id: namespace, label: ({ yunshuMemory: '记忆', yunshuPersona: '人格', yunshuVoice: '语音' })[namespace] || namespace, status: () => window.__yunshuHealth?.get(({ yunshuMemory: 'memory', yunshuPersona: 'persona', yunshuVoice: 'voice' })[namespace])?.state ?? 'unknown', describe: () => window.__yunshuHealth?.describe(({ yunshuMemory: 'memory', yunshuPersona: 'persona', yunshuVoice: 'voice' })[namespace]) ?? '健康状态未接通', render: dockProps => React.createElement(View, { sessionId: dockProps.sessionId, call, embedded: true }) };
      if (window.__yunshuDock?.register) { window.__yunshuDock.register(__dysEntry); } else { (window.__yunshuDockQueue = window.__yunshuDockQueue || []).push(__dysEntry); }
    });
    await ui;
  } catch (error) { await ui?.dispose(); await disposeRemote(); throw error; }
  return async () => { await ui.dispose(); await disposeRemote(); };
}


function createUnifiedHub() {
  const providers = new Map(), listeners = new Set();
  let snapshot = { owner: null, sections: [] }, epoch = 0;
  const publish = () => {
    const rows = [...providers.values()].sort((a, b) => (a.id === 'yunshuPersona' ? -1 : b.id === 'yunshuPersona' ? 1 : a.id.localeCompare(b.id)));
    const order = ['memory', 'persona', 'media'];
    snapshot = { owner: rows[0]?.id ?? null, sections: rows.flatMap(row => row.sections.map(section => ({ ...section, provider: row.id, call: row.call, epoch: row.epoch }))).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)) };
    for (const listener of listeners) listener(snapshot);
  };
  return {
    snapshot: () => snapshot,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    register(id, sections, call) {
      const token = Symbol(id); providers.set(id, { id, sections, call, token, epoch: ++epoch }); publish();
      return () => { if (providers.get(id)?.token === token) { providers.delete(id); publish(); } };
    },
  };
}
function getUnifiedHub() {
  const key = Symbol.for('@yunshu/unified-panel/v1');
  return globalThis[key] ??= createUnifiedHub();
}
function EmbeddedPanel({ label, children }) {
  return React.createElement('section', { role: 'region', 'aria-label': label, style: { display: 'grid', gap: 10, minWidth: 0 } }, children);
}
function UnifiedView({ sessionId, providerId, hub, onActiveChange }) {
  const h = React.createElement, anchor = React.useRef(null);
  const [snapshot, setSnapshot] = React.useState(hub.snapshot()), [open, setOpen] = React.useState(false), [tab, setTab] = React.useState('memory');
  React.useEffect(() => { const off = hub.subscribe(setSnapshot); setSnapshot(hub.snapshot()); return off; }, [hub]);
  const owned = snapshot.owner === providerId, tabs = snapshot.sections.filter(row => row.id !== 'media');
  const selected = tabs.find(row => row.id === tab) ?? tabs[0], media = snapshot.sections.find(row => row.id === 'media');
  React.useEffect(() => { if (!owned) setOpen(false); }, [owned]);
  React.useEffect(() => { setOpen(false); setTab('memory'); }, [sessionId]);
  React.useEffect(() => { if (!owned) return; onActiveChange?.(open); return () => onActiveChange?.(false); }, [open, owned]);
  if (!owned) return null;
  const tabId = id => 'yunshu-' + providerId + '-tab-' + id, contentId = 'yunshu-' + providerId + '-content';
  const move = (event, index) => {
    const n = tabs.length; let next;
    if (event.key === 'ArrowRight') next = (index + 1) % n;
    else if (event.key === 'ArrowLeft') next = (index + n - 1) % n;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = n - 1;
    else return;
    event.preventDefault(); const id = tabs[next].id; setTab(id); document.getElementById(tabId(id))?.focus();
  };
  return h('div', { className: 'ys-plugin', ref: anchor },
    h('button', { type: 'button', className: 'ysu-chip', disabled: !sessionId, onClick: () => setOpen(value => !value), 'aria-expanded': open, 'aria-label': sessionId ? '云舒：会话已连接' : '云舒：未连接', title: sessionId ? '云舒：会话已连接' : '云舒：未连接', 'data-yunshu-entry': true },
      h('span', { className: 'ysu-chip-dot', 'data-s': sessionId ? 'ok' : 'idle', 'aria-hidden': true }),
      h('svg', { viewBox: '0 0 24 24', width: 14, height: 14, 'aria-hidden': true },
        h('path', { d: 'M7 18h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.1 9 4.5 4.5 0 0 0 7 18Z', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' })),
      h('span', null, '云舒')),
    open && h(Panel, { anchor, label: '云舒', onClose: () => setOpen(false) },
      h('div', { className: 'ys-row', style: { justifyContent: 'space-between' } }, h('h3', null, '云舒'), h('button', { type: 'button', onClick: () => setOpen(false) }, '关闭')),
      h('div', { role: 'tablist', 'aria-label': '云舒功能', className: 'ys-row', style: { borderBottom: '1px solid color-mix(in srgb,currentColor 18%,transparent)', paddingBottom: 8 } },
        ...tabs.map((row, index) => h('button', { key: row.id, id: tabId(row.id), type: 'button', role: 'tab', 'aria-selected': row.id === selected?.id, 'aria-controls': contentId, tabIndex: row.id === selected?.id ? 0 : -1, onClick: () => setTab(row.id), onKeyDown: event => move(event, index), style: row.id === selected?.id ? { fontWeight: 600, background: 'color-mix(in srgb,currentColor 9%,transparent)' } : undefined }, row.label))),
      selected && h('div', { role: 'tabpanel', id: contentId, 'aria-labelledby': tabId(selected.id), style: { minWidth: 0 } },
        h(selected.View, { key: selected.id + ':' + sessionId + ':' + selected.epoch, sessionId, call: selected.call, embedded: true,
          mediaSection: selected.id === 'memory' && media ? h(media.View, { key: 'media:' + sessionId + ':' + media.epoch, sessionId, call: media.call, embedded: true }) : null }))));
}
async function mountUnifiedClient(ctx, namespace, info, sections, React) {
  const disposeRemote = await ctx.remote.$mount(info), hub = getUnifiedHub(); let ui;
  try {
    ui = ctx.inject(['remote.' + namespace, 'slots'], inner => {
      const style = document.createElement('style'); style.textContent = styles; document.head.append(style);
      inner.effect(() => () => style.remove());
      const call = async (sessionId, action, payload = {}, signal) => {
        const result = await inner.remote[namespace].request(sessionId, action, payload, signal);
        if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code, details: result.error.details });
        return result.value;
      };
      if (namespace === 'yunshuPersona') { const disconnect = window.__yunshuHealth.connect(call); inner.effect(() => disconnect); }
      const unregister = hub.register(namespace, sections, call); inner.effect(() => unregister);
      // UnifiedView 不能直接塞抽屉：它的面板由内部 open 状态控制，且非 hub owner 会 return null。
      // 改成把它手里的每个 section 摊成一个 dock 面板，直接渲染 section.View(embedded)。
      for (const __dysSection of sections) {
        const __dysEntry = { group: 'panel', id: namespace + '/' + __dysSection.id, label: __dysSection.label, status: () => window.__yunshuHealth?.get(__dysSection.id)?.state ?? 'unknown', describe: () => window.__yunshuHealth?.describe(__dysSection.id) ?? '健康状态未接通', render: dockProps => React.createElement(__dysSection.View, { sessionId: dockProps.sessionId, call, embedded: true }) };
        if (window.__yunshuDock?.register) { window.__yunshuDock.register(__dysEntry); } else { (window.__yunshuDockQueue = window.__yunshuDockQueue || []).push(__dysEntry); }
      }
    });
    await ui;
  } catch (error) { await ui?.dispose(); await disposeRemote(); throw error; }
  return async () => { await ui.dispose(); await disposeRemote(); };
}

function PersonaView({ sessionId, call, onActiveChange, embedded = false }) {
  const h = React.createElement, anchor = React.useRef(null), life = React.useRef(null);
  const [open,setOpen] = React.useState(embedded), [data,setData] = React.useState(null), [error,setError] = React.useState(''), [busy,setBusy] = React.useState(false);
  const [draft,setDraft] = React.useState(null), [history,setHistory] = React.useState([]), [query,setQuery] = React.useState(''), [capabilities,setCapabilities] = React.useState(null);
  const [standardDraft,setStandardDraft] = React.useState(null), [standardHistory,setStandardHistory] = React.useState([]);
  React.useEffect(() => {
    const abort = new AbortController(); life.current = abort; setData(null); setDraft(null); setHistory([]); setStandardDraft(null); setStandardHistory([]); setError(''); setBusy(false); setCapabilities(null);
    if (open && sessionId) call(sessionId,'status',{},abort.signal).then(v=>{if(!abort.signal.aborted)setData(v);}).catch(e=>{if(!abort.signal.aborted)setError(e.message);});
    return () => abort.abort();
  },[sessionId,open]);
  React.useEffect(()=>{onActiveChange?.(open);return()=>onActiveChange?.(false);},[open]);
  const run=async task=>{const signal=life.current.signal;setBusy(true);setError('');try{await task(signal);if(!signal.aborted){const next=await call(sessionId,'status',{},signal);if(!signal.aborted)setData(next);}}catch(e){if(!signal.aborted)setError(e.message);}finally{if(!signal.aborted)setBusy(false);}};
  const button=(label,action,disabled=false)=>h('button',{type:'button',onClick:action,disabled:busy||disabled},label);
  const names={memory:'记忆',voice:'语音',media:'媒体'}, states={starting:'启动中',closed:'已关闭',ready:'可读取',degraded:'部分异常',failed:'异常',not_installed:'未启用',unconfigured:'未配置',unverified:'已配置，未实测',unknown:'状态未知'};
  const standardStates={current:'当前',superseded:'已修订',withdrawn:'已撤回'};
  const limits=data?.rules?.limits??{nameChars:60,conventions:200,conventionChars:3000,contentChars:12000};
  const draftRules=draft?.conventions.split('\n').map(s=>s.trim()).filter(Boolean)??[];
  const draftPayload=draft?{name:draft.name.trim(),conventions:draftRules}:null;
  const draftChars=draftPayload?JSON.stringify(draftPayload).length:0;
  const draftError=!draft?'':draftRules.length>limits.conventions?'协作约定最多'+limits.conventions+'条':draftRules.some(s=>s.length>limits.conventionChars)?'每条协作约定最多'+limits.conventionChars+'字':draftChars>limits.contentChars?'个人规则内容最多'+limits.contentChars+'字（含名称与格式）':'';
  const editorStyle={position:'fixed',inset:'50% auto auto 50%',transform:'translate(-50%,-50%)',width:'min(590px,calc(100vw - 32px))',height:'min(370px,calc(100vh - 48px))',maxHeight:'80vh',boxSizing:'border-box',zIndex:1000,display:'grid',gap:10,gridTemplateRows:'auto auto minmax(60px,1fr) auto auto',overflow:'auto',padding:18,border:'1px solid var(--dsw-alias-border-l2,#555)',borderRadius:12,background:'var(--dsw-alias-bg-base, Canvas)',color:'var(--dsw-alias-label-primary, CanvasText)',boxShadow:'0 12px 44px #0006'};
  return h('div',{ className: 'ys-plugin', ref: anchor, style: embedded ? { display: 'contents' } : undefined }, !embedded && h('button',{type:'button',disabled:!sessionId,onClick:()=>setOpen(!open),'aria-expanded':open},'人格'),open&&h(embedded ? EmbeddedPanel : Panel,{anchor,label:'云舒人格',onClose:()=>setOpen(false)},
    h('div',{className:'ys-row'},!embedded && h('h3',null,'云舒人格'),button('刷新',()=>run(async()=>{})),!embedded && button('关闭',()=>setOpen(false))),
    error&&h('div',{role:'alert',className:'ys-error'},error),!data&&!error&&h('small',null,'加载中…'),
    data&&h(React.Fragment,null,h('h3',null,'个人规则'),h('small',{'aria-label':'规则生效方式'},data.rules?.registered?'固定规则已注册':'规则未就绪'),
      draft?h('section',{className:'ys-plugin ys-panel',role:'dialog','aria-label':'编辑个人规则',style:editorStyle,onKeyDown:e=>{if(e.key==='Escape'){e.stopPropagation();setDraft(null);}}},
        h('h3',null,'编辑个人规则'),
        h('input',{'aria-label':'助手名称',maxLength:limits.nameChars,value:draft.name,onChange:e=>setDraft({...draft,name:e.target.value})}),
        h('textarea',{'aria-label':'协作约定',maxLength:limits.contentChars,value:draft.conventions,onChange:e=>setDraft({...draft,conventions:e.target.value}),placeholder:'每行一条个人规则',style:{width:'100%',height:'100%',minHeight:0,resize:'none',lineHeight:1.5}}),
        h('div',null,h('small',null,'协作约定 '+draftRules.length+'/'+limits.conventions+' 条 · 内容 '+draftChars+'/'+limits.contentChars+' 字 · 单条最多'+limits.conventionChars+'字'),draftError&&h('div',{role:'alert',className:'ys-error'},draftError),error&&h('div',{role:'alert',className:'ys-error'},error)),
        h('div',{className:'ys-row'},button('保存个人规则',()=>{if(confirm('保存个人规则？'))void run(async signal=>{await call(sessionId,'identity-save',{content:draftPayload,version:draft.version,confirmed:true},signal);if(!signal.aborted)setDraft(null);});},!draft.name.trim()||Boolean(draftError)),button('取消编辑',()=>setDraft(null)))
      ):
        h('article',{className:'ys-card'},h('strong',null,data.identity.content.name),...data.identity.content.conventions.map((s,i)=>h('p',{key:i},s)),button('编辑个人规则',()=>setDraft({...data.identity.content,conventions:data.identity.content.conventions.join('\n'),version:data.identity.version}))),
      h('details',{className:'ys-history',onToggle:e=>{if(e.currentTarget.open)void run(async signal=>{const rows=await call(sessionId,'identity-history',{},signal);if(!signal.aborted)setHistory(rows);});}},
        h('summary',null,'规则历史'),history.length?history.map(row=>h('article',{className:'ys-card',key:row.version},
          h('strong',null,'v'+row.version+' · '+row.content.name),h('small',null,row.created_at),...row.content.conventions.map((rule,i)=>h('p',{key:i},rule)),
          row.version!==data.identity.version&&button('恢复此版本',()=>{if(confirm('恢复这个规则版本？'))void run(async signal=>{await call(sessionId,'identity-restore',{targetVersion:row.version,version:data.identity.version,confirmed:true},signal);if(!signal.aborted)setHistory(await call(sessionId,'identity-history',{},signal));});}))) : h('p',null,'暂无规则版本记录。')),
      h('h3',null,'个人标准'),
      ...(data.standards??[]).map(row=>h('article',{className:'ys-card',key:row.id},
        h('strong',null,(row.kind==='standard'?'标准':'倾向')+' · '+row.text),
        h('div',{className:'ys-row'},
          button('修订',()=>setStandardDraft({...row,mode:'revise'})),
          button('撤回',()=>setStandardDraft({...row,mode:'withdraw'}))))),
      standardDraft?h('article',{className:'ys-card'},
        standardDraft.mode==='withdraw'?h('strong',null,standardDraft.text):h(React.Fragment,null,
          h('textarea',{'aria-label':'标准内容',maxLength:120,value:standardDraft.text,onChange:e=>setStandardDraft({...standardDraft,text:e.target.value})}),
          h('div',{className:'ys-row'},button('标准',()=>setStandardDraft({...standardDraft,kind:'standard'}),standardDraft.kind==='standard'),button('倾向',()=>setStandardDraft({...standardDraft,kind:'tendency'}),standardDraft.kind==='tendency'))),
        h('input',{'aria-label':standardDraft.mode==='withdraw'?'撤回原因':'修订原因',maxLength:400,value:standardDraft.reason,onChange:e=>setStandardDraft({...standardDraft,reason:e.target.value}),placeholder:standardDraft.id?standardDraft.mode==='withdraw'?'撤回原因':'修订原因':'原因（可选）'}),
        standardDraft.mode!=='withdraw'&&h('input',{'aria-label':'依据',maxLength:600,value:standardDraft.evidence,onChange:e=>setStandardDraft({...standardDraft,evidence:e.target.value}),placeholder:'依据（可选）'}),
        h('div',{className:'ys-row'},button(standardDraft.mode==='withdraw'?'确认撤回':standardDraft.id?'保存修订':'添加标准',()=>{if(confirm(standardDraft.mode==='withdraw'?'撤回这条个人标准？':standardDraft.id?'保存标准修订？':'添加个人标准？'))void run(async signal=>{
          if(standardDraft.mode==='withdraw')await call(sessionId,'standards-withdraw',{id:standardDraft.id,version:standardDraft.version,reason:standardDraft.reason,confirmed:true},signal);
          else await call(sessionId,standardDraft.id?'standards-revise':'standards-create',{...(standardDraft.id?{id:standardDraft.id,version:standardDraft.version}:{}),standard:{text:standardDraft.text,kind:standardDraft.kind,reason:standardDraft.reason,evidence:standardDraft.evidence},confirmed:true},signal);
          if(!signal.aborted){setStandardDraft(null);setStandardHistory([]);}});},!standardDraft.text.trim()||Boolean(standardDraft.id&&!standardDraft.reason.trim())),button('取消',()=>setStandardDraft(null)))):
        button('添加个人标准',()=>setStandardDraft({text:'',kind:'standard',reason:'',evidence:''}),(data.standards??[]).length>=4),
      h('details',{className:'ys-history',onToggle:e=>{if(e.currentTarget.open)void run(async signal=>{const rows=await call(sessionId,'standards-history',{},signal);if(!signal.aborted)setStandardHistory(rows);});}},
        h('summary',null,'标准历史'),standardHistory.length?standardHistory.map(row=>h('article',{className:'ys-card',key:row.id},h('strong',null,'v'+row.version+' · '+(standardStates[row.state]??row.state)),h('p',null,row.text),row.reason&&h('small',null,row.reason))) : h('p',null,'暂无个人标准记录。')),
      h('h3',null,'情感回应'),
      data.affect?.available ? h('article',{className:'ys-card','aria-label':'情感状态'},
        h('div',{className:'ys-row'},h('strong',null,data.affect.enabled?'已开启':'已关闭'),button(data.affect.enabled?'关闭情感回应':'开启情感回应',()=>run(signal=>call(sessionId,'affect-enable',{enabled:!data.affect.enabled},signal)))),
        data.affect.enabled && h(React.Fragment,null,
          h('p',null,'当前感受：'+(data.affect.label??'未判断')),
          h('p',null,'回应方式：'+(data.affect.toneLabel??'自然')),
          data.affect.quote && h('p',null,'依据：'+data.affect.quote),
          data.affect.memoryMatches>0 && h('small',null,'本轮关联记忆：'+data.affect.memoryMatches+' 条'),
          button('清除当前状态',()=>run(signal=>call(sessionId,'affect-reset',{},signal)),!data.affect.strength))):
        h('small',null,data.affect?.error??'情感状态未就绪'),
      h('h3',null,'组件状态'),
      ...data.components.map(row=>h('article',{className:'ys-card',key:row.id,'data-component':row.id},h('strong',null,(names[row.id]??row.id)+' · '+(row.id==='media'&&row.state==='ready'?'已启用':states[row.state]??row.state)),row.error&&h('p',null,row.error),row.id==='voice'&&h('small',null,'麦克风：未知 · 扬声器：未知'),h('small',null,'检查时间：'+row.checkedAt))),
      h('h3',null,'本轮上下文'),
      data.context.status==='composed'?h('article',{className:'ys-card'},h('p',null,'上下文估算：'+data.context.estimatedTokens+' / '+data.context.budget.maxTokens+' token'),h('p',null,'选取 '+data.context.selected.length+' 条 · 省略 '+data.context.omitted.length+' 条'),h('small',null,'缓存用量：未获取')):h('small',null,data.context.status==='degraded'?'上下文暂不可用':'暂无上下文'),
      h('details',null,h('summary',null,'可用能力'),h('div',{className:'ys-row'},h('input',{'aria-label':'查找能力',maxLength:300,value:query,onChange:e=>setQuery(e.target.value),placeholder:'输入能力名称'}),button('查询能力',()=>run(async signal=>{const result=await call(sessionId,'capabilities',{query},signal);if(!signal.aborted)setCapabilities(result);}))),
        ...(capabilities?.tools??[]).map(tool=>h('article',{className:'ys-card',key:tool.name},h('strong',null,tool.name),h('p',null,tool.description),h('small',null,'已注册 · 未探测'))),capabilities?.truncated&&h('small',null,'显示前50项，请缩小查询范围'))
    )));
}


async function uploadMediaFile({ file, sourceId, partIndex, mimeType, sessionId, call, signal, maxBytes, onProgress = () => {} }) {
  if (!file || !Number.isSafeInteger(file.size) || file.size <= 0 || file.size > maxBytes) throw new Error('文件为空或超出单文件上限');
  signal.throwIfAborted();
  const bytes = new Uint8Array(await file.arrayBuffer()); signal.throwIfAborted();
  if (bytes.length !== file.size) throw new Error('文件大小已变更，请重新选择');
  const digest = await crypto.subtle.digest('SHA-256', bytes); signal.throwIfAborted();
  const sha256 = [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('');
  let uploadId;
  try {
    const ticket = await call(sessionId, 'media-upload-begin', { sourceId, partIndex, bytes: bytes.length, sha256, mimeType: mimeType || file.type || 'application/octet-stream', confirmed: true }, signal);
    uploadId = ticket.uploadId; signal.throwIfAborted();
    if (!uploadId || !Number.isSafeInteger(ticket.chunkBytes) || ticket.chunkBytes <= 0 || ticket.chunkBytes > 256 * 1024) throw new Error('上传参数无效');
    onProgress({ received: 0, total: bytes.length });
    for (let offset = 0; offset < bytes.length; offset += ticket.chunkBytes) {
      signal.throwIfAborted(); const chunk = bytes.subarray(offset, offset + ticket.chunkBytes); let binary = '';
      for (let i = 0; i < chunk.length; i += 8192) binary += String.fromCharCode(...chunk.subarray(i, i + 8192));
      const progress = await call(sessionId, 'media-upload-chunk', { uploadId, offset, base64: btoa(binary) }, signal);
      signal.throwIfAborted();
      if (progress.received !== offset + chunk.length || progress.total !== bytes.length) throw new Error('上传进度不一致');
      onProgress({ received: progress.received, total: bytes.length });
    }
    const result = await call(sessionId, 'media-upload-commit', { uploadId }, signal);
    signal.throwIfAborted();
    if (result.status !== 'stored' || result.sha256 !== sha256 || result.bytes !== bytes.length) throw new Error('保存结果不一致，请检查附件状态');
    return result;
  } catch (error) {
    if (uploadId) try { await call(sessionId, 'media-upload-cancel', { uploadId }, AbortSignal.timeout(5000)); }
    catch { throw Object.assign(new Error(error.message + '；上传清理未确认，请重新打开附件检查状态'), { cause: error, code: error.code, details: { ...error.details, uploadCleanupConfirmed: false } }); }
    throw error;
  }
}

function MediaLibrary({sessionId,call,maxBytes,onStored}) {
  const h=React.createElement, [items,setItems]=React.useState([]), [file,setFile]=React.useState(null),
    [busy,setBusy]=React.useState(false),[message,setMessage]=React.useState(''),[opened,setOpened]=React.useState(null);
  const life=React.useRef(null), preview=React.useRef(null), chooser=React.useRef(null),sending=React.useRef(false);
  const clear=()=>{if(preview.current)URL.revokeObjectURL(preview.current);preview.current=null;setOpened(null);};
  const refresh=async signal=>{const r=await call(sessionId,'media-library-list',{},signal);signal.throwIfAborted();setItems(r.items);onStored?.(r.total??r.items.length);};
  React.useEffect(()=>{const a=new AbortController();life.current=a;setFile(null);setItems([]);setMessage('');setBusy(false);sending.current=false;clear();
    refresh(a.signal).catch(e=>{if(!a.signal.aborted)setMessage(e.message);});
    return ()=>{a.abort();if(preview.current)URL.revokeObjectURL(preview.current);preview.current=null;};},[sessionId]);
  async function run(fn){if(sending.current)return;const signal=life.current.signal;sending.current=true;setBusy(true);setMessage('');
    try{await fn(signal);}catch(e){if(!signal.aborted)setMessage(e.message);}finally{if(!signal.aborted){sending.current=false;setBusy(false);}}}
  function upload(){void run(async signal=>{
    const requestId=crypto.randomUUID();
    const send=(sid,action,p,abort)=>action==='media-upload-begin'?call(sid,'media-library-begin',{...p,name:file.name,requestId},abort):call(sid,action,p,abort);
    await uploadMediaFile({file,partIndex:0,mimeType:file.type||'application/octet-stream',sessionId,call:send,signal,maxBytes});
    await refresh(signal);setFile(null);if(chooser.current)chooser.current.value='';setMessage('文件已保存。');
  });}
  function show(row){void run(async signal=>{
    const parts=[];let offset=0;
    while(offset<row.bytes){const r=await call(sessionId,'media-library-read',{id:row.id,part:row.part,digest:row.digest,offset},signal);
      signal.throwIfAborted();const bytes=Uint8Array.from(atob(r.base64),c=>c.charCodeAt(0));
      if(!bytes.length||r.total!==row.bytes||r.digest!==row.digest||r.next!==offset+bytes.length)throw Error('附件读取不完整。');
      parts.push(bytes);offset=r.next;}
    const blob=new Blob(parts,{type:row.mime}), bytes=await blob.arrayBuffer();
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
    signal.throwIfAborted();if(hash!==row.digest)throw Error('附件内容校验失败。');
    clear();preview.current=URL.createObjectURL(blob);setOpened({...row,url:preview.current});
  });}
  const button=(label,fn,extra={})=>h('button',{type:'button',disabled:busy,onClick:fn,...extra},label);
  return h('section',{'aria-label':'工作区附件',className:'ys-card'},
    h('label',null,'选择附件　',h('input',{ref:chooser,type:'file','aria-label':'选择附件',disabled:busy,onChange:e=>setFile(e.target.files[0]??null)})),
    button('导入文件',upload,{disabled:busy||!file}),
    items.length>0 && h('ul',null,items.map(row=>h('li',{key:row.id+':'+row.part},row.name+'　'+row.bytes+' B　',
      button('查看附件',()=>show(row),{'aria-label':'查看附件 '+row.name}),
      row.role==='owner' && button('移除',()=>void run(async signal=>{await call(sessionId,'media-library-remove',{id:row.id,part:row.part,digest:row.digest},signal);await refresh(signal);if(opened?.id===row.id)clear();setMessage('已从资料库移除。');}),{'aria-label':'移除 '+row.name})))),
    opened && h('div',null,/^image\/(?:png|jpeg|gif|webp)$/u.test(opened.mime)?h('img',{src:opened.url,alt:opened.name,style:{maxWidth:'100%',maxHeight:180}}):
      /^audio\//u.test(opened.mime)?h('audio',{src:opened.url,controls:true}):/^video\/(?:mp4|webm)$/u.test(opened.mime)?h('video',{src:opened.url,controls:true,style:{maxWidth:'100%'}}):null,
      h('a',{href:opened.url,download:opened.name},'保存副本'),button('关闭预览',clear)),
    message&&h('p',{role:'status'},message));
}

function MediaView({ sessionId, call, onActiveChange, embedded = false }) {
  const h = React.createElement, anchor = React.useRef(null), life = React.useRef(null), operation = React.useRef(null);
  const [open, setOpen] = React.useState(embedded), [data, setData] = React.useState(null), [error, setError] = React.useState(''), [message, setMessage] = React.useState(''), [busy, setBusy] = React.useState(false);
  const [loadError, setLoadError] = React.useState('');
  const [attachmentSource, setAttachmentSource] = React.useState(''), [attachments, setAttachments] = React.useState(null), [partIndex, setPartIndex] = React.useState('');
  const [file, setFile] = React.useState(null), [fileKey, setFileKey] = React.useState(0), [uploadProgress, setUploadProgress] = React.useState(null);
  const [backup, setBackup] = React.useState(''), [source, setSource] = React.useState(''), [destination, setDestination] = React.useState('');
  React.useEffect(() => {
    const abort = new AbortController(); life.current = abort; let timer;
    setData(null); setError(''); setLoadError(''); setMessage(''); setBusy(false); setBackup(''); setSource(''); setDestination('');
    setAttachmentSource(''); setAttachments(null); setPartIndex(''); setFile(null); setFileKey(n => n + 1); setUploadProgress(null);
    const refresh = async () => {
      try { const result = await call(sessionId, 'media-status', {}, abort.signal); if (!abort.signal.aborted) { setData(result); setLoadError(''); } }
      catch (e) { if (!abort.signal.aborted) setLoadError(e.message); }
      if (!abort.signal.aborted) timer = setTimeout(refresh, 2000);
    };
    if (open && sessionId) void refresh();
    return () => { abort.abort(); clearTimeout(timer); const pending = operation.current; pending?.abort(); if (operation.current === pending) operation.current = null; };
  }, [sessionId, open]);
  React.useEffect(() => { onActiveChange?.(open); return () => onActiveChange?.(false); }, [open]);
  const run = async (action, payload = {}, success = '已完成', execute) => {
    const scopeLife = life.current; if (!scopeLife || scopeLife.signal.aborted || operation.current) return;
    const abort = new AbortController(); operation.current = abort; const signal = AbortSignal.any([scopeLife.signal, abort.signal]);
    setBusy(true); setError(''); setMessage('');
    try {
      const result = execute ? await execute(signal) : await call(sessionId, action, payload, signal);
      if (!signal.aborted) setMessage(typeof success === 'function' ? success(result) : success);
    } catch (e) {
      if (!scopeLife.signal.aborted) {
        if (action === 'media-upload') setUploadProgress(null);
        if (e?.details?.cleanupComplete === false || e?.details?.incompleteDirectory || e?.details?.uploadCleanupConfirmed === false) {
          const leftover = e.details.incompleteDirectory;
          setError(e.message + (leftover && !e.message.includes(leftover) ? '；残留目录：' + leftover : ''));
        } else if (abort.signal.aborted) setMessage(['media-backup', 'media-restore'].includes(action) ? '已请求取消；请检查目标目录' : action === 'media-upload' ? '已请求取消；请检查附件状态' : '已请求取消');
        else setError(e.message);
      }
    } finally {
      if (operation.current === abort) operation.current = null;
      if (!scopeLife.signal.aborted) { setBusy(false); try { const result = await call(sessionId, 'media-status', {}, scopeLife.signal); if (!scopeLife.signal.aborted) setData(result); } catch (e) { if (!scopeLife.signal.aborted) setError(e.message); } }
    }
  };
  const loadParts = (id = attachmentSource, offset = 0) => run('media-parts', { sourceId: id, offset }, result => {
    setAttachmentSource(result.sourceId); setAttachments(result); setPartIndex(''); setFile(null); setFileKey(n => n + 1); setUploadProgress(null); return '附件已加载';
  });
  const selectedPart = attachments?.items.find(item => String(item.partIndex) === partIndex);
  const upload = () => {
    if (!file || !selectedPart?.canImport || !confirm('将所选文件补交到此附件？保留补交标记，不替换原始消息。')) return;
    return run('media-upload', {}, result => { setFile(null); setFileKey(n => n + 1); setAttachments(current => ({ ...current, items: current.items.map(item => item.partIndex === selectedPart.partIndex ? { ...item, origin: result.origin, retained: true, mimeType: result.mimeType } : item) })); return '文件已补交；请重新检查处理状态'; }, signal => uploadMediaFile({ file, sourceId: attachments.sourceId, partIndex: selectedPart.partIndex, mimeType: selectedPart.mimeType, sessionId, call, signal, maxBytes: data.limits.maxAssetBytes, onProgress: progress => { if (!signal.aborted) setUploadProgress(progress); } }));
  };
  const button = (label, fn, disabled = false) => h('button', { type: 'button', onClick: fn, disabled: busy || disabled }, label);
  const scanNames = { idle: '已完成', queued: '等待处理', scanning: '检查中', paused: '已暂停', attention: '需要处理', failed: '检查失败', closed: '已关闭' };
  const jobNames = { pending: '待处理', complete: '已保存', 'reference-only': '仅有引用', partial: '部分完成', failed: '处理失败', withdrawn: '来源已撤回' };
  const errors = { BATCH_LIMIT: '请继续补扫', MEDIA_MISSING: '请重新补交文件', INTEGRITY_ERROR: '文件损坏', PART_LIMIT: '附件数量超限', VAULT_BUSY: '媒体库正在使用', RECOVERY_BUSY: '补扫正在运行' };
  const counts = data?.progress.states ?? {}, total = Object.values(counts).reduce((a, b) => a + b, 0);
  const pending = counts.pending ?? 0;
  const attention = (counts['reference-only'] ?? 0) + (counts.failed ?? 0) + (counts.partial ?? 0);
  const needsRepair = attention > 0 || !!data?.scan.error || (data?.scan.paused && data?.progress.undiscovered) || ['degraded', 'failed'].includes(data?.health?.state);
  const problemJobs = (data?.jobs ?? []).filter(job => ['pending', 'reference-only', 'partial', 'failed'].includes(job.state));
  const attachmentList = attachments && h('div', { className: 'ys-card', style: { minWidth: 0 } },
    h('select', { 'aria-label': '目标附件', style: { minWidth: 0, maxWidth: '100%' }, value: partIndex, disabled: busy, onChange: e => { setPartIndex(e.target.value); setFile(null); setFileKey(n => n + 1); setUploadProgress(null); } },
      h('option', { value: '' }, '选择附件'),
      ...attachments.items.map(item => h('option', { key: item.partIndex, value: String(item.partIndex) }, '附件 '+(item.partIndex + 1)+' · '+(item.name || ({ image: '图片', audio: '音频', video: '视频', file: '文件' }[item.type]))))),
    attachments.nextOffset !== null && button('下一页附件', () => loadParts(attachments.sourceId, attachments.nextOffset)),
    selectedPart && h('div', null,
      h('small', null, selectedPart.origin === 'owner-import' ? '用户补交' : selectedPart.canImport ? '仅有引用' : '内联附件'),
      button('检查文件', () => run('media-verify', { sourceId: attachments.sourceId, partIndex: selectedPart.partIndex }, result => ({ verified: '文件检查通过', missing: '文件缺失', corrupt: '文件损坏', 'not-retained': '尚未保存文件', 'source-unavailable': '来源已撤回', 'source-changed': '来源已变更' }[result.status] ?? '文件检查未完成'))),
      selectedPart.canImport && h(React.Fragment, null,
        h('input', { key: fileKey, type: 'file', 'aria-label': '补交文件', style: { width: '100%', minWidth: 0 }, disabled: busy, onChange: e => { setFile(e.target.files?.[0] ?? null); setUploadProgress(null); } }),
        file && h('small', { style: { overflowWrap: 'anywhere' } }, file.name+' · '+file.size+' 字节'),
        button('确认补交', upload, !file || file.size <= 0 || file.size > data.limits.maxAssetBytes),
        file && (file.size <= 0 || file.size > data.limits.maxAssetBytes) && h('small', { role: 'alert' }, '文件为空或超出单文件上限'),
        uploadProgress && h('div', { className: 'ys-row' }, h('progress', { 'aria-label': '上传进度', value: uploadProgress.received, max: uploadProgress.total }), h('small', null, Math.floor(uploadProgress.received / uploadProgress.total * 100)+'%'))),
      !selectedPart.canImport && h('small', null, '使用补扫保存内联附件')));
  return h('section', { className: 'ys-plugin', ref: anchor, style: embedded ? { minWidth: 0 } : undefined, 'aria-label': '附件与备份' },
    !embedded && h('button', { type: 'button', disabled: !sessionId, onClick: () => setOpen(!open), 'aria-expanded': open }, '附件与备份'),
    open && h(embedded ? EmbeddedPanel : Panel, { anchor, label: '附件与备份', onClose: () => setOpen(false) },
      h('div', { className: 'ys-row' }, h('h3', null, '附件与备份'), !embedded && button('关闭', () => setOpen(false))),
      (error || loadError) && h('div', { role: 'alert', className: 'ys-error' }, error || loadError),
      message && h('div', { role: 'status' }, message),
      busy && h('div', { className: 'ys-row' }, h('span', null, '处理中…'), h('button', { type: 'button', onClick: () => operation.current?.abort() }, '取消操作')),
      !data && !error && !loadError && h('small', null, '读取附件状态…'),
      data && h(React.Fragment, null,
        h(MediaLibrary,{sessionId,call,maxBytes:data.limits.maxAssetBytes,onStored:stored=>setData(value=>value&&({...value,stored}))}),
        h('div', { className: 'ys-card', role: 'status', 'aria-label': '附件状态' },
          h('p', null, !data.stored && !total ? '当前项目暂无已保存附件' : '已保存 '+(data.stored ?? 0)+' 条 · 待处理 '+pending+' 条'+(attention ? ' · 需处理 '+attention+' 条' : '')),
          h('small', null, '内容观察 '+(data.observations ?? 0)+' 条'+(total > 0 ? ' · 仅有引用 '+(counts['reference-only'] ?? 0)+' 条' : ''))),
        needsRepair && h('details', { open: true }, h('summary', null, '处理附件问题'+(attention ? ' · '+attention : '')),
          data.scan.error && h('small', { role: 'alert' }, errors[data.scan.error] ?? '检查失败，请重试'),
          h('div', { className: 'ys-row' },
            button(data.scan.paused ? '继续检查' : '补扫遗漏附件', () => run('media-scan', {}, '检查已启动'), ['queued', 'scanning'].includes(data.scan.state)),
            button('重新检查', () => { if (confirm('重新检查当前项目的全部附件？')) void run('media-recheck', { confirmed: true }, '检查已启动'); })),
          ...problemJobs.map(job => h('div', { className: 'ys-row', key: job.source_id }, h('small', null, (jobNames[job.state] ?? '待处理')+' · '+job.source_id.slice(0, 12)), button('查看', () => loadParts(job.source_id)))),
          h('details', null, h('summary', null, '按来源编号查找'), h('input', { 'aria-label': '附件来源编号', placeholder: '附件来源编号', value: attachmentSource, onChange: e => setAttachmentSource(e.target.value) }), button('查看附件', () => loadParts(), !attachmentSource.trim())),
          attachmentList),
        !needsRepair && h('details', null, h('summary', null, '检查附件'),
          h('small', null, '新附件自动保存；需要时可检查当前项目的历史消息。'),
          button('开始检查', () => run('media-scan', {}, '检查已启动'), ['queued', 'scanning'].includes(data.scan.state))),
        h('details', null, h('summary', null, '备份与恢复'),
          h('input', { 'aria-label': '新备份目录', placeholder: '新备份目录', value: backup, onChange: e => setBackup(e.target.value), maxLength: 3000 }),
          button('创建备份', () => run('media-backup', { directory: backup }, result => '备份已保存：'+result.directory), !backup.trim()),
          h('input', { 'aria-label': '备份来源目录', placeholder: '备份来源目录', value: source, onChange: e => setSource(e.target.value), maxLength: 3000 }),
          h('input', { 'aria-label': '新恢复目录', placeholder: '新恢复目录', value: destination, onChange: e => setDestination(e.target.value), maxLength: 3000 }),
          button('恢复备份', () => { if (confirm('将备份恢复到新目录？')) void run('media-restore', { directory: source, destination, confirmed: true }, result => '已恢复：'+result.directory); }, !source.trim() || !destination.trim()),
          h('small', null, '恢复到新目录，不自动切换当前存档区。')))));
}

function PersonaMediaView(props) {
  return React.createElement(React.Fragment, null, React.createElement(PersonaView, props), React.createElement(MediaView, props));
}

return {inject:["remote","slots"],apply:ctx=>mountUnifiedClient(ctx,"yunshuPersona",remoteSpec("yunshuPersona",z,createTypertRemoteInfo),[{id:"persona",label:"人格",View:PersonaView},{id:"media",label:"媒体",View:MediaView}],React)};
}});
// Generated by scripts/build.mjs. RemoteInfo implementation from the installed DeepSeek Harness SDK (MIT).
window.__ModuleLoader__.load({id:"@yunshu/dsh-desktop/internal-voice",factory:require=>{
const React=require("react");const ReactDOM=require("react-dom");const ReactDOMClient=require("react-dom/client");const {z}=require("zod");
/** Lazy assembly of generated Remote definitions using caller-supplied Zod; no runtime imports. */
/**
 * Retain one generated definition per endpoint without constructing parsers or projections.
 * The class instance builds its shared descriptor/method index on first access;
 * input schemas and JSON Schema projections are cached only when requested.
 * @param spec - compiler-produced method facts and Zod factories.
 * @param zod - the generated artifact's Zod runtime for named-input parsers.
 * @returns a lazy, mountable info instance with no registration or transport effects.
 */
function createTypertRemoteInfo(spec, zod) {
    return new RemoteInfo(spec, zod);
}
class RemoteInfo {
    spec;
    zod;
    index;
    constructor(spec, zod) {
        this.spec = spec;
        this.zod = zod;
    }
    get package() { return this.spec.package; }
    get descriptors() { return this.resolve().descriptors; }
    get methods() { return this.resolve().methods; }
    resolve() {
        if (this.index !== undefined)
            return this.index;
        const zod = this.zod;
        const descriptors = [];
        const methods = Object.create(null);
        for (const [endpoint, definition] of Object.entries(this.spec.methods)) {
            const separator = endpoint.indexOf('/');
            const namespace = endpoint.slice(0, separator);
            const method = endpoint.slice(separator + 1);
            const parameters = definition.parameters.map(parameter => ({ ...parameter, wire: parameter.wire ?? parameter.name }));
            const descriptor = {
                ...definition,
                id: `${this.spec.package}#${endpoint}`,
                namespace,
                method,
                parameters,
                result: definition.result.description === undefined ? definition.result : new ResultValue(definition.result),
            };
            if (definition.invocation.kind === 'direct') {
                const inputs = [];
                const direct = Object.assign(descriptor, {
                    input(options) {
                        const strict = options?.strict === true;
                        return inputs[strict ? 1 : 0] ??= new NamedInput(parameters, strict, zod);
                    },
                    invoke(remote, input, signal) {
                        const named = input;
                        const values = parameters.map(parameter => named[parameter.wire]);
                        if (definition.cancellation !== undefined)
                            values.push(signal);
                        // Namespace access retains the Gateway's mount checks and scoped receiver policy.
                        const receiver = Reflect.get(remote, namespace);
                        const call = Reflect.get(receiver, method);
                        return call.apply(receiver, values);
                    },
                });
                // The generated namespace return type is selected by this same descriptor's mode.
                methods[endpoint] = direct;
            }
            descriptors.push(descriptor);
        }
        return this.index = { descriptors, methods };
    }
}
/**
 * Narrow a Registry descriptor to its generated direct-method capabilities.
 * @param descriptor - a live descriptor, including possible source fallback or Context-only receivers.
 * @returns whether generated named input and direct invocation are available.
 */
function isTypertRemoteMethod(descriptor) {
    return descriptor.invocation.kind === 'direct' && descriptor.result.mode === 'strict'
        && 'input' in descriptor && typeof descriptor.input === 'function'
        && 'invoke' in descriptor && typeof descriptor.invoke === 'function';
}
function optional(parameter) {
    return parameter.source === 'json' && parameter.acceptsUndefined === true;
}
class NamedInput {
    parameters;
    strict;
    zod;
    schema;
    projection;
    constructor(parameters, strict, zod) {
        this.parameters = parameters;
        this.strict = strict;
        this.zod = zod;
    }
    codec(parameter) {
        return this.strict ? parameter.strictCodec : parameter.codec;
    }
    create = () => this.schema ??= this.zod.strictObject(Object.fromEntries(this.parameters.map((parameter) => {
        const value = this.codec(parameter).create();
        return [parameter.wire, optional(parameter) ? value.optional() : value.nonoptional()];
    })));
    get jsonSchema() { return this.project().jsonSchema; }
    get jsonSchemaError() { return this.project().jsonSchemaError; }
    project() {
        if (this.projection !== undefined)
            return this.projection;
        const unavailable = this.parameters.find(parameter => this.codec(parameter).jsonSchema === undefined);
        if (unavailable !== undefined) {
            return this.projection = { jsonSchemaError: this.codec(unavailable).jsonSchemaError ?? `No JSON Schema for parameter ${unavailable.wire}` };
        }
        return this.projection = {
            jsonSchema: {
                type: 'object',
                properties: Object.fromEntries(this.parameters.map(parameter => [parameter.wire, {
                        ...this.codec(parameter).jsonSchema,
                        ...(parameter.description === undefined ? {} : { description: parameter.description }),
                    }])),
                required: this.parameters.filter(parameter => !optional(parameter)).map(parameter => parameter.wire),
                additionalProperties: false,
            },
        };
    }
}
class ResultValue {
    spec;
    projection;
    constructor(spec) {
        this.spec = spec;
    }
    get mode() { return this.spec.mode; }
    get typeSymbol() { return this.spec.typeSymbol; }
    get create() { return this.spec.create; }
    get decode() { return this.spec.decode; }
    get encode() { return this.spec.encode; }
    get description() { return this.spec.description; }
    get jsonSchemaError() { return this.spec.jsonSchemaError; }
    get jsonSchema() {
        if (this.projection === undefined) {
            const schema = this.spec.jsonSchema;
            this.projection = { value: schema === undefined ? undefined : { ...schema, description: this.spec.description } };
        }
        return this.projection.value;
    }
}
//# sourceMappingURL=remote-info.js.map
// One source of truth for both Host and browser Remote descriptions.
function remoteSpec(namespace, z, createTypertRemoteInfo) {
  // z.json() validates correctly but its parsed record strips __proto__ keys.
  // Preserve arbitrary user JSON as data after validation, including backups.
  const json = z.custom(value => z.json().safeParse(value).success, { message: 'Invalid JSON' });
  const codec = (type, schema, jsonSchema) => ({ mode: 'strict', typeSymbol: '@yunshu/' + namespace + '#' + type, create: () => schema, jsonSchema });
  const parameter = (name, schema, jsonSchema, extras = {}) => {
    const c = codec(name, schema, jsonSchema);
    if (extras.source === 'lookup') c.typeSymbol = '@deepseek-ai/dsh-session/types#SessionId';
    return { name, source: 'json', codec: c, strictCodec: c, ...extras };
  };
  return createTypertRemoteInfo({
    package: ({ yunshuMemory: '@yunshu/dsh-memory', yunshuVoice: '@yunshu/dsh-voice', yunshuPersona: '@yunshu/dsh-persona' })[namespace],
    methods: { [namespace + '/request']: {
      service: namespace, description: 'User-owned Yunshu plugin operation', invocation: { kind: 'direct' },
      parameters: [
        parameter('agent', z.string(), { type: 'string' }, { wire: 'agentId', source: 'lookup', lookup: 'agent' }),
        parameter('action', z.string(), { type: 'string' }),
        parameter('payload', json, {}),
      ],
      cancellation: { parameter: 'signal' },
      result: codec('result', json, {}),
      sourceLocation: { file: 'packages/shared/remote-spec.mjs', line: 1, column: 1 },
    } },
  }, z);
}

const entryChipStyles = ".ys-plugin button.ysu-chip{appearance:none;box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 20%,transparent));background:transparent;color:inherit;font:inherit;font-size:12px;line-height:1;white-space:nowrap;cursor:pointer;transition:background .15s ease}.ys-plugin button.ysu-chip:hover{background:var(--dsw-alias-bg-layer-2,color-mix(in srgb,currentColor 10%,transparent))}.ys-plugin button.ysu-chip:disabled{opacity:.45;cursor:default}.ys-plugin button.ysu-chip svg{width:14px;height:14px;flex:0 0 auto;opacity:.85}.ys-plugin .ysu-chip-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary,#888);flex:0 0 auto}.ys-plugin .ysu-chip-dot[data-s=\"ok\"]{background:var(--dsw-alias-state-success-primary,#2e6b53)}.ys-plugin .ysu-chip-dot[data-s=\"work\"]{background:var(--dsw-alias-brand-primary,#356e75)}.ys-plugin .ysu-chip-dot[data-s=\"late\"]{background:var(--dsw-alias-state-error-primary,#9a4a4e)}";
const styles = ".ys-panel button[aria-pressed=\"true\"]{background:color-mix(in srgb,currentColor 12%,transparent);font-weight:600}.ys-panel .ys-primary{background:ButtonFace;color:ButtonText}" + '.ys-plugin{position:relative;display:inline-flex;color:inherit;font:inherit}.ys-plugin button,.ys-plugin input,.ys-plugin textarea,.ys-plugin select{font:inherit;color:inherit}.ys-plugin button{padding:6px 10px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:9px;background:transparent;cursor:pointer}.ys-plugin button:hover{background:color-mix(in srgb,currentColor 8%,transparent)}.ys-plugin button:disabled{opacity:.45;cursor:default}.ys-panel{position:absolute;bottom:calc(100% + 10px);left:0;z-index:40;width:min(520px,80vw);max-height:65vh;overflow:auto;padding:16px;border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:14px;background:Canvas;color:CanvasText;box-shadow:0 12px 36px #0003;display:grid;gap:10px}.ys-panel h3{font-size:15px;margin:0}.ys-panel small{opacity:.72}.ys-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}.ys-panel textarea,.ys-panel input,.ys-panel select{box-sizing:border-box;border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:8px;padding:8px;background:transparent}.ys-panel textarea{width:100%;min-height:72px}.ys-card{padding:10px;border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-radius:10px;display:grid;gap:7px}.ys-card p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.ys-error{color:#b74435;white-space:pre-wrap}.ys-muted{opacity:.6}.ys-primary{font-weight:600}.ys-panel :focus-visible{outline:2px solid #687cf6;outline-offset:2px}' + ".ys-plugin select,\n.ys-panel select,\n.ys-plugin select option,\n.ys-panel select option,\n.ys-plugin select optgroup,\n.ys-panel select optgroup {\n  background-color: Canvas;\n  color: CanvasText;\n}\n\n.ys-plugin select:disabled,\n.ys-panel select:disabled,\n.ys-plugin select option:disabled,\n.ys-panel select option:disabled,\n.ys-plugin select optgroup:disabled,\n.ys-panel select optgroup:disabled {\n  color: GrayText;\n}\n" + entryChipStyles;
function Panel({ anchor, label, onClose, children }) {
  const ref = React.useRef(null), [position, setPosition] = React.useState(null);
  React.useLayoutEffect(() => {
    const place = () => {
      const rect = anchor.current?.getBoundingClientRect(); if (!rect) return;
      const width = Math.min(540, window.innerWidth - 32), height = Math.min(600, Math.max(160, rect.top - 80), window.innerHeight - 96);
      setPosition({ position: 'fixed', left: Math.max(16, Math.min(rect.left, window.innerWidth - width - 16)), bottom: Math.max(16, window.innerHeight - rect.top + 10), width, maxHeight: height, boxSizing: 'border-box', zIndex: 900, fontFamily: 'inherit', fontSize: 13, background: 'var(--dsw-alias-bg-base, Canvas)', color: 'var(--dsw-alias-label-primary, CanvasText)' });
    };
    place(); window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    const key = event => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } };
    const outside = event => { if (!ref.current?.contains(event.target) && !anchor.current?.contains(event.target)) onClose(); };
    document.addEventListener('keydown', key); document.addEventListener('pointerdown', outside);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); document.removeEventListener('keydown', key); document.removeEventListener('pointerdown', outside); };
  }, []);
  return ReactDOM.createPortal(React.createElement('section', { ref, className: 'ys-plugin ys-panel', role: 'region', 'aria-label': label, style: position ?? { visibility: 'hidden' } }, children), document.body);
}
async function mountClient(ctx, namespace, info, View, React) {
  const disposeRemote = await ctx.remote.$mount(info);
  let ui;
  try {
    ui = ctx.inject(['remote.' + namespace, 'slots'], inner => {
      const style = document.createElement('style'); style.textContent = styles; document.head.append(style);
      inner.effect(() => () => style.remove());
      const call = async (sessionId, action, payload = {}, signal) => {
        const result = await inner.remote[namespace].request(sessionId, action, payload, signal);
        if (!result.ok) { const error = new Error(result.error.message); error.code = result.error.code; throw error; }
        return result.value;
      };
      // 收进 dock 抽屉（embedded：只画面板、不画按钮）。dock 可能晚于本 bundle apply，先排队。
      const __dysEntry = { group: 'panel', id: namespace, label: ({ yunshuMemory: '记忆', yunshuPersona: '人格', yunshuVoice: '语音' })[namespace] || namespace, status: () => window.__yunshuHealth?.get(({ yunshuMemory: 'memory', yunshuPersona: 'persona', yunshuVoice: 'voice' })[namespace])?.state ?? 'unknown', describe: () => window.__yunshuHealth?.describe(({ yunshuMemory: 'memory', yunshuPersona: 'persona', yunshuVoice: 'voice' })[namespace]) ?? '健康状态未接通', render: dockProps => React.createElement(View, { sessionId: dockProps.sessionId, call, embedded: true }) };
      if (window.__yunshuDock?.register) { window.__yunshuDock.register(__dysEntry); } else { (window.__yunshuDockQueue = window.__yunshuDockQueue || []).push(__dysEntry); }
    });
    await ui;
  } catch (error) { await ui?.dispose(); await disposeRemote(); throw error; }
  return async () => { await ui.dispose(); await disposeRemote(); };
}

function pcmWave(samples, sampleRate, targetRate = 16000) {
  if (!(samples instanceof Float32Array) || !Number.isFinite(sampleRate) || sampleRate < targetRate) throw new Error('Invalid audio sample rate');
  const length = Math.floor(samples.length * targetRate / sampleRate);
  const out = new ArrayBuffer(44 + length * 2), view = new DataView(out);
  const ascii = (at, s) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  ascii(0, 'RIFF'); view.setUint32(4, 36 + length * 2, true); ascii(8, 'WAVE'); ascii(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, targetRate, true); view.setUint32(28, targetRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  ascii(36, 'data'); view.setUint32(40, length * 2, true);
  // Average each input interval before downsampling, avoiding nearest-neighbour aliasing.
  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * sampleRate / targetRate), end = Math.floor((i + 1) * sampleRate / targetRate);
    let sum = 0; for (let j = start; j < end; j++) sum += Number.isFinite(samples[j]) ? samples[j] : 0;
    const v = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
    view.setInt16(44 + i * 2, Math.round(v * (v < 0 ? 32768 : 32767)), true);
  }
  return new Uint8Array(out);
}
function waveBase64(bytes) {
  let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
class Recording {
  constructor({ onLimit = () => {}, onError = () => {}, autoStop = false, env = globalThis } = {}) {
    this.env = env; this.onLimit = onLimit; this.onError = onError; this.autoStop = autoStop;
    this.parts = []; this.frames = 0; this.cancelled = false; this.finished = false; this.voiced = 0; this.quiet = 0;
  }
  async start() {
    const e = this.env;
    if (!e.navigator?.mediaDevices?.getUserMedia || !e.AudioContext || !e.AudioWorkletNode) throw new Error('This desktop webview does not expose microphone AudioWorklet support');
    try {
      const stream = await e.navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (this.cancelled) { stream.getTracks().forEach(t => t.stop()); return; }
      this.stream = stream; this.context = new e.AudioContext();
      const source = "class YunshuCapture extends AudioWorkletProcessor { process(inputs) { const c=inputs[0]?.[0]; if(c) this.port.postMessage(c.slice()); return true; } } registerProcessor('yunshu-capture',YunshuCapture);";
      const url = e.URL.createObjectURL(new e.Blob([source], { type: 'text/javascript' }));
      try { await this.context.audioWorklet.addModule(url); } finally { e.URL.revokeObjectURL(url); }
      if (this.cancelled) { await this.dispose(); return; }
      this.sampleRate = this.context.sampleRate;
      this.node = new e.AudioWorkletNode(this.context, 'yunshu-capture');
      this.node.port.onmessage = event => {
        if (this.cancelled || this.finished) return;
        const part = new Float32Array(event.data); this.parts.push(part); this.frames += part.length;
        let energy = 0; for (const v of part) energy += v * v;
        if (Math.sqrt(energy / part.length) > 0.012) { this.voiced += part.length; this.quiet = 0; } else this.quiet += part.length;
        if (this.frames >= this.sampleRate * 60 || (this.autoStop && this.voiced > this.sampleRate * 0.25 && this.quiet > this.sampleRate * 1.1)) {
          this.finished = true; this.onLimit();
        }
      };
      this.node.onprocessorerror = () => { this.onError(new Error('Microphone audio processor failed')); void this.dispose(); };
      this.source = this.context.createMediaStreamSource(stream);
      this.gain = this.context.createGain(); this.gain.gain.value = 0;
      this.source.connect(this.node); this.node.connect(this.gain); this.gain.connect(this.context.destination);
      await this.context.resume();
    } catch (error) { await this.dispose(); throw error; }
  }
  async finish() {
    this.finished = true;
    const samples = new Float32Array(this.frames); let offset = 0;
    for (const part of this.parts) { samples.set(part, offset); offset += part.length; }
    const rate = this.sampleRate;
    await this.dispose();
    if (!rate || !samples.length) throw new Error('No audio recorded');
    return pcmWave(samples.subarray(0, rate * 60), rate);
  }
  async dispose() {
    this.cancelled = true;
    this.stream?.getTracks().forEach(t => t.stop()); this.stream = null;
    if (this.node) { this.node.port.onmessage = null; this.node.disconnect(); this.node = null; }
    this.source?.disconnect(); this.source = null; this.gain?.disconnect(); this.gain = null;
    const context = this.context; this.context = null;
    if (context && context.state !== 'closed') await context.close();
    this.parts = [];
  }
}
class LocalSpeaker {
  constructor(env = globalThis) { this.env = env; this.generation = 0; this.queue = []; this.speaking = false; this.owned = false; }
  stop() { this.generation++; this.queue = []; this.speaking = false; if (this.owned) this.env.speechSynthesis?.cancel(); this.owned = false; }
  speak(text) {
    const synth = this.env.speechSynthesis;
    const voices = synth?.getVoices().filter(v => v.localService) ?? [];
    const voice = voices.find(v => /^zh/i.test(v.lang)) ?? voices[0];
    if (!voice) throw new Error('No local system voice is available; install a Windows speech voice first');
    this.queue.push(...String(text).slice(0, 12000).match(/[^。！？.!?\n]{1,180}[。！？.!?\n]?/g) ?? []);
    if (this.queue.length > 150) this.queue = this.queue.slice(-150);
    const generation = this.generation;
    const next = () => {
      if (generation !== this.generation || !this.queue.length) { if (generation === this.generation) this.speaking = false; return; }
      const utterance = new this.env.SpeechSynthesisUtterance(this.queue.shift());
      utterance.voice = voice; utterance.lang = voice.lang;
      utterance.onend = next; utterance.onerror = () => this.stop();
      this.owned = true; this.speaking = true; synth.speak(utterance);
    };
    if (!this.speaking) next();
  }
}

// Browser-only orchestration primitives. Capture, VAD loading, transport and
// AudioContext scheduling are injected/owned by the host, not hidden here.
const VOICE_TIMING = Object.freeze({
  sampleRate: 16000, frameSamples: 320, frameMs: 20, preRollFrames: 20,
  activityIntervalMs: 50, speechThreshold: 0.025, bargeInThreshold: 0.06,
  speechStartFrames: 2, silenceMs: 650, minimumUtteranceMs: 180,
  maximumUtteranceMs: 20000, playbackGapMs: 2600,
  duckGain: 0.3, holdMs: 400, releaseAfterQuietMs: 300, rampSeconds: 0.03,
});

const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const generationValid = value => Number.isSafeInteger(value) && value >= 0;
const normalized = value => Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
const quantize = value => Math.round(normalized(value) * (value < 0 ? 32768 : 32767));

/** Stateful linear resampling: chunk boundaries cannot drop interpolation samples. */
class PcmFramer {
  constructor({ inputSampleRate = 16000, sampleRate = 16000, frameSamples = 320, maxInputSamples = 1048576 } = {}) {
    if (!Number.isFinite(inputSampleRate) || inputSampleRate < 8000 || inputSampleRate > 192000) throw new RangeError('Invalid input sample rate');
    if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 48000) throw new RangeError('Invalid output sample rate');
    if (!Number.isInteger(frameSamples) || frameSamples < 1 || frameSamples > 48000) throw new RangeError('Invalid frame size');
    if (!Number.isInteger(maxInputSamples) || maxInputSamples < 1) throw new RangeError('Invalid input bound');
    this.inputSampleRate = inputSampleRate; this.sampleRate = sampleRate;
    this.frameSamples = frameSamples; this.maxInputSamples = maxInputSamples;
    this.reset();
  }
  reset() {
    this.inputSamples = 0; this.outputSamples = 0; this.tail = 0;
    this.partial = new Int16Array(this.frameSamples); this.partialLength = 0;
  }
  push(samples) {
    if (!(samples instanceof Float32Array)) throw new TypeError('Expected Float32Array microphone samples');
    if (samples.length > this.maxInputSamples) throw new RangeError('Microphone chunk exceeds bound');
    if (!samples.length) return [];
    const before = this.inputSamples, end = before + samples.length, frames = [];
    const read = absolute => absolute < before ? this.tail : normalized(samples[absolute - before]);
    const ratio = this.inputSampleRate / this.sampleRate;
    while (true) {
      let position = this.outputSamples * ratio;
      const nearest = Math.round(position);
      if (Math.abs(position - nearest) < 1e-8) position = nearest;
      const left = Math.floor(position), fraction = position - left;
      if (left >= end || (fraction > 0 && left + 1 >= end)) break;
      const a = read(left), value = fraction ? a + (read(left + 1) - a) * fraction : a;
      this.partial[this.partialLength++] = quantize(value); this.outputSamples++;
      if (this.partialLength === this.frameSamples) {
        frames.push(this.partial); this.partial = new Int16Array(this.frameSamples); this.partialLength = 0;
      }
    }
    this.tail = normalized(samples[samples.length - 1]); this.inputSamples = end;
    return frames;
  }
  snapshot() { return { inputSamples: this.inputSamples, outputSamples: this.outputSamples, pendingSamples: this.partialLength }; }
}

/** Incremental text DELTAS, not cumulative transcript snapshots. */
class StreamingTextQueue {
  constructor({ maxSentence = 180, maxBuffered = 12000, maxQueued = 128 } = {}) {
    for (const value of [maxSentence, maxBuffered, maxQueued]) {
      if (!Number.isInteger(value) || value < 1) throw new RangeError('Invalid text queue bound');
    }
    this.maxSentence = maxSentence; this.maxBuffered = maxBuffered; this.maxQueued = maxQueued;
    this.clear();
  }
  clear() { this.buffer = ''; this.queue = []; this.closed = false; }
  push(delta, { final = false } = {}) {
    if (typeof delta !== 'string') throw new TypeError('Expected a text delta');
    if (this.closed) {
      if (!delta && final) return [];
      throw new Error('Speech text stream is already final');
    }
    const combined = this.buffer + delta, lastCode = combined.charCodeAt(combined.length - 1);
    const pendingSurrogate = !final && lastCode >= 0xd800 && lastCode <= 0xdbff ? combined.slice(-1) : '';
    const chars = Array.from(pendingSurrogate ? combined.slice(0, -1) : combined), produced = [];
    if (chars.length + pendingSurrogate.length > this.maxBuffered) throw new RangeError('Speech text buffer exceeds bound');
    let start = 0, i = 0;
    while (i < chars.length) {
      const ch = chars[i];
      let terminal = /[。！？!?；;\n]/u.test(ch);
      if (ch === '.') {
        const decimal = /[0-9]/u.test(chars[i - 1] || '') && /[0-9]/u.test(chars[i + 1] || '');
        terminal = !decimal && (i + 1 < chars.length || final);
      }
      if (terminal || i - start + 1 >= this.maxSentence) {
        let end = i + 1;
        if (terminal) {
          while (end < chars.length && /[。！？!?；;”’」』）)]/u.test(chars[end]) && end - start < this.maxSentence) end++;
        }
        const text = chars.slice(start, end).join('').trim();
        if (text) produced.push(text);
        start = end; i = end;
      } else i++;
    }
    let buffer = chars.slice(start).join('') + pendingSurrogate;
    if (final) { if (buffer.trim()) produced.push(buffer.trim()); buffer = ''; }
    if (this.queue.length + produced.length > this.maxQueued) throw new RangeError('Speech sentence queue exceeds bound');
    // Bounds fail atomically: existing text/queue is untouched until here.
    this.buffer = buffer; this.queue.push(...produced); this.closed = Boolean(final);
    return produced.slice();
  }
  shift() { return this.queue.shift(); }
  drain() { const result = this.queue; this.queue = []; return result; }
  snapshot() { return { bufferedCharacters: Array.from(this.buffer).length, queued: this.queue.length, closed: this.closed }; }
}

function copyPcmBytes(pcm) {
  if (pcm instanceof Int16Array) {
    const out = new Uint8Array(pcm.length * 2), view = new DataView(out.buffer);
    for (let i = 0; i < pcm.length; i++) view.setInt16(i * 2, pcm[i], true);
    return out;
  }
  if (pcm instanceof Uint8Array) return pcm.slice();
  if (pcm instanceof ArrayBuffer) return new Uint8Array(pcm.slice(0));
  throw new TypeError('Expected PCM bytes or Int16Array');
}

/** Validates order and ownership; does not itself schedule audible output. */
class OrderedPcmPlayback {
  constructor({ maxJobs = 256, maxSpeeches = 4096, maxChunkBytes = 1048576 } = {}) {
    for (const value of [maxJobs, maxSpeeches, maxChunkBytes]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new RangeError('Invalid playback bound');
    }
    this.maxJobs = maxJobs; this.maxSpeeches = maxSpeeches; this.maxChunkBytes = maxChunkBytes;
    this.stop();
  }
  start({ sessionId, generation = 0 } = {}) {
    if (!identifier(sessionId) || !generationValid(generation)) throw new TypeError('Invalid playback session identity');
    this.stop(); this.sessionId = sessionId; this.generation = generation; this.running = true;
  }
  matches(meta) { return this.running && meta?.sessionId === this.sessionId && meta?.generation === this.generation; }
  acceptSpeech(meta) {
    if (!this.matches(meta) || !identifier(meta.speechId)) return false;
    if (meta.speechId === this.speechId) return true;
    if (this.retired.has(meta.speechId) || this.retired.size >= this.maxSpeeches) return false;
    if (this.speechId) this.retired.add(this.speechId);
    this.speechId = meta.speechId; this.jobs.clear(); this.activeJob = null;
    return true;
  }
  invalidateSpeech() {
    if (this.speechId) this.retired.add(this.speechId);
    this.speechId = null; this.jobs.clear(); this.activeJob = null;
  }
  stop() {
    this.running = false; this.sessionId = null; this.generation = null; this.speechId = null;
    this.jobs = new Map(); this.retired = new Set(); this.activeJob = null;
  }
  acceptAudio(meta) {
    if (!this.matches(meta)) return { accepted: false, reason: 'stale_session' };
    if (!this.speechId || meta.speechId !== this.speechId) return { accepted: false, reason: 'stale_speech' };
    const fail = reason => { this.invalidateSpeech(); return { accepted: false, reason, stop: true }; };
    if (!identifier(meta.speechJobId) || !Number.isSafeInteger(meta.sequence) || meta.sequence < 0) return fail('invalid_audio_identity');
    if (meta.encoding !== 'pcm_s16le' || meta.channels !== 1 || !Number.isInteger(meta.sampleRate) || meta.sampleRate < 8000 || meta.sampleRate > 48000) return fail('invalid_audio_format');
    const bytes = meta.pcm?.byteLength;
    if (!Number.isSafeInteger(bytes) || !bytes || bytes % 2 || bytes > this.maxChunkBytes) return fail('invalid_audio_size');
    let pcm;
    try { pcm = copyPcmBytes(meta.pcm); } catch { return fail('invalid_audio_format'); }
    const previous = this.jobs.get(meta.speechJobId);
    if (previous?.final) return fail('finalized_job');
    if (meta.sequence !== (previous?.nextSequence ?? 0)) return fail('audio_sequence');
    if (previous && previous.sampleRate !== meta.sampleRate) return fail('audio_format_changed');
    if (!previous && this.jobs.size >= this.maxJobs) return fail('audio_job_limit');
    if (this.activeJob && this.activeJob !== meta.speechJobId) return fail('audio_job_interleaving');
    const final = meta.final === true;
    this.jobs.set(meta.speechJobId, { nextSequence: meta.sequence + 1, sampleRate: meta.sampleRate, final });
    this.activeJob = final ? null : meta.speechJobId;
    const chunk = {
      sessionId: this.sessionId, generation: this.generation, speechId: this.speechId,
      speechJobId: meta.speechJobId, sequence: meta.sequence, sampleRate: meta.sampleRate,
      channels: 1, encoding: 'pcm_s16le', pcm, final,
    };
    return { accepted: true, chunk };
  }
  accept(meta) { return this.acceptAudio(meta); }
  snapshot() { return { running: this.running, speechId: this.speechId, jobs: this.jobs.size, retiredSpeeches: this.retired.size }; }
}

/**
 * Event-driven capture/turn/speech orchestration. VAD recognizes speech, not a
 * person's identity. With no VAD, RMS candidates require ASR confirmation to
 * interrupt playback. No provider, microphone, timer or network is created here.
 */
class StreamingVoiceEngine {
  constructor({ onEvent = () => {}, vad = null, clock = () => globalThis.performance?.now() ?? Date.now(), timing = {}, maxVadQueue = 256, maxPendingTurns = 8, playback = {} } = {}) {
    if (typeof onEvent !== 'function' || typeof clock !== 'function') throw new TypeError('Expected event callback and clock');
    if (vad !== null && typeof vad?.push !== 'function') throw new TypeError('VAD must expose push(Int16Array)');
    this.timing = Object.freeze({ ...VOICE_TIMING, ...timing });
    for (const value of Object.values(this.timing)) if (!Number.isFinite(value) || value < 0) throw new RangeError('Invalid voice timing');
    if (this.timing.sampleRate !== 16000 || this.timing.frameSamples !== 320 || this.timing.frameMs !== 20) throw new RangeError('Capture contract is 16 kHz / 320 samples / 20 ms');
    if (!Number.isInteger(this.timing.preRollFrames) || this.timing.preRollFrames < 1 || this.timing.preRollFrames > 200 || this.timing.activityIntervalMs < 20 || !Number.isInteger(this.timing.speechStartFrames) || this.timing.speechStartFrames < 1 || this.timing.maximumUtteranceMs < this.timing.minimumUtteranceMs || this.timing.duckGain > 1) throw new RangeError('Invalid segmentation timing');
    if (!Number.isSafeInteger(maxVadQueue) || maxVadQueue < 1 || !Number.isSafeInteger(maxPendingTurns) || maxPendingTurns < 1) throw new RangeError('Invalid VAD queue bound');
    this.onEvent = onEvent; this.vad = vad; this.clock = clock;
    this.maxVadQueue = maxVadQueue; this.maxPendingTurns = maxPendingTurns;
    this.playback = new OrderedPcmPlayback(playback); this.text = new StreamingTextQueue();
    this.running = false; this.sessionId = null; this.generation = null;
    this._epoch = 0; this._nextGeneration = 0; this._identities = new Set();
    this._cleanups = new Set(); this._vadQueue = []; this._vadBusy = null;
    this._preroll = []; this._turns = new Map(); this._recentTurns = new Map();
    this._turn = null; this._duck = null; this._playbackActive = false; this._lastPlaybackAt = null;
    this._capturedMs = 0; this._startAt = 0; this._frameCounter = 0;
  }
  _emit(type, data = {}) {
    const event = { type, sessionId: this.sessionId, generation: this.generation, ...data };
    // A UI exception must not corrupt capture ownership or leak resources.
    try { this.onEvent(event); } catch (error) { this.lastListenerError = error; }
    return event;
  }
  _now() {
    const value = this.clock();
    return Math.max(Number.isFinite(value) ? value : this._startAt, this._startAt + this._capturedMs);
  }
  _owned(turn) { return this.running && turn?.epoch === this._epoch && !turn.closed; }
  start({ sessionId, inputSampleRate = 16000, generation = this._nextGeneration } = {}) {
    if (!identifier(sessionId) || !generationValid(generation)) throw new TypeError('Invalid voice session identity');
    const key = JSON.stringify([sessionId, generation]);
    if (this._identities.has(key)) throw new Error('Cannot reuse a voice session generation');
    if (this._identities.size >= 4096) throw new RangeError('Session identity history exhausted; create a new engine');
    const framer = new PcmFramer({ inputSampleRate });
    const now = this.clock(); if (!Number.isFinite(now)) throw new TypeError('Clock must return finite milliseconds');
    if (this.running) void this.stop('restart');
    this._epoch++; this._identities.add(key); this._nextGeneration = Math.max(this._nextGeneration, generation + 1);
    this.sessionId = sessionId; this.generation = generation; this.running = true; this.framer = framer;
    this._startAt = now; this._capturedMs = 0; this._frameCounter = 0; this._turnCounter = 0;
    this._nextActivityAt = this.timing.activityIntervalMs; this._activityEnergy = 0; this._activitySamples = 0; this._loudStreak = 0;
    this._preroll = []; this._turns = new Map(); this._recentTurns = new Map(); this._turn = null;
    this._vadEnabled = Boolean(this.vad); this._vadQueue = [];
    this._duck = null; this._playbackActive = false; this._lastPlaybackAt = null;
    this._textSequence = 0; this._textEnded = false; this.text.clear();
    this.playback.start({ sessionId, generation });
    this._emit('session_start', { sampleRate: 16000, inputSampleRate, frameMs: 20, humanVad: this._vadEnabled });
    if (!this._vadEnabled) this._emit('warning', { code: 'vad_unavailable', message: 'RMS candidates use ASR confirmation; no human-speech VAD is loaded.' });
    return { sessionId, generation, sampleRate: 16000, frameMs: 20 };
  }
  push(samples) {
    if (!this.running) return 0;
    const epoch = this._epoch, frames = this.framer.push(samples); let count = 0;
    if (frames.length) {
      // A session may be opened for TTS long before microphone permission is
      // granted. Anchor capture at its first PCM frame, not at session creation.
      const wallNow = this.clock(), expected = this._startAt + this._capturedMs;
      if (Number.isFinite(wallNow) && !this._frameCounter) this._startAt = Math.max(this._startAt, wallNow);
      else if (Number.isFinite(wallNow) && wallNow - expected > 250) {
        // A suspended device cannot splice old preroll or a half-utterance into
        // a new live capture interval. Pending VAD remains owned by its old turn.
        this._endTurn('capture_gap'); this._preroll = [];
        this._loudStreak = 0; this._activityEnergy = 0; this._activitySamples = 0;
        this._startAt += wallNow - expected;
        this._emit('warning', { code: 'capture_gap', message: 'A capture gap ended the previous audio turn.' });
      }
    }
    for (const pcm of frames) {
      if (!this.running || epoch !== this._epoch) break;
      this._processFrame(pcm); count++;
    }
    return count;
  }
  _isAudible(now = this._now()) {
    return Boolean(this.playback.speechId && (this._playbackActive || (this._lastPlaybackAt !== null && now - this._lastPlaybackAt <= this.timing.playbackGapMs)));
  }
  setPlaybackActive(active) {
    if (!this.running) return;
    if (active || this._playbackActive) this._lastPlaybackAt = this._now();
    this._playbackActive = Boolean(active);
  }
  tick(now = this._now()) {
    if (!this.running || !Number.isFinite(now)) return;
    if (this._duck && now - this._duck.lastAt >= this.timing.releaseAfterQuietMs) this._restoreGain();
  }
  _processFrame(pcm) {
    const epoch = this._epoch; this._capturedMs += 20; this._frameCounter++;
    const at = this._startAt + this._capturedMs;
    let energy = 0; for (const sample of pcm) energy += (sample / 32768) ** 2;
    const rms = Math.sqrt(energy / pcm.length);
    const threshold = this._isAudible(at) ? this.timing.bargeInThreshold : this.timing.speechThreshold;
    const frame = { pcm, at, index: this._frameCounter, loud: rms >= threshold, pending: this._vadEnabled, human: false, turn: null };
    this.tick(at);
    if (!this.running || epoch !== this._epoch) return;
    if (this._turn) this._attachFrame(this._turn, frame);
    else {
      this._preroll.push(frame);
      if (this._preroll.length > this.timing.preRollFrames) this._preroll.shift();
    }
    this._activityEnergy += energy; this._activitySamples += pcm.length;
    if (this._capturedMs >= this._nextActivityAt) {
      const activityRms = Math.sqrt(this._activityEnergy / this._activitySamples);
      this._activityEnergy = 0; this._activitySamples = 0;
      while (this._nextActivityAt <= this._capturedMs) this._nextActivityAt += this.timing.activityIntervalMs;
      this._loudStreak = activityRms >= threshold ? this._loudStreak + 1 : 0;
      if (!this._turn && this._loudStreak >= this.timing.speechStartFrames) this._beginTurn();
    }
    if (!this.running || epoch !== this._epoch) return;
    if (this._vadEnabled) this._enqueueVad(frame);
    else frame.pending = false;
    const turn = this._turn;
    if (!this._owned(turn)) return;
    this._flushTurn(turn);
    const duration = at - turn.firstAt + 20;
    if (duration >= this.timing.maximumUtteranceMs) this._endTurn('max_duration');
    else if (at - turn.lastLoudAt >= this.timing.silenceMs) this._endTurn('silence');
  }
  _attachFrame(turn, frame) {
    frame.turn = turn; turn.held.push(frame); turn.frameCount++; turn.lastAt = frame.at;
    if (frame.pending) turn.pendingVad++;
    if (frame.loud) { turn.voicedMs += 20; turn.lastLoudAt = frame.at; }
  }
  _beginTurn() {
    if (this._turns.size >= this.maxPendingTurns) this._fallbackVad('vad_pending_turn_limit');
    const frames = this._preroll; this._preroll = [];
    const turn = {
      epoch: this._epoch, turnId: 'turn-' + this.generation + '-' + (++this._turnCounter),
      firstAt: frames[0]?.at ?? this._now(), lastAt: this._now(), lastLoudAt: this._now(),
      frameCount: 0, voicedMs: 0, sequence: 0, held: [], pendingVad: 0,
      confirmed: false, fallback: !this._vadEnabled, ended: false, closed: false,
      interruptSpeechId: this._isAudible() ? this.playback.speechId : null,
    };
    this._turn = turn; this._turns.set(turn.turnId, turn);
    for (const frame of frames) this._attachFrame(turn, frame);
    this._emit('turn_start', { turnId: turn.turnId, sampleRate: 16000, frameMs: 20, preRollFrames: frames.length, humanVad: false });
    if (!this._owned(turn)) return;
    const humanFrame = frames.find(frame => frame.human);
    if (humanFrame) this._confirmVad(turn, humanFrame);
    this._flushTurn(turn);
  }
  _flushTurn(turn) {
    if (!this._owned(turn) || (!turn.confirmed && !turn.fallback)) return;
    while (turn.held.length && this._owned(turn)) {
      const frame = turn.held.shift();
      this._emit('audio_frame', {
        turnId: turn.turnId, sequence: turn.sequence++, pcm: frame.pcm.slice(),
        sampleRate: 16000, channels: 1, encoding: 'pcm_s16le', frameMs: 20, humanVad: turn.confirmed,
      });
    }
  }
  _endTurn(reason) {
    const turn = this._turn;
    if (!this._owned(turn)) return;
    this._turn = null; this._loudStreak = 0; turn.ended = true; turn.reason = reason;
    this._tryFinalize(turn);
  }
  _tryFinalize(turn) {
    if (!this._owned(turn) || !turn.ended) return;
    if (turn.voicedMs < this.timing.minimumUtteranceMs) return this._finalize(turn, 'too_short');
    if (turn.confirmed || turn.fallback) { this._flushTurn(turn); return this._finalize(turn); }
    if (!turn.pendingVad) this._finalize(turn, 'no_human_speech');
  }
  _finalize(turn, discarded = null) {
    if (!this._owned(turn)) return;
    turn.closed = true; turn.held = []; this._turns.delete(turn.turnId);
    this._recentTurns.set(turn.turnId, { ...turn, discarded, held: [] });
    while (this._recentTurns.size > 16) this._recentTurns.delete(this._recentTurns.keys().next().value);
    this._emit(discarded ? 'turn_discarded' : 'turn_end', {
      turnId: turn.turnId, frameCount: turn.frameCount, emittedFrames: turn.sequence,
      durationMs: turn.lastAt - turn.firstAt + 20, voicedMs: turn.voicedMs,
      reason: discarded || turn.reason, humanVad: turn.confirmed,
    });
  }
  _enqueueVad(frame) {
    if (this._vadQueue.length >= this.maxVadQueue) { this._fallbackVad('vad_backlog'); return; }
    this._vadQueue.push({ frame, epoch: this._epoch }); this._pumpVad();
  }
  _pumpVad() {
    if (this._vadBusy || !this.running || !this._vadEnabled) return;
    while (this._vadQueue.length && !this._vadBusy && this.running && this._vadEnabled) {
      const job = this._vadQueue.shift();
      if (job.epoch !== this._epoch || !job.frame) continue;
      let result;
      try { result = this.vad.push(job.frame.pcm.slice()); }
      catch { this._fallbackVad('vad_failed'); return; }
      if (result && typeof result.then === 'function') {
        this._vadBusy = job;
        Promise.resolve(result).then(value => this._settleVad(job, value), () => {
          if (this.running && job.epoch === this._epoch) this._fallbackVad('vad_failed');
        }).finally(() => {
          if (this._vadBusy === job) this._vadBusy = null;
          this._pumpVad();
        });
      } else this._settleVad(job, result);
    }
  }
  _settleVad(job, result) {
    if (!this.running || job.epoch !== this._epoch || !job.frame || !this._vadEnabled) return;
    if (result != null && (typeof result !== 'object' || typeof result.speech !== 'boolean')) { this._fallbackVad('vad_invalid_result'); return; }
    const frame = job.frame, turn = frame.turn;
    frame.pending = false; frame.human = result?.speech === true;
    frame.score = Number.isFinite(result?.score) ? result.score : null;
    if (turn && !turn.closed) {
      turn.pendingVad = Math.max(0, turn.pendingVad - 1);
      if (frame.human) this._confirmVad(turn, frame);
      this._tryFinalize(turn);
    }
  }
  _confirmVad(turn, frame) {
    if (!this._owned(turn)) return;
    if (!turn.confirmed) {
      turn.confirmed = true;
      this._emit('turn_confirmed', { turnId: turn.turnId, source: 'human_vad', score: frame.score ?? null, humanVad: true });
      this._flushTurn(turn);
    }
    // Delayed or ended-turn classifications may authorize ASR buffering, never
    // stop a newer response. A decision > 250 ms behind capture is not live.
    const now = this._now();
    if (!this._owned(turn) || turn !== this._turn || turn.ended || now - frame.at > 250 || !turn.interruptSpeechId || turn.interruptSpeechId !== this.playback.speechId || !this._isAudible(now)) return;
    if (!this._duck || this._duck.turnId !== turn.turnId || now - this._duck.lastAt >= this.timing.releaseAfterQuietMs) {
      this._restoreGain();
      this._duck = { turnId: turn.turnId, speechId: this.playback.speechId, firstAt: now, lastAt: now };
      this._emit('playback_gain', { gain: this.timing.duckGain, rampSeconds: this.timing.rampSeconds, speechId: this.playback.speechId });
    } else this._duck.lastAt = now;
    if (this._duck && now - this._duck.firstAt >= this.timing.holdMs) this._interruptPlayback('human_speech', turn.interruptSpeechId);
  }
  _fallbackVad(code) {
    if (!this._vadEnabled) return;
    this._vadEnabled = false; this._vadQueue = [];
    this._restoreGain();
    this._emit('warning', { code, message: 'Human-speech VAD unavailable; using ASR-confirmed candidates.', humanVad: false });
    for (const turn of [...this._turns.values()]) {
      turn.pendingVad = 0; turn.fallback = true;
      this._flushTurn(turn); this._tryFinalize(turn);
    }
  }
  _restoreGain() {
    if (!this._duck) return;
    const speechId = this._duck.speechId; this._duck = null;
    this._emit('playback_gain', { gain: 1, rampSeconds: this.timing.rampSeconds, speechId });
  }
  _interruptPlayback(reason, speechId = this.playback.speechId, notifyRemote = true) {
    if (!speechId || speechId !== this.playback.speechId) return false;
    this.playback.invalidateSpeech(); this.text.clear(); this._textSequence = 0; this._textEnded = false;
    this._playbackActive = false; this._lastPlaybackAt = null;
    this._emit('playback_stop', { reason, speechId, intent: 'stop_playback', notifyRemote });
    this._restoreGain(); return true;
  }
  stopPlayback(reason = 'user_stop') {
    if (!this.running) return false;
    return this._interruptPlayback(reason, this.playback.speechId, false);
  }
  confirmTranscript({ sessionId, generation, turnId, text } = {}) {
    if (!this.running || sessionId !== this.sessionId || generation !== this.generation || typeof text !== 'string' || !text.trim()) return false;
    const turn = this._turns.get(turnId) || this._recentTurns.get(turnId);
    if (!turn || turn.epoch !== this._epoch || turn.discarded) return false;
    this._emit('transcript_confirmed', { turnId, source: 'asr', humanVad: turn.confirmed });
    if (turn.interruptSpeechId === this.playback.speechId && this._isAudible()) this._interruptPlayback('asr_confirmed', turn.interruptSpeechId);
    return true;
  }
  acceptSpeech(meta) {
    if (!this.running) return false;
    const previous = this.playback.speechId;
    if (!this.playback.acceptSpeech(meta)) return false;
    if (previous === meta.speechId) return true;
    this.text.clear(); this._textSequence = 0; this._textEnded = false;
    this._playbackActive = false; this._lastPlaybackAt = null; this._restoreGain();
    if (previous) this._emit('playback_stop', { reason: 'speech_replaced', speechId: previous, intent: 'stop_playback', notifyRemote: false });
    return true;
  }
  acceptAudio(meta) {
    if (!this.running) return { accepted: false, reason: 'session_stopped' };
    const speechId = this.playback.speechId, result = this.playback.acceptAudio(meta);
    if (result.accepted) {
      this._lastPlaybackAt = this._now();
      this._emit('playback_audio', { ...result.chunk, pcm: result.chunk.pcm.slice() });
    } else if (result.stop) {
      this._playbackActive = false; this._lastPlaybackAt = null; this.text.clear(); this._restoreGain();
      this._emit('playback_stop', { reason: result.reason, speechId, intent: 'stop_playback', notifyRemote: false });
    }
    return result;
  }
  pushText(delta, { final = false, sessionId = this.sessionId, generation = this.generation, speechId = this.playback.speechId } = {}) {
    if (!this.running || sessionId !== this.sessionId || generation !== this.generation || !speechId || speechId !== this.playback.speechId) return [];
    const sentences = this.text.push(delta, { final }); this.text.drain();
    const epoch = this._epoch, events = [];
    for (let i = 0; i < sentences.length; i++) {
      if (!this.running || epoch !== this._epoch || speechId !== this.playback.speechId) break;
      events.push(this._emit('speech_text', { speechId, sequence: this._textSequence++, text: sentences[i], final: Boolean(final && i === sentences.length - 1) }));
    }
    if (final && !this._textEnded && this.running && epoch === this._epoch && speechId === this.playback.speechId) {
      this._textEnded = true; this._emit('speech_text_end', { speechId, sentenceCount: this._textSequence });
    }
    return events;
  }
  ownCleanup(fn) {
    if (typeof fn !== 'function') throw new TypeError('Expected cleanup function');
    this._cleanups.add(fn); return () => this._cleanups.delete(fn);
  }
  stop(reason = 'stopped') {
    const wasRunning = this.running, sessionId = this.sessionId, generation = this.generation, speechId = this.playback.speechId;
    this.running = false; this._epoch++;
    this._preroll = []; this._vadQueue = [];
    if (this._vadBusy) this._vadBusy.frame = null;
    for (const turn of this._turns.values()) { turn.closed = true; turn.held = []; }
    this._turns.clear(); this._recentTurns.clear(); this._turn = null;
    this.framer?.reset(); this.text.clear(); this.playback.stop();
    this._vadEnabled = false; this._capturedMs = 0; this._frameCounter = 0;
    this._activityEnergy = 0; this._activitySamples = 0; this._loudStreak = 0;
    this._playbackActive = false; this._lastPlaybackAt = null; this._restoreGain();
    if (wasRunning) {
      this._emit('playback_stop', { reason, speechId, intent: 'stop_playback', notifyRemote: false });
      this._emit('session_stop', { reason });
    }
    const cleanups = [...this._cleanups]; this._cleanups.clear();
    return Promise.allSettled(cleanups.map(fn => Promise.resolve().then(fn))).then(results => {
      for (const result of results) if (result.status === 'rejected') this._emit('warning', { sessionId, generation, code: 'cleanup_failed', message: 'An owned resource failed to clean up.' });
      return results;
    });
  }
  snapshot() {
    return {
      running: this.running, sessionId: this.sessionId, generation: this.generation,
      capturedFrames: this._frameCounter, preRollFrames: this._preroll.length,
      activeTurnId: this._turn?.turnId ?? null, pendingTurns: this._turns.size,
      vadEnabled: this._vadEnabled === true, queuedVadFrames: this._vadQueue.length,
      vadInFlight: Boolean(this._vadBusy?.epoch === this._epoch),
      gain: this._duck ? this.timing.duckGain : 1,
      text: this.text.snapshot(), playback: this.playback.snapshot(),
    };
  }
}

class StreamingMicrophone {
  constructor({ onSamples, onError = () => {}, env = globalThis, context = null }) { this.onSamples = onSamples; this.onError = onError; this.env = env; this.sharedContext = context; this.stopped = false; }
  async start() {
    const e = this.env;
    if (!e.navigator?.mediaDevices?.getUserMedia || !e.AudioContext || !e.AudioWorkletNode) throw new Error('无法使用麦克风');
    try {
      const stream = await e.navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (this.stopped) { stream.getTracks().forEach(track => track.stop()); return null; }
      this.echoCancellation = stream.getAudioTracks?.()[0]?.getSettings?.().echoCancellation === true;
      this.trackCleanups = [];
      for (const track of stream.getTracks()) {
        const ended = () => { if (!this.stopped) { this.onError(new Error('麦克风已断开')); void this.stop(); } };
        const muted = () => { if (!this.stopped) { this.onError(new Error('麦克风已静音')); void this.stop(); } };
        track.addEventListener?.('ended', ended); track.addEventListener?.('mute', muted);
        this.trackCleanups.push(() => { track.removeEventListener?.('ended', ended); track.removeEventListener?.('mute', muted); });
      }
      this.stream = stream; const context = this.context = this.sharedContext ?? new e.AudioContext();
      const source = "class YunshuStream extends AudioWorkletProcessor { process(inputs) { const samples=inputs[0]?.[0]; if(samples) this.port.postMessage(samples.slice()); return true; } } registerProcessor('yunshu-stream',YunshuStream);";
      const url = e.URL.createObjectURL(new e.Blob([source], { type: 'text/javascript' }));
      try { await context.audioWorklet.addModule(url); } finally { e.URL.revokeObjectURL(url); }
      if (this.stopped) { await this.stop(); return null; }
      this.input = context.createMediaStreamSource(stream); this.node = new e.AudioWorkletNode(context, 'yunshu-stream');
      this.node.port.onmessage = event => { if (!this.stopped) this.onSamples(new Float32Array(event.data), context.sampleRate); };
      this.node.onprocessorerror = () => { this.onError(new Error('麦克风处理失败')); void this.stop(); };
      this.mute = context.createGain(); this.mute.gain.value = 0;
      this.input.connect(this.node); this.node.connect(this.mute); this.mute.connect(context.destination);
      await context.resume(); return context.sampleRate;
    } catch (error) { await this.stop(); throw error; }
  }
  async stop() {
    this.stopped = true; for (const cleanup of this.trackCleanups ?? []) cleanup(); this.trackCleanups = [];
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = null;
    if (this.node) { this.node.port.onmessage = null; this.node.disconnect(); this.node = null; }
    this.input?.disconnect(); this.input = null; this.mute?.disconnect(); this.mute = null;
    const context = this.context; this.context = null;
    if (context && !this.sharedContext && context.state !== 'closed') await context.close();
  }
}
class PcmOutput {
  constructor({ env = globalThis, onActive = () => {} } = {}) { this.env = env; this.onActive = onActive; this.sources = new Set(); this.context = null; this.nextTime = 0; this.generation = 0; }
  async ready() {
    if (!this.env.AudioContext) throw new Error('无法使用扬声器');
    if (!this.context) { this.context = new this.env.AudioContext(); this.gain = this.context.createGain(); this.gain.connect(this.context.destination); }
    await this.context.resume();
  }
  setGain(gain, seconds = 0.03) {
    if (!this.context) return;
    this.gain.gain.cancelScheduledValues(this.context.currentTime);
    this.gain.gain.setTargetAtTime(Math.max(0, Math.min(1, gain)), this.context.currentTime, seconds);
  }
  play(bytes, sampleRate) {
    if (!this.context || this.context.state === 'closed') throw new Error('扬声器未就绪');
    if (!(bytes instanceof Uint8Array) || bytes.byteLength % 2 || sampleRate < 8000 || sampleRate > 48000) throw new Error('播放音频格式无效');
    if (!bytes.length) return;
    const context = this.context, start = Math.max(context.currentTime + 0.02, this.nextTime);
    if (start - context.currentTime > 45) throw new Error('播放队列已满');
    const audio = context.createBuffer(1, bytes.length / 2, sampleRate), channel = audio.getChannelData(0);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < channel.length; i++) channel[i] = view.getInt16(i * 2, true) / 32768;
    const source = context.createBufferSource(), generation = this.generation;
    source.buffer = audio; source.connect(this.gain); this.sources.add(source); this.onActive(true);
    source.onended = () => { source.disconnect(); this.sources.delete(source); if (generation === this.generation && !this.sources.size) this.onActive(false); };
    source.start(start); this.nextTime = start + audio.duration;
  }
  stop() {
    this.generation++; for (const source of this.sources) { source.onended = null; try { source.stop(); } catch {} source.disconnect(); }
    this.sources.clear(); this.nextTime = 0; this.setGain(1); this.onActive(false);
  }
  async close() { this.stop(); const context = this.context; this.context = null; if (context && context.state !== 'closed') await context.close(); }
}
function base64Pcm(value) {
  const binary = atob(value), bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Browser-compatible Silero v6 stateful inference. Model/runtime are injected;
// input is 16 kHz signed PCM, not a speaker identity or biometric embedding.
const SILERO_INPUT = Object.freeze({ sampleRate: 16000, frameSamples: 512, contextSamples: 64, stateShape: [2, 1, 128] });
class SileroVad {
  static async create({ ort, model, speechThreshold = 0.5, confirmFrames = 2, signal } = {}) {
    if (!ort?.Tensor || !ort?.InferenceSession || !(model instanceof Uint8Array)) throw new TypeError('人声检测资源无效');
    if (!Number.isFinite(speechThreshold) || speechThreshold <= 0 || speechThreshold >= 1 || !Number.isInteger(confirmFrames) || confirmFrames < 1 || confirmFrames > 10) throw new TypeError('人声检测参数无效');
    signal?.throwIfAborted();
    const session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    if (signal?.aborted) { await session.release(); signal.throwIfAborted(); }
    if (!['input', 'state', 'sr'].every(name => session.inputNames.includes(name)) || !['output', 'stateN'].every(name => session.outputNames.includes(name))) { await session.release(); throw new Error('人声检测模型接口不匹配'); }
    const detector = new SileroVad(ort, session, speechThreshold, confirmFrames);
    if (signal) { detector.abortHandler = () => { void detector.dispose().catch(() => {}); }; detector.signal = signal; signal.addEventListener('abort', detector.abortHandler, { once: true }); }
    return detector;
  }
  constructor(ort, session, threshold, confirmFrames) {
    this.ort = ort; this.session = session; this.threshold = threshold; this.confirmFrames = confirmFrames;
    this.queue = Promise.resolve(); this.queuedSamples = 0; this.epoch = 0; this.disposed = false;
    this._clear();
  }
  _clear() { this.state = new Float32Array(256); this.context = new Float32Array(64); this.pending = []; this.voicedRun = 0; }
  reset() { this.epoch++; this._clear(); }
  push(samples) {
    if (this.disposed) return Promise.resolve(null);
    if (!(samples instanceof Int16Array) || samples.length > 16000 || this.queuedSamples + samples.length > 16000 * 2) return Promise.reject(new Error('人声检测队列已满'));
    const epoch = this.epoch, copy = samples.slice(); this.queuedSamples += copy.length;
    const job = this.queue.then(async () => {
      if (this.disposed || epoch !== this.epoch) return null;
      for (const sample of copy) this.pending.push(sample / 32768);
      let result = null;
      while (this.pending.length >= 512 && !this.disposed && epoch === this.epoch) {
        const frame = Float32Array.from(this.pending.splice(0, 512));
        const input = new Float32Array(576); input.set(this.context); input.set(frame, 64);
        const tensors = { input: new this.ort.Tensor('float32', input, [1, 576]), state: new this.ort.Tensor('float32', this.state, [2, 1, 128]), sr: new this.ort.Tensor('int64', BigInt64Array.from([16000n]), []) };
        let output;
        try {
          output = await this.session.run(tensors);
          if (this.disposed || epoch !== this.epoch) return null;
          const score = Number(output.output?.data[0]);
          if (!Number.isFinite(score) || score < 0 || score > 1 || output.stateN?.data.length !== 256) throw new Error('人声检测结果无效');
          this.state = new Float32Array(output.stateN.data); this.context = frame.slice(-64);
          this.voicedRun = score >= this.threshold ? this.voicedRun + 1 : 0;
          result = { speech: this.voicedRun >= this.confirmFrames, score };
        } finally { for (const tensor of [...Object.values(tensors), ...Object.values(output ?? {})]) tensor.dispose?.(); }
      }
      return result;
    }).finally(() => { this.queuedSamples -= copy.length; });
    this.queue = job.catch(() => {}); return job;
  }
  dispose() {
    if (this.disposal) return this.disposal;
    this.disposed = true; this.reset(); this.signal?.removeEventListener('abort', this.abortHandler);
    this.disposal = this.queue.then(() => this.session.release()); return this.disposal;
  }
}

let yunshuVadResources = null;
const vadFileNames = ['silero_vad.onnx', 'ort.wasm.min.js', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'];
async function loadVadResources(request, { signal, env = globalThis } = {}) {
  signal?.throwIfAborted();
  if (!yunshuVadResources) {
    const entry = { urls: [], env, abort: new AbortController() }; yunshuVadResources = entry;
    const lifetime = signal ? AbortSignal.any([signal, entry.abort.signal]) : entry.abort.signal;
    entry.promise = (async () => {
      const manifest = await request('vad-manifest');
      if (manifest.schema !== 1 || manifest.runtimeVersion !== '1.27.0' || manifest.modelVersion !== '6.2.3' || manifest.chunkBytes !== 524288) throw new Error('人声检测资源版本不匹配');
      const read = async name => {
        const info = manifest.files?.[name];
        if (!info || !Number.isSafeInteger(info.bytes) || info.bytes <= 0 || info.bytes > 20000000 || !/^[a-f0-9]{64}$/.test(info.sha256)) throw new Error('人声检测资源格式无效');
        const bytes = new Uint8Array(info.bytes);
        for (let offset = 0; offset < bytes.length; offset += manifest.chunkBytes) {
          lifetime.throwIfAborted(); const packet = await request('vad-asset', { name, offset });
          if (packet.offset !== offset || packet.total !== bytes.length || packet.name !== name) throw new Error('人声检测资源片段不匹配');
          const size = Math.min(manifest.chunkBytes, bytes.length - offset);
          if (typeof packet.base64 !== 'string' || packet.base64.length > Math.ceil(size / 3) * 4) throw new Error('人声检测资源片段无效');
          const binary = env.atob(packet.base64);
          if (binary.length !== size) throw new Error('人声检测资源不完整');
          for (let i = 0; i < size; i++) bytes[offset + i] = binary.charCodeAt(i);
        }
        const digest = Array.from(new Uint8Array(await env.crypto.subtle.digest('SHA-256', bytes))).map(v => v.toString(16).padStart(2, '0')).join('');
        if (digest !== info.sha256) throw new Error('人声检测资源校验失败');
        return bytes;
      };
      const [model, script, module, wasm] = await Promise.all(vadFileNames.map(read));
      lifetime.throwIfAborted();
      const url = (bytes, type) => { const value = env.URL.createObjectURL(new env.Blob([bytes], { type })); entry.urls.push(value); return value; };
      const slot = '__yunshuVadRuntime_' + Math.random().toString(36).slice(2);
      const wrapped = '(()=>{' + new TextDecoder().decode(script) + '\n;globalThis[' + JSON.stringify(slot) + ']=ort;})();';
      const scriptUrl = url(wrapped, 'text/javascript'), moduleUrl = url(module, 'text/javascript');
      const element = env.document.createElement('script');
      try {
        await new Promise((resolve, reject) => {
          const finish = error => { clearTimeout(timer); lifetime.removeEventListener('abort', abort); element.onload = null; element.onerror = null; error ? reject(error) : resolve(); };
          const abort = () => finish(lifetime.reason ?? new Error('人声检测已取消'));
          const timer = setTimeout(() => finish(new Error('人声检测加载超时')), 15000);
          lifetime.addEventListener('abort', abort, { once: true });
          element.src = scriptUrl; element.onload = () => finish(); element.onerror = () => finish(new Error('人声检测运行时加载失败'));
          env.document.head.appendChild(element);
        });
        lifetime.throwIfAborted();
        const ort = env[slot];
        if (!ort?.InferenceSession) throw new Error('人声检测运行时不可用');
        ort.env.wasm.wasmPaths = { mjs: moduleUrl }; ort.env.wasm.wasmBinary = wasm;
        ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false; ort.env.logLevel = 'error';
        return { ort, model, manifest };
      } finally { element.remove(); delete env[slot]; }
    })().catch(error => { entry.abort.abort(); if (yunshuVadResources === entry) yunshuVadResources = null; for (const url of entry.urls.splice(0)) env.URL.revokeObjectURL(url); throw error; });
  }
  const result = await yunshuVadResources.promise; signal?.throwIfAborted(); return result;
}
function disposeVadResources() { const entry = yunshuVadResources; yunshuVadResources = null; if (!entry) return; entry.abort.abort(); for (const url of entry.urls.splice(0)) entry.env.URL.revokeObjectURL(url); }

let lastStandaloneGeneration=0;
class StandaloneTts {
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
function TtsPanel({sessionId,call,control,beforeStart,onConfigured,onServiceChange}) {
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

function* decodedPcmFrames(decoded) {
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

function VoiceView({ sessionId, call, locked, onActiveChange, target }) {
  const embedded = !!target?.closest('.ysd-embedded-voice');
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
  const localMic=React.useRef(null), talkback=React.useRef(null), talkEpoch=React.useRef(0);
  const localStatus=status?.catalog?.providers?.find(p=>p.id===status?.catalog?.selection?.providerId)??status?.catalog?.providers?.find(p=>p.location==='host-local');
  const localMode=!!status && status.asrMode!=='bailian';
  const prepared=localStatus?.preparation?.phase==='ready'||localStatus?.ready===true;
  const [preparing,setPreparing]=React.useState(false);
  function endSpeaker(){
    talkEpoch.current++;
    talkback.current?.stop();talkback.current=null;
    if(runtime.current)runtime.current.stopPlayback?.();
    preferences.current={...preferences.current,readReplies:false};setReadReplies(false);
  }
  async function beginSpeaker(){
    if(runtime.current && !localMode){preferences.current={...preferences.current,readReplies:true};setReadReplies(true);return;}
    if(talkback.current)return;
    const epoch=++talkEpoch.current;
    const signal=life.current.signal;
    const current=new StandaloneTts({remote:(action,payload,abort)=>call(sessionId,action,payload,abort),
      update:(value,notice)=>{if(signal.aborted || current!==talkback.current)return;
        if(notice)setError(notice);if(value==='连接中断'||value==='朗读失败'){endSpeaker();}}});
    talkback.current=current;
    try{await current.watch();if(epoch===talkEpoch.current&&!signal.aborted){preferences.current={...preferences.current,readReplies:true};setReadReplies(true);}}
    catch(e){if(epoch===talkEpoch.current&&!signal.aborted){endSpeaker();setError(e.message);}}
  }
  async function discardMic(){
    const r=localMic.current;localMic.current=null;
    if(r){r.abort.abort();clearTimeout(r.timer);await r.mic.stop().catch(()=>{});}
  }
  async function finishMic(){
    const r=localMic.current;if(!r||r.finishing)return;r.finishing=true;clearTimeout(r.timer);
    setPhase('transcribing');
    try{
      await r.mic.stop();r.abort.signal.throwIfAborted();
      if(!r.length||!r.rate)throw Error('没有收到录音，请检查麦克风。');
      const joined=new Float32Array(r.length);let at=0;
      for(const part of r.parts){joined.set(part,at);at+=part.length;}
      const data=await call(sessionId,'transcribe',{audioBase64:waveBase64(pcmWave(joined,r.rate))},r.abort.signal);
      r.abort.signal.throwIfAborted();const words=data.text?.trim();
      if(!words)throw Error('未辨认出文字，可以重新听写。');
      setDraft(words);
      if(r.conversation){
        r.abort.signal.throwIfAborted();
        await sendText(words,(a,v)=>call(sessionId,a,v,r.abort.signal),r.abort.signal,{fresh:true});
      }
      if(!r.abort.signal.aborted)setPhase('idle');
    }catch(e){if(!r.abort.signal.aborted){setError(e.message);setPhase('interrupted');}}
    finally{if(localMic.current===r)localMic.current=null;}
  }
  async function startMic(){
    if(!prepared){setError('请先在语音页准备本地识别模型。');return;}
    if(localMic.current || locked)return;
    const r={abort:new AbortController(),parts:[],length:0,rate:0,finishing:false,conversation:voiceMode==='conversation'};
    r.mic=new StreamingMicrophone({onSamples:(samples,rate)=>{
      if(localMic.current!==r||r.finishing)return;
      const n=Math.max(0,Math.min(samples.length,Math.floor(rate*59)-r.length));r.rate=rate;
      if(n){r.parts.push(samples.slice(0,n));r.length+=n;}
      if(n<samples.length)void finishMic();
    },onError:e=>{if(localMic.current===r){setError(e.message);void discardMic();setPhase('interrupted');}}});
    localMic.current=r;setError('');setPhase('requesting');
    try{await r.mic.start();if(localMic.current!==r)return;setPhase('listening');r.timer=setTimeout(()=>void finishMic(),58000);}
    catch(e){if(!r.abort.signal.aborted){setError(e.message);await discardMic();setPhase('interrupted');}}
  }
  React.useEffect(()=>{
    const check=()=>{const p=window.__yunshuControlUI.snapshot().preferences;if(p&&(!p.master||!p.voice))void stop();};
    return window.__yunshuControlUI.subscribe(check);
  },[sessionId]);
  async function prepareLocal(){
    const signal=life.current.signal;
    if(!localStatus?.id)return;
    try{
      setPreparing(true);setError('');
      await call(sessionId,'prepare',{providerId:localStatus.id},signal);
      for(;;){
        const next=await call(sessionId,'status',{},signal);signal.throwIfAborted();setStatus(next);
        const item=next.catalog?.providers?.find(p=>p.id===localStatus.id);
        if(item?.preparation?.phase==='ready')break;
        if(['error','failed','unprepared','cancelled'].includes(item?.preparation?.phase))throw Error('本地模型未准备成功，请检查网络后重试。');
        await new Promise(resolve=>setTimeout(resolve,800));signal.throwIfAborted();
      }
    }catch(e){if(!signal.aborted)setError(e.message);}finally{if(!signal.aborted)setPreparing(false);}
  }

  const stop = async ({ interrupted = false } = {}) => {
    endSpeaker();await discardMic();
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
    if (sessionId) call(sessionId, 'status', {}, abort.signal).then(value => { if (!abort.signal.aborted) { setStatus(value); setRegion(value.region ?? 'beijing');setSettingsOpen(false); } }).catch(e => { if (!abort.signal.aborted) setError(e.message); });
    return () => { abort.abort(); void stop(); };
  }, [sessionId]);
  React.useEffect(() => { onActiveChange?.(!['idle','interrupted'].includes(phase)); }, [phase]);
  React.useEffect(() => { if (locked) void stop(); }, [locked]);
  React.useEffect(() => { const close = () => { void stop(); }; window.addEventListener('pagehide', close); return () => window.removeEventListener('pagehide', close); }, []);
  React.useEffect(() => {
    const onQuickVoiceAction = event => {
      const action = event.detail?.action;
      if (!sessionId || event.detail?.sessionId!==sessionId || locked || !action) return;
      if (action === 'mic') {
        if (['idle', 'interrupted'].includes(phase)) void start({ recovering: phase === 'interrupted' });
        else if(localMic.current)void finishMic();else void stop();
      } else if (action === 'output') {
        if(preferences.current.readReplies||talkback.current)endSpeaker();else void beginSpeaker();
      }
    };
    window.addEventListener('yunshu:voice-action', onQuickVoiceAction);
    return () => window.removeEventListener('yunshu:voice-action', onQuickVoiceAction);
  }, [sessionId, locked, phase, status, voiceMode]);
  React.useEffect(() => {
    window.__yunshuLakeMicActive = !['idle','interrupted'].includes(phase);
    const snapshot = {sessionId,mic:window.__yunshuLakeMicActive,output:readReplies,phase};
    window.__yunshuVoiceState = snapshot;
    window.dispatchEvent(new CustomEvent('yunshu:voice-state',{detail:snapshot}));
    return () => {
      if(window.__yunshuVoiceState===snapshot) delete window.__yunshuVoiceState;
    };
  }, [sessionId, phase, readReplies]);
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
    if(localMode){await startMic();return;}
    const conversation=voiceMode==='conversation';setAutoSend(conversation);preferences.current={...preferences.current,autoSend:conversation};
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
  const entryState = !sessionId ? 'idle' : error || phase === 'interrupted' ? 'late' : active ? 'work' : status?.available ? 'ok' : 'idle';
  const entryLabel = phase === 'requesting' ? '语音：准备中' : phase === 'listening' ? '语音：聆听中' : entryState === 'late' ? '语音：异常' : '语音';
  return ReactDOM.createPortal(h('div', { className: 'ys-plugin', ref: anchor }, !embedded && button(
    h(React.Fragment, null,
      h('span', { className: 'ysu-chip-dot', 'data-s': entryState, 'aria-hidden': true }),
      h('svg', { viewBox: '0 0 24 24', width: 14, height: 14, 'aria-hidden': true },
        h('path', { d: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 }),
        h('path', { d: 'M6 11v1a6 6 0 0 0 12 0v-1M12 18v3m-4 0h8', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' })),
      h('span', null, '语音')),
    () => setOpen(!open), !sessionId, { className: 'ysu-chip', 'aria-label': entryLabel, 'aria-pressed': active, title: entryLabel }), (embedded || open) && h(embedded ? 'section' : Panel, embedded ? {className:'sr-voice', 'aria-label':'云舒语音',role:'region'} : { anchor, label: '云舒语音', onClose: () => setOpen(false) },
    h('div', { className: 'ys-row' }, h('h3', null, '云舒语音'), button('设置',()=>setSettingsOpen(value=>!value),active)),
    h('label',null,'麦克风模式　',h('select',{'aria-label':'麦克风模式',value:voiceMode,disabled:active,onChange:e=>setVoiceMode(e.target.value)},
      h('option',{value:'conversation'},'对话'),h('option',{value:'dictation'},'听写'))),
    localMode && !prepared && button(preparing?'正在准备模型…':'准备本地语音模型',()=>void prepareLocal(),preparing||!localStatus),
    h('small',{'aria-label':'语音状态'},phase==='listening'?'正在聆听':phase==='transcribing'?'正在本地识别':phase==='requesting'?'正在准备麦克风':phase==='interrupted'?'连接已中断，可重新开始':localMode?(prepared?'本地识别已就绪':'本地识别模型尚未就绪'):status?.available?'已就绪':'本地朗读可用；语音识别可在设置中连接'),
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

async function mountVoiceClient(ctx, info) {
  const disposeRemote = await ctx.remote.$mount(info);
  let ui;
  try {
    ui = ctx.inject(['remote.yunshuVoice', 'slots'], inner => {
      const container = document.createElement('div'), fallback = document.createElement('div');
      fallback.style.cssText = 'position:fixed;right:24px;bottom:24px;z-index:850;background:var(--dsw-alias-bg-base,Canvas);color:var(--dsw-alias-label-primary,CanvasText);border-radius:12px';
      document.body.append(container, fallback);
      const style = document.createElement('style'); style.textContent = styles; document.head.append(style);
      const root = ReactDOMClient.createRoot(container);
      let selected = {}, active = false, pinned = null, target = fallback, closed = false;
      const call = async (sessionId, action, payload = {}, signal) => {
        const result = await inner.remote.yunshuVoice.request(sessionId, action, payload, signal);
        if (!result.ok) { const error = new Error(result.error.message); error.code = result.error.code; throw error; }
        return result.value;
      };
      const render = () => {
        if (closed) return;
        fallback.hidden = true;
        root.render(React.createElement(VoiceView, { sessionId: active ? pinned : selected.sessionId, locked: selected.locked, call, target,
          onActiveChange: value => { if (active === value) return; if (value) pinned = selected.sessionId; active = value; render(); } }));
      };
      function Entry(props) {
        const element = React.useRef(null);
        React.useLayoutEffect(() => {
          const node = element.current; selected = { sessionId: props.sessionId, locked: props.locked }; target = node; render();
          return () => { if (target === node) { target = fallback; render(); } };
        }, [props.sessionId, props.locked]);
        return React.createElement('span', { ref: element });
      }
      const bindDockSession = event => {
        selected = event.detail || {}
        render()
      }
      selected = window.__yunshuLakeSession || {}
      window.addEventListener('yunshu:dock-session', bindDockSession)
      inner.effect(() => () => window.removeEventListener('yunshu:dock-session', bindDockSession))
      // 语音控件移入抽屉，原 Entry 继续管理录音、状态与 portal 目标。
      const voiceDockEntry = {
        group: 'panel', id: 'yunshuVoice', label: '语音',
        status: () => window.__yunshuHealth?.get('voice')?.state ?? 'unknown', describe: () => window.__yunshuHealth?.describe('voice') ?? '健康状态未接通',
        render: dockProps => React.createElement('div', { className: 'ysd-embedded-voice' },
          React.createElement(Entry, { sessionId: dockProps.sessionId })),
      };
      if (window.__yunshuDock?.register) window.__yunshuDock.register(voiceDockEntry);
      else (window.__yunshuDockQueue = window.__yunshuDockQueue || []).push(voiceDockEntry);
      render();
      inner.effect(() => () => { closed = true; root.unmount(); container.remove(); fallback.remove(); style.remove(); });
    });
    await ui;
  } catch (error) { await ui?.dispose(); await disposeRemote(); throw error; }
  return async () => { await ui.dispose(); await disposeRemote(); };
}

return {inject:["remote","slots"],apply:ctx=>{ctx.effect(()=>()=>disposeVadResources());return mountVoiceClient(ctx,remoteSpec("yunshuVoice",z,createTypertRemoteInfo))}};
}});
window.__ModuleLoader__.load({id:"@yunshu/dsh-desktop",factory:require=>({inject:["remote","slots"],apply:ctx=>{const health=window.__yunshuHealth;ctx.effect(()=>()=>health?.dispose?.());ctx.plugin(require("@yunshu/dsh-dock"));ctx.plugin(require("@yunshu/dsh-desktop/internal-memory"));ctx.plugin(require("@yunshu/dsh-desktop/internal-persona"));ctx.plugin(require("@yunshu/dsh-desktop/internal-voice"));ctx.plugin(require("@yunshu/dsh-desktop/file-receipts"));}})});
