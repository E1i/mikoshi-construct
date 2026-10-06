import { TASK_FILE } from '../../card/task-file.js'
import { INTAKE_EVENT } from './confirm.js'

const TAKEN_TOKEN = /^#?(\d+)$/

export type ParsedTaken = { kind: 'taken', numbers: number[] } | { kind: 'refused', reason: string }

export function parseTaken(text: string): ParsedTaken {
  const tokens = text.split(/[\s,]+/).filter(token => token !== '')
  const bad = tokens.find(token => !TAKEN_TOKEN.test(token))
  if (bad !== undefined)
    return { kind: 'refused', reason: `'${bad}' is not a pull request or issue number; --taken holds numbers separated by whitespace` }
  return { kind: 'taken', numbers: tokens.map(token => Number(TAKEN_TOKEN.exec(token)![1])) }
}

export function parkedNumbers(files: readonly string[]): number[] {
  return files.flatMap((file) => {
    const id = TASK_FILE.exec(file)?.[1]
    return id === undefined ? [] : [Number(id)]
  })
}

export function admittedNumbers(journal: string | null): number[] {
  return (journal ?? '').split('\n').flatMap((line) => {
    try {
      const entry = JSON.parse(line) as { event?: unknown, task?: unknown } | null
      return entry?.event === INTAKE_EVENT && typeof entry.task === 'string' && TAKEN_TOKEN.test(entry.task) ? [Number(entry.task)] : []
    }
    catch {
      return []
    }
  })
}

export function nextFreeNumbers(taken: readonly number[], count: number): number[] {
  const first = Math.max(0, ...taken) + 1
  return Array.from({ length: count }, (_, index) => first + index)
}
