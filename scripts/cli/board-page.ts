import type { DatabaseSync } from 'node:sqlite'
import type { BusCard, BusFacts, BusMatrix, BusService, CardsAtStage, CardStage, OwnerWait } from '../../src/commands/board/bus.js'
import type { ItemStage, PlanProgress } from '../../src/commands/board/goal.js'
import type { CardFields } from '../intake/card-contract.js'
import type { InForceDecision } from '../policy/decisions.js'
import type { CardChain } from './card-chain.js'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { busFacts, CARD_STAGES, latestCardEvents, openTasks } from '../../src/commands/board/bus.js'
import { planLine } from '../../src/commands/board/goal.js'
import { backlogCards, isLive, laneColumns, matrixLines, pulseLines, slotsReading, waitAction, waitTarget } from '../../src/commands/board/screens.js'
import { BANNER, LORE, PLAIN_LORE } from '../../src/ui/lore.js'
import { VERSION } from '../../src/version.js'
import { BUSY_TIMEOUT_MS, defaultBusPath } from '../core/db.js'
import { defaultHandoffDir } from '../core/handoff-dir.js'
import { openDatabase } from '../core/sqlite.js'
import { cardContract } from '../intake/card-contract.js'
import { inForceDecisions } from '../policy/decisions.js'
import { BOARD_FILE, cardGauges, FRESH_MS, windowGauges } from '../window/board.js'
import { mikoHandoff } from '../window/loop.js'
import { cardChain } from './card-chain.js'

export const PREFIX = '[bus:board] '
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const EDDIES_FILE = path.join(REPOSITORY_ROOT, '.claude/eddies.json')
export const MODEL_FILE = path.join(REPOSITORY_ROOT, 'construct.model.json')
export const PACKAGE_FILE = path.join(REPOSITORY_ROOT, 'package.json')
export const HANDOFF_FILE = mikoHandoff(defaultHandoffDir())

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

export interface CardDetail {
  contract: CardFields | null
  chain: CardChain | null
  pr: number | null
}

export interface Handoff {
  file: string
  text: string | null
}

