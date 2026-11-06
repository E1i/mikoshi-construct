import type { RecutOutcome } from '../../nodes/review/pr-close.js'
import type { GhResponse, GitHub, GitHubPut } from '../../ports/github.js'
import type { MergeBench } from './merge-bench.js'
import { afterEach, describe, expect, it } from 'vitest'
import { parkingFileText, parseParkingFile } from '../../../src/card/parking.js'
import { witnessesOf } from '../../../src/commands/intake/admit.js'
import { admittedRecord } from '../../../src/commands/intake/index.js'
import { appendCardEvent, cardBodyText, WINDOW_LANE } from '../../core/card-bodies.js'
import { appendEvent } from '../../core/db.js'
import { CARD_ADMITTED, OWNER_WAIT_OPENED, ROUND_EXTENDED, ROUND_MUTATIONS_PARKED, SHARD_ISSUED } from '../../core/events.js'
import { changesRoundsOf, closedByRounds, mergeDecidedPastRoundLimit, RECUT_GRACE_MS, REPEAT_FINDINGS, REVIEW_ROUNDS } from '../../core/queue.js'
import { busHeldCards } from '../../intake/intake.js'
import { RoundLimitRecutter } from '../../nodes/review/pr-close.js'
import { fullReview } from '../../nodes/review/review-depth.js'
import { REVIEW_ROUNDS_SPENT, ReviewWorker } from '../../nodes/review/review-worker.js'
import { reviewOf, reviewPrompt } from '../../nodes/review/reviewer.js'
import { cardWitnessesOf } from '../../policy/policy.js'
import { limitRuleOf, mutationsParkedGrantOf, PARKED_MUTATION_PREFIX, RECUT_ACTOR, sameFindings } from '../../policy/round-limit-decision.js'
import { cardBody, sha } from './github-fake.js'
import { eventsOf, liveBench } from './merge-bench.js'

const PR = 975
const CARD = PR + 100
const BRANCH = `feat/card-${CARD}`
const FILE = 'scripts/a.ts'
const OTHER_FILE = 'scripts/b.ts'
const HEADS = [sha('b'), sha('c'), sha('d')]
const NEXT_HEAD = sha('e')
const LAST_HEAD = sha('f')
const MUTATION = `${FILE}:run: flipping the comparison survives the suite`
const DEFECT = `${FILE}:run drops the second row`
const benches: MergeBench[] = []

afterEach(() => {
  for (const bench of benches.splice(0))
    bench.close()
})

function cardText(id: number, depends = '—', touches = [FILE, OTHER_FILE], decision = 'auto'): string {
  return parkingFileText({
    card: `#${id} a-card [implement/netwatch/M/cheap/${decision}] · depends ${depends} · blocks —`,
    branch: `feat/card-${id}`,
    touches,
    continue: 'stop',
    who: 'shift',
    body: ['Make it right.', '', 'Witnesses:', '- pnpm exec vitest run tests/a.test.ts', '', 'Trailing note.'].join('\n'),
  })
}

interface Fixture {
  bench: MergeBench
  worker: ReviewWorker
  outcomes: RecutOutcome[]
  reviewer: { findings: string[], survivingMutations?: string[] }
}

function admit(bench: MergeBench, id: number, text: string): void {
  const parsed = parseParkingFile(`${id}.md`, text)
  if (parsed.kind === 'refused')
    throw new Error(parsed.reason)
  appendCardEvent(bench.db, 'worker:intake:test', admittedRecord({ id, file: `${id}.md`, line: parsed.parked.task.card.line, who: parsed.parked.who, unclear: [], corrections: [], seam: [], risk: [], slices: [], text }, 'auto', bench.clock.now(), WINDOW_LANE))
  bench.tick()
}

