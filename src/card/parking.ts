import type { ShiftTask } from './task-file.js'
import { parseTaskFile } from './task-file.js'

export const SHIFT_WHO = 'shift'
export const WINDOW_WHO = 'window'
export const PRIORITIES = ['p0'] as const
const PARKING_KEYS = ['who', 'priority'] as const
const PARKING_LINE = /^(who|priority|creates):(.*)$/

export type Priority = typeof PRIORITIES[number]

export interface ParkedTask {
  task: ShiftTask
  who: string
  priority: Priority | null
  creates: string[]
}

export interface ParkingFileFields {
  card: string
  branch: string
  touches: readonly string[]
  creates?: readonly string[]
  continue: string
  who: string
  body: string
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
  const creates = (parking.get('creates') ?? '').split(',').map(entry => entry.trim()).filter(entry => entry !== '')
  return { kind: 'parked', parked: { task: parsed.task, who, priority: priority as Priority | null, creates } }
}

export function parkingFileText(fields: ParkingFileFields): string {
  return [
    `card: ${fields.card}`,
    `branch: ${fields.branch}`,
    `touches: ${fields.touches.join(', ')}`,
    ...(fields.creates === undefined || fields.creates.length === 0 ? [] : [`creates: ${fields.creates.join(', ')}`]),
    `continue: ${fields.continue}`,
    `who: ${fields.who}`,
    '',
    fields.body.trim(),
    '',
  ].join('\n')
}
