/**
 * 路径门禁（codex 裁决第 6 节）
 * 硬规则：任何新产物只能写在 协作扩展 的真实路径之下；越界即失败。
 * 例外清单为只读引用（memory.sqlite、.yunshu、_diag），不作为写入许可。
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve, sep, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
// bin/ 的上一级就是 联合体，再上一级就是 协作扩展
export const ROOT = resolve(HERE, '..', '..')
const POLICY = join(ROOT, 'path-policy.json')

function loadPolicy() {
  if (!existsSync(POLICY)) return { single_root: ROOT, explicit_exceptions_readonly: [] }
  return JSON.parse(readFileSync(POLICY, 'utf8').replace(/^\uFEFF/, ''))
}
const policy = loadPolicy()
const CANON = resolve(policy.single_root || ROOT)

export class PathViolation extends Error {
  constructor(p, why) { super(`路径越界（${why}）：${p} 不在 ${CANON} 之下`); this.path = p; this.code = 'PATH_VIOLATION' }
}

/** 断言 p 在根内；越界抛错。允许根本身。 */
export function assertInRoot(p) {
  const abs = resolve(p)
  if (abs === CANON) return abs
  if (!abs.startsWith(CANON + sep)) throw new PathViolation(abs, '不在单根内')
  if (abs.includes('..')) throw new PathViolation(abs, '含 ..')
  return abs
}

/** 只读例外：允许读，不允许写。 */
export function isReadOnlyException(p) {
  const abs = resolve(p)
  return (policy.explicit_exceptions_readonly || []).some(e => abs === resolve(e) || abs.startsWith(resolve(e) + sep))
}

/** 供外部审计：返回门禁状态摘要 */
export function describe() {
  return { single_root: CANON, exceptions: (policy.explicit_exceptions_readonly || []).length, policy: POLICY }
}
