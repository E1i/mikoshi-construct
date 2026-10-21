import type { BgResult, DetachedLaunch, ProcessList, RunningProcess } from './bg.js'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { alive, printBg, psList, startDetached } from './bg.js'
import { defaultBusPath, openBus } from './db.js'
import { shadowReading } from './report.js'
import { REVIEW_READS, SWITCH_FLAG } from './review-worker.js'

export const PREFIX = '[bus:review:bg] '
export const REVIEW_SCRIPT = 'bus:review'
export const REVIEW_LOG = 'review.log'
export const REVIEW_INSTANCE_FILE = 'bus-review.pid'
export const REVIEW_START_LOCK = 'bus-review-bg.lock'
export const REVIEW_WORKER_MARKERS = [`scripts/bus/review-worker.ts ${SWITCH_FLAG}`, `--silent ${REVIEW_SCRIPT} ${SWITCH_FLAG}`] as const

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

function recordedWorker(busDir: string, processes: ProcessList): RunningProcess | undefined {
  const file = path.join(busDir, REVIEW_INSTANCE_FILE)
  if (!existsSync(file))
    return undefined
  const pid = Number(readFileSync(file, 'utf8').trim())
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || !alive(pid))
    return undefined
  const listed = processes().find(candidate => candidate.pid === pid)
  if (listed === undefined)
    return { pid, args: `recorded in ${file}` }
  return REVIEW_WORKER_MARKERS.some(marker => listed.args.includes(marker)) ? listed : undefined
}

export function startReviewWorker(launch: DetachedLaunch, busDir: string, env: NodeJS.ProcessEnv, processes: ProcessList): BgResult {
  const held = launch.instanceFile === REVIEW_INSTANCE_FILE ? recordedWorker(busDir, processes) : undefined
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
  const preflight = (): string[] => busShadowProblems(defaultBusPath())
  printBg(startReviewWorker(reviewLaunch(preflight), path.join(os.homedir(), '.construct', 'bus'), process.env, psList()))
}
