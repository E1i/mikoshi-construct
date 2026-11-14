import type { DatabaseSync } from 'node:sqlite'
import type { PrGroup } from './group.js'
import type { OverlapDeclarations } from './overlap.js'
import { appendEvent } from '../db.js'
import { declaredPayload, MAIN_ADVANCED, PR_CLOSED, PR_GROUPS, PR_OBSERVED, PR_OPENED, PR_ORDERED } from '../events.js'
import { groupsOf } from './group.js'
import { orderDeclarationsAt, overlaps } from './overlap.js'

export const ORDER_EVENTS: readonly string[] = [PR_OBSERVED, PR_CLOSED, PR_OPENED, PR_ORDERED, MAIN_ADVANCED]
export const BUS_ORDERS = 'bus'
export const WINDOW_ORDERS = 'window'
export const ORDER_ACTOR = 'worker:supervisor:order'
export const PASS_VERDICT = 'pass'
export const GREEN_CI = 'green'
export const DIRTY = 'dirty'

export interface OrderEvent {
  id: number
  type: string
  pr: number | null
  payload: Readonly<Record<string, unknown>>
}

export interface OrderedPr {
  pr: number
  open: boolean
  life: number
  head: string | null
  headSince: number
  paths: readonly string[] | null
  ci: string | null
  verdict: string | null
  mergeable: string | null
}

interface MainStep {
  id: number
  paths: readonly string[]
  whole: boolean
}

export interface ShadowCounts {
  needsUpdate: number
  needsVerification: number
}

export interface PrOrder {
  prs: Map<number, OrderedPr>
  ranks: number[]
  mains: MainStep[]
  needsUpdate: Set<number>
  needsVerification: Set<number>
  counted: ShadowCounts
  through: number
}

export interface TurnState {
  parked: (pr: number) => boolean
  holds: (pr: number) => boolean
}

