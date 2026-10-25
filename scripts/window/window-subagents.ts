import type { DatabaseSync } from 'node:sqlite'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { appendEvent, defaultBusPath, openBus } from '../core/db.js'
import { WINDOW_SUBAGENT_EVENT } from '../core/events.js'

export const WINDOW_ACTOR = 'owner'

export interface WindowSubagent {
  session: string
  role: string
  task: string
  phase: 'started' | 'ended'
  tree?: string
  step?: string
}

export function recordWindowSubagent(db: DatabaseSync, subagent: WindowSubagent, at: Date): boolean {
  const { session, role, task, phase, tree, step } = subagent
  return appendEvent(db, {
    ts: at.toISOString(),
    type: WINDOW_SUBAGENT_EVENT,
    actor: WINDOW_ACTOR,
    cardId: null,
    pr: null,
    head: null,
    dedupeKey: `${WINDOW_SUBAGENT_EVENT}:${session}:${phase}:${step ?? ''}`,
    payload: { session, role, task, phase, tree: tree ?? null, step: step ?? null },
    legacy: false,
  })
}

const USAGE = 'pnpm exec tsx scripts/window/window-subagents.ts --session <id> --role <role> --task <#card> --phase <started|ended> [--tree <path>] [--step <text>]'

export type WindowSubagentCall
  = | { kind: 'record', subagent: WindowSubagent }
    | { kind: 'refused', reason: string }

export function windowSubagentCall(argv: string[]): WindowSubagentCall {
  let values: Record<string, string | undefined>
  try {
    values = parseArgs({ args: argv, options: { session: { type: 'string' }, role: { type: 'string' }, task: { type: 'string' }, phase: { type: 'string' }, tree: { type: 'string' }, step: { type: 'string' } } }).values
  }
  catch (error) {
    return { kind: 'refused', reason: `${error instanceof Error ? error.message : String(error)}; ${USAGE}` }
  }
  const { session, role, task, phase, tree, step } = values
  if (session === undefined || role === undefined || task === undefined)
    return { kind: 'refused', reason: `--session, --role and --task are required; ${USAGE}` }
  if (phase !== 'started' && phase !== 'ended')
    return { kind: 'refused', reason: `--phase is started or ended; ${USAGE}` }
  return { kind: 'record', subagent: { session, role, task, phase, tree, step } }
}

export function runWindowSubagent(argv: string[], busPath: string, now: () => Date): number {
  const call = windowSubagentCall(argv)
  if (call.kind === 'refused') {
    console.error(call.reason)
    return 1
  }
  const db = openBus(busPath)
  try {
    recordWindowSubagent(db, call.subagent, now())
    return 0
  }
  finally {
    db.close()
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = runWindowSubagent(process.argv.slice(2), defaultBusPath(), () => new Date())
