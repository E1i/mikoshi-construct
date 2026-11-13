import type { Lease } from '../../core/lease.js'
import type { CardStart, QueuedCard, StartedCard } from '../../nodes/launch/launch-executor.js'
import type { SessionContinuer } from '../../nodes/launch/launch-starter.js'
import type { TreePrCliPorts } from '../../nodes/launch/tree-pr-cli.js'
import type { ProcessTable } from '../../nodes/restart/chain-process.js'
import type { CardTreeTools } from '../../ports/card-tree.js'
import type { MergeBench } from './merge-bench.js'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_ADMITTED, CARD_ANSWERED, CARD_CONTINUED, CARD_STARTED, CARD_STOPPED } from '../../core/events.js'
import { leaseNext } from '../../core/lease.js'
import { eddiesJournalPath } from '../../core/places.js'
import { queueTask } from '../../core/queue.js'
import { ANSWER_RESTARTS, AnswerExecutor } from '../../nodes/answer/answer-executor.js'
import { answerHandoffPath, claudeAnswerer } from '../../nodes/answer/answerer.js'
import { MAX_RESTARTS, reachedContextLine } from '../../nodes/launch/continuation.js'
import { LaunchNode } from '../../nodes/launch/launch-worker.js'
import { busAtContextLine, runTreePr } from '../../nodes/launch/tree-pr-cli.js'
import { DISK_FLOOR_BYTES } from '../../ports/disk.js'
import { nodeSupply } from '../../supervisor/composition.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { sha } from './github-fake.js'
import { eventsOf, mergeBench } from './merge-bench.js'

const benches: MergeBench[] = []
const roots: string[] = []
const CONTEXT_WARN = 200_000

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

function bench(): MergeBench {
  const made = mergeBench()
  benches.push(made)
  return made
}

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'eddiesline-'))
  roots.push(root)
  return root
}

class ContinuingStarter implements SessionContinuer {
  stops: StartedCard[] = []
  continued = 0

  start(card: QueuedCard): CardStart {
    return { kind: 'started', card: { session: `s-${card.cardId}`, worktree: `/trees/mc-${card.cardId}`, branch: `feat/card-${card.cardId}`, base: 'f'.repeat(40), pid: 4242, pgid: 4242 } }
  }

  stop(card: StartedCard): void {
    this.stops.push(card)
  }

  continueFrom(_card: QueuedCard, from: StartedCard): CardStart {
    this.continued += 1
    return { kind: 'started', card: { ...from, session: `${from.session}-c${this.continued}` } }
  }
}

interface LaunchedAtLine {
  node: LaunchNode
  starter: ContinuingStarter
  published: string[]
}

async function launchedAtLine(made: MergeBench, cardId: number, wired = true): Promise<LaunchedAtLine> {
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'policy', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${cardId}`, payload: { lane: 'lane-a', decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${cardId}` }, legacy: false })
  made.tick()
  const starter = new ContinuingStarter()
  const published: string[] = []
  const exited: ProcessTable = { commandLine: () => null, signalGroup: () => {} }
  const node = new LaunchNode({ silentMs: SILENT_MS, db: made.db, starter, ...(wired ? { continuer: starter } : {}), clock: made.clock.now, session: 'node-1', mode: 'live', env: {}, processes: exited, resulted: () => true, handedOff: () => true, warned: () => true, atContextLine: () => true, committed: () => true, publish: card => published.push(card.session), disk: () => ({ bavail: 1, bsize: DISK_FLOOR_BYTES }), isolation: () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] }) })
  const controller = new AbortController()
  await node.run({ pause: async () => controller.abort(), signal: controller.signal, supply: nodeSupply() })
  made.tick()
  return { node, starter, published }
}

function journalIn(worktree: string, lines: readonly object[]): void {
  const journal = eddiesJournalPath(worktree)
  mkdirSync(path.dirname(journal), { recursive: true })
  writeFileSync(journal, lines.map(line => JSON.stringify(line)).join('\n'))
}

