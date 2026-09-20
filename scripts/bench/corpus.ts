import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const BRIEFS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tests/fixtures/ladder-runs')

export interface Brief {
  name: string
  text: string
  refusedBefore: boolean
}

export function corpus(): Brief[] {
  return readdirSync(BRIEFS)
    .filter(entry => entry.endsWith('.json'))
    .sort()
    .map(entry => JSON.parse(readFileSync(path.join(BRIEFS, entry), 'utf8')))
    .filter((run: { brief: string | null }) => run.brief != null)
    .map((run: { run: string, brief: string, returnedADesign: boolean, everyValueIsAPlaceholder: boolean }) => ({
      name: run.run,
      text: run.brief,
      refusedBefore: !run.returnedADesign || run.everyValueIsAPlaceholder,
    }))
}