function fixture(shard = true, text = cardText(CARD)): Fixture {
  const bench = liveBench()
  benches.push(bench)
  const outcomes: RecutOutcome[] = []
  const reviewer: Fixture['reviewer'] = { findings: [] }
  const post: GitHubPut = (endpoint, fields): GhResponse => {
    const number = Math.max(...bench.gitHub.pulls.keys()) + 1
    bench.gitHub.open({ number, head: bench.gitHub.pulls.get(PR)!.head, ref: fields.head, body: fields.body })
    return { status: 201, headers: {}, body: { number } }
  }
  const gitHub: GitHub = endpoint => endpoint.includes('/issues?') ? { status: 200, headers: {}, body: [{ number: Math.max(...bench.gitHub.pulls.keys()) }] } : bench.gitHub.client(endpoint)
  const recutter = new RoundLimitRecutter({ db: bench.db, gitHub, post, patch: bench.gitHub.patch, clock: bench.clock.now, cardStates: () => busHeldCards(bench.db) })
  const worker = new ReviewWorker({
    isolation: () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] }),
    db: bench.db,
    gitHub: bench.gitHub.client,
    publish: bench.gitHub.publish,
    reviewer: async () => ({ verdict: 'changes', findings: reviewer.findings, ...(reviewer.survivingMutations === undefined ? {} : { survivingMutations: reviewer.survivingMutations }), session: 'reviewer-1' }),
    plan: () => fullReview('a fixed plan'),
    clock: bench.clock.now,
    session: 'worker-1',
    recut: { recut: (at) => {
      const outcome = recutter.recut(at)
      outcomes.push(outcome)
      return outcome
    } },
  })
  if (shard)
    appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: SHARD_ISSUED, actor: 'owner', cardId: null, pr: null, head: null, dedupeKey: `${SHARD_ISSUED}:ws-1`, payload: { id: 'ws-1', by: 'Eli', scope: 'merge+decisions', until: new Date(bench.clock.now().getTime() + 6 * 3_600_000).toISOString(), window: 1 }, legacy: false })
  admit(bench, CARD, text)
  return { bench, worker, outcomes, reviewer }
}

async function reviewHead(fixed: Fixture, head: string, findings: string[], survivingMutations?: string[]): Promise<void> {
  fixed.reviewer.findings = findings
  fixed.reviewer.survivingMutations = survivingMutations
  fixed.bench.gitHub.open({ number: PR, head, ref: BRANCH, body: cardBody(PR) })
  fixed.bench.tick()
  expect(await fixed.worker.step()).toMatchObject({ kind: 'recorded' })
}

const EARLIER_ROUNDS = ['something else came up', 'an earlier finding']

async function toTheLimit(fixed: Fixture, last: string[], survivingMutations?: string[], before = EARLIER_ROUNDS): Promise<void> {
  for (const [at, head] of HEADS.slice(0, -1).entries())
    await reviewHead(fixed, head, [before[at]!])
  await reviewHead(fixed, HEADS.at(-1)!, last, survivingMutations)
}

function ts(fixed: Fixture): string {
  return fixed.bench.clock.now().toISOString()
}

function limited(fixed: Fixture, head: string): boolean[] {
  return (['review', 'answer'] as const).map(queue => closedByRounds(fixed.bench.db, ts(fixed), queue, PR, head))
}

function waits(fixed: Fixture): number {
  return eventsOf(fixed.bench.db, OWNER_WAIT_OPENED).length
}

function admittedByTheBus(fixed: Fixture): { id: number, text: string, depends: unknown }[] {
  return (fixed.bench.db.prepare(`SELECT card_id, payload FROM events WHERE type = ? AND actor = ? ORDER BY id`).all(CARD_ADMITTED, RECUT_ACTOR) as { card_id: number, payload: string }[])
    .map((row) => {
      const payload = JSON.parse(row.payload) as { text: string, depends: unknown }
      return { id: row.card_id, text: payload.text, depends: payload.depends }
    })
}

