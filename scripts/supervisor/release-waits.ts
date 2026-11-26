import type { DatabaseSync } from 'node:sqlite'
import { inTransaction, openOwnerWait, OWNER_ANSWER_LIFT } from '../core/db.js'
import { MAIN_ADVANCED, OWNER_WAIT_OPENED, RELEASE_RUN } from '../core/events.js'
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

function waitedRunIds(db: DatabaseSync, runs: readonly RedReleaseRun[]): Set<number> {
  const texts = new BusRead(db, { actor: RELEASE_WAIT_ACTOR }).slice(OWNER_WAIT_OPENED, ['text']).map(opened => String(opened.fields.text ?? ''))
  return new Set(runs.filter(run => texts.some(text => text.startsWith(releaseRunMark(run.runId)))).map(run => run.runId))
}

export function openReleaseWaits(db: DatabaseSync, ts: string): string[] {
  return inTransaction(db, () => {
    const runs = redRunsOf(db)
    const waited = waitedRunIds(db, runs)
    return runs.filter(run => !waited.has(run.runId)).map((run) => {
      waited.add(run.runId)
      const id = openOwnerWait(db, ts, RELEASE_WAIT_ACTOR, { need: 'decision', text: releaseWaitText(run), lift: OWNER_ANSWER_LIFT })
      return `${id}: ${releaseWaitText(run)}`
    })
  })
}

export function releaseWaitsTick(db: DatabaseSync, clock: () => Date): { step: () => string[] } {
  return { step: () => openReleaseWaits(db, clock().toISOString()) }
}
