import type { DatabaseSync } from 'node:sqlite'
import type { QueuedTask } from '../../core/queue.js'
import type { GitHub } from '../../ports/github.js'
import type { FakeRun } from './github-fake.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ABANDONED_TITLE } from '../../ci/required.js'
import { openBus } from '../../core/db.js'
import { CI_RERUN_REQUESTED, PR_OBSERVED } from '../../core/events.js'
import { leaseNext } from '../../core/lease.js'
import { answerCandidates, queueTaskWithin, updateCandidates } from '../../core/queue.js'
import { UpdateExecutor } from '../../nodes/update/update-executor.js'
import { NetWatch, TICK_MS } from '../../ports/netwatch.js'
import { busProjections } from '../../supervisor/composition.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { BusTick } from '../../supervisor/run.js'
import { Clock, FakeGitHub, sha } from './github-fake.js'

const CANCELLED_RUN = 4242
const FAILED_RUN = 4343
const REQUIRED_RUN_ID = 9000

interface CancelBench {
  db: DatabaseSync
  gitHub: FakeGitHub
  cancelled: Set<string>
  abandoned: Set<string>
  tick: () => void
  answers: (pr: number) => QueuedTask[]
  updates: (pr: number) => QueuedTask[]
  rerunEvents: (pr: number) => { head: string, payload: Record<string, unknown> }[]
  updateOnce: (pr: number) => ReturnType<UpdateExecutor['update']> | null
  close: () => void
}

