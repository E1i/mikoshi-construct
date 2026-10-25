import type { DatabaseSync } from 'node:sqlite'
import type { Equivalence } from './node.js'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { CARD_CLOSED, MERGE_DONE, NODE_DETECTED, NODE_EQUIVALENCE, REVIEW_RECORDED, UPDATE_DONE } from '../core/events.js'
import { FACTORY_RUNTIME } from '../core/factory-paths.js'
import { defaultBusPath, openBus } from './db.js'

export const PREFIX = '[bus:window] '
export const COMPLETION_OF = { merge: MERGE_DONE, update: UPDATE_DONE, close: CARD_CLOSED, review: REVIEW_RECORDED } as const
export const USAGE = `usage: pnpm exec tsx ${FACTORY_RUNTIME.busWindow} <${Object.keys(COMPLETION_OF).join('|')}>`

const DETECTED_OUTCOMES = new Set(['already', 'queued'])
const DETECTED_VIA = 'event'

export type WindowQueue = keyof typeof COMPLETION_OF

interface Completion {
  id: number
  card_id: number | null
  pr: number | null
  head: string | null
}

interface KeyInRun {
  key: string
  completion: number
  detected: number
  tasks: number
}

interface OneSidedTick extends Pick<Equivalence, 'only_node' | 'only_derive'> {
  id: number
}

export interface WindowCount {
  queue: WindowQueue
  run: KeyInRun[]
  stop: { id: number, cardId: number | null, why: string } | null
  ticks: number
  oneSided: OneSidedTick[]
}

function isWindowQueue(value: string | undefined): value is WindowQueue {
  return value !== undefined && Object.hasOwn(COMPLETION_OF, value)
}

function tasksOf(db: DatabaseSync, queue: WindowQueue, completion: Completion): string[] {
  const rows = db.prepare('SELECT task_key FROM tasks WHERE queue = ? AND card_id IS ? AND pr IS ? AND head IS ? ORDER BY id').all(queue, completion.card_id, completion.pr, completion.head) as { task_key: string }[]
  return rows.map(row => row.task_key)
}

function liveDetectionBefore(db: DatabaseSync, queue: WindowQueue, key: string, before: number): number | null {
  const row = db.prepare('SELECT id, payload FROM events WHERE dedupe_key = ? AND type = ? AND id < ?').get(`${NODE_DETECTED}:${queue}:${key}`, NODE_DETECTED, before) as { id: number, payload: string } | undefined
  if (row === undefined)
    return null
  const payload = JSON.parse(row.payload) as { key?: unknown, via?: unknown, outcome?: unknown }
  return payload.key === key && payload.via === DETECTED_VIA && typeof payload.outcome === 'string' && DETECTED_OUTCOMES.has(payload.outcome) ? Number(row.id) : null
}

function keyOfCompletion(db: DatabaseSync, queue: WindowQueue, completion: Completion): KeyInRun | string {
  const tasks = tasksOf(db, queue, completion)
  if (tasks.length !== 1)
    return `${tasks.length} ${queue} tasks for card ${completion.card_id ?? '-'} pr ${completion.pr ?? '-'} head ${completion.head ?? '-'}, not one`
  const key = tasks[0]!
  const detected = liveDetectionBefore(db, queue, key, completion.id)
  return detected === null ? `no live ${NODE_DETECTED} by ${key} via ${DETECTED_VIA} before it` : { key, completion: completion.id, detected, tasks: tasks.length }
}

function equivalenceTicks(db: DatabaseSync, queue: WindowQueue, since: number): { ticks: number, oneSided: OneSidedTick[] } {
  const actor = `worker:${queue}:`
  const rows = db.prepare('SELECT id, payload FROM events WHERE type = ? AND substr(actor, 1, ?) = ? AND id >= ? ORDER BY id').all(NODE_EQUIVALENCE, actor.length, actor, since) as { id: number, payload: string }[]
  const oneSided = rows.map((row) => {
    const payload = JSON.parse(row.payload) as Partial<Equivalence>
    return { id: Number(row.id), only_node: payload.only_node ?? [], only_derive: payload.only_derive ?? [] }
  }).filter(tick => tick.only_node.length > 0 || tick.only_derive.length > 0)
  return { ticks: rows.length, oneSided }
}

export function windowOf(db: DatabaseSync, queue: WindowQueue): WindowCount {
  const completions = db.prepare('SELECT id, card_id, pr, head FROM events WHERE type = ? ORDER BY id DESC').all(COMPLETION_OF[queue]) as unknown as Completion[]
  const run: KeyInRun[] = []
  let stop: WindowCount['stop'] = null
  for (const completion of completions) {
    const found = keyOfCompletion(db, queue, completion)
    if (typeof found === 'string') {
      stop = { id: Number(completion.id), cardId: completion.card_id === null ? null : Number(completion.card_id), why: found }
      break
    }
    run.push(found)
  }
  const since = run.length === 0 ? null : Math.min(...run.map(entry => entry.detected))
  return { queue, run, stop, ...(since === null ? { ticks: 0, oneSided: [] } : equivalenceTicks(db, queue, since)) }
}

function sides(tick: OneSidedTick): string {
  return [tick.only_node.length > 0 ? `only node ${tick.only_node.join(', ')}` : null, tick.only_derive.length > 0 ? `only derive ${tick.only_derive.join(', ')}` : null].filter(side => side !== null).join('; ')
}

export function windowLines(count: WindowCount): string[] {
  const since = count.run.length === 0 ? null : Math.min(...count.run.map(entry => entry.detected))
  return [
    `${count.queue}: N ${count.run.length}`,
    count.stop === null ? 'stop: none, every completion is in the run' : `stop: bus id ${count.stop.id} card ${count.stop.cardId === null ? '-' : `#${count.stop.cardId}`}: ${count.stop.why}`,
    ...count.run.map(entry => `key ${entry.key} · tasks ${entry.tasks} · detected bus id ${entry.detected} · done bus id ${entry.completion}`),
    since === null
      ? 'equivalence: no run, no ticks read'
      : `equivalence: ${count.ticks} ticks since bus id ${since}, ${count.oneSided.length === 0 ? 'none with a key on one side only' : `with a key on one side only: ${count.oneSided.map(tick => `bus id ${tick.id} (${sides(tick)})`).join(', ')}`}`,
  ].map(line => `${PREFIX}${line}`)
}

export function main(argv: readonly string[]): number {
  const queue = argv[0]
  if (!isWindowQueue(queue)) {
    console.error(`${PREFIX}${USAGE}`)
    return 1
  }
  const db = openBus(defaultBusPath())
  try {
    console.log(windowLines(windowOf(db, queue)).join('\n'))
    return 0
  }
  finally {
    db.close()
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2))
