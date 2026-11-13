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
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { sha } from '../bus/github-fake.js'
import { eventsOf, mergeBench } from '../bus/merge-bench.js'

const CARD = 1843
const CARD_SESSION = 'card-session-1843'
const ROW = 'boundary:session->window'
const FIRST_ASK = `the move needs ${ROW} 4→5 in contract/ratchet.json; may the card grow it?`
const REWORDED_ASK = `may contract/ratchet.json raise ${ROW} from 4 to 5 for the moved import?`
const PLAIN_QUESTION = 'which of the two readings of the brief does the card mean?'

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
  stopOnTheAgent: (question: string) => void
  asks: (question: string) => Promise<unknown>
  nextAnswer: () => unknown
}

function startedCard(): Card {
  const made = mergeBench()
  benches.push(made)
  const trees = mkdtempSync(path.join(tmpdir(), 'owner-only-question-'))
  roots.push(trees)
  const worktree = path.join(trees, `mc-${CARD}`)
  mkdirSync(worktree)
  const answers = path.join(trees, 'answers')
  const ts = (): string => made.clock.now().toISOString()
  appendEvent(made.db, { ts: ts(), type: CARD_ADMITTED, actor: 'policy', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${CARD}`, payload: { lane: 'lane-a', decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${CARD}` }, legacy: false })
  appendEvent(made.db, { ts: ts(), type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD}`, payload: { session: CARD_SESSION, worktree, branch: `feat/card-${CARD}`, base: sha('1') }, legacy: false })
  let stops = 0
  let sessions = 0
  const stopOnTheAgent = (question: string): void => {
    stops += 1
    appendEvent(made.db, { ts: ts(), type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${CARD}:agent-${stops}`, payload: { reason: QUESTION_AGENT, detail: question }, legacy: false })
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
  const nextAnswer = (): unknown => leaseNext(made.db, made.clock.now().toISOString(), 'answer', 'worker:answer:worker-1')
  return { made, sessions: () => sessions, stopOnTheAgent, asks, nextAnswer }
}

describe('a question only the owner can answer', () => {
  it('a question asking a ratchet row to grow stops for the owner at its first occurrence', async () => {
    const card = startedCard()
    card.stopOnTheAgent(PLAIN_QUESTION)

    expect(await card.asks(FIRST_ASK)).toMatchObject({ kind: 'stopped', reason: QUESTION_OWNER, detail: FIRST_ASK })
    expect(eventsOf(card.made.db, CARD_STOPPED).map(stop => stop.reason)).toEqual([QUESTION_AGENT, QUESTION_OWNER])
    expect(eventsOf(card.made.db, OWNER_WAIT_OPENED)).toEqual([expect.objectContaining({ text: ratchetGrowthLine(CARD, [ROW], FIRST_ASK) })])
    expect(card.nextAnswer()).toBeNull()
  })

  it('a reworded ask for the same ratchet row does not start another answer round', async () => {
    const card = startedCard()
    card.stopOnTheAgent(FIRST_ASK)

    expect(await card.asks(REWORDED_ASK)).toMatchObject({ kind: 'stopped', reason: QUESTION_OWNER, detail: FIRST_ASK })
    card.stopOnTheAgent(REWORDED_ASK)
    expect(await card.asks(FIRST_ASK)).toMatchObject({ kind: 'stopped', reason: QUESTION_OWNER, detail: REWORDED_ASK })

    expect(card.sessions()).toBe(0)
    expect(eventsOf(card.made.db, OWNER_WAIT_OPENED)).toHaveLength(1)
    expect(card.nextAnswer()).toBeNull()
  })

  it('a ratchet row is asked to grow only when the question names a growth', () => {
    expect(ratchetRowsAskedToGrow(FIRST_ASK)).toEqual([ROW])
    expect(ratchetRowsAskedToGrow(REWORDED_ASK)).toEqual([ROW])
    expect(ratchetRowsAskedToGrow(`${ROW} 5→4, the import left`)).toEqual([])
    expect(ratchetRowsAskedToGrow(PLAIN_QUESTION)).toEqual([])
    expect(ratchetRowsAskedToGrow(`grow lines:scripts/board/board-page.ts. to 1941?`)).toEqual(['lines:scripts/board/board-page.ts'])
  })

  it('another question after a plain stop stays with the agent', async () => {
    const card = startedCard()
    card.stopOnTheAgent(PLAIN_QUESTION)

    expect(await card.asks('does the second reading keep the first test?')).toMatchObject({ kind: 'stopped', reason: QUESTION_AGENT })
    expect(eventsOf(card.made.db, OWNER_WAIT_OPENED)).toEqual([])
  })
})