export interface BoardPage {
  version: string
  modelVersion: number | null
  facts: BusFacts
  gauges: Map<string, Gauges>
  windowGauges: Gauges | null
  limits: EddiesLimits
  details: Map<number, CardDetail>
  decisions: InForceDecision[]
  handoff: Handoff
  repository: string | null
  tickMs: number | null
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
const THOUSAND = 1_000
const MILLION = 1_000_000
const MINUTE_MS = 60_000
export const BOARD_DATA_FILE = 'board-data.js'
const BOARD_DATA_PREFIX = 'window.BOARD = '
const JSON_FLAG = '--json'
const EVENTS_PER_CARD = 5
const STALE_TICKS = 2
const OWNER_STATUS = 'OWNER'
export const SLOT_PREFIX = 'slot-'
const BUS_LIVE = 'bus-live'
const PULSE_ELEMENT_ID = 'bus-pulse'
const STALE_READING = 'bus stale'
const TITLE_PREFIX = 'construct board · '
const BACKLOG = 'backlog'
const DRILL = 'drill'
const DRILL_CONTENT = 'drill-content'
const BACKLOG_SCROLL = 'backlog-scroll'
const DIALOG_PREFIX = 'dialog-'
const HANDOFF_DIALOG = 'handoff'
const DECISIONS_DIALOG = 'decisions'
const HANDOFF_STATUS = 'STATUS'
const OPEN_HINT = '<span class="open-hint">open ›</span>'
const CARD_TASK = /^#(\d+)$/
const CARD_REFERENCE = /(?<!&|PR )#(\d+)\b/g
export const FLOW_META = 'live and recently ended cards by stage'
const CODE_SPAN = /`([^`]+)`/g
const HANDOFF_LINE = /^([^\s#:*-][^:]*):(?: (.*))?$/
const LIST_ITEM = /^\s*[-*]\s+/
const PUNCH_DIGITS = 16
const SETTLED_STAGES: readonly CardStage[] = ['merged', 'dropped']
export const PROGRESS_ORDER: readonly CardStage[] = ['merged', 'ready', 'answer/changes', 'review', 'in work', 'planned', 'stopped', 'dropped']
export const ITEM_PROGRESS_ORDER: readonly ItemStage[] = ['delivered', 'review', 'in_progress', 'queued', 'not_created']
const WAIT_NEEDS: Record<OwnerWait['need'], string> = { decision: 'D', merge: 'M', command: 'C' }

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

export function readRepositoryUrl(file: string = PACKAGE_FILE): string | null {
  try {
    const url = (JSON.parse(readFileSync(file, 'utf8')) as { repository?: { url?: unknown } } | null)?.repository?.url
    return typeof url === 'string' ? url.replace(/^git\+/, '').replace(/\.git$/, '') : null
  }
  catch {
    return null
  }
}

export function readHandoff(file: string = HANDOFF_FILE): Handoff {
  try {
    return { file, text: readFileSync(file, 'utf8') }
  }
  catch {
    return { file, text: null }
  }
}

function cardPrs(db: DatabaseSync): Map<number, number> {
  const rows = db.prepare('SELECT card_id, pr FROM cards WHERE pr IS NOT NULL').all() as { card_id: number, pr: number }[]
  return new Map(rows.map(row => [Number(row.card_id), Number(row.pr)]))
}

function cardDetails(db: DatabaseSync, facts: BusFacts): Map<number, CardDetail> {
  const prs = cardPrs(db)
  return new Map(facts.cards.map(card => [card.id, { contract: cardContract(db, card.id), chain: cardChain(db, card.id), pr: prs.get(card.id) ?? null }]))
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
  const over = limit !== null && value > limit
  const hot = !over && limit !== null && warnRatio !== null && value >= limit * warnRatio
  const bar = limit === null ? '<span></span>' : `<span class="edd-bar" style="--_fill: ${percent(value / limit)}${warnRatio === null ? '' : `; --_warn: ${percent(warnRatio)}`}"></span>`
  return `<div class="edd"${over ? ' data-over' : hot ? ' data-hot' : ''}><span class="edd-k">${name}</span>${bar}<span class="edd-v">${reading}</span></div>`
}

function gaugesOf(service: BusService, page: BoardPage): Gauges | null | undefined {
  if (service.role === WINDOW_ROLE)
    return page.windowGauges
  return SESSION_STEP.test(service.step) ? page.gauges.get(service.task) : undefined
}

function tileDialog(service: BusService, page: BoardPage): string | null {
  if (service.role === WINDOW_ROLE)
    return HANDOFF_DIALOG
  const card = CARD_TASK.exec(service.task)?.[1]
  return card !== undefined && page.details.has(Number(card)) ? cardDialog(Number(card)) : null
}

function serviceTile(service: BusService, page: BoardPage): string {
  const gauges = gaugesOf(service, page)
  const bars = gauges == null
    ? ''
    : eddiesBar('ctx', gauges.context, page.limits.contextLimit, page.limits.warnRatio) + eddiesBar('spent', gauges.spent, page.limits.sessionSpend, page.limits.warnRatio)
  const dialog = tileDialog(service, page)
  return [
    `<div class="svc" data-role="${escaped(service.role)}"${dialog === null ? '' : `${opener(dialog)} role="button"`}>`,
    `<div class="svc-top"><span class="svc-kind">${escaped(service.role)}</span><span class="lore">${LORE_NAMES[service.role] ?? RUNNER}</span><span class="svc-target">${escaped(service.task)}</span>${dialog === null ? '' : OPEN_HINT}</div>`,
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

function servicesMeta(page: BoardPage): string {
  const { facts, limits } = page
  const warn = limits.warnRatio === null ? 'eddies: no warn line' : `eddies: warn line <b>${percent(limits.warnRatio)}</b>`
  return [
    `<span class="meta">quickhacks on the subnet · agents at work <b>${facts.services.length}</b> · slots <b>${escaped(slotsReading(facts))}</b></span>`,
    `<span class="meta right edd-note">${warn}</span>`,
  ].join('')
}

function servicesSlot(page: BoardPage): string {
  const { facts } = page
  const tiles = facts.services.length === 0 ? [lineTile('window', PLAIN_LORE.boardNoServices)] : facts.services.map(service => serviceTile(service, page))
  return [
    `<div class="panel-head"><h2 id="h-services">${PLAIN_LORE.boardTabServices}</h2>${servicesMeta(page)}</div>`,
    '<div class="svc-grid">',
    ...tiles,
    ...pulseLines(facts, PLAIN_LORE).map(line => lineTile('bus', line)),
    ...matrixLines(facts, PLAIN_LORE).map(line => lineTile('matrix', line)),
    '</div>',
  ].join('\n')
}

function failureSpan(facts: BusFacts): string {
  return `<span class="fail"${facts.failure === null ? ' data-none' : ''}>last failure <b>${escaped(facts.failure ?? 'none')}</b></span>`
}

function shownStages(facts: BusFacts): CardsAtStage[] {
  const shown = backlogCards(facts.cards, facts.at, false)
  return CARD_STAGES.map(stage => ({ stage, cards: shown.filter(card => card.stage === stage).map(card => card.id) }))
}

function inProgressOrder(stages: CardsAtStage[]): CardsAtStage[] {
  return PROGRESS_ORDER.flatMap(stage => stages.filter(entry => entry.stage === stage))
}

function flowStages(facts: BusFacts): CardsAtStage[] {
  return inProgressOrder(shownStages(facts))
}

function swatch(stage: CardStage | ItemStage, count?: number): string {
  return `<i class="sw" data-stage="${escaped(stage)}"${count === undefined ? '' : ` style="--_n: ${count}" title="${escaped(stage)}: ${count}"`}></i>`
}

function legendRow(entry: CardsAtStage, page: BoardPage): string {
  const ids = SETTLED_STAGES.includes(entry.stage) || entry.cards.length === 0 ? '' : `<span class="ids">${entry.cards.map(card => cardReference(card, page)).join('')}</span>`
  return `<div class="stage"${entry.cards.length === 0 ? ' data-empty' : ''}>${swatch(entry.stage)}<span class="name">${escaped(entry.stage)}</span><span class="n">${entry.cards.length}</span>${ids}</div>`
}

function planBlock(plan: PlanProgress, backlog: number): string {
  return [
    `<div class="goal-top"><span class="goal-k">plan</span><span class="goal-name">${escaped(planLine(plan, backlog))}</span></div>`,
    `<div class="bar" role="img" aria-label="Plan slices by stage">${ITEM_PROGRESS_ORDER.filter(stage => plan.stages[stage] > 0).map(stage => swatch(stage, plan.stages[stage])).join('')}</div>`,
  ].join('')
}

function goalSlot(facts: BusFacts): string {
  const { goal } = facts
  return goal === null ? '' : goal.plans.map(plan => planBlock(plan, goal.backlog)).join('')
}

function waitText(wait: OwnerWait): string {
  const target = waitTarget(wait)
  return `${wait.id}${target === null ? '' : ` ${target}`} — ${waitAction(wait)}`
}

function waitItem(wait: OwnerWait, page: BoardPage): string {
  const inner = `<span class="kind">${WAIT_NEEDS[wait.need]}</span><span class="what">${escaped(waitText(wait))}</span>`
  return wait.card !== null && page.details.has(wait.card)
    ? `<button type="button" class="ask"${opener(cardDialog(wait.card))}>${inner}${OPEN_HINT}</button>`
    : `<span class="ask" data-static>${inner}</span>`
}

function waitsSlot(page: BoardPage): string {
  const { waits } = page.facts
  return waits.length === 0 ? '' : `<section class="owner-strip" aria-label="Waits for you"><span class="lbl">waits for you</span>${waits.map(wait => waitItem(wait, page)).join('')}</section>`
}

function flowSlot(page: BoardPage): string {
  const { facts } = page
  return [
    `<div class="panel-head"><h2 id="h-flow">${PLAIN_LORE.boardTabFlow}</h2><span class="meta">${FLOW_META}</span></div>`,
    '<div class="flow">',
    ...flowStages(facts).map(entry => legendRow(entry, page)),
    `<div class="flow-note"><span>review queue <b>${facts.reviewQueue}</b></span>${failureSpan(facts)}</div>`,
    '</div>',
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

function cardRow(card: BusCard): string {
  const cells = cardFields(card).map((field, at) => `<td${at === 0 ? ' class="slug"' : ''}>${escaped(field)}</td>`).join('')
  const stage = escaped(card.stage)
  return `<tr data-card="${card.id}" data-stage="${stage}"${isLive(card) ? ' data-live' : ''}${opener(cardDialog(card.id))}><td class="id">#${card.id}</td>${cells}<td><span class="st" data-stage="${stage}">${stage}</span></td><td>${OPEN_HINT}</td></tr>`
}

function laneBody(lane: string | null, cards: BusCard[]): string {
  const inLane = cards.filter(card => card.lane === lane)
  return `<tbody><tr class="lane"><th colspan="11" scope="rowgroup">${escaped(PLAIN_LORE.boardLaneLine(lane ?? undefined, inLane.length))}</th></tr>${inLane.map(cardRow).join('')}</tbody>`
}

function stagesOf(cards: BusCard[]): string[] {
  const present = new Set(cards.map(card => card.stage))
  return CARD_STAGES.filter(stage => present.has(stage))
}

function filterId(filter: string): string {
  return `show-${filter.replace(/\W/g, '_')}`
}

export function filterRule(filter: string): string {
  const id = filterId(filter)
  const shown = filter === LIVE_FILTER ? '[data-live]' : `[data-stage="${filter.replace(/["\\<>]/g, '')}"]`
  return `.backlog:has(#${id}:target) { & tr[data-card]:not(${shown}), & tbody:not(:has(tr${shown})) { display: none; } & .chip[href="#${id}"] { --_bg: var(--wire); --_fg: var(--void); --_bd: var(--wire); } }`
}

