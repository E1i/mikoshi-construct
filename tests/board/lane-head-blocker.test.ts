import type { DatabaseSync } from 'node:sqlite'
import type { StartableHold } from '../../scripts/nodes/launch/launch-candidates.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { busJson } from '../../scripts/cli/board-page.js'
import { appendEvent, openBus } from '../../scripts/core/db.js'
import { CARD_ADMITTED, CARD_DROPPED, CARD_STARTED, PR_OBSERVED } from '../../scripts/core/events.js'
import { reduce } from '../../scripts/core/reducer.js'
import { busCardEvents } from '../../scripts/intake/intake.js'
import { currentLane, laneOverlapRecorder, layLanes } from '../../scripts/nodes/launch/lane-assign.js'
import { holdReason, launchCandidates } from '../../scripts/nodes/launch/launch-candidates.js'
import { busProjections } from '../../scripts/supervisor/composition.js'
import { textSha } from '../../src/card/text-sha.js'
import { busReaderAt } from '../../src/commands/board/bus.js'
import { screenLines } from '../../src/commands/board/screens.js'
import { PLAIN_LORE } from '../../src/ui/lore.js'

const TS = '2026-11-17T10:00:00.000Z'
const NOW = new Date(TS)
const LANES = 3
const HEAD = 'a'.repeat(40)
const OPEN_PR = 1500
const SHARED_PATH = 'scripts/a.ts'
const [PR_CARD, PR_HELD, DROPPED, DROP_HELD] = [2101, 2102, 2103, 2104]
const IDLE_MACHINE = { free: () => LANES, held: () => null, waiting: () => [] }
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function cardText(id: number, touches: string, depends: number[]): string {
  const after = depends.length === 0 ? '—' : depends.map(each => `#${each}`).join(', ')
  return `card: #${id} card-${id} [implement/netwatch/S/cheap/auto] · depends ${after} · blocks —\nbranch: feat/card-${id}\ntouches: ${touches}\ncontinue: stop\nwho: shift\n\nDo the thing.\n`
}

class FixtureBus {
  readonly file: string
  readonly db: DatabaseSync
  private seq = 0

  constructor() {
    const root = mkdtempSync(path.join(tmpdir(), 'lane-head-'))
    roots.push(root)
    this.file = path.join(root, 'bus.db')
    this.db = openBus(this.file)
  }

  admit(id: number, touches: string, depends: number[] = []): this {
    const text = cardText(id, touches, depends)
    busCardEvents(this.db, 's1', () => LANES)({ type: CARD_ADMITTED, cardId: id, ts: TS, dedupeKey: `admit-${id}`, payload: { card: text.split('\n')[0]!.slice('card: '.length), lane: null, depends, decision: 'auto', contour: 'cheap', text, textSha: textSha(text) } })
    return this.settle()
  }

  append(type: string, id: number, payload: Record<string, unknown> = {}, pr: number | null = null): this {
    this.seq += 1
    appendEvent(this.db, { ts: TS, type, actor: 'policy', cardId: id, pr, head: null, dedupeKey: `${type}:${id}:${this.seq}`, payload, legacy: false })
    return this.settle()
  }

  openPr(id: number, pr: number): this {
    return this.append(CARD_STARTED, id).append(PR_OBSERVED, id, { card_id: id, base: 'main', head: HEAD, mergeable: 'clean', ci: 'pending', auto_merge: false, draft: false }, pr)
  }

  tick(): this {
    launchCandidates(this.db, () => false, () => NOW.getTime(), laneOverlapRecorder(this.db, TS, 'worker:launch:w1'), [], () => LANES, IDLE_MACHINE)
    reduce(this.db, 'pending', busProjections())
    return this
  }

  private settle(): this {
    reduce(this.db, 'pending', busProjections())
    layLanes(this.db, LANES, TS, 'policy')
    reduce(this.db, 'pending', busProjections())
    return this
  }
}

function heldBus(): FixtureBus {
  return new FixtureBus()
    .admit(PR_CARD, SHARED_PATH)
    .openPr(PR_CARD, OPEN_PR)
    .admit(PR_HELD, SHARED_PATH)
    .admit(DROPPED, 'scripts/c.ts')
    .admit(DROP_HELD, 'scripts/d.ts', [DROPPED])
    .append(CARD_DROPPED, DROPPED)
    .tick()
    .tick()
}

function expectedHeads(bus: FixtureBus): { lane: string, card: number, reason: string }[] {
  const heads: [number, StartableHold][] = [[PR_HELD, { kind: 'open-pr', pr: OPEN_PR, path: SHARED_PATH }], [DROP_HELD, { kind: 'dropped-depends', dropped: DROPPED }]]
  return heads.map(([card, hold]) => ({ lane: currentLane(bus.db, card)!, card, reason: holdReason(hold) }))
}

describe('the board prints no lane head, though the bus still reads what holds each one', () => {
  it('the facts carry the held heads while the text board and the page JSON print none', () => {
    const bus = heldBus()
    const expected = expectedHeads(bus)
    expect(new Set(expected.map(head => head.lane)).size).toBe(2)

    const reading = busReaderAt(bus.file, () => NOW)()
    if (reading.status !== 'read')
      throw new Error(`the bus was not read: ${reading.status}`)
    expect(reading.facts.laneHeads).toEqual(expect.arrayContaining(expected))
    expect(reading.facts.laneHeads).toHaveLength(2)

    const text = screenLines(reading.facts, PLAIN_LORE)
    expect(text.filter(line => line.includes('lane head'))).toEqual([])
    for (const head of expected)
      expect(text.filter(line => line.includes(head.lane))).toEqual([])

    const json = JSON.parse(busJson(bus.db, NOW)) as { laneHeads?: unknown }
    expect(json.laneHeads).toBeUndefined()
  })
})
