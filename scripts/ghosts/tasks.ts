import { readFileSync } from 'node:fs'

export interface Task {
  id: string
  brief: string
  worktree: string
  branch: string
}

export interface TasksFile {
  repo: string
  status: string
  out: string
  tasks: Task[]
}

const TOP_LEVEL_KEYS = ['repo', 'status', 'out', 'tasks'] as const
const TASK_KEYS = ['id', 'brief', 'worktree', 'branch'] as const

function assertPlainObject(value: unknown, where: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${where}: expected a JSON object`)
}

function assertKeys(object: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key))
      throw new Error(`${where}: unknown field '${key}'`)
  }
  for (const key of allowed) {
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
  assertKeys(raw, TASK_KEYS, where)
  return {
    id: assertString(raw.id, `${where} field id`),
    brief: assertString(raw.brief, `${where} field brief`),
    worktree: assertString(raw.worktree, `${where} field worktree`),
    branch: assertString(raw.branch, `${where} field branch`),
  }
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
  assertKeys(parsed, TOP_LEVEL_KEYS, 'tasks file')

  const repo = assertString(parsed.repo, 'tasks file field repo')
  const status = assertString(parsed.status, 'tasks file field status')
  const out = assertString(parsed.out, 'tasks file field out')

  if (!Array.isArray(parsed.tasks))
    throw new Error('tasks file field tasks: expected an array')

  const tasks = parsed.tasks.map((task, index) => parseTask(task, index))

  return { repo, status, out, tasks }
}

export function readTasksFile(filePath: string): TasksFile {
  return parseTasksFile(readFileSync(filePath, 'utf8'))
}