const COLUMNS = ['card', 'slug', 'kind', 'contour', 'size', 'path', 'gate', 'depends', 'blocks', 'state', '']

function backlogFilters(facts: BusFacts): string[] {
  return [LIVE_FILTER, ...stagesOf(backlogCards(facts.cards, facts.at, true))]
}

function filterTargetIds(facts: BusFacts): string[] {
  return [ALL_FILTER, ...backlogFilters(facts)].map(filterId)
}

function backlogSlot(facts: BusFacts): string {
  const cards = backlogCards(facts.cards, facts.at, true)
  const filters = backlogFilters(facts)
  const chip = (filter: string): string => `<a class="chip" href="#${filterId(filter)}">${escaped(filter)}</a>`
  return [
    `<style>${filters.map(filterRule).join('\n')}</style>`,
    `<div class="panel-head"><h2 id="h-backlog">${PLAIN_LORE.boardTabBacklog}</h2><span class="meta">${cards.length} cards · grouped by lane</span></div>`,
    `<nav class="filters" aria-label="Filter by stage">${chip(ALL_FILTER)}${filters.map(chip).join('')}</nav>`,
  ].join('\n')
}

function rowsSlot(facts: BusFacts): string {
  const cards = backlogCards(facts.cards, facts.at, true)
  return [
    `<thead><tr>${COLUMNS.map(column => `<th scope="col">${column}</th>`).join('')}</tr></thead>`,
    ...laneColumns(cards, facts.lanes).map(lane => laneBody(lane, cards)),
  ].join('\n')
}

function backlogPanel(facts: BusFacts, slots: BoardSlots): string {
  return [
    `<section class="panel backlog" id="${BACKLOG}" aria-labelledby="h-backlog">`,
    ...filterTargetIds(facts).map(id => `<span class="filter-target" id="${id}"></span>`),
    `<div id="${SLOT_PREFIX}backlog">${slots.backlog}</div>`,
    `<div class="scroll" id="${BACKLOG_SCROLL}"><table id="${SLOT_PREFIX}rows">`,
    slots.rows,
    '</table></div></section>',
  ].join('\n')
}

function headerPanel(page: BoardPage, slots: BoardSlots): string {
  return [
    '<header class="panel">',
    `<div class="banner-wrap"><pre class="banner" aria-label="MIKOSHI">${escaped(BANNER.replace(/^\n/, ''))}</pre>`,
    `<p class="subtitle">${escaped(LORE.subtitle(page.version))}</p></div>`,
    `<div class="head-side"><p class="board-title">construct <span>board</span></p><p class="kv" id="${SLOT_PREFIX}kv">${slots.kv}</p></div>`,
    `<div class="goal" id="${SLOT_PREFIX}goal">${slots.goal}</div>`,
    '</header>',
    `<div class="waits" id="${SLOT_PREFIX}waits">${slots.waits}</div>`,
  ].join('\n')
}

function headerReadings(page: BoardPage): string {
  const { facts } = page
  return [
    `<span>model <b>${page.modelVersion === null ? NONE : `v${page.modelVersion}`}</b></span>`,
    `<span>written <b>${escaped(facts.at)}</b></span>`,
    `<span>refresh <b>${page.tickMs === null ? NONE : `${page.tickMs / 1000}s`}</b></span>`,
    `<span class="live" id="${BUS_LIVE}"${liveAttribute(facts)}>${busFresh(facts) ? 'bus live' : STALE_READING}</span>`,
  ].join('')
}

function pulseReading(facts: BusFacts): string {
  const age = pulseAgeMs(facts)
  return age === null ? 'no pulse' : `pulse ${Math.round(age / MINUTE_MS)} min`
}

function statusSlot(facts: BusFacts): string {
  return [
    '<span class="mode">BOARD</span>',
    `<span>subnet <b class="live" id="${PULSE_ELEMENT_ID}"${liveAttribute(facts)}>${pulseReading(facts)}</b></span>`,
    `<span>agents <b>${facts.services.length}</b></span>`,
    `<span>review queue <b>${facts.reviewQueue}</b></span>`,
    failureSpan(facts),
    `<button type="button"${opener(HANDOFF_DIALOG)}><kbd>H</kbd> handoff ›</button>`,
    `<button type="button"${opener(DECISIONS_DIALOG)}><kbd>D</kbd> decisions ›</button>`,
    '<span>geek mode <b>--geek</b></span>',
    '<span class="cursor">construct board</span>',
  ].join('')
}

function opener(dialog: string): string {
  return ` data-open="${dialog}" tabindex="0" aria-haspopup="dialog"`
}

function cardDialog(card: number): string {
  return `card-${card}`
}

function cardReference(card: number, page: BoardPage): string {
  return page.details.has(card) ? `<button type="button" class="cid"${opener(cardDialog(card))}>#${card} ›</button>` : `#${card}`
}

function linked(text: string, page: BoardPage): string {
  return escaped(text).replace(CARD_REFERENCE, (_, card: string) => cardReference(Number(card), page)).replace(CODE_SPAN, '<code>$1</code>')
}

type PunchValue = string | number | null | undefined | readonly string[]

function punchField(label: string, value: PunchValue, page: BoardPage, wide = false): string {
  const empty = value === null || value === undefined || value === '' || value === NONE || (Array.isArray(value) && value.length === 0)
  const shown = empty ? NONE : Array.isArray(value) ? value.map(item => `<span class="tag">${linked(item, page)}</span>`).join(' ') : linked(String(value), page)
  return `<div class="pf"${wide ? ' data-wide' : ''}><span class="pf-k">${escaped(label)}</span><span class="pf-v"${empty ? ' data-none' : ''}>${shown}</span></div>`
}

function holes(sha: string): string {
  return [...sha.slice(0, PUNCH_DIGITS)].flatMap(digit => Number.parseInt(digit, 16).toString(2).padStart(4, '0').split('')).map(bit => `<i${bit === '1' ? ' data-on' : ''}></i>`).join('')
}

function punch(label: string, sha: string, fields: string[]): string {
  return `<div class="punch"><span class="punch-label">${escaped(label)}</span><div class="punch-holes" aria-hidden="true">${holes(sha)}</div><div class="punch-grid">${fields.join('')}</div></div>`
}

function divider(name: string): string {
  return `<div class="divider">${name}</div>`
}

function note(html: string): string {
  return `<p class="note">${html}</p>`
}

function paragraphs(text: string, page: BoardPage): string {
  return text.split(/\n\s*\n/).map(part => part.trim()).filter(part => part !== '').map(part => `<p>${linked(part, page)}</p>`).join('')
}

function listed(heading: string, items: readonly string[], page: BoardPage): string {
  return items.length === 0 ? '' : `<h3>${heading}</h3><ul>${items.map(item => `<li>${linked(item, page)}</li>`).join('')}</ul>`
}

function dialogHead(kind: string, id: string, name: string, state: string): string {
  return `<div class="drill-head"><span class="drill-kind">${kind}</span><span class="drill-id" id="drill-title">${escaped(id)}</span><span class="drill-name">${escaped(name)}</span>${state}<form method="dialog"><button class="drill-close" value="close">esc · close</button></form></div>`
}

