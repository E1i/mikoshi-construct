import type { RoleStop, THRESHOLDS, WindowEnd } from '../nodes/restart/role.js'
import type { ProcessTable } from '../ports/process-table.js'
import type { ExitLine, ExitReadings, Reading } from './eddies-measure.js'
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { defaultBusPath } from '../core/db.js'
import { FACTORY_RUNTIME } from '../core/factory-paths.js'
import { defaultHandoffDir } from '../core/handoff-dir.js'
import { statusOfFile } from '../core/handoff-status.js'
import { HANDOFF_WRITE_COMMAND, MIKO_COMMAND, MIKO_WATCH_COMMAND } from '../core/owner-commands.js'
import { RAISED_STATUS, raisedByTheBus } from '../nodes/restart/role.js'
import { ownerMessagesOf } from '../ports/client/claude/adapter.js'
import { clientAdapter } from '../ports/client/index.js'
import { OsProcessTable, rowsOf } from '../ports/process-table.js'
import { EXIT_REQUEST_VARIABLE, LOOP_PID_VARIABLE } from '../ports/session.js'
import { appendExitLine, EDDIES_JOURNAL_FILE, exitLineOf, PROJECT_VARIABLE, projectRoot, realExitReadings, SESSION_EXIT_EVENT, UNKNOWN } from './eddies-measure.js'
import { MIKO_HANDOFF_NAME, mikoHandoff, PREFIX } from './loop.js'
import { realRoleStopObserver } from './role-bus.js'
import { windowEndObserver } from './role-end.js'
import { tabWindowOf } from './tab.js'
import { dirtyOpenCardTrees, liveAgentsOf, sessionTranscriptOf, stoppedTasksIn } from './window-agents.js'
import { SESSION_VARIABLE } from './window-requests.js'

export { ownerMessagesOf }

export const FRESH_MS = 2 * 60 * 1000
export const LOOP_SCRIPT = path.normalize(FACTORY_RUNTIME.mikoLoopEntry)
export const BUILT_LOOP_SCRIPT = LOOP_SCRIPT.replace(/\.ts$/, '.js')
export const NOT_AT_A_STOP_CONDITION = `not at a stop condition: wait with ${MIKO_WATCH_COMMAND} --once --card <N> or take the next card`
export const TAB_THRESHOLD = 'in a tab window a threshold ends no session: continue in this session; compaction carries it on from the handoff (PreCompact insures it, SessionStart compact returns the continue prompt); nothing ended'
export const SANDBOX_REFUSAL = `outside the ${MIKO_COMMAND} loop the sandbox lets this command neither find nor signal any process: nothing ended; run the session under ${MIKO_COMMAND}`
const MESSAGES_BEFORE_THE_OWNER_SPOKE = 1

export type StopReason = typeof THRESHOLDS[number] | 'done' | 'core'

export interface ProcessRow {
  pid: number
  ppid: number
  args: string
}

export interface MikoExitDeps {
  pid: number
  table: () => ProcessRow[]
  handoffMtime: () => number | undefined
  now: () => number
  kill: (pid: number) => void
  loopRequest?: string
  requestEnd?: (request: string) => void
  err: (line: string) => void
  readings: () => ExitReadings
  recordExit: (line: ExitLine) => void
  handoff?: string
  status?: () => string | null
  raised?: boolean
  observeStop?: (stop: RoleStop) => void
  endWindow?: (end: WindowEnd) => void
  tab?: boolean
  liveAgents?: () => string[]
  dirtyTrees?: () => string[]
  ownerMessages?: () => number | null
}

function ownerMessagesIn(transcript: string | null): number | null {
  if (transcript === null)
    return null
  try {
    return ownerMessagesOf(readFileSync(transcript, 'utf8'))
  }
  catch {
    return null
  }
}

export function doneWaitsForTheOwner(): string {
  return `${MIKO_HANDOFF_NAME} says STATUS: DONE and the owner has not written in this session yet: wait for the owner's first message here and take its task, or end when the owner says so; nothing ended`
}

