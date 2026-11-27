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
import { decisionsOnTheCard, ReviewWorker } from '../../nodes/review/review-worker.js'
import { claudeReviewer, decisionLines, DECISIONS_BAR_LINE, ReviewTrees } from '../../nodes/review/reviewer.js'
import { recordDecision } from '../../policy/decisions/index.js'
import { busProjections, candidateRules } from '../../supervisor/composition.js'
import { reviewCandidates } from '../../supervisor/derive-queues.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { BusTick } from '../../supervisor/run.js'
import { Clock, FakeGitHub, sha } from '../bus/github-fake.js'
import { benchNetWatch } from '../bus/net-watch-bench.js'
import { detectReview } from '../bus/review-detection.js'

const PR = 1840
const CARD = PR + 100
const RATCHET_DECISION = 591
const OTHER_CARD_DECISION = 590
const UNBOUND_DECISION = 589
const RATCHET_TEXT = 'Card #1940 may grow the ratchet row lines:scripts/core/queue.ts from 4 to 5; the measured ratchet allows it.'
const OTHER_TEXT = 'Card #1941 drops its witness W2.'
const UNBOUND_TEXT = 'Every card names its witnesses.'
const CARD_TEXT = `#${CARD} ratchet-card [implement/bus/S/cheap/owner] · depends — · blocks —\n\nNo ratchet row grows.\n`
const sandboxed: IsolationReader = () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] })
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

async function promptOfTheReview(): Promise<{ prompt: string, bound: ReturnType<typeof decisionsOnTheCard> }> {
  const root = mkdtempSync(path.join(tmpdir(), 'review-owner-decisions-'))
  roots.push(root)
  const db = openBus(path.join(root, 'bus.db'))
  const gitHub = new FakeGitHub()
  const clock = new Clock()
  const busTick = new BusTick(db, busProjections(), benchNetWatch(db, gitHub.client, clock.now), clock.now)
  const ts = (): string => clock.now().toISOString()
  appendEvent(db, { ts: ts(), type: CARD_ADMITTED, actor: 'worker:intake:s1', cardId: CARD, pr: null, head: null, dedupeKey: `admitted-${CARD}`, payload: { card: CARD, lane: 'lane-1', text: CARD_TEXT, textSha: textSha(CARD_TEXT), bodySha: 'aaaa1111bbbb2222' }, legacy: false })
  recordDecision(db, { ts: ts(), decisionId: UNBOUND_DECISION, text: UNBOUND_TEXT, cards: [] })
  recordDecision(db, { ts: ts(), decisionId: OTHER_CARD_DECISION, text: OTHER_TEXT, cards: [CARD + 1] })
  recordDecision(db, { ts: ts(), decisionId: RATCHET_DECISION, text: RATCHET_TEXT, cards: [CARD] })
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
  const bound = decisionsOnTheCard(db, CARD, clock.now())
  db.close()
  expect(prompts).toHaveLength(1)
  return { prompt: prompts[0]!, bound }
}

describe('the review prompt carries the owner decisions bound to the card', () => {
  it('scenario 1940: a card decision allowing the ratchet 4 -> 5 reaches the review prompt and bars a ratchet finding', async () => {
    const { prompt, bound } = await promptOfTheReview()

    expect(bound).toEqual([{ decisionId: RATCHET_DECISION, text: RATCHET_TEXT }])
    expect(prompt).toContain('No ratchet row grows.')
    expect(prompt).toContain(`<decisions>\nD-${RATCHET_DECISION}: ${RATCHET_TEXT}\n</decisions>`)
    expect(prompt).toContain(DECISIONS_BAR_LINE)
    expect(DECISIONS_BAR_LINE).toContain('"the card promises X" is not given when a decision in force on this card allows otherwise')
  })

  it('a decision bound to another card or to no card stays out of the review prompt', async () => {
    const { prompt } = await promptOfTheReview()

    expect(prompt).not.toContain(OTHER_TEXT)
    expect(prompt).not.toContain(UNBOUND_TEXT)
  })

  it('a card with no decision in force gets no decision block and no bar line', () => {
    expect(decisionLines([])).toEqual([])
  })
})
