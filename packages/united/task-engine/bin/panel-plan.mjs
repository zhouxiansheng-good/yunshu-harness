import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

// Display and dispatch both follow the ordered revisions of the original ticket.
export function readPanelPlan(runDirectory, frames) {
  const path = join(runDirectory, 'revisions.ndjson')
  const plan = { goal: null, steps: new Map() }
  const rows = existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line)) : []
  if (frames?.some(f => f.op === 'new')) {
    const expected = frames.filter(f => f.op === 'revise').map(f => f.payload)
    if (expected.length !== rows.length || expected.some((frame, i) =>
      ['rev','action_id','problem','change','evidence','panelEdit'].some(k => !isDeepStrictEqual(frame[k], rows[i][k])))) {
      throw new Error('原任务的修订记录尚待核对。')
    }
  }
  for (const revision of rows) {
    if (!revision.action_id || !revision.evidence?.includes('task-action:' + revision.action_id)) continue
    const edit = revision.panelEdit
    if (edit?.type === 'goal') plan.goal = edit.value
    else if (edit?.type === 'step') plan.steps.set(edit.stepId, edit.value)
    // Tickets written by R33 have a human-readable change and no structured edit.
    else if (revision.problem?.startsWith('用户从任务台修改了任务目标：') && revision.change?.startsWith('保留原始目标证据，并将后续方案调整为：')) {
      plan.goal = revision.change.slice('保留原始目标证据，并将后续方案调整为：'.length)
    } else if (revision.problem?.startsWith('用户从任务台修改步骤 ') && revision.change?.startsWith('后续执行步骤改为：')) {
      plan.steps.set(revision.problem.slice('用户从任务台修改步骤 '.length), revision.change.slice('后续执行步骤改为：'.length))
    }
  }
  return plan
}
