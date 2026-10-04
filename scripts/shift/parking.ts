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

function byPriorityThenId(a: ParkedTask, b: ParkedTask): number {
  return Number(b.priority !== null) - Number(a.priority !== null) || Number(a.task.id) - Number(b.task.id)
}

function leftReason(parked: ParkedTask, closed: ReadonlySet<string>): string | null {
  if (parked.who !== SHIFT_WHO)
    return `who ${parked.who}`
  if (closed.has(parked.task.id))
    return 'closed'
  const open = parked.task.card.depends.filter(id => !closed.has(String(id)))
  return open.length === 0 ? null : `depends ${open.map(id => `#${id}`).join(', ')} not closed`
}

export function choose(parked: readonly ParkedTask[], closed: ReadonlySet<string>): Choice {
  const chosen: ShiftTask[] = []
  const left: LeftCard[] = []
  for (const card of [...parked].sort(byPriorityThenId)) {
    const reason = leftReason(card, closed)
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
