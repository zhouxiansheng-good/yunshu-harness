/** Runner-owned receipt signing and on-disk provenance checks. */
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const digest = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

function key() {
  const file = process.env.UNITED_RUNNER_KEY_FILE
  if (!file || !isAbsolute(file)) throw new Error('UNITED_RUNNER_KEY_FILE must name an absolute private key file')
  const project = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const rel = relative(project, resolve(file))
  if (!rel.startsWith('..') && !isAbsolute(rel)) throw new Error('runner key must be outside the project tree')
  const bytes = readFileSync(file)
  if (bytes.length < 32) throw new Error('runner key must contain at least 32 random bytes')
  return bytes
}

export function assertRunnerKey() { key() }

export function signReceipt(body) {
  const signature = createHmac('sha256', key()).update(JSON.stringify(body)).digest('hex')
  return { ...body, signature }
}

export function inside(root, file) {
  const base = realpathSync(root)
  const target = realpathSync(file)
  const rel = relative(base, target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('receipt path escapes run directory')
  if (!statSync(target).isFile()) throw new Error('receipt path is not a file')
  return target
}

export function verifyReceipt(receipt, runDir) {
  if (!receipt || receipt.v !== 2 || typeof receipt.signature !== 'string') throw new Error('invalid runner receipt v2')
  const { signature, ...body } = receipt
  const expected = createHmac('sha256', key()).update(JSON.stringify(body)).digest('hex')
  const got = Buffer.from(signature, 'hex'); const want = Buffer.from(expected, 'hex')
  if (got.length !== want.length || !timingSafeEqual(got, want)) throw new Error('runner receipt signature mismatch')
  if (!/^a-[0-9a-f-]{36}$/.test(body.attempt_id || '')) throw new Error('invalid attempt_id')
  if (!Number.isFinite(Date.parse(body.started_at)) || !Number.isFinite(Date.parse(body.ended_at))
      || Date.parse(body.ended_at) < Date.parse(body.started_at)) throw new Error('invalid receipt times')
  if (!Number.isInteger(body.exit_code) && body.exit_code !== null) throw new Error('invalid exit_code')
  if (!['executor_file', 'codex_final_event', 'dsh_final_event', 'missing'].includes(body.model_output_origin)) throw new Error('invalid model output origin')
  if ((body.model_output === null) !== (body.model_output_origin === 'missing')) throw new Error('model output presence mismatch')
  for (const name of ['task', 'stdout', 'stderr', 'normalized_result', 'envelope',
    ...(body.model_output === null ? [] : ['model_output'])]) {
    const record = body[name]
    if (!record || typeof record.path !== 'string' || !/^[0-9a-f]{64}$/.test(record.sha256 || '')) throw new Error('invalid ' + name + ' record')
    const path = inside(runDir, record.path)
    if (digest(path) !== record.sha256) throw new Error(name + ' hash mismatch')
  }
  return body
}
