import type { RecutOutcome } from '../../nodes/review/pr-close.js'
import type { GhResponse, GitHub, GitHubPut } from '../../ports/github.js'
import type { MergeBench } from './merge-bench.js'
import { afterEach, describe, expect, it } from 'vitest'
import { parkingFileText, parseParkingFile } from '../../../src/card/parking.js'
import { AMEND_SOURCE } from '../../../src/commands/intake/admit.js'
import { admittedRecord } from '../../../src/commands/intake/index.js'
import { appendCardEvent, WINDOW_LANE } from '../../core/card-bodies.js'
import { REVIEW_RECORDED } from '../../core/events.js'
import { answerCandidates, changesRoundsOf, closedByRounds, REPEAT_FINDINGS, REVIEW_ROUNDS } from '../../core/queue.js'
import { busHeldCards } from '../../intake/intake.js'
import { RoundLimitRecutter } from '../../nodes/review/pr-close.js'
import { fullReview } from '../../nodes/review/review-depth.js'
import { repeatStopLine } from '../../nodes/review/review-executor.js'
import { REVIEW_ROUNDS_SPENT, ReviewWorker, roundLimitLine } from '../../nodes/review/review-worker.js'
import { allFindingsRepeat, isNote, jaccard, REPEAT_JACCARD } from '../../policy/repeat-finding.js'
import { cardBody, sha } from './github-fake.js'
import { eventsOf, liveBench } from './merge-bench.js'

const PR = 980
const CARD = PR + 100
const BRANCH = `feat/card-${CARD}`
const GOAL_FILE = 'src/commands/board/goal.ts'
const ISSUES = 'repos/{owner}/{repo}/issues?'
const THE_FINDING = `${GOAL_FILE}:planLine prints the wrong count for a card with no witness`
const A_NEW_FINDING = 'docs/cli.md never names the flag the command gained'
const A_NOTE = 'Verification note: tests/contract/surface.test.ts fails in this sandbox with listen EPERM'
const benches: MergeBench[] = []

afterEach(() => {
  for (const bench of benches.splice(0))
    bench.close()
})

function cardText(decision = 'owner', body: string[] = []): string {
  return parkingFileText({
    card: `#${CARD} a-card [implement/netwatch/M/cheap/${decision}] · depends — · blocks —`,
    branch: BRANCH,
    touches: [GOAL_FILE, 'docs/cli.md'],
    continue: 'stop',
    who: 'shift',
    body: ['Make the plan line right.', ...body, '', 'Witnesses:', '- pnpm exec vitest run tests/board.test.ts'].join('\n'),
  })
}

function admit(bench: MergeBench, text: string, source?: string): void {
  const parsed = parseParkingFile(`${CARD}.md`, text)
  if (parsed.kind === 'refused')
    throw new Error(parsed.reason)
  appendCardEvent(bench.db, 'worker:intake:test', admittedRecord({ id: CARD, file: `${CARD}.md`, line: parsed.parked.task.card.line, who: parsed.parked.who, unclear: [], corrections: [], seam: [], risk: [], slices: [], text }, 'auto', bench.clock.now(), WINDOW_LANE, source))
  bench.tick()
}

interface Fixture {
  bench: MergeBench
  worker: ReviewWorker
  recuts: RecutOutcome[]
  notes: [number, string][]
  reviewer: { findings: string[] }
  decision: string
}

function fixture(decision = 'owner'): Fixture {
  const bench = liveBench()
  benches.push(bench)
  const recuts: RecutOutcome[] = []
  const notes: [number, string][] = []
  const reviewer = { findings: [] as string[] }
  const post: GitHubPut = (_endpoint, fields): GhResponse => {
    const number = Math.max(...bench.gitHub.pulls.keys()) + 1
    bench.gitHub.open({ number, head: bench.gitHub.pulls.get(PR)!.head, ref: fields.head, body: fields.body })
    return { status: 201, headers: {}, body: { number } }
  }
  const gitHub: GitHub = endpoint => endpoint.startsWith(ISSUES) ? { status: 200, headers: {}, body: [{ number: Math.max(...bench.gitHub.pulls.keys()) }] } : bench.gitHub.client(endpoint)
  const recutter = new RoundLimitRecutter({ db: bench.db, gitHub, post, patch: bench.gitHub.patch, clock: bench.clock.now, cardStates: () => busHeldCards(bench.db) })
  const worker = new ReviewWorker({
    isolation: () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] }),
    db: bench.db,
    gitHub: bench.gitHub.client,
    publish: bench.gitHub.publish,
    reviewer: async () => ({ verdict: 'changes', findings: reviewer.findings, session: 'reviewer-1' }),
    plan: () => fullReview('a fixed plan'),
    clock: bench.clock.now,
    session: 'worker-1',
    notePr: (pr, line) => notes.push([pr, line]),
    recut: { recut: (at) => {
      const outcome = recutter.recut(at)
      recuts.push(outcome)
      return outcome
    } },
  })
  admit(bench, cardText(decision))
  return { bench, worker, recuts, notes, reviewer, decision }
}

