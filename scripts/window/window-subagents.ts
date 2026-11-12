import type { DatabaseSync } from 'node:sqlite'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { appendEvent, defaultBusPath, openBus } from '../core/db.js'
import { WINDOW_SUBAGENT_EVENT } from '../core/events.js'
import { TSX_COMMAND } from '../core/owner-commands.js'
import { agentLines, agentsFileText } from './window-agents.js'

export const WINDOW_ACTOR = 'owner'

export interface WindowSubagent {
  session: string
  role: string
  task?: string
  phase: 'started' | 'ended'
  agent?: string
  tree?: string
  step?: string
}

export function windowSubagentKey(subagent: Pick<WindowSubagent, 'session' | 'phase' | 'agent' | 'step'>): string {
  const { session, phase, agent, step } = subagent
  return agent === undefined ? `${WINDOW_SUBAGENT_EVENT}:${session}:${phase}:${step ?? ''}` : `${WINDOW_SUBAGENT_EVENT}:${session}:${agent}:${phase}`
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
    dedupeKey: windowSubagentKey(subagent),
    payload: { session, role, task: task ?? null, phase, tree: tree ?? null, step: step ?? null },
    legacy: false,
  })
}

const PHASE_OF_HOOK_EVENT: Record<string, WindowSubagent['phase']> = { start: 'started', stop: 'ended' }
const UNTYPED_AGENT = 'agent'

export interface HookSubagent {
  subagent: WindowSubagent
  at: string | null
}

export function hookSubagentsIn(root: string): HookSubagent[] {
  return agentLines(agentsFileText(root)).flatMap((line) => {
    const phase = PHASE_OF_HOOK_EVENT[line.event]
    if (phase === undefined || line.session === null || line.session === '')
      return []
    return [{ subagent: { session: line.session, role: line.type ?? UNTYPED_AGENT, phase, agent: line.id }, at: line.at }]
  })
}

const USAGE = `${TSX_COMMAND} scripts/window/window-subagents.ts --session <id> --role <role> --task <#card> --phase <started|ended> [--tree <path>] [--step <text>]`

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
