import type { Lease } from '../../../core/lease.js'
import type { CardTreeTools } from '../../../ports/card-tree.js'
import type { MergeBench } from '../merge-bench.js'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendEvent } from '../../../core/db.js'
import { CARD_ANSWERED, CARD_CONTINUED, CARD_STARTED, CARD_STOPPED } from '../../../core/events.js'
import { leaseNext } from '../../../core/lease.js'
import { queueTask } from '../../../core/queue.js'
import { AnswerExecutor } from '../../../nodes/answer/answer-executor.js'
import { cardSessionOf } from '../../../nodes/answer/answer-source.js'
import { claudeAnswerer } from '../../../nodes/answer/answerer.js'
import { SILENT_MS } from '../../../supervisor/liveness-sites.js'
import { sha } from '../github-fake.js'
import { eventsOf, mergeBench, taskState } from '../merge-bench.js'

const CARD = 1852
const LAUNCH_SESSION = 'launch-session'
const CONTINUED_SESSION = 'continued-session'
const ANSWER_SESSION = 'answer-session'
const FRESH_SESSION = 'fresh-session'
const CONTEXT_WARN = 200_000
const OVER_THE_WARN = 201_662
const UNDER_THE_WARN = 40_000

const benches: MergeBench[] = []
const roots: string[] = []

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const made of benches.splice(0))
    made.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

interface Card {
  made: MergeBench
  trees: string
  worktree: string
  record: (type: string, payload: object) => number
}

function startedCard(): Card {
  const made = mergeBench()
  benches.push(made)
  const trees = mkdtempSync(path.join(tmpdir(), 'conveyor-k6-'))
  roots.push(trees)
  const worktree = path.join(trees, `mc-${CARD}`)
  mkdirSync(worktree)
  let sequence = 0
  const record = (type: string, payload: object): number => {
    sequence += 1
    appendEvent(made.db, { ts: made.clock.now().toISOString(), type, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${type}:${CARD}:${sequence}`, payload, legacy: false })
    return Number((made.db.prepare('SELECT max(id) AS id FROM events').get() as { id: number }).id)
  }
  record(CARD_STARTED, { session: LAUNCH_SESSION, worktree, branch: `feat/card-${CARD}`, base: sha('1') })
  return { made, trees, worktree, record }
}

function questionLease(card: Card): Lease {
  const stop = card.record(CARD_STOPPED, { reason: 'question.agent', detail: `a question on card #${CARD}` })
  const ts = card.made.clock.now().toISOString()
  queueTask(card.made.db, ts, { queue: 'answer', cardId: CARD, stop })
  return leaseNext(card.made.db, ts, 'answer', 'worker:answer:worker-1')!
}

const KNOWN_SESSIONS = [LAUNCH_SESSION, ANSWER_SESSION, FRESH_SESSION]

function sessionRunIn(argv: readonly string[]): string | null {
  return KNOWN_SESSIONS.find(session => argv.includes(session)) ?? null
}

describe('scenario 08: the session carries over between rounds', () => {
  it('scenario 08: the next answer resumes the last answer session when the launch session is over the context warning', async () => {
    const card = startedCard()
    card.record(CARD_ANSWERED, { session: ANSWER_SESSION, worktree: card.worktree, resumed: false, source: 'question', from: sha('a'), to: sha('b') })
    const lease = questionLease(card)
    const contexts = new Map<string, number>([[LAUNCH_SESSION, OVER_THE_WARN], [ANSWER_SESSION, UNDER_THE_WARN]])
    const ranIn: (string | null)[] = []
    const heads = [sha('b'), sha('c')]
    const cardTrees: CardTreeTools = { home: card.trees, exists: existsSync, branchOf: pr => `feat/card-${pr}`, recreate: () => {}, bringTo: () => {} }
    const answerer = claudeAnswerer(path.join(card.trees, 'answers'), {
      cardText: () => null,
      available: () => true,
      remoteHead: () => heads.shift() ?? null,
      spawn: async (run) => {
        ranIn.push(sessionRunIn(run.argv))
        writeFileSync(run.stdoutPath, `${JSON.stringify({ type: 'result', subtype: 'success', result: 'answered' })}\n`)
        return 0
      },
      newSession: () => FRESH_SESSION,
      publish: () => {},
      context: session => contexts.get(session) ?? null,
      contextWarn: () => CONTEXT_WARN,
    })
    const executor = new AnswerExecutor({ silentMs: SILENT_MS, db: card.made.db, answerer, ownerMerges: () => readFileSync('architecture/owner-merges.md', 'utf8'), clock: card.made.clock.now, trees: cardTrees })

    expect(await executor.answer(lease)).toMatchObject({ kind: 'answered', session: ANSWER_SESSION, resumed: true, head: sha('c') })
    expect(ranIn).toEqual([ANSWER_SESSION])
    expect(eventsOf(card.made.db, CARD_ANSWERED).at(-1)).toMatchObject({ session: ANSWER_SESSION, resumed: true })
    expect(taskState(card.made.db, lease.taskKey).state).toBe('completed')
  })

  it('the card session is the latest of the started, continued and answered sessions, on the started tree', () => {
    const card = startedCard()
    const branch = `feat/card-${CARD}`

    expect(cardSessionOf(card.made.db, CARD)).toEqual({ session: LAUNCH_SESSION, worktree: card.worktree, branch })
    card.record(CARD_CONTINUED, { session: CONTINUED_SESSION })
    expect(cardSessionOf(card.made.db, CARD)?.session).toBe(CONTINUED_SESSION)
    card.record(CARD_ANSWERED, { session: ANSWER_SESSION, worktree: card.worktree })
    expect(cardSessionOf(card.made.db, CARD)).toEqual({ session: ANSWER_SESSION, worktree: card.worktree, branch })
    card.record(CARD_ANSWERED, { resumed: false })
    expect(cardSessionOf(card.made.db, CARD)?.session).toBe(ANSWER_SESSION)
  })

  it('a later card.started takes the card back to its own session and tree', () => {
    const card = startedCard()
    card.record(CARD_ANSWERED, { session: ANSWER_SESSION })
    const relaunched = path.join(card.trees, 'relaunched')
    card.record(CARD_STARTED, { session: 'relaunch-session', worktree: relaunched, branch: 'feat/relaunched', base: sha('2') })

    expect(cardSessionOf(card.made.db, CARD)).toEqual({ session: 'relaunch-session', worktree: relaunched, branch: 'feat/relaunched' })
  })

  it('answer-source.ts and launch-root.ts read the card session from card-record and name no session event type of their own', () => {
    const source = readFileSync('scripts/nodes/answer/answer-source.ts', 'utf8')
    const launchRoot = readFileSync('scripts/nodes/launch/launch-root.ts', 'utf8')
    const sharedReading = /import \{[^}]*\bcardSessionsIn\b[^}]*\} from '\.\.\/\.\.\/core\/card-bodies\.js'/

    expect(source).toMatch(sharedReading)
    expect(launchRoot).toMatch(sharedReading)
    expect(source).not.toContain('launch/')
    for (const named of ['CARD_CONTINUED', 'CARD_ANSWERED', 'card.continued', 'card.answered']) {
      expect(source).not.toContain(named)
      expect(launchRoot).not.toContain(named)
    }
  })
})
