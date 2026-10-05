import type { Lore } from '../../ui/lore.js'
import type { ExpectResult } from './expect.js'
import type { CostReport, CostSource } from './source.js'
import type { StepCache } from './step-cache.js'
import type { RunStep, UnreadAgent } from './steps.js'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { VERSION } from '../../version.js'
import { defaultShiftRoot, defaultWindowJournal, readCheapClasses } from './cheap.js'
import { ClaudeCodeCostSource, claudeProjectsDir } from './claude-code.js'
import { expectFor } from './expect.js'
import { hasLedgerFindings, LEDGER_FILE, parseLedgerLine, readLedger, reconcile, summarizeLedger, withoutTokenTotals } from './ledger.js'
import { resolveRuntime } from './runtime.js'
import { knownRunSteps, readStepCache, recordRunSteps } from './step-cache.js'
import { readTurnJournal } from './turns.js'

export { cheapClass, cheapForecast, cheapForecastOf, cheapRows, defaultShiftRoot, defaultWindowJournal, readCheapClasses, readCheapTasks, sessionTokens, SHIFT_JOURNAL_FILE, WINDOW_JOURNAL_FILE } from './cheap.js'
export type { CheapClassReading, CheapForecast, CheapNote, CheapReading, CheapRow, CheapSample, CheapSession, CheapTask } from './cheap.js'
export { ClaudeCodeCostSource, claudeProjectsDir, collectWorkflowRuns, projectKey, readAgentRecord } from './claude-code.js'
export type { AgentRecord } from './claude-code.js'
export { EFFORTS, expectFor, expectLines, expectRefusal, formatContour, formatRoleExpect, formatStepExpect, formatTokens, readLedgerEntries, stepExpects } from './expect.js'
export type { ExpectHead, ExpectInput, ExpectResult, ImplementSubsample, RoleBand, SampleRow, SampleSource, StepExpect, Subsample } from './expect.js'
export { CAUSES, LEDGER_FILE, readLedger, reconcile, summarizeLedger, TOKEN_SOURCES } from './ledger.js'
export type { Cause, LedgerEntry, LedgerSummary, MalformedLedgerLine, Reconciliation, TokenCount, TokenSource } from './ledger.js'
export { COST_EXIT, COST_JSON_SCHEMA_VERSION, costJson, printCost } from './report.js'
export { resolveRuntime } from './runtime.js'
export { median, MINIMUM_SAMPLE } from './sample.js'
export type { CostReport, CostSource, CostStatus, Runtime } from './source.js'
export { readStepCache, STEP_CACHE_FILE } from './step-cache.js'
export type { StepCache } from './step-cache.js'
export { STEPS } from './steps.js'
export type { RunDecomposition, RunStep, Step, UnreadAgent } from './steps.js'
export { readTurnJournal, TURN_JOURNAL_FILE } from './turns.js'
export type { MalformedTurnLine, TurnSummary } from './turns.js'
export { tokensWithoutCacheReads, weighted } from './usage.js'
export type { AgentUsage, Usage, WorkflowRun } from './usage.js'

export function recordedSteps(cwd: string, runs: string[], source: CostSource | null): StepCache {
  return source != null && source.readable() ? recordRunSteps(cwd, runs, run => source.steps(run)) : readStepCache(cwd)
}

export function knownSteps(cwd: string, runs: string[], source: CostSource | null): StepCache {
  return source != null && source.readable() ? knownRunSteps(cwd, runs, run => source.steps(run)) : readStepCache(cwd)
}

export function costReport(cwd: string, options: { projectsDir?: string, shiftRoot?: string, windowJournal?: string, env?: NodeJS.ProcessEnv, version?: string } = {}): CostReport {
  const version = options.version ?? VERSION
  const runtime = resolveRuntime(cwd, options.env ?? process.env)
  const reading = readLedger(cwd)
  const ledger = summarizeLedger(reading)
  const reported = hasLedgerFindings(ledger)
  const turns = readTurnJournal(cwd)
  const projectsDir = options.projectsDir ?? claudeProjectsDir()
  const cheap = readCheapClasses(options.shiftRoot ?? defaultShiftRoot(), options.windowJournal ?? defaultWindowJournal(), projectsDir)
  const source: CostSource | null = runtime === 'claude-code' ? new ClaudeCodeCostSource(projectsDir) : null
  if (source == null || !source.readable())
    return { status: 'unsupported', runtime, version, turns, cheap, ...(reported ? { ledger: withoutTokenTotals(ledger) } : {}) }
  const ledgerRuns = reading.entries.map(entry => entry.run).filter(run => run != null)
  const result = source.read(cwd, ledgerRuns)
  recordedSteps(cwd, ledgerRuns, source)
  const joinable = result.status === 'ok' || result.status === 'empty'
  return {
    runtime,
    version,
    turns,
    cheap,
    ...result,
    ...(reported ? { ledger } : {}),
    ...(joinable && (reported || result.runs.length > 0) ? { reconciliation: reconcile(reading.entries, result.runs) } : {}),
  }
}

function ledgerLines(cwd: string): string[] | null {
  const file = path.join(cwd, LEDGER_FILE)
  if (!existsSync(file))
    return null
  return readFileSync(file, 'utf8').split('\n').filter(line => line.trim() !== '')
}

function runsOf(lines: string[]): string[] {
  return lines.map(parseLedgerLine).flatMap(entry => typeof entry === 'string' || entry.run === null ? [] : [entry.run])
}

function unreadWarnings(unread: UnreadAgent[], lore: Lore): string[] {
  const byRun = new Map<string, UnreadAgent[]>()
  for (const agent of unread)
    byRun.set(agent.run, [...byRun.get(agent.run) ?? [], agent])
  return [...byRun].map(([run, agents]) => lore.expectUnreadRun(run, agents.map(agent => lore.expectUnreadAgent(agent.agent, agent.reason)).join('; ')))
}

export function stepsOfRepository(root: string, runs: string[], warnings: string[], lore: Lore, source: CostSource | null): Map<string, RunStep[]> {
  const cache = knownSteps(root, runs, source)
  for (const line of cache.malformed)
    warnings.push(lore.expectStepCacheMalformed(line))
  warnings.push(...unreadWarnings(cache.unread, lore))
  return cache.runs
}

export function costExpect(cwd: string, options: { effort?: string, lore: Lore, warnings: string[] }): ExpectResult {
  const lines = ledgerLines(cwd)
  const runSteps = options.effort === undefined ? undefined : stepsOfRepository(cwd, runsOf(lines ?? []), options.warnings, options.lore, new ClaudeCodeCostSource())
  return expectFor({ ledgers: [{ source: LEDGER_FILE, lines }], effort: options.effort, runSteps }, options.lore)
}
