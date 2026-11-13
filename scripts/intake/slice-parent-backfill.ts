import type { SliceParentsBackfill } from '../core/card-bodies.js'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parentsFromCardLines } from '../../src/commands/intake/slice.js'
import { backfillSliceParentsOfBus } from '../core/card-bodies.js'

export const PREFIX = '[bus:slice-parent-backfill] '

export function sliceParentBackfill(ts: string, file?: string): SliceParentsBackfill {
  return backfillSliceParentsOfBus(ts, parentsFromCardLines, file)
}

export function backfillLines({ recorded, transfer }: SliceParentsBackfill): string[] {
  return [
    `${PREFIX}${recorded ? 'recorded' : 'already recorded, nothing written'}: ${Object.keys(transfer.cards).length} slices with a parent, ${transfer.unread.length} slice names read two ways and left without one`,
    ...transfer.unread.map(card => `${PREFIX}#${card}: another card carries the same slice name and part`),
  ]
}

function main(): number {
  for (const line of backfillLines(sliceParentBackfill(new Date().toISOString())))
    console.log(line)
  return 0
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main()
