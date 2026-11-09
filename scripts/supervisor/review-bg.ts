import type { BgResult, DetachedLaunch, ProcessList } from './bg.js'
import { existsSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { busDirOf, pinBus } from '../core/bus-path.js'
import { openBus } from '../core/db.js'
import { FACTORY_WORKERS } from '../core/factory-paths.js'
import { nodeProcess } from '../core/node.js'
import { shadowReading } from '../core/report.js'
import { REVIEW_READS, SWITCH_FLAG } from '../nodes/review/review-worker.js'
import { printBg, psList, startDetached, thisBus } from './bg.js'
import { recordedWorker } from './recorded-worker.js'

export const PREFIX = '[bus:review:bg] '
export const REVIEW_SCRIPT = 'bus:review'
export const REVIEW_LOG = 'review.log'
export const REVIEW_INSTANCE_FILE = 'bus-review.pid'
export const REVIEW_START_LOCK = 'bus-review-bg.lock'
export const REVIEW_WORKER_MARKERS = [`${FACTORY_WORKERS.review} ${SWITCH_FLAG}`, `--silent ${REVIEW_SCRIPT} ${SWITCH_FLAG}`] as const

export function busShadowProblems(busPath: string): string[] {
  if (!existsSync(busPath))
    return [`there is no bus.db at ${busPath}; the shadow has not run there`]
  const db = openBus(busPath)
  try {
    return shadowReading(db, REVIEW_READS).problems
  }
  catch (error) {
    return [`the shadow report could not be read: ${error instanceof Error ? error.message : String(error)}`]
  }
  finally {
    db.close()
  }
}

export function startReviewWorker(launch: DetachedLaunch, busDir: string, env: NodeJS.ProcessEnv, processes: ProcessList): BgResult {
  const held = launch.instanceFile === REVIEW_INSTANCE_FILE
    ? recordedWorker({ file: path.join(busDir, REVIEW_INSTANCE_FILE), node: nodeProcess('review'), markers: REVIEW_WORKER_MARKERS, bus: thisBus(env) }, processes)
    : undefined
  if (held !== undefined)
    return { stdout: [], stderr: [`${launch.prefix}${launch.script} is already running as pid ${held.pid} (${held.args}); nothing started`], exitCode: 1, alreadyRunning: held }
  return startDetached(launch, busDir, env, processes)
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
  const busPath = pinBus(process.env, os.homedir(), process.cwd())
  const preflight = (): string[] => busShadowProblems(busPath)
  printBg(startReviewWorker(reviewLaunch(preflight), busDirOf(busPath), process.env, psList()))
}
