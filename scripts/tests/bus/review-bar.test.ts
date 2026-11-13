import type { Review } from '../../nodes/review/reviewer.js'
import type { MergeBench } from './merge-bench.js'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { parkingFileText, parseParkingFile } from '../../../src/card/parking.js'
import { RISK_LEVELS } from '../../../src/card/risk.js'
import { cardRiskOf } from '../../../src/commands/intake/check.js'
import { admittedRecord } from '../../../src/commands/intake/index.js'
import { appendCardEvent, WINDOW_LANE } from '../../core/card-bodies.js'
import { REVIEW_RECORDED } from '../../core/events.js'
import { RATCHET_FILE } from '../../core/generated-files.js'
import { fullReview, planReview } from '../../nodes/review/review-depth.js'
import { passOnSurvivingMutations } from '../../nodes/review/review-executor.js'
import { ReviewWorker } from '../../nodes/review/review-worker.js'
import { ADVICE_LINE, REVIEW_BAR_LINE, reviewOf, reviewPrompt } from '../../nodes/review/reviewer.js'
import { classify } from '../../policy/morse/rules.js'
import { followsTouches, neverFollows } from '../../policy/touch-scope.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { cardBody, sha } from './github-fake.js'
import { eventsOf, liveBench } from './merge-bench.js'

const CARD_ID = 1688
const HEAD = 'a'.repeat(40)
const BASE = 'b'.repeat(40)
const TOUCHED = 'src/atlas/index.ts'
const UNRELATED_TEST = 'scripts/tests/other/unrelated.test.ts'
const GENERATED = 'contract/surface.json'
const SOURCE = 'src/foo.ts'
const MUTATION = 'src/atlas/index.ts:9 flipping the comparison survives the suite'
const DEFECT = 'src/atlas/index.ts:12 drops the second row'
const REACH = { touches: [TOUCHED], added: new Set<string>(), compositionRecords: [] }
const LEASE = { taskKey: `review:${CARD_ID}:900:${HEAD}`, queue: 'review' as const, cardId: CARD_ID, pr: 900, head: HEAD, leaseGen: 1, actor: 'worker:review:w' }

const line = (file: string): string => `${file} is outside the touches of card #${CARD_ID} (${TOUCHED})`

function firstPlan(outside: string) {
  const files = [TOUCHED, outside]
  const plan = planReview(LEASE, null, {
    base: () => BASE,
    changed: () => files,
    predict: () => ({ prediction: classify(files.map(path => ({ path, status: 'M' as const, additions: 1, deletions: 0 }))), files, added: [] }),
    scope: () => ({ touches: [TOUCHED], creates: [], runs: [] }),
  })
  if (plan.depth !== 'diff' || plan.round !== 'first')
    throw new Error(`expected a first diff review, got ${JSON.stringify(plan)}`)
  return plan
}

function cardOf(touches: string[], creates?: string[]): string {
  return parkingFileText({ card: `#${CARD_ID} a-card [implement/construct/S/cheap/auto] · depends — · blocks —`, branch: 'feat/a-card', touches, ...(creates === undefined ? {} : { creates }), continue: 'stop', who: 'shift', body: 'Make it right.' })
}

const changes = (findings: string[], survivingMutations?: string[]): Review => ({ verdict: 'changes', findings, ...(survivingMutations === undefined ? {} : { survivingMutations }), session: 's-1' })

const CARD_OF_RISK = { R1: ['eslint.config.mjs'], R2: ['src/detect/git.ts'], R3: ['src/atlas/index.ts'], R4: ['docs/cli.md'] } as const

const benches: MergeBench[] = []

afterEach(() => {
  for (const bench of benches.splice(0))
    bench.close()
})

const REVIEWED_PR = 975
const REVIEWED_CARD = REVIEWED_PR + 100

function reviewedCardText(touches: readonly string[]): string {
  return parkingFileText({ card: `#${REVIEWED_CARD} a-card [implement/construct/S/cheap/auto] · depends — · blocks —`, branch: `feat/card-${REVIEWED_CARD}`, touches: [...touches], continue: 'stop', who: 'shift', body: 'Make it right.' })
}

async function recordedThroughTheWorker(touches: readonly string[] | null, findings: string[], survivingMutations: string[]): Promise<{ verdict: string, findings: string[] }> {
  const bench = liveBench()
  benches.push(bench)
  if (touches !== null) {
    const text = reviewedCardText(touches)
    const parsed = parseParkingFile(`${REVIEWED_CARD}.md`, text)
    if (parsed.kind === 'refused')
      throw new Error(parsed.reason)
    appendCardEvent(bench.db, 'worker:intake:test', admittedRecord({ id: REVIEWED_CARD, file: `${REVIEWED_CARD}.md`, line: parsed.parked.task.card.line, who: parsed.parked.who, unclear: [], corrections: [], seam: [], risk: [], slices: [], text }, 'auto', bench.clock.now(), WINDOW_LANE))
    bench.tick()
  }
  const worker = new ReviewWorker({ silentMs: SILENT_MS, isolation: () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] }), db: bench.db, gitHub: bench.gitHub.client, publish: bench.gitHub.publish, reviewer: async () => ({ verdict: 'changes', findings, survivingMutations, session: 'reviewer-1' }), plan: () => fullReview('a fixed plan'), clock: bench.clock.now, session: 'worker-1' })
  bench.gitHub.open({ number: REVIEWED_PR, head: sha('b'), ref: `feat/card-${REVIEWED_CARD}`, body: cardBody(REVIEWED_PR) })
  bench.tick()
  await worker.step()
  return eventsOf(bench.db, REVIEW_RECORDED)[0] as { verdict: string, findings: string[] }
}