function atTheStop(reason: StopReason, readings: ExitReadings): string {
  return reason === 'core' ? `at a core change: main carries window-core v${readings.coreOnMain}, this session loaded v${readings.coreLoaded}` : `at the ${reason} limit`
}

function ownerHasNotSpoken(deps: MikoExitDeps): boolean {
  const messages = deps.ownerMessages?.() ?? null
  return messages !== null && messages <= MESSAGES_BEFORE_THE_OWNER_SPOKE
}

export function chainRowsOf(table: ProcessTable): ProcessRow[] {
  return rowsOf(table.snapshot()).map(row => ({ pid: row.pid, ppid: row.ppid, args: row.command }))
}

export function ancestors(table: ProcessRow[], pid: number): ProcessRow[] {
  const byPid = new Map(table.map(row => [row.pid, row]))
  const chain: ProcessRow[] = []
  const seen = new Set<number>()
  let row = byPid.get(pid)
  while (row !== undefined && !seen.has(row.pid)) {
    seen.add(row.pid)
    chain.push(row)
    row = byPid.get(row.ppid)
  }
  return chain.slice(1)
}

function isClaude(row: ProcessRow): boolean {
  return clientAdapter().processes.isClient(row.args)
}

export function sessionClaudeOf(table: () => ProcessRow[], pid: number): number | undefined {
  try {
    return ancestors(table(), pid).find(isClaude)?.pid
  }
  catch {
    return undefined
  }
}

export function isMikoLoop(row: ProcessRow): boolean {
  return row.args.includes(LOOP_SCRIPT) || row.args.includes(BUILT_LOOP_SCRIPT)
}

function atOrAbove(value: Reading<number>, limit: Reading<number>): boolean {
  return value !== UNKNOWN && limit !== UNKNOWN && value >= limit
}

function loadedCoreBelowMain(readings: ExitReadings): boolean {
  return readings.coreLoaded !== UNKNOWN && readings.coreOnMain !== UNKNOWN && readings.coreLoaded < readings.coreOnMain
}

export function stopReasonOf(status: string | null, readings: ExitReadings): StopReason | null {
  if (status === 'DONE')
    return 'done'
  if (readings.context === UNKNOWN || atOrAbove(readings.context, readings.contextWarn) || readings.budgetWarned === true)
    return 'context'
  if (atOrAbove(readings.spent, readings.spendWarn))
    return 'spend'
  if (loadedCoreBelowMain(readings))
    return 'core'
  return null
}

function budgetWarnFinding(budgetWarned: Reading<boolean>): string {
  if (budgetWarned === UNKNOWN)
    return UNKNOWN
  return budgetWarned ? 'found' : 'not found'
}

export function notAtAStopRefusal(readings: ExitReadings): string {
  return `${NOT_AT_A_STOP_CONDITION}; read context ${readings.context} (${readings.contextSource}), line ${readings.contextWarn} (${readings.contextWarnSource}), budget-warn of this session ${budgetWarnFinding(readings.budgetWarned)} (${EDDIES_JOURNAL_FILE}); nothing ended`
}

export type ExitDecision = { kill: number | null, line: string, reason: StopReason, stopped?: true } | { refuse: string }

function freshHandoff(handoffMtime: number | undefined, now: number): boolean {
  return handoffMtime !== undefined && now - handoffMtime <= FRESH_MS
}

function missingHandoffRefusal(): string {
  return `${MIKO_HANDOFF_NAME} does not exist: write it with ${HANDOFF_WRITE_COMMAND} first; nothing ended`
}

function missingHandoffDecision(handoffMtime: number | undefined, status: string | null): ExitDecision | null {
  return handoffMtime === undefined && status !== 'DONE' ? { refuse: missingHandoffRefusal() } : null
}

function staleHandoffRefusal(handoffMtime: number | undefined, now: number): string | null {
  if (handoffMtime === undefined)
    return missingHandoffRefusal()
  const age = now - handoffMtime
  return age > FRESH_MS ? `${MIKO_HANDOFF_NAME} was written ${Math.round(age / 1000)}s ago, more than ${FRESH_MS / 1000}s: write it with ${HANDOFF_WRITE_COMMAND} first; nothing ended` : null
}

