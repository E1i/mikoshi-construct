import type { DatabaseSync } from 'node:sqlite'
import type { BusEvent } from '../../core/db.js'
import type { AfterFailure, Lease } from '../../core/lease.js'
import type { VERIFICATION_WORDS } from '../../core/verification.js'
import type { WitnessSubject, WitnessVerdict } from '../../policy/policy.js'
import type { Shell, ShellResult } from '../../ports/worktree.js'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { stripVTControlCharacters } from 'node:util'
import { CARD_CLOSED, WITNESS_RECORDED } from '../../core/events.js'
import { isFullSha } from '../../core/identifiers.js'
import { assertHeld, completeTask, failTask, RENEW_MS, StaleLease } from '../../core/lease.js'
import { baseOfKey, LEASE_MS } from '../../core/queue.js'
import { GREEN, RED, witnessSubjectOf } from '../../policy/policy.js'
import { execGh, stdoutOrThrow } from '../../ports/gh.js'
import { witnessEnv } from '../../ports/session.js'
import { runOnTree } from '../../ports/witnesses.js'
import { gitIn, withWorktree } from '../../ports/worktree.js'

export const WITNESS_UNRUN = 'witness_unrun'
export const WITNESS_BUDGET_MS = LEASE_MS - RENEW_MS
const SHELL_BUFFER = 1 << 28
const LOCKFILE = 'pnpm-lock.yaml'
const INSTALL = 'pnpm install --frozen-lockfile'
const VERIFIED_BY_RUNNING_WITNESSES: typeof VERIFICATION_WORDS[number] = 'run'

export interface TimedShellResult extends ShellResult { timedOut: boolean }
export type TimedShell = (command: string, cwd: string, timeoutMs: number) => TimedShellResult

const GROUP_KILL_GRACE_MS = 10_000
const GROUP_RUNNER = [
  `const { spawn } = require('node:child_process')`,
  `const { constants } = require('node:os')`,
  `const [budget, command] = process.argv.slice(1)`,
  `const child = spawn('bash', ['-c', command], { detached: true, stdio: 'inherit' })`,
  `const timer = setTimeout(() => {`,
  `  try { process.kill(-child.pid, 'SIGKILL') } catch {}`,
  `  process.kill(process.pid, 'SIGKILL')`,
  `}, Number(budget))`,
  `child.on('error', () => process.exit(127))`,
  `child.on('exit', (code, signal) => {`,
  `  clearTimeout(timer)`,
  `  process.exit(code ?? 128 + (constants.signals[signal] ?? 0))`,
  `})`,
].join('\n')

export function realTimedShell(command: string, cwd: string, timeoutMs: number): TimedShellResult {
  const budget = String(Math.max(1, Math.floor(timeoutMs)))
  const result = spawnSync(process.execPath, ['-e', GROUP_RUNNER, budget, command], { cwd, env: witnessEnv(), encoding: 'utf8', maxBuffer: SHELL_BUFFER, timeout: timeoutMs + GROUP_KILL_GRACE_MS, killSignal: 'SIGKILL' })
  const timedOut = result.signal === 'SIGKILL' || (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT'
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}`, timedOut }
}

export interface WitnessTrees {
  baseOf: (pr: number, head: string) => string
  withTree: <T>(base: string, run: (tree: string) => T) => T
}

export interface WitnessParts {
  db: DatabaseSync
  clock: () => Date
  trees: WitnessTrees
  shell: TimedShell
  log: (line: string) => void
}

export type WitnessOutcome
  = | { kind: 'recorded', taskKey: string, verdict: WitnessVerdict, base: string, detail: string }
    | { kind: 'skipped', taskKey: string, why: string }
    | { kind: 'denied', taskKey: string, denial: { kind: 'technical', reason: string, detail: string }, next: AfterFailure }
    | { kind: 'fenced', taskKey: string }

class WitnessRed extends Error {
  constructor(readonly step: string, readonly problem: string) {
    super(`${step}: ${problem}`)
  }
}

class WitnessTimedOut extends Error {
  constructor(command: string) {
    super(`a witness command ran past the budget of ${WITNESS_BUDGET_MS} ms: ${command}`)
  }
}

export const EXCERPT_LINES = 20
export const EXCERPT_CHARS = 2000
const FAILURE_LINE = /^\s*(?:FAIL|[×✗✘])|\b\w*Error\b/

export function failureExcerpt(output: string): string {
  const lines = stripVTControlCharacters(output).split('\n').filter(line => FAILURE_LINE.test(line))
  return lines.slice(0, EXCERPT_LINES).map(line => line.trimEnd()).join('\n').slice(0, EXCERPT_CHARS)
}

function withFailureExcerpt(message: string, result: ShellResult | null): string {
  if (result === null || result.status === 0)
    return message
  const excerpt = failureExcerpt(result.output)
  return excerpt === '' ? message : `${message}\n${excerpt}`
}

export function gitWitnessTrees(repo: string): WitnessTrees {
  return {
    baseOf: (pr) => {
      gitIn(repo, ['fetch', '-q', 'origin', 'main', `pull/${pr}/head`])
      const base = stdoutOrThrow(execGh)(['api', `repos/{owner}/{repo}/pulls/${pr}`, '--jq', '.base.sha']).trim()
      if (!isFullSha(base))
        throw new Error(`GitHub named no base sha for #${pr}`)
      return base
    },
    withTree: (base, run) => withWorktree(repo, base, run),
  }
}

export class WitnessExecutor {
  constructor(private readonly parts: WitnessParts) {}

  private ts(): string {
    return this.parts.clock().toISOString()
  }

