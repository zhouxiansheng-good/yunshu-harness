import { enabled, requireFeature, featureTool, onChange } from '../system/policy.mjs';
import { registerCwdCompatibility } from './prompt-cwd.mjs';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { z } from 'zod';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { remoteSpec } from './shared/remote-spec.mjs';
import { requireOwner, registerRemote, dataError } from './shared/host.mjs';
import { IdentityStore, renderIdentity, PERSONAL_RULES_SECTION, legacyIdentityBudgetText, validateIdentityContent, IDENTITY_LIMITS } from './identity.mjs';
import { StandardsStore } from './standards.mjs';
import { composeContext } from './composer.mjs';
import { AffectStore, affectScope } from './affect.mjs';
import { estimateContextTokens, compareId } from './shared/context-contract.mjs';
const ownSources = new Set(['yunshu-memory', 'yunshu-persona']);
const missing = id => ({ id, state: 'not_installed', configured: false, evidence: 'service-absent', checkedAt: new Date().toISOString() });
const messageText = message => message?.role === 'user' && message.source?.kind === 'user'
  ? (message.content ?? []).filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n').slice(0, 4000) : '';
export const remoteInfo = remoteSpec('yunshuPersona', z, createTypertRemoteInfo);
export default class YunshuPersona extends TypertRemoteService {
  static inject = ['typert', 'tools', 'agents', 'systemPrompt'];
  get controlsContext() { return enabled('persona') && !this.closed; }
  constructor(ctx, config = {}) {
    super(ctx, 'yunshuPersona');
    this.ownerContext = ctx;
    this.closed = false; this.last = new WeakMap(); this.latestMessage = new WeakMap();
    this.dynamicSection = config.dynamicSection !== false && typeof ctx.systemPrompt?.section === 'function';
    const maxTokens = config.maxContextTokens ?? 10000, maxChars = config.maxContextChars ?? 30000;
    this.budget = { maxTokens, maxChars, maxReferenceTokens: config.maxReferenceTokens ?? Math.min(2200, maxTokens), maxReferenceChars: config.maxReferenceChars ?? Math.min(6500, maxChars) };
    this.identity = new IdentityStore(config.database ?? dshHomePath('plugins', 'yunshu-persona', 'identity.sqlite'));
    this.standards = new StandardsStore(this.identity.db);
    this.lifetime = new AbortController();
    ctx.effect(() => () => { this.closed = true; this.lifetime.abort(); this.referenceSection?.(); this.identitySection?.(); this.identity.close(); });
    this.affectError = null;
    try { this.affect = new AffectStore(this.identity.db); } catch { this.affectError = '情感状态暂不可用'; }
    this.checkIdentity(this.identity.read().content);
    this.refreshIdentity();
    registerCwdCompatibility(ctx);
    registerRemote(ctx, remoteInfo);
    if (this.dynamicSection) {
      // The host assembles the system prompt before pre-step. Replace this
      // section at assembly time so old reference snapshots never accumulate.
      this.referenceSection = ctx.systemPrompt.section({ name: 'yunshu-reference', order: 960, interpolate: false, text: '' });
      ctx.on('agent/inbox/claimed', ({ agent, message }) => { if (enabled('persona') && agent && messageText(message).trim()) this.latestMessage.set(agent, message); });
      ctx.on('system-prompt/assemble', async (_base, context, next) => {
        const assembly = await next();
        const agent = context.agent;
        if (!enabled('persona') || !agent || this.closed) return assembly;
        const latest = this.latestMessage.get(agent) ?? this.sessionMessage(agent);
        const text = await this.composeFor(agent, messageText(latest), context.signal, latest);
        context.signal?.throwIfAborted();
        if (this.closed) return assembly;
        const entry = assembly.sections.find(item => item.name === 'yunshu-reference');
        if (entry) { entry.text = text; entry.interpolate = false; }
        return assembly;
      }, { prepend: true });
    }
    const output = { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] };
    featureTool(ctx,defineTool({
      name: 'yunshu_capabilities', description: 'Inspect registered host tools and Yunshu component health. Configured/registered does not prove end-to-end operation. Use an exact tool name to inspect its arguments. Read-only; no probes or network calls.',
      parameters: { query: { type: 'string', required: true } }, output,
      execute: async ({ query }, exec) => { exec.signal.throwIfAborted(); return this.capabilities(exec.agent, query); },
    }));
    featureTool(ctx,defineTool({
      name: 'yunshu_memory_source', description: 'Read paginated original public memory evidence. Empty source_id lists this session sources. JSON excerpts may be incomplete; follow nextOffset. Attachment references are not verified media copies.',
      parameters: { source_id: { type: 'string', required: true }, offset: { type: 'number' }, before_cursor: { type: 'number' } }, output,
      execute: async ({ source_id, offset = 0, before_cursor }, exec) => {
        exec.signal.throwIfAborted(); const memory = this.memory(), scope = memory.scopeFor(exec.agent);
        if (!source_id) { const sources=memory.store.evidence.sources(scope,{sessionId:exec.agent.session.header.id,beforeCursor:before_cursor}); return {sources,pageLimit:50,nextCursor:sources.length===50?sources.at(-1).cursor:null}; }
        if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('原件读取位置无效');
        const source = memory.sourceAcrossScopes?.(source_id) ?? memory.store.evidence.source(scope, source_id); if (!source) return { found: false };
        const serialized = JSON.stringify(source.payload);
        if (offset > serialized.length) throw new Error('读取位置超过原件长度');
        return { found: true, source_id, role: source.role, contentHash: source.content_hash, format: 'json-fragment', totalChars: serialized.length, offset, nextOffset: offset + 6000 < serialized.length ? offset + 6000 : null, complete: offset === 0 && serialized.length <= 6000, text: serialized.slice(offset, offset + 6000) };
      },
    }));
    featureTool(ctx,defineTool({
      name: 'yunshu_observation_propose', description: 'Propose a sourced observation for owner review. Never confirms a fact or changes identity/preferences. Source_id and exact evidence quote are required. An image alone does not establish taste.',
      parameters: Object.fromEntries(['subject', 'predicate', 'value', 'modality', 'source_id', 'quote'].map(key => [key, { type: 'string', required: true }])), output,
      execute: async (args, exec) => {
        exec.signal.throwIfAborted(); const memory = this.memory(), scope = memory.scopeFor(exec.agent), source = memory.sourceAcrossScopes?.(args.source_id) ?? memory.store.evidence.source(scope, args.source_id);
        return memory.store.evidence.add(scope, { ...args, source_mode: source?.role === 'user' ? 'user_report' : 'model_inference' }, { confirmed: false });
      },
    }));
    featureTool(ctx,defineTool({
      name: 'yunshu_media_observe', description: 'Save a sourced model observation after the host actually interpreted an image or audio attachment in this conversation. Never infer taste, smell or other unseen properties. This is a model inference, not a user fact. An omitted source_id selects the latest user media in this session.',
      parameters: { description: { type: 'string', required: true }, source_id: { type: 'string' }, part_index: { type: 'number' } }, output,
      execute: async ({ description, source_id, part_index }, exec) => {
        exec.signal.throwIfAborted();
        if (typeof description !== 'string' || !description.trim() || description.length > 1200) throw new Error('附件内容描述无效');
        const memory = this.memory(), scope = memory.scopeFor(exec.agent), sessionId = exec.agent.session.header.id;
        const recent = memory.store.evidence.sources(scope, { sessionId, limit: 50 });
        const source = source_id ? memory.store.evidence.source(scope, source_id) : recent.map(row => memory.store.evidence.source(scope, row.id)).find(row => row?.role === 'user' && row.payload.parts.some(part => ['image', 'audio'].includes(part.type)));
        if (!source || source.role !== 'user' || source.session_id !== sessionId) throw new Error('当前会话没有对应的用户附件来源');
        const index = part_index ?? source.payload.parts.findIndex(part => ['image', 'audio'].includes(part.type));
        if (!Number.isSafeInteger(index) || index < 0 || index >= source.payload.parts.length) throw new Error('附件编号无效');
        const part = source.payload.parts[index];
        if (!['image', 'audio'].includes(part.type)) throw new Error('只接收实际处理过的图片或音频');
        const value = description.trim();
        const observation = memory.store.evidence.add(scope, { subject: (part.type === 'image' ? '图片' : '音频') + '附件 ' + (index + 1), predicate: '内容', value, modality: part.type, source_mode: 'model_inference', source_id: source.id, quote: value, kind: 'observation' }, { confirmed: true });
        return { id: observation.id, source_id: source.id, part_index: index, modality: part.type, source_mode: 'model_inference', state: observation.state };
      },
    }));
    featureTool(ctx,defineTool({
      name: 'yunshu_context_status', description: 'Read context composition budget, omissions and hashes for this agent. Estimated tokens are not billed tokens; cache usage is unknown unless actually observed.', parameters: {}, output,
      execute: async (_args, exec) => { exec.signal.throwIfAborted(); return this.last.get(exec.agent) ?? { status: 'not_composed' }; },
    }));
    ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      const decision = await next();
      if (decision.kind === 'reject' || signal.aborted || this.closed) return decision;
      if (!enabled('persona') || this.dynamicSection) return decision;
      const clean = decision.messages.filter(m => !ownSources.has(m.source?.kind));
      const latest = clean.findLast(m => m.role === 'user' && m.source?.kind === 'user');
      let text;
      try { text = await this.composeFor(agent, messageText(latest), signal, latest); }
      catch (error) { if (signal.aborted || this.closed) return { ...decision, messages: clean }; throw error; }
      if (signal.aborted || this.closed || !text) return { ...decision, messages: clean };
      return { ...decision, messages: [...clean, createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'yunshu-persona', form: 'snapshot', sections: [{ name: 'yunshu-reference', text }] } })] };
    }, { prepend: true });
  }
  sessionMessage(agent) {
    const events = agent?.session?.snapshotEvents?.() ?? agent?.session?.events ?? [];
    if (!Array.isArray(events)) return null;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]?.type !== 'user/message') continue;
      const message = events[i].data?.message ?? events[i].data;
      if (messageText(message).trim()) return message;
    }
    return null;
  }
  async composeFor(agent, query, signal, latest) {
    const affectGeneration = this.affect && agent?.session?.header?.id ? this.affect.generationFor(affectScope(agent)) : null;
    const states = this.componentHealth(), memory = enabled('memory') && this.ctx.get('yunshuMemory');
    let candidates = [];
    try { if (memory?.contextCandidates) candidates = await memory.contextCandidates(agent, query, signal); }
    catch (error) {
      signal?.throwIfAborted();
      const state = states.find(item => item.id === 'memory');
      if (state) Object.assign(state, { state: 'failed', evidence: 'retrieval-failed' });
    }
    signal?.throwIfAborted();
    if (this.closed) return '';
    try {
      if (this.affect) {
        const scope = affectScope(agent); this.affect.update(scope, latest, affectGeneration);
        const candidate = affectGeneration === this.affect.generationFor(scope) ? this.affect.candidate(scope) : null;
        if (candidate) candidates.push(candidate);
        this.affectError = null;
      }
    } catch { this.affectError = '情感状态暂不可用'; }
    const relevantStates = states.filter(item => item.id === 'memory' && item.state !== 'ready' || item.id === 'voice' && /语音|声音|听|朗读|麦克风|说话|voice|audio/i.test(query));
    try {
      const packet = composeContext({ identityText: renderIdentity(this.identity.read(), this.standards.list()), candidates, capabilities: relevantStates, ...this.budget });
      this.last.set(agent, { status: 'composed', mode: this.dynamicSection ? 'host-section' : 'pre-step-fallback', ...packet.diagnostics, componentHealth: states });
      return packet.text;
    } catch {
      this.last.set(agent, { status: 'degraded', reason: 'composition-failed', componentHealth: states });
      return '';
    }
  }
  memory() { const service = this.ctx.get('yunshuMemory'); if (!service?.store?.evidence || !service.scopeFor) throw new Error('请启用兼容版本的云舒记忆插件'); return service; }
  checkIdentity(content, standards = this.standards.list()) {
    const clean = validateIdentityContent(content);
    const rendered = renderIdentity({ content: clean }, standards);
    const standardText = standards.map(row => row.text).join('\n');
    if (estimateContextTokens(legacyIdentityBudgetText(clean) + standardText) > Math.min(IDENTITY_LIMITS.contextTokens, Math.floor(this.budget.maxTokens * 0.6))) throw new Error('个人规则过长，超过上下文预算，请缩短协作约定或个人标准');
    composeContext({ identityText: rendered, ...this.budget });
  }
  refreshIdentity() {
    this.identitySection?.();
    // Remote requests carry their own invocation context. Registration must
    // belong to the plugin owner, otherwise an edit can leak past unload.
    this.identitySection = this.ownerContext.systemPrompt.section({ name: PERSONAL_RULES_SECTION, order: 950, interpolate: false, text: renderIdentity(this.identity.read(), this.standards.list()) });
  }
  affectStatus(agent) {
    try {
      if (!this.affect || this.affectError) return { available: false, error: this.affectError ?? '情感状态暂不可用' };
      const state = this.affect.read(affectScope(agent));
      return { available: true, ...state, memoryMatches: state.enabled && state.strength ? (this.last.get(agent)?.selected ?? []).filter(s => s.layer !== 'affect').length : 0 };
    } catch { return { available: false, error: '情感状态暂不可用' }; }
  }
  componentHealth() {
    return [['memory', 'yunshuMemory'], ['voice', 'yunshuVoice']].map(([id, key]) => {
      const service = this.ctx.get(key);
      if (!service) return missing(id);
      if (!service.health) return { id, state: 'unknown', configured: null, evidence: 'health-interface-missing', checkedAt: new Date().toISOString() };
      try { return service.health(); } catch { return { id, state: 'failed', configured: null, evidence: 'health-check-failed', checkedAt: new Date().toISOString() }; }
    });
  }
  capabilities(agent, query = '') {
    if (typeof query !== 'string' || query.length > 300) throw new Error('能力查询无效');
    const schemas = this.ctx.tools.schemas(agent).sort((a, b) => compareId(a.name, b.name));
    const key = query.toLowerCase(), matches = schemas.filter(s => !s.name.startsWith('yunshu_') || this.ctx.get('yunshuControl')?.toolEnabled(s.name)!==false).filter(s => !key || s.name.toLowerCase().includes(key) || s.description?.toLowerCase().includes(key));
    return { extensions:(this.ctx.get('yunshuControl')?.catalog()??[]).filter(x=>x.active), components:this.componentHealth().map(c=>enabled(c.id)?c:{id:c.id,state:'disabled'}), tools: matches.slice(0, 50).map(s => ({ name: s.name, description: s.description, ...(s.name === query ? { parameters: s.parameters } : {}), state: 'registered-not-probed' })), total: matches.length, truncated: matches.length > 50, coverage: 'tools-visible-to-this-agent-and-yunshu-components', networkProbed: false };
  }
  async request(agent, action, payload, signal) {
    requireOwner(this.ctx, signal);
    try {
      requireFeature('persona');
      const p = z.record(z.string(), z.json()).parse(payload);
      if (action === 'status') { const identity = this.identity.read(); return { identity, standards: this.standards.list(), rules: { registered: !!this.identitySection && !this.closed, automatic: true, section: PERSONAL_RULES_SECTION, version: identity.version, limits: { ...IDENTITY_LIMITS, contextTokens: Math.min(IDENTITY_LIMITS.contextTokens, Math.floor(this.budget.maxTokens * 0.6)) } }, components: this.componentHealth(), context: this.last.get(agent) ?? { status: 'not_composed' }, budget: this.budget, affect: this.affectStatus(agent) }; }
      if (action === 'affect-enable') { if (!this.affect) throw new Error('情感状态暂不可用'); this.affect.setEnabled(p.enabled); return this.affectStatus(agent); }
      if (action === 'affect-reset') { if (!this.affect) throw new Error('情感状态暂不可用'); this.affect.reset(affectScope(agent)); return this.affectStatus(agent); }
      if (action === 'capabilities') return this.capabilities(agent, p.query ?? '');
      if (action === 'identity-history') return this.identity.history();
      if (action === 'standards-history') return this.standards.history(p.familyId);
      if (action === 'standards-create') { const saved = this.standards.create(p.standard, p.confirmed, next => this.checkIdentity(this.identity.read().content, next)); this.refreshIdentity(); return saved; }
      if (action === 'standards-revise') { const saved = this.standards.revise(p.id, p.version, p.standard, p.confirmed, next => this.checkIdentity(this.identity.read().content, next)); this.refreshIdentity(); return saved; }
      if (action === 'standards-withdraw') { const saved = this.standards.withdraw(p.id, p.version, p.reason, p.confirmed); this.refreshIdentity(); return saved; }
      if (action === 'identity-save') { this.checkIdentity(p.content); const saved = this.identity.save(p.content, p.version, p.confirmed); this.refreshIdentity(); return saved; }
      if (action === 'identity-restore') {
        const old = this.identity.history().find(r => r.version === p.targetVersion); if (!old) throw new Error('身份历史不存在');
        this.checkIdentity(old.content); const saved = this.identity.restore(p.targetVersion, p.version, p.confirmed); this.refreshIdentity(); return saved;
      }
      throw new Error('未知人格操作');
    } catch (error) { throw dataError(error); }
  }
}
