import type { DetachedLaunch } from './bg.js'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { BUS_RUN_LAUNCH, PREFIX } from './bg.js'
import { reviewLaunch } from './review-bg.js'
import { SWITCH_FLAG } from './review-worker.js'

export const WORKERS_FILE = 'workers.json'
export const WORKERS = ['review', 'merge', 'update'] as const

export type BusWorker = typeof WORKERS[number]

export function isBusWorker(name: string): name is BusWorker {
  return (WORKERS as readonly string[]).includes(name)
}

function queueWorkerLaunch(worker: 'merge' | 'update'): DetachedLaunch {
  const script = `bus:${worker}`
  return {
    prefix: PREFIX,
    script,
    args: [SWITCH_FLAG],
    markers: [`scripts/bus/${worker}-worker.ts ${SWITCH_FLAG}`, `--silent ${script} ${SWITCH_FLAG}`],
    instanceFile: `bus-${worker}.pid`,
    startLock: `bus-${worker}-bg.lock`,
    log: `${worker}.log`,
  }
}

export function workerLaunches(reviewPreflight: () => string[]): Record<BusWorker, DetachedLaunch> {
  return { review: reviewLaunch(reviewPreflight), merge: queueWorkerLaunch('merge'), update: queueWorkerLaunch('update') }
}

export function switchedOn(busDir: string): BusWorker[] {
  const file = path.join(busDir, WORKERS_FILE)
  if (!existsSync(file))
    return []
  const on = (JSON.parse(readFileSync(file, 'utf8')) as { on?: unknown }).on
  if (!Array.isArray(on) || !on.every(name => typeof name === 'string' && isBusWorker(name)))
    throw new Error(`${file} is not {"on": [${WORKERS.map(worker => `"${worker}"`).join(', ')}]}`)
  return WORKERS.filter(worker => on.includes(worker))
}

export function switchWorker(busDir: string, worker: BusWorker, on: boolean): BusWorker[] {
  const current = switchedOn(busDir)
  const next = WORKERS.filter(name => name === worker ? on : current.includes(name))
  mkdirSync(busDir, { recursive: true })
  writeFileSync(path.join(busDir, WORKERS_FILE), `${JSON.stringify({ on: next })}\n`)
  return next
}

export function wantedLaunches(busDir: string, reviewPreflight: () => string[]): DetachedLaunch[] {
  const launches = workerLaunches(reviewPreflight)
  return [BUS_RUN_LAUNCH, ...switchedOn(busDir).map(worker => launches[worker])]
}

export function busLaunches(reviewPreflight: () => string[]): DetachedLaunch[] {
  return [BUS_RUN_LAUNCH, ...Object.values(workerLaunches(reviewPreflight))]
}
