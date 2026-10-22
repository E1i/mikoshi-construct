import type { Refusal } from './sandbox-refusals.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { REFUSALS } from './sandbox-refusals.js'

export interface SandboxFailing { file: string, test: string, refused: Refusal }

export const SANDBOX_FAILING_LIST = path.join(import.meta.dirname, 'sandbox-failing.jsonl')

export function parseSandboxFailing(text: string): SandboxFailing[] {
  return text.split('\n').filter(line => line !== '').map((line, index) => {
    const entry = JSON.parse(line) as Partial<SandboxFailing>
    if (typeof entry.file !== 'string' || typeof entry.test !== 'string' || typeof entry.refused !== 'string' || !(entry.refused in REFUSALS))
      throw new Error(`sandbox-failing.jsonl line ${index + 1} names no file, test and known refusal: ${line}`)
    return { file: entry.file, test: entry.test, refused: entry.refused as Refusal }
  })
}

export const SANDBOX_FAILING: readonly SandboxFailing[] = parseSandboxFailing(readFileSync(SANDBOX_FAILING_LIST, 'utf8'))