async function reviewRound(fixed: Fixture, head: string, findings: string[]): Promise<void> {
  fixed.reviewer.findings = findings
  fixed.bench.gitHub.open({ number: PR, head, body: cardBody(PR, fixed.decision) })
  fixed.bench.tick()
  expect(await fixed.worker.step()).toMatchObject({ kind: 'recorded' })
}

function answersOfThePr(fixed: Fixture): number {
  fixed.bench.tick()
  return answerCandidates(fixed.bench.db, fixed.bench.clock.now().toISOString()).filter(task => task.pr === PR).length
}

describe('a late review round that repeats an earlier one', () => {
  it('a late round whose findings all repeat queues no answer and stops', async () => {
    const fixed = fixture()
    await reviewRound(fixed, sha('b'), [THE_FINDING])
    expect(answersOfThePr(fixed)).toBe(1)

    await reviewRound(fixed, sha('c'), [`Still open: ${THE_FINDING}`])

    expect(answersOfThePr(fixed)).toBe(0)
    expect(closedByRounds(fixed.bench.db, fixed.bench.clock.now().toISOString(), 'answer', PR, sha('c'))).toBe(true)
    expect(eventsOf(fixed.bench.db, REVIEW_ROUNDS_SPENT)).toEqual([expect.objectContaining({ state: REPEAT_FINDINGS, pr: PR, rounds: 2 })])
    expect(fixed.notes).toEqual([[PR, repeatStopLine(PR)]])
    expect(fixed.recuts).toEqual([expect.objectContaining({ kind: 'owner_wait', pr: PR })])
  })

  it('a late round with one new finding queues an answer', async () => {
    const fixed = fixture()
    await reviewRound(fixed, sha('b'), [THE_FINDING])
    await reviewRound(fixed, sha('c'), [`Still open: ${THE_FINDING}`, A_NEW_FINDING])

    expect(answersOfThePr(fixed)).toBe(1)
    expect(changesRoundsOf(fixed.bench.db, PR)).toBe(2)
    expect(eventsOf(fixed.bench.db, REVIEW_ROUNDS_SPENT)).toEqual([])
    expect(fixed.recuts).toEqual([])
  })

  it('a first changes round never stops on a repeat', async () => {
    const fixed = fixture()
    await reviewRound(fixed, sha('b'), [`Still open: ${THE_FINDING}`])

    expect(answersOfThePr(fixed)).toBe(1)
    expect(eventsOf(fixed.bench.db, REVIEW_RECORDED)).toHaveLength(1)
    expect(eventsOf(fixed.bench.db, REVIEW_ROUNDS_SPENT)).toEqual([])
    expect(allFindingsRepeat([`Still open: ${THE_FINDING}`], [])).toBe(false)
  })

  it('a verification note does not count as a repeat', async () => {
    const fixed = fixture()
    await reviewRound(fixed, sha('b'), [THE_FINDING, A_NOTE])
    await reviewRound(fixed, sha('c'), [A_NOTE])

    expect(answersOfThePr(fixed)).toBe(1)
    expect(eventsOf(fixed.bench.db, REVIEW_ROUNDS_SPENT)).toEqual([])
    expect(allFindingsRepeat([A_NOTE], [[A_NOTE]])).toBe(false)
    expect(allFindingsRepeat([THE_FINDING, A_NOTE], [[THE_FINDING, A_NOTE]])).toBe(false)
  })

  it('a repeat right after an owner amend answers, the card it was found against has changed', async () => {
    const fixed = fixture()
    await reviewRound(fixed, sha('b'), [THE_FINDING])
    admit(fixed.bench, cardText('owner', ['Amended by the owner.']), AMEND_SOURCE)
    await reviewRound(fixed, sha('c'), [`Still open: ${THE_FINDING}`])

    expect(answersOfThePr(fixed)).toBe(1)
    expect(eventsOf(fixed.bench.db, REVIEW_ROUNDS_SPENT)).toEqual([])
    expect(fixed.recuts).toEqual([])
  })

  it('a second review of one head repeats nothing, the push has not been tried', async () => {
    const fixed = fixture()
    await reviewRound(fixed, sha('b'), [THE_FINDING])
    fixed.bench.gitHub.open({ number: PR, head: sha('b'), body: `${cardBody(PR, fixed.decision)}\n\nAmended.` })
    fixed.bench.tick()
    await fixed.worker.step()

    expect(answersOfThePr(fixed)).toBe(1)
    expect(eventsOf(fixed.bench.db, REVIEW_ROUNDS_SPENT)).toEqual([])
  })

  it('a card the bus may re-cut is cut at the repeat, and its new pull request starts with no rounds', async () => {
    const fixed = fixture('auto')
    await reviewRound(fixed, sha('b'), [THE_FINDING])
    await reviewRound(fixed, sha('c'), [`Still open: ${THE_FINDING}`])

    expect(fixed.recuts).toEqual([expect.objectContaining({ kind: 'recut', pr: PR + 1 })])
    expect(changesRoundsOf(fixed.bench.db, PR + 1)).toBe(0)
  })

  it('three rounds of different findings still reach the limit as the limit, not as a repeat', async () => {
    const fixed = fixture()
    await reviewRound(fixed, sha('b'), ['first thing entirely apart'])
    await reviewRound(fixed, sha('c'), ['second matter wholly unrelated'])
    await reviewRound(fixed, sha('d'), ['third subject with other words'])

    expect(fixed.notes).toEqual([[PR, roundLimitLine(PR, REVIEW_ROUNDS)]])
  })

  it('the stop closes the pull request it was recorded on, from the head it stopped on', async () => {
    const fixed = fixture()
    const review = (head: string): { head: string, verdict: string, card_body: null } => ({ head, verdict: 'changes', card_body: null })
    await reviewRound(fixed, sha('b'), [THE_FINDING])
    expect(changesRoundsOf(fixed.bench.db, PR)).toBe(1)
    expect(changesRoundsOf(fixed.bench.db, PR, review(sha('c')))).toBe(2)

    await reviewRound(fixed, sha('c'), [`Still open: ${THE_FINDING}`])

    expect(changesRoundsOf(fixed.bench.db, PR)).toBe(REVIEW_ROUNDS)
    expect(changesRoundsOf(fixed.bench.db, PR, review(sha('c')))).toBe(REVIEW_ROUNDS)
    expect(changesRoundsOf(fixed.bench.db, PR + 1)).toBe(0)
  })
})

