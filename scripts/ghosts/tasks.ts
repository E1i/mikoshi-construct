import type { Card } from '../../src/card/grammar.js'
import { existsSync, readFileSync } from 'node:fs'
import { parseCard } from '../../src/card/grammar.js'
import { BUSY_TIMEOUT_MS, defaultBusPath } from '../bus/db.js'
import { CARD_STARTED } from '../bus/inbox.js'
import { openDatabase } from '../bus/sqlite.js'

export interface Task {
  id: string
  brief: string
  card: Card
}

export interface StartedTree {
  worktree: string
  branch: string
}

export interface TasksFile {
  repo: string
  status: string
  out: string
  tasks: Task[]
  matrix: string | undefined
}

const REQUIRED_TOP_LEVEL_KEYS = ['repo', 'status', 'out', 'tasks'] as const
const OPTIONAL_TOP_LEVEL_KEYS = ['matrix'] as const
const TOP_LEVEL_KEYS = [...REQUIRED_TOP_LEVEL_KEYS, ...OPTIONAL_TOP_LEVEL_KEYS] as const
const TASK_KEYS = ['id', 'brief', 'card'] as const

function assertPlainObject(value: unknown, where: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${where}: expected a JSON object`)
}

function assertKeys(object: Record<string, unknown>, allowed: readonly string[], required: readonly string[], where: string): void {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key))
      throw new Error(`${where}: unknown field '${key}'`)
  }
  for (const key of required) {
    if (!(key in object))
      throw new Error(`${where}: missing field '${key}'`)
  }
}

function assertString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`${where}: expected a non-empty string`)
  return value
}

function parseTask(raw: unknown, index: number): Task {
  const where = `tasks[${index}]`
  assertPlainObject(raw, where)
  assertKeys(raw, TASK_KEYS, TASK_KEYS, where)
  return {
    id: assertString(raw.id, `${where} field id`),
    brief: assertString(raw.brief, `${where} field brief`),
    card: parseTaskCard(raw.card, `${where} field card`),
  }
}

function parseTaskCard(value: unknown, where: string): Card {
  const parsed = parseCard(assertString(value, where))
  if (parsed.kind === 'refused')
    throw new Error(`${where}: ${parsed.reason}`)
  return parsed.card
}

export function parseTasksFile(raw: string): TasksFile {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch (error) {
    throw new Error(`the tasks file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }

  assertPlainObject(parsed, 'tasks file')
  assertKeys(parsed, TOP_LEVEL_KEYS, REQUIRED_TOP_LEVEL_KEYS, 'tasks file')

  const repo = assertString(parsed.repo, 'tasks file field repo')
  const status = assertString(parsed.status, 'tasks file field status')
  const out = assertString(parsed.out, 'tasks file field out')
  const matrix = parsed.matrix === undefined ? undefined : assertString(parsed.matrix, 'tasks file field matrix')

  if (!Array.isArray(parsed.tasks))
    throw new Error('tasks file field tasks: expected an array')

  const tasks = parsed.tasks.map((task, index) => parseTask(task, index))

  return { repo, status, out, tasks, matrix }
}

export function readTasksFile(filePath: string): TasksFile {
  return parseTasksFile(readFileSync(filePath, 'utf8'))
}

export type StartRecord = Record<string, unknown> & { event: 'path', task: string }

const CARD_STARTED_ROWS = `SELECT card_id, ts, payload FROM events WHERE type = '${CARD_STARTED}' AND legacy = 0 AND card_id IS NOT NULL ORDER BY id`

function jsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text)
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
  }
  catch {
    return undefined
  }
}

export function prCardOf(busPath: string, pr: number): number | null {
  if (!existsSync(busPath))
    return null
  const db = openDatabase(busPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS })
  try {
    const row = db.prepare('SELECT card_id FROM prs WHERE pr = ?').get(pr) as { card_id: number | null } | undefined
    return row?.card_id ?? null
  }
  finally {
    db.close()
  }
}

export function cardStartedLines(busPath: string): StartRecord[] {
  if (!existsSync(busPath))
    return []
  const db = openDatabase(busPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS })
  try {
    const rows = db.prepare(CARD_STARTED_ROWS).all() as unknown as { card_id: number, ts: string | null, payload: string }[]
    return rows.flatMap((row) => {
      const payload = jsonObject(row.payload)
      return payload === undefined ? [] : [{ ...payload, event: 'path' as const, task: String(row.card_id), ...(row.ts === null ? {} : { ts: row.ts }) }]
    })
  }
  finally {
    db.close()
  }
}

function startedTreeOf(line: Record<string, unknown>, task: string): StartedTree | undefined {
  return line.event === 'path' && line.task === task && typeof line.worktree === 'string' && typeof line.branch === 'string'
    ? { worktree: line.worktree, branch: line.branch }
    : undefined
}

export function startedTree(journalText: string, card: Card, busPath = defaultBusPath()): StartedTree | undefined {
  const journal = journalText.split('\n').map(jsonObject).filter(line => line !== undefined)
  return [...journal, ...cardStartedLines(busPath)].map(line => startedTreeOf(line, String(card.id))).filter(tree => tree !== undefined).at(-1)
}
