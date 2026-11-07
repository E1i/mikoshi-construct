import type { DatabaseSync } from 'node:sqlite'

export const BUS_VERSION = 2
export const CARD_VERSION = 1
export const UNRECORDED_VERSION = 1
export const CARD_VERSION_LINE = 'card-version:'

const NO_APPLICATION_ID = 0

export interface Understood {
  bus: readonly number[]
  card: readonly number[]
}

export function busVersionOf(db: DatabaseSync): number {
  const stamped = Number((db.prepare('PRAGMA application_id').get() as { application_id: number }).application_id)
  return stamped === NO_APPLICATION_ID ? UNRECORDED_VERSION : stamped
}

export function stampBusVersion(db: DatabaseSync, version: number): void {
  if (!Number.isInteger(version) || version <= NO_APPLICATION_ID)
    throw new Error(`a bus version is a positive integer, not ${version}`)
  db.exec(`PRAGMA application_id = ${version}`)
}

export function cardVersionOf(text: string): number {
  const line = text.split('\n').find(each => each.startsWith(CARD_VERSION_LINE))
  return line === undefined ? UNRECORDED_VERSION : Number(line.slice(CARD_VERSION_LINE.length).trim())
}
