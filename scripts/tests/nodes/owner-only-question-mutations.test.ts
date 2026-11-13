import type { MergeBench } from '../bus/merge-bench.js'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent } from '../../core/db.js'
import { CARD_ADMITTED, CARD_STARTED, CARD_STOPPED, OWNER_WAIT_OPENED, QUESTION_AGENT, QUESTION_OWNER } from '../../core/events.js'
import { leaseNext } from '../../core/lease.js'
import { AnswerExecutor, ratchetGrowthLine, ratchetRowsAskedToGrow } from '../../nodes/answer/answer-executor.js'
import { claudeAnswerer, ownerQuestionPath } from '../../nodes/answer/answerer.js'
import { recordDecision } from '../../policy/decisions/index.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { sha } from '../bus/github-fake.js'
import { eventsOf, mergeBench } from '../bus/merge-bench.js'

const CARD = 1879
const PR = 1779
const CARD_SESSION = 'card-session-1879'
const ROW = 'boundary:session->window'
const OTHER_ROW = 'lines:scripts/board/board-page.ts'
const ASK = `the move needs ${ROW} 4→5 in contract/ratchet.json; may the card grow it?`
const OTHER_ASK = `may the card grow ${OTHER_ROW} to 1941?`
const BOTH_ASK = `the move needs ${ROW} 4→5 and ${OTHER_ROW} 1940→1941; may the card grow both?`

const benches: MergeBench[] = []
const roots: string[] = []