function cardPunch(card: BusCard, detail: CardDetail, page: BoardPage): string {
  const [slug, kind, contour, size, cardPath, gate, depends, blocks] = cardFields(card)
  const contract = detail.contract
  const fields = [
    punchField('kind', kind, page),
    punchField('contour', contour, page),
    punchField('size', size, page),
    punchField('path', cardPath, page),
    punchField('gate', gate, page),
    punchField('milestone', contract?.milestone, page),
    punchField('decision', contract?.decision, page),
    punchField('who', contract?.who, page),
    punchField('priority', contract?.priority, page),
    punchField('risk', contract?.risk, page),
    punchField('lane', card.lane, page),
    punchField('continue', contract?.continue, page),
    punchField('depends', depends, page),
    punchField('blocks', blocks, page),
    punchField('branch', contract?.branch, page, true),
    punchField('card line', contract?.cardLine ?? card.line, page, true),
    punchField('touches', contract?.touches, page, true),
    punchField('creates', contract?.creates, page, true),
    punchField('seam', contract?.seam, page),
    punchField('slice', contract?.slice, page),
    punchField('text_sha', contract?.textSha, page),
    punchField('admission', contract?.admissionEventId, page),
    punchField('last heartbeat', contract?.lastHeartbeat?.ts, page),
  ]
  return punch(`card · ${slug === NONE ? `#${card.id}` : slug}`, contract?.textSha ?? card.id.toString(16).padStart(PUNCH_DIGITS, '0'), fields)
}

function cardProse(detail: CardDetail, page: BoardPage): string {
  const contract = detail.contract
  if (contract === null)
    return note('The bus holds no admitted card text for this card.')
  return `<div class="prose">${paragraphs(contract.prose, page)}${listed('Witnesses', contract.witnesses, page)}${listed('Unclear', contract.unclear, page)}</div>`
}

function matrixRows(rows: [string, string][]): string {
  return `<div class="mx-wrap"><table class="mx"><tbody>${rows.map(([key, value]) => `<tr><th scope="row">${escaped(key)}</th><td>${escaped(value)}</td></tr>`).join('')}</tbody></table></div>`
}

function pullLink(pr: number, page: BoardPage): string {
  return page.repository === null ? `PR #${pr}` : `<a data-link href="${escaped(`${page.repository}/pull/${pr}`)}">PR #${pr} ›</a>`
}

function cardMatrix(detail: CardDetail, page: BoardPage): string {
  if (detail.pr === null)
    return note('No pull request for this card in the bus yet.')
  const matrix: BusMatrix | undefined = page.facts.matrices.find(entry => entry.pr === detail.pr)
  if (matrix === undefined)
    return note(`The bus holds no check matrix for ${pullLink(detail.pr, page)}.`)
  const contract = detail.contract
  const check = matrixRows([['pull request', `PR #${matrix.pr}`], ['head', matrix.head ?? NONE], ['killed', String(matrix.killed)], ['survived', String(matrix.survived)], ['not run', String(matrix.notRun)], ['full run', matrix.full ?? NONE]])
  const risk = matrixRows([['risk', contract?.risk ?? NONE], ['seam', contract?.seam.join(', ') || NONE], ['slice', contract?.slice.join(', ') || NONE]])
  return `<div><p class="mx-title">check matrix · ${pullLink(matrix.pr, page)}</p>${check}</div><div><p class="mx-title">risk matrix</p>${risk}</div>`
}

function verdictText(verdict: unknown): string {
  return typeof verdict === 'string' ? verdict : JSON.stringify(verdict) ?? NONE
}

function chainEntries(chain: CardChain): [number, string][] {
  const entries: [number, string][] = chain.versions.map(event => [event, 'card text admitted'])
  if (chain.verdict !== null)
    entries.push([chain.verdict.event, `review recorded · ${verdictText(chain.verdict.verdict)}`])
  if (chain.proof !== null)
    entries.push([chain.proof, 'card verified'])
  return entries.sort((a, b) => a[0] - b[0])
}

function cardChainHtml(card: BusCard, detail: CardDetail): string {
  const command = `<code>pnpm card ${card.id} --chain</code>`
  if (detail.chain === null)
    return note(`No chain: the bus holds no admitted text for this card (${command}).`)
  const entries = chainEntries(detail.chain).map(([event, what]) => `<li><span class="when">event ${event}</span><span class="dot"></span><span class="ev">${escaped(what)}</span></li>`)
  const decisions = detail.chain.decisions.length === 0 ? '' : note(`decisions named: ${escaped(detail.chain.decisions.join(', '))}`)
  return `<ol class="chain">${entries.join('')}</ol>${decisions}${note(`the same fact as ${command}`)}`
}

function cardDialogHtml(card: BusCard, detail: CardDetail, page: BoardPage): string {
  const stage = escaped(card.stage)
  return [
    dialogHead('card', `#${card.id}`, cardFields(card)[0]!, `<span class="st" data-stage="${stage}">${stage}</span>`),
    '<div class="drill-body">',
    cardPunch(card, detail, page),
    divider('prose'),
    cardProse(detail, page),
    divider('matrix'),
    cardMatrix(detail, page),
    divider('chain'),
    cardChainHtml(card, detail),
    '</div>',
  ].join('')
}

interface HandoffParts {
  fields: [string, string[]][]
  prose: string[]
}

function handoffParts(text: string): HandoffParts {
  const parts: HandoffParts = { fields: [], prose: [] }
  let field: [string, string[]] | null = null
  for (const line of text.split(/\r?\n/)) {
    const labelled = HANDOFF_LINE.exec(line)
    if (labelled !== null) {
      field = [labelled[1]!, labelled[2] === undefined ? [] : [labelled[2]]]
      parts.fields.push(field)
    }
    else if (field !== null && LIST_ITEM.test(line)) {
      field[1].push(line.replace(LIST_ITEM, ''))
    }
    else if (line.trim() !== '') {
      field = null
      parts.prose.push(line.trim())
    }
  }
  return parts
}

function handoffDialogHtml(page: BoardPage): string {
  const name = path.basename(page.handoff.file)
  if (page.handoff.text === null)
    return `${dialogHead('handoff', LORE_NAMES.window!, name, '')}<div class="drill-body">${note(`No ${escaped(name)} to read.`)}</div>`
  const { fields, prose } = handoffParts(page.handoff.text)
  const status = fields.find(([label]) => label === HANDOFF_STATUS)?.[1][0]
  const punchFields = fields.map(([label, values]) => punchField(label, values.length === 1 ? values[0] : values, page, values.length > 1))
  return [
    dialogHead('handoff', LORE_NAMES.window!, name, status === undefined ? '' : `<span class="st">${escaped(status)}</span>`),
    '<div class="drill-body">',
    punch(`handoff · ${name}`, createHash('sha256').update(page.handoff.text).digest('hex'), punchFields),
    divider('prose'),
    prose.length === 0 ? note(`${escaped(name)} carries no prose.`) : `<div class="prose">${prose.map(line => `<p>${linked(line, page)}</p>`).join('')}</div>`,
    '</div>',
  ].join('')
}

function decisionsDialogHtml(page: BoardPage): string {
  const rows = page.decisions.map(decision => `<div><b>D-${decision.decisionId}</b><span>${linked(decision.text, page)}</span></div>`)
  return [
    dialogHead('decisions', 'in force', `${page.decisions.length} owner decisions`, ''),
    '<div class="drill-body">',
    rows.length === 0 ? note('The bus holds no owner decision in force.') : `<div class="dec">${rows.join('')}</div>`,
    '</div>',
  ].join('')
}

function dialogTemplate(dialog: string, html: string): string {
  return `<template id="${DIALOG_PREFIX}${dialog}">${html}</template>`
}

export const VIEW_KEY = 'construct-board:view'

const SCRIPT = `
(function () {
  var dialog = document.getElementById('${DRILL}')
  var content = document.getElementById('${DRILL_CONTENT}')
  var scroller = document.getElementById('${BACKLOG_SCROLL}')
  var view = { filter: '', scroll: 0, open: null }
  function save() {
    try { localStorage.setItem('${VIEW_KEY}', JSON.stringify(view)) }
    catch (error) {}
  }
  try {
    var stored = JSON.parse(localStorage.getItem('${VIEW_KEY}') || '{}')
    if (typeof stored.filter === 'string') view.filter = stored.filter
    if (typeof stored.scroll === 'number') view.scroll = stored.scroll
    if (typeof stored.open === 'string') view.open = stored.open
  }
  catch (error) {}
  function open(name) {
    var template = document.getElementById('${DIALOG_PREFIX}' + name)
    if (!template) { view.open = dialog.open ? view.open : null; return }
    content.innerHTML = template.innerHTML
    if (!dialog.open) dialog.showModal()
    view.open = name
    save()
  }
  dialog.addEventListener('close', function () { view.open = null; save() })
  dialog.addEventListener('click', function (event) { if (event.target === dialog) dialog.close() })
  document.addEventListener('click', function (event) {
    var hit = event.target.closest && event.target.closest('[data-open]')
    if (hit) open(hit.dataset.open)
  })
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') { if (dialog.open) dialog.close(); return }
    if (event.metaKey || event.ctrlKey || event.altKey) return
    var hit = event.target.closest && event.target.closest('[data-open]')
    if (hit && hit.tagName !== 'BUTTON' && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); open(hit.dataset.open); return }
    if (event.key === 'h' || event.key === 'H') open('${HANDOFF_DIALOG}')
    if (event.key === 'd' || event.key === 'D') open('${DECISIONS_DIALOG}')
  })
  addEventListener('hashchange', function () { view.filter = location.hash; save() })
  if (scroller) scroller.addEventListener('scroll', function () { view.scroll = scroller.scrollTop; save() })
  if (location.hash) view.filter = location.hash
  else if (view.filter && document.getElementById(view.filter.slice(1))) location.hash = view.filter
  if (scroller) scroller.scrollTop = view.scroll
  if (view.open) open(view.open)
  save()
  function stale() {
    var live = document.getElementById('${BUS_LIVE}')
    if (live) { live.setAttribute('data-stale', ''); live.textContent = '${STALE_READING}' }
    var pulse = document.getElementById('${PULSE_ELEMENT_ID}')
    if (pulse) pulse.setAttribute('data-stale', '')
  }
  function readable(board) {
    return board !== null && typeof board === 'object' && typeof board.written === 'string' && board.slots !== null && typeof board.slots === 'object' && Array.isArray(board.filters)
  }
  function apply(board) {
    document.title = '${TITLE_PREFIX}' + board.written
    for (var name in board.slots) {
      var slot = document.getElementById('${SLOT_PREFIX}' + name)
      if (slot && typeof board.slots[name] === 'string') slot.innerHTML = board.slots[name]
    }
    var backlog = document.getElementById('${BACKLOG}')
    board.filters.forEach(function (id) {
      if (!backlog || typeof id !== 'string' || document.getElementById(id)) return
      var target = document.createElement('span')
      target.className = 'filter-target'
      target.id = id
      backlog.prepend(target)
    })
  }
  var written = document.body.dataset.written
  var period = Number(document.body.dataset.tickMs)
  function receive(board) {
    if (!readable(board)) { stale(); return }
    if (typeof board.tickMs === 'number' && board.tickMs > 0) period = board.tickMs
    if (board.written === written) return
    written = board.written
    apply(board)
  }
  function schedule() {
    if (period > 0) setTimeout(update, period)
  }
  function update() {
    window.BOARD = undefined
    var script = document.createElement('script')
    script.onload = function () { script.remove(); receive(window.BOARD); schedule() }
    script.onerror = function () { script.remove(); stale(); schedule() }
    script.src = '${BOARD_DATA_FILE}?t=' + Date.now()
    document.head.appendChild(script)
  }
  schedule()
})()
`

function dialogsSlot(page: BoardPage): string {
  const cards = page.facts.cards.flatMap((card) => {
    const detail = page.details.get(card.id)
    return detail === undefined ? [] : [dialogTemplate(cardDialog(card.id), cardDialogHtml(card, detail, page))]
  })
  return [
    dialogTemplate(HANDOFF_DIALOG, handoffDialogHtml(page)),
    dialogTemplate(DECISIONS_DIALOG, decisionsDialogHtml(page)),
    ...cards,
  ].join('\n')
}

function dialogs(slots: BoardSlots): string {
  return [
    `<dialog class="drill" id="${DRILL}" aria-labelledby="drill-title"><div class="drill-wrap" id="${DRILL_CONTENT}"></div></dialog>`,
    `<div id="${SLOT_PREFIX}dialogs" hidden>${slots.dialogs}</div>`,
    `<script>${SCRIPT}</script>`,
  ].join('\n')
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
  &:has([data-over]) { --_accent: var(--signal); }
}
.svc-top { display: flex; gap: var(--space-s); align-items: baseline; }
.svc-kind { font: 700 0.8125rem var(--font-display); letter-spacing: 0.16em; text-transform: uppercase; }
.svc-target { margin-inline-start: auto; }
.svc-line { color: var(--dim); font-size: 0.72rem; overflow-wrap: anywhere; }
.lore { color: var(--amber); font: 700 0.75rem var(--font-display); letter-spacing: 0.1em; text-transform: uppercase; }
.edd {
  --_bar: var(--wire);
  --_value: var(--text);
  display: grid;
  grid-template-columns: 3.25rem minmax(0, 1fr) max-content;
  gap: var(--space-s);
  align-items: center;
  color: var(--dim);
  font-size: 0.65rem;
  &[data-hot] { --_bar: var(--amber); --_value: var(--amber); }
  &[data-over] { --_bar: var(--signal); --_value: var(--signal); }
}
.edd-k { text-transform: uppercase; letter-spacing: 0.08em; }
.edd-v { text-align: end; white-space: nowrap; color: var(--_value); }
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
.goal {
  flex-basis: 100%;
  display: grid;
  gap: var(--space-s);
  padding-block-start: 0.625rem;
  border-block-start: 1px solid var(--line);
  &:empty { display: none; }
}
.goal-top { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-s) 1rem; }
.goal-k { color: var(--signal); font: 700 0.75rem var(--font-display); letter-spacing: 0.2em; text-transform: uppercase; }
.goal-n {
  margin-inline-start: auto;
  font: 700 1.125rem var(--font-display);
  letter-spacing: 0.06em;
  & small { color: var(--dim); font: 400 0.6875rem var(--font-mono); letter-spacing: 0.04em; }
}
.bar {
  display: flex;
  gap: 2px;
  block-size: 0.875rem;
  padding: 2px;
  background: var(--panel-raised);
  border: 1px solid var(--line);
  & .sw { flex: var(--_n) 1 0; min-inline-size: 0; }
}
.sw {
  --_c: var(--off);
  --_paint: var(--_c);
  display: block;
  background: var(--_paint);
  &[data-stage="merged"] { --_c: var(--ok); }
  &[data-stage="ready"] { --_c: oklch(from var(--ok) calc(l - 0.2) c h); }
  &[data-stage="answer/changes"] { --_c: var(--signal); }
  &[data-stage="review"] { --_c: var(--wire); }
  &[data-stage="in work"] { --_c: var(--amber); }
  &[data-stage="planned"] { --_c: oklch(from var(--wire) calc(l - 0.3) calc(c * 0.5) h); }
  &[data-stage="stopped"] { --_c: var(--signal); --_paint: repeating-linear-gradient(135deg, var(--_c) 0 3px, transparent 3px 6px); }
  &[data-stage="dropped"] { --_paint: repeating-linear-gradient(135deg, var(--_c) 0 2px, transparent 2px 5px); }
  &[data-stage="delivered"] { --_c: var(--ok); }
  &[data-stage="in_progress"] { --_c: var(--amber); }
  &[data-stage="queued"] { --_c: oklch(from var(--wire) calc(l - 0.3) calc(c * 0.5) h); }
  &[data-stage="not_created"] { --_paint: repeating-linear-gradient(135deg, var(--_c) 0 2px, transparent 2px 5px); }
}
.waits:empty { display: none; }
.down { display: grid; gap: var(--space-xs); padding: var(--space-s) var(--space-m); }
.owner-strip {
  display: flex;
  flex-wrap: wrap;
  align-items: stretch;
  border: 1px solid var(--amber);
  background: linear-gradient(90deg, oklch(from var(--amber) l c h / 0.12), transparent 70%), var(--panel);
  & .lbl { display: flex; align-items: center; padding: var(--space-s) var(--space-m); background: var(--amber); color: var(--void); font: 700 0.75rem var(--font-display); letter-spacing: 0.18em; text-transform: uppercase; }
}
.ask {
  --_what: var(--text);
  display: flex;
  align-items: center;
  gap: 0.625rem;
  min-inline-size: 0;
  padding: var(--space-s) var(--space-m);
  border-inline-end: 1px solid var(--line);
  text-align: start;
  & .kind { color: var(--amber); font-weight: 700; }
  & .what { min-inline-size: 0; color: var(--_what); overflow-wrap: anywhere; }
  &[data-static] { --_what: var(--dim); }
}
.stage {
  --_name: var(--text);
  display: grid;
  grid-template-columns: 0.75rem 1fr auto;
  gap: 0.125rem 0.625rem;
  align-items: center;
  padding: 0.45rem var(--space-m);
  &[data-empty] { --_name: var(--off); }
  & .sw { inline-size: 0.75rem; block-size: 0.75rem; }
  & .name { color: var(--_name); font: 700 0.75rem var(--font-display); letter-spacing: 0.14em; text-transform: uppercase; }
  & .n { color: var(--_name); font: 700 0.9375rem var(--font-display); }
  & .ids { grid-column: 2 / -1; display: flex; flex-wrap: wrap; gap: 0.125rem 0.375rem; font-size: 0.75rem; }
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
  &[data-stage="dropped"] td { opacity: 0.55; }
  &[data-stage="in work"] td:first-child { box-shadow: inset 3px 0 var(--amber); }
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
  &[data-stage="merged"] { --_fg: var(--ok); }
  &[data-stage="planned"], &[data-stage="review"], &[data-stage="ready"] { --_fg: var(--wire); }
  &[data-stage="in work"], &[data-stage="answer/changes"] { --_fg: var(--amber); }
  &[data-stage="stopped"] { --_fg: var(--signal); }
  &[data-stage="dropped"] { --_fg: var(--off); }
}
.statusline {
  display: flex;
  flex-wrap: wrap;
  border: 1px solid var(--line);
  background: var(--panel);
  font-size: 0.72rem;
  & > span, & > button { padding: 0.3rem 0.75rem; border-inline-end: 1px solid var(--line); color: var(--dim); }
  & > button { color: var(--wire); font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
  & .mode { background: var(--signal); color: var(--void); font-weight: 700; letter-spacing: 0.12em; }
  & .cursor::after { content: "\\2588"; color: var(--wire); margin-inline-start: 0.3em; animation: --animation-blink 1s steps(1) infinite; }
}
button { margin: 0; padding: 0; border: 0; background: transparent; color: inherit; font: inherit; }
[data-open], [data-link], .drill-close {
  cursor: pointer;
  color: var(--wire);
  text-decoration: none;
  &:hover { background: var(--wire-soft); box-shadow: inset 0 -2px var(--wire); }
  &:focus-visible { outline: 2px solid var(--amber); outline-offset: -2px; }
}
tr[data-open] td:last-child { text-align: end; }
.open-hint { color: var(--wire); font-size: 0.65rem; letter-spacing: 0.1em; text-transform: uppercase; white-space: nowrap; }
.cid { padding-inline: 0.2em; }
kbd { padding: 0 0.25rem; border: 1px solid var(--wire); color: var(--wire); font: 700 0.625rem var(--font-mono); }
dialog.drill {
  --cut: 1.375rem;
  inline-size: min(56rem, calc(100vi - 2rem));
  max-block-size: calc(100dvh - 3rem);
  padding: 0;
  border: 1px solid var(--signal);
  background: var(--panel);
  color: var(--text);
  clip-path: polygon(0 0, calc(100% - var(--cut)) 0, 100% var(--cut), 100% 100%, var(--cut) 100%, 0 calc(100% - var(--cut)));
  &::backdrop { background: oklch(from var(--void) l c h / 0.7); backdrop-filter: blur(2px); }
}
.drill-wrap { display: flex; flex-direction: column; max-block-size: calc(100dvh - 3rem); }
.drill-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-s) var(--space-m);
  padding: var(--space-m) var(--space-l);
  border-block-end: 1px solid var(--line);
  background: linear-gradient(90deg, var(--signal-soft), transparent 70%);
  & form { margin: 0; }
}
.drill-kind { color: var(--signal); font: 700 0.6875rem var(--font-display); letter-spacing: 0.2em; text-transform: uppercase; }
.drill-id { font: 700 1.375rem var(--font-display); letter-spacing: 0.06em; }
.drill-name { flex: 1; min-inline-size: 0; font-weight: 700; overflow-wrap: anywhere; }
.drill-close { padding: var(--space-xs) 0.625rem; border: 1px solid var(--wire); font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; }
.drill-body { overflow: auto; padding: var(--space-l); display: grid; gap: var(--space-l); }
.punch { position: relative; border: 1px solid var(--line); background: var(--panel-raised); }
.punch-holes {
  display: flex;
  flex-wrap: wrap;
  gap: 3px;
  padding: var(--space-s) 0.625rem;
  border-block-end: 1px dashed var(--line);
  & i { inline-size: 0.375rem; block-size: 0.625rem; border: 1px solid var(--line); }
  & i[data-on] { background: var(--signal); border-color: var(--signal); }
}
.punch-label { position: absolute; inset-block-start: 0.375rem; inset-inline-end: 0.625rem; color: var(--dim); font-size: 0.625rem; letter-spacing: 0.1em; text-transform: uppercase; }
.punch-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 12rem), 1fr)); }
.pf {
  min-inline-size: 0;
  padding: 0.4rem 0.625rem;
  border-inline-end: 1px solid var(--line);
  border-block-end: 1px solid var(--line);
  &[data-wide] { grid-column: 1 / -1; }
}
.pf-k { display: block; color: var(--dim); font-size: 0.6rem; letter-spacing: 0.12em; text-transform: uppercase; }
.pf-v { display: block; overflow-wrap: anywhere; &[data-none] { color: var(--off); } }
.tag { display: inline-block; margin: 2px 4px 0 0; padding: 0 0.375rem; border: 1px solid var(--line); }
.divider {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  color: var(--signal);
  font: 700 0.6875rem var(--font-display);
  letter-spacing: 0.24em;
  text-transform: uppercase;
  &::before, &::after { content: ""; flex: 1; block-size: 1px; background: repeating-linear-gradient(90deg, var(--signal) 0 6px, transparent 6px 10px); }
}
.prose {
  display: grid;
  gap: 0.625rem;
  max-inline-size: 78ch;
  line-height: 1.65;
  & h3 { margin: 0; color: var(--amber); font: 700 0.6875rem var(--font-display); letter-spacing: 0.16em; text-transform: uppercase; }
  & ul { margin: 0; padding-inline-start: 1.2em; display: grid; gap: 3px; }
}
code { padding: 0 0.25rem; background: var(--panel-raised); color: var(--text); }
.note { padding-inline-start: var(--space-s); border-inline-start: 2px solid var(--amber); color: var(--dim); font-size: 0.6875rem; }
.mx-title { margin-block-end: 0.375rem; color: var(--amber); font: 700 0.6875rem var(--font-display); letter-spacing: 0.16em; text-transform: uppercase; }
.mx-wrap { overflow-x: auto; border: 1px solid var(--line); }
.mx {
  min-inline-size: 0;
  font-size: 0.75rem;
  & th { inline-size: 10rem; padding: 0.3rem 0.625rem; background: var(--panel-raised); color: var(--dim); font-weight: 600; text-align: start; }
  & td { padding: 0.3rem 0.625rem; border-block-end: 1px solid var(--line); }
}
.chain {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  & li { display: grid; grid-template-columns: 7rem 0.875rem minmax(0, 1fr); gap: 0.625rem; align-items: start; padding-block: var(--space-xs); }
  & .when { color: var(--dim); font-size: 0.7rem; text-align: end; }
  & .dot { inline-size: 0.625rem; block-size: 0.625rem; margin-block-start: var(--space-xs); border: 2px solid var(--wire); }
}
.dec {
  display: grid;
  border: 1px solid var(--line);
  & div { display: grid; grid-template-columns: 4.5rem minmax(0, 1fr); gap: 0.75rem; padding: var(--space-s) 0.75rem; border-block-end: 1px solid var(--line); }
  & div:last-child { border-block-end: 0; }
  & b { color: var(--amber); font-family: var(--font-display); letter-spacing: 0.06em; }
}
@keyframes --animation-board-banner-flicker { 0%, 96%, 100% { transform: none; } 97% { transform: translateX(2px); } 98% { transform: translateX(-1px); } }
@keyframes --animation-blink { 50% { opacity: 0.2; } }
@media (prefers-reduced-motion: reduce) {
  .banner, .live::before, .statusline .cursor::after { animation: none; }
}
`

export interface BoardSlots {
  kv: string
  goal: string
  waits: string
  services: string
  flow: string
  backlog: string
  rows: string
  status: string
  dialogs: string
}

export interface BoardData {
  written: string
  tickMs: number | null
  pulse: string | null
  waits: OwnerWait[]
  slots: BoardSlots
  filters: string[]
}

export function boardData(page: BoardPage): BoardData {
  return {
    written: page.facts.at,
    tickMs: page.tickMs,
    pulse: page.facts.pulse,
    waits: page.facts.waits,
    slots: {
      kv: headerReadings(page),
      goal: goalSlot(page.facts),
      waits: waitsSlot(page),
      services: servicesSlot(page),
      flow: flowSlot(page),
      backlog: backlogSlot(page.facts),
      rows: rowsSlot(page.facts),
      status: statusSlot(page.facts),
      dialogs: dialogsSlot(page),
    },
    filters: filterTargetIds(page.facts),
  }
}

export function boardDataScript(data: BoardData): string {
  return `${BOARD_DATA_PREFIX}${JSON.stringify(data)}\n`
}

export interface BoardSnapshot {
  written: string
  tickMs: number | null
  pulse: string | null
  waits: OwnerWait[]
}

export function readSnapshot(file: string): BoardSnapshot | null {
  try {
    const text = readFileSync(file, 'utf8')
    if (!text.startsWith(BOARD_DATA_PREFIX))
      return null
    const data = JSON.parse(text.slice(BOARD_DATA_PREFIX.length)) as Partial<BoardData> | null
    if (typeof data?.written !== 'string')
      return null
    return { written: data.written, tickMs: positive(data.tickMs), pulse: typeof data.pulse === 'string' ? data.pulse : null, waits: Array.isArray(data.waits) ? data.waits : [] }
  }
  catch {
    return null
  }
}

export interface BusDown {
  at: string
  stoppedAt: string | null
  error: string
  snapshot: BoardSnapshot | null
  handoffStatus: string | null
}

function snapshotAgeMs(down: BusDown): number | null {
  return down.snapshot === null ? null : Math.max(0, Date.parse(down.at) - Date.parse(down.snapshot.written))
}

function snapshotStale(down: BusDown): boolean {
  const age = snapshotAgeMs(down)
  const tick = down.snapshot?.tickMs ?? null
  return age === null || tick === null || age > STALE_TICKS * tick
}

function ownerStatus(handoff: Handoff): string | null {
  if (handoff.text === null)
    return null
  const status = handoffParts(handoff.text).fields.find(([label]) => label === HANDOFF_STATUS)?.[1][0]
  return status !== undefined && status.startsWith(OWNER_STATUS) ? status : null
}

export function busDownOf(now: Date, error: string, snapshotFile: string, handoff: Handoff): BusDown {
  const snapshot = readSnapshot(snapshotFile)
  return { at: now.toISOString(), stoppedAt: snapshot?.pulse ?? snapshot?.written ?? null, error, snapshot, handoffStatus: ownerStatus(handoff) }
}

export function busDownLine(down: BusDown): string {
  return `the bus stopped at ${down.stoppedAt ?? 'an unknown time'}: ${down.error}`
}

function snapshotLine(down: BusDown): string {
  const age = snapshotAgeMs(down)
  return down.snapshot === null || age === null ? 'no board snapshot to read' : `snapshot written ${down.snapshot.written} · age ${Math.round(age / MINUTE_MS)} min`
}

function busDownWaits(down: BusDown): string {
  const items = [
    ...(down.snapshot?.waits ?? []).map(wait => `<span class="ask" data-static><span class="kind">${WAIT_NEEDS[wait.need] ?? '?'}</span><span class="what">${escaped(waitText(wait))}</span></span>`),
    ...(down.handoffStatus === null ? [] : [`<span class="ask" data-static><span class="kind">H</span><span class="what">${escaped(`handoff STATUS: ${down.handoffStatus}`)}</span></span>`]),
  ]
  return items.length === 0
    ? note('No open owner wait in the last snapshot or the handoff.')
    : `<section class="owner-strip" aria-label="Waits for you"><span class="lbl">waits for you</span>${items.join('')}</section>`
}

export function renderBusDown(down: BusDown): string {
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${TITLE_PREFIX}bus stopped</title>`,
    `<style>${STYLE}</style></head><body>`,
    `<section class="panel" role="alert" aria-labelledby="h-bus-down"><div class="panel-head"><h2 id="h-bus-down">bus stopped</h2></div>`,
    `<div class="down"><p class="fail">${escaped(busDownLine(down))}</p><p><span class="live" data-snapshot${snapshotStale(down) ? ' data-stale' : ''}>${escaped(snapshotLine(down))}</span></p></div></section>`,
    busDownWaits(down),
    '</body></html>',
    '',
  ].join('\n')
}

