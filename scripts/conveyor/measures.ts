import type { DatabaseSync } from 'node:sqlite'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { defaultBusPath } from '../core/bus-path.js'
import { BUSY_TIMEOUT_MS } from '../core/db.js'
import { CHILD_ENDED, OWNER_WAIT_OPENED, PR_OBSERVED, REVIEW_RECORDED, TASK_COMPLETED, TASK_EXPIRED, TASK_FAILED, TASK_LEASED, TASK_RELEASED, TASK_SUPERSEDED, TASK_WITHDRAWN, UPDATE_DONE, WITNESS_RECORDED, WORKER_RETIRING } from '../core/events.js'
import { GENERATED_PATHS, NAMED_BY_THEIR_READERS, RATCHET_FILE } from '../core/generated-files.js'
import { RESTART_CUT } from '../core/lease.js'
import { openDatabase } from '../core/sqlite.js'
import { BusRead } from '../ports/bus-read.js'

export const ANSWER_QUEUE = 'answer'
export const UNSETTLED_CI = 'pending'
export const SIGNAL_EXIT = 143

export const SHARED_REGISTRIES: readonly string[] = [
  RATCHET_FILE.path,
  ...NAMED_BY_THEIR_READERS,
  ...GENERATED_PATHS,
  'eslint.config.mjs',
  'owner-commands-pending.json',
  'scripts/ci/layers.ts',
  'factory-paths.ts',
  'factory/modules.ts',
  'scripts/core/events.ts',
  'bus-readings.ts',
  'accepted.json',
  'nodes/laws.ts',
  'src/ui/lore.ts',
  'layer-map.json',
]

export const QUESTION_CLASSES = ['touches', 'growth', 'content'] as const

export type QuestionClass = typeof QUESTION_CLASSES[number]

