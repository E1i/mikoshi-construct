import type { ParkedTask } from '../../src/card/parking.js'
import type { ShiftTask } from '../../src/card/task-file.js'
import { SHIFT_WHO } from '../../src/card/parking.js'
import { taskConflicts } from './overlap.js'

export interface LeftCard {
  id: string
  reason: string
}

export interface Choice {
  chosen: ShiftTask[]
  left: LeftCard[]
}

const CLOSED = 'closed'

function byPriorityThenId(a: ParkedTask, b: ParkedTask): number {
  return Number(b.priority !== null) - Number(a.priority !== null) || Number(a.task.id) - Number(b.task.id)
}

function leftReason(parked: ParkedTask, done: ReadonlySet<string>, merged: ReadonlySet<string>): string | null {
  if (done.has(parked.task.id))
    return CLOSED
  if (parked.who !== SHIFT_WHO)
    return `who ${parked.who}`
  const open = parked.task.card.depends.filter(id => !merged.has(String(id)))
  return open.length === 0 ? null : `depends ${open.map(id => `#${id}`).join(', ')} not merged`
}

export function choose(parked: readonly ParkedTask[], done: ReadonlySet<string>, merged: ReadonlySet<string>): Choice {
  const chosen: ShiftTask[] = []
  const left: LeftCard[] = []
  for (const card of [...parked].sort(byPriorityThenId)) {
    const reason = leftReason(card, done, merged)
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