export function busDownJson(down: BusDown): string {
  return `${JSON.stringify({ status: 'stopped', at: down.at, line: busDownLine(down), stoppedAt: down.stoppedAt, error: down.error, snapshot: down.snapshot === null ? null : { written: down.snapshot.written, ageMs: snapshotAgeMs(down), stale: snapshotStale(down) }, waits: down.snapshot?.waits ?? [], handoffStatus: down.handoffStatus }, null, 2)}\n`
}

export function busJson(db: DatabaseSync, now: Date): string {
  const facts = busFacts(db, now)
  const prs = cardPrs(db)
  const events = latestCardEvents(db, EVENTS_PER_CARD)
  return `${JSON.stringify({
    status: 'live',
    at: facts.at,
    pulse: facts.pulse,
    waits: facts.waits,
    cards: facts.cards.map(card => ({ id: card.id, stage: card.stage, state: card.state, lane: card.lane, pr: prs.get(card.id) ?? null, line: card.line, events: events.get(card.id) ?? [] })),
    tasks: openTasks(db),
  }, null, 2)}\n`
}

export function renderBoard(page: BoardPage): string {
  const { slots } = boardData(page)
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${TITLE_PREFIX}${escaped(page.facts.at)}</title>`,
    `<style>${STYLE}</style></head><body data-written="${escaped(page.facts.at)}" data-tick-ms="${page.tickMs ?? ''}">`,
    headerPanel(page, slots),
    `<section class="panel" id="${SLOT_PREFIX}services" aria-labelledby="h-services">\n${slots.services}\n</section>`,
    '<div class="split">',
    `<section class="panel" id="${SLOT_PREFIX}flow" aria-labelledby="h-flow">\n${slots.flow}\n</section>`,
    backlogPanel(page.facts, slots),
    '</div>',
    `<footer class="statusline" id="${SLOT_PREFIX}status">${slots.status}</footer>`,
    dialogs(slots),
    '</body></html>',
    '',
  ].join('\n')
}

function boardPageOf(db: DatabaseSync, now: Date, handoffFile: string, tickMs: number | null): BoardPage {
  const facts = busFacts(db, now)
  return {
    version: VERSION,
    modelVersion: readModelVersion(),
    facts,
    gauges: projectedGauges(db),
    windowGauges: projectedWindowGauges(db),
    limits: readEddiesLimits(),
    details: cardDetails(db, facts),
    decisions: inForceDecisions(db),
    handoff: readHandoff(handoffFile),
    repository: readRepositoryUrl(),
    tickMs,
  }
}

export function writeBoardPage(file: string, html: string, files: BoardFiles = DISK_FILES): void {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`)
  files.write(temporary, html)
  files.rename(temporary, file)
}

