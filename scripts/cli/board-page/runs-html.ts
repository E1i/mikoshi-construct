import { narrowestMask } from '../../policy/touch-scope.js'
import { escaped } from './session-card.js'

export interface RunsGroup { name: string, files: string[], derived: boolean }

export interface RunsReading {
  full: string | null
  groups: RunsGroup[]
  paths: string[]
}

export const LAYER_ENTRY = 'layer:'
export const TOUCHED_TESTS = 'touched tests'
const NONE = '—'
const GLOB_SUFFIX = '/**'
const DERIVED_READING = 'derived from touches'
const WHOLE_FOLDER = 'whole folder'
const ROOT_FOLDER = '.'

interface RunsLane {
  head: string
  names: string[]
}

function isMask(entry: string): boolean {
  return entry.endsWith(GLOB_SUFFIX)
}

function headsItsLane(entry: string): boolean {
  return isMask(entry) || entry.startsWith(LAYER_ENTRY)
}

function folderOf(file: string): string {
  const slash = file.lastIndexOf('/')
  return slash === -1 ? ROOT_FOLDER : file.slice(0, slash)
}

function runsLanesOf(entries: readonly string[]): RunsLane[] {
  const masks = entries.filter(isMask)
  const lanes = new Map<string, Set<string>>()
  for (const entry of entries) {
    const head = headsItsLane(entry) ? entry : narrowestMask(entry, masks) ?? folderOf(entry)
    const names = lanes.get(head) ?? new Set<string>()
    lanes.set(head, names)
    if (!headsItsLane(entry))
      names.add(entry.slice(entry.lastIndexOf('/') + 1))
  }
  return [...lanes].map(([head, names]) => ({ head, names: [...names] }))
}

function runsTags(names: readonly string[]): string {
  return names.map(name => `<span class="tag">${escaped(name)}</span>`).join(' ')
}

function runsLaneHtml({ head, names }: RunsLane): string {
  const mask = isMask(head)
  const name = mask && names.length === 0 ? `${head} · ${WHOLE_FOLDER}` : head
  const files = names.length === 0 ? '' : `<p>${runsTags(names)}</p>`
  return `<div class="runs-group" data-lane="${escaped(head)}"${mask ? ' data-glob' : ''}><p class="runs-name">${escaped(name)}</p>${files}</div>`
}

function runsLanesHtml(entries: readonly string[]): string {
  return runsLanesOf(entries).map(runsLaneHtml).join('')
}

function runsGroupHtml(group: RunsGroup): string {
  const name = group.name === TOUCHED_TESTS ? TOUCHED_TESTS : `layer ${group.name}`
  return `<div class="runs-group" data-group="${escaped(group.name)}"${group.derived ? ' data-derived' : ''}><p class="runs-name">${escaped(name)}${group.derived ? ` · ${DERIVED_READING}` : ''}</p>${runsLanesHtml(group.files)}</div>`
}

export function runsHtml(reading: RunsReading | null, marksNone: boolean): string {
  if (reading === null)
    return ''
  const full = reading.full === null ? '' : `<p class="runs-full">full run: ${escaped(reading.full)}</p>`
  const none = marksNone && reading.groups.length === 0 ? `<p>runs: ${NONE}</p>` : ''
  const paths = reading.paths.length === 0 ? none : `<p>runs:</p>${runsLanesHtml(reading.paths)}`
  return `${full}${reading.groups.map(runsGroupHtml).join('')}${paths}`
}
