import type { DatabaseSync } from 'node:sqlite'
import type { WaitKind } from '../../core/events.js'
import type { CardWait } from '../../window/board.js'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { cardSection } from '../../contract/factory/card.js'
import { CARDS, copyEvent, IN_ORDER_MARK, OWNER_WAITS, readCurrent } from '../../core/bus-readings.js'
import { appendEvent, openBus, openOwnerWait } from '../../core/db.js'
import { CARD_ADMITTED, CARD_STOPPED, CARD_WAITS, PR_OPENED, WAIT_LIFTERS } from '../../core/events.js'
import { markReduced } from '../../core/watermark.js'
import { cardWaits, readAtLine, readBoard, waitText } from '../../window/board.js'
import { stateLines } from '../../window/handoff-write.js'

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const MINUTE_MS = 60_000
const ADMITTED = '2026-11-12T08:00:00.000Z'
const LATER = '2026-11-12T08:10:00.000Z'
const NOW = new Date('2026-11-12T08:20:00.000Z')
const OWNER_CARD = 905
const STOPPED_CARD_ID = 904

const roots: string[] = []
const dbs: DatabaseSync[] = []

afterEach(() => {
  for (const db of dbs.splice(0))
    db.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function bus(): DatabaseSync {
  const root = mkdtempSync(path.join(tmpdir(), 'card-wait-states-'))
  roots.push(root)
  const db = openBus(path.join(root, 'bus.db'))
  dbs.push(db)
  return db
}

function eventOf(db: DatabaseSync, dedupeKey: string): number {
  return Number((db.prepare('SELECT id FROM events WHERE dedupe_key = ?').get(dedupeKey) as { id: number }).id)
}

function admitted(db: DatabaseSync, card: number, lane: string, columns: { depends?: number[], state?: string | null } = {}): number {
  const key = `${CARD_ADMITTED}:${card}`
  appendEvent(db, { ts: ADMITTED, type: CARD_ADMITTED, actor: 'policy', cardId: card, pr: null, head: null, dedupeKey: key, payload: {}, legacy: false })
  const event = eventOf(db, key)
  db.prepare('INSERT INTO card_bodies (card_id, admission_event_id, text, text_sha, lane, who, priority, depends) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(card, event, `do ${card}`, 'a'.repeat(64), lane, 'shift', null, JSON.stringify(columns.depends ?? []))
  db.prepare('INSERT INTO cards (card_id, state, pr, event_id) VALUES (?, ?, NULL, ?)').run(card, columns.state ?? null, event)
  return event
}

function prOpened(db: DatabaseSync, card: number, pr: number): number {
  const key = `${PR_OPENED}:${pr}`
  appendEvent(db, { ts: LATER, type: PR_OPENED, actor: 'policy', cardId: card, pr, head: null, dedupeKey: key, payload: { pr }, legacy: false })
  const event = eventOf(db, key)
  db.prepare('INSERT INTO prs (pr, card_id, state, event_id) VALUES (?, ?, ?, ?)').run(pr, card, 'open', event)
  db.prepare('UPDATE cards SET state = ? WHERE card_id = ?').run('in_review', card)
  return event
}

function stopped(db: DatabaseSync, card: number): number {
  const key = `${CARD_STOPPED}:${card}`
  appendEvent(db, { ts: LATER, type: CARD_STOPPED, actor: 'policy', cardId: card, pr: null, head: null, dedupeKey: key, payload: { reason: 'question.agent' }, legacy: false })
  return eventOf(db, key)
}

function ownerWaitOn(db: DatabaseSync, card: number): { id: string, event: number } {
  const id = openOwnerWait(db, LATER, 'policy', { need: 'decision', text: 'which way', card })
  const event = eventOf(db, `owner.wait.opened:${id}`)
  db.prepare(`INSERT INTO ${OWNER_WAITS} (id, need, text, command, card_id, pr, state, answer, opened_at, event_id) VALUES (?, ?, ?, NULL, ?, NULL, 'open', NULL, ?, ?)`).run(id, 'decision', 'which way', card, LATER, event)
  return { id, event }
}

interface Standing {
  db: DatabaseSync
  events: Record<WaitKind, number>
  ownerWait: string
}

function standingCards(): Standing {
  const db = bus()
  const launch = admitted(db, 900, 'lane-1')
  const depends = admitted(db, 901, 'lane-2', { depends: [900] })
  admitted(db, 902, 'lane-3', { state: 'in_review' })
  const lane = prOpened(db, 902, 7002)
  admitted(db, 903, 'lane-3')
  admitted(db, STOPPED_CARD_ID, 'lane-4', { state: 'stopped' })
  const stop = stopped(db, STOPPED_CARD_ID)
  admitted(db, OWNER_CARD, 'lane-5')
  const owner = ownerWaitOn(db, OWNER_CARD)
  return { db, events: { launch, depends, lane, stopped: stop, owner: owner.event }, ownerWait: owner.id }
}

function expectedDeadline(since: string, kind: WaitKind): string {
  return new Date(Date.parse(since) + CARD_WAITS[kind].deadlineMinutes * MINUTE_MS).toISOString()
}

function byCard(waits: readonly CardWait[]): Map<number, CardWait> {
  return new Map(waits.map(wait => [wait.card, wait]))
}

describe('card wait states', () => {
  it('every standing card has a wait kind, a lifter and a deadline from the contract', () => {
    const { db, events, ownerWait } = standingCards()
    const reading = cardWaits(db, NOW)
    const waits = byCard(reading.waits)

    expect([...waits.keys()].sort()).toEqual([900, 901, 903, STOPPED_CARD_ID, OWNER_CARD])
    const expected: [number, WaitKind, string, string][] = [
      [900, 'launch', 'startable', ADMITTED],
      [901, 'depends', '#900 not merged', ADMITTED],
      [903, 'lane', 'behind #902 PR #7002', LATER],
      [STOPPED_CARD_ID, 'stopped', 'question.agent', LATER],
      [OWNER_CARD, 'owner', `${ownerWait} decision`, LATER],
    ]
    for (const [card, kind, detail, since] of expected) {
      expect(waits.get(card), `#${card}`).toMatchObject({ kind, detail, since, lifter: CARD_WAITS[kind].lifter, deadline: expectedDeadline(since, kind) })
      expect(WAIT_LIFTERS).toContain(waits.get(card)!.lifter)
    }
    expect(waits.get(903)!.event).toBe(events.lane)
    expect(waits.get(STOPPED_CARD_ID)!.event).toBe(events.stopped)
    expect(waits.get(OWNER_CARD)!.event).toBe(events.owner)

    const contract = JSON.parse(readFileSync(path.join(REPO_ROOT, 'contract/factory.json'), 'utf8')) as { card: { waits: unknown } }
    expect(cardSection(REPO_ROOT).waits).toEqual(CARD_WAITS)
    expect(contract.card.waits).toEqual(JSON.parse(JSON.stringify(CARD_WAITS)))
    expect(Object.values(CARD_WAITS).every(term => term.deadlineMinutes > 0)).toBe(true)
  })

  it('the board and the handoff print the wait the contract record holds and nothing else', () => {
    const { db } = standingCards()
    const records = byCard(cardWaits(db, NOW).waits)
    const board = readBoard({ db, now: NOW, watched: [], leaseOrders: {} })
    const queued = [...board.ready, ...board.waiting, ...board.blocked]

    expect(queued.map(card => Number(card.card)).sort()).toEqual([...records.keys()].sort())
    for (const card of queued) {
      expect(card.wait).toEqual(records.get(Number(card.card)))
      expect(card.reason).toBe(waitText(card.wait))
      expect(card.lane).toBe(card.wait.lane)
    }
    expect(board.ready.map(card => card.wait.kind)).toEqual(['launch'])
    expect(board.waiting.map(card => card.wait.kind).sort()).toEqual(['depends', 'lane'])
    expect(board.blocked.map(card => card.wait.kind).sort()).toEqual(['owner', 'stopped'])

    const blockedLine = stateLines(board).find(line => line.startsWith('blocked:'))!
    const printed = board.blocked.map(card => `#${card.card} ${waitText(card.wait)}`).join('; ')
    expect(blockedLine).toBe(`blocked: ${printed} (${readAtLine(board.waitsAt)})`)
    expect(blockedLine).toContain(`the window lifts it by ${records.get(STOPPED_CARD_ID)!.deadline}`)
    expect(blockedLine).toContain(`the owner lifts it by ${records.get(OWNER_CARD)!.deadline}`)
  })

  it('a reading from a copy names the event it was taken at', () => {
    const { db } = standingCards()
    const last = Number((db.prepare('SELECT max(id) AS id FROM events').get() as { id: number }).id)
    const boardAt = (): number => readBoard({ db, now: NOW, watched: [], leaseOrders: {} }).waitsAt

    expect(readCurrent(db, [CARDS], () => 'rows').stale).toMatchObject({ through: 0 })
    expect(cardWaits(db, NOW).at).toBe(0)
    expect(boardAt()).toBe(0)

    markReduced(db, IN_ORDER_MARK, last)
    expect(copyEvent(db, [CARDS, OWNER_WAITS])).toBe(last)
    expect(cardWaits(db, NOW).at).toBe(last)
    expect(boardAt()).toBe(last)
    const fresh = readCurrent(db, [CARDS], () => 'rows')
    expect(fresh.stale === null ? fresh.at : null).toBe(copyEvent(db, [CARDS]))

    const board = readBoard({ db, now: NOW, watched: [], leaseOrders: {} })
    expect(stateLines(board).find(line => line.startsWith('blocked:'))).toMatch(new RegExp(`\\(${readAtLine(last)}\\)$`))
    for (const card of [...board.ready, ...board.waiting, ...board.blocked])
      expect(card.wait.event, `#${card.card}`).toBeGreaterThan(0)
  })
})
