import type { CardStart, CardStarter, QueuedCard } from '../../nodes/launch/launch-executor.js'
import type { ProcessTable } from '../../nodes/restart/chain-process.js'
import type { MergeBench } from './merge-bench.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendEvent } from '../../core/db.js'
import { BOARD_ALARM, CARD_ADMITTED, CARD_STOPPED } from '../../core/events.js'
import { idleLoad, MachineSessions } from '../../core/machine-sessions.js'
import { keyOf } from '../../core/queue.js'
import { GIT_DENIED, LaunchNode } from '../../nodes/launch/launch-worker.js'
import { DISK_FLOOR_BYTES } from '../../ports/disk.js'
import { fixedThermal } from '../../ports/host-thermal.js'
import { nodeSupply } from '../../supervisor/composition.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { requestFromWindow, WindowRequests } from '../../window/window-requests.js'
import { eventsOf, mergeBench, taskState } from './merge-bench.js'

const REFUSAL = 'fatal: Unable to create \'/repo/.git/worktrees/mc-2199/index.lock\': Operation not permitted'
const REPORT = `#2199 git-denied\nresult: stopped before the commit: git commit refused\n${REFUSAL}\n`
const RACE_REPORT = `#2199 race\nresult: stopped before the push\nremote: error: cannot lock ref 'refs/heads/feat/card-2199': Unable to create '/srv/repo/refs/heads/feat/card-2199.lock': Permission denied\n`
const HOST_REPORT = `#2199 host\nresult: stopped before the push\nremote: error: [remote rejected] HEAD -> feat/card-2199 (HTTP 503 Service Unavailable)\n`

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

class FakeStarter implements CardStarter {
  start(card: QueuedCard): CardStart {
    return { kind: 'started', card: { session: `s-${card.cardId}`, worktree: `/trees/mc-${card.cardId}`, branch: `feat/card-${card.cardId}`, base: 'f'.repeat(40), pid: 4242, pgid: 4242 } }
  }

  stop(): void {}
}

function machine(made: MergeBench): MachineSessions {
  const dir = mkdtempSync(path.join(tmpdir(), 'launch-git-denied-'))
  roots.push(dir)
  return new MachineSessions(dir, () => false, 16, made.clock.now, idleLoad(16))
}

async function once(node: LaunchNode): Promise<void> {
  const controller = new AbortController()
  await node.run({ pause: async () => controller.abort(), signal: controller.signal, supply: nodeSupply() })
}

async function deniedCard(cardId: number, report: string = REPORT): Promise<{ made: MergeBench, node: LaunchNode }> {
  const made = mergeBench()
  benches.push(made)
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'policy', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${cardId}`, payload: { lane: 'lane-a', decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${cardId}` }, legacy: false })
  made.tick()
  const processes: ProcessTable = { commandLine: () => null, signalGroup: () => {} }
  const node = new LaunchNode({ silentMs: SILENT_MS, db: made.db, starter: new FakeStarter(), clock: made.clock.now, session: 'node-1', mode: 'live', env: {}, processes, resulted: () => true, reportOf: () => report, disk: () => ({ bavail: 1, bsize: DISK_FLOOR_BYTES }), isolation: () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] }), machine: machine(made), thermal: fixedThermal('nominal'), lanes: () => 4 })
  await once(node)
  made.tick()
  return { made, node }
}

function launchRows(made: MergeBench, cardId: number): number {
  return Number((made.db.prepare(`SELECT count(*) AS n FROM tasks WHERE queue = 'launch' AND card_id = ?`).get(cardId) as { n: number }).n)
}

describe('a git refusal is its own stop reason', () => {
  it('a card session whose git commit is refused stops with reason git-denied and the refusal text', async () => {
    const { made, node } = await deniedCard(2199)

    expect(node.stopOverdue()).toEqual([2199])
    expect(node.stopOverdue()).toEqual([])
    expect(eventsOf(made.db, CARD_STOPPED)).toEqual([{ reason: GIT_DENIED, code: GIT_DENIED, blocker: REFUSAL, detail: expect.stringContaining(REFUSAL) as unknown }])
    expect(eventsOf(made.db, BOARD_ALARM)).toEqual([])

    for (const [cardId, report] of [[2201, RACE_REPORT], [2202, HOST_REPORT]] as const) {
      const other = await deniedCard(cardId, report)
      other.node.stopOverdue()
      expect(eventsOf(other.made.db, CARD_STOPPED).filter(stop => stop.reason === GIT_DENIED)).toEqual([])
    }
  })

  it('a card stopped as git-denied is not requeued', async () => {
    const { made, node } = await deniedCard(2200)
    const key = keyOf({ queue: 'launch', cardId: 2200, generation: 'admission-2200' })
    node.stopOverdue()
    made.tick()
    made.tick()

    expect(launchRows(made, 2200)).toBe(1)
    expect(taskState(made.db, key).state).not.toBe('queued')
    const refuse = (): never => {
      throw new Error('a refused requeue uses no tree tool')
    }
    requestFromWindow(made.db, made.clock.now().toISOString(), 'test', { kind: 'requeue', task_key: key })
    expect(new WindowRequests(made.db, made.clock.now, { treeOf: refuse, exists: refuse, cutTree: refuse, dryRunOf: refuse, addDecision: refuse, causeHolds: () => null, closePr: refuse, closeDropped: () => [] }).run()).toMatchObject([{ kind: 'refused' }])
    made.tick()
    expect(launchRows(made, 2200)).toBe(1)
  })
})
