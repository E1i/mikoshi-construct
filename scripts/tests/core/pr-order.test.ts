import type { DatabaseSync } from 'node:sqlite'
import type { EventType } from '../../core/events.js'
import type { PrGroup } from '../../core/order/group.js'
import type { OrderEvent, PrOrder, TurnState } from '../../core/order/turn.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_HELD, CARD_RELEASED, MAIN_ADVANCED, PR_CLOSED, PR_OBSERVED, PR_OPENED, PR_ORDERED, TASK_COMPLETED, TASK_ENQUEUED, TASK_LEASED } from '../../core/events.js'
import { groupOf } from '../../core/order/group.js'
import { NO_DECLARATIONS, overlaps } from '../../core/order/overlap.js'
import { emptyOrder, foldOrder, foldOrderEvents, groupsWithTurn, membersOf, orderEventsFrom, orderGroups, PrOrderTick, turnOf, turnStateOf, WINDOW_ORDERS } from '../../core/order/turn.js'
import { BusRead } from '../../ports/bus-read.js'

class Events {
  private id = 0
  private heads = 0
  readonly all: OrderEvent[] = []

  private add(type: string, pr: number | null, payload: Record<string, unknown>): OrderEvent {
    this.id += 1
    const event = { id: this.id, type, pr, payload }
    this.all.push(event)
    return event
  }

  head(pr: number, paths: readonly string[], extra: Record<string, unknown> = {}): OrderEvent {
    this.heads += 1
    return this.add(PR_OBSERVED, pr, { head: String(this.heads).padStart(40, '0'), paths, ci: 'green', verdict_on_head: 'pass', mergeable: 'clean', ...extra })
  }

  ordered(pr: number, before?: number): OrderEvent {
    return this.add(PR_ORDERED, pr, before === undefined ? { by: 'bus' } : { by: WINDOW_ORDERS, before })
  }

  closed(pr: number): OrderEvent {
    return this.add(PR_CLOSED, pr, { merged: true })
  }

  opened(pr: number): OrderEvent {
    return this.add(PR_OPENED, pr, { pr })
  }

  main(paths: readonly string[], truncated = false): OrderEvent {
    return this.add(MAIN_ADVANCED, null, { sha: 'f'.repeat(40), paths, pathsTruncated: truncated, touches_mechanics: false })
  }
}

function busEvents(db: DatabaseSync): ReturnType<typeof orderEventsFrom> {
  return orderEventsFrom((type, fields, after) => new BusRead(db, { from: after + 1 }).slice(type as EventType, fields as never))
}

class State implements TurnState {
  readonly parkedPrs = new Set<number>()
  readonly holding = new Set<number>()
  readonly parked = (pr: number): boolean => this.parkedPrs.has(pr)
  readonly holds = (pr: number): boolean => this.holding.has(pr)
}

function fold(events: Events): PrOrder {
  return foldOrderEvents(events.all, NO_DECLARATIONS)
}

function groups(order: PrOrder): PrGroup[] {
  return orderGroups(order, NO_DECLARATIONS)
}

function turnOfPr(order: PrOrder, pr: number, state: TurnState): number | null {
  const group = groupOf(groups(order), pr)
  return group === null ? null : turnOf(order, group, state)
}

describe('overlaps on paths only', () => {
  it('two path sets overlap on a shared path and on a shared declared contention area, never on a derived registry', () => {
    const declarations = {
      modules: [{ module: 'm', layer: 'core', paths: ['m/'], exclude: [], shared: [] }],
      contention: [{ id: 'restart', paths: ['bus/'], why: 'one restart at a time', until: 'P-restart' }],
      derived: ['contract/module-files.json'],
    }
    expect(overlaps(['m/a.ts'], ['m/a.ts'], declarations)).toBe(true)
    expect(overlaps(['m/a.ts'], ['m/b.ts'], declarations)).toBe(false)
    expect(overlaps(['bus/a.ts'], ['bus/b.ts'], declarations)).toBe(true)
    expect(overlaps(['m/a.ts', 'contract/module-files.json'], ['m/b.ts', 'contract/module-files.json'], declarations)).toBe(false)
  })
})

