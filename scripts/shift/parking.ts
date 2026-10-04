import type { ShiftTask } from './task-file.js'
import { taskConflicts } from './overlap.js'
import { parseTaskFile } from './task-file.js'

export const SHIFT_WHO = 'shift'
export const PRIORITIES = ['p0'] as const
const PARKING_KEYS = ['who', 'priority'] as const
const PARKING_LINE = /^(who|priority):(.*)$/

export type Priority = typeof PRIORITIES[number]

export interface ParkedTask {
  task: ShiftTask
  who: string
  priority: Priority | null
}

export interface LeftCard {
  id: string
  reason: string
}

export interface Choice {
  chosen: ShiftTask[]
  left: LeftCard[]
}

export type ParsedParkingFile = { kind: 'parked', parked: ParkedTask } | { kind: 'refused', reason: string }

function refused(file: string, reason: string): ParsedParkingFile {
  return { kind: 'refused', reason: `${file}: ${reason}` }
}

export function parseParkingFile(file: string, text: string): ParsedParkingFile {
  const lines = text.split('\n')
  const blank = lines.findIndex(line => line.trim() === '')
  const headerEnd = blank === -1 ? lines.length : blank
  const parking = new Map<string, string>()
  const rest: string[] = []
  for (const [index, line] of lines.entries()) {
    const match = index < headerEnd ? PARKING_LINE.exec(line.trim()) : null
    if (match === null) {
      rest.push(line)
      continue
    }
    const [, key, value] = match as unknown as [string, string, string]
    if (parking.has(key))
      return refused(file, `header key '${key}' appears twice`)
    parking.set(key, value.trim())
  }
  const who = parking.get('who') ?? ''
  if (who === '')
    return refused(file, `a parked card names who takes it: 'who: ${SHIFT_WHO}' or the column's other value`)
  const priority = parking.get('priority') ?? null
  if (priority !== null && !(PRIORITIES as readonly string[]).includes(priority))
    return refused(file, `priority '${priority}' is not one of ${PRIORITIES.join(', ')}`)
  const parsed = parseTaskFile(file, rest.join('\n'))
  if (parsed.kind === 'refused')
    return { kind: 'refused', reason: `${parsed.reason}; a parked card also takes ${PARKING_KEYS.join(', ')}` }
  if (parsed.task.number !== parsed.task.id)
    return refused(file, `a parked card's file is named after its id: ${parsed.task.id}.md`)
  return { kind: 'parked', parked: { task: parsed.task, who, priority: priority as Priority | null } }
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