function questionOn(made: MergeBench, cardId: number, worktree: string): () => Lease {
  const ts = made.clock.now().toISOString()
  appendEvent(made.db, { ts, type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${cardId}`, payload: { session: 'card-session', worktree, branch: `feat/card-${cardId}`, base: sha('1') }, legacy: false })
  appendEvent(made.db, { ts, type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${cardId}`, payload: { reason: 'question.agent', detail: 'a question' }, legacy: false })
  const stop = made.db.prepare(`SELECT max(id) AS id FROM events WHERE type = '${CARD_STOPPED}'`).get() as { id: number }
  queueTask(made.db, ts, { queue: 'answer', cardId, stop: Number(stop.id) })
  return () => leaseNext(made.db, ts, 'answer', 'worker:answer:worker-1')!
}

function treesOf(root: string): CardTreeTools {
  return { home: root, exists: existsSync, branchOf: pr => `feat/card-${pr}`, recreate: () => {}, bringTo: () => {} }
}

describe('the launch session at the context warn', () => {
  it('a launch session at the context warn hands off and continues in a fresh session with no push', async () => {
    const made = bench()
    const { node, starter, published } = await launchedAtLine(made, 1701)

    expect(node.stopOverdue()).toEqual([])

    expect(starter.continued).toBe(1)
    expect(published).toEqual([])
    expect(eventsOf(made.db, CARD_STOPPED)).toEqual([])
    expect(eventsOf(made.db, CARD_CONTINUED)).toMatchObject([{ session: 's-1701-c1', continuation: 1, from: 's-1701' }])
  })

  it('a missing continuer stops the card with continuation-refused and no push', async () => {
    const made = bench()
    const { node, starter, published } = await launchedAtLine(made, 1702, false)

    expect(node.stopOverdue()).toEqual([1702])

    expect(starter.continued).toBe(0)
    expect(published).toEqual([])
    expect(eventsOf(made.db, CARD_STOPPED)).toEqual([expect.objectContaining({ reason: 'fault', detail: expect.stringContaining('continuation-refused') })])
  })

  it('past MAX_RESTARTS the card stops with no push and says so', async () => {
    const made = bench()
    const { node, starter, published } = await launchedAtLine(made, 1703)

    for (let restart = 0; restart < MAX_RESTARTS; restart += 1) {
      expect(node.stopOverdue()).toEqual([])
      made.tick()
    }
    expect(node.stopOverdue()).toEqual([1703])

    expect(starter.continued).toBe(MAX_RESTARTS)
    expect(published).toEqual([])
    const [stop] = eventsOf(made.db, CARD_STOPPED) as { reason: string, detail: string }[]
    expect(stop?.reason).toBe('fault')
    expect(stop?.detail).toContain('continuation-limit')
    expect(stop?.detail).toContain(`${MAX_RESTARTS} of ${MAX_RESTARTS} continuations used`)
    expect(stop?.detail).toContain('pushed nothing')
  })

  it('tree-pr leaves the tree as it is at the line and reads the journal of the continued session', () => {
    const root = tempRoot()
    const busPath = path.join(root, 'bus.db')
    const db = openBus(busPath)
    const ts = '2026-11-05T05:00:00.000Z'
    const turn = (type: string, payload: object): void => {
      appendEvent(db, { ts, type, actor: 'worker:launch:1', cardId: 1704, pr: null, head: null, dedupeKey: `${type}:1704`, payload, legacy: false })
    }
    turn(CARD_STARTED, { session: 'first' })
    turn(CARD_CONTINUED, { session: 'second' })
    const untouchable = (): never => {
      throw new Error('tree-pr went past the guard')
    }
    const ports = { card: untouchable, atContextLine: busAtContextLine(busPath) } as unknown as TreePrCliPorts
    const lines: string[] = []

    journalIn(root, [{ event: 'budget-warn', level: 'session-context', session_id: 'first' }])
    expect(busAtContextLine(busPath)(1704, root)).toBe(false)

    journalIn(root, [{ event: 'budget-warn', level: 'session-spend', session_id: 'second' }])
    expect(busAtContextLine(busPath)(1704, root)).toBe(false)

    journalIn(root, [{ event: 'budget-warn', level: 'session-context', session_id: 'second' }])
    expect(runTreePr(['1704', root], ports, line => lines.push(line))).toBe(0)
    expect(lines.join('\n')).toContain('nothing is pushed')

    turn(CARD_STOPPED, { reason: 'fault' })
    db.close()
    expect(busAtContextLine(busPath)(1704, root)).toBe(false)
  })

  it('the context line is a budget-warn of this session at the context level, and a spend warn is not', () => {
    const root = tempRoot()
    journalIn(root, [{ event: 'budget-warn', level: 'session-spend', session_id: 's' }, { event: 'budget-warn', level: 'session-context', session_id: 'other' }])
    expect(reachedContextLine(root, 's')).toBe(false)
    expect(reachedContextLine(root, 'other')).toBe(true)
    expect(reachedContextLine(path.join(root, 'no-tree'), 's')).toBe(false)
  })
})

