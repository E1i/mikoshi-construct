import type { DatabaseSync } from 'node:sqlite'
import type { Shell } from '../ports/worktree.js'
import type { BusEvent } from './db.js'
import type { AfterFailure, Lease } from './lease.js'
import type { WitnessSubject, WitnessVerdict } from './policy.js'
import { WITNESS_RECORDED } from '../core/events.js'
import { gitIn, withWorktree } from '../ports/worktree.js'
import { assertHeld, completeTask, failTask, StaleLease } from './lease.js'
import { GREEN, RED, witnessSubjectOf } from './policy.js'
import { runOnTree } from './witnesses.js'

export const WITNESS_UNRUN = 'witness_unrun'
const PR_BASE = 'origin/main'

export interface WitnessTrees {
  baseOf: (pr: number, head: string) => string
  withTree: <T>(base: string, run: (tree: string) => T) => T
}

export interface WitnessParts {
  db: DatabaseSync
  clock: () => Date
  trees: WitnessTrees
  shell: Shell
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

export function gitWitnessTrees(repo: string): WitnessTrees {
  return {
    baseOf: (pr, head) => {
      gitIn(repo, ['fetch', '-q', 'origin', 'main', `pull/${pr}/head`])
      return gitIn(repo, ['merge-base', head, PR_BASE])
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
      if (subject === null || lease.pr === null || lease.head === null) {
        completeTask(this.parts.db, this.ts(), lease, [])
        return { kind: 'skipped', taskKey: lease.taskKey, why: `card #${lease.cardId} declares no witness with a command, or the task names no pull request head` }
      }
      let base: string
      try {
        base = this.parts.trees.baseOf(lease.pr, lease.head)
      }
      catch (error) {
        const detail = `the base of ${lease.head} could not be read: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`
        const next = failTask(this.parts.db, this.ts(), lease, { reason: WITNESS_UNRUN, withdraw: false })
        return { kind: 'denied', taskKey: lease.taskKey, denial: { kind: 'technical', reason: WITNESS_UNRUN, detail }, next }
      }
      const red = this.redOf(subject, base, lease.head)
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

  private redOf(subject: WitnessSubject, base: string, head: string): string | null {
    return this.parts.trees.withTree(base, (tree) => {
      try {
        runOnTree(
          { tree, base, shell: this.parts.shell, log: this.parts.log, refuse: (step, problem) => {
            if (problem !== null)
              throw new WitnessRed(step, problem)
          }, time: (_name, run) => run() },
          { acceptance: subject.acceptance, invariants: subject.invariants, harnessCommand: null, sketchSha: head, changed: [], witnessesDir: tree },
        )
        return null
      }
      catch (error) {
        if (error instanceof WitnessRed)
          return error.message
        throw error
      }
    })
  }

  private recorded(lease: Lease, subject: WitnessSubject, base: string, verdict: WitnessVerdict, detail: string): BusEvent {
    return { ts: this.ts(), type: WITNESS_RECORDED, actor: lease.actor, cardId: lease.cardId, pr: lease.pr, head: lease.head, dedupeKey: `${WITNESS_RECORDED}:${lease.cardId}:${lease.head}:${base}:${subject.cardBody}`, payload: { head: lease.head, base, cardBody: subject.cardBody, verdict, detail }, legacy: false }
  }
}
