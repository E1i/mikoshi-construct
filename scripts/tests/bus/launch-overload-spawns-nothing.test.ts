import type { CardStart, CardStarter, QueuedCard, StartedCard } from '../../nodes/launch/launch-executor.js'
import type { SessionContinuer } from '../../nodes/launch/launch-starter.js'
import type { ProcessTable } from '../../nodes/restart/chain-process.js'
import type { HostThermal } from '../../ports/host-thermal.js'
import type { MergeBench } from './merge-bench.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendEvent } from '../../core/db.js'
import { CARD_ADMITTED, CARD_STARTED, CARD_STOPPED } from '../../core/events.js'
import { MachineSessions } from '../../core/machine-sessions.js'
import { LaunchNode } from '../../nodes/launch/launch-worker.js'
import { DISK_FLOOR_BYTES } from '../../ports/disk.js'
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

interface Spawns { sessions: number, continued: number, published: number, gates: number, lanes: number, processTable: number, thermal: number }

class CountingStarter implements CardStarter, SessionContinuer {
  constructor(private readonly spawns: Spawns) {}

  start(card: QueuedCard): CardStart {
    this.spawns.sessions += 1
    return { kind: 'started', card: { session: `s-${card.cardId}`, worktree: `/trees/mc-${card.cardId}`, branch: `feat/card-${card.cardId}`, base: 'f'.repeat(40), pid: 4242, pgid: 4242 } }
  }

  continueFrom(card: QueuedCard, from: StartedCard): CardStart {
    this.spawns.continued += 1
    return { kind: 'started', card: { ...from, session: `s-${card.cardId}-c` } }
  }

  stop(): void {}
}

function admit(made: MergeBench, cardId: number, lane: string): void {
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'policy', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${cardId}`, payload: { lane, decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${cardId}` }, legacy: false })
}

async function once(node: LaunchNode): Promise<void> {
  const controller = new AbortController()
  await node.run({ pause: async () => controller.abort(), signal: controller.signal, supply: nodeSupply() })
}

describe('launch under machine overload', () => {
  it('under a faked overload launch spawns nothing', async () => {
    const made = mergeBench()
    benches.push(made)
    const dir = mkdtempSync(path.join(tmpdir(), 'launch-overload-'))
    roots.push(dir)
    const spawns: Spawns = { sessions: 0, continued: 0, published: 0, gates: 0, lanes: 0, processTable: 0, thermal: 0 }
    let busy = 0
    let alive = true
    const machine = new MachineSessions(dir, () => false, 4, made.clock.now, { read: () => ({ busy, cores: 4 }) })
    const processes: ProcessTable = {
      commandLine: () => {
        spawns.processTable += 1
        return alive ? 'sh -c agent s-2340' : null
      },
      signalGroup: () => {},
    }
    const thermal: HostThermal = { level: () => {
      spawns.thermal += 1
      return 'nominal'
    } }
    const starter = new CountingStarter(spawns)
    const node = new LaunchNode({
      silentMs: SILENT_MS,
      db: made.db,
      starter,
      continuer: starter,
      clock: made.clock.now,
      session: 'node-1',
      mode: 'live',
      env: {},
      processes,
      resulted: () => true,
      committed: () => true,
      handedOff: () => true,
      publish: () => {
        spawns.published += 1
      },
      buildHandoff: () => {
        spawns.gates += 1
      },
      disk: () => ({ bavail: 1, bsize: DISK_FLOOR_BYTES }),
      isolation: () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] }),
      machine,
      thermal,
      lanes: () => {
        spawns.lanes += 1
        return 4
      },
    })
    admit(made, 2340, 'lane-a')
    made.tick()
    await once(node)
    expect(spawns.sessions).toBe(1)
    made.tick()

    busy = 100
    alive = false
    admit(made, 2341, 'lane-b')
    made.tick()
    Object.assign(spawns, { sessions: 0, continued: 0, published: 0, gates: 0, lanes: 0, processTable: 0, thermal: 0 })

    await once(node)
    expect(node.stopOverdue()).toEqual([])
    made.tick()
    await once(node)

    expect(spawns).toEqual({ sessions: 0, continued: 0, published: 0, gates: 0, lanes: 0, processTable: 0, thermal: 0 })
    expect(eventsOf(made.db, CARD_STARTED)).toHaveLength(1)
    expect(eventsOf(made.db, CARD_STOPPED)).toEqual([])

    busy = 0
    made.tick()
    node.stopOverdue()
    expect(spawns.processTable).toBeGreaterThan(0)
  })
})
