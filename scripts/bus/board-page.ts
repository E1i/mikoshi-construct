import type { DatabaseSync } from 'node:sqlite'
import type { BusCard, BusFacts, BusMatrix, BusService } from '../../src/commands/board/bus.js'
import type { CardChain } from './card-chain.js'
import type { CardFields } from './card-contract.js'
import type { InForceDecision } from './decisions.js'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { busFacts, FLOW_STATES } from '../../src/commands/board/bus.js'
import { backlogCards, goalLines, isLive, matrixLines, pulseLines } from '../../src/commands/board/screens.js'
import { BANNER, LORE, PLAIN_LORE } from '../../src/ui/lore.js'
import { VERSION } from '../../src/version.js'
import { mikoHandoff } from '../miko/loop.js'
import { BOARD_FILE, cardGauges, FRESH_MS, windowGauges } from './board.js'
import { cardChain } from './card-chain.js'
import { cardContract } from './card-contract.js'
import { BUSY_TIMEOUT_MS, defaultBusPath } from './db.js'
import { inForceDecisions } from './decisions.js'
import { openDatabase } from './sqlite.js'

export const PREFIX = '[bus:board] '
export const REFRESH_SECONDS = 30
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const EDDIES_FILE = path.join(REPOSITORY_ROOT, '.claude/eddies.json')
export const MODEL_FILE = path.join(REPOSITORY_ROOT, 'construct.model.json')
export const PACKAGE_FILE = path.join(REPOSITORY_ROOT, 'package.json')
export const HANDOFF_FILE = mikoHandoff(os.homedir())

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
const DRILL = 'drill'
const DRILL_CONTENT = 'drill-content'
const BACKLOG_SCROLL = 'backlog-scroll'
const DIALOG_PREFIX = 'dialog-'
const HANDOFF_DIALOG = 'handoff'
const DECISIONS_DIALOG = 'decisions'
const HANDOFF_STATUS = 'STATUS'
const OPEN_HINT = '<span class="open-hint">open ›</span>'
const CARD_TASK = /^#(\d+)$/
const CARD_REFERENCE = /(?<!&)#(\d+)\b/g
const CODE_SPAN = /`([^`]+)`/g
const HANDOFF_LINE = /^([^\s#:*-][^:]*):(?: (.*))?$/
const LIST_ITEM = /^\s*[-*]\s+/
const PUNCH_DIGITS = 16

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
  const hot = limit !== null && warnRatio !== null && value >= limit * warnRatio
  const bar = limit === null ? '<span></span>' : `<span class="edd-bar" style="--_fill: ${percent(value / limit)}${warnRatio === null ? '' : `; --_warn: ${percent(warnRatio)}`}"></span>`
  return `<div class="edd"${hot ? ' data-hot' : ''}><span class="edd-k">${name}</span>${bar}<span class="edd-v">${reading}</span></div>`
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

function flowPanel(page: BoardPage): string {
  const { facts } = page
  const live = facts.cards.filter(isLive)
  const stages = PLAIN_LORE.boardFlowColumns.map((title, column) => {
    const ids = live.filter(card => FLOW_STATES[column]!.includes(card.state ?? '')).map(card => cardReference(card.id, page))
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
  return `<tr data-card="${card.id}" data-state="${state}"${isLive(card) ? ' data-live' : ''}${opener(cardDialog(card.id))}><td class="id">#${card.id}</td>${cells}<td><span class="st" data-state="${state}">${state}</span></td><td>${OPEN_HINT}</td></tr>`
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

const COLUMNS = ['card', 'slug', 'kind', 'contour', 'size', 'path', 'gate', 'depends', 'blocks', 'state', '']

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
    `<div class="scroll" id="${BACKLOG_SCROLL}"><table>`,
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
    `<button type="button"${opener(HANDOFF_DIALOG)}><kbd>H</kbd> handoff ›</button>`,
    `<button type="button"${opener(DECISIONS_DIALOG)}><kbd>D</kbd> decisions ›</button>`,
    '<span>geek mode <b>--geek</b></span>',
    '<span class="cursor">construct board</span>',
  ]
  return `<footer class="statusline">${parts.join('')}</footer>`
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
  const state = escaped(stateOf(card))
  return [
    dialogHead('card', `#${card.id}`, cardFields(card)[0]!, `<span class="st" data-state="${state}">${state}</span>`),
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
})()
`

function dialogs(page: BoardPage): string {
  const cards = page.facts.cards.flatMap((card) => {
    const detail = page.details.get(card.id)
    return detail === undefined ? [] : [dialogTemplate(cardDialog(card.id), cardDialogHtml(card, detail, page))]
  })
  return [
    `<dialog class="drill" id="${DRILL}" aria-labelledby="drill-title"><div class="drill-wrap" id="${DRILL_CONTENT}"></div></dialog>`,
    dialogTemplate(HANDOFF_DIALOG, handoffDialogHtml(page)),
    dialogTemplate(DECISIONS_DIALOG, decisionsDialogHtml(page)),
    ...cards,
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
    flowPanel(page),
    backlogPanel(page.facts),
    '</div>',
    statusLine(page.facts),
    dialogs(page),
    '</body></html>',
    '',
  ].join('\n')
}

function pageOf(db: DatabaseSync, now: Date, handoffFile: string): string {
  const facts = busFacts(db, now)
  return renderBoard({
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
  })
}

export function writeBoardPage(file: string, html: string, files: BoardFiles = DISK_FILES): void {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`)
  files.write(temporary, html)
  files.rename(temporary, file)
}

export function printBoard(busPath: string, now: Date, write: (text: string) => void, handoffFile: string = HANDOFF_FILE): number {
  const db = openDatabase(busPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS })
  try {
    write(pageOf(db, now, handoffFile))
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
        writeBoardPage(file, pageOf(db, now, HANDOFF_FILE))
      }
      catch (error) {
        console.error(`${PREFIX}${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
      }
    },
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = runBoardCli()
