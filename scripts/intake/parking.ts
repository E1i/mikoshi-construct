import type { BusCardStates } from '../../src/card/closed.js'
import type { ParkedTask } from '../../src/card/parking.js'
import type { ShiftTask } from '../../src/card/task-file.js'
import { mergedTasks } from '../../src/card/closed.js'
import { SHIFT_WHO } from '../../src/card/parking.js'
import { FACTORY_FORMER_FOLDERS, inScopes } from '../core/factory-paths.js'
import { taskConflicts } from '../nodes/launch/overlap.js'
import { declaredGhostsFile, GHOSTS_FILES } from '../policy/shredder/reader.js'

export interface LeftCard {
  id: string
  reason: string
}

export interface Choice {
  chosen: ShiftTask[]
  left: LeftCard[]
}

const CLOSED = 'closed'
export const LADDER_REASON = `ladder card: MORSE approves a brief of any risk (ghosts:hash --by morse), a refused brief is left to the owner`
export const STOP_AT = ['hash', 'merge', 'question', 'boundary', 'fault'] as const

export type StopAt = typeof STOP_AT[number]
export const FAILED_AT: StopAt = 'fault'
export const DEPENDS_FAILED = 'depends failed '

export interface Stop {
  task: string
  at: StopAt
  why: string
  worktree: string | null
  shift: string
  session: string | null
  ts: string
  pr?: number
  failed?: boolean
}

function byPriorityThenId(a: ParkedTask, b: ParkedTask): number {
  return Number(b.priority !== null) - Number(a.priority !== null) || Number(a.task.id) - Number(b.task.id)
}

export type Created = (file: string) => boolean

function leftReason(parked: ParkedTask, done: ReadonlySet<string>, merged: ReadonlySet<string>, waiting: ReadonlyMap<string, StopAt>, created: Created, failedCards: ReadonlySet<string>): string | null {
  if (done.has(parked.task.id))
    return CLOSED
  if (parked.who !== SHIFT_WHO)
    return `who ${parked.who}`
  const stopped = waiting.get(parked.task.id)
  if (stopped !== undefined)
    return `waits ${stopped}`
  const open = parked.task.card.depends.filter(id => !merged.has(String(id)))
  const failed = open.filter(id => failedCards.has(String(id)))
  if (failed.length > 0)
    return `${DEPENDS_FAILED}${failed.map(id => `#${id}`).join(', ')}`
  if (open.length > 0)
    return `depends ${open.map(id => `#${id}`).join(', ')} not merged`
  const declared = new Set(parked.creates.flatMap(entry => declaredGhostsFile(entry)?.file ?? []))
  const unclassified = parked.task.touches.find(file => inScopes(file, FACTORY_FORMER_FOLDERS.ghosts) && !file.includes('*') && !declared.has(file) && created(file))
  if (unclassified !== undefined)
    return `classify ${unclassified} in ${GHOSTS_FILES}, or declare it in creates: with its kind`
  return null
}

export function latestStops(journal: string | null): Map<string, Stop> {
  const stops = new Map<string, Stop>()
  for (const line of (journal ?? '').split('\n')) {
    try {
      const entry = JSON.parse(line) as Partial<Stop> & { event?: unknown } | null
      if (entry?.event === 'stop' && typeof entry.task === 'string' && (STOP_AT as readonly unknown[]).includes(entry.at))
        stops.set(entry.task, entry as Stop)
    }
    catch {}
  }
  return stops
}

export function standingStops(stops: ReadonlyMap<string, Stop>, exists: (target: string) => boolean, released: (stop: Stop) => boolean = () => false): Map<string, StopAt> {
  const standing = new Map<string, StopAt>()
  for (const [task, stop] of stops) {
    if (!released(stop) && (stop.worktree === null ? stop.at === 'hash' : exists(stop.worktree)))
      standing.set(task, stop.at)
  }
  return standing
}

