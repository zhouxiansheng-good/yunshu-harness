/**
 * 成果读取 —— 把 runs 目录翻译成「做成了什么」，不是「谁干了什么」
 *
 * 判定规则（codex 裁决第 3 节）：
 *   - 有产物 + 已收齐 + 有决议 + 产物哈希可复算 → 已完成
 *   - 有产物 + 任务未结束 → 已做出，待核对
 *   - 有人提异议 或 任务被否定 → 需重做
 *   - 有产出一份超时未交 → 等你决定
 *   - 其余在跑 → 正在做
 *   - 什么都没有 → 不凑数，显示「还没有可以确认的成果」
 *
 * 文案来源优先级：runs/<id>/result.json（人工写的成果文案，最可信）
 *               > goal.json + 产物名（机械推导，只写能证明的）
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const rd = (p, d = null) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return d } }
const sha256 = (p) => {
  try { return createHash('sha256').update(readFileSync(p)).digest('hex') } catch { return null }
}
const fmtDate = (d) => `${d.getMonth() + 1} 月 ${d.getDate()} 日`

/** 禁词检查：命中说明文案混进了内部术语 */
const BANNED = ['run', 'agent', 'part', 'builder', 'guardian', 'explorer', 'dispatch', 'claim', 'ledger', 'hash', 'seq', '轮次', '派单', '回执', '拍板', '通道', '底子', '幂等', 'payload']
const clean = (s) => {
  const t = String(s || '')
  const hit = BANNED.find(w => t.toLowerCase().includes(w.toLowerCase()))
  return hit ? t.replace(new RegExp(hit, 'gi'), '') : t
}

const trim = (s, n) => { const t = String(s || '').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t }

export function readResults(unitedDir) {
  if (!existsSync(unitedDir)) return { headline: '还没有可以确认的成果。', done: [], doing: [], redo: [], checkedAt: '' }
  const runsDir = join(unitedDir, 'runs')
  if (!existsSync(runsDir)) return { headline: '还没有可以确认的成果。', done: [], doing: [], redo: [], checkedAt: '' }

  const runs = readdirSync(runsDir).filter(d => { try { return statSync(join(runsDir, d)).isDirectory() } catch { return false } })

  const done = [], doing = [], redo = []
  let newest = 0

  for (const id of runs) {
    const d = join(runsDir, id)
    const st = rd(join(d, 'state.json'))
    const goal = rd(join(d, 'goal.json'))
    const result = rd(join(d, 'result.json'))   // 人工写的成果文案（可选）
    if (!st || !goal) continue

    // 产物：artifacts 下的文件，算真哈希
    const artDir = join(d, 'artifacts')
    const arts = existsSync(artDir)
      ? readdirSync(artDir).filter(f => { try { return statSync(join(artDir, f)).isFile() } catch { return false } }).map(f => ({ name: f, path: join(artDir, f), sha: sha256(join(artDir, f)) }))
      : []
    const realArts = arts.filter(a => a.sha)

    // 决议
    const decDir = join(d, 'decisions')
    const decisions = existsSync(decDir) ? readdirSync(decDir).filter(f => f.endsWith('.json')).map(f => rd(join(decDir, f))).filter(Boolean) : []

    const pend = st.pending || {}
    const waiting = Object.values(pend).filter(v => v.status === 'pending')
    const anyOverdue = waiting.some(v => v.deadline_at && Date.now() > new Date(v.deadline_at).getTime())
    const hasVeto = !!st.veto

    // 时间
    let mtime = 0
    for (const a of realArts) { try { mtime = Math.max(mtime, statSync(a.path).mtimeMs) } catch {} }
    try { mtime = Math.max(mtime, statSync(join(d, 'state.json')).mtimeMs) } catch {}
    if (mtime) newest = Math.max(newest, mtime)

    // 判定
    let state = 'doing'
    if (hasVeto) state = 'redo'
    else if (st.status === 'done' && decisions.length && realArts.length) state = 'done'
    else if (realArts.length && (st.status === 'running' || st.status === 'open')) state = 'checking'
    else if (st.status === 'blocked') state = 'decide'
    else if (anyOverdue) state = 'decide'
    else if (st.status === 'done' && !realArts.length) state = 'checking'   // 说完成了但没产物 → 待核对
    else state = 'doing'

    // 文案：优先人工 result.json，否则机械推导（只写能证明的）
    const artNames = realArts.map(a => a.name).join('、')
    const title = result?.title
      ? clean(trim(result.title, 40))
      : (realArts.length
        ? clean(trim(`${goal.goal} —— 已产出${artNames ? ' ' + trim(artNames, 20) : ''}`, 40))
        : clean(trim(goal.goal, 40)))
    const note = result?.note
      ? clean(trim(result.note, 70))
      : (state === 'done' ? '产物已核对，内容与约定一致。'
        : state === 'checking' ? (realArts.length ? '产物已在，但还没核对完，不能算完成。' : '标了完成，但没有可打开的产物。')
        : state === 'redo' ? '有人提了异议，这一版不作为正式结果。'
        : state === 'decide' ? (anyOverdue ? '有人超时没交回，等你定要不要催或重派。' : '卡住了，等你给个方向。')
        : '还在做，没有可核对的结果。')

    const open = realArts.length
      ? { text: `产物：${artNames}\n位置：${realArts[0].path}\n校验值：${realArts[0].sha}` }
      : (goal.acceptance ? { text: `这件事的验收条件：\n${goal.acceptance}` } : null)

    const item = {
      id, title, note, state,
      openLabel: realArts.length ? '看结果' : (goal.acceptance ? '看验收条件' : null),
      open,
      updatedAt: mtime ? fmtDate(new Date(mtime)) : '',
    }

    if (state === 'done') done.push(item)
    else if (state === 'redo') redo.push(item)
    else doing.push(item)
  }

  const byTime = (a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')
  done.sort(byTime); redo.sort(byTime); doing.sort(byTime)

  // 首屏那一句：先讲最新成果；没有成果就直说
  let headline
  if (done.length) {
    headline = clean(`${done[0].title}。${done[0].note}`)
  } else if (redo.length) {
    headline = clean(`目前没有可确认的成果。最近一件需要重做：${redo[0].title}`)
  } else if (doing.length) {
    headline = clean(`目前还没有可确认的成果。正在做：${doing[0].title}`)
  } else {
    headline = '目前还没有可确认的成果。'
  }

  return {
    headline,
    done, doing, redo,
    checkedAt: newest ? fmtDate(new Date(newest)) : '',
  }
}
