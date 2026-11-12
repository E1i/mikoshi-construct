import type { QueuedCard, StartedCard } from '../../nodes/launch/launch-executor.js'
import type { ProcessTable } from '../../nodes/restart/chain-process.js'
import type { RequestOutcome } from '../../window/window-requests.js'
import type { MergeBench } from '../bus/merge-bench.js'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { QUEUED_CARD } from '../../core/card-automaton.js'
import { appendEvent } from '../../core/db.js'
import { CARD_ADMITTED, CARD_DEFERRED, CARD_MOVED, CARD_SESSION_ENDED, CARD_STARTED, CARD_STOPPED, REJECTED } from '../../core/events.js'
import { ownerMoveCommand } from '../../core/owner-commands.js'
import { reduce } from '../../core/reducer.js'
import { LaunchNode } from '../../nodes/launch/launch-worker.js'
import { sayToOwnerChannel } from '../../owner/channel.js'
import { DISK_FLOOR_BYTES } from '../../ports/disk.js'
import { busProjections } from '../../supervisor/composition.js'
import { requestFromWindow, requestOf, WindowRequests } from '../../window/window-requests.js'
import { mergeBench } from '../bus/merge-bench.js'

const CARD = 1784
const SESSION = 's-1784'
const SESSION_PID = 31784
const BODY = `card: #${CARD} rejected-start [implement/construct/S/cheap/owner] · depends — · blocks —\n\nA rejected start.\n`

interface Room {
  bench: MergeBench
  root: string
}

const rooms: Room[] = []

afterEach(() => {
  for (const made of rooms.splice(0)) {
    made.bench.close()
    rmSync(made.root, { recursive: true, force: true })
  }
})

