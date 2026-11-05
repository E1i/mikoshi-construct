import type { DatabaseSync } from 'node:sqlite'
import type { MergeBench } from './merge-bench.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { cardHoldOf } from '../../core/card-hold.js'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_ADMITTED, CARD_HELD, CARD_RELEASED, MERGE_DONE, POLICY_DENIED, PR_OBSERVED } from '../../core/events.js'
import { reduce } from '../../core/reducer.js'
import { busCardEvents } from '../../intake/intake.js'
import { ownerHoldOf } from '../../nodes/answer/answer-source.js'
import { assignMovedLane } from '../../nodes/launch/lane-assign.js'
import { launchCandidates, startableCards } from '../../nodes/launch/launch-candidates.js'
import { HELD_FOR_OWNER, HOLD_RECHECK_MS } from '../../nodes/merge/merge-executor.js'
import { eventsOf, liveBench } from './merge-bench.js'

const TS = '2026-11-05T10:00:00.000Z'
const LANES = 3
const CARD = 7
const PARENT = 6
const HEAD = 'b'.repeat(40)
const MERGE_PUT = 'repos/{owner}/{repo}/pulls/970/merge'
const HELD_CARD = 1070
const HELD_PR = 970

const roots: string[] = []
const benches: MergeBench[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
  for (const made of benches.splice(0))
    made.close()
})

function busWithCards(): DatabaseSync {
  const root = mkdtempSync(path.join(tmpdir(), 'hold-keeps-'))
  roots.push(root)
  const db = openBus(path.join(root, 'bus.db'))
  admit(db, PARENT, [])
  admit(db, CARD, [PARENT])
  assignMovedLane(db, CARD, 'lane-1', LANES, TS, 'policy')
  return db
}

function admit(db: DatabaseSync, id: number, depends: number[]): void {
  const dependsOn = depends.length === 0 ? '—' : depends.map(parent => `#${parent}`).join(', ')
  const text = `card: #${id} card-${id} [implement/netwatch/S/cheap/auto] · depends ${dependsOn} · blocks —\nbranch: feat/card-${id}\ntouches: src/card-${id}.ts\ncontinue: stop\nwho: shift\n\nDo the thing.\n`
  busCardEvents(db, 's1', () => LANES)({ type: CARD_ADMITTED, cardId: id, ts: TS, dedupeKey: `admit-${id}`, payload: { card: text.split('\n')[0]!.slice('card: '.length), lane: null, depends, decision: 'auto', contour: 'cheap', text, textSha: textSha(text) } })
  reduce(db)
}

function parentMerged(db: DatabaseSync): void {
  const pr = PARENT + 1000
  appendEvent(db, { ts: TS, type: PR_OBSERVED, actor: 'policy', cardId: PARENT, pr, head: HEAD, dedupeKey: `${PR_OBSERVED}:${pr}`, payload: { card_id: PARENT, base: 'main', head: HEAD, mergeable: 'clean', ci: 'green', auto_merge: false, draft: false }, legacy: false })
  appendEvent(db, { ts: TS, type: MERGE_DONE, actor: 'worker:merge:worker-1', cardId: PARENT, pr, head: HEAD, dedupeKey: `${MERGE_DONE}:${pr}`, payload: { commit: 'c'.repeat(40), rule: 'auto', task_key: `merge:${pr}`, lease_gen: 1 }, legacy: false })
  reduce(db)
}

function draftPr(db: DatabaseSync, cardId: number): void {
  const pr = cardId + 2000
  appendEvent(db, { ts: TS, type: PR_OBSERVED, actor: 'policy', cardId, pr, head: HEAD, dedupeKey: `${PR_OBSERVED}:draft-${pr}`, payload: { card_id: cardId, base: 'main', head: HEAD, mergeable: 'clean', ci: 'green', auto_merge: false, draft: true }, legacy: false })
  reduce(db)
}

function holdEvent(db: DatabaseSync, ts: string, type: string, cardId: number, key: string, payload: Record<string, unknown>): void {
  appendEvent(db, { ts, type, actor: 'owner', cardId, pr: null, head: null, dedupeKey: `${type}:${key}`, payload, legacy: false })
  reduce(db)
}

function candidates(db: DatabaseSync): number[] {
  return launchCandidates(db, () => false, () => Date.parse(TS), () => {}, []).map(each => each.cardId)
}

