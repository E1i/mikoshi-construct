import type { SeedEvent } from '../../../tests/board/bus-fixture.js'
import type { Lease } from '../../core/lease.js'
import type { NodeKind, NodeStep } from '../../core/node.js'
import type { QueuedTask } from '../../core/queue.js'
import type { LawCell, LawCells, LawId, LawNode, LawSite } from '../../nodes/laws.js'
import type { BgResult, DetachedLaunch, RunningProcess } from '../../supervisor/bg.js'
import type { BusWorker } from '../../supervisor/workers.js'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeBus } from '../../../tests/board/bus-fixture.js'
import { printBoard } from '../../cli/board-page.js'
import { NODE_DECLARATIONS } from '../../contract/factory/nodes.js'
import { LAW_GAP_PREFIX, lawGapNumbers, ratchetBreaks, readRatchet } from '../../contract/ratchet.js'
import { openBus } from '../../core/db.js'
import { SESSION_HEARTBEAT, WINDOW_HEARTBEAT } from '../../core/events.js'
import { completeTask, recordWorkerStarted } from '../../core/lease.js'
import { Node } from '../../core/node.js'
import { keyOf, queueTaskWithin } from '../../core/queue.js'
import { gapRows, LAW_CELLS, LAW_NODES, LAW_SITES, lawIds, LAWS, RESTART_KEEPS_SESSION, SESSION_BEAT_BESIDE_STALE_WINDOW, sourceOf } from '../../nodes/laws.js'
import { launchName } from '../../supervisor/bg.js'
import { slotsVariable } from '../../supervisor/scheduler.js'
import { busDrain, BusSupervisor, freeLeasesOf, withoutRetiring } from '../../supervisor/supervisor.js'
import { workerLaunches } from '../../supervisor/workers.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const OWNER_LAWS = ['Z1', 'Z2', 'Z3', 'Z4', 'Z5', 'Z6', 'Z7']

interface Witness {
  law: LawId
  run: (node: LawNode) => Promise<void>
}

type Witnesses = Readonly<Record<string, Witness>>

const OLD_MAIN = 'a'.repeat(40)
const NEW_MAIN = 'b'.repeat(40)
const SHARED_FILE = 'scripts/core/db.ts'
const SESSION_WRAPPER_PID = 599
const SESSION_PID = 600
const CLOSE_PID = 610
const PROMISE_TURNS = 10_000
const MINUTE = 60_000
const BOARD_NOW = new Date('2026-11-09T15:40:00.000Z')
const STALE_WINDOW_BEAT = '2026-11-07T14:39:00.000Z'
const LIVE_HEADER = 'id="bus-live">bus live<'
const SILENT_SESSION_MINUTES = 120
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

class LiveSession extends Node<NodeStep> {
  readonly taken: string[] = []
  private readonly rounds: (() => void)[] = []

  constructor(kind: NodeKind, db: DatabaseSync, clock: () => Date) {
    super(kind, { db, clock, session: 'old', mode: 'live', env: { [slotsVariable(kind)]: '1' }, self: { pid: SESSION_PID, started: clock().toISOString() }, codeSha: () => OLD_MAIN })
  }

  protected candidates(): QueuedTask[] {
    return []
  }

  protected async handle(lease: Lease): Promise<NodeStep> {
    this.taken.push(lease.taskKey)
    await new Promise<void>((resolve) => {
      this.rounds.push(resolve)
    })
    completeTask(this.db, this.clockIso(), lease, [])
    return { kind: 'completed', taskKey: lease.taskKey }
  }

  private clockIso(): string {
    return this.parts.clock().toISOString()
  }

  finish(): void {
    for (const round of this.rounds.splice(0))
      round()
  }
}

async function untilTrue(condition: () => boolean): Promise<void> {
  for (let turns = 0; turns < PROMISE_TURNS && !condition(); turns++)
    await Promise.resolve()
  if (!condition())
    throw new Error('the session never took its lease')
}

