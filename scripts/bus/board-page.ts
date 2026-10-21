import type { DatabaseSync } from 'node:sqlite'
import type { BusCard, BusFacts, BusService } from '../../src/commands/board/bus.js'
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { busFacts, FLOW_STATES } from '../../src/commands/board/bus.js'
import { backlogCards, goalLines, isLive, matrixLines, pulseLines } from '../../src/commands/board/screens.js'
import { BANNER, LORE, PLAIN_LORE } from '../../src/ui/lore.js'
import { VERSION } from '../../src/version.js'
import { BOARD_FILE, cardGauges, FRESH_MS, windowGauges } from './board.js'
import { BUSY_TIMEOUT_MS, defaultBusPath } from './db.js'
import { openDatabase } from './sqlite.js'

export const PREFIX = '[bus:board] '
export const REFRESH_SECONDS = 30
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const EDDIES_FILE = path.join(REPOSITORY_ROOT, '.claude/eddies.json')
export const MODEL_FILE = path.join(REPOSITORY_ROOT, 'construct.model.json')

export interface BoardFiles {
  write: (file: string, text: string) => void
  rename: (from: string, to: string) => void
}

export const DISK_FILES: BoardFiles = {
  write: (file, text) => writeFileSync(file, text),
  rename: renameSync,
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }

