import type { DatabaseSync } from 'node:sqlite'
import type { GhResponse, GitHub, GitHubPut } from '../../bus/github.js'
import type { CardAdmit, RecutOutcome } from '../../bus/pr-close.js'
import type { MergeBench } from './merge-bench.js'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { parkingFileText, parseParkingFile } from '../../../src/card/parking.js'
import { goalOf } from '../../../src/commands/board/goal.js'
import { AMEND_SOURCE } from '../../../src/commands/intake/admit.js'
import { admittedRecord } from '../../../src/commands/intake/index.js'
import { appendCardEvent, WINDOW_LANE } from '../../bus/card-bodies.js'
import { appendEvent } from '../../bus/db.js'
import { parkedCardNumbers } from '../../bus/intake.js'
import { RoundLimitRecutter } from '../../bus/pr-close.js'
import { changesRoundsOf, RECUT_GRACE_MS } from '../../bus/queue.js'
import { fullReview } from '../../bus/review-depth.js'
import { REVIEW_ROUNDS_SPENT, ReviewWorker } from '../../bus/review-worker.js'
import { RECUT_ACTOR } from '../../bus/round-limit-decision.js'
import { CARD_ADMITTED, CARD_DROPPED, MERGE_DONE, OWNER_WAIT_OPENED, PLAN_ITEM_ADDED, PLAN_ITEM_LINKED, PLAN_OPENED, PR_CLOSED, PR_OPENED, REVIEW_RECORDED, WITNESS_RECORDED } from '../../core/events.js'
import { cardBody, sha } from './github-fake.js'
import { eventsOf, liveBench } from './merge-bench.js'

const PR = 970
const CARD = PR + 100
const BRANCH = `feat/card-${CARD}`
const FIRST_NEW_CARD = CARD + 1
const HEADS = [sha('b'), sha('c'), sha('d')]
const GOAL_FILE = 'src/commands/board/goal.ts'
const NARROW_FINDING = `${GOAL_FILE}:planLine prints the wrong count`
const ISSUES = 'repos/{owner}/{repo}/issues?'
const benches: MergeBench[] = []

afterEach(() => {
  for (const bench of benches.splice(0))
    bench.close()
})

interface CardTextOptions {
  decision?: string
  body?: string[]
  witness?: string
  touches?: string[]
}

function cardText({ decision = 'auto', body = [], witness = 'pnpm exec vitest run tests/board.test.ts', touches = [GOAL_FILE, 'docs/cli.md'] }: CardTextOptions = {}): string {
  return parkingFileText({
    card: `#${CARD} a-card [implement/netwatch/M/cheap/${decision}] · depends — · blocks —`,
    branch: BRANCH,
    touches,
    continue: 'stop',
    who: 'shift',
    body: ['Make the plan line right.', ...body, '', 'Witnesses:', `- ${witness}`].join('\n'),
  })
}

const SLICEABLE = ['seam: complexity — two concerns', `slice: 1 count — ${GOAL_FILE}`, 'slice: 2 docs — docs/cli.md · depends 1']

function admitCard(bench: MergeBench, text: string, source?: string): void {
  const parsed = parseParkingFile(`${CARD}.md`, text)
  if (parsed.kind === 'refused')
    throw new Error(parsed.reason)
  const { event } = admittedRecord({ id: CARD, file: `${CARD}.md`, line: parsed.parked.task.card.line, who: parsed.parked.who, unclear: [], corrections: [], seam: [], risk: [], slices: [], text }, 'auto', bench.clock.now(), WINDOW_LANE, source)
  appendCardEvent(bench.db, 'worker:intake:test', event)
  bench.tick()
}

interface Post {
  endpoint: string
  fields: Record<string, string>
}

interface Fixture {
  bench: MergeBench
  worker: ReviewWorker
  posts: Post[]
  outcomes: RecutOutcome[]
  reviewer: { verdict: 'changes' | 'pass', findings: string[] }
  decision: string
}

interface FixtureOptions {
  decision?: string
  admit?: CardAdmit
  latestOnGitHub?: GhResponse
  recutThrows?: boolean
  patch?: GitHubPut
  parked?: () => number[]
}