function room(): Room {
  const made: Room = { bench: mergeBench(), root: mkdtempSync(path.join(tmpdir(), 'rejected-start-')) }
  rooms.push(made)
  appendEvent(made.bench.db, { ts: now(made), type: CARD_ADMITTED, actor: 'policy', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:rejected-start`, payload: { lane: 'lane-a', decision: 'auto', contour: 'cheap', depends: [], admission: 'rejected-start', text: BODY, textSha: textSha(BODY) }, legacy: false })
  made.bench.tick()
  return made
}

function now(made: Room): string {
  return made.bench.clock.now().toISOString()
}

function channel(made: Room): string {
  return path.join(made.root, 'owner-answers')
}

function asked(made: Room, argv: string[]): RequestOutcome {
  const refuse = (): never => {
    throw new Error('the owner moves call no other tool')
  }
  requestFromWindow(made.bench.db, now(made), 'window-1', requestOf(argv)!)
  const [outcome] = new WindowRequests(made.bench.db, made.bench.clock.now, { treeOf: refuse, exists: existsSync, cutTree: refuse, dryRunOf: refuse, addDecision: refuse, causeHolds: () => null, closePr: refuse, closeDropped: () => [] }, channel(made), () => null, made.root, made.bench.gitHub.client).run()
  reduce(made.bench.db, 'pending', busProjections())
  return outcome!
}

function started(made: Room, key: string): string {
  const dedupeKey = `${CARD_STARTED}:${key}`
  appendEvent(made.bench.db, { ts: now(made), type: CARD_STARTED, actor: 'worker:launch:node-1', cardId: CARD, pr: null, head: null, dedupeKey, payload: { session: SESSION, worktree: `/trees/mc-${CARD}`, branch: `feat/card-${CARD}`, base: 'f'.repeat(40), pid: SESSION_PID, pgid: SESSION_PID, contour: 'cheap' }, legacy: false })
  reduce(made.bench.db, 'pending', busProjections())
  return dedupeKey
}

function rejected(made: Room, dedupeKey: string): boolean {
  return made.bench.db.prepare(`SELECT 1 FROM events AS rejection JOIN events AS start ON start.id = json_extract(rejection.payload, '$.event_id') WHERE rejection.type = ? AND start.dedupe_key = ?`).get(REJECTED, dedupeKey) !== undefined
}

function launchNode(made: Room): LaunchNode {
  const starter = {
    start: (card: QueuedCard): { kind: 'started', card: StartedCard } => ({ kind: 'started', card: { session: `s-${card.cardId}`, worktree: `/trees/mc-${card.cardId}`, branch: `feat/card-${card.cardId}`, base: 'f'.repeat(40), pid: 4242, pgid: 4242, contour: 'cheap' } }),
    stop: () => {},
  }
  const table: ProcessTable = { commandLine: () => null, signalGroup: () => {} }
  return new LaunchNode({ db: made.bench.db, starter, clock: made.bench.clock.now, session: 'node-1', mode: 'live', env: {}, processes: table, pidAlive: () => false, collected: () => null, disk: () => ({ bavail: 1, bsize: DISK_FLOOR_BYTES }), isolation: () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] }) })
}

function sessionEnds(made: Room): string[] {
  return (made.bench.db.prepare(`SELECT payload FROM events WHERE type = ? AND card_id = ? ORDER BY id`).all(CARD_SESSION_ENDED, CARD) as { payload: string }[]).map(row => String((JSON.parse(row.payload) as { detail: unknown }).detail))
}

describe('a start the reducer rejected opens no session', () => {
  it('an owner launch is accepted for a card whose last card.started the reducer rejected', () => {
    const made = room()
    appendEvent(made.bench.db, { ts: now(made), type: CARD_STOPPED, actor: 'worker:launch:node-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:withdrawn`, payload: { reason: 'fault', detail: 'the launch task was withdrawn: card_not_queued' }, legacy: false })
    const start = started(made, 'after-the-withdrawal')
    expect(rejected(made, start)).toBe(true)

    sayToOwnerChannel(channel(made), ownerMoveCommand('launch', CARD), made.bench.clock.now())
    const outcome = asked(made, ['owner.launch', '--card', String(CARD)])

    expect(outcome).toMatchObject({ kind: 'done' })
    expect(outcome.detail).not.toContain('a second session cannot share its tree')
  })

  it('a rejected duplicate start leaves the earlier accepted session open', () => {
    const made = room()
    const accepted = started(made, 'accepted')
    expect(rejected(made, accepted)).toBe(false)
    const duplicate = started(made, 'duplicate')
    expect(rejected(made, duplicate)).toBe(true)
    const acceptedId = (made.bench.db.prepare(`SELECT id FROM events WHERE dedupe_key = ?`).get(accepted) as { id: number }).id

    sayToOwnerChannel(channel(made), ownerMoveCommand('launch', CARD), made.bench.clock.now())
    const launch = asked(made, ['owner.launch', '--card', String(CARD)])
    expect(launch).toMatchObject({ kind: 'refused' })
    expect(launch.detail).toContain(`runs the session started at event ${acceptedId}; a second session cannot share its tree`)

    sayToOwnerChannel(channel(made), ownerMoveCommand('stop', CARD), made.bench.clock.now())
    const stop = asked(made, ['owner.stop', '--card', String(CARD)])
    expect(stop).toMatchObject({ kind: 'done' })
    expect(stop.detail).toContain(`started at event ${acceptedId}`)
  })

  it('an owner stop of a session with no process records its end', () => {
    const made = room()
    started(made, 'accepted')
    appendEvent(made.bench.db, { ts: now(made), type: CARD_DEFERRED, actor: 'policy', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_DEFERRED}:rejected-start`, payload: { from: 'lane-a', to: 'lane-b', lane: 'lane-b', bodySha: textSha(BODY) }, legacy: false })
    reduce(made.bench.db, 'pending', busProjections())

    sayToOwnerChannel(channel(made), ownerMoveCommand('stop', CARD), made.bench.clock.now())
    expect(asked(made, ['owner.stop', '--card', String(CARD)])).toMatchObject({ kind: 'done' })

    expect(launchNode(made).stopOverdue()).toEqual([CARD])
    expect(sessionEnds(made)).toEqual([`card #${CARD} was stopped by the owner while deferred; its session ${SESSION} had no process left, so the bus records its end`])

    sayToOwnerChannel(channel(made), ownerMoveCommand('launch', CARD), made.bench.clock.now())
    expect(asked(made, ['owner.launch', '--card', String(CARD)])).toMatchObject({ kind: 'done' })
  })

  it('a session whose card left running without an owner stop stays open', () => {
    const made = room()
    started(made, 'accepted')
    appendEvent(made.bench.db, { ts: now(made), type: CARD_DEFERRED, actor: 'policy', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_DEFERRED}:left-running`, payload: { from: 'lane-a', to: 'lane-b', lane: 'lane-b', bodySha: textSha(BODY) }, legacy: false })
    appendEvent(made.bench.db, { ts: now(made), type: CARD_MOVED, actor: 'policy', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_MOVED}:left-running`, payload: { from: 'lane-b', to: 'lane-a', lane: 'lane-a', bodySha: textSha(BODY) }, legacy: false })
    reduce(made.bench.db, 'pending', busProjections())
    expect(made.bench.db.prepare(`SELECT state FROM cards WHERE card_id = ?`).get(CARD)).toEqual({ state: QUEUED_CARD })

    expect(launchNode(made).stopOverdue()).toEqual([])
    expect(sessionEnds(made)).toEqual([])

    sayToOwnerChannel(channel(made), ownerMoveCommand('stop', CARD), made.bench.clock.now())
    expect(asked(made, ['owner.stop', '--card', String(CARD)])).toMatchObject({ kind: 'done' })

    expect(launchNode(made).stopOverdue()).toEqual([CARD])
    expect(sessionEnds(made)).toEqual([`card #${CARD} was stopped by the owner while queued; its session ${SESSION} had no process left, so the bus records its end`])
  })
})
