import type { Ui } from '../ui/console.js'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { busPathOf, isOwnerCheckout, repositoryRoot } from '../../scripts/core/bus-path.js'
import { LADDER_RUN } from '../../scripts/core/events.js'
import { appendLedgerLine, LEDGER_FIELDS, parseLedgerLine } from './cost/ledger.js'

export const RUN_RECORD_EXIT = { recorded: 0, refused: 2 } as const
export const RUN_RECORD_CARD_VARIABLE = 'CONSTRUCT_CARD'
export const RUN_RECORD_ADAPTERS = ['bus', 'file'] as const
export const RUN_RECORD_ACTOR_PREFIX = 'worker:ladder:'
export const UNJOINABLE_RUN = 'unjoinable'

const ACTOR_UNSAFE = /[:\s]/g
const LEADING_CARD = /^#?(\d+)(?!\d)/
const POSITIVE_INTEGER = /^[1-9]\d*$/

export type RunRecordAdapter = typeof RUN_RECORD_ADAPTERS[number]

export type RunRecordResult
  = | { kind: 'recorded', adapter: RunRecordAdapter, target: string, fresh: boolean }
    | { kind: 'refused', reason: string }
    | { kind: 'needsBus', busPath: string }

export interface RunRecordPlace {
  dir: string
  env: NodeJS.ProcessEnv
  home: string
  now: () => Date
}

export interface LadderRunEvent {
  ts: string
  actor: string
  cardId: number | null
  dedupeKey: string
  payload: string
}

export type LadderRunPort = (busPath: string, event: LadderRunEvent) => boolean

type RunFields = Record<string, unknown>

function undeclaredKeys(record: RunFields): string[] {
  return Object.keys(record).filter(key => !(LEDGER_FIELDS as readonly string[]).includes(key))
}

function recordOf(text: string): RunFields | string {
  const entry = parseLedgerLine(text)
  if (typeof entry === 'string')
    return entry
  const record = JSON.parse(text) as RunFields
  const undeclared = undeclaredKeys(record)
  return undeclared.length === 0 ? record : `undeclared fields: ${undeclared.join(', ')}`
}

function cardOf(record: RunFields, env: NodeJS.ProcessEnv): number | null {
  const named = env[RUN_RECORD_CARD_VARIABLE]?.trim()
  if (named !== undefined && POSITIVE_INTEGER.test(named))
    return Number(named)
  const leading = typeof record.task === 'string' ? LEADING_CARD.exec(record.task.trim()) : null
  return leading === null || Number(leading[1]) === 0 ? null : Number(leading[1])
}

function actorOf(record: RunFields): string {
  const run = typeof record.run === 'string' && record.run !== '' ? record.run : UNJOINABLE_RUN
  return `${RUN_RECORD_ACTOR_PREFIX}${run.replace(ACTOR_UNSAFE, '-')}`
}

function rootOf(dir: string): string {
  return repositoryRoot(dir) ?? path.resolve(dir)
}

export function wiredBusOf(place: Pick<RunRecordPlace, 'dir' | 'env' | 'home'>): string | null {
  const busPath = busPathOf(place.env, place.home, place.dir, isOwnerCheckout(place.dir))
  return existsSync(busPath) ? busPath : null
}

export function ladderRunEventOf(record: RunFields, place: Pick<RunRecordPlace, 'env' | 'now'>): LadderRunEvent {
  const payload = JSON.stringify(record)
  return {
    ts: place.now().toISOString(),
    actor: actorOf(record),
    cardId: cardOf(record, place.env),
    dedupeKey: `${LADDER_RUN}:${createHash('sha256').update(payload).digest('hex')}`,
    payload,
  }
}

export function runRecord(text: string, place: RunRecordPlace, ladderRun?: LadderRunPort): RunRecordResult {
  const record = recordOf(text.trim())
  if (typeof record === 'string')
    return { kind: 'refused', reason: record }
  const busPath = wiredBusOf(place)
  if (busPath === null)
    return { kind: 'recorded', adapter: 'file', target: appendLedgerLine(rootOf(place.dir), JSON.stringify(record)), fresh: true }
  if (ladderRun === undefined)
    return { kind: 'needsBus', busPath }
  return { kind: 'recorded', adapter: 'bus', target: busPath, fresh: ladderRun(busPath, ladderRunEventOf(record, place)) }
}

export function printRunRecord(ui: Ui, result: RunRecordResult): number {
  if (result.kind === 'refused') {
    ui.flatline(ui.lore.runRecorded('refused', result.reason))
    return RUN_RECORD_EXIT.refused
  }
  if (result.kind === 'needsBus') {
    ui.flatline(ui.lore.runRecorded('needsBus', result.busPath))
    return RUN_RECORD_EXIT.refused
  }
  ui.ok(ui.lore.runRecorded(result.fresh ? result.adapter : 'present', result.target))
  return RUN_RECORD_EXIT.recorded
}