export function failedCards(stops: ReadonlyMap<string, Stop>, standing: ReadonlyMap<string, StopAt>): Set<string> {
  return new Set([...standing.keys()].filter(task => standing.get(task) === FAILED_AT && stops.get(task)?.failed === true))
}

export function choose(parked: readonly ParkedTask[], done: ReadonlySet<string>, merged: ReadonlySet<string>, waiting: ReadonlyMap<string, StopAt> = new Map(), created: Created = () => false, failed: ReadonlySet<string> = new Set()): Choice {
  const chosen: ShiftTask[] = []
  const left: LeftCard[] = []
  for (const card of [...parked].sort(byPriorityThenId)) {
    const reason = leftReason(card, done, merged, waiting, created, failed)
    const overlapping = reason === null ? chosen.find(task => taskConflicts([task, card.task]).length > 0) : undefined
    if (reason !== null)
      left.push({ id: card.task.id, reason })
    else if (overlapping !== undefined)
      left.push({ id: card.task.id, reason: `conflicts with #${overlapping.id}` })
    else
      chosen.push(card.task)
  }
  return { chosen, left }
}

export interface InReview {
  task: ShiftTask
  pr: number
}

export interface PipelineChoice {
  next: ShiftTask | undefined
  held: LeftCard[]
}

export function heldReason(review: InReview): string {
  return `waits PR #${review.pr} of #${review.task.id} in review`
}

export function nextInPipeline(chosen: readonly ShiftTask[], taken: ReadonlySet<string>, inReview: readonly InReview[]): PipelineChoice {
  const candidates = chosen.filter(candidate => !taken.has(candidate.id))
  const inWork = inReview[0]
  if (inWork === undefined)
    return { next: candidates[0], held: [] }
  return { next: undefined, held: candidates.map(card => ({ id: card.id, reason: heldReason(inWork) })) }
}

const DEPENDS_OPEN = /^depends (#\d+(?:, #\d+)*) not merged$/

export interface DependencyWait {
  id: string
  on: string[]
  inWork: boolean
}

function startedTasks(journal: string | null): Set<string> {
  return new Set((journal ?? '').split('\n').flatMap((line) => {
    try {
      const entry = JSON.parse(line) as { event?: unknown, task?: unknown, started?: unknown } | null
      return entry?.event === 'path' && typeof entry.task === 'string' && typeof entry.started === 'string' ? [entry.task] : []
    }
    catch {
      return []
    }
  }))
}

export function dependencyWaits(left: readonly LeftCard[], journal: string | null, busCards?: BusCardStates): DependencyWait[] {
  const started = startedTasks(journal)
  const merged = mergedTasks(journal, busCards)
  return left.flatMap((card) => {
    const open = DEPENDS_OPEN.exec(card.reason)
    if (open === null)
      return []
    const on = open[1]!.split(', ').map(id => id.slice(1))
    return [{ id: card.id, on, inWork: on.some(id => started.has(id) && !merged.has(id)) }]
  })
}

export function waitingLine(wait: DependencyWait): string {
  return `waiting on ${wait.on.map(id => `#${id}`).join(', ')}`
}

export const QUEUE_FILE = 'queue.txt'

function reasonGroup(reason: string): string {
  return reason.startsWith('who ') ? reason : reason.split(' ')[0]!
}

export function isClosed(card: LeftCard): boolean {
  return card.reason === CLOSED
}

export function leftSummary(left: readonly LeftCard[]): string {
  const counts = new Map<string, number>()
  for (const card of left)
    counts.set(reasonGroup(card.reason), (counts.get(reasonGroup(card.reason)) ?? 0) + 1)
  const groups = [...counts].sort((a, b) => b[1] - a[1]).map(([group, count]) => `${count} ${group}`)
  return `left: ${groups.length === 0 ? 'none' : groups.join(' · ')}`
}

export function leftLine(card: LeftCard): string {
  return `leaves #${card.id} (${card.reason})`
}

export function queueText(left: readonly LeftCard[]): string {
  return left.map(card => `${leftLine(card)}\n`).join('')
}
