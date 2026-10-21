import type { DetachedLaunch } from './bg.js'
import type { InForceDecision } from './decisions.js'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { BUS_RUN_LAUNCH, PREFIX } from './bg.js'
import { liveDecisionOf } from './live-decision.js'
import { LIVE_FLAG } from './node.js'
import { reviewLaunch } from './review-bg.js'
import { SWITCH_FLAG } from './review-worker.js'

export const WORKERS_FILE = 'workers.json'
export const WORKERS = ['review', 'merge', 'update', 'launch', 'restart', 'answer', 'close'] as const

export type BusWorker = typeof WORKERS[number]

export function isBusWorker(name: string): name is BusWorker {
  return (WORKERS as readonly string[]).includes(name)
}

function queueWorkerLaunch(worker: Exclude<BusWorker, 'review'>): DetachedLaunch {
  const script = `bus:${worker}`
  return {
    prefix: PREFIX,
    script,
    args: [SWITCH_FLAG],
    markers: [`scripts/bus/${worker}-worker.ts ${SWITCH_FLAG}`, `--silent ${script} ${SWITCH_FLAG}`],
    startLock: `bus-${worker}-bg.lock`,
    log: `${worker}.log`,
  }
}

export function workerLaunches(reviewPreflight: () => string[]): Record<BusWorker, DetachedLaunch> {
  return { review: reviewLaunch(reviewPreflight), merge: queueWorkerLaunch('merge'), update: queueWorkerLaunch('update'), launch: queueWorkerLaunch('launch'), restart: queueWorkerLaunch('restart'), answer: queueWorkerLaunch('answer'), close: queueWorkerLaunch('close') }
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

export function liveWorkers(busDir: string): BusWorker[] {
  const file = path.join(busDir, WORKERS_FILE)
  if (!existsSync(file))
    return []
  const live = (JSON.parse(readFileSync(file, 'utf8')) as { live?: unknown }).live ?? []
  if (!Array.isArray(live) || !live.every(name => typeof name === 'string' && isBusWorker(name)))
    throw new Error(`${file} has a "live" that is not a list of ${WORKERS.map(worker => `"${worker}"`).join(', ')}`)
  return WORKERS.filter(worker => live.includes(worker))
}

function writeWorkers(busDir: string, on: BusWorker[], live: BusWorker[]): void {
  mkdirSync(busDir, { recursive: true })
  writeFileSync(path.join(busDir, WORKERS_FILE), `${JSON.stringify(live.length === 0 ? { on } : { on, live })}\n`)
}

export function switchWorker(busDir: string, worker: BusWorker, on: boolean): BusWorker[] {
  const current = switchedOn(busDir)
  const next = WORKERS.filter(name => name === worker ? on : current.includes(name))
  writeWorkers(busDir, next, liveWorkers(busDir))
  return next
}

export function switchDetection(busDir: string, worker: BusWorker, live: boolean): BusWorker[] {
  const current = liveWorkers(busDir)
  const next = WORKERS.filter(name => name === worker ? live : current.includes(name))
  writeWorkers(busDir, switchedOn(busDir), next)
  return next
}

export function wantedLaunches(busDir: string, reviewPreflight: () => string[], decisions: readonly InForceDecision[] = []): DetachedLaunch[] {
  const launches = workerLaunches(reviewPreflight)
  const live = [...liveWorkers(busDir), ...(liveDecisionOf(decisions, 'launch') === null ? [] : ['launch' as const])]
  return [BUS_RUN_LAUNCH, ...switchedOn(busDir).map(worker => live.includes(worker) ? { ...launches[worker], args: [...launches[worker].args, LIVE_FLAG] } : launches[worker])]
}

export function busLaunches(reviewPreflight: () => string[]): DetachedLaunch[] {
  return [BUS_RUN_LAUNCH, ...Object.values(workerLaunches(reviewPreflight))]
}
