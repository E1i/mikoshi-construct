import type { DatabaseSync } from 'node:sqlite'
import type { ReleaseRun, RunJob } from '../../ports/ci-reading.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { TICK_MS } from '../../core/cadence.js'
import { OWNER_WAIT_OPENED, RELEASE_RUN } from '../../core/events.js'
import { InMemoryCi, releaseRunOf } from '../../ports/ci-reading.js'
import { NetWatch, NETWATCH_SCRIPT } from '../../ports/netwatch.js'
import { openComposedBus, orderAndShardTermTicks, PR_HISTORY, requiredCheckAt } from '../../supervisor/composition.js'
import { RELEASE_WAIT_ACTOR, releaseRunMark } from '../../supervisor/release-waits.js'
import { Clock, FakeGitHub, MAIN_1 } from '../bus/github-fake.js'

const RUN_ID = 44616314560
const FAILED_STEP = 'Version or publish'
const roots: string[] = []
const dbs: DatabaseSync[] = []

afterEach(() => {
  dbs.splice(0).forEach(db => db.close())
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }))
})

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

function bench(run: ReleaseRun, jobs: RunJob[]): { db: DatabaseSync, tick: () => void, waits: () => string[], released: () => Record<string, unknown>[] } {
  const root = mkdtempSync(path.join(tmpdir(), 'release-run-'))
  roots.push(root)
  const db = openComposedBus(path.join(root, 'bus.db'))
  dbs.push(db)
  const clock = new Clock()
  const ci = new InMemoryCi({ releaseRuns: { [MAIN_1]: run }, jobs: { [run.databaseId]: jobs } })
  const netWatch = new NetWatch(db, new FakeGitHub().client, clock.now, NETWATCH_SCRIPT, () => requiredCheckAt(), PR_HISTORY, ci)
  const order = orderAndShardTermTicks(db, process.cwd())
  const payloads = (type: string, actor?: string): Record<string, unknown>[] => (db.prepare(`SELECT payload FROM events WHERE type = ? AND (? IS NULL OR actor = ?) ORDER BY id`).all(type, actor ?? null, actor ?? null)).map(row => JSON.parse(String(row.payload)) as Record<string, unknown>)
  return {
    db,
    tick: () => {
      netWatch.poll()
      order.step()
      clock.advance(TICK_MS)
    },
    waits: () => payloads(OWNER_WAIT_OPENED, RELEASE_WAIT_ACTOR).map(wait => String(wait.text)),
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

  it('a release run still in progress records nothing until it concludes', () => {
    const made = bench({ databaseId: RUN_ID, status: 'in_progress', conclusion: null }, [])
    made.tick()

    expect(made.released()).toEqual([])
    expect(made.waits()).toEqual([])
  })
})
