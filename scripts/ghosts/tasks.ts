import type { Card } from '../../src/card/grammar.js'
import { readFileSync } from 'node:fs'
import { parseCard } from '../../src/card/grammar.js'

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

function startedTreeOf(line: string, task: string): StartedTree | undefined {
  try {
    const parsed = JSON.parse(line) as { event?: unknown, task?: unknown, worktree?: unknown, branch?: unknown }
    return parsed.event === 'path' && parsed.task === task && typeof parsed.worktree === 'string' && typeof parsed.branch === 'string'
      ? { worktree: parsed.worktree, branch: parsed.branch }
      : undefined
  }
  catch {
    return undefined
  }
}

export function startedTree(journalText: string, card: Card): StartedTree | undefined {
  return journalText.split('\n').map(line => startedTreeOf(line, String(card.id))).filter(tree => tree !== undefined).at(-1)
}