function startable(db: DatabaseSync): number[] {
  return startableCards(db, () => false, () => Date.parse(TS), []).map(each => each.cardId)
}

describe('a hold keeps the launch node', () => {
  it('a held card whose depends merged stays out of the launch candidates until released', () => {
    const db = busWithCards()
    parentMerged(db)
    expect(candidates(db)).toContain(CARD)

    holdEvent(db, TS, CARD_HELD, CARD, 'hold', { request: 1, reason: 'the owner reads it first' })
    expect(candidates(db)).not.toContain(CARD)
    expect(startable(db)).not.toContain(CARD)

    holdEvent(db, TS, CARD_RELEASED, CARD, 'release', { request: 2 })
    expect(candidates(db)).toContain(CARD)
    expect(startable(db)).toContain(CARD)
    db.close()
  })

  it('a takeover keeps a card out of the launch candidates the same way', () => {
    const db = busWithCards()
    parentMerged(db)

    holdEvent(db, TS, CARD_HELD, CARD, 'takeover', { request: 1, reason: 'no route', takeover: true })
    expect(candidates(db)).not.toContain(CARD)
    expect(cardHoldOf(db, CARD)).toBe(`card #${CARD} is taken over by the window: no route`)

    holdEvent(db, TS, CARD_RELEASED, CARD, 'release', { request: 2 })
    expect(candidates(db)).toContain(CARD)
    db.close()
  })

  it('a draft pull request stays the answer node\'s hold and adds none to launch', () => {
    const db = busWithCards()
    draftPr(db, PARENT)

    expect(ownerHoldOf(db, PARENT)).toContain('has the draft pull request')
    expect(cardHoldOf(db, PARENT)).toBeNull()
    db.close()
  })
})

function heldBench(): MergeBench {
  const made = liveBench()
  benches.push(made)
  made.gitHub.open({ number: HELD_PR, review: 'success' })
  made.tick()
  return made
}

describe('a hold keeps the merge node', () => {
  it('the merge node denies the pull request of a held card and merges it after release', () => {
    const made = heldBench()
    holdEvent(made.db, made.clock.now().toISOString(), CARD_HELD, HELD_CARD, 'hold', { request: 1, reason: 'the owner reads it first' })
    made.tick()

    const lease = made.lease()!
    expect(made.merge(lease)).toMatchObject({ kind: 'denied', denial: { reason: HELD_FOR_OWNER, detail: `card #${HELD_CARD} is held for the owner: the owner reads it first` }, next: 'queued' })
    expect(made.gitHub.puts.map(each => each.endpoint)).toEqual([])
    expect(eventsOf(made.db, POLICY_DENIED)).toEqual([expect.objectContaining({ reason: HELD_FOR_OWNER })])
    expect(eventsOf(made.db, MERGE_DONE)).toEqual([])
    expect(made.lease()).toBeNull()

    holdEvent(made.db, made.clock.now().toISOString(), CARD_RELEASED, HELD_CARD, 'release', { request: 2 })
    made.clock.advance(HOLD_RECHECK_MS)
    made.tick()

    expect(made.merge(made.lease()!)).toMatchObject({ kind: 'merged' })
    expect(made.gitHub.puts.map(each => each.endpoint)).toEqual([MERGE_PUT])
  })

  it('a takeover denies the merge the same way', () => {
    const made = heldBench()
    holdEvent(made.db, made.clock.now().toISOString(), CARD_HELD, HELD_CARD, 'takeover', { request: 1, reason: 'no route', takeover: true })
    made.tick()

    expect(made.merge(made.lease()!)).toMatchObject({ kind: 'denied', denial: { reason: HELD_FOR_OWNER, detail: `card #${HELD_CARD} is taken over by the window: no route` } })
    expect(made.gitHub.puts).toEqual([])
  })

  it('a pull request already merged on GitHub is recorded as merged under a hold', () => {
    const made = heldBench()
    const lease = made.lease()!
    holdEvent(made.db, made.clock.now().toISOString(), CARD_HELD, HELD_CARD, 'hold', { request: 1, reason: 'too late' })
    made.gitHub.close(HELD_PR, true)

    expect(made.merge(lease)).toMatchObject({ kind: 'merged' })
    expect(made.gitHub.puts).toEqual([])
  })
})
