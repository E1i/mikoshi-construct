import type { ShiftTask } from './task-file.js'
import { parseTaskFile } from './task-file.js'
import { witnessFieldRefusals } from './witness-fields.js'

export const SHIFT_WHO = 'shift'
export const WINDOW_WHO = 'window'
export const PRIORITIES = ['p0', 'p1', 'p2'] as const
export const CARD_TOOLS = ['web', 'skills', 'agents'] as const
const PARKING_KEYS = ['who', 'priority', 'release', 'tools'] as const
const PARKING_LINE = /^(who|priority|release|creates|tools):(.*)$/
const TOOLS_SEPARATOR = /[\s,]+/

export type Priority = typeof PRIORITIES[number]
export type CardTool = typeof CARD_TOOLS[number]

export interface ParkedTask {
  task: ShiftTask
  who: string
  priority: Priority | null
  release: string | null
  creates: string[]
  tools: CardTool[]
}

export interface ParkingFileFields {
  card: string
  branch: string
  touches: readonly string[]
  creates?: readonly string[]
  continue: string
  who: string
  priority?: Priority
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
  const release = parking.get('release') ?? null
  if (release === '')
    return refused(file, `'release:' names no release; name an open release or take the line out`)
  const toolsLine = parking.get('tools') ?? null
  const tools = (toolsLine ?? '').split(TOOLS_SEPARATOR).filter(word => word !== '')
  if (toolsLine !== null && tools.length === 0)
    return refused(file, `'tools:' names no tool; name any of ${CARD_TOOLS.join(', ')} or take the line out`)
  const unknownTool = tools.find(word => !(CARD_TOOLS as readonly string[]).includes(word))
  if (unknownTool !== undefined)
    return refused(file, `tools '${unknownTool}' is not one of ${CARD_TOOLS.join(', ')}`)
  const parsed = parseTaskFile(file, rest.join('\n'))
  if (parsed.kind === 'refused')
    return { kind: 'refused', reason: `${parsed.reason}; a parked card also takes ${PARKING_KEYS.join(', ')}` }
  if (parsed.task.number !== parsed.task.id)
    return refused(file, `a parked card's file is named after its id: ${parsed.task.id}.md`)
  const fieldRefusals = witnessFieldRefusals(parsed.task.body)
  if (fieldRefusals.length > 0)
    return refused(file, fieldRefusals.join('; '))
  const creates = (parking.get('creates') ?? '').split(',').map(entry => entry.trim()).filter(entry => entry !== '')
  return { kind: 'parked', parked: { task: parsed.task, who, priority: priority as Priority | null, release, creates, tools: tools as CardTool[] } }
}

export function cardToolsOf(file: string, text: string | null): CardTool[] {
  if (text === null)
    return []
  const parsed = parseParkingFile(file, text)
  return parsed.kind === 'parked' ? parsed.parked.tools : []
}

export function parkingFileText(fields: ParkingFileFields): string {
  return [
    `card: ${fields.card}`,
    `branch: ${fields.branch}`,
    `touches: ${fields.touches.join(', ')}`,
    ...(fields.creates === undefined || fields.creates.length === 0 ? [] : [`creates: ${fields.creates.join(', ')}`]),
    `continue: ${fields.continue}`,
    `who: ${fields.who}`,
    ...(fields.priority === undefined ? [] : [`priority: ${fields.priority}`]),
    '',
    fields.body.trim(),
    '',
  ].join('\n')
}
