import type { CardStart, QueuedCard } from '../../nodes/launch/launch-executor.js'
import type { ProcessTable } from '../../nodes/restart/chain-process.js'
import type { ProcessTable as ProcessTablePort } from '../../ports/process-table.js'
import type { MergeBench } from '../bus/merge-bench.js'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendEvent } from '../../core/db.js'
import { CARD_ADMITTED, CARD_STOPPED } from '../../core/events.js'
import { LaunchNode } from '../../nodes/launch/launch-worker.js'
import { DISK_FLOOR_BYTES } from '../../ports/disk.js'
import { recordedPid, recordedPidLives, sessionLifeIn } from '../../supervisor/recorded-worker.js'
import { eventsOf, mergeBench } from '../bus/merge-bench.js'

const RECORDED_PID = 4242
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

class OneSessionStarter {
  start(card: QueuedCard): CardStart {
    return { kind: 'started', card: { session: `s-${card.cardId}`, worktree: `/trees/mc-${card.cardId}`, branch: `feat/card-${card.cardId}`, base: 'f'.repeat(40), pid: RECORDED_PID, pgid: RECORDED_PID } }
  }

  stop(): void {}
}

async function launchedWith(cardId: number, pidAlive: (pid: number) => boolean): Promise<{ made: MergeBench, node: LaunchNode }> {
  const made = mergeBench()
  benches.push(made)
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'policy', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${cardId}`, payload: { lane: 'lane-a', decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${cardId}` }, legacy: false })
  made.tick()
  const groupStillListed: ProcessTable = { commandLine: pid => pid === RECORDED_PID ? `agent session s-${cardId}` : null, signalGroup: () => {} }
  const node = new LaunchNode({
    db: made.db,
    starter: new OneSessionStarter(),
    clock: made.clock.now,
    session: 'node-1',
    mode: 'live',
    env: {},
    processes: groupStillListed,
    pidAlive,
    resulted: () => false,
    handedOff: () => false,
    warned: () => false,
    committed: () => true,
    disk: () => ({ bavail: 1, bsize: DISK_FLOOR_BYTES }),
    isolation: () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] }),
  })
  const controller = new AbortController()
  await node.run({ pause: async () => controller.abort(), signal: controller.signal })
  made.tick()
  return { made, node }
}

function tableOf(commands: string[]): ProcessTablePort {
  return {
    snapshot: () => ({ readable: true, rows: commands.map((command, index) => ({ pid: 100 + index, ppid: 1, pgid: 100 + index, started: 'Mon Nov  9 08:00:00 2026', command })) }),
    clientCwds: () => ({ readable: false, reason: 'not read' }) as never,
    cpuSample: () => '',
  }
}

describe('the recorded worker pid', () => {
  it('launch reads a card session as ended when its recorded worker pid is no longer alive', async () => {
    const { made, node } = await launchedWith(1901, () => false)

    expect(node.stopOverdue()).toEqual([1901])

    expect(eventsOf(made.db, CARD_STOPPED)).toMatchObject([{ detail: expect.stringContaining('session s-1901 ended with no pull request') }])
  })

  it('launch keeps a card session running while its recorded worker pid is alive', async () => {
    const { made, node } = await launchedWith(1902, pid => pid === RECORDED_PID)

    expect(node.stopOverdue()).toEqual([])

    expect(eventsOf(made.db, CARD_STOPPED)).toEqual([])
  })

  it('a pid that is not a positive integer never reads as alive', () => {
    expect(recordedPidLives(0, () => true)).toBe(false)
    expect(recordedPidLives(-3, () => true)).toBe(false)
    expect(recordedPidLives(1.5, () => true)).toBe(false)
    expect(recordedPidLives(77, () => true)).toBe(true)
  })

  it('a pid file is read as its pid, and a missing or garbled one as none', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'recorded-worker-'))
    roots.push(root)
    const file = path.join(root, 'bus-review.pid')

    expect(recordedPid(file)).toBeNull()
    writeFileSync(file, 'garbled\n')
    expect(recordedPid(file)).toBeNull()
    writeFileSync(file, '31337\n')
    expect(recordedPid(file)).toBe(31337)
  })

  it('a session lives while a process names it, and the bus cannot tell when the table is unreadable', () => {
    const table = tableOf(['agent session abc', 'node other'])

    expect(sessionLifeIn(table)('abc')).toBe('live')
    expect(sessionLifeIn(table)('xyz')).toBe('dead')
    expect(sessionLifeIn({ ...table, snapshot: () => ({ readable: false, reason: 'ps refused' }) })('abc')).toBe('unknown')
  })
})
