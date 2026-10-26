import type { InForceDecision } from '../policy/decisions.js'
import type { DetachedLaunch } from './bg.js'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { FACTORY_WORKERS } from '../core/factory-paths.js'
import { LIVE_FLAG } from '../core/node.js'
import { SWITCH_FLAG } from '../nodes/review/review-worker.js'
import { liveDecisionOf } from '../policy/live-decision.js'
import { BUS_RUN_LAUNCH, PREFIX } from './bg.js'
import { reviewLaunch } from './review-bg.js'

export const WORKERS_FILE = 'workers.json'
export const WORKERS = ['review', 'merge', 'update', 'launch', 'restart', 'answer', 'close', 'witness'] as const

export const FACTORY_MODES = ['window', 'ghost-protocol'] as const
export const DEFAULT_MODE = 'window'

export type BusWorker = typeof WORKERS[number]
export type FactoryMode = typeof FACTORY_MODES[number]

export const MODE_WORKERS: Readonly<Record<FactoryMode, readonly BusWorker[]>> = {
  'window': ['review', 'launch', 'answer', 'witness'],
  'ghost-protocol': WORKERS,
}

export const MODE_LIVE: Readonly<Record<FactoryMode, readonly BusWorker[]>> = {
  'window': ['review', 'launch', 'answer', 'witness'],
  'ghost-protocol': [],
}

export function isFactoryMode(name: string): name is FactoryMode {
  return (FACTORY_MODES as readonly string[]).includes(name)
}

export function isBusWorker(name: string): name is BusWorker {
  return (WORKERS as readonly string[]).includes(name)
}

function queueWorkerLaunch(worker: Exclude<BusWorker, 'review'>): DetachedLaunch {
  const script = `bus:${worker}`
  return {
    prefix: PREFIX,
    script,
    args: [SWITCH_FLAG],
    markers: [`${FACTORY_WORKERS[worker]} ${SWITCH_FLAG}`, `--silent ${script} ${SWITCH_FLAG}`],
    startLock: `bus-${worker}-bg.lock`,
    log: `${worker}.log`,
  }
}

export function workerLaunches(reviewPreflight: () => string[]): Record<BusWorker, DetachedLaunch> {
  return { review: reviewLaunch(reviewPreflight), merge: queueWorkerLaunch('merge'), update: queueWorkerLaunch('update'), launch: queueWorkerLaunch('launch'), restart: queueWorkerLaunch('restart'), answer: queueWorkerLaunch('answer'), close: queueWorkerLaunch('close'), witness: queueWorkerLaunch('witness') }
}

function workersRecord(busDir: string): Record<string, unknown> | null {
  const file = path.join(busDir, WORKERS_FILE)
  if (!existsSync(file))
    return null
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  }
  catch (error) {
    throw new Error(`${file} is not JSON (${error instanceof Error ? error.message : String(error)})`)
  }
}

export function switchedOn(busDir: string): BusWorker[] {
  const record = workersRecord(busDir)
  if (record === null)
    return []
  const on = record.on
  if (!Array.isArray(on) || !on.every(name => typeof name === 'string' && isBusWorker(name)))
    throw new Error(`${path.join(busDir, WORKERS_FILE)} is not {"on": [${WORKERS.map(worker => `"${worker}"`).join(', ')}]}`)
  return WORKERS.filter(worker => on.includes(worker))
}

export function liveWorkers(busDir: string): BusWorker[] {
  const live = workersRecord(busDir)?.live ?? []
  if (!Array.isArray(live) || !live.every(name => typeof name === 'string' && isBusWorker(name)))
    throw new Error(`${path.join(busDir, WORKERS_FILE)} has a "live" that is not a list of ${WORKERS.map(worker => `"${worker}"`).join(', ')}`)
  return WORKERS.filter(worker => live.includes(worker))
}

export function termEndOf(busDir: string): string | null {
  const until = workersRecord(busDir)?.until
  return typeof until === 'string' ? until : null
}

export function modeOf(busDir: string): FactoryMode | null {
  if (workersRecord(busDir) === null)
    return null
  const on = switchedOn(busDir)
  return FACTORY_MODES.find(mode => MODE_WORKERS[mode].length === on.length && MODE_WORKERS[mode].every(worker => on.includes(worker))) ?? null
}

function writeWorkers(busDir: string, on: BusWorker[], live: BusWorker[], until: string | null = termEndOf(busDir)): void {
  mkdirSync(busDir, { recursive: true })
  writeFileSync(path.join(busDir, WORKERS_FILE), `${JSON.stringify({ on, ...(live.length === 0 ? {} : { live }), ...(until === null ? {} : { until }) })}\n`)
}

export function switchMode(busDir: string, mode: FactoryMode, until: string | null = null, seededLive: readonly BusWorker[] = []): BusWorker[] {
  const on = WORKERS.filter(worker => MODE_WORKERS[mode].includes(worker))
  const live = liveWorkers(busDir)
  writeWorkers(busDir, on, WORKERS.filter(worker => live.includes(worker) || seededLive.includes(worker)), until)
  return on
}

export function startingMode(busDir: string): FactoryMode | null {
  if (existsSync(path.join(busDir, WORKERS_FILE)))
    return null
  switchMode(busDir, DEFAULT_MODE, null, MODE_LIVE[DEFAULT_MODE])
  return DEFAULT_MODE
}

export function returnToWindowAtTermEnd(busDir: string, now: Date): boolean {
  const until = termEndOf(busDir)
  if (until === null || Date.parse(until) > now.getTime())
    return false
  switchMode(busDir, DEFAULT_MODE)
  return true
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

export function wantedLaunches(busDir: string, reviewPreflight: () => string[], decisions: readonly InForceDecision[] = [], now: Date = new Date()): DetachedLaunch[] {
  returnToWindowAtTermEnd(busDir, now)
  const launches = workerLaunches(reviewPreflight)
  const live = [...liveWorkers(busDir), ...(liveDecisionOf(decisions, 'launch') === null ? [] : ['launch' as const])]
  return [BUS_RUN_LAUNCH, ...switchedOn(busDir).map(worker => live.includes(worker) ? { ...launches[worker], args: [...launches[worker].args, LIVE_FLAG] } : launches[worker])]
}

export function busLaunches(reviewPreflight: () => string[]): DetachedLaunch[] {
  return [BUS_RUN_LAUNCH, ...Object.values(workerLaunches(reviewPreflight))]
}
