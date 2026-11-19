import type { BusService, CrawlerReading } from '../../../src/commands/board/bus.js'
import type { Daemon } from './daemon-catalog.js'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
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
  boardDaemonsHead: { title: string, installed: (count: number) => string }
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
const HOME_MARK = '~'
const SD_TICK_COUNT = 5
const SD_TICKS = `<span class="sd-ticks">${'<i></i>'.repeat(SD_TICK_COUNT)}</span>`
const SD_VIEW = '4 14 40 34'
const SKETCHES: Readonly<Record<string, string>> = {
  'hex-iris': '<path class="sd-eye" d="M7 32 L15 24 H33 L41 32 L33 40 H15 Z"/><polygon class="sd-fill" points="24,24.5 30.5,28.2 30.5,35.8 24,39.5 17.5,35.8 17.5,28.2"/><circle class="sd-pupil" cx="24" cy="32" r="2.6"/><path class="sd-scan" d="M11 32 H17.5 M30.5 32 H37"/><path class="sd-bracket" d="M10 20 H14 V22 M38 20 H34 V22 M10 44 H14 V42 M38 44 H34 V42"/>',
  'adapter-chip': '<rect class="sd-fill" x="16" y="21" width="16" height="22"/><path d="M12 24 H16 M32 24 H36 M12 28 H16 M32 28 H36 M12 32 H16 M32 32 H36 M12 36 H16 M32 36 H36 M12 40 H16 M32 40 H36"/><path d="M21 29 L19 32 L21 35 M27 29 L29 32 L27 35"/><path class="sd-scan" d="M24 15 V21 M24 43 V48"/>',
}
const UNKNOWN_SKETCH = '<rect class="sd-fill" x="18" y="25" width="12" height="14"/>'

export function homeShort(file: string, home: string): string {
  if (home === '' || home === path.sep)
    return file
  if (file === home)
    return HOME_MARK
  return file.startsWith(`${home}${path.sep}`) ? `${HOME_MARK}${file.slice(home.length)}` : file
}

export function mikoMode(root: string, exists: (file: string) => boolean, home: string = homedir()): MikoMode {
  return { hijacked: exists(path.join(root, ATTACH_RECORD)), path: homeShort(root, home) }
}

export function mikoBay(root: string, loadedSkills: readonly string[], lore: DaemonWords, exists: (file: string) => boolean = existsSync, home: string = homedir()): MikoBay {
  return { mode: mikoMode(root, exists, home), daemons: { daemons: installedDaemons(daemonCatalog(root), loadedSkills), reader: DAEMON_READER, loadedIn: LOADED_SOURCE }, lore }
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
  return `<div class="sd-card"><div class="sd-face">${SD_TICKS}<svg class="sd-art" viewBox="${SD_VIEW}" aria-hidden="true"><g class="sd-sketch" data-sketch="${escaped(daemon.sketch ?? '')}">${sketch}</g></svg><span class="sd-name">${escaped(daemon.daemon)}</span></div></div>`
}

export function longestName(daemons: readonly Daemon[]): number {
  return Math.max(0, ...daemons.map(daemon => daemon.daemon.length))
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
  const head = `<div class="daemons-head"><span class="daemons-title">${escaped(lore.boardDaemonsHead.title)}</span><span class="daemons-chip">${escaped(lore.boardDaemonsHead.installed(daemons.length))}</span></div>`
  if (daemons.length === 0)
    return `<div class="miko-daemons bevel">${head}<div class="svc-line daemons-unread">${escaped(lore.boardDaemonsUnread(reading.reader, reading.loadedIn))}</div></div>`
  const shown = daemons.find(daemon => daemon.loaded) ?? daemons[0]!
  return `<div class="miko-daemons bevel">${head}<div class="daemons-bay"><ol class="daemon-slots" style="--_chars: ${longestName(daemons)}">${daemons.map((daemon, index) => daemonSlot(daemon, index, lore)).join('')}</ol><div class="daemon-status">${daemons.map(daemon => daemonPane(daemon, daemon === shown, lore)).join('')}</div></div></div>`
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
  return `<div class="svc bevel" data-role="window"${parts.opener}${mode} data-strip>${mikoLeft(parts)}${crawlersCell(parts.presence.crawlers, parts.now)}${daemons}</div>`
}
