import type { DatabaseSync } from 'node:sqlite'

export const BUS_VERSION = 3
export const BUS_VERSION_BEFORE_LADDER_RUN = 2
export const CARD_VERSION_BEFORE_TOUCH_SCOPE = 1
export const CARD_VERSION = 2
export const UNRECORDED_VERSION = 1
export const CARD_VERSION_KEY = 'cardVersion'
export const BUS_VERSION_RECORD = 'PRAGMA application_id'

const NO_APPLICATION_ID = 0

export interface Understood {
  bus: readonly number[]
  card: readonly number[]
}

function stampedId(db: DatabaseSync): number {
  return Number((db.prepare(BUS_VERSION_RECORD).get() as { application_id: number }).application_id)
}

export function busVersionOf(db: DatabaseSync): number {
  const stamped = stampedId(db)
  return stamped === NO_APPLICATION_ID ? UNRECORDED_VERSION : stamped
}

export function stampBusVersion(db: DatabaseSync, version: number): void {
  if (!Number.isInteger(version) || version <= NO_APPLICATION_ID)
    throw new Error(`a bus version is a positive integer, not ${version}`)
  db.exec(`${BUS_VERSION_RECORD} = ${version}`)
}

export function recordBusVersion(db: DatabaseSync): number {
  if (stampedId(db) === NO_APPLICATION_ID)
    stampBusVersion(db, BUS_VERSION)
  return busVersionOf(db)
}

export function cardVersionIn(payload: string | null): number {
  if (payload === null)
    return UNRECORDED_VERSION
  const version = (JSON.parse(payload) as Record<string, unknown>)[CARD_VERSION_KEY]
  return typeof version === 'number' ? version : UNRECORDED_VERSION
}