describe('the rule of a repeat', () => {
  const NOTES: [string, boolean][] = [
    ['Verification note: the suite passes', true],
    ['Environment note, not a code finding: listen EPERM', true],
    ['Review environment note, not a defect: ps is blocked', true],
    ['Earlier environment note (not a code finding): passes', true],
    ['Design note accepted: findings go to stderr', true],
    ['Note for #842, not blocking here', true],
    ['**Verification note**: the suite passes', true],
    ['The PR\'s Open note names readSnapshot', false],
    ['scripts/note.ts has no test', false],
    ['Notable gap: no witness', false],
    ['Still open: the changeset is missing', false],
  ]

  it('tells a note from a finding by how the finding opens', () => {
    for (const [finding, note] of NOTES)
      expect(isNote(finding), finding).toBe(note)
  })

  it('counts a finding at the threshold and not below it', () => {
    expect(REPEAT_JACCARD).toBe(0.4)
    expect(jaccard('a b c d', 'a b c d')).toBe(1)
    expect(jaccard('', '')).toBe(0)
    expect(jaccard('a b c d e f', 'a b c d g h i j')).toBe(0.4)
    expect(allFindingsRepeat(['a b c d e f'], [['a b c d g h i j']])).toBe(true)
    expect(jaccard('a b c d', 'a b c e f g h')).toBeLessThan(REPEAT_JACCARD)
    expect(allFindingsRepeat(['a b c d'], [['a b c e f g h']])).toBe(false)
  })

  it('reads every earlier round, not only the last, and no earlier note', () => {
    expect(allFindingsRepeat([THE_FINDING], [[A_NEW_FINDING], [THE_FINDING]])).toBe(true)
    expect(allFindingsRepeat([THE_FINDING, A_NEW_FINDING], [[A_NEW_FINDING], [THE_FINDING]])).toBe(true)
    expect(allFindingsRepeat(['Still open: anything'], [[A_NOTE]])).toBe(false)
    expect(allFindingsRepeat([], [[THE_FINDING]])).toBe(false)
  })
})
