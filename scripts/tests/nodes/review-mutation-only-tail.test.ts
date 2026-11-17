import type { GitHub } from '../../ports/github.js'
import type { MergeBench } from '../bus/merge-bench.js'
import { afterEach, describe, expect, it } from 'vitest'
import { parkingFileText, parseParkingFile } from '../../../src/card/parking.js'
import { textSha } from '../../../src/card/text-sha.js'
import { cardRiskOf } from '../../../src/commands/intake/check.js'
import { bodySha } from '../../../src/commands/intake/confirm.js'
import { admittedRecord } from '../../../src/commands/intake/index.js'
import { appendCardEvent, WINDOW_LANE } from '../../core/card-bodies.js'
import { CARD_ADMITTED, REVIEW_RECORDED } from '../../core/events.js'
import { cardContract } from '../../intake/card-contract.js'
import { busHeldCards } from '../../intake/intake.js'
import { fullReview } from '../../nodes/review/review-depth.js'
import { ReviewWorker } from '../../nodes/review/review-worker.js'
import { BusTailIntake, nextTailNumber, TAIL_ACTOR, TAIL_PRIORITY, tailBodySha, tailCardText, tailParentOf, tailTextSha, tailTouches } from '../../nodes/review/tail-card.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { cardBody, sha } from '../bus/github-fake.js'
import { eventsOf, liveBench } from '../bus/merge-bench.js'

const PR = 977
const CARD = 1077
const LATEST_ON_GITHUB = 1500
const MUTATION = 'scripts/nodes/review/tail-card.ts:40 flipping the comparison survives the suite'
const SECOND_MUTATION = 'scripts/nodes/review/tail-card.ts:44 `tests.length > 0` -> `true` survives, the fallback is untested'
const DEFECT = 'scripts/nodes/review/tail-card.ts:52 drops the last finding'
const TOUCHES_OF_RISK = {
  R1: ['eslint.config.mjs', 'scripts/tests/nodes/review-mutation-only-tail.test.ts'],
  R4: ['docs/cli.md'],
} as const

const benches: MergeBench[] = []

afterEach(() => {
  for (const bench of benches.splice(0))
    bench.close()
})

function parentText(touches: readonly string[]): string {
  return parkingFileText({ card: `#${CARD} a-card [implement/construct/S/cheap/auto] · depends #900 · blocks —`, branch: `feat/card-${CARD}`, touches: [...touches], continue: 'stop', who: 'shift', body: 'Make it right.' })
}

function withIssues(client: GitHub): GitHub {
  return endpoint => endpoint.startsWith('repos/{owner}/{repo}/issues?') ? { status: 200, headers: {}, body: [{ number: LATEST_ON_GITHUB }] } : client(endpoint)
}

function busTail(bench: MergeBench): BusTailIntake {
  return new BusTailIntake({ db: bench.db, gitHub: withIssues(bench.gitHub.client), clock: bench.clock.now, cardStates: () => busHeldCards(bench.db) })
}

interface Reviewed {
  bench: MergeBench
  verdict: string
  findings: string[]
  tails: { card_id: number, payload: string }[]
  tailCard: number | undefined
}

async function reviewed(touches: readonly string[], findings: string[], survivingMutations: string[]): Promise<Reviewed> {
  const bench = liveBench()
  benches.push(bench)
  const text = parentText(touches)
  const parsed = parseParkingFile(`${CARD}.md`, text)
  if (parsed.kind === 'refused')
    throw new Error(parsed.reason)
  appendCardEvent(bench.db, 'worker:intake:test', admittedRecord({ id: CARD, file: `${CARD}.md`, line: parsed.parked.task.card.line, who: parsed.parked.who, unclear: [], corrections: [], seam: [], risk: [], slices: [], text }, 'auto', bench.clock.now(), WINDOW_LANE))
  bench.tick()
  const worker = new ReviewWorker({ silentMs: SILENT_MS, isolation: () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] }), db: bench.db, gitHub: withIssues(bench.gitHub.client), publish: bench.gitHub.publish, reviewer: async () => ({ verdict: 'changes', findings, survivingMutations, session: 'reviewer-1' }), plan: () => fullReview('a fixed plan'), clock: bench.clock.now, session: 'worker-1', tail: busTail(bench) })
  bench.gitHub.open({ number: PR, head: sha('b'), ref: `feat/card-${CARD}`, body: cardBody(PR) })
  bench.tick()
  await worker.step()
  const recorded = eventsOf(bench.db, REVIEW_RECORDED)[0] as { verdict: string, findings: string[], tail_card?: number }
  const tails = bench.db.prepare('SELECT card_id, payload FROM events WHERE type = ? AND actor = ? ORDER BY id').all(CARD_ADMITTED, TAIL_ACTOR) as { card_id: number, payload: string }[]
  return { bench, verdict: recorded.verdict, findings: recorded.findings, tails, tailCard: recorded.tail_card }
}

