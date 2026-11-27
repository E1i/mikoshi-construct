import type { DatabaseSync } from 'node:sqlite'
import type { ReleaseRun, RunJob } from '../../ports/ci-reading.js'
import type { PrHistory } from '../../ports/netwatch.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { TICK_MS } from '../../core/cadence.js'
import { appendEvent } from '../../core/db.js'
import { MAIN_ADVANCED, OWNER_WAIT_OPENED, RELEASE_RUN } from '../../core/events.js'
import { GREEN_CI, RED_CI } from '../../core/order/turn.js'
import { InMemoryCi, releaseRunOf } from '../../ports/ci-reading.js'
import { NetWatch, NETWATCH_SCRIPT } from '../../ports/netwatch.js'
import { openComposedBus, orderAndShardTermTicks, PR_HISTORY, requiredCheckAt } from '../../supervisor/composition.js'
import { redMainWaitText, RELEASE_WAIT_ACTOR, releaseRunMark, unreleasedMainShas } from '../../supervisor/release-waits.js'
import { Clock, FakeGitHub, MAIN_1 } from '../bus/github-fake.js'

const RUN_ID = 44616314560
const RED_MAIN = 'e'.repeat(40)
const FAILED_STEP = 'Version or publish'
const roots: string[] = []
const dbs: DatabaseSync[] = []

afterEach(() => {
  dbs.splice(0).forEach(db => db.close())
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }))
})

function advanceMain(db: DatabaseSync, sha: string, ci: string, key = 'first'): void {
  appendEvent(db, { ts: '2026-11-27T04:40:00.000Z', type: MAIN_ADVANCED, actor: 'netwatch', cardId: null, pr: null, head: null, dedupeKey: `main.advanced:${sha}:${ci}:${key}`, payload: { sha, ci, paths: [], pathsTruncated: false, touches_mechanics: false }, legacy: false })
}

function step(name: string, conclusion: string): NonNullable<RunJob['steps']>[number] {
  return { name, conclusion, startedAt: '2026-11-27T04:30:00Z', completedAt: '2026-11-27T04:38:00Z' }
}

function releaseJob(conclusion: string): RunJob {
  return {
    name: 'release',
    conclusion,
    startedAt: '2026-11-27T04:30:00Z',
    completedAt: '2026-11-27T04:38:00Z',
    steps: [step('Wait for the green CI quality on this commit', 'success'), step(FAILED_STEP, conclusion), step('Upload the stage record', conclusion === 'success' ? 'success' : 'skipped')],
  }
}

interface Bench {
  db: DatabaseSync
  releaseRuns: Record<string, ReleaseRun>
  tick: () => void
  waits: () => string[]
  waitNeeds: () => unknown[]
  released: () => Record<string, unknown>[]
}

function bench(run: ReleaseRun, jobs: RunJob[], history: PrHistory = PR_HISTORY): Bench {
  const root = mkdtempSync(path.join(tmpdir(), 'release-run-'))
  roots.push(root)
  const db = openComposedBus(path.join(root, 'bus.db'))
  dbs.push(db)
  const clock = new Clock()
  const releaseRuns: Record<string, ReleaseRun> = { [MAIN_1]: run }
  const ci = new InMemoryCi({ releaseRuns, jobs: { [run.databaseId]: jobs } })
  const netWatch = new NetWatch(db, new FakeGitHub().client, clock.now, NETWATCH_SCRIPT, () => requiredCheckAt(), history, ci)
  const order = orderAndShardTermTicks(db, process.cwd())
  const payloads = (type: string, actor?: string): Record<string, unknown>[] => (db.prepare(`SELECT payload FROM events WHERE type = ? AND (? IS NULL OR actor = ?) ORDER BY id`).all(type, actor ?? null, actor ?? null)).map(row => JSON.parse(String(row.payload)) as Record<string, unknown>)
  return {
    db,
    releaseRuns,
    tick: () => {
      netWatch.poll()
      order.step()
      clock.advance(TICK_MS)
    },
    waits: () => payloads(OWNER_WAIT_OPENED, RELEASE_WAIT_ACTOR).map(wait => String(wait.text)),
    waitNeeds: () => payloads(OWNER_WAIT_OPENED, RELEASE_WAIT_ACTOR).map(wait => wait.need),
    released: () => payloads(RELEASE_RUN),
  }
}