function fixture(text: string, options: FixtureOptions = {}): Fixture {
  const bench = liveBench()
  benches.push(bench)
  const posts: Post[] = []
  const outcomes: RecutOutcome[] = []
  const reviewer: Fixture['reviewer'] = { verdict: 'changes', findings: [] }
  const post: GitHubPut = (endpoint, fields): GhResponse => {
    posts.push({ endpoint, fields })
    const number = Math.max(...bench.gitHub.pulls.keys()) + 1
    bench.gitHub.open({ number, head: bench.gitHub.pulls.get(PR)!.head, ref: fields.head, body: fields.body })
    return { status: 201, headers: {}, body: { number } }
  }
  const gitHub: GitHub = endpoint => endpoint.startsWith(ISSUES) ? options.latestOnGitHub ?? { status: 200, headers: {}, body: [{ number: Math.max(...bench.gitHub.pulls.keys()) }] } : bench.gitHub.client(endpoint)
  const recutter = new RoundLimitRecutter({ db: bench.db, gitHub, post, patch: options.patch ?? bench.gitHub.patch, clock: bench.clock.now, parked: options.parked ?? (() => []), admit: options.admit })
  const worker = new ReviewWorker({
    isolation: () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] }),
    db: bench.db,
    gitHub: bench.gitHub.client,
    publish: bench.gitHub.publish,
    reviewer: async () => ({ verdict: reviewer.verdict, findings: reviewer.findings, session: 'reviewer-1' }),
    plan: () => fullReview('a fixed plan'),
    clock: bench.clock.now,
    session: 'worker-1',
    recut: { recut: (at) => {
      if (options.recutThrows === true)
        throw new Error('database is locked')
      const outcome = recutter.recut(at)
      outcomes.push(outcome)
      return outcome
    } },
  })
  admitCard(bench, text)
  return { bench, worker, posts, outcomes, reviewer, decision: options.decision ?? 'auto' }
}

async function reviewHead(fixed: Fixture, head: string): Promise<void> {
  fixed.bench.gitHub.open({ number: PR, head, body: cardBody(PR, fixed.decision) })
  fixed.bench.tick()
  expect(await fixed.worker.step()).toMatchObject({ kind: 'recorded' })
}

async function reviewToTheLimit(fixed: Fixture): Promise<void> {
  for (const head of HEADS)
    await reviewHead(fixed, head)
}

function admittedByTheRecut(db: DatabaseSync): { cardId: number, text: string, depends: unknown }[] {
  return (db.prepare(`SELECT card_id, payload FROM events WHERE type = ? AND actor = ? ORDER BY id`).all(CARD_ADMITTED, RECUT_ACTOR) as { card_id: number, payload: string }[])
    .map(row => ({ cardId: row.card_id, text: String((JSON.parse(row.payload) as { text: string }).text), depends: (JSON.parse(row.payload) as { depends: unknown }).depends }))
}

function recutOpened(db: DatabaseSync): { cardId: number, pr: number }[] {
  return (db.prepare(`SELECT card_id, pr FROM events WHERE type = ? AND actor = ? ORDER BY id`).all(PR_OPENED, RECUT_ACTOR) as { card_id: number, pr: number }[]).map(row => ({ cardId: row.card_id, pr: row.pr }))
}

function recordRed(bench: MergeBench, head: string, at: number): void {
  appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: WITNESS_RECORDED, actor: 'worker:witness:test', cardId: CARD, pr: PR, head, dedupeKey: `${WITNESS_RECORDED}:red-${head}-${at}`, payload: { head, verdict: 'red' }, legacy: false })
}

function ownerWaits(db: DatabaseSync): string[] {
  return eventsOf(db, OWNER_WAIT_OPENED).map(payload => String(payload.text))
}

function merges(bench: MergeBench): unknown[] {
  return bench.gitHub.puts.filter(put => put.endpoint.endsWith('/merge'))
}

function untouched(fixed: Fixture): void {
  expect(fixed.bench.gitHub.pulls.get(PR)!.state).toBe('open')
  expect(fixed.bench.gitHub.closes).toEqual([])
  expect(fixed.posts).toEqual([])
  expect(admittedByTheRecut(fixed.bench.db)).toEqual([])
}