  run(lease: Lease): WitnessOutcome {
    try {
      assertHeld(this.parts.db, lease)
      const subject = witnessSubjectOf(this.parts.db, lease.cardId)
      if (subject !== null && lease.pr === null && lease.head !== null && isFullSha(lease.head))
        return this.onMain(lease, subject, lease.head)
      if (subject === null || lease.pr === null || lease.head === null) {
        completeTask(this.parts.db, this.ts(), lease, [])
        return { kind: 'skipped', taskKey: lease.taskKey, why: `card #${lease.cardId} declares no witness with a command, or the task names no pull request head` }
      }
      let base: string
      try {
        const current = this.parts.trees.baseOf(lease.pr, lease.head)
        base = baseOfKey(lease.taskKey) ?? current
      }
      catch (error) {
        return this.unrun(lease, `the base of ${lease.head} could not be read: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
      }
      let red: string | null
      try {
        red = this.redOf(subject, base, lease.head)
      }
      catch (error) {
        if (error instanceof WitnessTimedOut)
          return this.unrun(lease, error.message)
        throw error
      }
      const verdict = red === null ? GREEN : RED
      const detail = red ?? `every card witness red on the base ${base} and green on ${lease.head}`
      completeTask(this.parts.db, this.ts(), lease, [this.recorded(lease, subject, base, verdict, detail)])
      return { kind: 'recorded', taskKey: lease.taskKey, verdict, base, detail }
    }
    catch (error) {
      if (error instanceof StaleLease)
        return { kind: 'fenced', taskKey: lease.taskKey }
      throw error
    }
  }

  private onMain(lease: Lease, subject: WitnessSubject, main: string): WitnessOutcome {
    let red: string | null
    try {
      red = this.redOnMain(subject, main)
    }
    catch (error) {
      if (error instanceof WitnessTimedOut)
        return this.unrun(lease, error.message)
      throw error
    }
    const verdict = red === null ? GREEN : RED
    const detail = red ?? `every card witness green on main at ${main}`
    const closing = red === null ? [this.closedOnMain(lease, main)] : []
    completeTask(this.parts.db, this.ts(), lease, [this.recorded(lease, subject, main, verdict, detail), ...closing])
    return { kind: 'recorded', taskKey: lease.taskKey, verdict, base: main, detail }
  }

  private redOnMain(subject: WitnessSubject, main: string): string | null {
    const last: { result: ShellResult | null } = { result: null }
    const shell = this.budgeted(this.parts.clock().getTime() + WITNESS_BUDGET_MS, last)
    return this.parts.trees.withTree(main, (tree) => {
      if (existsSync(path.join(tree, LOCKFILE)) && shell(INSTALL, tree).status !== 0)
        return withFailureExcerpt(`${INSTALL} failed on main at ${main}`, last.result)
      const red = [...subject.acceptance, ...subject.invariants].find(witness => shell(witness.command, tree).status !== 0)
      return red === undefined ? null : withFailureExcerpt(`on main: "${red.criterion}" exits ${last.result?.status ?? 'without a status'} at ${main}`, last.result)
    })
  }

  private closedOnMain(lease: Lease, main: string): BusEvent {
    return { ts: this.ts(), type: CARD_CLOSED, actor: lease.actor, cardId: lease.cardId, pr: null, head: main, dedupeKey: `${CARD_CLOSED}:${lease.cardId}`, payload: { verification: VERIFIED_BY_RUNNING_WITNESSES, witnessedOnMain: main }, legacy: false }
  }

  private unrun(lease: Lease, detail: string): WitnessOutcome {
    const next = failTask(this.parts.db, this.ts(), lease, { reason: WITNESS_UNRUN, withdraw: false })
    return { kind: 'denied', taskKey: lease.taskKey, denial: { kind: 'technical', reason: WITNESS_UNRUN, detail }, next }
  }

  private budgeted(deadline: number, last: { result: ShellResult | null }): Shell {
    return (command, cwd) => {
      const left = deadline - this.parts.clock().getTime()
      if (left <= 0)
        throw new WitnessTimedOut(command)
      const result = this.parts.shell(command, cwd, left)
      if (result.timedOut)
        throw new WitnessTimedOut(command)
      last.result = result
      return result
    }
  }

  private redOf(subject: WitnessSubject, base: string, head: string): string | null {
    const deadline = this.parts.clock().getTime() + WITNESS_BUDGET_MS
    const last: { result: ShellResult | null } = { result: null }
    return this.parts.trees.withTree(base, (tree) => {
      try {
        runOnTree(
          { tree, base, shell: this.budgeted(deadline, last), log: this.parts.log, refuse: (step, problem) => {
            if (problem !== null)
              throw new WitnessRed(step, problem)
          }, time: (_name, run) => run() },
          { acceptance: subject.acceptance, invariants: subject.invariants, harnessCommand: null, sketchSha: head, changed: [], witnessesDir: tree },
        )
        return null
      }
      catch (error) {
        if (error instanceof WitnessRed)
          return withFailureExcerpt(error.message, last.result)
        throw error
      }
    })
  }

  private recorded(lease: Lease, subject: WitnessSubject, base: string, verdict: WitnessVerdict, detail: string): BusEvent {
    return { ts: this.ts(), type: WITNESS_RECORDED, actor: lease.actor, cardId: lease.cardId, pr: lease.pr, head: lease.head, dedupeKey: `${WITNESS_RECORDED}:${lease.cardId}:${lease.head}:${base}:${subject.cardBody}`, payload: { head: lease.head, base, cardBody: subject.cardBody, verdict, detail }, legacy: false }
  }
}
