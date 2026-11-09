import type { ShiftGate } from '../../../src/manifest.js'
import type { Lease } from '../../core/lease.js'
import type { AnswerOutcome } from '../../nodes/answer/duties/index.js'
import type { CardTreeTools } from '../../ports/card-tree.js'
import type { MergeBench } from './merge-bench.js'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent } from '../../core/db.js'
import { CARD_ADMITTED, CARD_STARTED, CARD_STOPPED, DECISIONS_IMPORTED, OWNER_WAIT_OPENED, POLICY_DENIED, QUESTION_AGENT, QUESTION_OWNER } from '../../core/events.js'
import { leaseNext } from '../../core/lease.js'
import { NETWATCH } from '../../core/observations.js'
import { AnswerExecutor } from '../../nodes/answer/answer-executor.js'
import { answerSourceOf } from '../../nodes/answer/answer-source.js'
import { claudeAnswerer, ownerQuestionPath, windowGateRule } from '../../nodes/answer/answerer.js'
import { answerPrompt } from '../../nodes/answer/duties/index.js'
import { recordDecision } from '../../policy/decisions.js'
import { sha } from './github-fake.js'
import { eventsOf, mergeBench } from './merge-bench.js'

const CARD = 1917
const PR = CARD - 100
const OTHER_CARD = 1918
const OWNER_MERGES = readFileSync('architecture/owner-merges.md', 'utf8')
const QUESTION = 'may the card touch architecture/owner-merges.md?'
const BOUND_TEXT = 'the card may touch architecture/owner-merges.md'
const ANOTHER_CARDS_TEXT = 'the other card keeps its bearer'
const LAPSED_TEXT = 'the bearer stays for now · until 2020-01-01T00:00Z'
const SUPERSEDED_TEXT = 'the bearer stays for good'
const BLOCK = 'Owner decisions in force for this card'
const GATE = { prepush: [] } as unknown as ShiftGate
const CARD_SESSION = 'card-session-1'

const benches: MergeBench[] = []
const roots: string[] = []

afterEach(() => {
  for (const made of benches.splice(0))
    made.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

interface Bench {
  made: MergeBench
  worktree: string
  ts: () => string
  asks: (question: string | null) => Promise<{ outcome: AnswerOutcome, prompt: string }>
}

function startedCard(): Bench {
  const made = mergeBench()
  benches.push(made)
  const trees = mkdtempSync(path.join(tmpdir(), 'bus-answer-decisions-'))
  roots.push(trees)
  const worktree = path.join(trees, `mc-${CARD}`)
  mkdirSync(worktree)
  const answers = path.join(trees, 'answers')
  const ts = (): string => made.clock.now().toISOString()
  appendEvent(made.db, { ts: ts(), type: CARD_ADMITTED, actor: 'policy', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${CARD}`, payload: { lane: 'lane-a', decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${CARD}` }, legacy: false })
  appendEvent(made.db, { ts: ts(), type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD}`, payload: { session: CARD_SESSION, worktree, branch: `feat/card-${CARD}`, base: sha('1') }, legacy: false })
  const cardTrees: CardTreeTools = { home: trees, exists: existsSync, branchOf: pr => `feat/card-${pr + 100}`, recreate: () => {}, bringTo: () => {} }
  const asks: Bench['asks'] = async (question) => {
    const lease = leaseNext(made.db, ts(), 'answer', 'worker:answer:worker-1')!
    let prompt = ''
    const answerer = claudeAnswerer(answers, {
      cardText: () => null,
      available: () => true,
      remoteHead: () => sha('a'),
      spawn: async (run) => {
        prompt = run.argv.at(-1)!
        if (question !== null)
          writeFileSync(ownerQuestionPath(answers, CARD_SESSION, lease.leaseGen), `${question}\n`)
        return 0
      },
      newSession: () => CARD_SESSION,
      publish: () => {},
    })
    const executor = new AnswerExecutor({ db: made.db, answerer, ownerMerges: () => OWNER_MERGES, clock: made.clock.now, trees: cardTrees, dirty: () => false, liveSession: () => null })
    return { outcome: await executor.answer(lease), prompt }
  }
  return { made, worktree, ts, asks }
}

function changesAsked(bench: Bench): void {
  bench.made.gitHub.open({ number: PR, review: 'failure' })
  bench.made.tick()
}

function agentStop(bench: Bench): void {
  appendEvent(bench.made.db, { ts: bench.ts(), type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${CARD}:agent`, payload: { reason: QUESTION_AGENT, detail: QUESTION }, legacy: false })
}

