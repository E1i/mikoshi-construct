import type { DatabaseSync } from 'node:sqlite'
import type { EventType } from '../../../core/events.js'
import type { OverlapDeclarations } from '../../../core/order/overlap.js'
import type { OrderEventSource } from '../../../core/order/turn.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { busFacts } from '../../../../src/commands/board/bus.js'
import { screenLines } from '../../../../src/commands/board/screens.js'
import { PLAIN_LORE } from '../../../../src/ui/lore.js'
import { appendEvent, openBus } from '../../../core/db.js'
import { readDeclarations } from '../../../core/declarations.js'
import { declaredPayload, MAIN_ADVANCED, PR_OBSERVED, PR_OPENED, PR_ORDERED, TASK_ENQUEUED, TASK_LEASED, WINDOW_REQUEST } from '../../../core/events.js'
import { groupOf } from '../../../core/order/group.js'
import { overlapDeclarationsOf, overlaps } from '../../../core/order/overlap.js'
import { BUS_ORDERS, ORDER_ACTOR, orderEventsFrom, orderGroups, PrOrderTick, readOrder, turnOf } from '../../../core/order/turn.js'
import { BusRead } from '../../../ports/bus-read.js'
import { NetWatch } from '../../../ports/netwatch.js'
import { busOrderTick, superviseUntilReplaced } from '../../../supervisor/supervisor.js'
import { dispatchRequest } from '../../../window/requests/index.js'
import { requestOf } from '../../../window/window-requests.js'
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

function emptyBus(): { db: Bus, root: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-o2-wired-'))
  roots.push(root)
  return { db: openBus(path.join(root, 'bus.db')), root }
}

function count(db: Bus, type: string): number {
  return Number((db.prepare('SELECT count(*) AS n FROM events WHERE type = ?').get(type) as { n: number }).n)
}

