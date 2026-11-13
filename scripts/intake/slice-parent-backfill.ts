import type { CardLine, SliceParentsBackfill, SliceParentsTransfer } from '../core/card-bodies.js'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { backfillSliceParentsOfBus } from '../core/card-bodies.js'

export const PREFIX = '[bus:slice-parent-backfill] '

const WRITTEN_SLICE_NAME = /^(.+)-slice-(\d+)$/
const CARD_LINE_NAME = /#\d+\s+(\S+)/

export interface SliceShare {
  card: number
  part: number
  of: number
}

export interface TransferredParents extends SliceParentsTransfer {
  cards: Record<string, SliceShare>
}

interface NamedSlice {
  card: number
  base: string
  part: number
}

function nameOnLine(line: string): string | null {
  return CARD_LINE_NAME.exec(line)?.[1] ?? null
}

function namedSlice(row: CardLine): NamedSlice | null {
  const slice = WRITTEN_SLICE_NAME.exec(nameOnLine(row.line) ?? '')
  return slice === null ? null : { card: row.card, base: slice[1]!, part: Number(slice[2]) }
}

export function parentsFromCardLines(rows: readonly CardLine[], among: readonly CardLine[]): TransferredParents {
  const siblings = among.flatMap(row => namedSlice(row) ?? [])
  const transferred: TransferredParents = { cards: {}, unread: [] }
  for (const slice of rows.flatMap(row => namedSlice(row) ?? [])) {
    const group = siblings.filter(other => other.base === slice.base)
    const parts = group.map(other => other.part)
    if (parts.filter(part => part === slice.part).length > 1) {
      transferred.unread.push(slice.card)
      continue
    }
    const stub = among.find(row => nameOnLine(row.line) === slice.base)?.card
    transferred.cards[String(slice.card)] = { card: stub ?? Math.min(...group.map(other => other.card)), part: slice.part, of: Math.max(new Set(parts).size, ...parts) }
  }
  return transferred
}

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
