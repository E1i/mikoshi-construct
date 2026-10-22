import type { DatabaseSync } from 'node:sqlite'
import type { GhResponse, GitHubPut } from '../../bus/github.js'
import type { CardAdmit, RecutOutcome } from '../../bus/pr-close.js'
import type { MergeBench } from './merge-bench.js'
import { afterEach, describe, expect, it } from 'vitest'
import { parkingFileText, parseParkingFile } from '../../../src/card/parking.js'
import { goalOf } from '../../../src/commands/board/goal.js'
import { admittedRecord } from '../../../src/commands/intake/index.js'
import { appendCardEvent, WINDOW_LANE } from '../../bus/card-bodies.js'
import { appendEvent } from '../../bus/db.js'
import { RECUT_ACTOR, RoundLimitRecutter } from '../../bus/pr-close.js'
import { changesRoundsOf } from '../../bus/queue.js'
import { fullReview } from '../../bus/review-depth.js'
import { REVIEW_ROUNDS_SPENT, ReviewWorker } from '../../bus/review-worker.js'
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
const benches: MergeBench[] = []

afterEach(() => {
  for (const bench of benches.splice(0))
    bench.close()
})

interface CardTextOptions {
  decision?: string
  body?: string[]
  witness?: string
}

function cardText({ decision = 'auto', body = [], witness = 'pnpm exec vitest run tests/board.test.ts' }: CardTextOptions = {}): string {
  return parkingFileText({
    card: `#${CARD} a-card [implement/netwatch/M/cheap/${decision}] · depends — · blocks —`,
    branch: BRANCH,
    touches: [GOAL_FILE, 'docs/cli.md'],
    continue: 'stop',
    who: 'shift',
    body: ['Make the plan line right.', ...body, '', 'Witnesses:', `- ${witness}`].join('\n'),
  })
}

const SLICEABLE = ['seam: complexity — two concerns', `slice: 1 count — ${GOAL_FILE}`, 'slice: 2 docs — docs/cli.md · depends 1']

function admitCard(bench: MergeBench, text: string): void {
  const parsed = parseParkingFile(`${CARD}.md`, text)
  if (parsed.kind === 'refused')
    throw new Error(parsed.reason)
  const { event } = admittedRecord({ id: CARD, file: `${CARD}.md`, line: parsed.parked.task.card.line, who: parsed.parked.who, unclear: [], corrections: [], seam: [], risk: [], slices: [], text }, 'auto', bench.clock.now(), WINDOW_LANE)
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

function fixture(text: string, options: { decision?: string, admit?: CardAdmit } = {}): Fixture {
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
  const recutter = new RoundLimitRecutter({ db: bench.db, gitHub: bench.gitHub.client, post, patch: bench.gitHub.patch, clock: bench.clock.now, admit: options.admit })
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
      admitCard(fixed.bench, cardText({ body: [`Amended for ${head}.`] }))
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
    for (const at of [1, 2, 3])
      appendEvent(fixed.bench.db, { ts: fixed.bench.clock.now().toISOString(), type: WITNESS_RECORDED, actor: 'worker:witness:test', cardId: CARD, pr: PR, head: HEADS[0]!, dedupeKey: `${WITNESS_RECORDED}:red-${at}`, payload: { head: HEADS[0]!, verdict: 'red' }, legacy: false })
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
  })
})