describe('a file outside the touches, first bar', () => {
  it('a test outside the touches is a note and not a finding', () => {
    const plan = firstPlan(UNRELATED_TEST)
    expect(plan.touchFindings).toEqual([])
    expect(plan.touchNotes).toEqual([line(UNRELATED_TEST)])
    const prompt = reviewPrompt(LEASE, plan, '/tmp/t', '/tmp/v.json')
    expect(prompt).toContain(`Note in the report, not as a finding and no reason for changes; the pull request names it: ${line(UNRELATED_TEST)}`)
    expect(prompt).not.toContain(`Report as a finding of this review: ${line(UNRELATED_TEST)}`)
  })

  it('a generated file outside the touches is a note and not a finding', () => {
    const plan = firstPlan(GENERATED)
    expect(plan.touchFindings).toEqual([])
    expect(plan.touchNotes).toEqual([line(GENERATED)])
  })

  it('a source file outside the touches stays a finding', () => {
    const plan = firstPlan(SOURCE)
    expect(plan.touchFindings).toEqual([line(SOURCE)])
    expect(plan.touchNotes).toEqual([])
    expect(reviewPrompt(LEASE, plan, '/tmp/t', '/tmp/v.json')).toContain(`Report as a finding of this review: ${line(SOURCE)}`)
  })

  it.each([
    'templates/attach/earlier-carriers.json',
  ])('the generated %s on an R1 path never follows and stays a finding', (file) => {
    const plan = firstPlan(file)
    expect(neverFollows(file, REACH)).toBe(true)
    expect(followsTouches(file, REACH)).toBe(false)
    expect(plan.touchFindings).toEqual([line(file)])
    expect(plan.touchNotes).toEqual([])
  })

  it.each([
    'scripts/tests/bus/helper.ts',
    'tests/fixtures/a.json',
    'README.md',
    'contract/accepted.json',
    'architecture/composition/doctor.yaml',
  ])('%s is neither a test nor a generated file, so it stays a finding', (file) => {
    expect(followsTouches(file, REACH)).toBe(false)
    expect(firstPlan(file).touchFindings).toEqual([line(file)])
  })

  it('the recorded ratchet is a generated file that follows, and the merge rule still reads it', () => {
    expect(followsTouches(RATCHET_FILE.path, REACH)).toBe(true)
  })
})

