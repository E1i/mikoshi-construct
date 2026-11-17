import type { BusFacts, BusPanelFacts, BusSlot } from '../../../src/commands/board/bus.js'
import { escaped } from './session-card.js'

export type Health = 'green' | 'yellow' | 'red'

export interface PublishedSnapshot {
  written: string
  tickMs: number | null
}

export interface BusPanelParts {
  facts: BusFacts
  freshMs: number
  snapshot: PublishedSnapshot | null
  startCommand: string
}

interface HealthRow {
  name: string
  health: Health
  reading: string
}

const SECOND_MS = 1_000
const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
const DOWN_PULSES = 2
const STALE_PUBLISHES = 2
const PERCENT = 100
const REDUCER_LAG_RED = 100
const RATE_YELLOW = 1_000
const RATE_RED = 100
const NONE = '—'
const NO_PANEL: BusPanelFacts = { version: 1, lastEvent: null, minutes: [], families: [], familyTotal: 0, reducerLag: null, rateRemaining: null, pulses: [], workers: [], alarm: null, recent: [] }

export function ageOf(ms: number | null): string {
  if (ms === null)
    return NONE
  if (ms < MINUTE_MS)
    return `${Math.round(ms / SECOND_MS)}s`
  return ms < HOUR_MS ? `${Math.round(ms / MINUTE_MS)}m` : `${Math.round(ms / HOUR_MS)}h`
}

function sinceMs(ts: string | null | undefined, now: string): number | null {
  const at = Date.parse(ts ?? '')
  return Number.isNaN(at) ? null : Math.max(0, Date.parse(now) - at)
}

export function pulseAgeMs(facts: BusFacts): number | null {
  return sinceMs(facts.pulse, facts.at)
}

export function busFresh(facts: BusFacts, freshMs: number): boolean {
  const age = pulseAgeMs(facts)
  return age !== null && age <= freshMs
}

function pulseIntervalMs(panel: BusPanelFacts, freshMs: number): number {
  const [last, before] = panel.pulses.map(ts => Date.parse(ts))
  const gap = last === undefined || before === undefined ? Number.NaN : last - before
  return Number.isFinite(gap) && gap > 0 ? gap : freshMs
}

export function busDown(facts: BusFacts, freshMs: number): boolean {
  const age = pulseAgeMs(facts)
  const panel = facts.panel ?? NO_PANEL
  return age === null || age > DOWN_PULSES * pulseIntervalMs(panel, freshMs)
}

function reducerRow(lag: number | null): HealthRow {
  if (lag === null)
    return { name: 'REDUCER', health: 'yellow', reading: 'no watermark' }
  return { name: 'REDUCER', health: lag === 0 ? 'green' : lag <= REDUCER_LAG_RED ? 'yellow' : 'red', reading: `lag ${lag} events` }
}

function snapshotRow(snapshot: PublishedSnapshot | null, now: string): HealthRow {
  const age = sinceMs(snapshot?.written, now)
  const tick = snapshot?.tickMs ?? null
  if (age === null)
    return { name: 'SNAPSHOT', health: 'yellow', reading: 'not published' }
  const health: Health = tick === null || age > STALE_PUBLISHES * tick ? 'red' : age > tick ? 'yellow' : 'green'
  return { name: 'SNAPSHOT', health, reading: `published ${ageOf(age)} ago` }
}

function netwatchRow(rate: number | null): HealthRow {
  if (rate === null)
    return { name: 'NETWATCH', health: 'yellow', reading: 'no rate reading' }
  return { name: 'NETWATCH', health: rate < RATE_RED ? 'red' : rate < RATE_YELLOW ? 'yellow' : 'green', reading: `rate ${rate} left` }
}

function workersRow(panel: BusPanelFacts, now: string, freshMs: number): HealthRow {
  const expected = panel.workers.length
  const alive = panel.workers.filter(worker => (sinceMs(worker.ts, now) ?? Number.POSITIVE_INFINITY) <= freshMs).length
  const health: Health = expected > 0 && alive === expected ? 'green' : alive === 0 ? 'red' : 'yellow'
  return { name: 'WORKERS', health, reading: `${alive}/${expected} alive` }
}

function alarmRow(panel: BusPanelFacts): HealthRow {
  const alarm = panel.alarm
  if (alarm === null)
    return { name: 'ALARMS', health: 'green', reading: 'none open' }
  return { name: 'ALARMS', health: 'red', reading: [alarm.reason ?? 'alarm', alarm.card === null ? null : `#${alarm.card}`].filter(part => part !== null).join(' · ') }
}

function healthRows(parts: BusPanelParts, panel: BusPanelFacts): HealthRow[] {
  const { facts, freshMs } = parts
  const waits = facts.waits.length
  return [
    reducerRow(panel.reducerLag),
    snapshotRow(parts.snapshot, facts.at),
    netwatchRow(panel.rateRemaining),
    workersRow(panel, facts.at, freshMs),
    { name: 'WAITS', health: waits === 0 ? 'green' : 'yellow', reading: `${waits} open` },
    alarmRow(panel),
  ]
}

