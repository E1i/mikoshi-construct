import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { isFullSha, prOf } from '../../core/identifiers.js'

export interface DryRunRecord {
  pr: number
  head: string
}

const SESSION_NAME = /^[\w-]+$/
const DRY_RUN_REVIEWS = 'dry-run-reviews'

export function dryRunReviewsDir(busDir: string): string {
  return path.join(busDir, DRY_RUN_REVIEWS)
}

function recordPath(dir: string, session: string): string | null {
  return SESSION_NAME.test(session) ? path.join(dir, `${session}.dry-run.json`) : null
}

export function keepDryRun(dir: string): (session: string, record: DryRunRecord) => void {
  return (session, record) => {
    const file = recordPath(dir, session)
    if (file !== null)
      writeFileSync(file, `${JSON.stringify(record)}\n`)
  }
}

export function dryRunIn(dir: string): (session: string) => DryRunRecord | null {
  return (session) => {
    const file = recordPath(dir, session)
    if (file === null || !existsSync(file))
      return null
    const kept = JSON.parse(readFileSync(file, 'utf8')) as { pr?: unknown, head?: unknown }
    const pr = prOf(kept.pr)
    return pr === null || !isFullSha(kept.head) ? null : { pr, head: kept.head }
  }
}
