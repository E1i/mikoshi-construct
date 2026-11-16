import type { BusService, CrawlerReading } from '../../../src/commands/board/bus.js'
import { compact, escaped, minutesBetween } from './session-card.js'

export interface MikoWords {
  role: string
  name: string
  plainTitle: string
}

export interface MikoPresence {
  model: string | null
  core: number | null
  status: string | null
  handoffBytes: number | null
  skills: readonly string[]
  crawlers: readonly CrawlerReading[]
}

export interface MikoPanelParts {
  windows: readonly BusService[]
  bars: (service: BusService) => string
  presence: MikoPresence
  now: string
  words: MikoWords
  busLines: readonly string[]
  busLive: boolean
  opener: string
  hint: string
  idle: string | null
}

const BUS_LIVE_HEAD = 'BUS LIVE'
const BUS_STALE_HEAD = 'BUS STALE'
const CRAWLERS_HEAD = 'CRAWLERS'
const FLATLINED = 'FLATLINED'
const SIGNAL_LOST = 'NO ACTIVE CRAWLERS · SIGNAL LOST'
const SKILLS_HEAD = 'SKILLS'
const KILOBYTE = 1_024
const CRAWLER_NUMBER_WIDTH = 2
const PART_JOIN = ' · '

export function handoffSize(bytes: number): string {
  return bytes < KILOBYTE ? `${bytes} B` : `${Number((bytes / KILOBYTE).toFixed(1))} KB`
}

function joined(parts: readonly (string | null)[]): string {
  return parts.filter(part => part !== null).join(PART_JOIN)
}

function mikoTitle(words: MikoWords, model: string | null, hint: string): string {
  return `<div class="svc-top"${words.plainTitle}><span class="svc-kind">${words.role}</span><span class="lore">${words.name}</span>${model === null ? '' : `<span class="miko-model">(${escaped(model)})</span>`}${hint}</div>`
}

export function windowLine(presence: MikoPresence): string {
  const line = joined([
    presence.core === null ? null : `window v${presence.core}`,
    presence.status === null ? null : `status [${presence.status}]`,
    presence.handoffBytes === null ? null : `handoff ${handoffSize(presence.handoffBytes)}`,
  ])
  return line === '' ? '' : `<div class="svc-line miko-window">${escaped(line)}</div>`
}

function skillsRow(skills: readonly string[]): string {
  if (skills.length === 0)
    return ''
  return `<div class="miko-skills"><span class="miko-skills-head">${SKILLS_HEAD}</span>${skills.map(skill => `<span class="miko-skill">${escaped(skill)}</span>`).join('')}</div>`
}

function mikoSelf(service: BusService, parts: MikoPanelParts, first: boolean): string {
  return [
    '<div class="miko-self">',
    mikoTitle(parts.words, first ? parts.presence.model : null, first ? parts.hint : ''),
    first ? windowLine(parts.presence) : '',
    first ? skillsRow(parts.presence.skills) : '',
    parts.bars(service),
    '</div>',
  ].join('')
}

function mikoLeft(parts: MikoPanelParts): string {
  if (parts.windows.length > 0)
    return parts.windows.map((service, index) => mikoSelf(service, parts, index === 0)).join('')
  return `<div class="miko-self">${mikoTitle(parts.words, null, '')}${parts.idle === null ? '' : `<div class="svc-line">${escaped(parts.idle)}</div>`}</div>`
}

export function crawlerRow(crawler: CrawlerReading, index: number, now: string): string {
  const number = String(index + 1).padStart(CRAWLER_NUMBER_WIDTH, '0')
  const what = joined([crawler.description, crawler.startedAt === null ? null : `${minutesBetween(crawler.startedAt, now)} min`])
  const use = joined([crawler.context === null ? null : `CTX ${compact(crawler.context)}`, crawler.spent === null ? null : `SPENT ${compact(crawler.spent)}`])
  return [
    `<li class="miko-crawler" data-state="${escaped(crawler.state.toLowerCase())}">`,
    `<div class="crawler-top"><span class="crawler-name">${escaped(`CRAWLER #${number} · ${crawler.kind}`)}</span><span class="crawler-chip">${escaped(crawler.state)}</span></div>`,
    what === '' ? '' : `<div class="crawler-what">${escaped(what)}</div>`,
    use === '' ? '' : `<div class="crawler-use">${escaped(use)}</div>`,
    '</li>',
  ].join('')
}

export function crawlersCell(crawlers: readonly CrawlerReading[], now: string): string {
  const live = crawlers.length
  const head = `<div class="crawlers-head"><span class="crawlers-title">${CRAWLERS_HEAD}</span><span class="crawlers-live"${live > 0 ? ' data-live' : ''}>LIVE · ${live}</span></div>`
  const body = live === 0
    ? `<div class="crawlers-flatline"><span class="flatline-stamp">${FLATLINED}</span><span class="flatline-line">${SIGNAL_LOST}</span></div>`
    : `<ul class="miko-crawler-rows">${crawlers.map((crawler, index) => crawlerRow(crawler, index, now)).join('')}</ul>`
  return `<div class="miko-crawlers"${live === 0 ? ' data-flatlined' : ''}>${head}${body}</div>`
}

function busColumn(parts: MikoPanelParts): string {
  return `<div class="miko-bus"${parts.busLive ? '' : ' data-stale'}><div class="miko-bus-head">${parts.busLive ? BUS_LIVE_HEAD : BUS_STALE_HEAD}</div>${parts.busLines.map(line => `<div class="svc-line">${escaped(line)}</div>`).join('')}</div>`
}

export function mikoPanel(parts: MikoPanelParts): string {
  return `<div class="svc bevel" data-role="window"${parts.opener} data-strip>${mikoLeft(parts)}${crawlersCell(parts.presence.crawlers, parts.now)}${busColumn(parts)}</div>`
}