async function restartKeepsSession(node: LawNode): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'z1-restart-'))
  roots.push(root)
  const db = openBus(path.join(root, 'bus.db'))
  const date = (): Date => new Date('2026-11-09T18:45:26.000Z')
  const ts = (): string => date().toISOString()
  const launches = workerLaunches(() => [])
  const { close } = launches
  const sessionLaunch = launches[node as BusWorker]
  let alive: RunningProcess[] = [
    { pid: CLOSE_PID, args: `node pnpm.cjs --silent ${launchName(close)}` },
    { pid: SESSION_WRAPPER_PID, args: `node pnpm.cjs --silent ${launchName(sessionLaunch)}` },
    { pid: SESSION_PID, args: `node --import tsx ${sessionLaunch.markers[0]}` },
  ]
  const stopped: number[] = []
  const kind = node as NodeKind
  const session = new LiveSession(kind, db, date)
  recordWorkerStarted(db, ts(), session.actor, { pid: SESSION_PID, started: ts() })
  const task: QueuedTask = { queue: kind, cardId: 1776 }
  let head = OLD_MAIN
  const known: DetachedLaunch[] = [close, sessionLaunch]
  const supervisor = new BusSupervisor({
    known,
    wanted: () => known,
    start: (launch): BgResult => {
      alive = [...alive, { pid: 701, args: `node pnpm.cjs --silent ${launchName(launch)}` }]
      return { stdout: [], stderr: [], exitCode: 0 }
    },
    stop: async (instance, launch) => {
      if (launch === close) {
        queueTaskWithin(db, ts(), task)
        await untilTrue(() => session.taken.length === 1)
      }
      stopped.push(instance.pid)
      alive = alive.filter(each => each.pid !== instance.pid)
    },
    freeLeases: list => freeLeasesOf(db, ts(), list),
    drain: busDrain(db, ts),
    processes: withoutRetiring(() => alive, db),
    mainSince: () => [{ id: 1, sha: NEW_MAIN }],
    code: {
      head: () => head,
      holds: sha => sha === head,
      pull: () => {
        head = NEW_MAIN
      },
      changedSince: sha => sha === head ? [] : [SHARED_FILE],
      runs: () => new Set([SHARED_FILE]),
    },
    journal: () => {},
    now: () => date().getTime(),
  }, 0)
  const controller = new AbortController()
  const running = session.run({ pause: async () => {}, signal: controller.signal })
  try {
    await supervisor.step()
  }
  finally {
    session.finish()
    controller.abort()
    await running.catch(() => {})
  }
  const state = db.prepare('SELECT state FROM tasks WHERE task_key = ?').get(keyOf(task))
  db.close()
  if (stopped.includes(SESSION_PID) || stopped.includes(SESSION_WRAPPER_PID))
    throw new Error(`the restart signalled the live ${node} session (stopped ${stopped.join(', ')})`)
  if ((state as { state?: string } | undefined)?.state !== 'completed')
    throw new Error(`the ${node} session did not finish its round: ${JSON.stringify(state)}`)
}

function boardReadsLive(node: LawNode, sessionBeat: string): boolean {
  const root = mkdtempSync(path.join(tmpdir(), 'z7-session-'))
  roots.push(root)
  const events: SeedEvent[] = [
    { ts: STALE_WINDOW_BEAT, type: WINDOW_HEARTBEAT, card: null, payload: JSON.stringify({ session: 'window' }) },
    { ts: sessionBeat, type: SESSION_HEARTBEAT, card: 45, payload: JSON.stringify({ session: 's-45', step: node }) },
  ]
  const busPath = writeBus(path.join(root, 'bus.db'), { events })
  const db = new DatabaseSync(busPath)
  try {
    db.exec('ALTER TABLE card_bodies ADD COLUMN admission_event_id INTEGER; ALTER TABLE card_bodies ADD COLUMN text_sha TEXT NOT NULL DEFAULT \'\'')
  }
  finally {
    db.close()
  }
  let html = ''
  vi.stubEnv('BUS_RERUN', '')
  try {
    printBoard(busPath, BOARD_NOW, (text) => {
      html += text
    }, path.join(root, 'miko.md'), 'html')
  }
  finally {
    vi.unstubAllEnvs()
  }
  return html.includes(LIVE_HEADER)
}