export function loopExitDecision(handoffMtime: number | undefined, now: number, status: string | null, readings: ExitReadings): ExitDecision {
  const reason = stopReasonOf(status, readings)
  if (reason === null)
    return { refuse: notAtAStopRefusal(readings) }
  if (reason === 'done')
    return { kill: null, reason, line: `the loop ends the session: ${MIKO_HANDOFF_NAME} says STATUS: ${status}` }
  const stale = staleHandoffRefusal(handoffMtime, now)
  if (stale !== null)
    return { refuse: stale }
  return { kill: null, reason, line: `the loop ends the session ${atTheStop(reason, readings)}: the ${MIKO_COMMAND} loop starts the next session` }
}

export function tabThresholdDecision(handoffMtime: number | undefined, now: number, status: string | null, readings: ExitReadings): ExitDecision | null {
  const reason = stopReasonOf(status, readings)
  if (reason === null || reason === 'done')
    return null
  return { refuse: staleHandoffRefusal(handoffMtime, now) ?? TAB_THRESHOLD }
}

export function isPermissionDenied(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'EPERM' || /EPERM|not permitted/i.test(error instanceof Error ? error.message : String(error))
}

function chainOf(deps: MikoExitDeps): ProcessRow[] | null {
  try {
    return ancestors(deps.table(), deps.pid)
  }
  catch (error) {
    if (isPermissionDenied(error))
      return null
    throw error
  }
}

function decisionOf(deps: MikoExitDeps, status: string | null, readings: ExitReadings): ExitDecision {
  if (deps.loopRequest !== undefined)
    return loopExitDecision(deps.handoffMtime(), deps.now(), status, readings)
  const tab = deps.tab === true ? tabThresholdDecision(deps.handoffMtime(), deps.now(), status, readings) : null
  if (tab !== null)
    return tab
  const missing = missingHandoffDecision(deps.handoffMtime(), status)
  if (missing !== null)
    return missing
  const chain = chainOf(deps)
  return chain === null ? { refuse: SANDBOX_REFUSAL } : exitDecision(chain, deps.handoffMtime(), deps.now(), status, readings)
}

export function exitDecision(chain: ProcessRow[], handoffMtime: number | undefined, now: number, status: string | null, readings: ExitReadings): ExitDecision {
  const at = chain.findIndex(isClaude)
  if (at === -1)
    return { refuse: 'no claude process among the ancestors of this command: nothing to end' }
  const claude = chain[at]!
  const reason = stopReasonOf(status, readings)
  if (reason === null)
    return { refuse: notAtAStopRefusal(readings) }
  if (reason === 'done')
    return { kill: claude.pid, reason, line: `ending claude ${claude.pid}: ${MIKO_HANDOFF_NAME} says STATUS: ${status}` }
  const above = chain.slice(at + 1)
  const nextClaude = above.findIndex(isClaude)
  const underLoop = (nextClaude === -1 ? above : above.slice(0, nextClaude)).some(isMikoLoop)
  if (!underLoop && reason !== 'core' && status === RAISED_STATUS && freshHandoff(handoffMtime, now))
    return { kill: claude.pid, reason, line: `ending claude ${claude.pid} at the ${reason} limit: no ${MIKO_COMMAND} loop stands above it, so role.stopped goes to the bus for the restart queue`, stopped: true }
  if (!underLoop)
    return { refuse: `claude ${claude.pid} does not run under the ${MIKO_COMMAND} loop (${LOOP_SCRIPT}): nothing ended` }
  const stale = staleHandoffRefusal(handoffMtime, now)
  if (stale !== null)
    return { refuse: stale }
  return { kill: claude.pid, reason, line: `ending claude ${claude.pid} ${atTheStop(reason, readings)}: the ${MIKO_COMMAND} loop starts the next session` }
}

function unfinishedWork(deps: MikoExitDeps): string | null {
  const agents = deps.liveAgents?.() ?? []
  if (agents.length > 0)
    return `subagents still running: ${agents.join(', ')}: wait for them and write their results into the handoff`
  const trees = deps.dirtyTrees?.() ?? []
  return trees.length > 0 ? `uncommitted changes in: ${trees.join(', ')}: commit or hand them off first` : null
}