describe('the bus observes the Release run of each main sha', () => {
  it('a red release run on main is recorded with its failed step and opens one owner wait', () => {
    const made = bench({ databaseId: RUN_ID, status: 'completed', conclusion: 'failure' }, [releaseJob('failure')])
    made.tick()
    made.tick()

    expect(made.released()).toEqual([expect.objectContaining({ sha: MAIN_1, run_id: RUN_ID, conclusion: 'failure', verdict: 'red', failed_step: `release › ${FAILED_STEP}` })])
    expect(made.released()[0]!.steps).toContainEqual({ job: 'release', step: FAILED_STEP, conclusion: 'failure' })
    const waits = made.waits()
    expect(waits).toHaveLength(1)
    expect(waits[0]).toContain(releaseRunMark(RUN_ID))
    expect(waits[0]).toContain(MAIN_1)
    expect(waits[0]).toContain(FAILED_STEP)
    expect(made.waitNeeds()).toEqual(['decision'])
  })

  it.each(['skipped', 'neutral'])('a %s release run is green and opens no owner wait', (conclusion) => {
    const made = bench({ databaseId: RUN_ID, status: 'completed', conclusion }, [releaseJob(conclusion)])
    made.tick()
    made.tick()

    expect(made.released()).toEqual([expect.objectContaining({ sha: MAIN_1, run_id: RUN_ID, conclusion, verdict: 'green', failed_step: null })])
    expect(made.waits()).toEqual([])
  })

  it('the Release run of the main sha observed on a tick is read on that same tick', () => {
    const made = bench({ databaseId: RUN_ID, status: 'completed', conclusion: 'success' }, [releaseJob('success')])
    made.tick()

    expect(made.released()).toEqual([expect.objectContaining({ sha: MAIN_1, run_id: RUN_ID, verdict: 'green' })])
  })

  it('a main sha whose Release run concludes after main.advanced was observed is caught up on a later tick', () => {
    const made = bench({ databaseId: RUN_ID, status: 'in_progress', conclusion: null }, [releaseJob('failure')])
    made.tick()
    expect(made.released()).toEqual([])
    expect(unreleasedMainShas(made.db)).toEqual([MAIN_1])

    made.releaseRuns[MAIN_1] = { databaseId: RUN_ID, status: 'completed', conclusion: 'failure' }
    made.tick()
    made.tick()

    expect(made.released()).toEqual([expect.objectContaining({ sha: MAIN_1, run_id: RUN_ID, conclusion: 'failure', verdict: 'red' })])
    expect(made.waits()).toHaveLength(1)
    expect(unreleasedMainShas(made.db)).toEqual([])
  })

  it('a sha re-read on a later tick with the same run and conclusion writes no second release.run', () => {
    const rereading: PrHistory = { ...PR_HISTORY, unreleasedMainShas: () => [MAIN_1] }
    const made = bench({ databaseId: RUN_ID, status: 'completed', conclusion: 'failure' }, [releaseJob('failure')], rereading)
    made.tick()
    made.tick()
    made.tick()

    expect(made.released()).toHaveLength(1)
    expect(made.waits()).toHaveLength(1)
  })

  it('a green release run is recorded with no owner wait', () => {
    const made = bench({ databaseId: RUN_ID, status: 'completed', conclusion: 'success' }, [releaseJob('success')])
    made.tick()
    made.tick()

    expect(made.released()).toEqual([expect.objectContaining({ sha: MAIN_1, run_id: RUN_ID, verdict: 'green', failed_step: null })])
    expect(made.waits()).toEqual([])
  })

  it('the Release run of a sha is the push run of the Release workflow among the runs on that head', () => {
    const runs = [
      { id: 1, name: 'CI', event: 'push', status: 'completed', conclusion: 'failure' },
      { id: 2, name: 'Release', event: 'workflow_dispatch', status: 'completed', conclusion: 'failure' },
      { id: RUN_ID, name: 'Release', event: 'push', status: 'completed', conclusion: 'failure' },
    ]
    expect(releaseRunOf(runs)).toEqual({ databaseId: RUN_ID, status: 'completed', conclusion: 'failure' })
    expect(releaseRunOf(runs.slice(0, 2))).toBeNull()
  })

  it('a red main opens one owner wait per sha', () => {
    const made = bench({ databaseId: RUN_ID, status: 'completed', conclusion: 'success' }, [releaseJob('success')])
    advanceMain(made.db, RED_MAIN, RED_CI)
    advanceMain(made.db, RED_MAIN, RED_CI, 'again')
    made.tick()
    made.tick()

    const waits = made.waits()
    expect(waits).toEqual([redMainWaitText(RED_MAIN)])
    expect(waits[0]).toContain(RED_MAIN)
    expect(waits[0]).toContain('CI on main red')
    expect(made.waitNeeds()).toEqual(['decision'])
  })

  it('a green main opens no owner wait', () => {
    const made = bench({ databaseId: RUN_ID, status: 'completed', conclusion: 'success' }, [releaseJob('success')])
    advanceMain(made.db, RED_MAIN, GREEN_CI)
    made.tick()
    made.tick()

    expect(made.waits()).toEqual([])
  })

  it('a release run still in progress records nothing until it concludes', () => {
    const made = bench({ databaseId: RUN_ID, status: 'in_progress', conclusion: null }, [])
    made.tick()

    expect(made.released()).toEqual([])
    expect(made.waits()).toEqual([])
  })
})
