import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const builtIn = fileURLToPath(new URL('../parts/', import.meta.url))

export function readPart(engineDir, id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) return null
  const configured = join(engineDir, 'parts')
  const file = join(existsSync(configured) ? configured : builtIn, id + '.json')
  if (!existsSync(file)) return null
  return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
}

export function objectiveKey(revision, part, objective) {
  const hash = createHash('sha256').update(objective, 'utf8').digest('hex')
  return revision + '|' + part + '|' + hash.slice(0, 12)
}

export function dispatchRestriction(st, part, objective) {
  const stop = (code, reason, message = reason) => ({code, reason, message})
  if (['done','blocked','disputed'].includes(st.status)) return stop('closed', '任务已结束或受阻。', `run 状态 ${st.status}，不复活（人工开新 run）`)
  if (st._watch?.verdict === 'STALE' && part.part_id !== 'guardian') return stop('stale', '任务长时间没有进展，需要先复核。', 'STALE：只允许 guardian 进场，其余停派')
  if (Object.values(st.pending || {}).some(p => p.status === 'outcome_unknown') && part.part_id !== 'guardian') return stop('outcome_unknown', '派单结果待核实。', '存在 outcome_unknown 未对账：只允许 guardian 进场')
  const active = st.active_parts || []
  if (active.includes(part.part_id)) return stop('pending', '已派单，等待交回。', part.part_id + ' 还有未回收派单，先收结果')
  if (active.length >= (st.budget?.active_max || 3)) return stop('capacity', '已有多项任务在途，请等待交回。', `同时激活 ${active.length}/${st.budget?.active_max || 3}`)
  const limit = st.budget?.turns_max ?? 6
  if ((st.watermark?.turn || 0) >= limit) return stop('budget', '已用完 ' + limit + ' 轮额度，请先核对后续安排。', `轮次已到上限 ${limit}（超预算直接拒，不降级）`)
  const hit = (part.forbidden_actions || []).find(x => objective.includes(x))
  if (hit) return stop('role-limit', '这一步超出了角色权限，请先修订步骤。', '目标出现该 part 禁区：' + hit)
  if ((st.seen_objectives || []).includes(objectiveKey(st.goal_rev, part.part_id, objective))) return stop('duplicate', '这条指令已经派发，请先核对之前的派单。', '同 goal_rev + part + objective 已派过（去重）')
  return null
}
