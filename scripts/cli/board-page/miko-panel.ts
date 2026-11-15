import type { BusService } from '../../../src/commands/board/bus.js'
import { escaped } from './session-card.js'

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
  words: MikoWords
  busLines: readonly string[]
  busLive: boolean
  opener: string
  hint: string
  idle: string | null
}

const BUS_LIVE_HEAD = 'BUS LIVE'
const BUS_STALE_HEAD = 'BUS STALE'

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

function crawlers(parts: MikoPanelParts): string {
  return `<div class="miko-crawlers">${parts.windows.map(parts.crawlers).join('')}</div>`
}

function busColumn(parts: MikoPanelParts): string {
  return `<div class="miko-bus"${parts.busLive ? '' : ' data-stale'}><div class="miko-bus-head">${parts.busLive ? BUS_LIVE_HEAD : BUS_STALE_HEAD}</div>${parts.busLines.map(line => `<div class="svc-line">${escaped(line)}</div>`).join('')}</div>`
}

export function mikoPanel(parts: MikoPanelParts): string {
  return `<div class="svc bevel" data-role="window"${parts.opener} data-strip>${mikoLeft(parts)}${crawlers(parts)}${busColumn(parts)}</div>`
}