export type BoardFormat = 'html' | 'json'

function boardText(busPath: string, now: Date, handoffFile: string, format: BoardFormat): string {
  const db = openDatabase(busPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS })
  try {
    return format === 'json' ? busJson(db, now) : renderBoard(boardPageOf(db, now, handoffFile, null))
  }
  finally {
    db.close()
  }
}

export function printBoard(busPath: string, now: Date, write: (text: string) => void, handoffFile: string = HANDOFF_FILE, format: BoardFormat = 'html'): number {
  let text: string
  try {
    text = boardText(busPath, now, handoffFile, format)
  }
  catch (error) {
    const down = busDownOf(now, error instanceof Error ? error.message.split('\n')[0]! : String(error), path.join(path.dirname(busPath), BOARD_DATA_FILE), readHandoff(handoffFile))
    write(format === 'json' ? busDownJson(down) : renderBusDown(down))
    return 1
  }
  write(text)
  return 0
}

export function runBoardCli(busPath: string = defaultBusPath(), args: readonly string[] = process.argv.slice(2)): number {
  if (!existsSync(busPath)) {
    console.error(`${PREFIX}no bus database at ${busPath}`)
    return 1
  }
  return printBoard(busPath, new Date(), text => process.stdout.write(text), HANDOFF_FILE, args.includes(JSON_FLAG) ? 'json' : 'html')
}

export interface BoardProjection {
  file: string
  dataFile: string
  project: (now: Date) => void
}

export function boardProjection(db: DatabaseSync, busPath: string, tickMs: number, files: BoardFiles = DISK_FILES, handoffFile: string = HANDOFF_FILE): BoardProjection {
  const file = path.join(path.dirname(busPath), BOARD_FILE)
  const dataFile = path.join(path.dirname(busPath), BOARD_DATA_FILE)
  return {
    file,
    dataFile,
    project: (now) => {
      try {
        const page = boardPageOf(db, now, handoffFile, tickMs)
        writeBoardPage(dataFile, boardDataScript(boardData(page)), files)
        writeBoardPage(file, renderBoard(page), files)
      }
      catch (error) {
        console.error(`${PREFIX}${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
      }
    },
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = runBoardCli()
