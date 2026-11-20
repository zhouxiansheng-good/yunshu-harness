/** Bind a coding ticket to one existing manual United task, without a second task ledger. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { artifactAttempt, spentTokens, diagnosisHold, cumulativeArtifact } from './attempts.mjs';
import { writerHold, writerBinding } from './writer-authority.mjs';
import { marked as handoffMarked, kind as handoffKind } from './handoff-release.mjs';
import { linkedTicketId, unitedTaskFiles, assertUnitedTask } from './united-task.mjs';
export { linkedTicketId } from './united-task.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const read = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const inside = (root, path) => {
  const part = relative(root, path);
  return part === '' || (part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part));
};

export class UnitedCodingBridge {
  constructor({ root, cli, auditSource, auditWriter, auditHandoff } = {}) {
    if (!root || !isAbsolute(root)) throw new TypeError('united root must be absolute');
    this.root = realpathSync(root);
    this.runs = realpathSync(join(this.root, 'runs'));
    this.cli = realpathSync(cli ?? join(this.root, 'bin', 'united.mjs'));
    this.auditSource = auditSource;
    this.auditHandoff = auditHandoff;
    this.auditWriter = auditWriter;
    if (!statSync(this.runs).isDirectory() || !statSync(this.cli).isFile())
      throw new TypeError('United runs or CLI is unavailable');
  }

  task(runId, messageId) {
    linkedTicketId(runId, messageId);
    const dir = realpathSync(join(this.runs, runId));
    if (!inside(this.runs, dir)) throw new Error('United run escapes configured root');
    const state = read(join(dir, 'state.json'));
    const pending = state.pending?.[messageId];
    if (!pending) throw new Error('United message is not in the task ledger');
    const files = unitedTaskFiles(dir, messageId, pending);
    const taskFile = files.find(existsSync);
    if (!taskFile) throw new Error('United task envelope is missing');
    const envelope = read(taskFile);
    assertUnitedTask(runId, messageId, state, pending, envelope);
    return { runId, messageId, dir, state, pending, envelope };
  }

  link({ runId, messageId, ticketId, goal, acceptance }) {
    if (ticketId !== linkedTicketId(runId, messageId))
      throw new Error('ticket id must derive from the United task ids');
    const { state, pending, envelope } = this.task(runId, messageId);
    if (!['open', 'running'].includes(state.status)) throw new Error('United run is not active');
    if (pending.deadline_at && Date.now() > Date.parse(pending.deadline_at))
      throw new Error('United task deadline passed; reconcile before dispatch');
    if (pending.status !== 'pending' || pending.part !== 'builder'
      || envelope.execution_mode !== 'manual')
      throw new Error('United task must be a pending manual builder assignment');
    if (envelope.task?.objective !== goal || envelope.task?.acceptance !== acceptance)
      throw new Error('coding contract differs from the frozen United task');
    return { runId, messageId, goalId: envelope.goal_id, goalRev: envelope.goal_rev,
      part: pending.part, phase: envelope.phase };
  }

  submit(record) {
    const writerHeld = writerHold(record);
    if (writerHeld) return { submitted: false, reason: writerHeld };
    if (record.writerPolicy === 1 && (this.auditWriter?.(record) !== true
      || JSON.stringify(record.promotion?.writer) !== JSON.stringify(writerBinding(record))))
      return { submitted: false, reason: 'writer-evidence-or-promotion-binding-required' };
    const held = diagnosisHold(record);
    if (held) return { submitted: false, reason: held };
    const link = record.united;
    if (!link) return { submitted: false, reason: 'ticket-not-linked' };
    if (record.status !== 'promoted' || record.promotion?.status !== 'promoted'
      || record.verification?.status !== 'target-files-and-test-passed'
      || record.scopeAudit !== 'passed')
      return { submitted: false, reason: 'verified-promotion-required' };
    const { runId, messageId } = link;
    if (record.ticketId !== linkedTicketId(runId, messageId))
      throw new Error('ticket id no longer matches United task');
    const { dir, state, pending, envelope } = this.task(runId, messageId);
    let qualified;
    if(handoffMarked(record)){try{qualified=this.auditHandoff?.(record);if(!qualified)throw Error('handoff-host-required');}catch(e){return {submitted:false,reason:e.message};}}
    if (!['open', 'running'].includes(state.status) && !(qualified && state.status==='done' && pending.status==='settled'))
      return { submitted: false, reason: 'United run is not active', status: state.status };
    if (envelope.goal_id !== link.goalId || envelope.goal_rev !== link.goalRev
      || envelope.to !== link.part || envelope.phase !== link.phase
      || envelope.execution_mode !== 'manual')
      throw new Error('linked United task changed');
    const receiptId = 'm-' + sha('coding:' + record.ticketId).slice(0, 10);
    if (!['pending', 'settled'].includes(pending.status))
      return { submitted: false, reason: 'United task no longer pending', status: pending.status };
    if (pending.status === 'pending' && pending.deadline_at && Date.now() > Date.parse(pending.deadline_at))
      return { submitted: false, reason: 'United task deadline passed; reconcile first' };
    const artifact = artifactAttempt(record);
    if (!artifact || (record.promotion.attemptId != null && record.promotion.attemptId !== artifact.attemptId))
      return { submitted: false, reason: 'verified-artifact-reference-required' };
    // Only an untouched, single-implementation legacy promotion may retain the
    // pre-cumulative receipt path. Typed/multi-attempt records require a fresh binding.
    if (record.artifactPolicy !== 1 && (record.runs.length !== 1 || Object.hasOwn(record.runs[0], 'kind')))
      return { submitted: false, reason: 'cumulative-verification-required' };
    const changed = record.promotion.files, binding = record.verification.artifact ?? cumulativeArtifact(record);
    if (Object.hasOwn(record, 'artifactPolicy') && (record.artifactPolicy !== 1
      || record.promotion.attemptId !== artifact.attemptId || record.promotion.checkId !== record.verification.checkId
      || JSON.stringify(record.promotion.artifact) !== JSON.stringify(binding)))
      return { submitted: false, reason: 'promotion-artifact-binding-invalid' };
    if (!Array.isArray(changed) || new Set(changed).size !== changed.length
      || changed.some(file => !record.files.includes(file))
      || (binding && JSON.stringify(changed) !== JSON.stringify(binding.files)))
      return { submitted: false, reason: 'promotion-file-binding-invalid' };
    if (!changed.length) return { submitted: false, reason: 'no-promoted-files' };
    const cwd = realpathSync(record.cwd);
    // The independent check saw every target, including unchanged files.
    const targetEvidence = record.files.map(file => {
      const path = resolve(cwd, file);
      if (!inside(cwd, path) || !existsSync(path) || !inside(cwd, realpathSync(path))
        || !statSync(path).isFile()) throw new Error('promoted file missing or escaped: ' + file);
      const actual = sha(readFileSync(path));
      if (actual !== artifact.after?.[file])
        throw new Error('promoted file changed after verification: ' + file);
      return { uri: 'artifact://' + path, sha256: actual };
    });
    const evidence = changed.map(file => targetEvidence[record.files.indexOf(file)]);
    if (record.artifactPolicy === 1 && this.auditSource?.(record) !== true)
      return { submitted: false, reason: 'source-workspace-changed-or-complete-audit-unavailable' };
    if(qualified){const ticket=join(dirname(dirname(record.stage.path)),'tickets',record.ticketId+'.json');evidence.push({uri:'artifact://'+ticket,sha256:sha(readFileSync(ticket))});}
    const tokens = spentTokens(record);
    const statement = '编码文件已独立验证并提升：' + changed.join(', ') + '；执行者 ' + record.provider
      + '；token ' + (tokens ?? '未知') + '；结算费用待核对';
    const reply = { v: 1, id: receiptId, parent_id: messageId, run_id: runId,
      goal_id: link.goalId, goal_rev: link.goalRev, from: link.part, to: 'self',
      kind: 'finding', phase: link.phase, at: record.promotion.promotedAt,
      coding_ticket_id: record.ticketId, statement,
      ...(qualified?{handoff_delivery:{kind:handoffKind,parent:qualified.key.parent,receiptSha256:qualified.receiptSha256}}:{}),
      claim: { statement, evidence }, evidence };
    return publishCodingFinding(this,{dir,pending,reply,changed,tokens});
  }
}
// Both qualified producers use the same deterministic outbox and authoritative recv.
export function publishCodingFinding(bridge,{dir,pending,reply,changed,tokens}) {
    const {run_id:runId,parent_id:messageId,id:receiptId}=reply;
    const outbox=join(dir,'out',receiptId+'.json');
    if (pending.status === 'settled') {
      if (existsSync(outbox) && JSON.stringify(read(outbox)) === JSON.stringify(reply))
        return { submitted: true, alreadySubmitted: true, runId, messageId, receiptId };
      return { submitted: false, reason: 'United settled receipt differs from verified artifact', runId, messageId };
    }
    const replyFile = join(dir, 'artifacts', 'coding-' + messageId + '.json');
    if (existsSync(replyFile)) {
      if (JSON.stringify(read(replyFile)) !== JSON.stringify(reply))
        throw new Error('existing coding receipt differs; reconcile before retry');
    } else {
      mkdirSync(dirname(replyFile), { recursive: true });
      const temp = join(dirname(replyFile), '.' + basename(replyFile) + '.' + process.pid + '.new');
      writeFileSync(temp, JSON.stringify(reply, null, 2) + '\n', 'utf8');
      renameSync(temp, replyFile);
    }
    // The United CLI alone commits its authoritative event and settles the parent assignment.
    const result = spawnSync(process.execPath, [bridge.cli, 'recv', '--run', runId,
      '--file', replyFile, '--manual'], { encoding: 'utf8', timeout: 15000, windowsHide: true,
      env: { ...process.env, UNITED_RUNS_DIR: bridge.runs,
        UNITED_LEDGER: join(bridge.root, 'ledger.ndjson'),
        UNITED_LEDGER_V2: join(bridge.root, 'ledger-v2.ndjson') } });
    if (result.status !== 0) {
      const after = bridge.task(runId, messageId).pending;
      if (after.status === 'settled' && existsSync(outbox)
        && JSON.stringify(read(outbox)) === JSON.stringify(reply))
        return { submitted: true, alreadySubmitted: true, runId, messageId, receiptId };
      return { submitted: false, reason: 'United recv failed', exitCode: result.status,
        detail: (result.stderr || result.stdout || result.error?.message || '').slice(-700) };
    }
    if (bridge.task(runId, messageId).pending.status !== 'settled' || !existsSync(outbox) || JSON.stringify(read(outbox))!==JSON.stringify(reply))
      throw new Error('United recv returned success without a settled receipt');
    return { submitted: true, alreadySubmitted: false, runId, messageId, receiptId,
      files: changed, tokenUsage: tokens, cost: 'unknown; verify with relay statement' };
}