export function runMikoExit(deps: MikoExitDeps): number {
  const readings = deps.readings()
  const status = deps.status?.() ?? null
  const decision = decisionOf(deps, status, readings)
  if ('refuse' in decision) {
    deps.err(`${PREFIX}${decision.refuse}`)
    return 1
  }
  if (decision.reason === 'done' && ownerHasNotSpoken(deps)) {
    deps.err(`${PREFIX}${doneWaitsForTheOwner()}`)
    return 1
  }
  const unfinished = unfinishedWork(deps)
  if (unfinished !== null) {
    deps.err(`${PREFIX}${unfinished}; nothing ended`)
    return 1
  }
  if (decision.stopped === true) {
    deps.endWindow?.('eddies')
    deps.observeStop?.({ role: 'miko', handoff: deps.handoff ?? '', status: RAISED_STATUS, reason: decision.reason, raised: deps.raised ?? false })
  }
  else if (decision.reason === 'done') {
    deps.endWindow?.('miko:exit')
  }
  try {
    deps.recordExit(exitLineOf(readings, decision.reason, new Date(deps.now()).toISOString()))
  }
  catch (error) {
    deps.err(`${PREFIX}the ${SESSION_EXIT_EVENT} line was not written (${error instanceof Error ? error.message : String(error)})`)
  }
  deps.err(`${PREFIX}${decision.line}`)
  try {
    if (decision.kill === null)
      deps.requestEnd?.(deps.loopRequest!)
    else
      deps.kill(decision.kill)
  }
  catch (error) {
    if (!isPermissionDenied(error))
      throw error
    deps.err(`${PREFIX}${SANDBOX_REFUSAL}`)
    return 1
  }
  return 0
}

export function loopRequestOf(env: NodeJS.ProcessEnv): string | undefined {
  return env[LOOP_PID_VARIABLE] === undefined ? undefined : env[EXIT_REQUEST_VARIABLE]
}

function mtimeOf(file: string): number | undefined {
  try {
    return statSync(file).mtimeMs
  }
  catch {
    return undefined
  }
}

export function exitRootOf(env: NodeJS.ProcessEnv, cwd: string): string {
  return projectRoot({ [PROJECT_VARIABLE]: env[PROJECT_VARIABLE] || cwd })
}

export function realMikoExitDeps(handoff: string): MikoExitDeps {
  const root = exitRootOf(process.env, process.cwd())
  const transcript = (): string | null => sessionTranscriptOf(os.homedir(), process.env[SESSION_VARIABLE])
  const table = (): ProcessRow[] => chainRowsOf(new OsProcessTable())
  return {
    pid: process.pid,
    table,
    handoffMtime: () => mtimeOf(handoff),
    now: () => Date.now(),
    kill: pid => process.kill(pid, 'SIGTERM'),
    loopRequest: loopRequestOf(process.env),
    requestEnd: (request) => {
      mkdirSync(path.dirname(request), { recursive: true })
      writeFileSync(request, `${sessionClaudeOf(table, process.pid) ?? ''}\n`)
    },
    err: line => console.error(line),
    readings: () => realExitReadings(process.env, os.homedir(), root, defaultBusPath()),
    recordExit: line => appendExitLine(root, line),
    handoff,
    status: () => statusOfFile(handoff) ?? null,
    raised: raisedByTheBus(process.env),
    observeStop: realRoleStopObserver(line => console.error(`${PREFIX}${line}`)),
    endWindow: windowEndObserver({ busPath: defaultBusPath(), pid: process.pid, now: () => new Date(), err: line => console.error(`${PREFIX}${line}`) }),
    tab: tabWindowOf(process.env) !== null,
    liveAgents: () => liveAgentsOf(root, process.env, stoppedTasksIn(transcript())),
    dirtyTrees: () => dirtyOpenCardTrees(process.env, defaultBusPath()),
    ownerMessages: () => ownerMessagesIn(transcript()),
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = runMikoExit(realMikoExitDeps(mikoHandoff(defaultHandoffDir())))
