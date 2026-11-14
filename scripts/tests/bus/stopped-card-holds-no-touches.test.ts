import type { DatabaseSync } from 'node:sqlite'
import type { CardStart, CardStarter, QueuedCard } from '../../nodes/launch/launch-executor.js'
import type { MergeBench } from './merge-bench.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { plannedStallLines } from '../../cli/board-warnings.js'
import { openOwnerWaits } from '../../core/bus-readings.js'
import { appendEvent, openBus, openOwnerWait } from '../../core/db.js'
import { CARD_ADMITTED, CARD_STARTED, CARD_STOPPED, OPEN_QUESTION, OWNER_WAIT_OPENED, QUESTION_AGENT } from '../../core/events.js'
import { MachineSessions } from '../../core/machine-sessions.js'
import { queueTask } from '../../core/queue.js'
import { reduce } from '../../core/reducer.js'
import { busCardEvents } from '../../intake/intake.js'
import { launchCandidates } from '../../nodes/launch/launch-candidates.js'
import { LaunchNode } from '../../nodes/launch/launch-worker.js'
import { busProjections, nodeSupply } from '../../supervisor/composition.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { eventsOf, mergeBench } from './merge-bench.js'

const TS = '2026-11-12T08:48:00.000Z'
const MINUTE_MS = 60_000
const LANES = 3
const MACHINE_CORES = 16
const SHARED = 'src/shared.ts'
const CARD = 1853
const WINDOW_QUESTION = 'may the touches widen to the direct importer?'
const DECISION = 'D-441'
const OWNER_QUESTION = 'which allowlist holds the gate?'
const HANDOFF = ['current card: #1853', 'queue: #1853', 'done: x', 'not done: x', 'delegation: none', 'next task: x', 'local decisions: none', 'owner waits: none', 'decisions: none', 'intake tokens: none', 'stop reason: a question', 'continue when: now'].join('\n')
const roots: string[] = []
const benches: MergeBench[] = []