describe('a surviving mutation, second bar', () => {
  it('only surviving mutations on an R3 card record pass with the findings kept', async () => {
    expect(cardRiskOf(CARD_ID, cardOf([...CARD_OF_RISK.R3]))).toBe('R3')
    expect(await recordedThroughTheWorker(CARD_OF_RISK.R3, [MUTATION], [MUTATION])).toMatchObject({ verdict: 'pass', findings: [MUTATION] })
    expect(await recordedThroughTheWorker(CARD_OF_RISK.R4, [MUTATION], [MUTATION])).toMatchObject({ verdict: 'pass', findings: [MUTATION] })
  })

  it('only surviving mutations on an R1 or R2 card stay changes', async () => {
    expect(cardRiskOf(CARD_ID, cardOf([...CARD_OF_RISK.R1]))).toBe('R1')
    expect(cardRiskOf(CARD_ID, cardOf([...CARD_OF_RISK.R2]))).toBe('R2')
    expect(await recordedThroughTheWorker(CARD_OF_RISK.R1, [MUTATION], [MUTATION])).toMatchObject({ verdict: 'changes', findings: [MUTATION] })
    expect(await recordedThroughTheWorker(CARD_OF_RISK.R2, [MUTATION], [MUTATION])).toMatchObject({ verdict: 'changes', findings: [MUTATION] })
  })

  it('a surviving mutation beside a behaviour defect stays changes on an R3 card', async () => {
    expect(await recordedThroughTheWorker(CARD_OF_RISK.R3, [MUTATION, DEFECT], [MUTATION])).toMatchObject({ verdict: 'changes', findings: [MUTATION, DEFECT] })
  })

  it('a card the bus holds no body for keeps changes through the worker', async () => {
    expect(await recordedThroughTheWorker(null, [MUTATION], [MUTATION])).toMatchObject({ verdict: 'changes' })
  })

  it('every risk level reads one way or the other, so a new level cannot pass unread', () => {
    expect(RISK_LEVELS.map(risk => passOnSurvivingMutations(changes([MUTATION], [MUTATION]), risk).verdict)).toEqual(['changes', 'changes', 'pass', 'pass'])
  })

  it('a card whose risk cannot be read keeps changes: no body, an unparsable body, no touches', () => {
    expect(cardRiskOf(CARD_ID, null)).toBeNull()
    expect(cardRiskOf(CARD_ID, 'no card here')).toBeNull()
    expect(passOnSurvivingMutations(changes([MUTATION], [MUTATION]), null).verdict).toBe('changes')
  })

  it('the deepest touch decides the risk, and a created path counts', () => {
    expect(cardRiskOf(CARD_ID, cardOf(['docs/cli.md', 'src/detect/git.ts']))).toBe('R2')
    expect(cardRiskOf(CARD_ID, cardOf(['docs/cli.md'], ['eslint.config.mjs']))).toBe('R1')
  })

  it('a changes verdict with no findings, or a mark outside its findings, stays changes', () => {
    expect(passOnSurvivingMutations(changes([], [MUTATION]), 'R3').verdict).toBe('changes')
    expect(passOnSurvivingMutations(changes([DEFECT], [MUTATION]), 'R3').verdict).toBe('changes')
    expect(passOnSurvivingMutations(changes([MUTATION]), 'R3').verdict).toBe('changes')
  })

  it('a mark compares as the round-limit rule compares it, trimmed', () => {
    expect(passOnSurvivingMutations(changes([` ${MUTATION} `], [MUTATION]), 'R3')).toMatchObject({ verdict: 'pass', findings: [` ${MUTATION} `] })
  })

  it('a pass stays what it was', () => {
    const review: Review = { verdict: 'pass', findings: [], session: 's-1' }
    expect(passOnSurvivingMutations(review, 'R1')).toBe(review)
  })
})

describe('a finding on the pull request description, third bar', () => {
  const DESCRIPTION = 'the pull request description names no count line'
  const verdictText = (verdict: string, findings: string[], advice?: string[]): string => JSON.stringify({ verdict, findings, ...(advice === undefined ? {} : { advice }) })

  it('a finding only on the pull request description is advice and does not make the verdict changes', () => {
    expect(reviewOf(verdictText('changes', [DESCRIPTION], [DESCRIPTION]), 's-1')).toEqual({ verdict: 'pass', findings: [DESCRIPTION], advice: [DESCRIPTION], session: 's-1' })
    expect(reviewOf(verdictText('changes', [` ${DESCRIPTION} `], [DESCRIPTION]), 's-1').verdict).toBe('pass')
  })

  it('advice beside a defect of code stays changes with both findings kept', () => {
    expect(reviewOf(verdictText('changes', [DESCRIPTION, DEFECT], [DESCRIPTION]), 's-1')).toMatchObject({ verdict: 'changes', findings: [DESCRIPTION, DEFECT] })
  })

  it('a changes verdict with no findings, or with no advice list, stays changes', () => {
    expect(reviewOf(verdictText('changes', [], [DESCRIPTION]), 's-1').verdict).toBe('changes')
    expect(reviewOf(verdictText('changes', [DESCRIPTION]), 's-1').verdict).toBe('changes')
  })

  it('an advice that is no list of strings is refused', () => {
    expect(() => reviewOf(JSON.stringify({ verdict: 'changes', findings: [DESCRIPTION], advice: DESCRIPTION }), 's-1')).toThrow(/advice that is no list of strings/)
  })

  it('every prompt states that only code, test and contract defects make the verdict changes', () => {
    expect(reviewPrompt(LEASE, firstPlan(SOURCE), '/tmp/t', '/tmp/v.json')).toContain(ADVICE_LINE)
    expect(reviewPrompt(LEASE, fullReview('a fixed plan'), '/tmp/t', '/tmp/v.json')).toContain(ADVICE_LINE)
    expect(ADVICE_LINE).toContain('Only a defect of code, tests or the contract makes the verdict changes')
  })
})

describe('one bar', () => {
  it('the prompt and the role line in the template state the same bar', () => {
    const template = readFileSync('templates/ai/claude/_claude/agents/review.md', 'utf8')
    expect(template).toContain(REVIEW_BAR_LINE)
    expect(reviewPrompt(LEASE, firstPlan(SOURCE), '/tmp/t', '/tmp/v.json')).toContain(REVIEW_BAR_LINE)
    expect(reviewPrompt(LEASE, { depth: 'full', why: 'a fixed plan', prediction: null }, '/tmp/t', '/tmp/v.json')).toContain(REVIEW_BAR_LINE)
    expect(reviewPrompt(LEASE, { depth: 'diff', round: 'again', why: 'after changes', since: BASE, reviewed: BASE, findings: [] }, '/tmp/t', '/tmp/v.json')).toContain(REVIEW_BAR_LINE)
  })
})
