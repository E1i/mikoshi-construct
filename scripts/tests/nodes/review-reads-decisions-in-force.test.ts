import type { IsolationReader } from '../../ports/isolation.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { TICK_MS } from '../../core/cadence.js'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_ADMITTED } from '../../core/events.js'
import { keyOf, queueTaskWithin } from '../../core/queue.js'
import { fullReview } from '../../nodes/review/review-depth.js'
import { ReviewWorker } from '../../nodes/review/review-worker.js'
import { claudeReviewer, DECISIONS_BAR_LINE, ReviewTrees } from '../../nodes/review/reviewer.js'
import { namesCard } from '../../policy/decisions/decisions.js'
import { recordDecision } from '../../policy/decisions/index.js'
import { busProjections, candidateRules } from '../../supervisor/composition.js'
import { reviewCandidates } from '../../supervisor/derive-queues.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { BusTick } from '../../supervisor/run.js'
import { Clock, FakeGitHub, sha } from '../bus/github-fake.js'
import { benchNetWatch } from '../bus/net-watch-bench.js'
import { detectReview } from '../bus/review-detection.js'

const CARD = 2056
const PR = CARD - 100
const RANGE_DECISION = 667
const PR_DECISION = 668
const FAR_RANGE_DECISION = 669
const RANGE_TEXT = 'For #2055-#2059 the per-row ratchet growth listed in the recount is allowed as an ownership move; growth is allowed while the total falls.'
const PR_TEXT = `PR #${PR} may carry the generated registry row it measured.`
const FAR_RANGE_TEXT = 'For #2060-#2062 growth is allowed.'
const CARD_TEXT = `#${CARD} range-card [implement/bus/S/cheap/owner] · depends — · blocks —\n\nNo ratchet row grows.\n`
const sandboxed: IsolationReader = () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] })
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

interface Recorded { decisionId: number, text: string }

async function promptOfTheReview(decisions: readonly Recorded[]): Promise<string> {
  const root = mkdtempSync(path.join(tmpdir(), 'review-reads-decisions-'))
  roots.push(root)
  const db = openBus(path.join(root, 'bus.db'))
  const gitHub = new FakeGitHub()
  const clock = new Clock()
  const busTick = new BusTick(db, busProjections(), benchNetWatch(db, gitHub.client, clock.now), clock.now)
  const ts = (): string => clock.now().toISOString()
  appendEvent(db, { ts: ts(), type: CARD_ADMITTED, actor: 'worker:intake:s1', cardId: CARD, pr: null, head: null, dedupeKey: `admitted-${CARD}`, payload: { card: CARD, lane: 'lane-1', text: CARD_TEXT, textSha: textSha(CARD_TEXT), bodySha: 'aaaa1111bbbb2222' }, legacy: false })
  for (const { decisionId, text } of decisions)
    recordDecision(db, { ts: ts(), decisionId, text, cards: [] })
  gitHub.open({ number: PR, head: sha('a') })
  busTick.run()
  detectReview({ db, gitHub, clock })
  clock.advance(TICK_MS)
  const candidate = reviewCandidates(db, ts(), candidateRules()).find(each => each.pr === PR)!
  queueTaskWithin(db, ts(), candidate)
  const prompts: string[] = []
  const reviewer = claudeReviewer(new ReviewTrees('/repo', path.join(root, 'reviews'), { git: () => {}, worktrees: () => [], prepare: () => {}, state: () => ({ head: sha('a'), status: [] }) }), async (params) => {
    prompts.push(params.prompt)
    throw new Error('stop after the spawn')
  })
  const worker = new ReviewWorker({ silentMs: SILENT_MS, db, gitHub: gitHub.client, publish: () => {}, reviewer, plan: () => fullReview('a fixed plan'), clock: clock.now, session: 'worker-1', isolation: sandboxed })
  await worker.stepOn(keyOf(candidate))
  db.close()
  expect(prompts).toHaveLength(1)
  return prompts[0]!
}

describe('review reads every decision in force that names the card or its PR', () => {
  it('a decision naming the card inside a #A-#B range with no card tail reaches the review prompt with the bar line', async () => {
    const prompt = await promptOfTheReview([{ decisionId: RANGE_DECISION, text: RANGE_TEXT }])

    expect(prompt).toContain('No ratchet row grows.')
    expect(prompt).toContain(`<decisions>\nD-${RANGE_DECISION}: ${RANGE_TEXT}\n</decisions>`)
    expect(prompt).toContain(DECISIONS_BAR_LINE)
  })

  it('a decision naming the PR of the card and no card reaches the review prompt', async () => {
    const prompt = await promptOfTheReview([{ decisionId: PR_DECISION, text: PR_TEXT }])

    expect(prompt).toContain(`<decisions>\nD-${PR_DECISION}: ${PR_TEXT}\n</decisions>`)
    expect(prompt).toContain(DECISIONS_BAR_LINE)
  })

  it('a range decision that does not cover the card stays out of the review prompt', async () => {
    const prompt = await promptOfTheReview([{ decisionId: FAR_RANGE_DECISION, text: FAR_RANGE_TEXT }])

    expect(prompt).not.toContain(FAR_RANGE_TEXT)
    expect(prompt).not.toContain(DECISIONS_BAR_LINE)
  })
})

const NAMING_CASES: { name: string, decision: { cards: number[], text: string }, card: number, pr: number | null, names: boolean }[] = [
  { name: 'the card in the cards list', decision: { cards: [CARD], text: 'no number here' }, card: CARD, pr: null, names: true },
  { name: 'the card as #N in the text', decision: { cards: [], text: `Card #${CARD} drops W2.` }, card: CARD, pr: null, names: true },
  { name: 'a hyphen range covering the card', decision: { cards: [], text: 'For #2055-#2059 growth is allowed' }, card: CARD, pr: null, names: true },
  { name: 'an en dash range covering the card', decision: { cards: [], text: 'For #2055–#2059 growth is allowed' }, card: CARD, pr: null, names: true },
  { name: 'a range edge equal to the card', decision: { cards: [], text: 'For #2050-#2056' }, card: CARD, pr: null, names: true },
  { name: 'a range below the card', decision: { cards: [], text: 'For #2050-#2055' }, card: CARD, pr: null, names: false },
  { name: 'a bare number without #', decision: { cards: [], text: `Card ${CARD} drops W2.` }, card: CARD, pr: null, names: false },
  { name: 'a longer number that starts with the card', decision: { cards: [], text: `Card #${CARD}0 drops W2.` }, card: CARD, pr: null, names: false },
  { name: 'PR #N of the card', decision: { cards: [], text: `PR #${PR} may grow` }, card: CARD, pr: PR, names: true },
  { name: 'PR #N with no PR on the lease', decision: { cards: [], text: `PR #${PR} may grow` }, card: CARD, pr: null, names: false },
  { name: 'PR #N equal to the card number is not the card', decision: { cards: [], text: `PR #${CARD} may grow` }, card: CARD, pr: PR, names: false },
  { name: 'another card', decision: { cards: [CARD + 1], text: `Card #${CARD + 1}` }, card: CARD, pr: PR, names: false },
]

describe('namesCard', () => {
  for (const { name, decision, card, pr, names } of NAMING_CASES) {
    it(`${names ? 'names' : 'does not name'} the card: ${name}`, () => {
      expect(namesCard(decision, card, pr)).toBe(names)
    })
  }
})
