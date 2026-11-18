import type { ProcessRow } from '../../ports/process-table.js'
import type { RequestOutcome, RequestTools } from '../../window/window-requests.js'
import type { MergeBench } from '../bus/merge-bench.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent } from '../../core/db.js'
import { CARD_ADMITTED, CARD_ANSWERED, CARD_CLOSED, CARD_DROPPED, CARD_RELEASED, CARD_SESSION_ENDED, CARD_STARTED, CARD_STOPPED, CARD_TAKEOVER, MERGE_DONE, PR_OPENED } from '../../core/events.js'
import { InMemoryProcessTable } from '../../ports/process-table.js'
import { cardTransitions } from '../../supervisor/composition.js'
import { STALLED_ACTOR, StalledSessions, UNDRIVEN_AFTER_MS } from '../../supervisor/stalled-sessions.js'
import { RequestContext } from '../../window/requests/context.js'
import { STARTER_ACTOR } from '../../window/window-prs.js'
import { requestFromWindow, requestOf, WindowRequests } from '../../window/window-requests.js'
import { sha } from '../bus/github-fake.js'
import { eventsOf, mergeBench } from '../bus/merge-bench.js'

const PR = 1634
const CARD = PR + 100
const BASE = sha('0')
const PUSHED = sha('b')
const TREE = `/trees/mc-${CARD}`
const MINUTE = 60_000
const TAKEOVER_WAIT_MS = 31 * MINUTE
const WINDOW_CARD = `card: #${CARD} window-cut-card [implement/construct/M/cheap/auto] · depends — · blocks —\nbranch: feat/card-${CARD}\ntouches: scripts/a.ts\ncontinue: stop\nwho: window\n\nThe window cut its tree through tree.cut.\n`
const REASON = 'CI went red on the window PR and no process runs in its tree'

const UNUSED_TOOLS: RequestTools = {
  treeOf: () => TREE,
  exists: () => false,
  cutTree: () => {},
  dryRunOf: () => null,
  addDecision: () => ({ code: 1, lines: [] }),
  causeHolds: () => null,
  closePr: () => ({ kind: 'refused', detail: 'unused' }) as never,
  closeDropped: () => [],
}

interface Room {
  made: MergeBench
  root: string
}

const rooms: Room[] = []

afterEach(() => {
  for (const room of rooms.splice(0)) {
    room.made.close()
    rmSync(room.root, { recursive: true, force: true })
  }
})

