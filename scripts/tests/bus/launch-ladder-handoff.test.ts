import type { Card } from '../../../src/card/grammar.js'
import type { CardStart, CardStarter, QueuedCard, StartedCard } from '../../nodes/launch/launch-executor.js'
import type { ProcessTable } from '../../nodes/restart/chain-process.js'
import type { IsolationReader } from '../../ports/isolation.js'
import type { MergeBench } from './merge-bench.js'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { constructHome, repoHome, repoIdOf } from '../../core/bus-path.js'
import { appendEvent } from '../../core/db.js'
import { CARD_ADMITTED, CARD_STARTED, CARD_STOPPED, CARD_WAITING, LADDER_APPROVAL } from '../../core/events.js'
import { HANDOFF_DIR } from '../../core/handoff-dir.js'
import { handoffLadderSteps, LaunchNode, WITHDRAWN_TO_CHEAP } from '../../nodes/launch/launch-worker.js'
import { eventsOf, mergeBench } from './merge-bench.js'

const CARD_ID = 1399
const LANE = 'lane-x'
const CARD: Card = { id: CARD_ID, name: 'a-card', kind: 'implement', milestone: 'construct', size: 'M', contour: 'ladder', decision: 'owner', depends: [], blocks: [], line: `#${CARD_ID} a-card [implement/construct/M/ladder/owner] · depends — · blocks —` }
const sandboxed: IsolationReader = () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] })

const roots: string[] = []
const benches: MergeBench[] = []

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

function scratch(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'launch-ladder-handoff-'))
  roots.push(root)
  return root
}

class LadderStarter implements CardStarter {
  stops: StartedCard[] = []
  constructor(private readonly onStop: () => void = () => {}) {}

  start(card: QueuedCard): CardStart {
    return { kind: 'started', card: { session: `s-${card.cardId}`, worktree: `/trees/mc-${card.cardId}`, branch: `feat/card-${card.cardId}`, base: 'f'.repeat(40), pid: 4242, pgid: 4242, step: 'brief' } }
  }

  stop(card: StartedCard): void {
    this.stops.push(card)
    this.onStop()
  }
}

function admit(made: MergeBench, contour: string, admission: string): void {
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'policy', cardId: CARD_ID, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${admission}`, payload: { lane: LANE, decision: 'owner', contour, depends: [], admission }, legacy: false })
}

async function once(node: LaunchNode): Promise<void> {
  const controller = new AbortController()
  await node.run({ pause: async () => controller.abort(), signal: controller.signal })
}

function queuedLaunches(made: MergeBench): unknown {
  return made.db.prepare(`SELECT count(*) AS n FROM tasks WHERE queue = 'launch' AND card_id = ? AND state = 'queued'`).get(CARD_ID)
}

describe('launch writes the ladder brief through the per-repo handoff resolver', () => {
  it('a repository that is not the owner checkout gets its brief and tasks file under its own repo home, never under ~/.construct/handoff', () => {
    const root = scratch()
    const home = path.join(root, 'home')
    const repo = path.join(root, 'vedeti-memorial')
    mkdirSync(repo, { recursive: true })
    const steps = handoffLadderSteps(repo, {}, path.join(root, 'bus.db'), home)
    const task = { card: CARD, touches: [] } as unknown as Parameters<typeof steps.brief>[0]
    const own = path.join(repoHome(home, repoIdOf(repo)), HANDOFF_DIR)

    expect(path.dirname(steps.brief(task))).toBe(own)
    expect(path.dirname(steps.tasksFile(task))).toBe(own)
    expect(steps.brief(task).startsWith(path.join(constructHome(home), HANDOFF_DIR))).toBe(false)
  })

  it('a named handoff directory still wins over the resolver', () => {
    const root = scratch()
    const named = path.join(root, 'named-handoff')
    const steps = handoffLadderSteps(path.join(root, 'repo'), { CONSTRUCT_HANDOFF_DIR: named }, path.join(root, 'bus.db'), path.join(root, 'home'))
    const task = { card: CARD, touches: [] } as unknown as Parameters<typeof steps.brief>[0]
    expect(path.dirname(steps.brief(task))).toBe(named)
  })
})

describe('moving a ladder card to cheap releases it', () => {
  it('a ladder card that waits for ladder.approval and is moved to cheap is withdrawn and queues again', async () => {
    const made = mergeBench()
    benches.push(made)
    const gone: ProcessTable = { commandLine: () => null, signalGroup: () => {} }
    const ladder = new LadderStarter()
    const node = new LaunchNode({ db: made.db, starter: new LadderStarter(), ladder, clock: made.clock.now, session: 'node-1', mode: 'live', env: {}, processes: gone, resulted: () => true, isolation: sandboxed })
    admit(made, 'ladder', 'first')
    made.tick()
    await once(node)
    expect(eventsOf(made.db, CARD_STARTED)).toMatchObject([{ contour: 'ladder' }])
    made.tick()
    expect(node.stopOverdue()).toEqual([])
    expect(eventsOf(made.db, CARD_WAITING)).toMatchObject([{ reason: LADDER_APPROVAL }])
    expect(queuedLaunches(made)).toEqual({ n: 0 })

    admit(made, 'cheap', 'moved-to-cheap')
    made.tick()
    expect(node.stopOverdue()).toEqual([CARD_ID])
    expect(eventsOf(made.db, CARD_STOPPED)).toMatchObject([{ code: WITHDRAWN_TO_CHEAP }])
    made.tick()
    expect(queuedLaunches(made)).toEqual({ n: 1 })
    expect(node.stopOverdue()).toEqual([])
  })

  it('a running ladder session of a card moved to cheap is stopped, then the card queues again', async () => {
    const made = mergeBench()
    benches.push(made)
    let live = true
    const processes: ProcessTable = { commandLine: () => (live ? `sh -c claude -p --session-id s-${CARD_ID}` : null), signalGroup: () => {} }
    const ladder = new LadderStarter(() => {
      live = false
    })
    const node = new LaunchNode({ db: made.db, starter: new LadderStarter(), ladder, clock: made.clock.now, session: 'node-1', mode: 'live', env: {}, processes, isolation: sandboxed })
    admit(made, 'ladder', 'first')
    made.tick()
    await once(node)
    made.tick()
    expect(node.stopOverdue()).toEqual([])
    expect(ladder.stops).toEqual([])

    admit(made, 'cheap', 'moved-to-cheap')
    made.tick()
    expect(node.stopOverdue()).toEqual([CARD_ID])
    expect(ladder.stops).toHaveLength(1)
    made.tick()
    expect(queuedLaunches(made)).toEqual({ n: 1 })
  })

  it('a ladder card whose latest admission still says ladder is left running', async () => {
    const made = mergeBench()
    benches.push(made)
    const processes: ProcessTable = { commandLine: () => `sh -c claude -p --session-id s-${CARD_ID}`, signalGroup: () => {} }
    const ladder = new LadderStarter()
    const node = new LaunchNode({ db: made.db, starter: new LadderStarter(), ladder, clock: made.clock.now, session: 'node-1', mode: 'live', env: {}, processes, isolation: sandboxed })
    admit(made, 'ladder', 'first')
    made.tick()
    await once(node)
    made.tick()
    expect(node.stopOverdue()).toEqual([])
    expect(ladder.stops).toEqual([])
    expect(eventsOf(made.db, CARD_STOPPED)).toEqual([])
  })
})