describe('the re-cut of a pull request at the review round limit', () => {
  it('three changes with one narrow finding naming its place narrow the card, cut a new card, re-cut the PR and merge nothing', async () => {
    const fixed = fixture(cardText())
    fixed.reviewer.findings = [NARROW_FINDING]
    await reviewToTheLimit(fixed)

    expect(eventsOf(fixed.bench.db, REVIEW_ROUNDS_SPENT)).toHaveLength(1)
    const admitted = admittedByTheRecut(fixed.bench.db)
    expect(admitted.map(card => card.cardId)).toEqual([CARD, FIRST_NEW_CARD])
    expect(admitted[0]!.text).toContain('narrowed: ')
    expect(admitted[1]!.depends).toEqual([CARD])
    expect(fixed.bench.gitHub.closes).toEqual([{ pr: PR, fields: { state: 'closed' } }])
    expect(fixed.posts).toHaveLength(1)
    expect(fixed.posts[0]!.fields.head).toBe(BRANCH)
    expect(recutOpened(fixed.bench.db)).toEqual([{ cardId: CARD, pr: PR + 1 }])
    expect(fixed.outcomes).toEqual([expect.objectContaining({ kind: 'recut', pr: PR + 1, cards: [CARD, FIRST_NEW_CARD], carrier: CARD })])
    expect(merges(fixed.bench)).toEqual([])
  })

  it('a finding with no unambiguous place or touching the goal witness slices the card with Shredder', async () => {
    const unplaced = ['the count is wrong somewhere']
    const witnessed = [`${GOAL_FILE}:planLine prints the wrong count`]
    for (const [findings, witness] of [[unplaced, undefined], [witnessed, `pnpm exec eslint ${GOAL_FILE}`]] as const) {
      const fixed = fixture(cardText({ body: SLICEABLE, witness }))
      fixed.reviewer.findings = findings
      await reviewToTheLimit(fixed)

      const admitted = admittedByTheRecut(fixed.bench.db)
      expect(admitted.map(card => card.cardId), findings.join()).toEqual([FIRST_NEW_CARD, FIRST_NEW_CARD + 1])
      expect(admitted[0]!.text).toContain(`branch: ${BRANCH}\n`)
      expect(admitted[1]!.text).toContain(`branch: ${BRANCH}-2\n`)
      expect(admitted[1]!.depends).toEqual([FIRST_NEW_CARD])
      expect(eventsOf(fixed.bench.db, CARD_DROPPED)).toEqual([expect.objectContaining({ lane: 'superseded', recut: PR })])
      expect(fixed.bench.gitHub.closes).toEqual([{ pr: PR, fields: { state: 'closed' } }])
      expect(fixed.posts.map(each => each.fields.head)).toEqual([BRANCH])
      expect(recutOpened(fixed.bench.db)).toEqual([{ cardId: FIRST_NEW_CARD, pr: PR + 1 }])
    }
  })

  it('two changes from owner amends and one ordinary changes do not reach the limit', async () => {
    const fixed = fixture(cardText())
    fixed.reviewer.findings = [NARROW_FINDING]
    await reviewHead(fixed, HEADS[0]!)
    for (const head of HEADS.slice(1)) {
      admitCard(fixed.bench, cardText({ body: [`Amended for ${head}.`] }), AMEND_SOURCE)
      await reviewHead(fixed, head)
    }

    expect(eventsOf(fixed.bench.db, REVIEW_RECORDED)).toHaveLength(3)
    expect(changesRoundsOf(fixed.bench.db, PR)).toBe(1)
    expect(eventsOf(fixed.bench.db, REVIEW_ROUNDS_SPENT)).toEqual([])
    expect(fixed.outcomes).toEqual([])
    untouched(fixed)
  })

  it('three red witnesses without a changes review start no re-cut and open the owner wait to check the proof mechanism', () => {
    const fixed = fixture(cardText())
    fixed.bench.gitHub.open({ number: PR, head: HEADS[0]!, body: cardBody(PR) })
    fixed.bench.tick()
    for (const at of [1, 2, 3])
      recordRed(fixed.bench, HEADS[0]!, at)
    fixed.bench.tick()
    fixed.bench.tick()

    const waits = ownerWaits(fixed.bench.db)
    expect(waits).toHaveLength(1)
    expect(waits[0]).toContain('check the proof mechanism')
    expect(eventsOf(fixed.bench.db, REVIEW_ROUNDS_SPENT)).toEqual([])
    expect(eventsOf(fixed.bench.db, PR_CLOSED)).toEqual([])
    expect(fixed.outcomes).toEqual([])
    untouched(fixed)
  })

  it('a failure creating a sub-card leaves the original PR open, the branch intact and an owner wait', async () => {
    const refusals: CardAdmit[] = [
      () => {
        throw new Error('the bus refused the second card')
      },
      () => false,
    ]
    for (const refuse of refusals) {
      let admitted = 0
      const fixed = fixture(cardText(), { admit: (event) => {
        admitted += 1
        if (admitted === 2)
          return refuse(event)
        return appendCardEvent(benches.at(-1)!.db, RECUT_ACTOR, event)
      } })
      fixed.reviewer.findings = [NARROW_FINDING]
      await reviewToTheLimit(fixed)

      untouched(fixed)
      expect(admitted).toBe(2)
      expect(fixed.outcomes).toEqual([expect.objectContaining({ kind: 'owner_wait', pr: PR })])
      expect(ownerWaits(fixed.bench.db)).toEqual([expect.stringContaining(`PR #${PR}`)])
      expect(fixed.bench.gitHub.pulls.get(PR)!.head).toBe(HEADS[2])
    }
  })

  it('the new PR after a re-cut has no pass until a new review', async () => {
    const fixed = fixture(cardText())
    fixed.reviewer.findings = [NARROW_FINDING]
    await reviewToTheLimit(fixed)
    const recutPr = PR + 1
    fixed.bench.tick()
    fixed.bench.tick()
    const verdictOnHead = (): unknown => (fixed.bench.db.prepare('SELECT verdict_on_head FROM prs WHERE pr = ?').get(recutPr) as { verdict_on_head: string | null }).verdict_on_head
    const queued = (queue: string): unknown[] => fixed.bench.db.prepare(`SELECT task_key FROM tasks WHERE pr = ? AND queue = ? AND state = 'queued'`).all(recutPr, queue)
    const reviewsOfTheRecutPr = (): unknown[] => fixed.bench.db.prepare('SELECT id FROM events WHERE type = ? AND pr = ?').all(REVIEW_RECORDED, recutPr)

    expect(verdictOnHead()).not.toBe('pass')
    expect(queued('merge')).toEqual([])
    expect(reviewsOfTheRecutPr()).toEqual([])
    expect(eventsOf(fixed.bench.db, MERGE_DONE)).toEqual([])
    expect(merges(fixed.bench)).toEqual([])
  })

  it('an owner PR at the limit opens an owner wait', async () => {
    const fixed = fixture(cardText({ decision: 'owner' }), { decision: 'owner' })
    fixed.reviewer.findings = [NARROW_FINDING]
    await reviewToTheLimit(fixed)

    expect(fixed.outcomes).toEqual([expect.objectContaining({ kind: 'owner_wait', pr: PR })])
    expect(ownerWaits(fixed.bench.db)).toEqual([expect.stringContaining('owner card')])
    untouched(fixed)
  })

  it('a re-cut card linked to plan item X links every new card to X in the same transaction and the slices without cards do not grow', async () => {
    const fixed = fixture(cardText({ body: SLICEABLE }))
    const { db } = fixed.bench
    const now = fixed.bench.clock.now
    const owner = (type: string, cardId: number | null, payload: Record<string, unknown>): void => {
      appendEvent(db, { ts: now().toISOString(), type, actor: 'owner', cardId, pr: null, head: null, dedupeKey: `${type}:${JSON.stringify(payload)}`, payload, legacy: false })
    }
    owner(PLAN_OPENED, null, { id: 'p-1', title: 'Plan', goal: 'a goal', plan_file: '/plans/p-1.md' })
    owner(PLAN_ITEM_ADDED, null, { plan: 'p-1', item: 'X', title: 'item x' })
    owner(PLAN_ITEM_ADDED, null, { plan: 'p-1', item: 'Y', title: 'item y' })
    owner(PLAN_ITEM_LINKED, CARD, { plan: 'p-1', item: 'X', card: CARD })
    fixed.bench.tick()
    const cardsOf = (item: string): unknown => JSON.parse((db.prepare('SELECT cards FROM plan_items WHERE plan_id = ? AND item_id = ?').get('p-1', item) as { cards: string }).cards)
    const notCreated = (): number | undefined => goalOf(db as never, now())?.plans[0]!.stages.not_created
    const before = notCreated()

    fixed.reviewer.findings = ['the count is wrong somewhere']
    await reviewToTheLimit(fixed)
    fixed.bench.tick()

    expect(before).toBe(1)
    expect(notCreated()).toBe(before)
    expect(cardsOf('X')).toEqual([CARD, FIRST_NEW_CARD, FIRST_NEW_CARD + 1])
    expect(cardsOf('Y')).toEqual([])
    const linkedAt = (cardId: number): number => (db.prepare('SELECT id FROM events WHERE type = ? AND card_id = ?').get(PLAN_ITEM_LINKED, cardId) as { id: number }).id
    const admittedAt = (cardId: number): number => (db.prepare('SELECT id FROM events WHERE type = ? AND card_id = ? AND actor = ?').get(CARD_ADMITTED, cardId, RECUT_ACTOR) as { id: number }).id
    for (const cardId of [FIRST_NEW_CARD, FIRST_NEW_CARD + 1])
      expect(linkedAt(cardId)).toBeGreaterThan(admittedAt(cardId))
    const linkActors = db.prepare('SELECT DISTINCT actor FROM events WHERE type = ? AND card_id IN (?, ?)').all(PLAN_ITEM_LINKED, FIRST_NEW_CARD, FIRST_NEW_CARD + 1) as { actor: string }[]
    expect(linkActors).toEqual([{ actor: RECUT_ACTOR }])
  })

  it('two red witnesses on a merged PR, a closed PR or an earlier head open no wait to check the proof mechanism', () => {
    for (const merged of [true, false]) {
      const fixed = fixture(cardText())
      fixed.bench.gitHub.open({ number: PR, head: HEADS[0]!, body: cardBody(PR) })
      fixed.bench.tick()
      fixed.bench.gitHub.close(PR, merged)
      fixed.bench.tick()
      for (const at of [1, 2])
        recordRed(fixed.bench, HEADS[0]!, at)
      fixed.bench.tick()
      fixed.bench.tick()

      expect(ownerWaits(fixed.bench.db), `merged: ${merged}`).toEqual([])
    }
    const moved = fixture(cardText())
    moved.bench.gitHub.open({ number: PR, head: HEADS[0]!, body: cardBody(PR) })
    moved.bench.tick()
    moved.bench.gitHub.open({ number: PR, head: HEADS[1]!, body: cardBody(PR) })
    moved.bench.tick()
    for (const at of [1, 2])
      recordRed(moved.bench, HEADS[0]!, at)
    moved.bench.tick()
    moved.bench.tick()

    expect(ownerWaits(moved.bench.db)).toEqual([])
  })

  it('an R1 card at the limit opens an owner wait and is not re-cut', async () => {
    const fixed = fixture(cardText({ touches: ['scripts/bus/queue.ts'], body: SLICEABLE }))
    fixed.reviewer.findings = ['scripts/bus/queue.ts:roundsOf counts the wrong review']
    await reviewToTheLimit(fixed)

    expect(fixed.outcomes).toEqual([expect.objectContaining({ kind: 'owner_wait', pr: PR, why: expect.stringContaining('is R1') })])
    expect(ownerWaits(fixed.bench.db)).toEqual([expect.stringContaining('is R1')])
    untouched(fixed)
  })

  it('a close of the old PR that is refused after the cards are admitted opens no new PR and one owner wait', async () => {
    const answers: GitHubPut[] = [
      () => ({ status: 500, headers: {}, body: null }),
      () => {
        throw new Error('connection reset')
      },
    ]
    for (const patch of answers) {
      const fixed = fixture(cardText(), { patch })
      fixed.reviewer.findings = [NARROW_FINDING]
      await reviewToTheLimit(fixed)

      expect(admittedByTheRecut(fixed.bench.db).map(card => card.cardId)).toEqual([CARD, FIRST_NEW_CARD])
      expect(fixed.posts).toEqual([])
      expect(eventsOf(fixed.bench.db, PR_CLOSED)).toEqual([])
      expect(fixed.bench.gitHub.pulls.get(PR)!.state).toBe('open')
      expect(fixed.outcomes).toEqual([expect.objectContaining({ kind: 'owner_wait', pr: PR })])
      expect(ownerWaits(fixed.bench.db)).toEqual([expect.stringContaining(`PR #${PR} was not closed`)])
    }
  })

  it('an admit that reports a card admitted the bus does not hold leaves the PR untouched behind an owner wait', async () => {
    const fixed = fixture(cardText(), { admit: () => true })
    fixed.reviewer.findings = [NARROW_FINDING]
    await reviewToTheLimit(fixed)

    untouched(fixed)
    expect(ownerWaits(fixed.bench.db)).toEqual([expect.stringContaining(`the bus holds no card.admitted of #${CARD}, #${FIRST_NEW_CARD}`)])
  })

  it('a number held by a parked card is not given to a re-cut card', async () => {
    const fixed = fixture(cardText(), { parked: () => [CARD + 7] })
    fixed.reviewer.findings = [NARROW_FINDING]
    await reviewToTheLimit(fixed)

    expect(admittedByTheRecut(fixed.bench.db).map(card => card.cardId)).toEqual([CARD, CARD + 8])
  })

  it('a parking that cannot be read allocates no card and leaves the PR untouched behind an owner wait', async () => {
    const fixed = fixture(cardText(), { parked: parkedCardNumbers(path.join(os.tmpdir(), `no-parking-${process.pid}-${Date.now()}`)) })
    fixed.reviewer.findings = [NARROW_FINDING]
    await reviewToTheLimit(fixed)

    untouched(fixed)
    expect(ownerWaits(fixed.bench.db)).toEqual([expect.stringContaining('cannot be read, so no card number is allocated')])
  })

  it('a change of the card body that is not an owner amend still spends a round', async () => {
    const fixed = fixture(cardText())
    fixed.reviewer.findings = [NARROW_FINDING]
    await reviewHead(fixed, HEADS[0]!)
    for (const head of HEADS.slice(1)) {
      admitCard(fixed.bench, cardText({ body: [`Rewritten for ${head}.`] }))
      await reviewHead(fixed, head)
    }

    expect(changesRoundsOf(fixed.bench.db, PR)).toBe(3)
    expect(eventsOf(fixed.bench.db, REVIEW_ROUNDS_SPENT)).toHaveLength(1)
  })

  it('a number taken on GitHub above the bus maximum is not given to a re-cut card', async () => {
    const fixed = fixture(cardText(), { latestOnGitHub: { status: 200, headers: {}, body: [{ number: CARD + 40 }] } })
    fixed.reviewer.findings = [NARROW_FINDING]
    await reviewToTheLimit(fixed)

    expect(admittedByTheRecut(fixed.bench.db).map(card => card.cardId)).toEqual([CARD, CARD + 41])
  })

  it('gitHub numbers that cannot be read allocate no card and leave the PR untouched behind an owner wait', async () => {
    const fixed = fixture(cardText(), { latestOnGitHub: { status: 502, headers: {}, body: null } })
    fixed.reviewer.findings = [NARROW_FINDING]
    await reviewToTheLimit(fixed)

    untouched(fixed)
    expect(ownerWaits(fixed.bench.db)).toEqual([expect.stringContaining('GitHub answered 502')])
  })

  it('a re-cut that stops before its outcome is recorded gets an owner wait from the queue once its grace is over', async () => {
    const fixed = fixture(cardText(), { recutThrows: true })
    fixed.reviewer.findings = [NARROW_FINDING]
    await reviewToTheLimit(fixed)
    fixed.bench.tick()

    expect(eventsOf(fixed.bench.db, REVIEW_ROUNDS_SPENT)).toHaveLength(1)
    expect(ownerWaits(fixed.bench.db)).toEqual([])
    fixed.bench.clock.advance(RECUT_GRACE_MS)
    fixed.bench.tick()
    fixed.bench.tick()

    expect(ownerWaits(fixed.bench.db)).toEqual([expect.stringContaining(`PR #${PR} reached the review round limit (D-104), and the bus holds neither its re-cut nor an owner wait`)])
    untouched(fixed)
  })

  it('a re-cut that ended in its own owner wait or a new PR gets no second wait from the queue', async () => {
    for (const findings of [[NARROW_FINDING], ['the count is wrong somewhere']]) {
      const fixed = fixture(cardText())
      fixed.reviewer.findings = findings
      await reviewToTheLimit(fixed)
      const waits = ownerWaits(fixed.bench.db).length
      expect(fixed.outcomes.map(outcome => outcome.kind)).toEqual([findings[0] === NARROW_FINDING ? 'recut' : 'owner_wait'])
      fixed.bench.clock.advance(RECUT_GRACE_MS)
      fixed.bench.tick()

      expect(ownerWaits(fixed.bench.db)).toHaveLength(waits)
    }
  })
})
