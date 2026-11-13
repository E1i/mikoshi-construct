import type { CardStart, QueuedCard, StartedCard } from '../../nodes/launch/launch-executor.js'
import type { SessionContinuer } from '../../nodes/launch/launch-starter.js'
import type { ProcessTable } from '../../nodes/restart/chain-process.js'
import type { CardTreeTools } from '../../ports/card-tree.js'
import type { MergeBench } from './merge-bench.js'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeBus } from '../../../tests/board/bus-fixture.js'
import { printBoard, readEddiesLimits } from '../../cli/board-page.js'
import { appendEvent } from '../../core/db.js'
import { CARD_ADMITTED, CARD_CONTINUED, CARD_STARTED, CARD_STOPPED, SESSION_HEARTBEAT, WINDOW_HEARTBEAT } from '../../core/events.js'
import { leaseNext } from '../../core/lease.js'
import { eddiesJournalPath } from '../../core/places.js'
import { queueTask } from '../../core/queue.js'
import { AnswerExecutor } from '../../nodes/answer/answer-executor.js'
import { answerHandoffPath, claudeAnswerer, contextWarnOfEddies } from '../../nodes/answer/answerer.js'
import { reachedContextLine } from '../../nodes/launch/continuation.js'
import { LaunchNode } from '../../nodes/launch/launch-worker.js'
import { DISK_FLOOR_BYTES } from '../../ports/disk.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { realExitReadings, sessionGauges } from '../../window/eddies-measure.js'
import { sha } from './github-fake.js'
import { eventsOf, mergeBench } from './merge-bench.js'

const HOOK = path.resolve(import.meta.dirname, '../../../templates/ai/claude/scripts/construct/eddies.mjs')
const LIVE_HOOK = path.resolve(import.meta.dirname, '../../../.claude/hooks/eddies.mjs')
const AT_THE_LINE = 151_000
const BELOW_THE_LINE = 149_000
const CARD_LINE = 150_000
const MODEL = 'claude-opus-5-5'
const LIMITS = {
  contextLimit: 250_000,
  cardContextLine: CARD_LINE,
  sessionSpend: 3_000_000,
  agentSpend: 2_000_000,
  runSpend: 3_000_000,
  warnRatio: 0.8,
  modelWindows: { [MODEL]: 1_000_000 },
}
const NOW = new Date('2026-11-05T08:00:00.000Z')
const benches: MergeBench[] = []
const roots: string[] = []

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
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

function treeWithLimits(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'eddiesline150-'))
  roots.push(root)
  mkdirSync(path.join(root, '.claude'))
  writeFileSync(eddiesFileIn(root), JSON.stringify(LIMITS))
  return root
}

function eddiesFileIn(root: string): string {
  return path.join(root, '.claude', 'eddies.json')
}

function transcriptAt(root: string, session: string, context: number, model: string | null = MODEL): string {
  const file = path.join(root, '.claude', 'projects', 'p', `${session}.jsonl`)
  mkdirSync(path.dirname(file), { recursive: true })
  const message = { role: 'assistant', ...(model === null ? {} : { model }), usage: { input_tokens: context, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }
  writeFileSync(file, `${JSON.stringify({ requestId: 'r1', message })}\n`)
  return file
}

function guardRun(root: string, session: string, transcript: string, card: string, hook = HOOK): { status: number | null, stderr: string } {
  const input = JSON.stringify({ session_id: session, transcript_path: transcript, tool_name: 'Bash', tool_input: { command: 'ls' } })
  return spawnSync(process.execPath, [hook, 'guard'], { input, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root, CONSTRUCT_CARD: card, CONSTRUCT_HANDOFF_DIR: root } })
}

function hookOn(root: string, session: string, transcript: string, card: string, hook = HOOK): void {
  const run = guardRun(root, session, transcript, card, hook)
  expect(run.status, run.stderr).toBe(0)
}

class ContinuingStarter implements SessionContinuer {
  continued = 0

