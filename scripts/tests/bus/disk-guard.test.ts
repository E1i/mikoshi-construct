import type { DiskReader } from '../../bus/disk.js'
import type { CardStart, CardStarter, QueuedCard } from '../../bus/launch-executor.js'
import type { IsolationReader } from '../../ports/isolation.js'
import type { Shell } from '../../ports/worktree.js'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { appendEvent } from '../../bus/db.js'
import { DISK_FLOOR_BYTES, DISK_LOW, diskLowDetail, freeBytes } from '../../bus/disk.js'
import { taskKey } from '../../bus/identifiers.js'
import { ownerInbox } from '../../bus/inbox.js'
import { LaunchExecutor } from '../../bus/launch-executor.js'
import { leaseNext } from '../../bus/lease.js'
import { FAILURES_TO_STOP } from '../../bus/queue.js'
import { BOARD_ALARM, CARD_ADMITTED, CARD_STOPPED, POLICY_DENIED } from '../../core/events.js'
import { PreflightRefusal, runPreflight } from '../../ghosts/preflight.js'
import { eventsOf, mergeBench, taskState } from './merge-bench.js'

const sandboxed: IsolationReader = () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] })

const BSIZE = 4096
const CARD = 951

function df(bytes: number): DiskReader {
  return () => ({ bavail: Math.floor(bytes / BSIZE), bsize: BSIZE })
}

const LOW = df(DISK_FLOOR_BYTES - 1024 ** 3)
const ENOUGH = df(DISK_FLOOR_BYTES + 1024 ** 3)

class RecordingStarter implements CardStarter {
  starts: QueuedCard[] = []
  start(card: QueuedCard): CardStart {
    this.starts.push(card)
    return { kind: 'started', card: { session: 's', worktree: `/trees/mc-${card.cardId}`, branch: `feat/card-${card.cardId}`, base: 'f'.repeat(40), pid: 4242, pgid: 4242 } }
  }

  stop(): void {}
}

function launchOnce(disk: DiskReader, rounds = 1) {
  const bench = mergeBench()
  try {
    const starter = new RecordingStarter()
    const executor = new LaunchExecutor({ db: bench.db, starter, clock: bench.clock.now, disk, isolation: sandboxed })
    appendEvent(bench.db, { ts: bench.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'policy', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${CARD}`, payload: { lane: 'lane-a', decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${CARD}` }, legacy: false })
    bench.tick()
    const outcomes = Array.from({ length: rounds }, () => executor.launch(leaseNext(bench.db, bench.clock.now().toISOString(), 'launch', 'worker:launch:w')!))
    return {
      outcomes,
      starts: starter.starts,
      task: taskState(bench.db, taskKey({ queue: 'launch', cardId: CARD, generation: `admission-${CARD}` })),
      denials: eventsOf(bench.db, POLICY_DENIED),
      stopped: eventsOf(bench.db, CARD_STOPPED),
      alarms: eventsOf(bench.db, BOARD_ALARM),
      inbox: ownerInbox(bench.db),
    }
  }
  finally {
    bench.close()
  }
}

describe('the disk floor', () => {
  it('free space is statfs bavail times bsize, and only under 20 GiB does it read low', () => {
    expect(DISK_FLOOR_BYTES).toBe(20 * 1024 ** 3)
    expect(freeBytes(() => ({ bavail: 10, bsize: 512 }))).toBe(5120)
    expect(diskLowDetail(LOW)).toMatch(/19\.0 GiB free, under the floor of 20\.0 GiB/)
    expect(diskLowDetail(df(DISK_FLOOR_BYTES))).toBeNull()
  })
})

describe('the launch executor under the disk floor', () => {
  it('a substituted df below 20 GiB releases the task with policy.denied(technical, disk_low), starts nothing and sends nothing to the inbox', () => {
    const run = launchOnce(LOW)

    expect(run.outcomes).toMatchObject([{ kind: 'denied', denial: { kind: 'technical', reason: DISK_LOW }, next: 'queued' }])
    expect(run.starts).toEqual([])
    expect(run.task).toEqual({ state: 'queued', lease_gen: 1, failures: 0 })
    expect(run.denials).toMatchObject([{ command: 'launch', kind: 'technical', reason: DISK_LOW }])
    expect(run.inbox).toEqual([])
  })

  it('a disk that stays low counts no failure, so the card is never stopped and no alarm is raised', () => {
    const run = launchOnce(LOW, FAILURES_TO_STOP + 1)

    expect(run.starts).toEqual([])
    expect(run.task).toMatchObject({ state: 'queued', failures: 0 })
    expect(run.stopped).toEqual([])
    expect(run.alarms).toEqual([])
    expect(run.inbox).toEqual([])
  })

  it('a df above the floor starts the card', () => {
    const run = launchOnce(ENOUGH)

    expect(run.outcomes).toMatchObject([{ kind: 'started' }])
    expect(run.starts).toEqual([{ cardId: CARD, lane: 'lane-a' }])
    expect(run.denials).toEqual([])
  })
})

describe('preflight under the disk floor', () => {
  it('refuses at P0 with disk_low before any worktree is created or any command runs', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'disk-guard-preflight-'))
    try {
      const repo = path.join(root, 'repo')
      execFileSync('git', ['init', '-q', repo])
      const commands: string[] = []
      const shell: Shell = (command) => {
        commands.push(command)
        return { status: 0, output: '' }
      }
      const input = { briefPath: path.join(root, 'brief.md'), text: '', sketch: { kind: 'none', reason: 'none' } as const, buildStdout: '{}', base: 'f'.repeat(40) }
      let refusal: unknown
      try {
        runPreflight(input, { repo, shell, log: () => {}, clock: () => 0, disk: LOW })
      }
      catch (error) {
        refusal = error
      }

      expect(refusal).toBeInstanceOf(PreflightRefusal)
      expect(refusal).toMatchObject({ step: 'P0', message: expect.stringContaining(DISK_LOW) })
      expect(commands).toEqual([])
      expect(execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' }).split('\n').filter(line => line.startsWith('worktree '))).toHaveLength(1)
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
