import type { OwnerMove } from '../../core/owner-commands.js'
import type { QueuedCard, StartedCard } from '../../nodes/launch/launch-executor.js'
import type { ProcessTable } from '../../nodes/restart/chain-process.js'
import type { RequestOutcome } from '../../window/window-requests.js'
import type { MergeBench } from '../bus/merge-bench.js'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { cardHoldOf } from '../../core/card-hold.js'
import { appendEvent } from '../../core/db.js'
import { BOARD_ALARM, CARD_ADMITTED, CARD_HELD, CARD_STARTED, CARD_STOPPED, CARD_TAKEOVER, COMMAND_EXECUTED, TASK_REQUEUED, TASK_SUPERSEDED } from '../../core/events.js'
import { generationOfKey } from '../../core/identifiers.js'
import { OWNER } from '../../core/inbox.js'
import { ownerMoveCommand } from '../../core/owner-commands.js'
import { generationField, TASK_FOLDS } from '../../core/queue.js'
import { reduce } from '../../core/reducer.js'
import { storedByKey } from '../../core/stored.js'
import { LaunchNode } from '../../nodes/launch/launch-worker.js'
import { OWNER_WORD_NOT_FOUND, sayToOwnerChannel, USED_WORD } from '../../owner/channel.js'
import { DISK_FLOOR_BYTES } from '../../ports/disk.js'
import { requestFromWindow, requestOf, TAKEOVER_AFTER_MINUTES, WindowRequests } from '../../window/window-requests.js'
import { mergeBench } from '../bus/merge-bench.js'

const CARD = 1828
const BODYLESS_CARD = 1829
const SESSION_PID = 24039
const SESSION = 's-1828'
const BODY = `card: #${CARD} owner-moves [implement/construct/S/cheap/owner] · depends — · blocks —\n\nThe owner moves it.\n`

interface Room {
  bench: MergeBench
  root: string
  live: Set<number>
  stopped: number[]
}

const rooms: Room[] = []

afterEach(() => {
  for (const made of rooms.splice(0)) {
    made.bench.close()
    rmSync(made.root, { recursive: true, force: true })
  }
})

function room(): Room {
  const made: Room = { bench: mergeBench(), root: mkdtempSync(path.join(tmpdir(), 'owner-moves-')), live: new Set(), stopped: [] }
  rooms.push(made)
  appendEvent(made.bench.db, { ts: now(made), type: CARD_ADMITTED, actor: 'policy', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:owner-moves`, payload: { lane: 'lane-a', decision: 'auto', contour: 'cheap', depends: [], admission: 'owner-moves', text: BODY, textSha: textSha(BODY) }, legacy: false })
  made.bench.tick()
  return made
}

function now(made: Room): string {
  return made.bench.clock.now().toISOString()
}

function channel(made: Room): string {
  return path.join(made.root, 'owner-answers')
}

function requests(made: Room, causes: (string | null)[] = []): WindowRequests {
  const refuse = (): never => {
    throw new Error('the owner moves call no other tool')
  }
  return new WindowRequests(made.bench.db, made.bench.clock.now, { treeOf: refuse, exists: existsSync, cutTree: refuse, dryRunOf: refuse, addDecision: refuse, causeHolds: () => causes.shift() ?? null, closePr: refuse, closeDropped: () => [] }, channel(made), () => null, made.root, made.bench.gitHub.client)
}

function ownerSays(made: Room, move: OwnerMove, target: string | number): string {
  return sayToOwnerChannel(channel(made), ownerMoveCommand(move, target), made.bench.clock.now())
}

function asked(made: Room, argv: string[]): RequestOutcome {
  const request = requestOf(argv)
  expect(request).not.toBeNull()
  requestFromWindow(made.bench.db, now(made), 'window-1', request!)
  const [outcome] = requests(made).run()
  reduce(made.bench.db)
  return outcome!
}

function eventsOf(made: Room, type: string): { actor: string, card_id: number | null, payload: Record<string, unknown> }[] {
  return (made.bench.db.prepare('SELECT actor, card_id, payload FROM events WHERE type = ? ORDER BY id').all(type) as { actor: string, card_id: number | null, payload: string }[]).map(row => ({ ...row, payload: JSON.parse(row.payload) as Record<string, unknown> }))
}

function ownerMoves(made: Room): string[] {
  return eventsOf(made, COMMAND_EXECUTED).filter(event => event.actor === OWNER).map(event => String(event.payload.command))
}

function launchTask(made: Room): { task_key: string, state: string } {
  return made.bench.db.prepare(`SELECT task_key, state FROM tasks WHERE queue = 'launch' AND card_id = ? ORDER BY id DESC LIMIT 1`).get(CARD) as { task_key: string, state: string }
}

function sessionStarted(made: Room): void {
  made.live.add(SESSION_PID)
  appendEvent(made.bench.db, { ts: now(made), type: CARD_STARTED, actor: 'worker:launch:node-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:owner-moves`, payload: { session: SESSION, worktree: `/trees/mc-${CARD}`, branch: `feat/card-${CARD}`, base: 'f'.repeat(40), pid: SESSION_PID, pgid: SESSION_PID, contour: 'cheap' }, legacy: false })
  reduce(made.bench.db)
}

