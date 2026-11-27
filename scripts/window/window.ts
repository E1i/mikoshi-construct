import type { DatabaseSync } from 'node:sqlite'
import type { Equivalence } from '../core/node.js'
import type { TaskRow } from '../core/tasks-query.js'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { defaultBusPath, openBus } from '../core/db.js'
import { EITHER_JOURNAL, events } from '../core/events-query.js'
import { CARD_CLOSED, MERGE_DONE, NODE_DETECTED, NODE_EQUIVALENCE, REVIEW_RECORDED, UPDATE_DONE } from '../core/events.js'
import { FACTORY_RUNTIME } from '../core/factory-paths.js'
import { TSX_COMMAND } from '../core/owner-commands.js'
import { ofQueue } from '../core/tasks-query.js'
import { BusRead } from '../ports/bus-read.js'

export const PREFIX = '[bus:window] '
export const COMPLETION_OF = { merge: MERGE_DONE, update: UPDATE_DONE, close: CARD_CLOSED, review: REVIEW_RECORDED } as const
export const USAGE = `usage: ${TSX_COMMAND} ${FACTORY_RUNTIME.busWindow} <${Object.keys(COMPLETION_OF).join('|')}>`

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

function tasksOf(queued: readonly TaskRow[], completion: Completion): string[] {
  return queued.filter(task => task.card_id === completion.card_id && task.pr === completion.pr && task.head === completion.head).sort((a, b) => a.id - b.id).map(task => task.task_key)
}

function liveDetectionBefore(db: DatabaseSync, queue: WindowQueue, key: string, before: number): number | null {
  const row = events(db, { keys: [`${NODE_DETECTED}:${queue}:${key}`], types: [NODE_DETECTED], before, legacy: EITHER_JOURNAL })[0]
  if (row === undefined)
    return null
  const payload = (row.data ?? {}) as { key?: unknown, via?: unknown, outcome?: unknown }
  return payload.key === key && payload.via === DETECTED_VIA && typeof payload.outcome === 'string' && DETECTED_OUTCOMES.has(payload.outcome) ? row.id : null
}

function keyOfCompletion(db: DatabaseSync, queue: WindowQueue, queued: readonly TaskRow[], completion: Completion): KeyInRun | string {
  const tasks = tasksOf(queued, completion)
  if (tasks.length !== 1)
    return `${tasks.length} ${queue} tasks for card ${completion.card_id ?? '-'} pr ${completion.pr ?? '-'} head ${completion.head ?? '-'}, not one`
  const key = tasks[0]!
  const detected = liveDetectionBefore(db, queue, key, completion.id)
  return detected === null ? `no live ${NODE_DETECTED} by ${key} via ${DETECTED_VIA} before it` : { key, completion: completion.id, detected, tasks: tasks.length }
}

function equivalenceTicks(db: DatabaseSync, queue: WindowQueue, since: number): { ticks: number, oneSided: OneSidedTick[] } {
  const actor = `worker:${queue}:`
  const rows = new BusRead(db).where({ actor, from: since, legacy: true }).slice(NODE_EQUIVALENCE, ['only_node', 'only_derive'])
  const oneSided = rows.map((row) => {
    const fields = row.fields as Partial<Pick<Equivalence, 'only_node' | 'only_derive'>>
    return { id: row.id, only_node: fields.only_node ?? [], only_derive: fields.only_derive ?? [] }
  }).filter(tick => tick.only_node.length > 0 || tick.only_derive.length > 0)
  return { ticks: rows.length, oneSided }
}

export function windowOf(db: DatabaseSync, queue: WindowQueue): WindowCount {
  const completions: Completion[] = events(db, { types: [COMPLETION_OF[queue]], legacy: EITHER_JOURNAL, newestFirst: true })
  const queued = ofQueue(db, queue)
  const run: KeyInRun[] = []
  let stop: WindowCount['stop'] = null
  for (const completion of completions) {
    const found = keyOfCompletion(db, queue, queued, completion)
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
