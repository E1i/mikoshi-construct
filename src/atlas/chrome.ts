import type { MapState } from './components.js'
import type { AtlasMode } from './switch.js'
import type { AtlasTally } from './tally.js'
import { escaped } from '../model/page.js'
import { MAP_STATES } from './components.js'
import { switchHtml } from './switch.js'
import { THEME_BUTTON_ID } from './theme.js'

const WORDS = {
  brand: 'MIKOSHI',
  engine: 'atlas · engine',
  theme: '◐ theme',
  themeLabel: 'Switch between the light and the dark theme',
  eyebrow: { map: 'atlas // engram', docs: 'atlas // docs' } satisfies Record<AtlasMode, string>,
  contours: 'contours',
  parts: 'parts',
  files: 'files',
  states: { held: 'read', unknown: 'not read', absent: 'absent' } satisfies Record<MapState, string>,
  entries: 'entry points',
  relations: 'relations',
  readShare: (percent: number) => `${percent}% of files read`,
  mode: 'ATLAS',
  source: 'source',
  derived: 'states derived on read, never stored',
  offline: 'offline · no network calls',
  command: 'construct atlas',
}

const count = (value: number): string => value.toLocaleString('en-US')

const percentOf = (part: number, whole: number): number => Math.round(part * 100 / whole)

export function topbarHtml(current: AtlasMode, modeFiles?: Record<AtlasMode, string>): string {
  return [
    `<div class="topbar">`,
    `<span class="mark">${WORDS.brand} <small>${escaped(WORDS.engine)}</small></span>`,
    modeFiles == null ? '' : switchHtml(current, modeFiles),
    `<button class="theme" id="${THEME_BUTTON_ID}" type="button" aria-label="${escaped(WORDS.themeLabel)}">${escaped(WORDS.theme)}</button>`,
    `</div>`,
  ].filter(line => line !== '').join('\n')
}

function stat(value: number, label: string, state?: MapState): string {
  return `<div class="stat"${state == null ? '' : ` data-state="${state}"`}><b>${count(value)}</b><span>${escaped(label)}</span></div>`
}

function statesHtml(tally: AtlasTally): string[] {
  return MAP_STATES
    .filter(state => state !== 'absent' || tally.states.absent > 0)
    .map(state => stat(tally.states[state], `${WORDS.states[state]} · ${percentOf(tally.states[state], tally.files)}%`, state))
}

function meterHtml(tally: AtlasTally): string {
  let offset = 0
  const bars = MAP_STATES.filter(state => tally.states[state] > 0).map((state) => {
    const bar = `<rect data-state="${state}" x="${offset}" y="0" width="${tally.states[state]}" height="1"></rect>`
    offset += tally.states[state]
    return bar
  })
  return `<svg class="meter" viewBox="0 0 ${tally.files} 1" preserveAspectRatio="none" role="img" aria-label="${escaped(WORDS.readShare(percentOf(tally.states.held, tally.files)))}">${bars.join('')}</svg>`
}

function statsHtml(tally: AtlasTally | null): string {
  if (tally == null || tally.files === 0)
    return ''
  return [
    `<div class="stats">`,
    stat(tally.contours, WORDS.contours),
    stat(tally.parts, WORDS.parts),
    stat(tally.files, WORDS.files),
    ...statesHtml(tally),
    stat(tally.entries, WORDS.entries),
    stat(tally.relations, WORDS.relations),
    `</div>`,
    meterHtml(tally),
  ].join('\n')
}

export function heroHtml(mode: AtlasMode, projectName: string, tally: AtlasTally | null): string {
  return [
    `<header class="hero">`,
    `<div class="eyebrow">${escaped(WORDS.eyebrow[mode])}</div>`,
    `<h1 class="repo">${escaped(projectName)}</h1>`,
    statsHtml(tally),
    `</header>`,
  ].filter(line => line !== '').join('\n')
}

export function statusHtml(generatedFrom: string): string {
  return `<footer class="status"><span class="mode">${WORDS.mode}</span><span>${WORDS.source} <b>${escaped(generatedFrom)}</b></span><span>${escaped(WORDS.derived)}</span><span>${escaped(WORDS.offline)}</span><span class="cursor">${escaped(WORDS.command)}</span></footer>`
}
