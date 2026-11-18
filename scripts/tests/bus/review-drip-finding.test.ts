import type { DripSources } from '../../nodes/review/review-executor.js'
import type { MergeBench } from './merge-bench.js'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { parkingFileText, parseParkingFile } from '../../../src/card/parking.js'
import { admittedRecord } from '../../../src/commands/intake/index.js'
import { appendCardEvent } from '../../core/card-bodies.js'
import { REVIEW_DRIP, REVIEW_RECORDED } from '../../core/events.js'
import { answerCandidates } from '../../nodes/answer/answer-candidates.js'
import { fullReview } from '../../nodes/review/review-depth.js'
import { gitDripSources, isDrip, namedPaths, trackedSuffixes } from '../../nodes/review/review-executor.js'
import { ReviewWorker } from '../../nodes/review/review-worker.js'
import { answerParts } from '../../supervisor/composition.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { cardBody, sha } from './github-fake.js'
import { eventsOf, liveBench } from './merge-bench.js'

const PR = 1529
const CARD = PR + 100
const GOAL_FILE = 'src/commands/board/goal.ts'
const TRACKED = [GOAL_FILE, 'docs/cli.md', 'scripts/core/queue.ts', 'scripts/ci/verdict.ts', '.github/workflows/ci.yml', 'scripts/window/watch.ts', 'scripts/supervisor/run.ts']
const CHANGED_SINCE_THE_FIRST_ROUND = [GOAL_FILE]

const FIRST_ROUND_FINDING = `${GOAL_FILE}:planLine prints the wrong count for a card with no witness`
const DRIPS = [
  'scripts/core/queue.ts: the answer candidates query reads tasks without the generation filter, so a retired generation is answered twice',
  'queue.ts answerCandidatesWhere keeps a parked PR among the candidates once its park expired',
  'scripts/ci/verdict.ts treats a cancelled check as failed, and ci.yml never re-runs it',
  'scripts/window/watch.ts:289 reads the handoff before the lock is held',
  'scripts/supervisor/run.ts BusTick.run swallows the error of a failed reduce',
]
const FOLLOW_UP = `${GOAL_FILE}: the fix for planLine now divides by zero when the plan has no card`
const REPEAT = `Still open: ${FIRST_ROUND_FINDING}`
const NO_PATH = 'The new branch of the plan line has no test that fails without it'
const ON_THE_DESCRIPTION = 'The PR description claims scripts/core/queue.ts changed, but the diff does not touch it'

const benches: MergeBench[] = []

afterEach(() => {
  for (const bench of benches.splice(0))
    bench.close()
})

function admit(bench: MergeBench): void {
  const text = parkingFileText({
    card: `#${CARD} a-card [implement/netwatch/M/cheap/auto] · depends — · blocks —`,
    branch: `feat/card-${CARD}`,
    touches: [GOAL_FILE, 'docs/cli.md'],
    continue: 'stop',
    who: 'shift',
    body: ['Make the plan line right.', '', 'Witnesses:', '- pnpm exec vitest run tests/board.test.ts'].join('\n'),
  })
  const parsed = parseParkingFile(`${CARD}.md`, text)
  if (parsed.kind === 'refused')
    throw new Error(parsed.reason)
  appendCardEvent(bench.db, 'worker:intake:test', admittedRecord({ id: CARD, file: `${CARD}.md`, line: parsed.parked.task.card.line, who: parsed.parked.who, unclear: [], corrections: [], seam: [], risk: [], slices: [], text }, 'auto', bench.clock.now()))
  bench.tick()
}

interface Fixture {
  bench: MergeBench
  worker: ReviewWorker
  reviewer: { findings: string[] }
}

const READABLE: DripSources = { changed: () => CHANGED_SINCE_THE_FIRST_ROUND, files: () => TRACKED }

function fixture(sources: DripSources = READABLE): Fixture {
  const bench = liveBench()
  benches.push(bench)
  const reviewer = { findings: [] as string[] }
  const worker = new ReviewWorker({ silentMs: SILENT_MS, isolation: () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] }), db: bench.db, gitHub: bench.gitHub.client, publish: bench.gitHub.publish, reviewer: async () => ({ verdict: 'changes', findings: reviewer.findings, session: 'reviewer-1' }), plan: () => fullReview('a fixed plan'), clock: bench.clock.now, session: 'worker-1', dripSources: sources })
  admit(bench)
  return { bench, worker, reviewer }
}

async function reviewRound(fixed: Fixture, head: string, findings: string[], body = cardBody(PR)): Promise<void> {
  fixed.reviewer.findings = findings
  fixed.bench.gitHub.open({ number: PR, head, body })
  fixed.bench.tick()
  expect(await fixed.worker.step()).toMatchObject({ kind: 'recorded' })
}

function lastRecorded(fixed: Fixture): Record<string, unknown> {
  return eventsOf(fixed.bench.db, REVIEW_RECORDED).at(-1)!
}

