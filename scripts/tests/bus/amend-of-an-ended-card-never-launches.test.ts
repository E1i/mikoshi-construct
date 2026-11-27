import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_ADMITTED, CARD_CLOSED, CARD_DROPPED, CARD_STARTED, CARD_STOPPED } from '../../core/events.js'
import { MachineSessions } from '../../core/machine-sessions.js'
import { reduce } from '../../core/reducer.js'
import { busCardEvents } from '../../intake/bus-intake.js'
import { launchableCard, launchCandidates } from '../../nodes/launch/launch-candidates.js'
import { busProjections } from '../../supervisor/composition.js'

const TS = '2026-11-20T08:00:00.000Z'
const LANES = 3
const MACHINE_CORES = 16
const CARD = 1641
const roots: string[] = []
const dbs: DatabaseSync[] = []

afterEach(() => {
  dbs.splice(0).forEach(db => db.close())
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function cardText(priority: string): string {
  return `card: #${CARD} probe-${CARD} [probe/construct/S/cheap/auto] · depends — · blocks —\nbranch: probe/card-${CARD}\ntouches: scripts/a.ts\npriority: ${priority}\ncontinue: stop\nwho: shift\n\nProbe it.\n`
}

class Bench {
  readonly root = mkdtempSync(path.join(tmpdir(), 'amend-ended-'))
  readonly db: DatabaseSync = openBus(path.join(this.root, 'bus.db'))
  private admissions = 0

  constructor() {
    roots.push(this.root)
    dbs.push(this.db)
  }

  admit(source?: string, priority = 'p3'): this {
    this.admissions += 1
    const text = cardText(priority)
    busCardEvents(this.db, 's1')({ type: CARD_ADMITTED, cardId: CARD, ts: TS, dedupeKey: `admit-${CARD}-${this.admissions}`, payload: { card: text.split('\n')[0]!.slice('card: '.length), depends: [], decision: 'auto', contour: 'cheap', text, textSha: textSha(text), ...(source === undefined ? {} : { source }) } })
    return this.reduced()
  }

  record(type: typeof CARD_STARTED | typeof CARD_CLOSED | typeof CARD_DROPPED | typeof CARD_STOPPED): this {
    appendEvent(this.db, { ts: TS, type, actor: 'policy', cardId: CARD, pr: null, head: null, dedupeKey: `${type}:${CARD}`, payload: {}, legacy: false })
    return this.reduced()
  }

  candidates(): number[] {
    return launchCandidates(this.db, () => false, () => Date.parse(TS), () => {}, [], () => LANES, new MachineSessions(path.join(this.root, 'machine'), () => false, MACHINE_CORES)).map(candidate => candidate.cardId)
  }

  private reduced(): this {
    reduce(this.db, 'pending', busProjections())
    return this
  }
}

describe('an amend of a card that already ended', () => {
  it('an amend admission after card.closed leaves the card out of the launch queue', () => {
    const bench = new Bench().admit().record(CARD_STARTED).record(CARD_CLOSED).admit('amend', 'p2')

    expect(bench.candidates()).not.toContain(CARD)
    expect(launchableCard(bench.db, CARD)).toBeNull()
  })

  it('an amend admission after card.dropped leaves the card out of the launch queue', () => {
    const bench = new Bench().admit().record(CARD_DROPPED).admit('amend', 'p2')

    expect(bench.candidates()).not.toContain(CARD)
    expect(launchableCard(bench.db, CARD)).toBeNull()
  })

  it('an amend admission of a card never started keeps it queued', () => {
    const bench = new Bench().admit().admit('amend', 'p2')

    expect(bench.candidates()).toContain(CARD)
    expect(launchableCard(bench.db, CARD)).not.toBeNull()
  })

  it('a fresh admission after card.closed queues the card again', () => {
    const bench = new Bench().admit().record(CARD_STARTED).record(CARD_CLOSED).admit(undefined, 'p2')

    expect(bench.candidates()).toContain(CARD)
    expect(launchableCard(bench.db, CARD)).not.toBeNull()
  })

  it('a fresh admission after card.dropped queues the card again', () => {
    const bench = new Bench().admit().record(CARD_DROPPED).admit(undefined, 'p2')

    expect(bench.candidates()).toContain(CARD)
    expect(launchableCard(bench.db, CARD)).not.toBeNull()
  })

  it('an amend admission after card.stopped keeps the card queued', () => {
    const bench = new Bench().admit().record(CARD_STARTED).record(CARD_STOPPED).admit('amend', 'p2')

    expect(bench.candidates()).toContain(CARD)
    expect(launchableCard(bench.db, CARD)).not.toBeNull()
  })
})
