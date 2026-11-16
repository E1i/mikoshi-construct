import type { BusService, SubagentReading } from '../../../src/commands/board/bus.js'
import type { CrawlerWork, EddiesLimits } from './session-card.js'
import { agentHeat, escaped, minutesBetween } from './session-card.js'

export interface MikoWords {
  role: string
  name: string
  plainTitle: string
  serviceLine: (service: BusService) => string
}

export interface MikoPanelParts {
  windows: readonly BusService[]
  bars: (service: BusService) => string
  crawlers: (service: BusService) => string
  limits: EddiesLimits
  now: string
  work: ReadonlyMap<string, CrawlerWork>
  words: MikoWords
  busLines: readonly string[]
  busLive: boolean
  opener: string
  hint: string
  idle: string | null
}

const BUS_LIVE_HEAD = 'BUS LIVE'
const BUS_STALE_HEAD = 'BUS STALE'
const CRAWLER_STATES = ['calm', 'hot', 'over'] as const
const NONE = '—'

function mikoTitle(words: MikoWords, target: string | null, hint: string): string {
  return `<div class="svc-top"${words.plainTitle}><span class="svc-kind">${words.role}</span><span class="lore">${words.name}</span>${target === null ? '' : `<span class="svc-target">${escaped(target)}</span>`}${hint}</div>`
}

function mikoSelf(service: BusService, parts: MikoPanelParts, first: boolean): string {
  return [
    '<div class="miko-self">',
    mikoTitle(parts.words, service.task, first ? parts.hint : ''),
    `<div class="svc-line">${escaped(parts.words.serviceLine(service))}</div>`,
    parts.bars(service),
    '</div>',
  ].join('')
}

function mikoLeft(parts: MikoPanelParts): string {
  if (parts.windows.length > 0)
    return parts.windows.map((service, index) => mikoSelf(service, parts, index === 0)).join('')
  return `<div class="miko-self">${mikoTitle(parts.words, null, '')}${parts.idle === null ? '' : `<div class="svc-line">${escaped(parts.idle)}</div>`}</div>`
}

const textOrNull = (value: unknown): string | null => typeof value === 'string' && value.trim() !== '' ? value : null

export function crawlerWorkOf(events: readonly { fields: { role?: unknown, task?: unknown, step?: unknown } }[]): Map<string, CrawlerWork> {
  return new Map(events.flatMap(({ fields }) => {
    const role = textOrNull(fields.role)
    return role === null ? [] : [[role, { task: textOrNull(fields.task), action: textOrNull(fields.step) }] as const]
  }))
}

export function crawlerRow(agent: SubagentReading, work: CrawlerWork | undefined, limits: EddiesLimits, now: string): string {
  const time = agent.at === null ? NONE : `${minutesBetween(agent.at, now)} min`
  const line = [agent.name, work?.task ?? NONE, work?.action ?? NONE, time].join(' · ')
  return `<li class="miko-crawler" data-state="${CRAWLER_STATES[agentHeat(agent, limits)]}"><span class="crawler-dot"></span><span>${escaped(line)}</span></li>`
}

function crawlers(parts: MikoPanelParts): string {
  const rows = parts.windows.flatMap(service => service.subagents ?? []).map(agent => crawlerRow(agent, parts.work.get(agent.name), parts.limits, parts.now))
  return `<div class="miko-crawlers">${parts.windows.map(parts.crawlers).join('')}${rows.length === 0 ? '' : `<ul class="miko-crawler-rows">${rows.join('')}</ul>`}</div>`
}

function busColumn(parts: MikoPanelParts): string {
  return `<div class="miko-bus"${parts.busLive ? '' : ' data-stale'}><div class="miko-bus-head">${parts.busLive ? BUS_LIVE_HEAD : BUS_STALE_HEAD}</div>${parts.busLines.map(line => `<div class="svc-line">${escaped(line)}</div>`).join('')}</div>`
}

export function mikoPanel(parts: MikoPanelParts): string {
  return `<div class="svc bevel" data-role="window"${parts.opener} data-strip>${mikoLeft(parts)}${crawlers(parts)}${busColumn(parts)}</div>`
}
