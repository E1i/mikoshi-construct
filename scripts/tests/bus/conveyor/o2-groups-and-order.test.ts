import type { DatabaseSync } from 'node:sqlite'
import type { EventType } from '../../../core/events.js'
import type { OverlapDeclarations } from '../../../core/order/overlap.js'
import type { OrderEventSource } from '../../../core/order/turn.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../../core/db.js'
import { readDeclarations } from '../../../core/declarations.js'
import { PR_ORDERED } from '../../../core/events.js'
import { groupOf } from '../../../core/order/group.js'
import { overlapDeclarationsOf, overlaps } from '../../../core/order/overlap.js'
import { BUS_ORDERS, ORDER_ACTOR, orderEventsFrom, orderGroups, readOrder, turnOf } from '../../../core/order/turn.js'
import { BusRead } from '../../../ports/bus-read.js'
import { NetWatch } from '../../../ports/netwatch.js'
import { Clock, FakeGitHub, sha } from '../github-fake.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

const MODULE_FILES = 'contract/module-files.json'
const DECLARATIONS = 'declarations/'

type Bus = ReturnType<typeof openBus>

function busEvents(db: DatabaseSync): OrderEventSource {
  return orderEventsFrom((type, fields, after) => new BusRead(db, { from: after + 1 }).slice(type as EventType, fields as never))
}

function observedBus(pulls: { number: number, files: string[] }[]): { db: Bus, declarations: OverlapDeclarations } {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-o2-groups-'))
  roots.push(root)
  const db = openBus(path.join(root, 'bus.db'))
  const gitHub = new FakeGitHub()
  pulls.forEach((pull, at) => gitHub.open({ ...pull, head: sha(String.fromCharCode(97 + at)) }))
  new NetWatch(db, gitHub.client, new Clock().now).poll()
  return { db, declarations: overlapDeclarationsOf(readDeclarations()) }
}

function order(db: Bus, pr: number): void {
  appendEvent(db, { ts: '2026-11-14T00:00:01Z', type: PR_ORDERED, actor: ORDER_ACTOR, cardId: null, pr, head: null, dedupeKey: `${PR_ORDERED}:${pr}:test`, payload: { by: BUS_ORDERS }, legacy: false })
}

describe('conveyor O2: groups are computed from the paths the bus recorded', () => {
  it('scenario 10: two cards of one module adding different files under its pattern and one card elsewhere form three groups', () => {
    const { db, declarations } = observedBus([
      { number: 1001, files: ['docs/guide/first-new-page.md', MODULE_FILES] },
      { number: 1002, files: ['docs/guide/second-new-page.md', MODULE_FILES] },
      { number: 1003, files: ['templates/base/a-new-template.md'] },
    ])
    const groups = orderGroups(readOrder(busEvents(db), declarations), declarations)
    expect(groups).toEqual([
      { prs: [1001], modules: ['docs'] },
      { prs: [1002], modules: ['docs'] },
      { prs: [1003], modules: ['templates'] },
    ])
    expect(declarations.derived).toContain(MODULE_FILES)
    expect(overlaps(['docs/guide/first-new-page.md', MODULE_FILES], ['docs/guide/second-new-page.md', MODULE_FILES], { ...declarations, derived: [] })).toBe(true)
    const paths = [...readOrder(busEvents(db), declarations).prs.values()].flatMap(life => life.paths ?? [])
    expect(paths.filter(file => file.startsWith(DECLARATIONS))).toEqual([])
    db.close()
  })

  it('scenario 14: PRs adding declarations/events/a.json and b.json are different groups; two PRs adding the same declarations/events/c.json are one group, ordered by turnOf', () => {
    const { db, declarations } = observedBus([
      { number: 1401, files: ['declarations/events/a.json'] },
      { number: 1402, files: ['declarations/events/b.json'] },
      { number: 1403, files: ['declarations/events/c.json'] },
      { number: 1404, files: ['declarations/events/c.json'] },
    ])
    order(db, 1404)
    order(db, 1403)
    const folded = readOrder(busEvents(db), declarations)
    const groups = orderGroups(folded, declarations)
    expect(groups.map(group => group.prs)).toEqual([[1401], [1402], [1403, 1404]])
    const shared = groupOf(groups, 1403)!
    const nothingParked = { parked: () => false, holds: () => false }
    expect(turnOf(folded, shared, nothingParked)).toBe(1404)
    expect(turnOf(folded, shared, { ...nothingParked, parked: pr => pr === 1404 })).toBe(1403)
    db.close()
  })
})
