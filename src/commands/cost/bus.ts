import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { parseCard } from '../../card/grammar.js'
import { projectKey } from './claude-code.js'

const CHEAP_CONTOUR = 'cheap'
const MS_PER_MINUTE = 60_000

interface BusTask {
  task: string
  taskClass: string
  sessions: { id: string, project: string }[]
  minutes: number
}

interface BusLeftOut {
  task: string
  taskClass: string
  text: string
}

interface BusSample {
  tasks: BusTask[]
  leftOut: BusLeftOut[]
}

interface ClosedCardRow {
  card_id: number
  card_line: string | null
  started: string
  start_payload: string
  ended: string
  close_payload: string
}

const CLOSED_CARDS = `
SELECT c.card_id, b.card_line, s.ts AS started, s.payload AS start_payload, k.ts AS ended, k.payload AS close_payload
FROM cards c
JOIN card_bodies b ON b.card_id = c.card_id
JOIN events k ON k.card_id = c.card_id AND k.type = 'card.closed'
JOIN events s ON s.id = (SELECT MAX(id) FROM events WHERE card_id = c.card_id AND type = 'card.started' AND legacy = 0)
WHERE s.ts IS NOT NULL AND k.ts IS NOT NULL
ORDER BY c.card_id
`

function payloadOf(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown
    return value != null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  }
  catch {
    return {}
  }
}

function taskOf(row: ClosedCardRow, busPath: string): BusTask | BusLeftOut | null {
  if (row.card_line === null)
    return null
  const parsed = parseCard(row.card_line)
  if (parsed.kind !== 'card' || parsed.card.contour !== CHEAP_CONTOUR)
    return null
  const task = String(row.card_id)
  const taskClass = `${parsed.card.kind}/${parsed.card.size}`
  if (typeof payloadOf(row.close_payload).verification !== 'string')
    return { task, taskClass, text: `#${task} close without verification not counted` }
  const { session, worktree } = payloadOf(row.start_payload)
  if (typeof session !== 'string' || session === '' || typeof worktree !== 'string')
    return { task, taskClass, text: `#${task} session or worktree not recorded on its card.started event in ${busPath}` }
  const minutes = (Date.parse(row.ended) - Date.parse(row.started)) / MS_PER_MINUTE
  if (!Number.isFinite(minutes) || minutes < 0)
    return { task, taskClass, text: `#${task} closed before it started in ${busPath}, not counted` }
  return { task, taskClass, sessions: [{ id: session, project: projectKey(worktree) }], minutes }
}

export function readBusTasks(busPath: string): BusSample {
  const sample: BusSample = { tasks: [], leftOut: [] }
  if (!existsSync(busPath))
    return sample
  try {
    for (const row of closedCards(busPath)) {
      const read = taskOf(row, busPath)
      if (read !== null && 'text' in read)
        sample.leftOut.push(read)
      else if (read !== null)
        sample.tasks.push(read)
    }
    return sample
  }
  catch {
    return { tasks: [], leftOut: [] }
  }
}

function closedCards(busPath: string): ClosedCardRow[] {
  const db = new DatabaseSync(busPath, { readOnly: true })
  try {
    return db.prepare(CLOSED_CARDS).all() as unknown as ClosedCardRow[]
  }
  finally {
    db.close()
  }
}
