import type { BusService, CrawlerReading } from '../../../src/commands/board/bus.js'
import type { Daemon } from './daemon-catalog.js'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { DAEMON_READER, daemonCatalog, installedDaemons, LOADED_SOURCE } from './daemon-catalog.js'
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

export interface MikoMode {
  hijacked: boolean
  path: string
}

export interface DaemonWords {
  boardMikoChip: string
  boardMikoWhere: (hijacked: boolean, path: string) => string
  boardDaemonsHead: (installed: number) => string
  boardDaemonState: (loaded: boolean) => string
  boardDaemonSlot: (slot: number) => string
  boardDaemonMutations: (count: number) => string
  boardDaemonsUnread: (reader: string, loadedIn: string) => string
}

export interface DaemonsReading {
  daemons: readonly Daemon[]
  reader: string
  loadedIn: string
}

export interface MikoPanelParts {
  windows: readonly BusService[]
  bars: (service: BusService) => string
  presence: MikoPresence
  now: string
  words: MikoWords
  opener: string
  hint: string
  idle: string | null
  bay?: MikoBay
}

export interface MikoBay {
  mode: MikoMode
  daemons: DaemonsReading
  lore: DaemonWords
}

export const ATTACH_RECORD = '.construct/attach.json'
const SD_OUTLINE = 'M3 2H27L37 12V58H3Z'
const SD_TICKS = 'M8 2V8M12 2V8M16 2V8M20 2V8M24 2V8'
const SKETCHES: Readonly<Record<string, string>> = {
  'hex-iris': '<polygon points="20,20 29,25 29,35 20,40 11,35 11,25"/><circle cx="20" cy="30" r="5"/><circle cx="20" cy="30" r="1.6"/>',
  'adapter-chip': '<rect x="12" y="22" width="16" height="16"/><path d="M16 22V18M20 22V18M24 22V18M16 38V42M20 38V42M24 38V42M12 26H8M12 34H8M28 26H32M28 34H32"/>',
}
const UNKNOWN_SKETCH = '<rect x="14" y="24" width="12" height="12"/>'

export function mikoMode(root: string, exists: (file: string) => boolean): MikoMode {
  return { hijacked: exists(path.join(root, ATTACH_RECORD)), path: root }
}

export function mikoBay(root: string, loadedSkills: readonly string[], lore: DaemonWords, exists: (file: string) => boolean = existsSync): MikoBay {
  return { mode: mikoMode(root, exists), daemons: { daemons: installedDaemons(daemonCatalog(root), loadedSkills), reader: DAEMON_READER, loadedIn: LOADED_SOURCE }, lore }
}

function modeLine(mode: MikoMode, lore: DaemonWords): string {
  const chip = mode.hijacked ? `<span class="mode-chip">${escaped(lore.boardMikoChip)}</span>` : ''
  return `<div class="svc-line miko-where">${chip}<span>${escaped(lore.boardMikoWhere(mode.hijacked, mode.path))}</span></div>`
}

function daemonState(daemon: Daemon): string {
  return daemon.loaded ? 'loaded' : 'sleep'
}

export function sdCard(daemon: Daemon): string {
  const sketch = daemon.sketch === null ? UNKNOWN_SKETCH : SKETCHES[daemon.sketch] ?? UNKNOWN_SKETCH
  return `<div class="sd-card"><svg viewBox="0 0 40 60" aria-hidden="true"><path class="sd-frame" d="${SD_OUTLINE}"/><path class="sd-frame" d="${SD_TICKS}"/><g class="sd-sketch" data-sketch="${escaped(daemon.sketch ?? '')}">${sketch}</g></svg><span class="sd-name">${escaped(daemon.daemon)}</span></div>`
}

function daemonSlot(daemon: Daemon, index: number, lore: DaemonWords): string {
  return `<li class="daemon-slot" data-daemon-slot="${escaped(daemon.daemon)}" data-state="${daemonState(daemon)}" tabindex="0"><span class="slot-bay">${sdCard(daemon)}</span><span class="slot-foot"><i class="slot-led"></i>${escaped(lore.boardDaemonSlot(index + 1))}</span></li>`
}

function daemonPane(daemon: Daemon, shown: boolean, lore: DaemonWords): string {
  const mutations = daemon.mutations.map(mutation => `<li>${escaped(mutation)}</li>`).join('')
  return `<div class="daemon-pane" data-daemon-pane="${escaped(daemon.daemon)}" data-state="${daemonState(daemon)}"${shown ? ' data-default data-shown' : ''}><span class="pane-name">${escaped(daemon.daemon)}</span><span class="pane-tag">${escaped(lore.boardDaemonState(daemon.loaded))}</span><span class="pane-head">${escaped(lore.boardDaemonMutations(daemon.mutations.length))}</span><ul class="pane-mutations">${mutations}</ul></div>`
}

export function daemonsCell(reading: DaemonsReading, lore: DaemonWords): string {
  const { daemons } = reading
  const head = `<div class="daemons-head">${escaped(lore.boardDaemonsHead(daemons.length))}</div>`
  if (daemons.length === 0)
    return `<div class="miko-daemons">${head}<div class="svc-line daemons-unread">${escaped(lore.boardDaemonsUnread(reading.reader, reading.loadedIn))}</div></div>`
  const shown = daemons.find(daemon => daemon.loaded) ?? daemons[0]!
  return `<div class="miko-daemons">${head}<div class="daemons-bay"><ol class="daemon-slots">${daemons.map((daemon, index) => daemonSlot(daemon, index, lore)).join('')}</ol><div class="daemon-status">${daemons.map(daemon => daemonPane(daemon, daemon === shown, lore)).join('')}</div></div></div>`
}

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
    first && parts.bay !== undefined ? modeLine(parts.bay.mode, parts.bay.lore) : '',
    first ? windowLine(parts.presence) : '',
    first ? skillsRow(parts.presence.skills) : '',
    parts.bars(service),
    '</div>',
  ].join('')
}

function mikoLeft(parts: MikoPanelParts): string {
  if (parts.windows.length > 0)
    return parts.windows.map((service, index) => mikoSelf(service, parts, index === 0)).join('')
  const where = parts.bay === undefined ? '' : modeLine(parts.bay.mode, parts.bay.lore)
  return `<div class="miko-self">${mikoTitle(parts.words, null, '')}${where}${parts.idle === null ? '' : `<div class="svc-line">${escaped(parts.idle)}</div>`}</div>`
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

export function mikoPanel(parts: MikoPanelParts): string {
  const { bay } = parts
  const mode = bay === undefined ? '' : ` data-mode="${bay.mode.hijacked ? 'hijack' : 'init'}"`
  const daemons = bay === undefined ? '' : daemonsCell(bay.daemons, bay.lore)
  return `<div class="svc bevel" data-role="window"${parts.opener}${mode} data-strip>${mikoLeft(parts)}${daemons}${crawlersCell(parts.presence.crawlers, parts.now)}</div>`
}
