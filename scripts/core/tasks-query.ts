import type { DatabaseSync, SQLInputValue } from 'node:sqlite'

export interface TaskRow {
  id: number
  task_key: string
  queue: string
  card_id: number
  pr: number | null
  head: string | null
  state: string
  lease_gen: number
  lease_until: string | null
  failures: number
  event_id: number
}

export interface CardTasks {
  queue?: string
  state?: string
  after?: number
}

type StoredTask = Record<keyof TaskRow, SQLInputValue>

function numberOrNull(value: SQLInputValue): number | null {
  return value === null ? null : Number(value)
}

function textOrNull(value: SQLInputValue): string | null {
  return value === null ? null : String(value)
}

function taskOf(row: StoredTask): TaskRow {
  return {
    id: Number(row.id),
    task_key: String(row.task_key),
    queue: String(row.queue),
    card_id: Number(row.card_id),
    pr: numberOrNull(row.pr),
    head: textOrNull(row.head),
    state: String(row.state),
    lease_gen: Number(row.lease_gen),
    lease_until: textOrNull(row.lease_until),
    failures: Number(row.failures),
    event_id: Number(row.event_id),
  }
}

export function ofCard(db: DatabaseSync, cardId: number, filter: CardTasks = {}): TaskRow[] {
  const where = ['card_id = ?']
  const values: SQLInputValue[] = [cardId]
  if (filter.queue !== undefined) {
    where.push('queue = ?')
    values.push(filter.queue)
  }
  if (filter.state !== undefined) {
    where.push('state = ?')
    values.push(filter.state)
  }
  if (filter.after !== undefined) {
    where.push('event_id > ?')
    values.push(filter.after)
  }
  const rows = db.prepare(`SELECT id, task_key, queue, card_id, pr, head, state, lease_gen, lease_until, failures, event_id FROM tasks WHERE ${where.join(' AND ')} ORDER BY event_id, id`).all(...values) as StoredTask[]
  return rows.map(taskOf)
}