describe('changing findings at the round limit under a decisions shard', () => {
  it('changing findings extend one round', async () => {
    const fixed = fixture()
    await toTheLimit(fixed, [DEFECT])
    fixed.bench.tick()

    expect(eventsOf(fixed.bench.db, ROUND_EXTENDED)).toEqual([{ pr: PR, findings: [DEFECT], previous: ['an earlier finding'] }])
    expect(eventsOf(fixed.bench.db, REVIEW_ROUNDS_SPENT)).toEqual([])
    expect(changesRoundsOf(fixed.bench.db, PR)).toBe(REVIEW_ROUNDS - 1)
    expect(limited(fixed, HEADS.at(-1)!)).toEqual([false, false])
    expect(limited(fixed, NEXT_HEAD)).toEqual([false, false])
    expect(waits(fixed)).toBe(0)
    expect(fixed.outcomes).toEqual([])
  })

  it('extension survives a new head', async () => {
    const fixed = fixture()
    await toTheLimit(fixed, [DEFECT])
    fixed.bench.gitHub.open({ number: PR, head: NEXT_HEAD, ref: BRANCH, body: cardBody(PR) })
    fixed.bench.tick()
    fixed.bench.gitHub.open({ number: PR, head: LAST_HEAD, ref: BRANCH, body: cardBody(PR) })
    fixed.bench.tick()

    expect(limited(fixed, NEXT_HEAD)).toEqual([false, false])
    expect(limited(fixed, LAST_HEAD)).toEqual([false, false])
    expect(eventsOf(fixed.bench.db, ROUND_EXTENDED)).toHaveLength(1)
  })

  it('repeat second extension and no shard go to the owner', async () => {
    const repeated = fixture(true, cardText(CARD, '—', [FILE, OTHER_FILE], 'owner'))
    await toTheLimit(repeated, [` ${DEFECT} `], undefined, [EARLIER_ROUNDS[0]!, DEFECT])
    const unshared = fixture(false, cardText(CARD, '—', [FILE, OTHER_FILE], 'owner'))
    await toTheLimit(unshared, [DEFECT])
    const twice = fixture(true, cardText(CARD, '—', [FILE, OTHER_FILE], 'owner'))
    await toTheLimit(twice, [DEFECT])
    await reviewHead(twice, NEXT_HEAD, ['a third finding'])

    for (const fixed of [repeated, unshared]) {
      expect(eventsOf(fixed.bench.db, ROUND_EXTENDED)).toEqual([])
      expect(eventsOf(fixed.bench.db, REVIEW_ROUNDS_SPENT)).toHaveLength(1)
      expect(fixed.outcomes).toEqual([expect.objectContaining({ kind: 'owner_wait', pr: PR })])
      expect(limited(fixed, HEADS.at(-1)!)).toEqual([true, true])
    }
    expect(eventsOf(twice.bench.db, ROUND_EXTENDED)).toHaveLength(1)
    expect(eventsOf(twice.bench.db, REVIEW_ROUNDS_SPENT)).toHaveLength(1)
    expect(twice.outcomes).toEqual([expect.objectContaining({ kind: 'owner_wait', pr: PR })])
    expect(limited(twice, NEXT_HEAD)).toEqual([true, true])
  })

  it('a reworded repeat at the limit spends no extension and goes to the owner', async () => {
    const fixed = fixture(true, cardText(CARD, '—', [FILE, OTHER_FILE], 'owner'))
    await toTheLimit(fixed, ['Still open: an earlier finding'])

    expect(eventsOf(fixed.bench.db, ROUND_EXTENDED)).toEqual([])
    expect(eventsOf(fixed.bench.db, REVIEW_ROUNDS_SPENT)).toEqual([expect.objectContaining({ state: REPEAT_FINDINGS, rounds: REVIEW_ROUNDS })])
    expect(fixed.outcomes).toEqual([expect.objectContaining({ kind: 'owner_wait', pr: PR })])
    expect(limited(fixed, HEADS.at(-1)!)).toEqual([true, true])
  })

  it('compares findings as trimmed sets, so a reworded finding is new', () => {
    expect(sameFindings([' a', 'b '], ['b', 'a', 'a'])).toBe(true)
    expect(sameFindings(['a'], ['a, reworded'])).toBe(false)
    expect(sameFindings(['a', 'b'], ['a'])).toBe(false)
  })
})

