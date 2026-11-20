import type { DatabaseSync } from 'node:sqlite'
import { WITNESS_RECORDED } from '../core/events.js'
import { BusRead } from '../ports/bus-read.js'

export interface WitnessRecord {
  verdict: string
  detail: string
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function withWitnessRecords<T extends object>(admission: T, records: readonly WitnessRecord[]): T & { witnessRecords?: readonly WitnessRecord[] } {
  return records.length === 0 ? admission : { ...admission, witnessRecords: records }
}

export function witnessRecordsOf(db: DatabaseSync, cardId: number): WitnessRecord[] {
  return new BusRead(db).where({ card: cardId }).slice(WITNESS_RECORDED, ['verdict', 'detail']).map(({ fields }) => ({ verdict: textOf(fields.verdict), detail: textOf(fields.detail) }))
}