async function sessionBeatBesideStaleWindow(node: LawNode): Promise<void> {
  const ago = (minutes: number): string => new Date(BOARD_NOW.getTime() - minutes * MINUTE).toISOString()
  if (!boardReadsLive(node, ago(1)))
    throw new Error(`a ${node} session beating a minute ago beside a stale window beat reads the factory down`)
  if (boardReadsLive(node, ago(SILENT_SESSION_MINUTES)))
    throw new Error(`a ${node} session silent for ${SILENT_SESSION_MINUTES} minutes beside a stale window beat reads the factory live`)
}

const WITNESSES: Witnesses = {
  [RESTART_KEEPS_SESSION]: { law: 'Z1', run: restartKeepsSession },
  [SESSION_BEAT_BESIDE_STALE_WINDOW]: { law: 'Z7', run: sessionBeatBesideStaleWindow },
}

function cellKinds(cell: LawCell): string[] {
  return ['witness', 'notApplicable', 'gap'].filter(kind => kind in cell)
}

function cellFaults(law: LawId, node: LawNode, cell: LawCell | undefined, witnesses: Witnesses): string[] {
  if (cell === undefined)
    return [`${law} × ${node}: no cell`]
  if (cellKinds(cell).length !== 1)
    return [`${law} × ${node}: a cell is exactly one of witness, notApplicable or gap`]
  if ('witness' in cell)
    return witnesses[cell.witness]?.law === law ? [] : [`${law} × ${node}: witness ${cell.witness} is not a witness of ${law} the suite runs`]
  if ('notApplicable' in cell)
    return cell.notApplicable.trim() === '' ? [`${law} × ${node}: not applicable without its reason`] : []
  return cell.gap.length === 0 || cell.gap.some(card => !Number.isInteger(card) || card <= 0) ? [`${law} × ${node}: a gap names the card that closes it`] : []
}

function registryFaults(cells: LawCells, witnesses: Witnesses): string[] {
  const unknownLaws = Object.keys(cells).filter(law => !Object.hasOwn(LAWS, law)).map(law => `${law}: a law the registry does not declare`)
  return [...unknownLaws, ...lawIds().flatMap((law) => {
    const row = cells[law] as Partial<Record<LawNode, LawCell>> | undefined
    if (row === undefined)
      return [`${law}: no row`]
    const strangers = Object.keys(row).filter(node => !(LAW_SITES as readonly string[]).includes(node)).map(node => `${law} × ${node}: not a law site`)
    return [...strangers, ...LAW_NODES.flatMap(node => cellFaults(law, node, row[node], witnesses))]
  })]
}

function failureOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function lawOutcome(law: LawId, node: LawNode, witnesses: Witnesses): Promise<string | null> {
  const ofTheLaw = Object.entries(witnesses).filter(([, witness]) => witness.law === law)
  if (ofTheLaw.length === 0)
    return `no witness of ${law} runs on ${node}`
  const failures: string[] = []
  for (const [id, witness] of ofTheLaw) {
    try {
      await witness.run(node)
      return null
    }
    catch (error) {
      failures.push(`${id}: ${failureOf(error)}`)
    }
  }
  return failures.join('; ')
}

function gapTitle(law: LawId, node: LawNode, cards: readonly number[]): string {
  return `gap: ${law} × ${node} → ${cards.map(card => `#${card}`).join(', ')}`
}

function siteWithoutSource(site: LawSite): boolean {
  return !existsSync(path.join(REPO_ROOT, sourceOf(site)))
}

function recordedLawGaps(): Record<string, number> {
  return Object.fromEntries(Object.entries(readRatchet(REPO_ROOT)).filter(([key]) => key.startsWith(LAW_GAP_PREFIX)))
}