describe('pr_order projection rules, one case per row of §1.1', () => {
  it('a PR merged while it holds the turn leaves the order, and the next unparked member by rank takes it in the same fold step', () => {
    const events = new Events()
    events.head(1, ['a'])
    events.head(2, ['a'])
    events.head(3, ['a'])
    events.ordered(1)
    events.ordered(2)
    events.ordered(3)
    const state = new State()
    state.parkedPrs.add(2)
    const order = fold(events)
    expect(turnOfPr(order, 1, state)).toBe(1)
    foldOrder(order, events.closed(1), NO_DECLARATIONS)
    expect(membersOf(order, groupOf(groups(order), 3)!)).toEqual([2, 3])
    expect(turnOfPr(order, 3, state)).toBe(3)
  })

  it('a group that splits on a new head keeps each member\'s rank; the part with the former holder keeps the turn, the other part has its own', () => {
    const events = new Events()
    events.head(1, ['a', 'shared'])
    events.head(2, ['b', 'shared'])
    events.head(3, ['b'])
    events.ordered(3)
    events.ordered(1)
    events.ordered(2)
    const state = new State()
    state.holding.add(1)
    const order = fold(events)
    expect(groups(order).map(group => group.prs)).toEqual([[1, 2, 3]])
    expect(turnOfPr(order, 2, state)).toBe(1)
    foldOrder(order, events.head(1, ['a']), NO_DECLARATIONS)
    expect(groups(order).map(group => group.prs)).toEqual([[1], [2, 3]])
    expect(order.ranks).toEqual([3, 1, 2])
    expect(turnOfPr(order, 1, state)).toBe(1)
    expect(turnOfPr(order, 2, state)).toBe(3)
  })

  it('two groups joined by a new head keep their ranks in one order; with both former holders leased, the lower rank is the turn and no lease is revoked', () => {
    const events = new Events()
    events.head(1, ['a'])
    events.head(2, ['b'])
    events.ordered(2)
    events.ordered(1)
    const state = new State()
    state.holding.add(1)
    state.holding.add(2)
    const order = fold(events)
    expect(groups(order)).toHaveLength(2)
    foldOrder(order, events.head(1, ['a', 'b']), NO_DECLARATIONS)
    const [joined] = groups(order)
    expect(joined!.prs).toEqual([1, 2])
    expect(membersOf(order, joined!)).toEqual([2, 1])
    expect(turnOf(order, joined!, state)).toBe(2)
    expect([...state.holding]).toEqual([1, 2])
  })

  it('a new head that overlaps several groups at once joins all of them and the PR into one component', () => {
    const events = new Events()
    events.head(1, ['a'])
    events.head(2, ['b'])
    events.head(3, ['c'])
    events.head(4, ['d'])
    for (const pr of [3, 1, 2, 4])
      events.ordered(pr)
    const order = fold(events)
    expect(groups(order)).toHaveLength(4)
    foldOrder(order, events.head(4, ['a', 'b', 'c']), NO_DECLARATIONS)
    const [joined] = groups(order)
    expect(joined!.prs).toEqual([1, 2, 3, 4])
    expect(turnOf(order, joined!, new State())).toBe(3)
  })

  it('a reopened PR starts a new life: no rank until a new pr.ordered, which puts it at the tail, and no turn by its old rank', () => {
    const events = new Events()
    events.head(1, ['a'])
    events.head(2, ['a'])
    events.ordered(1)
    events.ordered(2)
    events.closed(1)
    events.opened(1)
    const order = fold(events)
    expect(order.ranks).toEqual([2])
    expect(turnOfPr(order, 1, new State())).toBe(2)
    foldOrder(order, events.ordered(1), NO_DECLARATIONS)
    expect(order.ranks).toEqual([2, 1])
    expect(turnOfPr(order, 1, new State())).toBe(2)
  })

  it('the window moving a PR changes its rank and revokes no lease: a leased holder keeps the turn until it finishes', () => {
    const events = new Events()
    events.head(1, ['a'])
    events.head(2, ['a'])
    events.head(3, ['a'])
    events.ordered(1)
    events.ordered(2)
    events.ordered(3)
    const state = new State()
    state.holding.add(1)
    const order = fold(events)
    foldOrder(order, events.ordered(3, 1), NO_DECLARATIONS)
    expect(order.ranks).toEqual([3, 1, 2])
    expect(turnOfPr(order, 1, state)).toBe(1)
    state.holding.delete(1)
    expect(turnOfPr(order, 1, state)).toBe(3)
  })

  it('a member that becomes parked or unparked keeps its rank, and the turn is derived again', () => {
    const events = new Events()
    events.head(1, ['a'])
    events.head(2, ['a'])
    events.ordered(1)
    events.ordered(2)
    const state = new State()
    const order = fold(events)
    expect(turnOfPr(order, 1, state)).toBe(1)
    state.parkedPrs.add(1)
    expect(turnOfPr(order, 1, state)).toBe(2)
    state.parkedPrs.add(2)
    expect(turnOfPr(order, 1, state)).toBeNull()
    state.parkedPrs.clear()
    expect(order.ranks).toEqual([1, 2])
    expect(turnOfPr(order, 1, state)).toBe(1)
  })
})

