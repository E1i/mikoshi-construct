import type { Reviewer, ReviewStart, SessionDescendants, TreeTools } from '../../nodes/review/reviewer.js'
import type { ProcessRow, ProcessSnapshot, ProcessTable } from '../../ports/process-table.js'
import type { SpawnSessionParams } from '../../ports/session.js'
import type { MergeBench } from '../bus/merge-bench.js'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parkingFileText, parseParkingFile } from '../../../src/card/parking.js'
import { admittedRecord } from '../../../src/commands/intake/index.js'
import { appendCardEvent } from '../../core/card-bodies.js'
import { BOARD_ALARM, REVIEW_RECORDED, TASK_FAILED, TASK_LEASED } from '../../core/events.js'
import { fullReview } from '../../nodes/review/review-depth.js'
import { REVIEW_FAILED, windowRouteLine } from '../../nodes/review/review-executor.js'
import { ReviewWorker } from '../../nodes/review/review-worker.js'
import { claudeReviewer, osDescendants, REVIEW_CEILING, ReviewFailed, reviewPrompt, ReviewTrees, VERDICT_ENDS_LINE, WITNESS_RUNS_LINE } from '../../nodes/review/reviewer.js'
import { InMemoryProcessTable } from '../../ports/process-table.js'
import { clientCommand, spawnSession } from '../../ports/session.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { cardBody, sha } from '../bus/github-fake.js'
import { eventsOf, liveBench } from '../bus/merge-bench.js'

const PR = 1586
const CARD = PR + 100
const HEAD = sha('a')
const FINDING = 'scripts/a.ts:1 drops the second row'
const PIDS_VARIABLE = 'CONSTRUCT_REVIEW_CEILING_PIDS'
const cleanTree: Pick<TreeTools, 'prepare' | 'state'> = { prepare: () => {}, state: () => ({ head: HEAD, status: [] }) }
const cleanups: (() => void)[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0))
    cleanup()
})

function temporary(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function cardText(): string {
  return parkingFileText({
    card: `#${CARD} review-ceiling [implement/construct/L/cheap/owner] · depends — · blocks —`,
    branch: `feat/card-${CARD}`,
    touches: ['scripts/a.ts'],
    continue: 'stop',
    who: 'shift',
    body: ['Make it right.', '', 'Witnesses:', '- pnpm exec vitest run scripts/tests/a.test.ts'].join('\n'),
  })
}

function benchWith(reviewer: Reviewer): { bench: MergeBench, worker: ReviewWorker } {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const bench = liveBench()
  cleanups.push(() => bench.close())
  const text = cardText()
  const parsed = parseParkingFile(`${CARD}.md`, text)
  if (parsed.kind === 'refused')
    throw new Error(parsed.reason)
  appendCardEvent(bench.db, 'worker:intake:test', admittedRecord({ id: CARD, file: `${CARD}.md`, line: parsed.parked.task.card.line, who: parsed.parked.who, unclear: [], corrections: [], seam: [], risk: [], slices: [], text }, 'auto', bench.clock.now()))
  bench.tick()
  bench.gitHub.open({ number: PR, head: HEAD, ref: `feat/card-${CARD}`, body: cardBody(PR) })
  bench.tick()
  const worker = new ReviewWorker({ silentMs: SILENT_MS, isolation: () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] }), db: bench.db, gitHub: bench.gitHub.client, publish: bench.gitHub.publish, reviewer, plan: () => fullReview('a fixed plan'), clock: bench.clock.now, session: 'worker-1' })
  return { bench, worker }
}

function ungated(descendants: SessionDescendants): ReviewStart {
  return { gate: { start: async () => true, release: () => {} }, keep: () => true, joinWorkers: () => 1, leaveWorkers: () => {}, descendants, verdictPollMs: 20 }
}

function reviewerOver(spawn: (params: SpawnSessionParams) => Promise<number>, descendants: SessionDescendants = osDescendants(new InMemoryProcessTable({}))): Reviewer {
  const trees = new ReviewTrees(temporary('review-ceiling-repo-'), temporary('review-ceiling-trees-'), { git: () => {}, worktrees: () => [], ...cleanTree })
  return claudeReviewer(trees, spawn, () => {}, 60_000, () => null, ungated(descendants))
}

function leasesOf(bench: MergeBench): number {
  const rows = bench.db.prepare('SELECT dedupe_key FROM events WHERE type = ?').all(TASK_LEASED) as { dedupe_key: string }[]
  return rows.filter(row => row.dedupe_key.startsWith(`${TASK_LEASED}:review:${CARD}:${PR}:`)).length
}

function stubClient(script: string): string {
  const dir = temporary('review-ceiling-bin-')
  const client = path.join(dir, clientCommand())
  writeFileSync(client, `#!/usr/bin/env bash\n${script}\n`)
  chmodSync(client, 0o755)
  return dir
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch {
    return false
  }
}

function writtenTable(pids: string): ProcessTable {
  const quiet = new InMemoryProcessTable({})
  const snapshot = (): ProcessSnapshot => {
    if (!existsSync(pids))
      return { readable: true, rows: [] }
    const [root, background, session] = readFileSync(pids, 'utf8').trim().split(' ')
    const rows: ProcessRow[] = [
      { pid: Number(root), ppid: 1, pgid: Number(root), started: 'root', command: `${clientCommand()} ${session}` },
      { pid: Number(background), ppid: Number(root), pgid: Number(root), started: 'background', command: 'sleep 30' },
    ]
    return { readable: true, rows: rows.filter(row => alive(row.pid)) }
  }
  return { snapshot, clientCwds: () => quiet.clientCwds(), cpuSample: () => quiet.cpuSample() }
}