export function emptyOrder(): PrOrder {
  return { prs: new Map(), ranks: [], mains: [], needsUpdate: new Set(), needsVerification: new Set(), counted: { needsUpdate: 0, needsVerification: 0 }, through: 0 }
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function pathsOf(value: unknown): string[] | null {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string') ? value as string[] : null
}

function prNumberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function newLife(pr: number, id: number, from?: OrderedPr): OrderedPr {
  return { pr, open: true, life: id, head: from?.head ?? null, headSince: from?.headSince ?? id, paths: from?.paths ?? null, ci: null, verdict: null, mergeable: null }
}

function leaveTheOrder(order: PrOrder, pr: number): void {
  order.ranks = order.ranks.filter(ranked => ranked !== pr)
  order.needsUpdate.delete(pr)
  order.needsVerification.delete(pr)
}

function mark(set: Set<number>, pr: number, holds: boolean): boolean {
  if (!holds) {
    set.delete(pr)
    return false
  }
  if (set.has(pr))
    return false
  set.add(pr)
  return true
}

function judge(order: PrOrder, life: OrderedPr, declarations: OverlapDeclarations): void {
  const since = order.mains.filter(step => step.id > life.headSince)
  const needsUpdate = life.mergeable === DIRTY
    || since.some(step => step.whole)
    || (life.paths !== null && overlaps(life.paths, since.flatMap(step => step.paths), declarations))
  if (mark(order.needsUpdate, life.pr, needsUpdate))
    order.counted.needsUpdate += 1
  if (mark(order.needsVerification, life.pr, !needsUpdate && since.length > 0))
    order.counted.needsVerification += 1
}

function openLives(order: PrOrder): OrderedPr[] {
  return [...order.prs.values()].filter(life => life.open)
}

function forgetMainsNoPrNeeds(order: PrOrder): void {
  const oldest = Math.min(...openLives(order).map(life => life.headSince))
  order.mains = order.mains.filter(step => step.id > oldest)
}

function observed(order: PrOrder, event: OrderEvent, pr: number, declarations: OverlapDeclarations): void {
  const known = order.prs.get(pr)
  const life = known?.open === true ? known : newLife(pr, event.id, known)
  const head = textOf(event.payload.head)
  const newHead = head !== life.head
  const recorded: OrderedPr = {
    ...life,
    head,
    headSince: newHead ? event.id : life.headSince,
    paths: pathsOf(event.payload.paths) ?? (newHead ? null : life.paths),
    ci: textOf(event.payload.ci),
    verdict: textOf(event.payload.verdict_on_head),
    mergeable: textOf(event.payload.mergeable),
  }
  order.prs.set(pr, recorded)
  judge(order, recorded, declarations)
}

function closed(order: PrOrder, pr: number): void {
  const known = order.prs.get(pr)
  if (known !== undefined)
    order.prs.set(pr, { ...known, open: false })
  leaveTheOrder(order, pr)
}

function opened(order: PrOrder, event: OrderEvent, pr: number): void {
  const known = order.prs.get(pr)
  if (known?.open !== true)
    order.prs.set(pr, newLife(pr, event.id, known))
}

function ordered(order: PrOrder, event: OrderEvent, pr: number): void {
  if (order.prs.get(pr)?.open !== true)
    return
  const before = prNumberOf(event.payload.before)
  const moved = textOf(event.payload.by) === WINDOW_ORDERS || before !== null
  if (!moved && order.ranks.includes(pr))
    return
  order.ranks = order.ranks.filter(ranked => ranked !== pr)
  const at = before === null || before === pr ? -1 : order.ranks.indexOf(before)
  if (at === -1)
    order.ranks.push(pr)
  else
    order.ranks.splice(at, 0, pr)
}

function mainAdvanced(order: PrOrder, event: OrderEvent, declarations: OverlapDeclarations): void {
  order.mains.push({ id: event.id, paths: pathsOf(event.payload.paths) ?? [], whole: event.payload.pathsTruncated === true })
  for (const life of openLives(order))
    judge(order, life, declarations)
  forgetMainsNoPrNeeds(order)
}

export function foldOrder(order: PrOrder, event: OrderEvent, declarations: OverlapDeclarations): PrOrder {
  order.through = Math.max(order.through, event.id)
  if (event.type === MAIN_ADVANCED) {
    mainAdvanced(order, event, declarations)
    return order
  }
  const pr = event.pr ?? prNumberOf(event.payload.pr)
  if (pr === null)
    return order
  if (event.type === PR_OBSERVED)
    observed(order, event, pr, declarations)
  else if (event.type === PR_CLOSED)
    closed(order, pr)
  else if (event.type === PR_OPENED)
    opened(order, event, pr)
  else if (event.type === PR_ORDERED)
    ordered(order, event, pr)
  return order
}

export function foldOrderEvents(events: readonly OrderEvent[], declarations: OverlapDeclarations, order: PrOrder = emptyOrder()): PrOrder {
  for (const event of events)
    foldOrder(order, event, declarations)
  return order
}

export function orderGroups(order: PrOrder, declarations: OverlapDeclarations, touchesOf: (pr: number) => readonly string[] | null = () => null): PrGroup[] {
  return groupsOf(openLives(order).map(life => ({ pr: life.pr, paths: life.paths ?? touchesOf(life.pr) ?? [] })), declarations)
}

export function membersOf(order: PrOrder, group: PrGroup): number[] {
  return order.ranks.filter(pr => group.prs.includes(pr) && order.prs.get(pr)?.open === true)
}

export function turnOf(order: PrOrder, group: PrGroup, state: TurnState): number | null {
  const members = membersOf(order, group)
  return members.find(state.holds) ?? members.find(pr => !state.parked(pr)) ?? null
}

export function readyToOrder(order: PrOrder): number[] {
  return openLives(order)
    .filter(life => !order.ranks.includes(life.pr) && life.ci === GREEN_CI && life.verdict === PASS_VERDICT)
    .map(life => life.pr)
    .sort((a, b) => a - b)
}

export interface OrderSlice {
  id: number
  pr: number | null
  fields: object
}

export type SliceOf = (type: string, fields: readonly string[], after: number) => OrderSlice[]

export type OrderEventSource = (after: number) => OrderEvent[]

export const ORDER_FIELDS: Readonly<Record<string, readonly string[]>> = {
  [PR_OBSERVED]: ['head', 'paths', 'ci', 'verdict_on_head', 'mergeable'],
  [PR_CLOSED]: ['merged'],
  [PR_OPENED]: ['pr'],
  [PR_ORDERED]: ['before', 'by'],
  [MAIN_ADVANCED]: ['paths', 'pathsTruncated'],
}

export function orderEventsFrom(sliceOf: SliceOf): OrderEventSource {
  return after => ORDER_EVENTS
    .flatMap(type => sliceOf(type, ORDER_FIELDS[type]!, after).map(slice => ({ id: slice.id, type, pr: slice.pr, payload: slice.fields as Record<string, unknown> })))
    .sort((a, b) => a.id - b.id)
}

export interface GroupWithTurn extends PrGroup {
  turn: number | null
}

export const PARKING_VERDICT = 'changes'
export const PARKING_CI = 'red'

export function parkedByRecord(order: PrOrder): TurnState {
  return {
    parked: (pr) => {
      const life = order.prs.get(pr)
      return life === undefined || life.verdict === PARKING_VERDICT || life.ci === PARKING_CI
    },
    holds: () => false,
  }
}

export function groupsWithTurn(order: PrOrder, declarations: OverlapDeclarations): GroupWithTurn[] {
  const state = parkedByRecord(order)
  return orderGroups(order, declarations).map(group => ({ ...group, turn: turnOf(order, group, state) }))
}

export function recordGroups(db: DatabaseSync, ts: string, order: PrOrder, groups: readonly GroupWithTurn[]): boolean {
  const payload = { groups: groups.map(({ prs, modules, turn }) => ({ prs, modules, turn })), ...order.counted }
  return appendEvent(db, {
    ts,
    type: PR_GROUPS,
    actor: ORDER_ACTOR,
    cardId: null,
    pr: null,
    head: null,
    dedupeKey: `${PR_GROUPS}:${order.through}:${JSON.stringify(payload)}`,
    payload: declaredPayload(PR_GROUPS, payload),
    legacy: false,
  })
}

export function recordMove(db: DatabaseSync, ts: string, actor: string, request: number, pr: number, before: number | null): boolean {
  return appendEvent(db, {
    ts,
    type: PR_ORDERED,
    actor,
    cardId: null,
    pr,
    head: null,
    dedupeKey: `${PR_ORDERED}:move:request-${request}`,
    payload: declaredPayload(PR_ORDERED, before === null ? { by: WINDOW_ORDERS } : { by: WINDOW_ORDERS, before }),
    legacy: false,
  })
}

export function readOrder(events: OrderEventSource, declarations: OverlapDeclarations): PrOrder {
  return foldOrderEvents(events(0), declarations)
}

export function orderedKey(pr: number, life: number): string {
  return `${PR_ORDERED}:${pr}:${life}`
}

export function recordOrdered(db: DatabaseSync, ts: string, order: PrOrder): number[] {
  return readyToOrder(order).filter(pr => appendEvent(db, {
    ts,
    type: PR_ORDERED,
    actor: ORDER_ACTOR,
    cardId: null,
    pr,
    head: null,
    dedupeKey: orderedKey(pr, order.prs.get(pr)!.life),
    payload: declaredPayload(PR_ORDERED, { by: BUS_ORDERS }),
    legacy: false,
  }))
}

export class PrOrderTick {
  private readonly order = emptyOrder()
  private shown: ShadowCounts = { needsUpdate: 0, needsVerification: 0 }
  private recorded: string | null = null

  constructor(
    private readonly db: DatabaseSync,
    private readonly events: OrderEventSource,
    private readonly now: () => string,
    private readonly declarations: () => OverlapDeclarations,
    private readonly prefix: string,
  ) {}

  step(): string[] {
    try {
      const events = this.events(this.order.through)
      const changed = events.length > 0 || this.recorded === null
      const declarations = changed ? this.declarations() : null
      if (declarations !== null && events.length > 0)
        foldOrderEvents(events, declarations, this.order)
      const lines = recordOrdered(this.db, this.now(), this.order).map(pr => `${this.prefix}PR #${pr} reached pass + green: ${PR_ORDERED} puts it at the tail of its group's order`)
      if (declarations !== null)
        this.recordGroups(declarations)
      return [...lines, ...this.shadowLine()]
    }
    catch (error) {
      return [`${this.prefix}folding ${PR_ORDERED} failed: ${error instanceof Error ? error.message : String(error)}; retried on the next tick`]
    }
  }

  private recordGroups(declarations: OverlapDeclarations): void {
    const groups = groupsWithTurn(this.order, declarations)
    const reading = JSON.stringify({ groups, counted: this.order.counted })
    if (reading === this.recorded)
      return
    recordGroups(this.db, this.now(), this.order, groups)
    this.recorded = reading
  }

  private shadowLine(): string[] {
    const { counted } = this.order
    if (counted.needsUpdate === this.shown.needsUpdate && counted.needsVerification === this.shown.needsVerification)
      return []
    this.shown = { ...counted }
    return [`${this.prefix}shadow: needsUpdate counted ${counted.needsUpdate}, needsVerification counted ${counted.needsVerification}; nothing acts on them yet`]
  }
}

export function prOrderTickAt(db: DatabaseSync, root: string, prefix: string, events: OrderEventSource): PrOrderTick {
  return new PrOrderTick(db, events, () => new Date().toISOString(), () => orderDeclarationsAt(root), prefix)
}