afterEach(() => {
  benches.splice(0).forEach(made => made.close())
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function scratch(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function cardText(id: number, touches: string): string {
  return `card: #${id} card-${id} [implement/netwatch/S/cheap/auto] · depends — · blocks —\nbranch: feat/card-${id}\ntouches: ${touches}\ncontinue: stop\nwho: shift\n\nDo the thing.\n`
}

class Bench {
  readonly root = scratch('stopped-holds-')
  readonly db: DatabaseSync = openBus(path.join(this.root, 'bus.db'))

  admit(id: number): this {
    const text = cardText(id, SHARED)
    busCardEvents(this.db, 's1', () => LANES)({ type: CARD_ADMITTED, cardId: id, ts: TS, dedupeKey: `admit-${id}`, payload: { card: text.split('\n')[0]!.slice('card: '.length), lane: null, depends: [], decision: 'auto', contour: 'cheap', text, textSha: textSha(text) } })
    return this.reduced()
  }

  start(id: number): this {
    appendEvent(this.db, { ts: TS, type: CARD_STARTED, actor: 'policy', cardId: id, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${id}`, payload: {}, legacy: false })
    return this.reduced()
  }

  stopOnAQuestion(id: number): this {
    appendEvent(this.db, { ts: TS, type: CARD_STOPPED, actor: 'worker:launch:node-1', cardId: id, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${id}`, payload: { reason: QUESTION_AGENT, code: OPEN_QUESTION, blocker: OWNER_QUESTION, paths: [] }, legacy: false })
    openOwnerWait(this.db, TS, 'worker:launch:node-1', { need: 'decision', text: `card #${id} asks: ${OWNER_QUESTION}`, card: id })
    queueTask(this.db, TS, { queue: 'launch', cardId: id, generation: `admit-${id}` })
    return this.reduced()
  }

  candidates(): number[] {
    return launchCandidates(this.db, () => false, () => Date.parse(TS), () => {}, [], () => LANES, new MachineSessions(path.join(this.root, 'machine'), () => false, MACHINE_CORES)).map(candidate => candidate.cardId)
  }

  linesAfter(minutes: number): string[] {
    return plannedStallLines(this.db, new Date(Date.parse(TS) + minutes * MINUTE_MS))
  }

  private reduced(): this {
    reduce(this.db, 'pending', busProjections())
    return this
  }
}

class OneStarter implements CardStarter {
  constructor(private readonly worktree: string) {}

  start(card: QueuedCard): CardStart {
    return { kind: 'started', card: { session: `s-${card.cardId}`, worktree: this.worktree, branch: `feat/card-${card.cardId}`, base: 'f'.repeat(40), pid: 4242, pgid: 4242 } }
  }

  stop(): void {}
}

async function stoppedWith(reportLine: string): Promise<MergeBench> {
  const made = mergeBench()
  benches.push(made)
  const report = { text: null as string | null }
  const node = new LaunchNode({ silentMs: SILENT_MS, db: made.db, starter: new OneStarter(scratch('stopped-tree-')), clock: made.clock.now, session: 'node-1', mode: 'live', env: {}, processes: { commandLine: () => null, signalGroup: () => {} }, pidAlive: () => false, collected: () => null, atContextLine: () => true, handedOff: () => report.text !== null, reportOf: () => report.text, machine: new MachineSessions(scratch('stopped-machine-'), () => false, MACHINE_CORES), lanes: () => 4, disk: () => ({ bavail: 1, bsize: 1024 ** 4 }), isolation: () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] }) })
  const text = `card: #${CARD} a-card [implement/construct/M/cheap/auto] · depends — · blocks —\nbranch: feat/card-${CARD}\ntouches: scripts/a.ts\ncontinue: auto\nwho: shift\n\nDo it.\n`
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:admission-1`, payload: { card: `#${CARD}`, lane: 'lane-1', decision: 'auto', contour: 'cheap', depends: [], admission: 'admission-1', text, textSha: textSha(text) }, legacy: false })
  made.tick()
  const controller = new AbortController()
  await node.run({ pause: async () => controller.abort(), signal: controller.signal, supply: nodeSupply() })
  made.tick()
  report.text = `${HANDOFF}\n${reportLine}\n`
  node.stopOverdue()
  made.tick()
  return made
}

describe('a card stopped on a question with no live session', () => {
  it('a card stopped on a question with no session does not hold its touches', () => {
    const bench = new Bench().admit(1).start(1).stopOnAQuestion(1).admit(2)

    expect(bench.candidates()).toContain(2)
    expect(bench.linesAfter(20).join('\n')).not.toContain('session of #1')
  })
})

describe('a question the window settles under a decision in force', () => {
  it('a question the window settles opens as a window wait', async () => {
    const made = await stoppedWith(`window-question: ${WINDOW_QUESTION} · ${DECISION}`)

    expect(eventsOf(made.db, CARD_STOPPED)).toEqual([expect.objectContaining({ reason: QUESTION_AGENT, code: OPEN_QUESTION, window: [{ question: WINDOW_QUESTION, decision: DECISION }] })])
    expect(eventsOf(made.db, OWNER_WAIT_OPENED)).toEqual([expect.objectContaining({ need: 'decision', decision: DECISION })])
    expect(openOwnerWaits(made.db)).toEqual([expect.objectContaining({ card: CARD, lifter: 'window', decision: DECISION })])
  })

  it('a plain question line still opens a wait for the owner', async () => {
    const made = await stoppedWith(`question: ${OWNER_QUESTION}`)

    expect(eventsOf(made.db, OWNER_WAIT_OPENED)).toEqual([expect.objectContaining({ need: 'decision' })])
    expect(openOwnerWaits(made.db)).toEqual([expect.objectContaining({ card: CARD, lifter: 'owner', decision: null })])
  })
})
