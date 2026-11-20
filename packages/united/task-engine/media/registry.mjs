import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const catalogPath = join(dirname(fileURLToPath(import.meta.url)), 'catalog.json')

export function matchingMediaHands(objective) {
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'))
  const phrase = String(objective).toLocaleLowerCase()
  return (catalog.capabilities || [])
    .filter(item => (item.trigger_terms || []).some(term => phrase.includes(String(term).toLocaleLowerCase())))
    .map(item => ({ id: item.id, readiness: item.readiness, command: item.command,
      when_use: item.when_use || null, when_not_use: item.when_not_use || null,
      selfcheck: item.selfcheck || null, input_format: item.input_format || null,
      output_format: item.output_format || null,
      cost_usd: item.cost_usd, price_unit: item.price_unit || null, catalog: catalogPath }))
}