describe('conveyor O2: the order runs in the bus, on the board and through the window', () => {
  it('the supervisor loop runs the order tick it builds for the bus: a PR at pass + green gets one pr.ordered, and the shadow counts are printed', async () => {
    const { db, root } = emptyBus()
    appendEvent(db, { ts: '2026-11-14T00:00:00Z', type: PR_OBSERVED, actor: 'netwatch', cardId: null, pr: 77, head: null, dedupeKey: 'o2:observed', payload: { head: 'a'.repeat(40), paths: ['docs/x.md'], ci: 'green', verdict_on_head: 'pass', mergeable: 'clean' }, legacy: false })
    appendEvent(db, { ts: '2026-11-14T00:00:01Z', type: MAIN_ADVANCED, actor: 'netwatch', cardId: null, pr: null, head: null, dedupeKey: 'o2:main', payload: { sha: 'f'.repeat(40), paths: ['docs/x.md'], pathsTruncated: false, touches_mechanics: false }, legacy: false })
    const printed: string[] = []
    let ticks = 0
    await superviseUntilReplaced({
      supervisor: { step: async () => [], get ownCodeBehind() {
        ticks += 1
        return ticks > 2 ? 'sha' : null
      } } as never,
      keeper: { step: () => [] } as never,
      order: busOrderTick(db, root),
      relaunch: () => ({ stdout: [], stderr: [], exitCode: 0 }),
      print: line => printed.push(line),
      pause: async () => {},
    })
    expect(count(db, PR_ORDERED)).toBe(1)
    expect(printed).toEqual(expect.arrayContaining([expect.stringContaining('PR #77 reached pass + green'), expect.stringContaining('needsUpdate counted 1')]))
    db.close()
  })

  it('the order tick records the groups of scenario 10 as pr.groups, and the board shows each with its modules and its turn, and the shadow counts', () => {
    const { db, declarations } = observedBus([
      { number: 1001, files: ['docs/guide/first-new-page.md', MODULE_FILES] },
      { number: 1002, files: ['docs/guide/second-new-page.md', MODULE_FILES] },
      { number: 1003, files: ['templates/base/a-new-template.md'] },
    ])
    order(db, 1002)
    new PrOrderTick(db, busEvents(db), () => '2026-11-14T00:00:30Z', () => declarations, '').step()
    const facts = busFacts(db, new Date('2026-11-14T00:01:00Z'))
    expect(facts.groups).toEqual([
      { prs: [1001], modules: ['docs'], turn: null },
      { prs: [1002], modules: ['docs'], turn: 1002 },
      { prs: [1003], modules: ['templates'], turn: null },
    ])
    expect(facts.shadow).toEqual({ needsUpdate: 0, needsVerification: 3 })
    const lines = screenLines(facts, PLAIN_LORE)
    expect(lines.filter(line => line.includes('PR #100'))).toEqual([
      expect.stringContaining('PR #1001'),
      expect.stringContaining('turn PR #1002'),
      expect.stringContaining('PR #1003'),
    ])
    expect(lines).toEqual(expect.arrayContaining([expect.stringContaining('needsUpdate counted 0 · needsVerification counted 3')]))
    db.close()
  })

  it('on a real bus the tick groups a PR not yet observed by its card\'s touches, and the board shows the member holding a leased merge as the turn', () => {
    const { db, declarations } = observedBus([
      { number: 3001, files: ['docs/guide/shared.md'] },
      { number: 3002, files: ['docs/guide/shared.md'] },
    ])
    order(db, 3001)
    order(db, 3002)
    appendEvent(db, { ts: '2026-11-14T00:00:02Z', type: PR_OPENED, actor: 'worker:shift:1', cardId: 33, pr: 3003, head: null, dedupeKey: `${PR_OPENED}:33:3003`, payload: { pr: 3003 }, legacy: false })
    appendEvent(db, { ts: '2026-11-14T00:00:03Z', type: TASK_ENQUEUED, actor: 'policy', cardId: 32, pr: 3002, head: null, dedupeKey: 'o2:merge:enqueued', payload: { task_key: 'merge:32:3002:x', queue: 'merge' }, legacy: false })
    appendEvent(db, { ts: '2026-11-14T00:00:04Z', type: TASK_LEASED, actor: 'policy', cardId: 32, pr: 3002, head: null, dedupeKey: 'o2:merge:leased', payload: { task_key: 'merge:32:3002:x', queue: 'merge', lease_gen: 1 }, legacy: false })
    const touches = (card: number): readonly string[] | null => card === 33 ? ['docs/guide/shared.md'] : null
    new PrOrderTick(db, busEvents(db), () => '2026-11-14T00:00:30Z', () => declarations, '', touches).step()
    expect(busFacts(db, new Date('2026-11-14T00:01:00Z')).groups).toEqual([{ prs: [3001, 3002, 3003], modules: ['docs'], turn: 3002 }])
    db.close()
  })

  it('order.move from the window writes pr.ordered {before, by: window}, and the fold puts the PR ahead of the one it names', () => {
    const { db, declarations } = observedBus([
      { number: 2001, files: ['docs/guide/shared.md'] },
      { number: 2002, files: ['docs/guide/shared.md'] },
    ])
    order(db, 2001)
    order(db, 2002)
    const payload = requestOf(['order.move', '--pr', '2002', '--before', '2001'])
    expect(payload).toEqual({ kind: 'order.move', pr: 2002, before: 2001 })
    expect(declaredPayload(WINDOW_REQUEST, payload!)).toEqual(payload)
    const outcome = dispatchRequest({ db, now: () => '2026-11-14T00:02:00Z' } as never, 'order.move', 9001, payload!)
    expect(outcome.done).toBe(true)
    const moved = new BusRead(db).slice(PR_ORDERED, ['before', 'by'] as never)
    expect(moved.at(-1)).toMatchObject({ pr: 2002, fields: { before: 2001, by: 'window' } })
    const folded = readOrder(busEvents(db), declarations)
    expect(folded.ranks).toEqual([2002, 2001])
    const [group] = orderGroups(folded, declarations)
    expect(turnOf(folded, group!, { parked: () => false, holds: () => false })).toBe(2002)
    db.close()
  })
})
