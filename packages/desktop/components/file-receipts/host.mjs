import { enabled, requireFeature, featureTool, onChange } from '../system/policy.mjs';
import { z } from 'zod';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { initial, fold, fullRead, sessionFile, deriveBasis, digest, writtenDigest, receiptKind, hasPendingMutation } from './projection.mjs';

const dictionary = z.record(z.string(), z.json());
const stateSchema = z.object({
  root: z.string().nullable(), cwd: z.string().nullable(), inherited: z.number().int(), turn: z.number().int().nullable(),
  active: dictionary, sources: z.array(dictionary), view: z.object({ turns: dictionary })
});
export const name = 'yunshu-file-receipts';
export const inject = ['sessionProjections', 'tools', 'fs'];

function factsText(basis, previous) {
  function detail(s) {
    return [s.domainId, s.subjectId, s.sourceId, s.revisionId, s.path,
      s.recordedAt && '记录时间 ' + s.recordedAt, s.effectiveAt && '生效时间 ' + s.effectiveAt].filter(Boolean).join(' · ');
  }
  return [basis && '本次文件引用并读回的原件：' + detail(basis),
    previous && '同一文件上次读回时所用的原件：' + detail(previous),
    '回执只核对文件写入和可见内容。新旧依据各自属于当时的记录，追认历史错误或推断现场原因需要另外的直接证据。'
  ].filter(Boolean).join('\n');
}
export async function apply(ctx) {
  const handle = await ctx.sessionProjections.register({ key: 'yunshuFileReceipts', stateVersion: 3, stateSchema,
    init: initial, apply: fold, wire: { summary: false, viewSchema: z.object({ turns: dictionary }), view: state => state.view } });
  // Opaque fs revision witnesses live only for this running session and turn.
  const observed = new WeakMap();
  const sessions = new WeakMap();
  function sessionWrites(session, turn) {
    const prior = sessions.get(session);
    if (prior?.turn === turn) return prior.files;
    const files = new Map(); sessions.set(session, { turn, files }); return files;
  }
  ctx.on('fs/observed', (target, info, exec) => {
    if(!enabled('tasks'))return;
    if (!exec?.agent?.session || exec.parent || !['read','edit','write','apply_patch'].includes(exec.name)) return;
    try {
      const state = handle.stateOf(exec.agent.session);
      if (state.turn == null) return;
      const file = sessionFile(state, ctx.fs.processPath(target));
      if (!file) return;
      const writes = sessionWrites(exec.agent.session, state.turn);
      if (exec.name !== 'read' || info.kind !== 'present') writes.delete(file.key);
      if (info.kind !== 'present' || typeof info.version !== 'string' || !info.version) return;
      const observations = observed.get(exec) ?? new Map();
      observations.set(file.key, { ...file, version: info.version });
      observed.set(exec, observations);
    } catch { /* An unavailable witness can never block the tool. */ }
  });
  ctx.on('tools/result', (exec, result) => {
    if(!enabled('tasks'))return;
    const observations = observed.get(exec);
    if (!observations || exec.name === 'read' || result.isError) return;
    try {
      const value = result.value;
      if (exec.name === 'apply_patch' && (value?.phase !== 'commit' || value.cancelled ||
          !value.operations?.length || value.operations.some(op => op.status !== 'completed'))) return;
      const state = handle.stateOf(exec.agent.session);
      const call = state.active.calls.find(c => c.id === exec.callId && c.name === exec.name);
      if (state.turn == null || !call) return;
      const writes = sessionWrites(exec.agent.session, state.turn);
      for (const file of observations.values()) {
        if (call.name === 'apply_patch' ? !call.targets.includes(file.key) : call.key !== file.key) continue;
        const change = exec.name === 'apply_patch' ? value.operations.flatMap(op => op.changes ?? [])
          .find(c => sessionFile(state, c.path)?.key === file.key) : value;
        if (sessionFile(state, change?.path)?.key !== file.key || typeof change?.after !== 'string') continue;
        // Compare both native version and complete normalized text at readback.
        writes.set(file.key, { version: file.version, call, hash: writtenDigest(change.after) });
      }
    } catch {}
  });
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next();
    if (!enabled('tasks') || exec.name !== 'read' || exec.parent || !exec.agent || result.isError || decision.kind !== 'accept' ||
        Object.hasOwn(decision, 'content') || Object.hasOwn(decision, 'value')) return decision;
    try {
      const state = handle.stateOf(exec.agent.session);
      const file = sessionFile(state, result.value?.path);
      const witness = file && observed.get(exec)?.get(file.key);
      const write = witness && sessionWrites(exec.agent.session, state.turn).get(file.key);
      const call = state.active.calls.find(c => c.id === exec.callId && c.name === 'read');
      if (!write || !call || call.key !== file.key || write.version !== witness.version ||
          write.call.step >= call.step || write.call.seq >= call.seq) return decision;
      const latest = state.active.writes.filter(w => w.key === file.key).at(-1);
      if (latest?.seq !== write.call.seq || latest.id !== write.call.id || hasPendingMutation(state.active.calls,file.key)) return decision;
      const text = fullRead(result.value, result.content);
      if (text === null || digest(text) !== write.hash) return decision;
      const { basis, previous } = deriveBasis(state, text, file, write.call.seq);
      const context = createUserMessage({ source: { kind: receiptKind, turn: state.turn, key: file.key,
        writeSeq: write.call.seq, writeCallId: write.call.id, readCallId: exec.callId, hash: write.hash },
        content: [{ type: 'text', text: '文件已写入并完整读回：' + file.relative + '\n' + factsText(basis, previous) }] });
      return { ...decision, additionalContexts: [...(decision.additionalContexts ?? []), context] };
    } catch { return decision; }
  });
}
