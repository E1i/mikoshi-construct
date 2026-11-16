import type { BusEvent } from './card-runs.js'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { GATE_RUN } from '../core/events.js'
import { appendBusEvent, NoBusFile } from './card-runs.js'
import { MODULE_FILES } from './layers.js'

export const GATE_SOURCES = ['gate', 'prepush'] as const
export type GateSource = typeof GATE_SOURCES[number]

export const GATE_MODES = ['layered', 'full'] as const
export type GateMode = typeof GATE_MODES[number]

const GATE_RUN_ACTOR = 'worker'
const FULL_SHA = /^[0-9a-f]{40}$/

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface GateRun {
  source: GateSource
  mode: GateMode
  reason: string
  seconds: number
  round: string | null
  card: number | null
  moduleFiles: boolean
  tests: number
}

export function sourceOf(round: string | null): GateSource {
  return round === null ? 'prepush' : 'gate'
}

export function touchesModuleFiles(touches: readonly string[]): boolean {
  return touches.includes(MODULE_FILES)
}

export function namedTests(args: readonly string[]): string[] {
  const flag = args.findIndex(arg => arg.startsWith('-'))
  return flag === -1 ? [...args] : args.slice(0, flag)
}

export function modeOfArgs(args: readonly string[] | null): GateMode {
  return args === null || namedTests(args).length > 0 ? 'layered' : 'full'
}

export function gateRunEvent(run: GateRun, ts: string): BusEvent {
  const { card, ...payload } = run
  return {
    ts,
    type: GATE_RUN,
    actor: `${GATE_RUN_ACTOR}:${run.source}:${process.pid}`,
    cardId: card,
    pr: null,
    head: run.round !== null && FULL_SHA.test(run.round) ? run.round : null,
    dedupeKey: `${GATE_RUN}:${run.source}:${run.round ?? 'none'}:${ts}`,
    payload,
    legacy: false,
  }
}

export const GATE_RUN_SPOOL = path.join('.construct', 'gate-runs.jsonl')

function spooled(spool: string): BusEvent[] {
  if (!existsSync(spool))
    return []
  return readFileSync(spool, 'utf8').split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as BusEvent)
}

function keep(spool: string, event: BusEvent): void {
  mkdirSync(path.dirname(spool), { recursive: true })
  appendFileSync(spool, `${JSON.stringify(event)}\n`)
}

export function drainGateRuns(spool: string, busPath?: string): number {
  const waiting = spooled(spool)
  for (const event of waiting)
    appendBusEvent(event, busPath)
  rmSync(spool, { force: true })
  return waiting.length
}

function drainedNote(spool: string | null, busPath: string | undefined): string {
  if (spool === null)
    return ''
  try {
    const drained = drainGateRuns(spool, busPath)
    return drained === 0 ? '' : `; ${drained} earlier run${drained === 1 ? '' : 's'} kept in ${GATE_RUN_SPOOL} recorded with it`
  }
  catch (error) {
    return `; the runs kept in ${GATE_RUN_SPOOL} stay there (${messageOf(error)})`
  }
}

export function recordGateRun(run: GateRun, ts: string, busPath?: string, spool: string | null = null): string {
  const event = gateRunEvent(run, ts)
  try {
    appendBusEvent(event, busPath)
    return `prepush: ${GATE_RUN} recorded on the bus — ${run.source}, ${run.mode}, ${run.seconds} s${drainedNote(spool, busPath)}`
  }
  catch (error) {
    if (error instanceof NoBusFile)
      return `prepush: ${GATE_RUN} not recorded, no bus is reachable from here: ${JSON.stringify(event.payload)}`
    const why = `the bus took no write (${messageOf(error)})`
    if (spool === null)
      return `prepush: ${GATE_RUN} not recorded, ${why}: ${JSON.stringify(event.payload)}`
    keep(spool, event)
    return `prepush: ${GATE_RUN} kept in ${GATE_RUN_SPOOL}, ${why}; the next run that can write the bus records it: ${JSON.stringify(event.payload)}`
  }
}