const SIGNALLED_REASON = /\bexit 143\b|\bSIG(?:TERM|KILL|INT)\b/
const GROWTH = /\bgrow(?:s|th)?\b/i
const OUTSIDE_THE_TOUCHES = /outside (?:the |its )?(?:card(?:'s)? )?touches|widen(?:s|ed)? its touches|touches widened|not in the touches/i

export interface MeasureWindow {
  from: string
  to: string
}

export interface IdleUpdates {
  idle: number
  updates: number
  idleIds: number[]
}

export interface RestartCuts {
  cut: number
  live: number
  retirings: number
}

export interface RegistryQuestions {
  questions: number
  naming: number
  classes: Record<QuestionClass, number>
  ids: Record<QuestionClass, string[]>
}

export interface Measures {
  window: MeasureWindow
  idleUpdates: IdleUpdates
  restartCuts: RestartCuts
  registryQuestions: RegistryQuestions
}

function inside(window: MeasureWindow, ts: string | null): boolean {
  return ts !== null && ts >= window.from && ts < window.to
}

interface Observation {
  fields: { ci?: unknown, mergeable?: unknown }
}

function settled(observation: Observation): boolean {
  return observation.fields.ci !== UNSETTLED_CI
}

function sameObservation(left: Observation, right: Observation): boolean {
  return left.fields.ci === right.fields.ci && left.fields.mergeable === right.fields.mergeable
}

interface OnAHead {
  id: number
  head: string | null
}

function lastBefore<T extends OnAHead>(rows: readonly T[], head: string, id: number): T | undefined {
  return rows.filter(row => row.head === head && row.id < id).at(-1)
}

function onTheHead<T extends OnAHead>(rows: readonly T[], head: string): T[] {
  return rows.filter(row => row.head === head)
}

interface UpdateRow {
  id: number
  pr: number
  from: string
  to: string
}

function isIdle(read: BusRead, update: UpdateRow): boolean {
  const onThePr = read.where({ pr: update.pr })
  const observed = onThePr.slice(PR_OBSERVED, ['ci', 'mergeable'])
  const before = lastBefore(observed, update.from, update.id)
  const after = onTheHead(observed, update.to).filter(settled)
  if (before === undefined || after.length === 0 || !after.every(observation => sameObservation(observation, before)))
    return false
  const witnesses = onThePr.slice(WITNESS_RECORDED, ['verdict'])
  const witnessBefore = lastBefore(witnesses, update.from, update.id)?.fields.verdict ?? null
  if (!onTheHead(witnesses, update.to).every(witness => witness.fields.verdict === witnessBefore))
    return false
  const reviews = onTheHead(onThePr.slice(REVIEW_RECORDED, []), update.to)
  const answers = onTheHead(onThePr.slice(TASK_LEASED, ['queue']), update.to).filter(lease => lease.fields.queue === ANSWER_QUEUE)
  return reviews.length === 0 && answers.length === 0
}

export function idleUpdates(read: BusRead, window: MeasureWindow): IdleUpdates {
  const updates = read.where({ legacy: true }).slice(UPDATE_DONE, ['from', 'to', 'clean']).filter(update => inside(window, update.ts))
  const idleIds = updates.flatMap((update) => {
    const { from, to, clean } = update.fields
    if ((clean !== true && clean !== 1) || update.pr === null || typeof from !== 'string' || typeof to !== 'string')
      return []
    return isIdle(read.where({ legacy: true }), { id: update.id, pr: update.pr, from, to }) ? [update.id] : []
  })
  return { idle: idleIds.length, updates: updates.length, idleIds }
}

interface LeaseEnd {
  id: number
  type: string
  task: unknown
  gen: unknown
  reason: unknown
}

function leaseEnds(read: BusRead): LeaseEnd[] {
  const end = (type: string, row: { id: number, fields: { task_key?: unknown, lease_gen?: unknown, reason?: unknown } }): LeaseEnd =>
    ({ id: row.id, type, task: row.fields.task_key, gen: row.fields.lease_gen, reason: row.fields.reason })
  return [
    ...read.slice(TASK_COMPLETED, ['task_key', 'lease_gen']).map(row => end(TASK_COMPLETED, row)),
    ...read.slice(TASK_EXPIRED, ['task_key', 'reason']).map(row => end(TASK_EXPIRED, row)),
    ...read.slice(TASK_FAILED, ['task_key', 'lease_gen', 'reason']).map(row => end(TASK_FAILED, row)),
    ...read.slice(TASK_RELEASED, ['task_key', 'lease_gen', 'reason']).map(row => end(TASK_RELEASED, row)),
    ...read.slice(TASK_SUPERSEDED, ['task_key', 'lease_gen']).map(row => end(TASK_SUPERSEDED, row)),
    ...read.slice(TASK_WITHDRAWN, ['task_key']).map(row => end(TASK_WITHDRAWN, row)),
  ].sort((left, right) => left.id - right.id)
}

interface HeldLease {
  id: number
  task: unknown
  gen: unknown
}

function endOf(ends: readonly LeaseEnd[], lease: HeldLease, after: number): LeaseEnd | undefined {
  return ends.find(end => end.id > after && end.task === lease.task && end.gen === lease.gen)
}

interface SignalEnd {
  id: number
  task: unknown
}

function signalEnds(read: BusRead): SignalEnd[] {
  return read.slice(CHILD_ENDED, ['task_key', 'exit', 'signal'])
    .filter(row => (typeof row.fields.signal === 'string' && row.fields.signal !== '') || row.fields.exit === SIGNAL_EXIT)
    .map(row => ({ id: row.id, task: row.fields.task_key }))
}

function cutByRestart(ending: LeaseEnd | undefined, signals: readonly SignalEnd[], lease: HeldLease, retiring: number): boolean {
  if (ending?.type === TASK_RELEASED && ending.reason === RESTART_CUT)
    return true
  if (ending?.type === TASK_FAILED && typeof ending.reason === 'string' && SIGNALLED_REASON.test(ending.reason))
    return true
  return signals.some(signal => signal.task === lease.task && signal.id > retiring && (ending === undefined || signal.id <= ending.id))
}

export function restartCuts(read: BusRead, window: MeasureWindow): RestartCuts {
  const all = read.where({ legacy: true })
  const retirings = all.slice(WORKER_RETIRING, ['worker']).filter(retiring => inside(window, retiring.ts))
  const answerLeases = all.slice(TASK_LEASED, ['queue', 'task_key', 'lease_gen']).filter(lease => lease.fields.queue === ANSWER_QUEUE)
  const ends = retirings.length === 0 ? [] : leaseEnds(all)
  const signals = retirings.length === 0 ? [] : signalEnds(all)
  let live = 0
  let cut = 0
  for (const retiring of retirings) {
    const worker = retiring.fields.worker
    if (typeof worker !== 'string')
      continue
    const held = answerLeases
      .filter(lease => lease.actor === worker && lease.id < retiring.id)
      .map(lease => ({ id: lease.id, task: lease.fields.task_key, gen: lease.fields.lease_gen }))
      .filter(lease => !ends.some(end => end.id > lease.id && end.id < retiring.id && end.task === lease.task && end.gen === lease.gen))
    live += held.length
    cut += held.filter(lease => cutByRestart(endOf(ends, lease, retiring.id), signals, lease, retiring.id)).length
  }
  return { cut, live, retirings: retirings.length }
}

export function namesARegistry(payload: string): boolean {
  return SHARED_REGISTRIES.some(registry => payload.includes(registry))
}

export function questionClassOf(text: string): QuestionClass {
  if (OUTSIDE_THE_TOUCHES.test(text))
    return 'touches'
  return GROWTH.test(text) ? 'growth' : 'content'
}

export function registryQuestions(read: BusRead, window: MeasureWindow): RegistryQuestions {
  const waits = read.where({ legacy: true }).slice(OWNER_WAIT_OPENED, ['card', 'command', 'id', 'need', 'pr', 'request', 'text']).filter(wait => inside(window, wait.ts))
  const classes: Record<QuestionClass, number> = { touches: 0, growth: 0, content: 0 }
  const ids: Record<QuestionClass, string[]> = { touches: [], growth: [], content: [] }
  const naming = waits.filter(wait => namesARegistry(JSON.stringify(wait.fields)))
  for (const wait of naming) {
    const kind = questionClassOf(typeof wait.fields.text === 'string' ? wait.fields.text : '')
    classes[kind] += 1
    ids[kind].push(typeof wait.fields.id === 'string' ? wait.fields.id : '?')
  }
  return { questions: waits.length, naming: naming.length, classes, ids }
}

export function measures(db: DatabaseSync, window: MeasureWindow): Measures {
  const read = new BusRead(db)
  return { window, idleUpdates: idleUpdates(read, window), restartCuts: restartCuts(read, window), registryQuestions: registryQuestions(read, window) }
}

export function measureLines(taken: Measures): string[] {
  const { window, idleUpdates: updates, restartCuts: cuts, registryQuestions: questions } = taken
  return [
    `window ${window.from} → ${window.to}`,
    `1. idle updates / all updates: ${updates.idle} / ${updates.updates} update.done`,
    `2. rounds cut by restart / rounds live at restart: ${cuts.cut} / ${cuts.live}, over ${cuts.retirings} worker.retiring`,
    `3. owner questions naming a hand-edited shared registry: ${questions.naming} of ${questions.questions} owner.wait.opened — touches ${questions.classes.touches}, growth ${questions.classes.growth}, content ${questions.classes.content}`,
    ...QUESTION_CLASSES.map(kind => `   ${kind}: ${questions.ids[kind].join(' ') || '—'}`),
  ]
}

export const USAGE = 'usage: conveyor:measures --from <ts> --to <ts> [--bus <bus.db>] [--json]'

export function runMeasures(args: readonly string[], busPath: string, write: (line: string) => void): number {
  const { values } = parseArgs({ args: [...args], options: { from: { type: 'string' }, to: { type: 'string' }, json: { type: 'boolean' }, bus: { type: 'string' } } })
  if (values.from === undefined || values.to === undefined) {
    write(USAGE)
    return 2
  }
  const db = openDatabase(values.bus ?? busPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS })
  try {
    const taken = measures(db, { from: values.from, to: values.to })
    for (const line of values.json === true ? [JSON.stringify(taken)] : measureLines(taken))
      write(line)
    return 0
  }
  finally {
    db.close()
  }
}

const isEntry = process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
if (isEntry)
  process.exitCode = runMeasures(process.argv.slice(2), defaultBusPath(), line => process.stdout.write(`${line}\n`))