function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let mixed = state
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

const PRS = [1, 2, 3, 4, 5, 6]
const PATHS = ['a', 'b', 'c', 'd', 'e']

function randomStep(random: () => number, events: Events, state: State): OrderEvent | null {
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!
  const pr = pick(PRS)
  const roll = random()
  if (roll < 0.3)
    return events.head(pr, PATHS.filter(() => random() < 0.35))
  if (roll < 0.45)
    return events.ordered(pr)
  if (roll < 0.52)
    return events.ordered(pr, pick(PRS))
  if (roll < 0.6)
    return events.closed(pr)
  if (roll < 0.66)
    return events.opened(pr)
  if (roll < 0.72)
    return events.main(PATHS.filter(() => random() < 0.3))
  const set = roll < 0.86 ? state.parkedPrs : state.holding
  if (set.has(pr))
    set.delete(pr)
  else
    set.add(pr)
  return null
}

function assertTheInvariant(order: PrOrder, state: State): void {
  const open = [...order.prs.values()].filter(life => life.open).map(life => life.pr).sort((a, b) => a - b)
  const all = groups(order)
  expect(all.flatMap(group => group.prs).sort((a, b) => a - b)).toEqual(open)
  for (const group of all) {
    const members = membersOf(order, group)
    const turn = turnOf(order, group, state)
    if (members.some(pr => !state.parked(pr)))
      expect(turn).not.toBeNull()
    if (turn !== null) {
      expect(members).toContain(turn)
      expect(order.prs.get(turn)!.open).toBe(true)
    }
  }
}

describe('the pr_order invariant over random event sequences', () => {
  it('every group with an unparked member has exactly one turn holder, never a closed PR, and a ready unparked PR gets the turn in finitely many folds', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const random = seeded(seed)
      const events = new Events()
      const state = new State()
      const order = emptyOrder()
      for (let step = 0; step < 60; step += 1) {
        const event = randomStep(random, events, state)
        if (event !== null)
          foldOrder(order, event, NO_DECLARATIONS)
        assertTheInvariant(order, state)
      }
      expect(fold(events).ranks).toEqual(order.ranks)

      const ready = order.ranks.filter(pr => !state.parked(pr))
      if (ready.length === 0)
        continue
      const target = ready.at(-1)!
      const bound = order.ranks.length
      let folds = 0
      for (let turn = turnOfPr(order, target, state); turn !== target; turn = turnOfPr(order, target, state)) {
        expect(turn).not.toBeNull()
        state.holding.delete(turn!)
        foldOrder(order, events.closed(turn!), NO_DECLARATIONS)
        folds += 1
        expect(folds).toBeLessThanOrEqual(bound)
      }
      expect(turnOfPr(order, target, state)).toBe(target)
    }
  })
})

