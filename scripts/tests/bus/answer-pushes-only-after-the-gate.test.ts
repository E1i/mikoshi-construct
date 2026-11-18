import type { Lease } from '../../core/lease.js'
import type { AnswerOutcome } from '../../nodes/answer/duties/index.js'
import type { CardTreeTools } from '../../ports/card-tree.js'
import type { MergeBench } from './merge-bench.js'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PREPUSH_COMMAND } from '../../ci/prepush.js'
import { appendEvent } from '../../core/db.js'
import { CARD_ANSWERED, CARD_STARTED, CARD_STOPPED } from '../../core/events.js'
import { leaseNext } from '../../core/lease.js'
import { queueTask } from '../../core/queue.js'
import { AnswerExecutor } from '../../nodes/answer/answer-executor.js'
import { claudeAnswerer, gateDecisionOf, gateRunOutcome } from '../../nodes/answer/answerer.js'
import { cardTransitions } from '../../supervisor/composition.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { sha } from './github-fake.js'
import { eventsOf, mergeBench } from './merge-bench.js'

const CARD = 951
const TYPECHECK = 'pnpm typecheck'
const ROUND = sha('b')
const GATE = [TYPECHECK, `${PREPUSH_COMMAND} --round ${ROUND}`]

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

interface GateResult {
  command: string
  isError: boolean
  content: string
}

function bashUse(id: string, command: string): string {
  return JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } })
}

function bashResult(id: string, isError: boolean, content: string): string {
  return JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content }] } })
}

interface Round {
  outcome: AnswerOutcome
  published: number
  made: MergeBench
}

async function roundWith(results: readonly GateResult[], dirty = true): Promise<Round> {
  const made = mergeBench()
  benches.push(made)
  const trees = mkdtempSync(path.join(tmpdir(), 'answer-gate-'))
  roots.push(trees)
  const worktree = path.join(trees, `mc-${CARD}`)
  mkdirSync(worktree)
  writeFileSync(path.join(worktree, 'construct.json'), `${JSON.stringify({ harness: { command: 'pnpm run quality' }, shift: { prepush: [TYPECHECK, PREPUSH_COMMAND] } })}\n`)
  const ts = made.clock.now().toISOString()
  appendEvent(made.db, { ts, type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD}`, payload: { session: 'card-session-1', worktree, branch: `feat/card-${CARD}`, base: sha('1') }, legacy: false })
  appendEvent(made.db, { ts, type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${CARD}`, payload: { reason: 'question.agent', detail: 'a question' }, legacy: false })
  const stop = Number((made.db.prepare('SELECT max(id) AS id FROM events WHERE type = ?').get(CARD_STOPPED) as { id: number }).id)
  queueTask(made.db, ts, { queue: 'answer', cardId: CARD, stop })
  const lease = (): Lease => leaseNext(made.db, ts, 'answer', 'worker:answer:worker-1')!
  let published = 0
  const heads = [sha('a'), sha('a')]
  const answerer = claudeAnswerer(path.join(trees, 'answers'), {
    cardText: () => null,
    available: () => true,
    remoteHead: () => heads.shift() ?? sha('a'),
    localHead: () => ROUND,
    spawn: async (run) => {
      const lines = results.flatMap((result, index) => [bashUse(`t${index}`, result.command), bashResult(`t${index}`, result.isError, result.content)])
      lines.forEach(line => run.onLine?.(line))
      writeFileSync(run.stdoutPath, `${lines.join('\n')}\n`)
      return 0
    },
    newSession: () => 'new-session-1',
    publish: () => {
      published += 1
    },
  })
  const cardTrees: CardTreeTools = { home: trees, exists: existsSync, branchOf: pr => `feat/card-${pr}`, recreate: () => {}, bringTo: () => {} }
  const executor = new AnswerExecutor({ cards: cardTransitions(), silentMs: SILENT_MS, db: made.db, answerer, ownerMerges: () => '', clock: made.clock.now, trees: cardTrees, liveSession: () => null, prepare: () => null, dirty: () => dirty, localHead: () => sha('a') })
  return { outcome: await executor.answer(lease()), published, made }
}

describe('an answer round pushes only after the gate decided', () => {
  it('an answer round with no gate decision pushes nothing', async () => {
    for (const results of [[], [{ command: TYPECHECK, isError: false, content: 'ok' }]]) {
      const { outcome, published, made } = await roundWith(results)
      expect(published).toBe(0)
      expect(outcome).toMatchObject({ kind: 'denied', denial: { reason: 'answer_failed', detail: expect.stringMatching(/recorded no gate decision.*pushed nothing.*the answer goes again/) } })
      expect(eventsOf(made.db, CARD_ANSWERED)).toEqual([])
    }
  })

  it('a gate that could not run is an explicit outcome, never null, and the push reads it', async () => {
    const timedOut = [{ command: TYPECHECK, isError: false, content: 'ok' }, { command: `${PREPUSH_COMMAND} --round ${ROUND}`, isError: true, content: 'Command timed out after 10m 0s' }]
    expect(gateRunOutcome(true, 'Command timed out after 10m 0s')).toBe('unrun')
    expect(gateRunOutcome(true, [{ type: 'text', text: 'listen EPERM: operation not permitted' }])).toBe('unrun')
    expect(gateRunOutcome(true, 'FAIL tests/x.test.ts')).toBe('red')
    expect(gateRunOutcome(false, 'ok')).toBe('green')
    expect(gateDecisionOf(GATE.length, ['green', 'unrun'])).toBe('unrun')
    expect(gateDecisionOf(GATE.length, ['green'])).toBeNull()
    expect(gateDecisionOf(0, [])).toBe('undeclared')
    const { published, outcome } = await roundWith(timedOut)
    expect(published).toBe(1)
    expect(outcome.kind).not.toBe('fenced')
  })

  it('a round that ran every gate command pushes, and a clean round with nothing to push is not refused for its gate', async () => {
    const green = GATE.map(command => ({ command, isError: false, content: 'ok' }))
    expect((await roundWith(green)).published).toBe(1)
    const clean = await roundWith([], false)
    expect(clean.published).toBe(0)
    expect(clean.outcome).not.toMatchObject({ denial: { detail: expect.stringMatching(/no gate decision/) } })
  })
})
