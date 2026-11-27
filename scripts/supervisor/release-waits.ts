import type { DatabaseSync } from 'node:sqlite'
import { inTransaction, openOwnerWait, OWNER_ANSWER_LIFT } from '../core/db.js'
import { MAIN_ADVANCED, OWNER_WAIT_OPENED, RELEASE_RUN } from '../core/events.js'
import { RED_CI } from '../core/order/turn.js'
import { BusRead } from '../ports/bus-read.js'

export const RELEASE_WAIT_ACTOR = 'worker:supervisor:release-run'
export const RELEASE_WATCH_DEPTH = 3
export const RED_RELEASE = 'red'

export interface RedReleaseRun {
  runId: number
  sha: string
  conclusion: string
  failedStep: string | null
}

export function releaseRunMark(runId: number): string {
  return `Release run ${runId} `
}

export function releaseWaitText(run: RedReleaseRun): string {
  return `${releaseRunMark(run.runId)}on main ${run.sha} ended ${run.conclusion}${run.failedStep === null ? ' with no failed step named' : ` at step ${run.failedStep}`}: the version may sit staged and unpublished; open the run on GitHub, fix or re-run it, then answer this wait`
}

export function redMainMark(sha: string): string {
  return `Main ${sha} `
}

export function redMainWaitText(sha: string): string {
  return `${redMainMark(sha)}advanced with CI on main red: open the failed checks of that commit on GitHub, fix main or re-run them, then answer this wait`
}

export function unreleasedMainShas(db: DatabaseSync, depth: number = RELEASE_WATCH_DEPTH): string[] {
  const read = new BusRead(db, { limit: depth })
  const released = new Set(new BusRead(db).slice(RELEASE_RUN, ['sha']).map(run => run.fields.sha))
  return read.slice(MAIN_ADVANCED, ['sha'], 'newest').flatMap(main => typeof main.fields.sha === 'string' && !released.has(main.fields.sha) ? [main.fields.sha] : [])
}

function redRunsOf(db: DatabaseSync): RedReleaseRun[] {
  return new BusRead(db).slice(RELEASE_RUN, ['run_id', 'sha', 'conclusion', 'failed_step', 'verdict']).flatMap(({ fields }) =>
    fields.verdict === RED_RELEASE && typeof fields.run_id === 'number' && typeof fields.sha === 'string'
      ? [{ runId: fields.run_id, sha: fields.sha, conclusion: String(fields.conclusion), failedStep: typeof fields.failed_step === 'string' ? fields.failed_step : null }]
      : [])
}

function waitTexts(db: DatabaseSync): string[] {
  return new BusRead(db, { actor: RELEASE_WAIT_ACTOR }).slice(OWNER_WAIT_OPENED, ['text']).map(opened => String(opened.fields.text ?? ''))
}

function waitedRunIds(db: DatabaseSync, runs: readonly RedReleaseRun[]): Set<number> {
  const texts = waitTexts(db)
  return new Set(runs.filter(run => texts.some(text => text.startsWith(releaseRunMark(run.runId)))).map(run => run.runId))
}

function redMainShasOf(db: DatabaseSync): string[] {
  const shas = new BusRead(db).slice(MAIN_ADVANCED, ['sha', 'ci']).flatMap(({ fields }) => fields.ci === RED_CI && typeof fields.sha === 'string' ? [fields.sha] : [])
  return [...new Set(shas)]
}

function waitedMainShas(db: DatabaseSync, shas: readonly string[]): Set<string> {
  const texts = waitTexts(db)
  return new Set(shas.filter(sha => texts.some(text => text.startsWith(redMainMark(sha)))))
}

function openDecisionWait(db: DatabaseSync, ts: string, text: string): string {
  const id = openOwnerWait(db, ts, RELEASE_WAIT_ACTOR, { need: 'decision', text, lift: OWNER_ANSWER_LIFT })
  return `${id}: ${text}`
}

export function openReleaseWaits(db: DatabaseSync, ts: string): string[] {
  return inTransaction(db, () => {
    const runs = redRunsOf(db)
    const waited = waitedRunIds(db, runs)
    return runs.filter(run => !waited.has(run.runId)).map((run) => {
      waited.add(run.runId)
      return openDecisionWait(db, ts, releaseWaitText(run))
    })
  })
}

export function openRedMainWaits(db: DatabaseSync, ts: string): string[] {
  return inTransaction(db, () => {
    const shas = redMainShasOf(db)
    const waited = waitedMainShas(db, shas)
    return shas.filter(sha => !waited.has(sha)).map(sha => openDecisionWait(db, ts, redMainWaitText(sha)))
  })
}

export function releaseWaitsTick(db: DatabaseSync, clock: () => Date): { step: () => string[] } {
  return {
    step: () => {
      const ts = clock().toISOString()
      return [...openReleaseWaits(db, ts), ...openRedMainWaits(db, ts)]
    },
  }
}