  start(card: QueuedCard): CardStart {
    return { kind: 'started', card: { session: `s-${card.cardId}`, worktree: `/trees/mc-${card.cardId}`, branch: `feat/card-${card.cardId}`, base: 'f'.repeat(40), pid: 4242, pgid: 4242 } }
  }

  stop(): void {}

  continueFrom(_card: QueuedCard, from: StartedCard): CardStart {
    this.continued += 1
    return { kind: 'started', card: { ...from, session: `${from.session}-c${this.continued}` } }
  }
}

async function launchedOver(made: MergeBench, cardId: number, tree: string): Promise<{ node: LaunchNode, starter: ContinuingStarter, published: string[] }> {
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'policy', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${cardId}`, payload: { lane: 'lane-a', decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${cardId}` }, legacy: false })
  made.tick()
  const starter = new ContinuingStarter()
  const published: string[] = []
  const exited: ProcessTable = { commandLine: () => null, signalGroup: () => {} }
  const node = new LaunchNode({ silentMs: SILENT_MS, db: made.db, starter, continuer: starter, clock: made.clock.now, session: 'node-1', mode: 'live', env: {}, processes: exited, resulted: () => true, handedOff: () => true, warned: () => false, atContextLine: card => reachedContextLine(tree, card.session), committed: () => true, publish: card => published.push(card.session), disk: () => ({ bavail: 1, bsize: DISK_FLOOR_BYTES }), isolation: () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] }) })
  const controller = new AbortController()
  await node.run({ pause: async () => controller.abort(), signal: controller.signal })
  made.tick()
  return { node, starter, published }
}

function boardOver(root: string, events: { ts: string, type: string, card: number | null, payload: string }[]): string {
  const file = path.join(root, 'bus.db')
  writeBus(file, {
    cards: [{ id: 1801, state: 'running', lane: 'lane-1', line: '#1801 line', since: minutesAgo(20) }],
    roles: [{ role: 'operator', status: 'idle', state: 'awake' }],
    events: [{ ts: minutesAgo(1), type: 'netwatch.tick', card: null, payload: '{}' }, ...events],
  })
  const db = new DatabaseSync(file)
  db.exec('ALTER TABLE card_bodies ADD COLUMN admission_event_id INTEGER; ALTER TABLE card_bodies ADD COLUMN text_sha TEXT NOT NULL DEFAULT \'\'')
  db.close()
  let html = ''
  expect(printBoard(file, NOW, (text) => {
    html += text
  }, path.join(root, 'miko.md'), 'html', eddiesFileIn(root))).toBe(0)
  return html
}

function minutesAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString()
}

function cardBeat(payload: object): { ts: string, type: string, card: number, payload: string } {
  return { ts: minutesAgo(3), type: SESSION_HEARTBEAT, card: 1801, payload: JSON.stringify({ step: 'launch', session: 's-1801', ...payload }) }
}

describe('the 150k line of a launch session', () => {
  it('a launch session at 151k hands off and continues in a fresh session with no push', async () => {
    const tree = treeWithLimits()
    hookOn(tree, 's-1810', transcriptAt(tree, 's-1810', AT_THE_LINE), '1810')
    expect(reachedContextLine(tree, 's-1810')).toBe(true)
    const made = bench()
    const { node, starter, published } = await launchedOver(made, 1810, tree)

    expect(node.stopOverdue()).toEqual([])

    expect(starter.continued).toBe(1)
    expect(published).toEqual([])
    expect(eventsOf(made.db, CARD_STOPPED)).toEqual([])
    expect(eventsOf(made.db, CARD_CONTINUED)).toMatchObject([{ session: 's-1810-c1', continuation: 1, from: 's-1810' }])
  })

  it('a session at exactly the 150k line crosses it', () => {
    for (const hook of [HOOK, LIVE_HOOK]) {
      const tree = treeWithLimits()
      hookOn(tree, 's-exact', transcriptAt(tree, 's-exact', CARD_LINE), '1814', hook)
      expect(reachedContextLine(tree, 's-exact'), hook).toBe(true)
    }
  })

  it('a launch session at 149k is below the line, and warnRatio does not move it to 120k', () => {
    const tree = treeWithLimits()
    hookOn(tree, 's-low', transcriptAt(tree, 's-low', BELOW_THE_LINE), '1811')
    expect(reachedContextLine(tree, 's-low')).toBe(false)
    expect(existsSync(eddiesJournalPath(tree))).toBe(false)
  })

  it('a config with no card line falls back to contextLimit times warnRatio', () => {
    const tree = treeWithLimits()
    const { cardContextLine: _line, ...without } = LIMITS
    writeFileSync(eddiesFileIn(tree), JSON.stringify(without))
    hookOn(tree, 's-old', transcriptAt(tree, 's-old', AT_THE_LINE), '1812')
    expect(reachedContextLine(tree, 's-old')).toBe(false)
    expect(realExitReadings({ CONSTRUCT_CARD: '1812' }, tree, tree, path.join(tree, 'bus.db')).contextWarn).toBe(without.contextLimit * without.warnRatio)
  })
})