describe('the bus writes pr.ordered once per life, when a PR first reaches pass + green', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0))
      rmSync(root, { recursive: true, force: true })
  })

  it('records pr.ordered once, never again on the same life, and once more after a reopen reaches pass + green again', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bus-pr-order-'))
    roots.push(root)
    const db = openBus(path.join(root, 'bus.db'))
    let at = 0
    const write = (type: string, payload: Record<string, unknown>): void => {
      at += 1
      appendEvent(db, { ts: '2026-11-14T00:00:00Z', type, actor: 'netwatch', cardId: null, pr: 950, head: null, dedupeKey: `test:${at}`, payload, legacy: false })
    }
    const observed = (ci: string, verdict: string | null): void => write(PR_OBSERVED, { head: 'a'.repeat(40), base: 'main', paths: ['docs/x.md'], ci, verdict_on_head: verdict, mergeable: 'clean' })
    const tick = new PrOrderTick(db, busEvents(db), () => '2026-11-14T00:00:01Z', () => NO_DECLARATIONS, '[test] ')
    const ordered = (): number => db.prepare('SELECT count(*) AS n FROM events WHERE type = ?').get(PR_ORDERED)!.n as number

    observed('pending', null)
    tick.step()
    expect(ordered()).toBe(0)
    observed('green', 'pass')
    expect(tick.step()).toEqual([expect.stringContaining('PR #950 reached pass + green')])
    tick.step()
    observed('green', 'pass')
    tick.step()
    expect(ordered()).toBe(1)

    write(PR_CLOSED, { merged: false })
    write(PR_OPENED, { pr: 950 })
    tick.step()
    expect(ordered()).toBe(1)
    observed('green', 'pass')
    tick.step()
    tick.step()
    expect(ordered()).toBe(2)
    db.close()
  })
})

describe('shadow: needsUpdate and needsVerification are computed and counted, and nothing reads them', () => {
  it('main advancing over a path the PR changed counts needsUpdate; over another path, needsVerification; a truncated main counts as overlap', () => {
    const events = new Events()
    events.head(1, ['a'])
    events.head(2, ['b'])
    events.head(3, ['c'])
    events.main(['a'])
    let order = fold(events)
    expect([...order.needsUpdate]).toEqual([1])
    expect([...order.needsVerification].sort()).toEqual([2, 3])
    expect(order.counted).toEqual({ needsUpdate: 1, needsVerification: 2 })

    foldOrder(order, events.head(1, ['a']), NO_DECLARATIONS)
    expect(order.needsUpdate.has(1)).toBe(false)
    foldOrder(order, events.main(['z'], true), NO_DECLARATIONS)
    expect([...order.needsUpdate].sort()).toEqual([1, 2, 3])
    expect(order.counted).toEqual({ needsUpdate: 4, needsVerification: 2 })

    order = fold(events)
    expect(order.counted).toEqual({ needsUpdate: 4, needsVerification: 2 })
  })
})

describe('needsUpdate holds when CI is red on the PR while green on main (the #1895 case)', () => {
  it('a red PR with no path overlap and a clean merge state counts needsUpdate once main is green, and not while main is red', () => {
    const events = new Events()
    events.head(1, ['a'], { ci: 'red' })
    events.main(['z'])
    const order = fold(events)
    expect(order.needsUpdate.has(1)).toBe(false)
    order.mainCi = 'green'
    foldOrder(order, events.main(['y']), NO_DECLARATIONS)
    expect(order.needsUpdate.has(1)).toBe(true)
    expect(order.counted.needsUpdate).toBe(1)
    order.mainCi = 'red'
    foldOrder(order, events.main(['x']), NO_DECLARATIONS)
    expect(order.needsUpdate.has(1)).toBe(false)
  })
})