function cancelBench(): CancelBench {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-cancel-'))
  const db = openBus(path.join(root, 'bus.db'))
  const gitHub = new FakeGitHub()
  const clock = new Clock()
  const cancelled = new Set<string>()
  const abandoned = new Set<string>()
  const titles = new Map<number, string>()
  const client: GitHub = (endpoint) => {
    const annotations = /^repos\/\{owner\}\/\{repo\}\/check-runs\/(\d+)\/annotations$/.exec(endpoint)
    if (annotations !== null)
      return { status: 200, headers: {}, body: [{ title: titles.get(Number(annotations[1])) ?? null, message: 'Process completed with exit code 1.' }] }
    const response = gitHub.client(endpoint)
    if (!endpoint.includes('/check-runs'))
      return response
    const head = /\/commits\/([0-9a-f]{40})\/check-runs/.exec(endpoint)?.[1] ?? ''
    const body = response.body as { check_runs: { name: string, conclusion: string | null }[] }
    return { ...response, body: { check_runs: body.check_runs.map((check) => {
      if (check.name !== gitHub.checkName || check.conclusion !== 'failure')
        return cancelled.has(check.name) ? { ...check, conclusion: 'cancelled' } : check
      const id = REQUIRED_RUN_ID + titles.size
      titles.set(id, abandoned.has(head) ? ABANDONED_TITLE : 'CI / required is red')
      return { ...check, id, output: { annotations_count: 1, annotations_url: `https://api.github.com/repos/{owner}/{repo}/check-runs/${id}/annotations` } }
    }) } }
  }
  const busTick = new BusTick(db, busProjections(), new NetWatch(db, client, clock.now), clock.now, () => {})
  const executor = new UpdateExecutor({ silentMs: SILENT_MS, db, gitHub: client, put: gitHub.put, post: gitHub.post, publish: gitHub.publish, clock: clock.now, settle: () => {} })
  const ts = (): string => clock.now().toISOString()
  const tick = (): void => {
    busTick.run()
    clock.advance(TICK_MS)
  }
  tick()
  return {
    db,
    gitHub,
    cancelled,
    abandoned,
    tick,
    answers: pr => answerCandidates(db, ts()).filter(task => task.pr === pr),
    updates: pr => updateCandidates(db, ts()).filter(task => task.pr === pr),
    rerunEvents: pr => (db.prepare(`SELECT head, payload FROM events WHERE type = ? AND pr = ? ORDER BY id`).all(CI_RERUN_REQUESTED, pr) as { head: string, payload: string }[]).map(row => ({ head: row.head, payload: JSON.parse(row.payload) as Record<string, unknown> })),
    updateOnce: (pr) => {
      for (const task of updateCandidates(db, ts()).filter(each => each.pr === pr))
        queueTaskWithin(db, ts(), task)
      const lease = leaseNext(db, ts(), 'update', 'worker:update:worker-1')
      return lease === null ? null : executor.update(lease)
    },
    close: () => {
      db.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

const failedRun = (): FakeRun => ({ id: FAILED_RUN, run_attempt: 1, status: 'completed', conclusion: 'failure' })

const cancelledRun = (): FakeRun => ({ id: CANCELLED_RUN, run_attempt: 1, status: 'completed', conclusion: 'cancelled' as FakeRun['conclusion'] })

function observedPayloads(db: DatabaseSync, pr: number): Record<string, unknown>[] {
  return (db.prepare(`SELECT payload FROM events WHERE type = ? AND pr = ? ORDER BY id`).all(PR_OBSERVED, pr) as { payload: string }[]).map(row => JSON.parse(row.payload) as Record<string, unknown>)
}

describe('a red head only from a cancelled check', () => {
  it('a head red only from a cancelled check enqueues no answer and requests one re-run', () => {
    const bench = cancelBench()
    bench.cancelled.add('vitest (1/2)')
    bench.gitHub.open({ number: 1200, required: 'failure', failed: ['vitest (1/2)'], runs: [cancelledRun()] })
    bench.tick()

    expect(observedPayloads(bench.db, 1200).at(-1)).toMatchObject({ ci: 'red', failed_checks: ['vitest (1/2)'], cancelled_checks: ['vitest (1/2)'] })
    expect(bench.answers(1200)).toEqual([])
    expect(bench.updates(1200)).toEqual([expect.objectContaining({ queue: 'update', pr: 1200, head: sha('a') })])

    expect(bench.updateOnce(1200)).toMatchObject({ kind: 'rerun', requested: true })
    expect(bench.gitHub.reruns).toEqual([CANCELLED_RUN])
    expect(bench.rerunEvents(1200)).toEqual([{ head: sha('a'), payload: expect.objectContaining({ requested: true, runs: [CANCELLED_RUN] }) }])
    expect(bench.updates(1200)).toEqual([])
    bench.close()
  })

  it('a head with a failed check beside a cancelled one, and a red head with no failed check named, still enqueue an answer', () => {
    const bench = cancelBench()
    bench.cancelled.add('vitest (1/2)')
    bench.gitHub.open({ number: 1201, head: sha('b'), required: 'failure', failed: ['lint', 'vitest (1/2)'], runs: [cancelledRun()] })
    bench.gitHub.open({ number: 1202, head: sha('c'), required: 'failure', failed: [] })
    bench.tick()

    expect(observedPayloads(bench.db, 1201).at(-1)).toMatchObject({ failed_checks: ['lint', 'vitest (1/2)'], cancelled_checks: ['vitest (1/2)'] })
    expect(observedPayloads(bench.db, 1202).at(-1)).not.toHaveProperty('cancelled_checks')
    expect(bench.answers(1201)).toEqual([expect.objectContaining({ queue: 'answer', pr: 1201, head: sha('b') })])
    expect(bench.answers(1202)).toEqual([expect.objectContaining({ queue: 'answer', pr: 1202, head: sha('c') })])
    expect(bench.updates(1201)).toEqual([])
    expect(bench.updates(1202)).toEqual([])
    bench.close()
  })

  it('a head cancelled-only again after its one re-run enqueues an answer and requests no second re-run', () => {
    const bench = cancelBench()
    bench.cancelled.add('vitest (1/2)')
    bench.gitHub.open({ number: 1203, required: 'failure', failed: ['vitest (1/2)'], runs: [cancelledRun()] })
    bench.tick()
    expect(bench.updateOnce(1203)).toMatchObject({ kind: 'rerun', requested: true })

    bench.gitHub.pulls.get(1203)!.required = 'pending'
    bench.tick()
    bench.gitHub.pulls.get(1203)!.required = 'failure'
    bench.gitHub.pulls.get(1203)!.runs = [{ ...cancelledRun(), run_attempt: 2 }]
    bench.tick()

    expect(observedPayloads(bench.db, 1203).at(-1)).toMatchObject({ ci: 'red', cancelled_checks: ['vitest (1/2)'] })
    expect(bench.answers(1203)).toEqual([expect.objectContaining({ queue: 'answer', pr: 1203, head: sha('a') })])
    expect(bench.updates(1203)).toEqual([])
    expect(bench.updateOnce(1203)).toBeNull()
    expect(bench.gitHub.reruns).toEqual([CANCELLED_RUN])
    expect(bench.rerunEvents(1203)).toHaveLength(1)
    bench.close()
  })

  it('a re-run GitHub refuses is recorded once and the head goes to the answer path', () => {
    const bench = cancelBench()
    bench.cancelled.add('vitest (1/2)')
    bench.gitHub.rerunStatus = 403
    bench.gitHub.open({ number: 1204, required: 'failure', failed: ['vitest (1/2)'], runs: [cancelledRun()] })
    bench.tick()

    expect(bench.updateOnce(1204)).toMatchObject({ kind: 'rerun', requested: false })
    expect(bench.rerunEvents(1204)).toEqual([{ head: sha('a'), payload: expect.objectContaining({ requested: false, runs: [CANCELLED_RUN] }) }])
    expect(bench.answers(1204)).toEqual([expect.objectContaining({ queue: 'answer', pr: 1204 })])
    expect(bench.updates(1204)).toEqual([])
    bench.close()
  })

  it('a new head red only from a cancelled check gets its own one re-run', () => {
    const bench = cancelBench()
    bench.cancelled.add('vitest (1/2)')
    bench.gitHub.open({ number: 1205, required: 'failure', failed: ['vitest (1/2)'], runs: [cancelledRun()] })
    bench.tick()
    expect(bench.updateOnce(1205)).toMatchObject({ kind: 'rerun', requested: true })

    bench.gitHub.pulls.get(1205)!.head = sha('e')
    bench.gitHub.pulls.get(1205)!.runs = [{ ...cancelledRun(), id: CANCELLED_RUN + 1 }]
    bench.tick()

    expect(bench.answers(1205)).toEqual([])
    expect(bench.updateOnce(1205)).toMatchObject({ kind: 'rerun', requested: true })
    expect(bench.gitHub.reruns).toEqual([CANCELLED_RUN, CANCELLED_RUN + 1])
    expect(bench.rerunEvents(1205).map(event => event.head)).toEqual([sha('a'), sha('e')])
    bench.close()
  })
})

describe('a red head only from needs GitHub abandoned', () => {
  it('abandoned: a required red only from abandoned needs gets one rerun and enqueues no answer', () => {
    const bench = cancelBench()
    bench.abandoned.add(sha('a'))
    bench.gitHub.open({ number: 1493, required: 'failure', failed: [], runs: [failedRun()] })
    bench.tick()

    expect(observedPayloads(bench.db, 1493).at(-1)).toMatchObject({ ci: 'red', failed_checks: ['required'], cancelled_checks: ['required'] })
    expect(bench.answers(1493)).toEqual([])
    expect(bench.updates(1493)).toEqual([expect.objectContaining({ queue: 'update', pr: 1493, head: sha('a') })])
    expect(bench.updateOnce(1493)).toMatchObject({ kind: 'rerun', requested: true })
    expect(bench.gitHub.reruns).toEqual([FAILED_RUN])
    expect(bench.updates(1493)).toEqual([])
    bench.close()
  })

  it('abandoned: a required red beside a job that ran and failed, or with no abandoned annotation, still enqueues an answer', () => {
    const bench = cancelBench()
    bench.abandoned.add(sha('b'))
    bench.gitHub.open({ number: 1494, head: sha('b'), required: 'failure', failed: ['lint'], runs: [failedRun()] })
    bench.gitHub.open({ number: 1495, head: sha('c'), required: 'failure', failed: [], runs: [failedRun()] })
    bench.tick()

    expect(observedPayloads(bench.db, 1494).at(-1)).not.toHaveProperty('cancelled_checks')
    expect(observedPayloads(bench.db, 1495).at(-1)).not.toHaveProperty('cancelled_checks')
    expect(bench.answers(1494)).toEqual([expect.objectContaining({ queue: 'answer', pr: 1494 })])
    expect(bench.answers(1495)).toEqual([expect.objectContaining({ queue: 'answer', pr: 1495 })])
    expect(bench.updates(1494)).toEqual([])
    expect(bench.updates(1495)).toEqual([])
    bench.close()
  })
})
