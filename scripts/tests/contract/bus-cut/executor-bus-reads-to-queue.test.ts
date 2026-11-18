import type { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CONCEPTS } from '../../../contract/factory/concepts.js'
import { findSites } from '../../../contract/factory/overlaps.js'
import { repositoryReport } from '../../../contract/module-graph/report.js'
import { appendEvent, openBus } from '../../../core/db.js'
import { CARD_RELEASED, CARD_STOPPED, QUESTION_AGENT, QUESTION_OWNER, SCOPE_WIDENED } from '../../../core/events.js'
import { latestReleaseOf, latestWidenStopOf, widenedOnTheAdmission } from '../../../core/queue.js'

const REPO_RUN_TIMEOUT = 180_000
const ROOT = path.resolve(import.meta.dirname, '../../../..')
const EXECUTORS = ['scripts/nodes/answer/answer-executor.ts', 'scripts/nodes/merge/merge-executor.ts']
const VIOLATING_IMPORTS_AT_MOST = 1079
const BUS_READ = [CONCEPTS.find(concept => concept.id === 'bus-read')!]
const TS = '2026-11-18T08:00:00.000Z'
const CARD = 7
const OTHER_CARD = 8
const opened: DatabaseSync[] = []

afterEach(() => {
  for (const db of opened.splice(0))
    db.close()
})

function bus(): DatabaseSync {
  const db = openBus(':memory:')
  opened.push(db)
  return db
}

function append(db: DatabaseSync, type: typeof CARD_RELEASED | typeof CARD_STOPPED | typeof SCOPE_WIDENED, cardId: number, key: string, payload: Record<string, unknown>): void {
  appendEvent(db, { ts: TS, type, actor: 'policy', cardId, pr: null, head: null, dedupeKey: `${type}:${key}`, payload, legacy: false })
}

describe('the executors read the bus through named readers of core/queue.ts', () => {
  it('no bus-read site is left in the answer or the merge executor, and the module graph does not grow', { timeout: REPO_RUN_TIMEOUT }, () => {
    const inExecutors = findSites(ROOT, BUS_READ).filter(site => EXECUTORS.includes(site.file))

    expect(inExecutors).toEqual([])
    expect(repositoryReport().statistics.violatingImports).toBeLessThanOrEqual(VIOLATING_IMPORTS_AT_MOST)
  })

  it('the latest release of a card carries its id and its request, and no release reads as null', () => {
    const db = bus()
    expect(latestReleaseOf(db, CARD)).toBeNull()
    append(db, CARD_RELEASED, CARD, 'first', { request: 11 })
    append(db, CARD_RELEASED, CARD, 'second', { reason: 'takeover' })
    append(db, CARD_RELEASED, OTHER_CARD, 'other', { request: 12 })

    const release = latestReleaseOf(db, CARD)
    expect(release?.request).toBeNull()
    expect(latestReleaseOf(db, OTHER_CARD)?.request).toBe(12)
    expect(release!.id).toBeLessThan(latestReleaseOf(db, OTHER_CARD)!.id)
  })

  it('the latest widen stop is an owner question that asks to widen, with only its string paths', () => {
    const db = bus()
    append(db, CARD_STOPPED, CARD, 'widen', { reason: QUESTION_OWNER, detail: 'widen it', widen: ['a.ts', 3, 'b.ts'] })
    append(db, CARD_STOPPED, CARD, 'agent', { reason: QUESTION_AGENT, detail: 'not a widen', widen: ['c.ts'] })
    append(db, CARD_STOPPED, CARD, 'empty', { reason: QUESTION_OWNER, detail: 'nothing to widen', widen: [] })

    expect(latestWidenStopOf(db, CARD)).toMatchObject({ detail: 'widen it', widen: ['a.ts', 'b.ts'] })
    expect(latestWidenStopOf(db, OTHER_CARD)).toBeNull()
  })

  it('the paths widened on an admission are those of that admission only, in the order they were widened', () => {
    const db = bus()
    append(db, SCOPE_WIDENED, CARD, 'one', { paths: ['a.ts'], admission: 5, detail: 'one' })
    append(db, SCOPE_WIDENED, CARD, 'two', { paths: ['b.ts', 'c.ts'], admission: 5, detail: 'two' })
    append(db, SCOPE_WIDENED, CARD, 'older', { paths: ['old.ts'], admission: 4, detail: 'older' })
    append(db, SCOPE_WIDENED, OTHER_CARD, 'other', { paths: ['other.ts'], admission: 5, detail: 'other' })

    expect(widenedOnTheAdmission(db, CARD, 5)).toEqual(['a.ts', 'b.ts', 'c.ts'])
    expect(widenedOnTheAdmission(db, CARD, 6)).toEqual([])
  })
})