describe('the turn the bus records is the turnOf of §1.1, folded from the bus record', () => {
  let id = 1000
  const at = (type: string, pr: number | null, card: number | null, payload: Record<string, unknown>): OrderEvent => ({ id: ++id, type, pr, card, payload })

  function threeInOneGroup(): PrOrder {
    const order = emptyOrder()
    for (const [pr, card] of [[1, 11], [2, 12], [3, 13]] as const) {
      foldOrder(order, at(PR_OBSERVED, pr, null, { head: String(pr).padStart(40, '0'), paths: ['shared'], ci: 'green', verdict_on_head: 'pass', mergeable: 'clean', card_id: card }), NO_DECLARATIONS)
      foldOrder(order, at(PR_ORDERED, pr, null, { by: 'bus' }), NO_DECLARATIONS)
    }
    return order
  }

  const turn = (order: PrOrder, waiting: ReadonlySet<number> = new Set()): number | null => groupsWithTurn(order, NO_DECLARATIONS, { waitingCards: waiting, touchesOf: () => null })[0]!.turn

  it('an answer queued or leased on the card, a card hold and an open owner question each park the member; the turn passes down the rank', () => {
    const order = threeInOneGroup()
    expect(turn(order)).toBe(1)
    foldOrder(order, at(TASK_ENQUEUED, 1, 11, { task_key: 'answer:11:1:x', queue: 'answer' }), NO_DECLARATIONS)
    expect(turn(order)).toBe(2)
    foldOrder(order, at(TASK_LEASED, 1, 11, { task_key: 'answer:11:1:x', queue: 'answer' }), NO_DECLARATIONS)
    expect(turn(order)).toBe(2)
    foldOrder(order, at(CARD_HELD, null, 12, {}), NO_DECLARATIONS)
    expect(turn(order)).toBe(3)
    expect(turn(order, new Set([13]))).toBeNull()
    foldOrder(order, at(TASK_COMPLETED, 1, 11, { task_key: 'answer:11:1:x', queue: 'answer' }), NO_DECLARATIONS)
    expect(turn(order, new Set([13]))).toBe(1)
    foldOrder(order, at(CARD_RELEASED, null, 12, {}), NO_DECLARATIONS)
    expect(turnStateOf(order, new Set()).parked(2)).toBe(false)
  })

  it('a member holding a leased update or merge task is the turn even below a lower rank, and gives it back when the task ends', () => {
    const order = threeInOneGroup()
    foldOrder(order, at(TASK_ENQUEUED, 3, 13, { task_key: 'merge:13:3:x', queue: 'merge' }), NO_DECLARATIONS)
    expect(turn(order)).toBe(1)
    foldOrder(order, at(TASK_LEASED, 3, 13, { task_key: 'merge:13:3:x', queue: 'merge' }), NO_DECLARATIONS)
    expect(turnStateOf(order, new Set()).holds(3)).toBe(true)
    expect(turn(order)).toBe(3)
    foldOrder(order, at(TASK_COMPLETED, 3, 13, { task_key: 'merge:13:3:x', queue: 'merge' }), NO_DECLARATIONS)
    expect(turn(order)).toBe(1)
  })

  it('an open PR with no observation yet is grouped by its card\'s declared touches', () => {
    const order = threeInOneGroup()
    foldOrder(order, at(PR_OPENED, 4, 14, { pr: 4 }), NO_DECLARATIONS)
    const touches = (card: number): readonly string[] | null => card === 14 ? ['shared'] : null
    const groups = groupsWithTurn(order, NO_DECLARATIONS, { waitingCards: new Set(), touchesOf: touches })
    expect(groups.map(group => group.prs)).toEqual([[1, 2, 3, 4]])
    expect(groupsWithTurn(order, NO_DECLARATIONS).map(group => group.prs)).toEqual([[1, 2, 3], [4]])
  })
})