export function escaped(text: string): string {
  return text.replace(/[&<>"']/g, char => ESCAPES[char]!)
}

export interface Gauges {
  context: number | null
  spent: number | null
}

export interface EddiesLimits {
  contextLimit: number | null
  sessionSpend: number | null
  warnRatio: number | null
}

export interface BoardPage {
  version: string
  modelVersion: number | null
  facts: BusFacts
  gauges: Map<string, Gauges>
  windowGauges: Gauges | null
  limits: EddiesLimits
}

const NO_LIMITS: EddiesLimits = { contextLimit: null, sessionSpend: null, warnRatio: null }
const LORE_NAMES: Record<string, string> = { window: 'Мико', review: 'ICE', matrix: 'ICE', bus: 'Subnet' }
const RUNNER = 'Runner'
const WINDOW_ROLE = 'window'
const SESSION_STEP = / · pulse \d+ min ago$/
const CARD_PREFIX = /^card:\s*/
const FIELD_COUNT = 5
const NONE = '—'
const ALL_FILTER = 'all'
const LIVE_FILTER = 'live'
const STATE_ORDER = [...FLOW_STATES.flat(), 'stopped', 'merged', 'closed', 'dropped']
const THOUSAND = 1_000
const MILLION = 1_000_000
const MINUTE_MS = 60_000

function positive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

export function readEddiesLimits(file: string = EDDIES_FILE): EddiesLimits {
  try {
    const config = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> | null
    return config === null || typeof config !== 'object' ? NO_LIMITS : { contextLimit: positive(config.contextLimit), sessionSpend: positive(config.sessionSpend), warnRatio: positive(config.warnRatio) }
  }
  catch {
    return NO_LIMITS
  }
}

export function readModelVersion(file: string = MODEL_FILE): number | null {
  try {
    const model = JSON.parse(readFileSync(file, 'utf8')) as { modelVersion?: unknown } | null
    return Number.isInteger(model?.modelVersion) ? model!.modelVersion as number : null
  }
  catch {
    return null
  }
}

function projectedGauges(db: DatabaseSync): Map<string, Gauges> {
  return new Map(cardGauges(db).map(row => [`#${row.card}`, { context: positive(row.context), spent: positive(row.spent) }]))
}

function projectedWindowGauges(db: DatabaseSync): Gauges | null {
  const row = windowGauges(db)
  return row === null ? null : { context: positive(row.context), spent: positive(row.spent) }
}

function compact(value: number): string {
  if (value >= MILLION)
    return `${Number((value / MILLION).toFixed(1))}M`
  return value >= THOUSAND ? `${Math.round(value / THOUSAND)}k` : String(value)
}

function percent(ratio: number): string {
  return `${Math.min(100, Math.round(ratio * 100))}%`
}

function eddiesBar(name: string, value: number | null, limit: number | null, warnRatio: number | null): string {
  if (value === null)
    return ''
  const reading = limit === null ? compact(value) : `${compact(value)}/${compact(limit)}`
  const hot = limit !== null && warnRatio !== null && value >= limit * warnRatio
  const bar = limit === null ? '<span></span>' : `<span class="edd-bar" style="--_fill: ${percent(value / limit)}${warnRatio === null ? '' : `; --_warn: ${percent(warnRatio)}`}"></span>`
  return `<div class="edd"${hot ? ' data-hot' : ''}><span class="edd-k">${name}</span>${bar}<span class="edd-v">${reading}</span></div>`
}

function gaugesOf(service: BusService, page: BoardPage): Gauges | null | undefined {
  if (service.role === WINDOW_ROLE)
    return page.windowGauges
  return SESSION_STEP.test(service.step) ? page.gauges.get(service.task) : undefined
}

function serviceTile(service: BusService, page: BoardPage): string {
  const gauges = gaugesOf(service, page)
  const bars = gauges == null
    ? ''
    : eddiesBar('ctx', gauges.context, page.limits.contextLimit, page.limits.warnRatio) + eddiesBar('spent', gauges.spent, page.limits.sessionSpend, page.limits.warnRatio)
  return [
    `<div class="svc" data-role="${escaped(service.role)}">`,
    `<div class="svc-top"><span class="svc-kind">${escaped(service.role)}</span><span class="lore">${LORE_NAMES[service.role] ?? RUNNER}</span><span class="svc-target">${escaped(service.task)}</span></div>`,
    `<div class="svc-line">${escaped(PLAIN_LORE.boardServiceLine(service.role, service.task, service.tree ?? undefined, service.step))}</div>`,
    bars,
    '</div>',
  ].join('')
}

function lineTile(role: string, line: string): string {
  return `<div class="svc" data-role="${role}"><div class="svc-top"><span class="svc-kind">${role}</span><span class="lore">${LORE_NAMES[role] ?? RUNNER}</span></div><div class="svc-line">${escaped(line)}</div></div>`
}

function pulseAgeMs(facts: BusFacts): number | null {
  return facts.pulse === null ? null : Math.max(0, Date.parse(facts.at) - Date.parse(facts.pulse))
}

function busFresh(facts: BusFacts): boolean {
  const age = pulseAgeMs(facts)
  return age !== null && age <= FRESH_MS
}

function liveAttribute(facts: BusFacts): string {
  return busFresh(facts) ? '' : ' data-stale'
}

function slotsReading(facts: BusFacts): string {
  return facts.slots.length === 0 ? 'none in use' : facts.slots.map(slot => `${slot.queue} ${slot.used}`).join(', ')
}

function servicesMeta(page: BoardPage): string {
  const { facts, limits } = page
  const warn = limits.warnRatio === null ? 'eddies: no warn line' : `eddies: warn line <b>${percent(limits.warnRatio)}</b>`
  return [
    `<span class="meta">quickhacks on the subnet · agents at work <b>${facts.services.length}</b> · slots <b>${escaped(slotsReading(facts))}</b> (bus records no capacity)</span>`,
    `<span class="meta right edd-note">${warn}</span>`,
  ].join('')
}

function servicesPanel(page: BoardPage): string {
  const { facts } = page
  const tiles = facts.services.length === 0 ? [lineTile('window', PLAIN_LORE.boardNoServices)] : facts.services.map(service => serviceTile(service, page))
  return [
    '<section class="panel" aria-labelledby="h-services">',
    `<div class="panel-head"><h2 id="h-services">${PLAIN_LORE.boardTabServices}</h2>${servicesMeta(page)}</div>`,
    '<div class="svc-grid">',
    ...tiles,
    ...pulseLines(facts, PLAIN_LORE).map(line => lineTile('bus', line)),
    ...matrixLines(facts, PLAIN_LORE).map(line => lineTile('matrix', line)),
    '</div></section>',
  ].join('\n')
}

function failureSpan(facts: BusFacts): string {
  return `<span class="fail"${facts.failure === null ? ' data-none' : ''}>last failure <b>${escaped(facts.failure ?? 'none')}</b></span>`
}

function flowPanel(facts: BusFacts): string {
  const live = facts.cards.filter(isLive)
  const stages = PLAIN_LORE.boardFlowColumns.map((title, column) => {
    const ids = live.filter(card => FLOW_STATES[column]!.includes(card.state ?? '')).map(card => `#${card.id}`)
    return `<div class="stage"${ids.length === 0 ? ' data-empty' : ''}><span class="n">${ids.length}</span><span class="name">${escaped(title)}</span><span class="ids">${ids.length === 0 ? NONE : ids.join(' · ')}</span></div>`
  })
  return [
    '<section class="panel" aria-labelledby="h-flow">',
    `<div class="panel-head"><h2 id="h-flow">${PLAIN_LORE.boardTabFlow}</h2></div>`,
    '<div class="flow">',
    ...goalLines(facts, PLAIN_LORE).map(line => `<p class="goal">${escaped(line)}</p>`),
    ...stages,
    `<div class="flow-note"><span>review queue <b>${facts.reviewQueue}</b></span>${failureSpan(facts)}</div>`,
    '</div></section>',
  ].join('\n')
}

function relation(parts: string[], name: string): string {
  return parts.find(part => part.startsWith(`${name} `))?.slice(name.length + 1).trim() || NONE
}

function cardFields(card: BusCard): string[] {
  const parts = (card.line ?? '').replace(CARD_PREFIX, '').split(' · ')
  const words = parts[0]!.split(' ').filter(word => !word.startsWith('#') && word !== '')
  const tagWord = words.find(word => word.startsWith('['))
  const tags = (tagWord ?? '').replace(/^\[|\]$/g, '').split('/')
  const fields = Array.from({ length: FIELD_COUNT }, (_, at) => tags[at] || NONE)
  return [words.find(word => word !== tagWord) ?? NONE, ...fields, relation(parts, 'depends'), relation(parts, 'blocks')]
}

function stateOf(card: BusCard): string {
  return card.state ?? NONE
}

function cardRow(card: BusCard): string {
  const cells = cardFields(card).map((field, at) => `<td${at === 0 ? ' class="slug"' : ''}>${escaped(field)}</td>`).join('')
  const state = escaped(stateOf(card))
  return `<tr data-card="${card.id}" data-state="${state}"${isLive(card) ? ' data-live' : ''}><td class="id">#${card.id}</td>${cells}<td><span class="st" data-state="${state}">${state}</span></td></tr>`
}

function lanesOf(cards: BusCard[]): (string | null)[] {
  const named = [...new Set(cards.flatMap(card => card.lane === null ? [] : [card.lane]))].sort()
  return cards.some(card => card.lane === null) ? [...named, null] : named
}

function laneBody(lane: string | null, cards: BusCard[]): string {
  const inLane = cards.filter(card => card.lane === lane)
  return `<tbody><tr class="lane"><th colspan="11" scope="rowgroup">${escaped(PLAIN_LORE.boardLaneLine(lane ?? undefined, inLane.length))}</th></tr>${inLane.map(cardRow).join('')}</tbody>`
}

function statesOf(cards: BusCard[]): string[] {
  const present = [...new Set(cards.map(stateOf))]
  const rank = (state: string): number => STATE_ORDER.includes(state) ? STATE_ORDER.indexOf(state) : STATE_ORDER.length
  return present.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
}

function filterId(filter: string): string {
  return `show-${filter.replace(/\W/g, '_')}`
}

export function filterRule(filter: string): string {
  const id = filterId(filter)
  const shown = filter === LIVE_FILTER ? '[data-live]' : `[data-state="${filter.replace(/["\\<>]/g, '')}"]`
  return `.backlog:has(#${id}:target) { & tr[data-card]:not(${shown}), & tbody:not(:has(tr${shown})) { display: none; } & .chip[href="#${id}"] { --_bg: var(--wire); --_fg: var(--void); --_bd: var(--wire); } }`
}

const COLUMNS = ['card', 'slug', 'kind', 'contour', 'size', 'path', 'gate', 'depends', 'blocks', 'state']

function backlogPanel(facts: BusFacts): string {
  const cards = backlogCards(facts.cards, facts.at, true)
  const filters = [LIVE_FILTER, ...statesOf(cards)]
  const chip = (filter: string): string => `<a class="chip" href="#${filterId(filter)}">${escaped(filter)}</a>`
  return [
    '<section class="panel backlog" aria-labelledby="h-backlog">',
    ...[ALL_FILTER, ...filters].map(filter => `<span class="filter-target" id="${filterId(filter)}"></span>`),
    `<style>${filters.map(filterRule).join('\n')}</style>`,
    `<div class="panel-head"><h2 id="h-backlog">${PLAIN_LORE.boardTabBacklog}</h2><span class="meta">${cards.length} cards · grouped by lane</span></div>`,
    `<nav class="filters" aria-label="Filter by state">${chip(ALL_FILTER)}${filters.map(chip).join('')}</nav>`,
    '<div class="scroll"><table>',
    `<thead><tr>${COLUMNS.map(column => `<th scope="col">${column}</th>`).join('')}</tr></thead>`,
    ...lanesOf(cards).map(lane => laneBody(lane, cards)),
    '</table></div></section>',
  ].join('\n')
}

function headerPanel(page: BoardPage): string {
  return [
    '<header class="panel">',
    `<div class="banner-wrap"><pre class="banner" aria-label="MIKOSHI">${escaped(BANNER.replace(/^\n/, ''))}</pre>`,
    `<p class="subtitle">${escaped(LORE.subtitle(page.version))}</p></div>`,
    `<div class="head-side"><p class="board-title">construct <span>board</span></p>${headerReadings(page)}</div>`,
    '</header>',
  ].join('\n')
}

function headerReadings(page: BoardPage): string {
  const { facts } = page
  const readings = [
    `<span>model <b>${page.modelVersion === null ? NONE : `v${page.modelVersion}`}</b></span>`,
    `<span>written <b>${escaped(facts.at)}</b></span>`,
    `<span>refresh <b>${REFRESH_SECONDS}s</b></span>`,
    `<span class="live"${liveAttribute(facts)}>${busFresh(facts) ? 'bus live' : 'bus stale'}</span>`,
  ]
  return `<p class="kv">${readings.join('')}</p>`
}

function pulseReading(facts: BusFacts): string {
  const age = pulseAgeMs(facts)
  return age === null ? 'no pulse' : `pulse ${Math.round(age / MINUTE_MS)} min`
}

function statusLine(facts: BusFacts): string {
  const parts = [
    '<span class="mode">BOARD</span>',
    `<span>subnet <b class="live"${liveAttribute(facts)}>${pulseReading(facts)}</b></span>`,
    `<span>agents <b>${facts.services.length}</b></span>`,
    `<span>review queue <b>${facts.reviewQueue}</b></span>`,
    failureSpan(facts),
    '<span>geek mode <b>--geek</b></span>',
    '<span class="cursor">construct board</span>',
  ]
  return `<footer class="statusline">${parts.join('')}</footer>`
}

const STYLE = `
:root {
  color-scheme: dark;
  --void: #07080d;
  --panel: #0d1018;
  --panel-raised: #11151f;
  --line: #232a3a;
  --text: #c9d1e4;
  --dim: #6d7891;
  --signal: #ff3b5c;
  --signal-soft: oklch(from var(--signal) l c h / 0.14);
  --wire: #2de2e6;
  --wire-soft: oklch(from var(--wire) l c h / 0.1);
  --amber: #f5c542;
  --ok: #5fe08a;
  --off: #545d72;
  --font-display: "Eurostile", "Bank Gothic", ui-sans-serif, sans-serif;
  --font-mono: ui-monospace, "SF Mono", Menlo, monospace;
  --space-xs: 0.25rem;
  --space-s: 0.5rem;
  --space-m: 0.875rem;
  --space-l: 1.25rem;
  --cut: 0.875rem;
  --head-block-size: 1.875rem;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: var(--space-l) var(--space-l) 1.5rem;
  display: grid;
  gap: var(--space-m);
  container-type: inline-size;
  background-color: var(--void);
  background-image: linear-gradient(var(--line) 1px, transparent 1px), linear-gradient(90deg, var(--line) 1px, transparent 1px);
  background-size: 3rem 3rem;
  color: var(--text);
  font: 0.8125rem/1.5 var(--font-mono);
  font-variant-numeric: tabular-nums;
  &::after { content: ""; position: fixed; inset: 0; pointer-events: none; background: repeating-linear-gradient(0deg, #ffffff06 0 1px, transparent 1px 3px); }
}
p { margin: 0; }
.panel {
  min-inline-size: 0;
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border: 1px solid var(--line);
  clip-path: polygon(0 0, calc(100% - var(--cut)) 0, 100% var(--cut), 100% 100%, var(--cut) 100%, 0 calc(100% - var(--cut)));
}
.panel-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-m);
  padding: var(--space-s) var(--space-m);
  border-block-end: 1px solid var(--line);
  background: linear-gradient(90deg, var(--signal-soft), transparent 60%);
  & h2 { margin: 0; font: 700 0.9375rem/1 var(--font-display); letter-spacing: 0.18em; text-transform: uppercase; color: var(--signal); }
  & h2::before { content: "\\258C"; color: var(--wire); margin-inline-end: 0.4em; }
  & .meta { color: var(--dim); font-size: 0.6875rem; letter-spacing: 0.06em; text-transform: uppercase; }
  & .right { margin-inline-start: auto; }
}
header.panel {
  --cut: 1.375rem;
  flex-flow: row wrap;
  justify-content: space-between;
  align-items: end;
  gap: var(--space-s) 1.75rem;
  padding: var(--space-l) var(--space-l) var(--space-m);
  border-color: var(--signal);
  background: radial-gradient(120% 140% at 0% 0%, var(--signal-soft), transparent 55%), var(--panel);
}
.banner-wrap { overflow-x: auto; min-inline-size: 0; }
.banner {
  margin: 0;
  color: var(--signal);
  font: 700 0.65rem/1.05 var(--font-mono);
  text-shadow: -1.5px 0 var(--wire), 1.5px 0 oklch(from var(--signal) l c h / 0.4), 0 0 18px oklch(from var(--signal) l c h / 0.33);
  animation: --animation-board-banner-flicker 7s steps(1) infinite;
}
.subtitle { margin-block-start: var(--space-s); color: var(--wire); font-size: 0.75rem; letter-spacing: 0.08em; }
.head-side { display: grid; gap: var(--space-xs); justify-items: end; text-align: end; }
.board-title {
  font: 700 clamp(1.25rem, 3.2cqi, 2.125rem)/1 var(--font-display);
  letter-spacing: 0.22em;
  text-transform: uppercase;
  & span { color: var(--signal); }
}
.kv { display: flex; flex-wrap: wrap; justify-content: end; gap: 0.375rem var(--space-m); color: var(--dim); font-size: 0.6875rem; text-transform: uppercase; letter-spacing: 0.06em; }
:where(.kv, .meta, .flow-note, .statusline) b { color: var(--text); font-weight: 600; }
.live {
  --_fg: var(--ok);
  --_blink: --animation-blink 1.6s steps(1) infinite;
  color: var(--_fg);
  &::before { content: "\\25CF"; margin-inline-end: 0.25rem; animation: var(--_blink); }
  &[data-stale] { --_fg: var(--signal); --_blink: none; }
}
.fail {
  --_fg: var(--signal);
  color: var(--_fg);
  & b { color: var(--_fg); }
  &[data-none] { --_fg: var(--dim); }
}
.svc-grid { display: grid; gap: 1px; background: var(--line); grid-template-columns: repeat(auto-fill, minmax(min(100%, 15rem), 1fr)); }
.svc {
  --_accent: var(--wire);
  display: grid;
  gap: var(--space-xs);
  padding: 0.625rem var(--space-m);
  background: var(--panel);
  border-inline-start: 3px solid var(--_accent);
  &[data-role="window"] { --_accent: var(--signal); }
  &[data-role="bus"] { --_accent: var(--ok); }
  &:has([data-hot]) { --_accent: var(--amber); }
}
.svc-top { display: flex; gap: var(--space-s); align-items: baseline; }
.svc-kind { font: 700 0.8125rem var(--font-display); letter-spacing: 0.16em; text-transform: uppercase; }
.svc-target { margin-inline-start: auto; color: var(--wire); }
.svc-line { color: var(--dim); font-size: 0.72rem; overflow-wrap: anywhere; }
.lore { color: var(--amber); font: 700 0.75rem var(--font-display); letter-spacing: 0.1em; text-transform: uppercase; }
.edd {
  --_bar: var(--wire);
  --_value: var(--text);
  display: grid;
  grid-template-columns: 3.25rem 1fr 5rem;
  gap: var(--space-s);
  align-items: center;
  color: var(--dim);
  font-size: 0.65rem;
  &[data-hot] { --_bar: var(--amber); --_value: var(--amber); }
}
.edd-k { text-transform: uppercase; letter-spacing: 0.08em; }
.edd-v { text-align: end; color: var(--_value); }
.edd-bar {
  block-size: 0.375rem;
  position: relative;
  background: var(--line);
  &::before { content: ""; position: absolute; inset: 0 auto 0 0; inline-size: var(--_fill, 0%); background: var(--_bar); }
  &::after { content: ""; position: absolute; inset-block: -2px; inset-inline-start: var(--_warn, 100%); inline-size: 1px; background: var(--amber); }
}
.split { display: grid; gap: var(--space-m); align-items: start; grid-template-columns: minmax(14rem, 18rem) minmax(0, 1fr); }
@container (inline-size <= 52rem) { .split { grid-template-columns: minmax(0, 1fr); } }
.flow { padding: var(--space-xs) 0 0.625rem; }
.goal { padding: var(--space-s) var(--space-m) 0; color: var(--ok); font: 700 0.75rem var(--font-display); letter-spacing: 0.1em; text-transform: uppercase; }
.stage {
  --_n-bg: var(--wire);
  --_n-fg: var(--void);
  --_ids: var(--wire);
  display: grid;
  grid-template-columns: 2.125rem 1fr;
  gap: 0 0.625rem;
  align-items: center;
  padding: 0.625rem var(--space-m);
  &[data-empty] { --_n-bg: var(--line); --_n-fg: var(--dim); --_ids: var(--off); }
  & .n { inline-size: 2.125rem; block-size: 2.125rem; display: grid; place-items: center; font: 700 1rem var(--font-display); color: var(--_n-fg); background: var(--_n-bg); clip-path: polygon(0 0, 100% 0, 100% 70%, 70% 100%, 0 100%); }
  & .name { font: 700 0.75rem var(--font-display); letter-spacing: 0.16em; text-transform: uppercase; }
  & .ids { grid-column: 2; color: var(--_ids); font-size: 0.75rem; overflow-wrap: anywhere; }
}
.flow-note { margin: var(--space-xs) var(--space-m) 0; padding-block-start: 0.625rem; border-block-start: 1px solid var(--line); color: var(--dim); font-size: 0.6875rem; display: grid; gap: var(--space-xs); }
.backlog { position: relative; block-size: calc(100dvh - 2rem); min-block-size: 26rem; }
.filter-target { position: absolute; inset-block-start: 0; }
.filters { display: flex; flex-wrap: wrap; gap: 0.375rem; padding: var(--space-s) var(--space-m); border-block-end: 1px solid var(--line); }
.chip {
  --_bg: transparent;
  --_fg: var(--dim);
  --_bd: var(--line);
  padding: 0.2rem 0.6rem;
  background: var(--_bg);
  color: var(--_fg);
  border: 1px solid var(--_bd);
  font: 600 0.6875rem var(--font-mono);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  text-decoration: none;
  clip-path: polygon(0.375rem 0, 100% 0, calc(100% - 0.375rem) 100%, 0 100%);
  &:hover { --_fg: var(--text); --_bd: var(--dim); }
  &:focus-visible { outline: 2px solid var(--amber); outline-offset: 2px; }
}
.backlog:not(:has(.filter-target:target)) .chip[href="#show-all"] { --_bg: var(--wire); --_fg: var(--void); --_bd: var(--wire); }
.scroll { flex: 1; min-block-size: 0; overflow: auto; scrollbar-color: var(--signal) var(--panel); }
table { inline-size: 100%; min-inline-size: 54rem; border-collapse: collapse; }
thead th {
  position: sticky;
  inset-block-start: 0;
  z-index: 2;
  block-size: var(--head-block-size);
  padding: 0 0.625rem;
  background: var(--panel-raised);
  color: var(--dim);
  border-block-end: 1px solid var(--signal);
  font: 600 0.65rem var(--font-mono);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  text-align: start;
  white-space: nowrap;
}
tr.lane th {
  position: sticky;
  inset-block-start: var(--head-block-size);
  z-index: 1;
  padding: 0.375rem 0.625rem;
  background: var(--void);
  color: var(--amber);
  border-block-end: 1px solid var(--line);
  font: 700 0.6875rem var(--font-display);
  letter-spacing: 0.18em;
  text-transform: uppercase;
  text-align: start;
}
tr[data-card] {
  & td { padding: 0.3rem 0.625rem; border-block-end: 1px solid var(--panel-raised); white-space: nowrap; color: var(--dim); }
  &:hover td { background: var(--wire-soft); }
  &[data-state="dropped"] td, &[data-state="closed"] td { opacity: 0.55; }
  &[data-state="running"] td:first-child { box-shadow: inset 3px 0 var(--amber); }
}
td.id { color: var(--wire); font-weight: 600; }
td.slug { color: var(--text); white-space: normal; min-inline-size: 16rem; }
.st {
  --_fg: var(--dim);
  --_bg: transparent;
  display: inline-block;
  min-inline-size: 6.5rem;
  padding: 0.05rem 0.5rem;
  background: var(--_bg);
  color: var(--_fg);
  border: 1px solid var(--_fg);
  font: 700 0.65rem var(--font-mono);
  letter-spacing: 0.1em;
  text-align: center;
  text-transform: uppercase;
  &[data-state="merged"] { --_fg: var(--ok); }
  &[data-state="queued"], &[data-state="in_review"], &[data-state="ready"] { --_fg: var(--wire); }
  &[data-state="running"], &[data-state="changes"] { --_fg: var(--amber); }
  &[data-state="stopped"] { --_fg: var(--signal); }
  &[data-state="dropped"], &[data-state="closed"] { --_fg: var(--off); }
}
.statusline {
  display: flex;
  flex-wrap: wrap;
  border: 1px solid var(--line);
  background: var(--panel);
  font-size: 0.72rem;
  & > span { padding: 0.3rem 0.75rem; border-inline-end: 1px solid var(--line); color: var(--dim); }
  & .mode { background: var(--signal); color: var(--void); font-weight: 700; letter-spacing: 0.12em; }
  & .cursor::after { content: "\\2588"; color: var(--wire); margin-inline-start: 0.3em; animation: --animation-blink 1s steps(1) infinite; }
}
@keyframes --animation-board-banner-flicker { 0%, 96%, 100% { transform: none; } 97% { transform: translateX(2px); } 98% { transform: translateX(-1px); } }
@keyframes --animation-blink { 50% { opacity: 0.2; } }
@media (prefers-reduced-motion: reduce) {
  .banner, .live::before, .statusline .cursor::after { animation: none; }
}
`

export function renderBoard(page: BoardPage): string {
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="refresh" content="${REFRESH_SECONDS}">`,
    `<title>construct board · ${escaped(page.facts.at)}</title>`,
    `<style>${STYLE}</style></head><body>`,
    headerPanel(page),
    servicesPanel(page),
    '<div class="split">',
    flowPanel(page.facts),
    backlogPanel(page.facts),
    '</div>',
    statusLine(page.facts),
    '</body></html>',
    '',
  ].join('\n')
}

function pageOf(db: DatabaseSync, now: Date): string {
  return renderBoard({ version: VERSION, modelVersion: readModelVersion(), facts: busFacts(db, now), gauges: projectedGauges(db), windowGauges: projectedWindowGauges(db), limits: readEddiesLimits() })
}

export function writeBoardPage(file: string, html: string, files: BoardFiles = DISK_FILES): void {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`)
  files.write(temporary, html)
  files.rename(temporary, file)
}

export function printBoard(busPath: string, now: Date, write: (text: string) => void): number {
  const db = openDatabase(busPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS })
  try {
    write(pageOf(db, now))
    return 0
  }
  finally {
    db.close()
  }
}

export function runBoardCli(busPath: string = defaultBusPath()): number {
  if (!existsSync(busPath)) {
    console.error(`${PREFIX}no bus database at ${busPath}`)
    return 1
  }
  return printBoard(busPath, new Date(), text => process.stdout.write(text))
}

export interface BoardProjection {
  file: string
  project: (now: Date) => void
}

export function boardProjection(db: DatabaseSync, busPath: string): BoardProjection {
  const file = path.join(path.dirname(busPath), BOARD_FILE)
  return {
    file,
    project: (now) => {
      try {
        writeBoardPage(file, pageOf(db, now))
      }
      catch (error) {
        console.error(`${PREFIX}${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
      }
    },
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = runBoardCli()