function answersOfThePr(fixed: Fixture): number {
  fixed.bench.tick()
  return answerCandidates(fixed.bench.db, fixed.bench.clock.now().toISOString(), answerParts()).filter(task => task.pr === PR).length
}

describe('a new finding of a later changes round on code the answer did not touch', () => {
  it('is kept in the payload under drip and not counted, so a round left with only such findings records pass', async () => {
    const fixed = fixture()
    await reviewRound(fixed, sha('b'), [FIRST_ROUND_FINDING])
    await reviewRound(fixed, sha('c'), DRIPS)

    expect(lastRecorded(fixed)).toMatchObject({ head: sha('c'), verdict: 'pass', findings: [], drip: DRIPS })
    expect(answersOfThePr(fixed)).toBe(0)
  })

  it('a marked drip finding is in the bus as its own event after a pass verdict', async () => {
    const fixed = fixture()
    await reviewRound(fixed, sha('b'), [FIRST_ROUND_FINDING])
    await reviewRound(fixed, sha('c'), DRIPS)

    expect(lastRecorded(fixed)).toMatchObject({ verdict: 'pass' })
    expect(eventsOf(fixed.bench.db, REVIEW_DRIP)).toEqual(DRIPS.map(finding => ({ card: CARD, pr: PR, head: sha('c'), finding })))
  })

  it('counts a finding naming a changed file, a repeat, a finding naming no path and one on a changed description, and marks only the drip', async () => {
    const fixed = fixture()
    await reviewRound(fixed, sha('b'), [FIRST_ROUND_FINDING])
    await reviewRound(fixed, sha('c'), [DRIPS[0]!, FOLLOW_UP, REPEAT, NO_PATH, ON_THE_DESCRIPTION], `${cardBody(PR)}\n\nThe description changed.`)

    expect(lastRecorded(fixed)).toMatchObject({ verdict: 'changes', findings: [FOLLOW_UP, REPEAT, NO_PATH, ON_THE_DESCRIPTION], drip: [DRIPS[0]] })
    expect(eventsOf(fixed.bench.db, REVIEW_DRIP)).toEqual([expect.objectContaining({ finding: DRIPS[0] })])
    expect(answersOfThePr(fixed)).toBe(1)
  })

  it('marks nothing in the first changes round of a pull request', async () => {
    const fixed = fixture()
    await reviewRound(fixed, sha('b'), DRIPS)

    expect(lastRecorded(fixed)).toMatchObject({ verdict: 'changes', findings: DRIPS })
    expect(lastRecorded(fixed)).not.toHaveProperty('drip')
    expect(eventsOf(fixed.bench.db, REVIEW_DRIP)).toEqual([])
  })

  it('counts every finding as today when the diff since the previous round cannot be read', async () => {
    const fixed = fixture({ changed: () => {
      throw new Error('unknown revision')
    }, files: () => TRACKED })
    await reviewRound(fixed, sha('b'), [FIRST_ROUND_FINDING])
    await reviewRound(fixed, sha('c'), DRIPS)

    expect(lastRecorded(fixed)).toMatchObject({ verdict: 'changes', findings: DRIPS })
    expect(eventsOf(fixed.bench.db, REVIEW_DRIP)).toEqual([])
  })
})

describe('the git reading of a drip round', () => {
  it('lists the files tracked at a head and the files changed between two heads', () => {
    const sources = gitDripSources(process.cwd())
    expect(sources.files('HEAD')).toContain('scripts/nodes/review/review-executor.ts')
    expect(sources.changed('HEAD', 'HEAD')).toEqual([])
  })
})

describe('the placement of a finding', () => {
  const tracked = trackedSuffixes(TRACKED)

  it('names a tracked file by its path, a suffix of it or its base name, and ignores a line number and punctuation', () => {
    expect(namedPaths('`scripts/window/watch.ts:289` reads it.', tracked)).toEqual(['scripts/window/watch.ts'])
    expect(namedPaths('see core/queue.ts, then ci.yml.', tracked)).toEqual(['scripts/core/queue.ts', '.github/workflows/ci.yml'])
    expect(namedPaths('e.g. Node.js 0.47 has no such file', tracked)).toEqual([])
  })

  it('is drip only when it names tracked files and none of them changed, and the description finding counts only on a changed description', () => {
    const round = { changed: new Set(CHANGED_SINCE_THE_FIRST_ROUND), tracked, descriptionChanged: false }
    expect(DRIPS.every(finding => isDrip(finding, round))).toBe(true)
    expect(isDrip(FOLLOW_UP, round)).toBe(false)
    expect(isDrip(NO_PATH, round)).toBe(false)
    expect(isDrip(`${DRIPS[0]!} and ${GOAL_FILE}`, round)).toBe(false)
    expect(isDrip(ON_THE_DESCRIPTION, round)).toBe(true)
    expect(isDrip(ON_THE_DESCRIPTION, { ...round, descriptionChanged: true })).toBe(false)
  })
})
