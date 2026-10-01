import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const ROLES_JOURNAL = path.join('.construct', 'roles.jsonl')

export interface ModelMismatch {
  at: string
  session: string
  agentType: string
  expected: string
  actual: string
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '?'
}

function mismatchOf(line: string): ModelMismatch[] {
  try {
    const entry = JSON.parse(line) as Record<string, unknown> | null
    if (entry?.kind !== 'model-mismatch')
      return []
    return [{ at: text(entry.at), session: text(entry.session), agentType: text(entry.agentType), expected: text(entry.expected), actual: text(entry.actual) }]
  }
  catch {
    return []
  }
}

export function readModelMismatches(dir: string | undefined): ModelMismatch[] {
  if (dir === undefined)
    return []
  const file = path.join(dir, ROLES_JOURNAL)
  try {
    return existsSync(file) ? readFileSync(file, 'utf8').split('\n').flatMap(mismatchOf) : []
  }
  catch {
    return []
  }
}

export function mismatchText(mismatch: ModelMismatch): string {
  return `model-mismatch ${mismatch.agentType} expected ${mismatch.expected}, ran on ${mismatch.actual} (${mismatch.at}, session ${mismatch.session})`
}