function heldByTheOwner(made: Room): void {
  appendEvent(made.bench.db, { ts: now(made), type: CARD_HELD, actor: OWNER, cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_HELD}:owner-moves`, payload: { request: 1, reason: 'the owner reads it first' }, legacy: false })
  reduce(made.bench.db)
}

function launchNode(made: Room): { node: LaunchNode, started: () => number } {
  let started = 0
  const starter = {
    start: (card: QueuedCard): { kind: 'started', card: StartedCard } => {
      started += 1
      return { kind: 'started', card: { session: `s-${card.cardId}`, worktree: `/trees/mc-${card.cardId}`, branch: `feat/card-${card.cardId}`, base: 'f'.repeat(40), pid: 4242, pgid: 4242, contour: 'cheap' } }
    },
    stop: (card: StartedCard) => {
      made.stopped.push(card.pid)
      made.live.delete(card.pid)
    },
  }
  const table: ProcessTable = { commandLine: pid => made.live.has(pid) ? `claude --session-id ${SESSION}` : null, signalGroup: () => {} }
  const node = new LaunchNode({ db: made.bench.db, starter, clock: made.bench.clock.now, session: 'node-1', mode: 'live', env: {}, processes: table, pidAlive: pid => made.live.has(pid), collected: () => null, disk: () => ({ bavail: 1, bsize: DISK_FLOOR_BYTES }), isolation: () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] }) })
  return { node, started: () => started }
}

async function oneRound(node: LaunchNode): Promise<void> {
  const controller = new AbortController()
  await node.run({ pause: async () => controller.abort(), signal: controller.signal })
}

describe('the owner moves a card', () => {
  it('an owner stop ends the live session of a card and records one bus event', () => {
    const made = room()
    sessionStarted(made)
    ownerSays(made, 'stop', CARD)

    const { node } = launchNode(made)
    expect(node.stopOverdue()).toEqual([])

    const outcome = asked(made, ['owner.stop', '--card', String(CARD)])

    expect(outcome).toMatchObject({ kind: 'done' })
    expect(ownerMoves(made)).toEqual([ownerMoveCommand('stop', CARD)])
    expect(eventsOf(made, COMMAND_EXECUTED)).toEqual([expect.objectContaining({ actor: OWNER, card_id: CARD })])
    expect(node.stopOverdue()).toEqual([CARD])
    expect(made.stopped).toEqual([SESSION_PID])
    expect(eventsOf(made, CARD_STOPPED)).toEqual([expect.objectContaining({ card_id: CARD, payload: expect.objectContaining({ detail: expect.stringContaining(`the owner stopped card #${CARD} session ${SESSION}`) }) })])
  })

  it('an owner launch starts a standing card now without its launch conditions', async () => {
    const held = room()
    heldByTheOwner(held)
    const unmoved = launchNode(held)
    await oneRound(unmoved.node)
    expect(unmoved.started()).toBe(0)

    const made = room()
    heldByTheOwner(made)
    ownerSays(made, 'launch', CARD)
    const outcome = asked(made, ['owner.launch', '--card', `#${CARD}`])
    const moved = launchNode(made)
    await oneRound(moved.node)

    expect(outcome).toMatchObject({ kind: 'done' })
    expect(cardHoldOf(made.bench.db, CARD)).not.toBeNull()
    expect(moved.started()).toBe(1)
    expect(eventsOf(made, CARD_STARTED)).toHaveLength(1)
    expect(ownerMoves(made)).toEqual([ownerMoveCommand('launch', CARD)])
  })

  it('an owner takeover gives the card to the window before 30 minutes', () => {
    const made = room()
    requestFromWindow(made.bench.db, now(made), 'window-1', requestOf(['takeover', '--card', String(CARD), '--reason', 'no route'])!)
    const [byTheWindow] = requests(made).run()
    expect(byTheWindow).toMatchObject({ kind: 'refused', detail: expect.stringContaining('has a bus route') })

    ownerSays(made, 'takeover', CARD)
    const outcome = asked(made, ['owner.takeover', '--card', String(CARD)])

    expect(TAKEOVER_AFTER_MINUTES).toBe(30)
    expect(outcome).toMatchObject({ kind: 'done' })
    expect(eventsOf(made, CARD_TAKEOVER)).toEqual([expect.objectContaining({ actor: OWNER, card_id: CARD })])
    expect(cardHoldOf(made.bench.db, CARD)).toContain('taken over by the window')
    expect(ownerMoves(made)).toEqual([ownerMoveCommand('takeover', CARD)])
  })

  it('an owner requeue queues the card task again with no board alarm', () => {
    const made = room()
    const task = launchTask(made)
    const superseded = { ts: now(made), type: TASK_SUPERSEDED, actor: 'worker:launch:node-1', cardId: CARD, pr: null, head: null, dedupeKey: `${TASK_SUPERSEDED}:${task.task_key}:owner-moves`, payload: { task_key: task.task_key, queue: 'launch', ...generationField(generationOfKey(task.task_key, { queue: 'launch', cardId: CARD })) }, legacy: false }
    appendEvent(made.bench.db, superseded)
    TASK_FOLDS[TASK_SUPERSEDED]!(made.bench.db, storedByKey(made.bench.db, superseded.dedupeKey))
    expect(launchTask(made).state).toBe('superseded')
    expect(asked(made, ['requeue', '--task', task.task_key])).toMatchObject({ kind: 'refused', detail: `no ${BOARD_ALARM} names ${task.task_key}` })

    ownerSays(made, 'requeue', task.task_key)
    const outcome = asked(made, ['owner.requeue', '--task', task.task_key])

    expect(outcome).toMatchObject({ kind: 'done' })
    expect(launchTask(made)).toEqual({ task_key: task.task_key, state: 'queued' })
    expect(eventsOf(made, TASK_REQUEUED)).toHaveLength(1)
    expect(eventsOf(made, BOARD_ALARM)).toEqual([])
    expect(ownerMoves(made)).toEqual([ownerMoveCommand('requeue', task.task_key)])
  })

  it('an owner move is refused only when it is physically impossible and names the cause', () => {
    const made = room()
    const said = [ownerSays(made, 'stop', CARD), ownerSays(made, 'launch', BODYLESS_CARD), ownerSays(made, 'takeover', BODYLESS_CARD), ownerSays(made, 'requeue', 'launch:9999')]

    expect(asked(made, ['owner.stop', '--card', String(CARD)])).toMatchObject({ kind: 'refused', detail: expect.stringContaining(`card #${CARD} has no live session to stop`) })
    expect(asked(made, ['owner.launch', '--card', String(BODYLESS_CARD)])).toMatchObject({ kind: 'refused', detail: expect.stringContaining(`the bus holds no card #${BODYLESS_CARD}; there is nothing to move`) })
    expect(asked(made, ['owner.takeover', '--card', String(BODYLESS_CARD)])).toMatchObject({ kind: 'refused', detail: expect.stringContaining(`the bus holds no card #${BODYLESS_CARD}`) })
    expect(asked(made, ['owner.requeue', '--task', 'launch:9999'])).toMatchObject({ kind: 'refused', detail: expect.stringContaining('launch:9999 is not a task') })
    expect(said.filter(file => !existsSync(file) || existsSync(`${file}${USED_WORD}`))).toEqual([])

    expect(asked(made, ['owner.takeover', '--card', String(CARD)])).toMatchObject({ kind: 'refused', detail: expect.stringContaining(OWNER_WORD_NOT_FOUND) })
    expect(ownerMoves(made)).toEqual([])
    expect(eventsOf(made, CARD_TAKEOVER)).toEqual([])
  })
})
