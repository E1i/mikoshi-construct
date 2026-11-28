import type { CardStart, CardStarter, QueuedCard } from '../../nodes/launch/launch-executor.js'
import type { MergeBench } from '../bus/merge-bench.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendEvent } from '../../core/db.js'
import { BOARD_ALARM, CARD_ADMITTED, CARD_STARTED, CARD_STOPPED, CARD_WAITING, TASK_FAILED } from '../../core/events.js'
import { idleLoad, MachineSessions } from '../../core/machine-sessions.js'
import { HOST_FAULT_RETRY_MS } from '../../nodes/launch/host-gate.js'
import { LaunchNode } from '../../nodes/launch/launch-worker.js'
import { DISK_FLOOR_BYTES } from '../../ports/disk.js'
import { syncThroughPort } from '../../ports/git.js'
import { HOST_DEGRADED, hostFaultOf, HostFaultPersists } from '../../ports/host-fault.js'
import { fixedThermal } from '../../ports/host-thermal.js'
import { spawnSession } from '../../ports/session.js'
import { nodeSupply } from '../../supervisor/composition.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { eventsOf, mergeBench } from '../bus/merge-bench.js'
import { claudeClient } from '../client/claude-client.js'

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

function passwdLookupFailed(): Error {
  return Object.assign(new Error('A system error occurred: uv_os_get_passwd returned ENOENT (no such file or directory)'), { code: 'ERR_SYSTEM_ERROR', info: { errno: -2, code: 'ENOENT', message: 'no such file or directory', syscall: 'uv_os_get_passwd' } })
}

const FETCH_FAILED = 'fatal: unable to access \'https://github.com/owner/repo/\': Could not resolve host: github.com\n'

class HostFaultingStarter implements CardStarter {
  readonly started: number[] = []
  constructor(private faultsLeft: number, private readonly fault: () => CardStart) {}

  start(card: QueuedCard): CardStart {
    if (this.faultsLeft > 0) {
      this.faultsLeft -= 1
      return this.fault()
    }
    this.started.push(card.cardId)
    return { kind: 'started', card: { session: `s-${card.cardId}`, worktree: `/trees/mc-${card.cardId}`, branch: `feat/card-${card.cardId}`, base: 'f'.repeat(40), pid: 4242, pgid: 4242 } }
  }

  stop(): void {}
}

function bench(): MergeBench {
  const made = mergeBench()
  benches.push(made)
  return made
}

function admit(made: MergeBench, cardId: number, lane: string): void {
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'policy', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${cardId}`, payload: { lane, decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${cardId}` }, legacy: false })
}

function nodeOf(made: MergeBench, starter: CardStarter): LaunchNode {
  const dir = mkdtempSync(path.join(tmpdir(), 'host-fault-'))
  roots.push(dir)
  return new LaunchNode({ silentMs: SILENT_MS, db: made.db, starter, clock: made.clock.now, session: 'node-1', mode: 'live', env: { CONSTRUCT_BUS_SLOTS_LAUNCH: '2' }, disk: () => ({ bavail: 1, bsize: DISK_FLOOR_BYTES }), isolation: () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] }), machine: new MachineSessions(dir, () => false, 16, made.clock.now, idleLoad(16)), thermal: fixedThermal('nominal'), lanes: () => 4 })
}

async function once(node: LaunchNode): Promise<void> {
  const controller = new AbortController()
  await node.run({ pause: async () => controller.abort(), signal: controller.signal, supply: nodeSupply() })
}

function noCardFault(made: MergeBench): void {
  expect(eventsOf(made.db, CARD_STOPPED)).toEqual([])
  expect(eventsOf(made.db, TASK_FAILED)).toEqual([])
  expect(eventsOf(made.db, CARD_WAITING)).toEqual([])
  expect(eventsOf(made.db, BOARD_ALARM).filter(alarm => alarm.reason !== HOST_DEGRADED)).toEqual([])
}

describe('a host fault is not a card fault', () => {
  it('an injected ENOENT from userInfo or a failed fetch at start is retried and the card is not stopped', async () => {
    const sleeps: number[] = []
    const work = mkdtempSync(path.join(tmpdir(), 'host-fault-spawn-'))
    roots.push(work)
    const spawned = spawnSession(claudeClient, { cwd: work, sessionId: 's-enoent', prompt: 'p', stdoutPath: path.join(work, 'out'), stderrPath: path.join(work, 'err'), env: { PATH: work } })
    await expect(spawned).rejects.toBeInstanceOf(HostFaultPersists)
    await expect(spawned).rejects.toMatchObject({ fault: { source: 'os' }, code: 'ENOENT' })

    let fetches = 0
    const fetch = (): string => {
      fetches += 1
      if (fetches < 3)
        throw Object.assign(new Error('Command failed: git fetch -q origin main'), { stderr: FETCH_FAILED })
      return ''
    }
    expect(syncThroughPort(fetch, '/tree', ['fetch', '-q', 'origin', 'main'], { attempts: 4, firstMs: 10, sleep: ms => sleeps.push(ms) })).toBe('')
    expect(sleeps).toEqual([10, 20])

    const made = bench()
    admit(made, 2340, 'lane-a')
    made.tick()
    const starter = new HostFaultingStarter(1, () => {
      throw passwdLookupFailed()
    })
    const node = nodeOf(made, starter)

    await once(node)
    expect(starter.started).toEqual([])
    noCardFault(made)

    made.clock.advance(HOST_FAULT_RETRY_MS)
    made.tick()
    await once(node)
    expect(starter.started).toEqual([2340])
    expect(eventsOf(made.db, CARD_STARTED)).toHaveLength(1)
    noCardFault(made)
  })

  it('host faults on several cards raise one host degraded alarm and no per-card fault', async () => {
    const made = bench()
    admit(made, 2341, 'lane-a')
    admit(made, 2342, 'lane-b')
    made.tick()
    const starter = new HostFaultingStarter(4, () => ({ kind: 'refused', denial: { kind: 'technical', reason: 'start_failed', detail: `git fetch origin main failed: ${FETCH_FAILED}` } }))
    const node = nodeOf(made, starter)

    await once(node)
    await once(node)
    made.tick()

    const alarms = eventsOf(made.db, BOARD_ALARM)
    expect(alarms).toEqual([{ reason: HOST_DEGRADED, cause: 'network', detail: expect.stringContaining('Could not resolve host: github.com') as unknown }])
    noCardFault(made)
    expect(starter.started).toEqual([])
  })

  it('gitHub 5xx, DNS and OS limits are host faults; a missing file and a refusal are not', () => {
    expect(hostFaultOf(new Error('gh: Server Error (HTTP 599)'))).toMatchObject({ source: 'github', detail: 'gh: Server Error (HTTP 599)' })
    expect(hostFaultOf(new Error('gh: Not Found (HTTP 404)'))).toBeNull()
    expect(hostFaultOf(Object.assign(new Error('spawnSync git EAGAIN'), { code: 'EAGAIN', syscall: 'spawnSync git' }))).toMatchObject({ source: 'os' })
    expect(hostFaultOf(Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' }))).toMatchObject({ source: 'os' })
    expect(hostFaultOf(new Error('gh api: HTTP 502 Bad Gateway'))).toMatchObject({ source: 'github' })
    expect(hostFaultOf(Object.assign(new Error('ENOENT: no such file or directory, open \'/tree/report.md\''), { code: 'ENOENT', syscall: 'open' }))).toBeNull()
    expect(hostFaultOf(Object.assign(new Error('Command failed: git push'), { stderr: 'remote: Permission to owner/repo.git denied to someone.\n' }))).toBeNull()
  })
})
