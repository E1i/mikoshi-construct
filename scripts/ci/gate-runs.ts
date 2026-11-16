import type { BusEvent } from './card-runs.js'
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

export function recordGateRun(run: GateRun, ts: string, busPath?: string): string {
  const event = gateRunEvent(run, ts)
  try {
    appendBusEvent(event, busPath)
    return `prepush: ${GATE_RUN} recorded on the bus — ${run.source}, ${run.mode}, ${run.seconds} s`
  }
  catch (error) {
    const why = error instanceof NoBusFile ? 'no bus is reachable from here' : `the bus took no write (${messageOf(error)})`
    return `prepush: ${GATE_RUN} not recorded, ${why}: ${JSON.stringify(event.payload)}`
  }
}
