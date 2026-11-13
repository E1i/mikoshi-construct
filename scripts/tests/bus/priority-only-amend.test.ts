import type { StarterPorts } from '../../nodes/launch/launch-starter.js'
import type { ProcessTable } from '../../nodes/restart/chain-process.js'
import type { DiskReader } from '../../ports/disk.js'
import type { IsolationReader } from '../../ports/isolation.js'
import type { MergeBench } from './merge-bench.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parkingFileText } from '../../../src/card/parking.js'
import { runAdmit } from '../../../src/commands/intake/admit.js'
import { runAmend } from '../../../src/commands/intake/amend.js'
import { cardBodyText } from '../../core/card-bodies.js'
import { BUS_DB_VARIABLE } from '../../core/db.js'
import { CARD_CONTINUED, CARD_STOPPED, CARD_WAITING } from '../../core/events.js'
import { cardBodyShaOfCard, keyOf, QUEUED, queueTask } from '../../core/queue.js'
import { busIntakePorts } from '../../intake/intake.js'
import { realStarterPorts } from '../../nodes/launch/launch-root.js'
import { ShiftCardStarter } from '../../nodes/launch/launch-starter.js'
import { LaunchNode } from '../../nodes/launch/launch-worker.js'
import { DISK_FLOOR_BYTES } from '../../ports/disk.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { sha } from './github-fake.js'
import { eventsOf, mergeBench, taskState } from './merge-bench.js'

const CARD = 1786
const PR = 1501
const sandboxed: IsolationReader = () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] })
const roomy: DiskReader = () => ({ bavail: 1, bsize: DISK_FLOOR_BYTES })
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

async function once(node: LaunchNode): Promise<void> {
  const controller = new AbortController()
  await node.run({ pause: async () => controller.abort(), signal: controller.signal })
}

function liveSession(made: MergeBench, root: string): { node: LaunchNode, spawned: unknown[], live: Set<string> } {
  const spawned: unknown[] = []
  const live = new Set<string>()
  let sessions = 0
  const real = realStarterPorts(root, {}, 'Shift task {{task}}\n\n', () => 'unused', id => cardBodyText(made.db, id))
  const ports: StarterPorts = {
    ...real,
    cut: () => `/trees/mc-${CARD}`,
    base: () => 'b'.repeat(40),
    spawnDetached: (run) => {
      spawned.push(run)
      return 5150 + spawned.length
    },
    pgidOf: pid => pid,
    kill: () => {},
    uuid: () => {
      sessions += 1
      live.add(`sess-${sessions}`)
      return `sess-${sessions}`
    },
    envOf: () => ({}),
    changedPaths: () => [],
    readReport: () => null,
    cardSessions: () => [],
    readTranscript: () => null,
    treeFile: () => null,
  }
  const starter = new ShiftCardStarter({ launchDir: path.join(root, 'launch'), claude: 'agent', treePr: 'tree-pr' }, ports)
  const processes: ProcessTable = { commandLine: () => live.size === 0 ? null : `sh -c agent ${[...live].at(-1)}`, signalGroup: () => {} }
  const node = new LaunchNode({ silentMs: SILENT_MS, db: made.db, starter, continuer: starter, clock: made.clock.now, session: 'node-1', mode: 'live', env: {}, processes, resulted: () => true, handedOff: () => false, disk: roomy, isolation: sandboxed })
  return { node, spawned, live }
}

describe('law 2: a priority-only edit makes no new card body', () => {
  it('an amend of priority alone over a live session keeps the session running and its answer and merge tasks', async () => {
    const made = mergeBench()
    benches.push(made)
    vi.stubEnv(BUS_DB_VARIABLE, made.busPath)
    const root = mkdtempSync(path.join(tmpdir(), 'bus-priority-amend-'))
    roots.push(root)
    const repo = path.join(root, 'repo')
    mkdirSync(path.join(repo, 'docs'), { recursive: true })
    writeFileSync(path.join(repo, 'docs', 'a.md'), '')
    const parking = path.join(root, 'parking')
    const lane = path.join(parking, 'lane-a')
    mkdirSync(lane, { recursive: true })
    const file = path.join(lane, `${CARD}.md`)
    writeFileSync(file, parkingFileText({ card: `#${CARD} ordered-card [implement/netwatch/S/cheap/auto] · depends — · blocks —`, branch: 'feat/ordered-card', touches: ['docs/a.md'], continue: 'auto', who: 'shift', body: 'Do the ordered text.' }))
    const ports = busIntakePorts(made.db, 's1')
    expect(runAdmit({ file, dir: repo, dryRun: false, autoConfirm: true, parkingRoot: parking, events: ports.cardEvents, cardStates: ports.cardStates, admissions: ports.cardAdmissions }, made.clock.now)).toMatchObject({ status: 'admitted', source: 'admit' })
    made.tick()
    rmSync(file)

    const { node, spawned, live } = liveSession(made, root)
    await once(node)
    made.tick()
    expect(made.db.prepare(`SELECT state FROM cards WHERE card_id = ?`).get(CARD)).toEqual({ state: 'running' })
    expect(spawned).toHaveLength(1)

    const body = cardBodyShaOfCard(made.db, CARD)!
    const ts = made.clock.now().toISOString()
    const answer = { queue: 'answer' as const, cardId: CARD, pr: PR, head: sha('a'), cardBody: body }
    const merge = { queue: 'merge' as const, cardId: CARD, pr: PR, head: sha('a') }
    queueTask(made.db, ts, answer)
    queueTask(made.db, ts, merge)

    made.clock.advance(1000)
    const amended = runAmend({ card: `#${CARD}`, flags: { priority: 'p0' }, dir: repo, dryRun: false, autoConfirm: true, parkingRoot: parking, events: ports.cardEvents, cardStates: ports.cardStates, admissions: ports.cardAdmissions }, made.clock.now)
    expect(amended).toMatchObject({ status: 'admitted', source: 'amend' })
    made.tick()
    expect(cardBodyText(made.db, CARD)).toContain('priority: p0')
    expect(cardBodyShaOfCard(made.db, CARD)).toBe(body)

    expect(node.stopOverdue()).toEqual([])
    expect(node.stopOverdue()).toEqual([])
    expect(eventsOf(made.db, CARD_WAITING)).toEqual([])
    expect(eventsOf(made.db, CARD_STOPPED)).toEqual([])
    expect(eventsOf(made.db, CARD_CONTINUED)).toEqual([])
    expect(spawned).toHaveLength(1)
    expect(live).toEqual(new Set(['sess-1']))
    expect(made.db.prepare(`SELECT state FROM cards WHERE card_id = ?`).get(CARD)).toEqual({ state: 'running' })
    expect(taskState(made.db, keyOf(answer)).state).toBe(QUEUED)
    expect(taskState(made.db, keyOf(merge)).state).toBe(QUEUED)
  })
})
