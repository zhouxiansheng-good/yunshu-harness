/** Shared canonical task addressing; neither directory scans nor state mutation. */
import { join } from 'node:path';

export function linkedTicketId(runId, messageId) {
  if (typeof runId !== 'string' || typeof messageId !== 'string'
    || !/^r-[a-zA-Z0-9-]+$/.test(runId) || !/^m-[a-zA-Z0-9-]+$/.test(messageId))
    throw new TypeError('invalid United run or message id');
  const id = runId + '_' + messageId;
  if (id.length > 80) throw new TypeError('linked ticket id is too long');
  return id;
}

export function unitedTaskFiles(dir, messageId, pending) {
  if (typeof pending?.part !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(pending.part))
    throw new Error('United task part is invalid');
  return ['in', 'claimed'].map(folder => join(dir, folder, pending.part + '-' + messageId + '.json'));
}

export function assertUnitedTask(runId, messageId, state, pending, envelope) {
  if (state.run_id !== runId || envelope.id !== messageId || envelope.run_id !== runId
    || envelope.kind !== 'task' || envelope.to !== pending.part
    || envelope.goal_id !== state.goal_id || envelope.goal_rev !== state.goal_rev)
    throw new Error('United task envelope differs from its ledger');
}