function cell(name: string, title: string, body: string): string {
  return `<div class="bus-cell bevel" data-cell="${name}"><div class="bus-cell-head">${title}</div>${body}</div>`
}

function flowCell(panel: BusPanelFacts): string {
  const peak = Math.max(1, ...panel.minutes)
  const bars = panel.minutes.map(count => `<i class="flow-bar" style="--_h:${Math.round(count / peak * PERCENT)}%" title="${count}"></i>`).join('')
  return cell('flow', 'EVENT FLOW', `<div class="flow-rate"><b>${panel.minutes.at(-1) ?? 0}</b> events/min</div><div class="flow-bars">${bars}</div>`)
}

function familiesCell(panel: BusPanelFacts): string {
  const total = Math.max(1, panel.familyTotal)
  const rows = panel.families.map(({ family, count }) => `<li><span>${escaped(family)}</span><b>${Math.round(count / total * PERCENT)}%</b></li>`).join('')
  return cell('families', 'TOP EVENTS · 30 MIN', rows === '' ? `<div class="svc-line">no events</div>` : `<ul class="bus-families">${rows}</ul>`)
}

function healthCell(rows: readonly HealthRow[]): string {
  return cell('health', 'NODE HEALTH', `<ul class="bus-health">${rows.map(row => `<li class="bevel" data-node="${row.name.toLowerCase()}" data-health="${row.health}"><span>${row.name}</span><b>${escaped(row.reading)}</b></li>`).join('')}</ul>`)
}

function slotRow(slot: BusSlot): string {
  const total = slot.total ?? slot.used
  const full = slot.total !== null && slot.used >= slot.total
  const segments = Array.from({ length: total }, (_, index) => `<i data-seg${index < slot.used ? ' data-on' : ''}></i>`).join('')
  return `<li data-slot-queue="${escaped(slot.queue)}" data-used="${slot.used}" data-total="${total}"${full ? ' data-full' : ''}><span>${escaped(slot.queue.toUpperCase())}</span><span class="slot-segs">${segments}</span><b>${slot.used}/${slot.total ?? NONE}</b></li>`
}

function slotsCell(slots: readonly BusSlot[]): string {
  return cell('slots', 'SLOTS', slots.length === 0 ? `<div class="svc-line">no queue reported</div>` : `<ul class="bus-slots">${slots.map(slotRow).join('')}</ul>`)
}

function timeOf(ts: string | null): string {
  return ts === null ? NONE : ts.slice(11, 19)
}

function recentCell(panel: BusPanelFacts): string {
  const rows = panel.recent.map(event => `<li class="bevel" data-event="${event.id}"><span class="when">${timeOf(event.ts)}</span><span>${escaped(event.type)}${event.detail === null ? '' : ` · ${escaped(event.detail)}`}</span><b>${event.card === null ? NONE : `#${event.card}`}</b></li>`).join('')
  return cell('recent', 'RECENT ACTIVITY', rows === '' ? `<div class="svc-line">no events</div>` : `<ul class="bus-recent">${rows}</ul>`)
}

function emblem(): string {
  return `<span class="bus-emblem" aria-hidden="true"><span class="bus-emblem-ring"></span><span class="bus-emblem-glyph">&gt;_</span></span>`
}

function header(parts: BusPanelParts, panel: BusPanelFacts, down: boolean): string {
  const age = ageOf(pulseAgeMs(parts.facts))
  const event = panel.lastEvent === null ? NONE : `#${panel.lastEvent.id}`
  const snapshot = ageOf(sinceMs(parts.snapshot?.written, parts.facts.at))
  return [
    `<div class="bus-head">${emblem()}`,
    `<span class="bus-title">${down ? 'BUS DOWN' : 'BUS LIVE'} V${panel.version}</span>`,
    `<span class="bus-pulse">● ${down ? 'NO PULSE' : 'PULSE'} · ${age}</span>`,
    `<span class="bus-meta">event ${event} · snapshot ${snapshot}</span></div>`,
  ].join('')
}

function flatlined(parts: BusPanelParts, panel: BusPanelFacts): string {
  const last = panel.lastEvent
  const line = `last event ${last === null ? NONE : `#${last.id}`} · ${ageOf(sinceMs(last?.ts, parts.facts.at))} · start the bus with ${parts.startCommand}`
  return `<div class="bus-flatline"><span class="flatline-stamp">FLATLINED</span><span class="flatline-line">NO PULSE · NODES SILENT</span><span class="flatline-line">${escaped(line)}</span></div>`
}

export function busPanel(parts: BusPanelParts): string {
  const panel = parts.facts.panel ?? NO_PANEL
  const down = busDown(parts.facts, parts.freshMs)
  const body = down ? flatlined(parts, panel) : `<div class="bus-body">${[flowCell(panel), familiesCell(panel), healthCell(healthRows(parts, panel)), slotsCell(parts.facts.slots), recentCell(panel)].join('')}</div>`
  return `<div class="bus-panel bevel"${down ? ' data-down' : ''} role="region" aria-label="bus">${header(parts, panel, down)}${body}</div>`
}
