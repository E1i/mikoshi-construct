import type { CardStart, CardStarter, QueuedCard } from '../../nodes/launch/launch-executor.js'
import type { ProcessTable } from '../../nodes/restart/chain-process.js'
import type { ThermalLevel } from '../../ports/host-thermal.js'
import type { MergeBench } from './merge-bench.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendEvent } from '../../core/db.js'
import { BOARD_ALARM, CARD_ADMITTED, CARD_STARTED, CARD_STOPPED, TASK_FAILED } from '../../core/events.js'
import { idleLoad, MachineSessions, setMachineLimit } from '../../core/machine-sessions.js'
import { LaunchNode } from '../../nodes/launch/launch-worker.js'
import { DISK_FLOOR_BYTES } from '../../ports/disk.js'
import { HOST_HOT, thermalFree } from '../../ports/host-thermal.js'
import { nodeSupply } from '../../supervisor/composition.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { eventsOf, mergeBench } from './merge-bench.js'

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
  readonly starts: number[] = []

  start(card: QueuedCard): CardStart {
    this.starts.push(card.cardId)
    return { kind: 'started', card: { session: `s-${card.cardId}`, worktree: `/trees/mc-${card.cardId}`, branch: `feat/card-${card.cardId}`, base: 'f'.repeat(40), pid: 4242, pgid: 4242 } }
  }

  stop(): void {}
}

interface Rig { made: MergeBench, node: LaunchNode, starter: FakeStarter, level: { now: ThermalLevel }, published: { count: number } }

function rig(limit: number): Rig {
  const made = mergeBench()
  benches.push(made)
  const dir = mkdtempSync(path.join(tmpdir(), 'launch-thermal-'))
  roots.push(dir)
  setMachineLimit(dir, limit)
  const starter = new FakeStarter()
  const level: { now: ThermalLevel } = { now: 'nominal' }
  const published = { count: 0 }
  const processes: ProcessTable = { commandLine: () => null, signalGroup: () => {} }
  const node = new LaunchNode({
    silentMs: SILENT_MS,
    db: made.db,
    starter,
    clock: made.clock.now,
    session: 'node-1',
    mode: 'live',
    env: { CONSTRUCT_BUS_SLOTS_LAUNCH: '4' },
    processes,
    resulted: () => true,
    committed: () => true,
    publish: () => {
      published.count += 1
    },
    disk: () => ({ bavail: 1, bsize: DISK_FLOOR_BYTES }),
    isolation: () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] }),
    machine: new MachineSessions(dir, () => true, 16, made.clock.now, idleLoad(16)),
    thermal: { level: () => level.now },
    lanes: () => 8,
  })
  return { made, node, starter, level, published }
}

function admit(made: MergeBench, cardId: number, lane: string): void {
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'policy', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${cardId}`, payload: { lane, decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${cardId}` }, legacy: false })
}

async function once(node: LaunchNode): Promise<void> {
  const controller = new AbortController()
  await node.run({ pause: async () => controller.abort(), signal: controller.signal, supply: nodeSupply() })
}

describe('thermal pressure as a launch input', () => {
  it('under moderate thermal pressure launch halves its free slots', async () => {
    expect([thermalFree(4, 'moderate'), thermalFree(3, 'moderate'), thermalFree(1, 'moderate'), thermalFree(4, 'nominal')]).toEqual([2, 1, 0, 4])
    const { made, node, starter, level } = rig(2)
    admit(made, 2401, 'lane-a')
    made.tick()
    await once(node)
    expect(starter.starts).toEqual([2401])

    level.now = 'moderate'
    admit(made, 2402, 'lane-b')
    made.tick()
    await once(node)
    made.tick()
    await once(node)
    expect(starter.starts).toEqual([2401])

    level.now = 'nominal'
    made.tick()
    await once(node)
    expect(starter.starts).toEqual([2401, 2402])
  })

  it('under heavy thermal pressure launch starts no session or gate and the bus raises one host hot alarm', async () => {
    const { made, node, starter, level, published } = rig(8)
    admit(made, 2403, 'lane-a')
    made.tick()
    await once(node)
    expect(starter.starts).toEqual([2403])
    made.tick()

    level.now = 'heavy'
    admit(made, 2404, 'lane-b')
    admit(made, 2405, 'lane-c')
    made.tick()
    await once(node)
    expect(node.stopOverdue()).toEqual([])
    made.tick()
    await once(node)
    expect(node.stopOverdue()).toEqual([])

    expect(starter.starts).toEqual([2403])
    expect(published.count).toBe(0)
    expect(eventsOf(made.db, CARD_STARTED)).toHaveLength(1)
    expect(eventsOf(made.db, CARD_STOPPED)).toEqual([])
    expect(eventsOf(made.db, TASK_FAILED)).toEqual([])
    expect(eventsOf(made.db, BOARD_ALARM)).toEqual([{ reason: HOST_HOT, cause: 'thermal', detail: expect.stringContaining('thermal pressure heavy') as unknown }])

    level.now = 'nominal'
    made.tick()
    await once(node)
    expect(starter.starts).toEqual([2403, 2404, 2405])
  })
})
