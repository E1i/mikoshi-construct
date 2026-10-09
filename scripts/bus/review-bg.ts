import type { DetachedLaunch } from './bg.js'
import type { GitHub } from './github.js'
import { realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { printBg, startDetached } from './bg.js'
import { defaultBusPath, openBus } from './db.js'
import { ghApi } from './github.js'
import { shadowProblems } from './report.js'
import { SWITCH_FLAG } from './review-worker.js'

export const PREFIX = '[bus:review:bg] '
export const REVIEW_SCRIPT = 'bus:review'
export const REVIEW_LOG = 'review.log'
export const REVIEW_INSTANCE_FILE = 'bus-review.pid'
export const REVIEW_START_LOCK = 'bus-review-bg.lock'
export const REVIEW_WORKER_MARKERS = ['scripts/bus/review-worker.ts', `--silent ${REVIEW_SCRIPT} ${SWITCH_FLAG}`] as const

export function busShadowProblems(busPath: string, gitHub: GitHub): string[] {
  const db = openBus(busPath)
  try {
    return shadowProblems(db, gitHub, () => Date.now())
  }
  finally {
    db.close()
  }
}

export function reviewLaunch(preflight: () => string[]): DetachedLaunch {
  return {
    prefix: PREFIX,
    script: REVIEW_SCRIPT,
    args: [SWITCH_FLAG],
    markers: REVIEW_WORKER_MARKERS,
    instanceFile: REVIEW_INSTANCE_FILE,
    startLock: REVIEW_START_LOCK,
    log: REVIEW_LOG,
    preflight,
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const preflight = (): string[] => busShadowProblems(defaultBusPath(), ghApi(process.cwd()))
  printBg(startDetached(reviewLaunch(preflight), path.join(os.homedir(), '.construct', 'bus')))
}