function decided(bench: Bench, decisionId: number, text: string, cards: number[]): void {
  recordDecision(bench.made.db, { ts: bench.ts(), decisionId, text, cards })
  bench.made.tick()
}

function leaseOf(): Lease {
  return { taskKey: `answer:${CARD}`, cardId: CARD, pr: null, head: null, leaseGen: 1, actor: 'worker:answer:worker-1' } as unknown as Lease
}

function promptOf(bench: Bench): string {
  const source = answerSourceOf(bench.made.db, leaseOf(), bench.made.clock.now())!
  const card = { session: CARD_SESSION, worktree: bench.worktree, branch: `feat/card-${CARD}` }
  return answerPrompt({ lease: leaseOf(), source, widened: null, card }, null, windowGateRule(card, GATE, 'owner.txt'))
}

async function stoppedOnTheOwner(bench: Bench): Promise<void> {
  changesAsked(bench)
  expect((await bench.asks(QUESTION)).outcome).toMatchObject({ kind: 'stopped', reason: QUESTION_OWNER })
  bench.made.tick()
}

describe('an owner decision bound to a card reaches its answer session', () => {
  it('prompt carries the decisions bound to the card', () => {
    const bench = startedCard()
    agentStop(bench)
    expect(promptOf(bench)).not.toContain(BLOCK)

    decided(bench, 900, ANOTHER_CARDS_TEXT, [OTHER_CARD])
    expect(promptOf(bench)).not.toContain(BLOCK)
    expect(promptOf(bench)).not.toContain(ANOTHER_CARDS_TEXT)

    decided(bench, 901, BOUND_TEXT, [CARD])
    const prompt = promptOf(bench)
    expect(prompt).toContain(BLOCK)
    expect(prompt).toContain(`D-901: ${BOUND_TEXT}`)
    expect(prompt).not.toContain(ANOTHER_CARDS_TEXT)
  })

  it('source holds only decisions in force', () => {
    const bench = startedCard()
    agentStop(bench)
    decided(bench, 901, BOUND_TEXT, [CARD])
    decided(bench, 902, LAPSED_TEXT, [CARD])
    decided(bench, 903, SUPERSEDED_TEXT, [CARD])
    expect(answerSourceOf(bench.made.db, leaseOf(), bench.made.clock.now())).toMatchObject({ decisions: expect.arrayContaining([`D-903: ${SUPERSEDED_TEXT}`]) as unknown })

    appendEvent(bench.made.db, {
      ts: bench.ts(),
      type: DECISIONS_IMPORTED,
      actor: NETWATCH,
      cardId: null,
      pr: null,
      head: null,
      dedupeKey: `${DECISIONS_IMPORTED}:without-903`,
      payload: { decisions: [
        { decision_id: 901, text: BOUND_TEXT, scope: [CARD] },
        { decision_id: 902, text: LAPSED_TEXT, scope: [CARD] },
      ] },
      legacy: false,
    })
    bench.made.tick()

    expect(answerSourceOf(bench.made.db, leaseOf(), bench.made.clock.now())).toMatchObject({ decisions: [`D-901: ${BOUND_TEXT}`] })
  })

  it('repeated stop under a decision opens no wait', async () => {
    const bench = startedCard()
    await stoppedOnTheOwner(bench)
    decided(bench, 901, BOUND_TEXT, [CARD])
    const stops = eventsOf(bench.made.db, CARD_STOPPED).length
    const waits = eventsOf(bench.made.db, OWNER_WAIT_OPENED).length

    const { outcome, prompt } = await bench.asks(`  ${QUESTION}  `)

    expect(prompt).toContain(`D-901: ${BOUND_TEXT}`)
    expect(outcome).toMatchObject({ kind: 'denied', denial: { reason: 'repeated_stop', detail: expect.stringContaining('D-901') as unknown } })
    expect(eventsOf(bench.made.db, POLICY_DENIED)).toEqual([expect.objectContaining({ reason: 'repeated_stop' })])
    expect(eventsOf(bench.made.db, CARD_STOPPED)).toHaveLength(stops)
    expect(eventsOf(bench.made.db, OWNER_WAIT_OPENED)).toHaveLength(waits)
  })

  it('the answer goes again after the denied repeat, with the decision in its prompt', async () => {
    const bench = startedCard()
    await stoppedOnTheOwner(bench)
    decided(bench, 901, BOUND_TEXT, [CARD])
    await bench.asks(QUESTION)
    bench.made.tick()

    const again = await bench.asks(null)

    expect(again.prompt).toContain(`D-901: ${BOUND_TEXT}`)
  })

  it('a repeat of a question.agent stop under a decision opens no wait', async () => {
    const bench = startedCard()
    changesAsked(bench)
    appendEvent(bench.made.db, { ts: bench.ts(), type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId: CARD, pr: PR, head: sha('a'), dedupeKey: `${CARD_STOPPED}:${CARD}:agent-on-the-pr`, payload: { reason: QUESTION_AGENT, detail: QUESTION }, legacy: false })
    decided(bench, 901, BOUND_TEXT, [CARD])
    const stops = eventsOf(bench.made.db, CARD_STOPPED).length

    const { outcome } = await bench.asks(QUESTION)

    expect(outcome).toMatchObject({ kind: 'denied', denial: { reason: 'repeated_stop' } })
    expect(eventsOf(bench.made.db, CARD_STOPPED)).toHaveLength(stops)
    expect(eventsOf(bench.made.db, OWNER_WAIT_OPENED)).toEqual([])
  })

  it('a lapsed decision recorded after the stop does not deny the repeat', async () => {
    const bench = startedCard()
    await stoppedOnTheOwner(bench)
    decided(bench, 902, LAPSED_TEXT, [CARD])
    const waits = eventsOf(bench.made.db, OWNER_WAIT_OPENED).length

    const { outcome, prompt } = await bench.asks(QUESTION)

    expect(prompt).not.toContain(LAPSED_TEXT)
    expect(outcome).toMatchObject({ kind: 'stopped', reason: QUESTION_OWNER })
    expect(eventsOf(bench.made.db, OWNER_WAIT_OPENED)).toHaveLength(waits + 1)
  })

  it('a different question under a decision still opens a wait', async () => {
    const bench = startedCard()
    await stoppedOnTheOwner(bench)
    decided(bench, 901, BOUND_TEXT, [CARD])
    const waits = eventsOf(bench.made.db, OWNER_WAIT_OPENED).length

    const { outcome } = await bench.asks('may the card also drop a line of architecture/owner-merges.md?')

    expect(outcome).toMatchObject({ kind: 'stopped', reason: QUESTION_OWNER })
    expect(eventsOf(bench.made.db, OWNER_WAIT_OPENED)).toHaveLength(waits + 1)
  })

  it('the same question with the decision recorded before the stop still opens a wait', async () => {
    const bench = startedCard()
    decided(bench, 901, BOUND_TEXT, [CARD])
    changesAsked(bench)
    appendEvent(bench.made.db, { ts: bench.ts(), type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId: CARD, pr: PR, head: sha('a'), dedupeKey: `${CARD_STOPPED}:${CARD}:before`, payload: { reason: QUESTION_OWNER, detail: QUESTION }, legacy: false })

    const { outcome } = await bench.asks(QUESTION)

    expect(outcome).toMatchObject({ kind: 'stopped', reason: QUESTION_OWNER })
  })

  it('the same question after a new turn of the card still opens a wait', async () => {
    const bench = startedCard()
    await stoppedOnTheOwner(bench)
    decided(bench, 901, BOUND_TEXT, [CARD])
    appendEvent(bench.made.db, { ts: bench.ts(), type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD}:again`, payload: { session: CARD_SESSION, worktree: bench.worktree, branch: `feat/card-${CARD}`, base: sha('1') }, legacy: false })

    const { outcome } = await bench.asks(QUESTION)

    expect(outcome).toMatchObject({ kind: 'stopped', reason: QUESTION_OWNER })
  })
})