describe('surviving mutations at the round limit under a decisions shard', () => {
  it('a surviving mutation at the limit allows merge and parks a continuation card', async () => {
    const fixed = fixture()
    await toTheLimit(fixed, [MUTATION], [MUTATION])
    fixed.bench.clock.advance(RECUT_GRACE_MS + 1)
    fixed.bench.tick()
    const head = HEADS.at(-1)!
    const [card] = admittedByTheBus(fixed)

    expect(eventsOf(fixed.bench.db, ROUND_EXTENDED)).toEqual([])
    expect(eventsOf(fixed.bench.db, ROUND_MUTATIONS_PARKED)).toEqual([{ pr: PR, head, mutations: [MUTATION], card: card!.id }])
    expect(card!.id).toBeGreaterThan(PR)
    expect(card!.depends).toEqual([CARD])
    const parsed = parseParkingFile(`${card!.id}.md`, card!.text)
    expect(parsed).toMatchObject({ kind: 'parked', parked: { task: { touches: [FILE, OTHER_FILE], card: { size: 'XS', depends: [CARD] } } } })
    expect(witnessesOf(card!.text)).toEqual([`${PARKED_MUTATION_PREFIX}${MUTATION}`])
    expect(mergeDecidedPastRoundLimit(fixed.bench.db, ts(fixed), PR, head)).not.toBeNull()
    expect(closedByRounds(fixed.bench.db, ts(fixed), 'merge', PR, head)).toBe(false)
    expect(limited(fixed, head)).toEqual([true, true])
    expect(mergeDecidedPastRoundLimit(fixed.bench.db, ts(fixed), PR, NEXT_HEAD)).toBeNull()
    expect(waits(fixed)).toBe(0)
    expect(fixed.outcomes).toEqual([{ kind: 'parked', pr: PR, card: card!.id }])
    expect(fixed.bench.gitHub.closes).toEqual([])
    expect(cardBodyText(fixed.bench.db, CARD)).toBe(cardText(CARD))
  })

  it('an existing continuation card takes the mutation', async () => {
    const fixed = fixture()
    const dependent = CARD + 1
    admit(fixed.bench, dependent, cardText(dependent, `#${CARD}`))
    await toTheLimit(fixed, [MUTATION], [MUTATION])
    fixed.bench.tick()
    const admitted = admittedByTheBus(fixed)

    expect(admitted.map(card => card.id)).toEqual([dependent])
    expect(witnessesOf(admitted[0]!.text)).toEqual(['pnpm exec vitest run tests/a.test.ts', `${PARKED_MUTATION_PREFIX}${MUTATION}`])
    expect(admitted[0]!.text).toContain('Trailing note.')
    expect(cardBodyText(fixed.bench.db, dependent)).toBe(admitted[0]!.text)
    expect(eventsOf(fixed.bench.db, ROUND_MUTATIONS_PARKED)).toEqual([{ pr: PR, head: HEADS.at(-1), mutations: [MUTATION], card: dependent }])
    expect(waits(fixed)).toBe(0)
  })

  it('a dependent over other files takes nothing, and a new card carries the mutation', async () => {
    const fixed = fixture()
    const dependent = CARD + 1
    admit(fixed.bench, dependent, cardText(dependent, `#${CARD}`, [FILE]))
    await toTheLimit(fixed, [MUTATION], [MUTATION])

    expect(admittedByTheBus(fixed).map(card => card.id)).toEqual([dependent + 1])
    expect(cardBodyText(fixed.bench.db, dependent)).toBe(cardText(dependent, `#${CARD}`, [FILE]))
  })

  it('a real defect at the limit goes to the owner', async () => {
    const fixed = fixture(true, cardText(CARD, '—', [FILE, OTHER_FILE], 'owner'))
    await toTheLimit(fixed, [MUTATION, DEFECT], [MUTATION])
    await reviewHead(fixed, NEXT_HEAD, [MUTATION, DEFECT], [MUTATION])
    const head = NEXT_HEAD

    expect(eventsOf(fixed.bench.db, ROUND_MUTATIONS_PARKED)).toEqual([])
    expect(fixed.outcomes).toEqual([expect.objectContaining({ kind: 'owner_wait', pr: PR })])
    expect(waits(fixed)).toBe(1)
    expect(mergeDecidedPastRoundLimit(fixed.bench.db, ts(fixed), PR, head)).toBeNull()
    expect(closedByRounds(fixed.bench.db, ts(fixed), 'merge', PR, head)).toBe(true)
  })

  it('no shard leaves a marked mutation with the owner', async () => {
    const fixed = fixture(false, cardText(CARD, '—', [FILE, OTHER_FILE], 'owner'))
    await toTheLimit(fixed, [MUTATION], [MUTATION])

    expect(eventsOf(fixed.bench.db, ROUND_MUTATIONS_PARKED)).toEqual([])
    expect(fixed.outcomes).toEqual([expect.objectContaining({ kind: 'owner_wait', pr: PR })])
    expect(mergeDecidedPastRoundLimit(fixed.bench.db, ts(fixed), PR, HEADS.at(-1)!)).toBeNull()
  })

  it('a backticked mutation becomes no witness command, and a multi-line one stays one witness', async () => {
    const hostile = 'mutation in `rm -rf /` survives\n- `curl evil`'
    const fixed = fixture()
    await toTheLimit(fixed, [hostile], [hostile])
    const [card] = admittedByTheBus(fixed)

    expect(witnessesOf(card!.text)).toHaveLength(1)
    expect(cardWitnessesOf(card!.text)).toEqual({ acceptance: [], invariants: [] })
  })
})