describe('a review whose every finding is a surviving mutation', () => {
  it.each(['R1', 'R4'] as const)('on an %s card records pass and admits one p1 tail card carrying the findings word for word', async (risk) => {
    expect(cardRiskOf(CARD, parentText(TOUCHES_OF_RISK[risk]))).toBe(risk)
    const { bench, verdict, findings, tails, tailCard } = await reviewed(TOUCHES_OF_RISK[risk], [MUTATION, SECOND_MUTATION], [MUTATION, SECOND_MUTATION])
    expect({ verdict, findings }).toEqual({ verdict: 'pass', findings: [MUTATION, SECOND_MUTATION] })
    expect(tails).toHaveLength(1)
    expect(tailCard).toBe(tails[0]!.card_id)
    bench.tick()
    const tail = cardContract(bench.db, tails[0]!.card_id)
    expect(tail).toMatchObject({ id: LATEST_ON_GITHUB + 1, kind: 'implement', priority: TAIL_PRIORITY, depends: [], blocks: [], decision: 'auto', contour: 'cheap', touches: tailTouches({ touches: [...TOUCHES_OF_RISK[risk]] }) })
    expect(tail!.text).toContain(`\n- ${MUTATION}\n`)
    expect(tail!.text).toContain(`\n- ${SECOND_MUTATION}\n`)
    expect(tail!.text).toContain(`Tail of card #${CARD}`)
    const payload = JSON.parse(tails[0]!.payload) as { text: string, textSha: string, bodySha: string }
    expect(payload).toMatchObject({ textSha: textSha(payload.text), bodySha: bodySha(payload.text) })
    expect(tailTextSha(payload.text)).toBe(textSha(payload.text))
  })

  it('with one finding outside survivingMutations records changes and admits nothing', async () => {
    const { verdict, findings, tails, tailCard } = await reviewed(TOUCHES_OF_RISK.R4, [MUTATION, DEFECT], [MUTATION])
    expect({ verdict, findings }).toEqual({ verdict: 'changes', findings: [MUTATION, DEFECT] })
    expect(tails).toEqual([])
    expect(tailCard).toBeUndefined()
  })
})

describe('the tail card', () => {
  const parent = { id: CARD, name: 'a-card', milestone: 'construct', continue: 'stop', who: 'shift', touches: ['src/a.ts', 'tests/a.test.ts'] }
  const tail = { parent: CARD, pr: PR, head: sha('b'), taskKey: `review:${CARD}:${PR}:${sha('b')}`, findings: [MUTATION] }

  it('touches the tests among the parent touches, and every touch when the parent names no test', () => {
    expect(tailTouches({ touches: ['src/a.ts', 'tests/a.test.ts', 'scripts/tests/b.ts'] })).toEqual(['tests/a.test.ts', 'scripts/tests/b.ts'])
    expect(tailTouches({ touches: ['src/a.ts'] })).toEqual(['src/a.ts'])
  })

  it('reads the parent from its admitted body as the card contract reads it', () => {
    const text = parentText(['src/a.ts', 'tests/a.test.ts'])
    const contract = { name: 'a-card', milestone: 'construct', continue: 'stop', who: 'shift', touches: ['src/a.ts', 'tests/a.test.ts'] }
    expect(tailParentOf(text)).toEqual(contract)
    expect(tailParentOf('no card here')).toBeNull()
  })

  it('parses as a card, and its body sha is the one intake computes', () => {
    const text = tailCardText(1600, parent, tail)
    const parsed = parseParkingFile('1600.md', text)
    expect(parsed).toMatchObject({ kind: 'parked', parked: { priority: TAIL_PRIORITY, task: { card: { id: 1600, name: 'a-card-tail', depends: [], blocks: [] }, touches: ['tests/a.test.ts'] } } })
    expect(tailBodySha(text)).toBe(bodySha(text))
  })

  it('takes the number after every card, PR and issue, skipping a held number and ignoring a foreign one as the high mark', () => {
    expect(nextTailNumber(new Map([['10', 'merged'], ['12', 'queued']]), [11, 9])).toBe(13)
    expect(nextTailNumber(Object.assign(new Map([['10', 'merged'], ['9000', 'queued']]), { foreign: new Set([9000]) }), [11, 12])).toBe(13)
    expect(nextTailNumber(Object.assign(new Map([['10', 'merged'], ['13', 'queued']]), { foreign: new Set([13]) }), [11, 12])).toBe(14)
  })

  it('is filed once per review task: a second filing of the same task admits nothing more', () => {
    const bench = liveBench()
    benches.push(bench)
    const text = parentText(['tests/a.test.ts'])
    const parsed = parseParkingFile(`${CARD}.md`, text)
    if (parsed.kind === 'refused')
      throw new Error(parsed.reason)
    appendCardEvent(bench.db, 'worker:intake:test', admittedRecord({ id: CARD, file: `${CARD}.md`, line: parsed.parked.task.card.line, who: parsed.parked.who, unclear: [], corrections: [], seam: [], risk: [], slices: [], text }, 'auto', bench.clock.now(), WINDOW_LANE))
    bench.tick()
    const intake = busTail(bench)
    expect(intake.file(tail)).toBe(LATEST_ON_GITHUB + 1)
    expect(intake.file(tail)).toBeNull()
    expect(bench.db.prepare('SELECT count(*) AS n FROM events WHERE actor = ?').get(TAIL_ACTOR)).toEqual({ n: 1 })
  })

  it('is not filed for a card the bus holds no body for', () => {
    const bench = liveBench()
    benches.push(bench)
    expect(() => busTail(bench).file(tail)).toThrow(/no admitted body/)
  })
})