async function afterAllTicks(bench: MergeBench, worker: ReviewWorker): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    bench.tick()
    await worker.step()
  }
}

describe('a review ended at its ceiling goes to the window', () => {
  it('a written verdict leaves the session and its background child running until they end on their own', async () => {
    const pids = path.join(temporary('review-ceiling-pids-'), 'pids')
    const sessionRunsMs = 1_500
    vi.stubEnv(PIDS_VARIABLE, pids)
    vi.stubEnv('PATH', `${stubClient([
      'for last; do :; done',
      'verdict=$(printf \'%s\\n\' "$last" | sed -n \'s/^Finish by writing \\(.*\\) as JSON:.*/\\1/p\')',
      'sleep 1 &',
      `echo "$$ $! \${@: -2:1}" >"$${PIDS_VARIABLE}"`,
      `printf '{"verdict":"changes","findings":["${FINDING}"]}' >"$verdict"`,
      'sleep 1.5',
    ].join('\n'))}:${process.env.PATH}`)
    const signalled: [number, NodeJS.Signals][] = []
    const { bench, worker } = benchWith(reviewerOver(spawnSession, { ...osDescendants(writtenTable(pids)), sampleMs: 50, end: (pid, signal) => signalled.push([pid, signal]) }))
    const started = Date.now()

    expect(await worker.step()).toMatchObject({ kind: 'recorded', verdict: 'changes' })

    expect(Date.now() - started).toBeGreaterThanOrEqual(sessionRunsMs)
    expect(signalled).toEqual([])
    expect(eventsOf(bench.db, REVIEW_RECORDED).map(payload => payload.findings)).toEqual([[FINDING]])
    expect(existsSync(pids)).toBe(true)
    const [root, background] = readFileSync(pids, 'utf8').trim().split(' ').map(Number)
    expect([alive(root!), alive(background!)]).toEqual([false, false])
  })

  it('the review prompt names the card witnesses and mutations and forbids directory runs and polling loops', () => {
    const lease = { taskKey: `review:${CARD}:${PR}:${HEAD}`, queue: 'review' as const, cardId: CARD, pr: PR, head: HEAD, leaseGen: 1, actor: 'worker:review:w' }
    const prompt = reviewPrompt(lease, fullReview('a fixed plan'), '/tmp/t', '/tmp/v.json', cardText())

    expect(prompt).toContain(WITNESS_RUNS_LINE)
    expect(prompt).toContain(VERDICT_ENDS_LINE)
    expect(WITNESS_RUNS_LINE).toMatch(/the card's witnesses and its mutations/)
    expect(WITNESS_RUNS_LINE).toMatch(/never run vitest over a whole test directory/)
    expect(WITNESS_RUNS_LINE).toMatch(/never move a run to the background/)
    expect(WITNESS_RUNS_LINE).toMatch(/never wait on a run in a polling loop/)
    expect(prompt.indexOf(WITNESS_RUNS_LINE)).toBeLessThan(prompt.indexOf('Finish by writing /tmp/v.json'))
  })

  it('a review that failed at the ceiling starts no second run and opens the window route', async () => {
    let started = 0
    const { bench, worker } = benchWith(async () => {
      started += 1
      throw new ReviewFailed('the review session ended at its ceiling without a verdict', { path: '/tmp/t', release: () => null }, true)
    })

    expect(await worker.step()).toMatchObject({ kind: 'denied', denial: { reason: REVIEW_CEILING }, next: 'withdrawn' })
    await afterAllTicks(bench, worker)

    expect(started).toBe(1)
    expect(leasesOf(bench)).toBe(1)
    expect(eventsOf(bench.db, TASK_FAILED).map(payload => [payload.reason, payload.next])).toEqual([[REVIEW_CEILING, 'withdrawn']])
    const alarms = eventsOf(bench.db, BOARD_ALARM).filter(payload => payload.reason === REVIEW_CEILING)
    expect(alarms).toHaveLength(1)
    const route = windowRouteLine({ cardId: CARD, pr: PR, head: HEAD })
    expect(alarms[0]!.detail).toBe(route)
    expect(route).toContain(`PR #${PR}`)
    expect(route).toContain(`card #${CARD}`)
    expect(route).toContain(HEAD)
    expect(route).toContain(`pnpm bus:review --dry-run ${PR}`)
    expect(route).toContain(`pnpm bus:request allow-merge --pr ${PR} --head ${HEAD}`)
  })

  it('a review that fails for another reason is still requeued', async () => {
    const { bench, worker } = benchWith(async () => {
      throw new ReviewFailed('the review tree is not clean before the review', { path: '/tmp/t', release: () => null })
    })

    expect(await worker.step()).toMatchObject({ kind: 'denied', denial: { reason: REVIEW_FAILED }, next: 'queued' })

    expect(eventsOf(bench.db, TASK_FAILED).map(payload => [payload.reason, payload.next])).toEqual([[REVIEW_FAILED, 'queued']])
    expect(eventsOf(bench.db, BOARD_ALARM).filter(payload => payload.reason === REVIEW_CEILING)).toEqual([])
  })
})
