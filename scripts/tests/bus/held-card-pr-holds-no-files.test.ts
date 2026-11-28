import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_ADMITTED, CARD_HELD, CARD_RELEASED, CARD_STARTED, PR_OBSERVED, SESSION_HEARTBEAT } from '../../core/events.js'
import { MachineSessions } from '../../core/machine-sessions.js'
import { reduce } from '../../core/reducer.js'
import { busCardEvents } from '../../intake/bus-intake.js'
import { layLanes } from '../../nodes/launch/lane-assign.js'
import { holdReason, launchCandidates, startableCards } from '../../nodes/launch/launch-candidates.js'
import { busProjections } from '../../supervisor/composition.js'

const TS = '2026-11-27T22:57:00.000Z'
const NOW_MS = Date.parse(TS)
const LANES = 4
const HEAD = 'e'.repeat(40)
const HELD_CARD = 2142
const HELD_PR = 2014
const SHARED_PATH = 'scripts/nodes/launch/launch-candidates.ts'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function cardText(id: number, touches: readonly string[], priority: string): string {
  return `card: #${id} card-${id} [implement/netwatch/S/cheap/auto] · depends — · blocks —\nbranch: feat/card-${id}\ntouches: ${touches.join(', ')}\ncontinue: stop\nwho: shift\npriority: ${priority}\n\nDo the thing.\n`
}

class Bench {
  readonly root = mkdtempSync(path.join(tmpdir(), 'held-pr-'))
  readonly db: DatabaseSync

  constructor() {
    roots.push(this.root)
    this.db = openBus(path.join(this.root, 'bus.db'))
  }

  admit(id: number, touches: readonly string[], priority: string): this {
    const text = cardText(id, touches, priority)
    busCardEvents(this.db, 's1')({ type: CARD_ADMITTED, cardId: id, ts: TS, dedupeKey: `admit-${id}`, payload: { card: text.split('\n')[0]!.slice('card: '.length), depends: [], decision: 'auto', contour: 'cheap', text, textSha: textSha(text) } })
    layLanes(this.db, LANES, TS, 'worker:launch:s1', id)
    return this.reduced()
  }

  openPr(id: number, pr: number, diff: readonly string[]): this {
    this.append(CARD_STARTED, id, null, `${CARD_STARTED}:${id}`, {})
    return this.append(PR_OBSERVED, id, pr, `${PR_OBSERVED}:${pr}`, { card_id: id, base: 'main', head: HEAD, mergeable: 'clean', ci: 'green', auto_merge: false, draft: false, paths: diff, pathsTruncated: false }, HEAD)
  }

  beat(id: number): this {
    return this.append(SESSION_HEARTBEAT, id, null, `${SESSION_HEARTBEAT}:${id}`, { step: 'answer', session: `s-${id}` })
  }

  hold(id: number): this {
    return this.append(CARD_HELD, id, null, `${CARD_HELD}:${id}`, { request: 1, reason: 'held until #2324' }, null, 'owner')
  }

  release(id: number): this {
    return this.append(CARD_RELEASED, id, null, `${CARD_RELEASED}:${id}`, { request: 2 }, null, 'owner')
  }

  candidates(): number[] {
    return launchCandidates(this.db, () => false, () => NOW_MS, () => {}, [], () => LANES, this.machine()).map(candidate => candidate.cardId).sort()
  }

  reasons(): string[] {
    return startableCards(this.db, () => false, () => NOW_MS, [], () => LANES, this.machine()).map(card => holdReason(card.hold))
  }

  private machine(): MachineSessions {
    return new MachineSessions(path.join(this.root, 'machine'), () => false, 16)
  }

  private append(type: string, cardId: number, pr: number | null, dedupeKey: string, payload: Record<string, unknown>, head: string | null = null, actor = 'policy'): this {
    appendEvent(this.db, { ts: TS, type, actor, cardId, pr, head, dedupeKey, payload, legacy: false })
    return this.reduced()
  }

  private reduced(): this {
    reduce(this.db, 'pending', busProjections())
    return this
  }
}

function withHeldPr(): Bench {
  return new Bench()
    .admit(HELD_CARD, [SHARED_PATH], 'p1')
    .openPr(HELD_CARD, HELD_PR, [SHARED_PATH])
    .hold(HELD_CARD)
    .admit(2310, [SHARED_PATH], 'p1')
    .admit(2365, [SHARED_PATH, 'scripts/other.ts'], 'p2')
}

describe('a held card\'s open pull request holds no files', () => {
  it('a card overlapping only a held card\'s pull request starts, whatever its priority against the held card', () => {
    const bench = withHeldPr()

    expect(bench.reasons().filter(reason => reason.includes(`open PR #${HELD_PR}`))).toEqual([])
    expect(bench.candidates()).toContain(2310)
  })

  it('the pull request holds its files again once the hold is released', () => {
    const bench = withHeldPr().release(HELD_CARD)

    expect(bench.candidates()).toEqual([])
    expect(bench.reasons()).toEqual([`overlap with open PR #${HELD_PR} on ${SHARED_PATH}`, `overlap with open PR #${HELD_PR} on ${SHARED_PATH}`])
  })

  it('a held card with a live session still holds its files', () => {
    const bench = withHeldPr().beat(HELD_CARD)

    expect(bench.candidates()).toEqual([])
  })
})