describe('a card line that cannot be read', () => {
  it('a card line that is not a positive number refuses the tool call and names the key', () => {
    const tree = treeWithLimits()
    writeFileSync(eddiesFileIn(tree), JSON.stringify({ ...LIMITS, cardContextLine: 'soon' }))
    const run = guardRun(tree, 's-bad', transcriptAt(tree, 's-bad', AT_THE_LINE), '1813')
    expect(run.status).toBe(2)
    expect(run.stderr).toContain('config-cardContextLine-invalid')
  })
})

describe('the 150k line of an answer session', () => {
  it('an answer session at 151k hands off and continues in a fresh session with no push', async () => {
    const made = bench()
    const root = treeWithLimits()
    vi.stubEnv('CLAUDE_PROJECT_DIR', root)
    const worktree = path.join(root, 'mc-1820')
    mkdirSync(path.dirname(answerHandoffPath(worktree)), { recursive: true })
    const ts = made.clock.now().toISOString()
    appendEvent(made.db, { ts, type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: 1820, pr: null, head: null, dedupeKey: `${CARD_STARTED}:1820`, payload: { session: 'card-session', worktree, branch: 'feat/card-1820', base: sha('1') }, legacy: false })
    appendEvent(made.db, { ts, type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId: 1820, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:1820`, payload: { reason: 'question.agent', detail: 'a question' }, legacy: false })
    const stop = made.db.prepare(`SELECT max(id) AS id FROM events WHERE type = '${CARD_STOPPED}'`).get() as { id: number }
    queueTask(made.db, ts, { queue: 'answer', cardId: 1820, stop: Number(stop.id) })
    const lease = leaseNext(made.db, ts, 'answer', 'worker:answer:worker-1')!
    const contexts = new Map<string, number>()
    const prompts: string[] = []
    const pushedAfter: string[] = []
    let current = ''
    const answerer = claudeAnswerer(path.join(root, 'answers'), {
      cardText: () => null,
      available: () => true,
      remoteHead: () => pushedAfter.length === 0 ? sha('a') : sha('e'),
      spawn: async (run) => {
        current = run.argv.includes('--resume') ? 'card-session' : 'fresh-session'
        prompts.push(run.argv.at(-1)!)
        contexts.set(current, current === 'card-session' ? AT_THE_LINE : 40_000)
        if (current === 'card-session')
          writeFileSync(answerHandoffPath(worktree), 'the handoff the first session left')
        writeFileSync(run.stdoutPath, `${JSON.stringify({ type: 'result', subtype: 'success', result: 'ended' })}\n`)
        return 0
      },
      newSession: () => 'fresh-session',
      publish: () => pushedAfter.push(current),
      context: session => contexts.get(session) ?? null,
      contextWarn: contextWarnOfEddies,
      diff: () => 'diff --git a/x b/x',
    })
    const trees: CardTreeTools = { home: root, exists: existsSync, branchOf: pr => `feat/card-${pr}`, recreate: () => {}, bringTo: () => {} }
    const executor = new AnswerExecutor({ silentMs: SILENT_MS, db: made.db, answerer, ownerMerges: () => '', clock: made.clock.now, trees, liveSession: () => null, dirty: () => false })

    expect(await executor.answer(lease)).toMatchObject({ kind: 'answered', session: 'fresh-session', resumed: false })

    expect(pushedAfter).toEqual(['fresh-session'])
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain('the handoff the first session left')
  })

  it('the coordinating window keeps contextLimit times warnRatio', () => {
    const root = treeWithLimits()
    const withCard = realExitReadings({ CONSTRUCT_CARD: '1' }, root, root, path.join(root, 'bus.db'))
    const asWindow = realExitReadings({}, root, root, path.join(root, 'bus.db'))
    expect(withCard.contextWarn).toBe(CARD_LINE)
    expect(asWindow.contextWarn).toBe(LIMITS.contextLimit * LIMITS.warnRatio)
  })
})

describe('one number, one line, one denominator', () => {
  it('the board and eddies show the same context number and line', () => {
    const root = treeWithLimits()
    const transcript = transcriptAt(root, 's-1801', AT_THE_LINE)
    hookOn(root, 's-1801', transcript, '1801')
    const [line] = readFileSync(eddiesJournalPath(root), 'utf8').trim().split('\n').map(text => JSON.parse(text) as { event: string, spent: number, limit: number })
    const gauges = sessionGauges(root, root, 's-1801')

    const html = boardOver(root, [cardBeat(gauges)])

    expect(line).toMatchObject({ event: 'context-line', spent: AT_THE_LINE, limit: CARD_LINE })
    expect(gauges.context).toBe(line!.spent)
    expect(readEddiesLimits(eddiesFileIn(root)).cardContextLine).toBe(line!.limit)
    expect(html).toContain('<span class="edd-v">151k/1M</span>')
    expect(html).toContain('card line <b>150k</b>')
    expect(html).toContain('#1801: ctx 151k of 150k, over the limit')
  })

  it('the context denominator is the window of the model and not 250k', () => {
    const root = treeWithLimits()
    const html = boardOver(root, [cardBeat({ context: AT_THE_LINE, model: MODEL })])
    expect(html).toContain('<span class="edd-v">151k/1M</span>')
    expect(html).not.toContain('151k/250k')
    expect(html).toMatch(/<span class="edd-k">ctx<\/span><span class="edd-bar" style="--_fill: 15%; --_warn: 15%"><\/span>/)
  })

  it('a model the file does not name shows no denominator', () => {
    const root = treeWithLimits()
    const html = boardOver(root, [cardBeat({ context: AT_THE_LINE, model: 'claude-unlisted' })])
    expect(html).toContain('<span class="edd-v">151k</span>')
    expect(html).not.toContain('151k/')
  })

  it('the window keeps its line while its denominator is the window of its model', () => {
    const beat = (context: number): { ts: string, type: string, card: null, payload: string } => ({ ts: minutesAgo(2), type: WINDOW_HEARTBEAT, card: null, payload: JSON.stringify({ session: 'w', context, model: MODEL }) })
    const below = boardOver(treeWithLimits(), [beat(AT_THE_LINE)])
    expect(below).toContain('<span class="edd-v">151k/1M</span>')
    expect(below).not.toContain('window: ctx')
    const past = boardOver(treeWithLimits(), [beat(201_000)])
    expect(past).toContain('window: ctx 201k of 250k, past the Eddies line 200k')
  })

  it('a transcript names its model to the gauges only when it carries one', () => {
    const root = treeWithLimits()
    transcriptAt(root, 'named', 1000)
    transcriptAt(root, 'unnamed', 1000, null)
    expect(sessionGauges(root, root, 'named').model).toBe(MODEL)
    expect(sessionGauges(root, root, 'unnamed')).not.toHaveProperty('model')
  })
})
