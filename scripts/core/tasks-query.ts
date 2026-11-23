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

interface TaskFilter extends CardTasks {
  key?: string
  card?: number
}

function selected(db: DatabaseSync, filter: TaskFilter): TaskRow[] {
  const where: string[] = []
  const values: SQLInputValue[] = []
  const add = (clause: string, value: SQLInputValue | undefined): void => {
    if (value === undefined)
      return
    where.push(clause)
    values.push(value)
  }
  add('task_key = ?', filter.key)
  add('card_id = ?', filter.card)
  add('queue = ?', filter.queue)
  add('state = ?', filter.state)
  add('event_id > ?', filter.after)
  const rows = db.prepare(`SELECT id, task_key, queue, card_id, pr, head, state, lease_gen, lease_until, failures, event_id FROM tasks WHERE ${where.join(' AND ')} ORDER BY event_id, id`).all(...values) as StoredTask[]
  return rows.map(taskOf)
}

export function byKey(db: DatabaseSync, taskKey: string): TaskRow | null {
  return selected(db, { key: taskKey })[0] ?? null
}

export function ofQueue(db: DatabaseSync, queue: string): TaskRow[] {
  return selected(db, { queue })
}

export function ofCard(db: DatabaseSync, cardId: number, filter: CardTasks = {}): TaskRow[] {
  return selected(db, { ...filter, card: cardId })
}