afterEach(() => {
  for (const made of benches.splice(0))
    made.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

interface Card {
  made: MergeBench
  sessions: () => number
  stopOnTheAgent: (question: string, pr?: number) => void
  asks: (question: string) => Promise<unknown>
  decide: (decisionId: number) => void
  opensItsPr: () => void
}

function startedCard(): Card {
  const made = mergeBench()
  benches.push(made)
  const trees = mkdtempSync(path.join(tmpdir(), 'owner-only-question-mutations-'))
  roots.push(trees)
  const worktree = path.join(trees, `mc-${CARD}`)
  mkdirSync(worktree)
  const answers = path.join(trees, 'answers')
  const ts = (): string => made.clock.now().toISOString()
  appendEvent(made.db, { ts: ts(), type: CARD_ADMITTED, actor: 'policy', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${CARD}`, payload: { lane: 'lane-a', decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${CARD}` }, legacy: false })
  appendEvent(made.db, { ts: ts(), type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD}`, payload: { session: CARD_SESSION, worktree, branch: `feat/card-${CARD}`, base: sha('1') }, legacy: false })
  let stops = 0
  let sessions = 0
  const stopOnTheAgent = (question: string, pr?: number): void => {
    stops += 1
    appendEvent(made.db, { ts: ts(), type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId: CARD, pr: pr ?? null, head: pr === undefined ? null : sha('a'), dedupeKey: `${CARD_STOPPED}:${CARD}:agent-${stops}`, payload: { reason: QUESTION_AGENT, detail: question }, legacy: false })
    made.tick()
  }
  const asks = async (question: string): Promise<unknown> => {
    const lease = leaseNext(made.db, ts(), 'answer', 'worker:answer:worker-1')!
    const answerer = claudeAnswerer(answers, {
      cardText: () => null,
      available: () => true,
      remoteHead: () => sha('a'),
      spawn: async () => {
        sessions += 1
        writeFileSync(ownerQuestionPath(answers, CARD_SESSION, lease.leaseGen), `${question}\n`)
        return 0
      },
      newSession: () => CARD_SESSION,
      publish: () => {},
    })
    const executor = new AnswerExecutor({ silentMs: SILENT_MS, db: made.db, answerer, ownerMerges: () => '', clock: made.clock.now, trees: { home: trees, exists: existsSync, branchOf: pr => `feat/card-${pr}`, recreate: () => {}, bringTo: () => {} }, dirty: () => false, liveSession: () => null })
    const outcome = await executor.answer(lease)
    made.tick()
    return outcome
  }
  const decide = (decisionId: number): void => {
    recordDecision(made.db, { ts: ts(), decisionId, text: `#${CARD}: the row may not grow; move the import instead`, cards: [CARD] })
    made.tick()
    made.tick()
  }
  const opensItsPr = (): void => {
    made.gitHub.open({ number: PR, head: sha('a'), review: 'success' })
    made.tick()
  }
  return { made, sessions: () => sessions, stopOnTheAgent, asks, decide, opensItsPr }
}

function openedWaits(card: Card): string[] {
  return eventsOf(card.made.db, OWNER_WAIT_OPENED).map(wait => String(wait.text))
}

const GROWTH_WORDS = ['grow', 'grows', 'growing', 'grown', 'growth', 'raise', 'raises', 'raising', 'bump', 'bumps', 'increase', 'increases', 'lift', 'рост', 'поднять']
const GROWTH_ARROWS = ['→', '->', '=>', '⟶']
const ROW_PREFIXES = ['boundary', 'law-gaps', 'lines-scope', 'lines', 'overlaps']

describe('the owner-only question path, member by member', () => {
  it('a ratchet question the owner already answered runs the answer round and opens no second wait', async () => {
    const card = startedCard()
    card.stopOnTheAgent(ASK)

    expect(await card.asks(ASK)).toMatchObject({ kind: 'stopped', reason: QUESTION_OWNER, detail: ASK })
    expect(card.sessions()).toBe(0)
    expect(openedWaits(card)).toEqual([ratchetGrowthLine(CARD, [ROW], ASK)])

    card.decide(1879)
    expect(await card.asks(ASK)).toMatchObject({ kind: 'denied', denial: { reason: 'repeated_stop' } })

    expect(card.sessions()).toBe(1)
    expect(openedWaits(card)).toHaveLength(1)
  })

  it('every growth word, arrow and row prefix stops for the owner', () => {
    const cases = [
      ...GROWTH_WORDS.map(word => ({ question: `${word} ${ROW} by one`, rows: [ROW] })),
      ...GROWTH_ARROWS.map(arrow => ({ question: `${ROW} 4${arrow}5`, rows: [ROW] })),
      ...ROW_PREFIXES.map(prefix => ({ question: `grow ${prefix}:scripts/a.ts by one`, rows: [`${prefix}:scripts/a.ts`] })),
    ]
    for (const { question, rows } of cases)
      expect(ratchetRowsAskedToGrow(question), question).toEqual(rows)
    for (const arrow of GROWTH_ARROWS)
      expect(ratchetRowsAskedToGrow(`${ROW} 5${arrow}4`), arrow).toEqual([])
  })

  it('a question naming two rows opens its own wait beside a wait for one of them', async () => {
    const card = startedCard()
    card.stopOnTheAgent(ASK)
    expect(await card.asks(ASK)).toMatchObject({ kind: 'stopped', reason: QUESTION_OWNER })
    card.opensItsPr()

    card.stopOnTheAgent(BOTH_ASK, PR)
    expect(await card.asks(BOTH_ASK)).toMatchObject({ kind: 'stopped', reason: QUESTION_OWNER, detail: BOTH_ASK })

    expect(openedWaits(card)).toEqual([ratchetGrowthLine(CARD, [ROW], ASK), ratchetGrowthLine(CARD, [ROW, OTHER_ROW], BOTH_ASK)])
    expect(card.sessions()).toBe(0)
  })

  it('a question naming one row opens its own wait beside a wait for another row', async () => {
    const card = startedCard()
    card.stopOnTheAgent(OTHER_ASK)
    expect(await card.asks(OTHER_ASK)).toMatchObject({ kind: 'stopped', reason: QUESTION_OWNER })
    card.opensItsPr()

    card.stopOnTheAgent(ASK, PR)
    expect(await card.asks(ASK)).toMatchObject({ kind: 'stopped', reason: QUESTION_OWNER, detail: ASK })

    expect(openedWaits(card)).toEqual([ratchetGrowthLine(CARD, [OTHER_ROW], OTHER_ASK), ratchetGrowthLine(CARD, [ROW], ASK)])
  })

  it('a question naming the rows of an open wait opens no second wait', async () => {
    const card = startedCard()
    card.stopOnTheAgent(BOTH_ASK)
    expect(await card.asks(BOTH_ASK)).toMatchObject({ kind: 'stopped', reason: QUESTION_OWNER })
    card.opensItsPr()

    card.stopOnTheAgent(ASK, PR)
    expect(await card.asks(ASK)).toMatchObject({ kind: 'stopped', reason: QUESTION_OWNER, detail: ASK })

    expect(openedWaits(card)).toEqual([ratchetGrowthLine(CARD, [ROW, OTHER_ROW], BOTH_ASK)])
  })
})