describe('the answer session at the context warn', () => {
  it('the restart bound of the answer node is the MAX_RESTARTS of the launch node, which it may not import', () => {
    expect(ANSWER_RESTARTS).toBe(MAX_RESTARTS)
  })

  it('an answer session at the context warn hands off and continues in a fresh session with no push', async () => {
    const made = bench()
    const root = tempRoot()
    const worktree = path.join(root, 'mc-1705')
    mkdirSync(path.dirname(answerHandoffPath(worktree)), { recursive: true })
    const answers = path.join(root, 'answers')
    const lease = questionOn(made, 1705, worktree)()
    const contexts = new Map<string, number>()
    const sessions = ['fresh-session']
    const prompts: string[] = []
    const pushedAfter: string[] = []
    let current = ''
    const answerer = claudeAnswerer(answers, {
      cardText: () => null,
      available: () => true,
      remoteHead: () => pushedAfter.length === 0 ? sha('a') : sha('e'),
      spawn: async (run) => {
        current = run.argv.includes('--resume') ? 'card-session' : 'fresh-session'
        prompts.push(run.argv.at(-1)!)
        contexts.set(current, current === 'card-session' ? CONTEXT_WARN + 1 : 40_000)
        if (current === 'card-session')
          writeFileSync(answerHandoffPath(worktree), 'the handoff the first session left')
        writeFileSync(run.stdoutPath, `${JSON.stringify({ type: 'result', subtype: 'success', result: 'ended' })}\n`)
        return 0
      },
      newSession: () => sessions.shift()!,
      publish: () => pushedAfter.push(current),
      context: session => contexts.get(session) ?? null,
      contextWarn: () => CONTEXT_WARN,
      diff: () => 'diff --git a/x b/x',
    })
    const executor = new AnswerExecutor({ silentMs: SILENT_MS, db: made.db, answerer, ownerMerges: () => '', clock: made.clock.now, trees: treesOf(root), liveSession: () => null, dirty: () => false })

    expect(await executor.answer(lease)).toMatchObject({ kind: 'answered', session: 'fresh-session', resumed: false })

    expect(pushedAfter).toEqual(['fresh-session'])
    expect(prompts).toHaveLength(2)
    expect(prompts[0]).toContain('On the context warn')
    expect(prompts[1]).toContain('the handoff the first session left')
    expect(eventsOf(made.db, CARD_ANSWERED)).toMatchObject([{ session: 'fresh-session', resumed: false }])
  })

  it('past MAX_RESTARTS the answer stops the card with no push and says so', async () => {
    const made = bench()
    const root = tempRoot()
    const worktree = path.join(root, 'mc-1706')
    mkdirSync(worktree)
    const lease = questionOn(made, 1706, worktree)
    const pushed: string[] = []
    let spawned = 0
    const answerer = claudeAnswerer(path.join(root, 'answers'), {
      cardText: () => null,
      available: () => true,
      remoteHead: () => sha('a'),
      spawn: async (run) => {
        spawned += 1
        writeFileSync(run.stdoutPath, `${JSON.stringify({ type: 'result', subtype: 'success', result: 'ended' })}\n`)
        return 0
      },
      newSession: () => `fresh-${spawned}`,
      publish: () => pushed.push('pushed'),
      context: () => CONTEXT_WARN + 1,
      contextWarn: () => CONTEXT_WARN,
      diff: () => null,
    })
    const executor = new AnswerExecutor({ silentMs: SILENT_MS, db: made.db, answerer, ownerMerges: () => '', clock: made.clock.now, trees: treesOf(root), liveSession: () => null, dirty: () => false })

    expect(await executor.answer(lease())).toMatchObject({ kind: 'stopped', reason: 'fault' })

    expect(spawned).toBe(MAX_RESTARTS + 1)
    expect(pushed).toEqual([])
    const stops = eventsOf(made.db, CARD_STOPPED) as { detail: string, code?: string }[]
    expect(stops.at(-1)).toMatchObject({ code: 'continuation-limit', detail: expect.stringContaining('pushed nothing') })
  })
})