function room(): Room {
  const made: Room = { made: mergeBench(), root: mkdtempSync(path.join(tmpdir(), 'tree-cut-session-')) }
  rooms.push(made)
  const { db, clock } = made.made
  appendEvent(db, { ts: clock.now().toISOString(), type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:body:${CARD}`, payload: { card: `#${CARD}`, lane: 'lane-1', text: WINDOW_CARD, textSha: textSha(WINDOW_CARD) }, legacy: false })
  made.made.tick()
  return made
}

function cutByTheBus({ made }: Room): void {
  const ts = made.clock.now().toISOString()
  appendEvent(made.db, { ts, type: CARD_STARTED, actor: `${STARTER_ACTOR}by-hand`, cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD}:feat/card-${CARD}:${ts}`, payload: { path: 'cheap', started: ts, worktree: TREE, base: BASE, tree_origin: 'cut', branch: `feat/card-${CARD}` }, legacy: false })
  made.tick()
}

function launchedByTheBus({ made }: Room): void {
  const ts = made.clock.now().toISOString()
  appendEvent(made.db, { ts, type: CARD_STARTED, actor: 'worker:launch:4242', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:launch:${CARD}:${ts}`, payload: { session: 'shift-session', worktree: TREE, branch: `feat/card-${CARD}`, base: BASE, pid: 4343, pgid: 4343, contour: 'cheap', tree_origin: 'cut', isolation: 'full', isolationGaps: [] }, legacy: false })
  made.tick()
}

function context({ made, root }: Room): RequestContext {
  return new RequestContext(made.db, made.clock.now, UNUSED_TOOLS, path.join(root, 'owner-answers'), () => null, root, made.gitHub.client)
}

function takeover({ made, root }: Room): RequestOutcome {
  requestFromWindow(made.db, made.clock.now().toISOString(), 'window-1', requestOf(['takeover', '--card', String(CARD), '--reason', REASON])!)
  return new WindowRequests(made.db, made.clock.now, UNUSED_TOOLS, path.join(root, 'owner-answers'), () => null, root, made.gitHub.client).run()[0]!
}

function sweep({ made }: Room, trees = new InMemoryProcessTable({})): string[] {
  return new StalledSessions(made.db, made.clock.now, { cards: cardTransitions(), lifeOf: () => 'unknown', trees }).step()
}

function endsOf({ made }: Room): unknown[] {
  return (made.db.prepare(`SELECT actor, head, payload FROM events WHERE card_id = ? AND type = '${CARD_SESSION_ENDED}' ORDER BY id`).all(CARD) as { actor: string, head: string | null, payload: string }[]).map(row => ({ actor: row.actor, head: row.head, ...JSON.parse(row.payload) as object }))
}

function pushed({ made }: Room, head: string): void {
  made.gitHub.open({ number: PR, head, required: 'failure' })
  made.tick()
}

function claudeIn(cwd: string): InMemoryProcessTable {
  return new InMemoryProcessTable({ cwds: { kind: 'listed', cwds: [cwd] } })
}

function running(command: string): InMemoryProcessTable {
  const row: ProcessRow = { pid: 4242, ppid: 1, pgid: 4242, started: 'Tue Nov 17 10:00:00 2026', command }
  return new InMemoryProcessTable({ rows: [row] })
}

const NOT_ENDED = expect.stringContaining('has not ended') as unknown

describe('the session a window tree.cut opens ends when the window pushes', () => {
  it('a push after a window tree.cut ends its session and a takeover is accepted', () => {
    const at = room()
    cutByTheBus(at)
    expect(context(at).routeOf(CARD)).toEqual(expect.stringContaining(`its session started at event`))

    pushed(at, PUSHED)
    at.made.clock.advance(TAKEOVER_WAIT_MS)
    expect(sweep(at, claudeIn('/Users/someone/projects/repo'))).toEqual([expect.stringContaining(`${CARD_SESSION_ENDED} #${CARD}: the session started at event`)])
    expect(endsOf(at)).toEqual([expect.objectContaining({ actor: STALLED_ACTOR, head: PUSHED, stopped: false, detail: expect.stringContaining(`pushed ${PUSHED} to PR #${PR}, over its base ${BASE}`) as unknown })])

    expect(context(at).routeOf(CARD)).toBeNull()
    expect(takeover(at)).toMatchObject({ kind: 'done' })
    expect(eventsOf(at.made.db, CARD_TAKEOVER)).toHaveLength(1)
  })

  it('a pull request seen at the base of the cut is no push and ends nothing', () => {
    const at = room()
    cutByTheBus(at)
    pushed(at, BASE)
    expect(sweep(at, claudeIn(TREE))).toEqual([])
    expect(endsOf(at)).toEqual([])
    expect(context(at).routeOf(CARD)).toEqual(NOT_ENDED)
  })

  it('a release of the card after the cut ends its session', () => {
    const at = room()
    cutByTheBus(at)
    appendEvent(at.made.db, { ts: at.made.clock.now().toISOString(), type: CARD_RELEASED, actor: 'worker:window:window-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_RELEASED}:request-1`, payload: { request: 1, reason: 'the window lets the card go' }, legacy: false })
    at.made.tick()
    expect(sweep(at, claudeIn(TREE))).toEqual([expect.stringContaining('was released at event')])
    expect(context(at).routeOf(CARD)).toBeNull()
  })

  it('a pull request the bus opened past the base of the cut ends its session', () => {
    const at = room()
    cutByTheBus(at)
    appendEvent(at.made.db, { ts: at.made.clock.now().toISOString(), type: PR_OPENED, actor: 'worker:launch:4242', cardId: CARD, pr: PR, head: PUSHED, dedupeKey: `${PR_OPENED}:${PR}`, payload: { pr: PR }, legacy: false })
    at.made.tick()
    expect(sweep(at, claudeIn(TREE))).toEqual([expect.stringContaining(`pushed ${PUSHED} to PR #${PR}`)])
    expect(endsOf(at)).toEqual([expect.objectContaining({ actor: STALLED_ACTOR, head: PUSHED })])
  })

  it('the end is written once', () => {
    const at = room()
    cutByTheBus(at)
    pushed(at, PUSHED)
    expect(sweep(at)).toHaveLength(1)
    expect(sweep(at)).toEqual([])
    expect(endsOf(at)).toHaveLength(1)
  })
})

describe('a session nobody drives is ended by the bus after its round time', () => {
  it('a started session with no live process past its round time is ended by the bus', () => {
    const at = room()
    cutByTheBus(at)
    at.made.clock.advance(UNDRIVEN_AFTER_MS)
    expect(sweep(at, claudeIn('/Users/someone/projects/repo'))).toEqual([expect.stringContaining(`no live process runs in its tree ${TREE}`)])
    expect(endsOf(at)).toEqual([expect.objectContaining({ actor: STALLED_ACTOR, head: null, stopped: false })])
    expect(context(at).routeOf(CARD)).toBeNull()
  })

  it('a live session is not ended', () => {
    const inside = room()
    cutByTheBus(inside)
    expect(sweep(inside)).toEqual([])
    expect(context(inside).routeOf(CARD)).toEqual(NOT_ENDED)

    const lives = [claudeIn(TREE), claudeIn(path.join(TREE, 'scripts')), running(`node vitest run --root ${TREE}`), new InMemoryProcessTable({ cwds: { kind: 'unreadable', why: 'lsof: permission denied' } }), new InMemoryProcessTable({ rows: { unreadable: 'ps: permission denied' } })]
    for (const table of lives) {
      const live = room()
      cutByTheBus(live)
      live.made.clock.advance(UNDRIVEN_AFTER_MS)
      expect(sweep(live, table)).toEqual([])
      expect(endsOf(live)).toEqual([])
      expect(context(live).routeOf(CARD)).toEqual(NOT_ENDED)
    }
  })

  it.each([CARD_STOPPED, CARD_ANSWERED, MERGE_DONE, CARD_CLOSED, CARD_DROPPED])('a start already ended by %s is not ended again past its round time', (type) => {
    const at = room()
    cutByTheBus(at)
    appendEvent(at.made.db, { ts: at.made.clock.now().toISOString(), type, actor: 'worker:test:ends', cardId: CARD, pr: null, head: null, dedupeKey: `${type}:${CARD}:end-of-start`, payload: {}, legacy: false })
    at.made.tick()
    at.made.clock.advance(UNDRIVEN_AFTER_MS)
    expect(sweep(at, claudeIn('/Users/someone/projects/repo'))).toEqual([])
    expect(endsOf(at)).toEqual([])
  })

  it('a start that recorded no tree is not ended past its round time', () => {
    const at = room()
    const ts = at.made.clock.now().toISOString()
    appendEvent(at.made.db, { ts, type: CARD_STARTED, actor: `${STARTER_ACTOR}by-hand`, cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD}:no-tree:${ts}`, payload: { path: 'cheap', started: ts, base: BASE, branch: `feat/card-${CARD}` }, legacy: false })
    at.made.tick()
    at.made.clock.advance(UNDRIVEN_AFTER_MS)
    expect(sweep(at, claudeIn('/Users/someone/projects/repo'))).toEqual([])
    expect(endsOf(at)).toEqual([])
  })

  it('a tree whose name only begins like the card tree is not the card tree', () => {
    const at = room()
    cutByTheBus(at)
    at.made.clock.advance(UNDRIVEN_AFTER_MS)
    expect(sweep(at, claudeIn(`${TREE}0`))).toHaveLength(1)
  })
})

describe('a session the launch node started is ended by its own shift, not by this sweep', () => {
  it('a card\'s own worker session that pushed and runs past its round time with no process in sight is not ended', () => {
    const at = room()
    cutByTheBus(at)
    launchedByTheBus(at)
    pushed(at, PUSHED)
    at.made.clock.advance(UNDRIVEN_AFTER_MS)
    expect(sweep(at, claudeIn('/Users/someone/projects/repo'))).toEqual([])
    expect(endsOf(at)).toEqual([])
    expect(context(at).routeOf(CARD)).toEqual(NOT_ENDED)
  })
})