describe('the laws of a node', () => {
  it('every law has a cell for each of the 8 nodes and every witness cell names a witness', () => {
    expect(lawIds()).toEqual(OWNER_LAWS)
    expect(LAW_SITES.filter(siteWithoutSource)).toEqual([])
    expect(NODE_DECLARATIONS.map(({ kind }) => kind).filter(kind => !(LAW_NODES as readonly string[]).includes(kind))).toEqual([])
    expect(LAW_NODES).toHaveLength(8)
    expect(registryFaults(LAW_CELLS, WITNESSES)).toEqual([])

    const unwitnessed = { ...LAW_CELLS, Z2: { ...LAW_CELLS.Z2, merge: { witness: 'Z2-unwritten' } } }
    const missing = { ...LAW_CELLS, Z5: Object.fromEntries(Object.entries(LAW_CELLS.Z5).filter(([node]) => node !== 'review')) } as unknown as LawCells
    const unreasoned = { ...LAW_CELLS, Z1: { ...LAW_CELLS.Z1, close: { notApplicable: ' ' } } }
    const cardless = { ...LAW_CELLS, Z6: { ...LAW_CELLS.Z6, update: { gap: [] } } }

    expect(registryFaults(unwitnessed, WITNESSES)).toEqual([expect.stringContaining('Z2 × merge: witness Z2-unwritten')])
    expect(registryFaults(missing, WITNESSES)).toEqual(['Z5 × review: no cell'])
    expect(registryFaults(unreasoned, WITNESSES)).toEqual(['Z1 × close: not applicable without its reason'])
    expect(registryFaults(cardless, WITNESSES)).toEqual(['Z6 × update: a gap names the card that closes it'])
  })

  it('a gap cell that passes is red until its row is struck', async () => {
    const passing: Witnesses = { 'Z5-seeded': { law: 'Z5', run: async () => {} } }
    const failing: Witnesses = { 'Z5-seeded': { law: 'Z5', run: async () => Promise.reject(new Error('launch wrote no event')) } }

    expect(await lawOutcome('Z5', 'launch', passing)).toBeNull()
    expect(await lawOutcome('Z5', 'launch', failing)).toBe('Z5-seeded: launch wrote no event')
    expect(await lawOutcome('Z5', 'launch', {})).toBe('no witness of Z5 runs on launch')
    expect(registryFaults({ ...LAW_CELLS, Z5: { ...LAW_CELLS.Z5, launch: { witness: 'Z5-seeded' } } }, { ...WITNESSES, ...passing })).toEqual([])
  })

  it('a new gap row is a ratchet break', () => {
    const recorded = recordedLawGaps()
    const added = { ...LAW_CELLS, Z1: { ...LAW_CELLS.Z1, close: { gap: [1777] } } }
    const struck = { ...LAW_CELLS, Z2: { ...LAW_CELLS.Z2, answer: { witness: 'Z2-answer' } } }

    expect(recorded).toEqual(lawGapNumbers())
    expect(Object.keys(recorded)).toHaveLength(gapRows().length)
    expect(ratchetBreaks(recorded, lawGapNumbers())).toEqual([])
    expect(ratchetBreaks(recorded, lawGapNumbers(added))).toEqual([expect.stringContaining(`${LAW_GAP_PREFIX}Z1:close grew from 0 to 1`)])
    expect(ratchetBreaks(recorded, lawGapNumbers(struck))).toEqual([expect.stringContaining(`${LAW_GAP_PREFIX}Z2:answer went down from 1 to 0`)])
  })

  describe('each law over each node', () => {
    for (const law of lawIds()) {
      for (const node of LAW_NODES) {
        const cell = LAW_CELLS[law][node]
        if ('witness' in cell) {
          it(`${law} × ${node}`, async () => {
            const witness = WITNESSES[cell.witness]

            expect(witness?.law, `${cell.witness} is not a witness of ${law}`).toBe(law)
            await witness!.run(node)
          })
        }
        if ('gap' in cell) {
          it(gapTitle(law, node, cell.gap), async () => {
            expect(await lawOutcome(law, node, WITNESSES), `${law} × ${node} passes: strike its gap row in scripts/nodes/laws.ts and lower contract/ratchet.json in this pull request`).not.toBeNull()
          })
        }
      }
    }
  })
})