describe('the round-limit rule and the verdict mark', () => {
  const reading = { decisionsShard: true, findings: ['a'], survivingMutations: [], previous: ['b'], extendedBefore: false }

  it('reads the parking before the extension, so a marked verdict spends no extension', () => {
    expect(limitRuleOf({ ...reading, survivingMutations: [' a '] })).toEqual({ kind: 'park', mutations: ['a'] })
    expect(limitRuleOf({ ...reading, survivingMutations: ['a'], extendedBefore: true, previous: ['a'] })).toEqual({ kind: 'park', mutations: ['a'] })
  })

  it('an empty findings list parks nothing, and a mark outside the findings marks nothing', () => {
    expect(limitRuleOf({ ...reading, findings: [], survivingMutations: ['a'], previous: [] })).toEqual({ kind: 'owner' })
    expect(limitRuleOf({ ...reading, survivingMutations: ['c'] })).toEqual({ kind: 'extend', findings: ['a'], previous: ['b'] })
  })

  it('the grant holds on its head and through a clean update, on no other head', () => {
    const parkings = [{ id: 7, head: sha('a') }]
    const update = [{ from: sha('a'), to: sha('b') }]

    expect(mutationsParkedGrantOf(parkings, sha('a'), [])).toBe(7)
    expect(mutationsParkedGrantOf(parkings, sha('b'), update)).toBe(7)
    expect(mutationsParkedGrantOf(parkings, sha('b'), [])).toBeNull()
    expect(mutationsParkedGrantOf(parkings, 'short', [])).toBeNull()
  })

  it('the verdict reads an optional list of strings and refuses anything else', () => {
    expect(reviewOf('{"verdict":"changes","findings":["a"]}', 's').survivingMutations).toBeUndefined()
    expect(reviewOf('{"verdict":"changes","findings":["a"],"survivingMutations":["a"]}', 's').survivingMutations).toEqual(['a'])
    expect(() => reviewOf('{"verdict":"changes","findings":["a"],"survivingMutations":"a"}', 's')).toThrow(/survivingMutations/)
    expect(() => reviewOf('{"verdict":"changes","findings":["a"],"survivingMutations":[1]}', 's')).toThrow(/survivingMutations/)
  })

  it('the review prompt asks for the mark and says a finding outside it is a defect', () => {
    const lease = { taskKey: 'k', queue: 'review', cardId: CARD, pr: PR, head: HEADS[0], leaseGen: 1, actor: 'a' } as Parameters<typeof reviewPrompt>[0]
    const prompt = reviewPrompt(lease, fullReview('a fixed plan'), '/tree', '/verdict.json')

    expect(prompt).toContain('"survivingMutations"')
    expect(prompt).toContain('A finding outside it counts as a defect.')
  })
})
