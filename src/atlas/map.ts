import type { ComponentMap } from './components.js'
import type { SourceLinks } from './source-link.js'
import type { AtlasInput } from './view.js'
import { createHash } from 'node:crypto'
import { escaped } from '../model/page.js'
import { channelMap } from './channels.js'
import { ATLAS_DATA_MARK, ATLAS_SCRIPT } from './client.js'
import { componentMap, CROSSINGS, isCodeRelation, MAP_STATES } from './components.js'
import { entryMap } from './entries.js'
import { RELATIVE_LINKS } from './source-link.js'
import { drawnFiles } from './tally.js'

const WORDS = {
  label: 'The map of contours, their parts and the arrows between them',
  heading: 'Map',
  levels: 'contours → parts → files',
  gestures: 'drag to pan · scroll to zoom',
  search: 'Find a file, contour, part or entry point by name',
  searchPlaceholder: 'find a file, contour, part or entry point',
  edges: 'edges',
  filters: 'Show or hide a kind of edge',
  sortParts: 'sort parts',
  sorts: 'Sort the parts inside a contour',
  click: 'Click',
  hint: ' a contour to open its parts, a part to list its files, a file to see what it reaches and what reaches it. Selecting a node lights its edges and neighbours; edge labels show on hover, on the selection and when zoomed in.',
  inspector: 'Inspector',
  inspectorHint: 'Click a contour, part or file: its facts and edges open here.',
  legend: 'Legend',
  legendKinds: 'file states · edge kinds',
  noMechanics: (name: string) => `Nothing to draw yet: ${name} holds no mechanics. construct atlas scans the tracked files and draws them here.`,
  states: {
    held: 'read, and its relations found',
    unknown: 'not read: discovery reads no file of this type, or could not read it',
    absent: 'named by the interpretation, and not in the tree',
  },
  crossings: {
    inside: 'inside one contour',
    through: 'through the contour’s declared entry or contract',
    bypass: 'past the declared entry: a finding',
    direct: 'into a contour that declares no entry',
  },
  layers: {
    runs: 'an entry point — a package.json script, a workflow step or a hook — and the files its command names',
    file: 'a file name that a module calling a node:fs write and a module calling a node:fs read both name; a candidate, not traced',
  },
}

const SORTS = ['name', 'edges', 'state']

const SCRIPT_SAFE: Record<string, string> = { '<': '\\u003c', '>': '\\u003e', '&': '\\u0026', '\u2028': '\\u2028', '\u2029': '\\u2029' }

export function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, character => SCRIPT_SAFE[character])
}

function pageData(map: ComponentMap, mechanics: NonNullable<AtlasInput['mechanics']>, rootFromPage: string, links: SourceLinks): unknown {
  const { files, drawn: stateOf } = drawnFiles(map, mechanics)
  const index = new Map(files.map((file, at) => [file, at]))
  const countsOf = (counts: { held: number, unknown: number, absent: number }): number[] => MAP_STATES.map(state => counts[state])
  const entries = entryMap(mechanics.relations)
  return {
    root: rootFromPage,
    source: links,
    files,
    states: files.map(file => stateOf.get(file)?.state ?? 'unknown'),
    reasons: Object.fromEntries(files.flatMap(file => stateOf.get(file)?.reason == null ? [] : [[file, stateOf.get(file)?.reason]])),
    groups: map.groups.map(group => ({ ...group, counts: countsOf(group.counts) })),
    contours: map.contours.map(contour => ({
      id: contour.id,
      name: contour.name,
      kind: contour.kind,
      declaredBy: contour.declaredBy,
      entries: contour.entries,
      state: contour.state,
      counts: countsOf(contour.counts),
      components: contour.components.map(component => ({ id: component.id, name: component.name, purpose: component.purpose, undeclaredContour: component.undeclaredContour, state: component.state, counts: countsOf(component.counts), files: component.files.map(file => index.get(file.path)), misplaced: component.misplaced.map(file => index.get(file)) })),
    })),
    relations: map.relations.map(relation => [index.get(relation.from), index.get(relation.to), lineOf(relation.at), CROSSINGS.indexOf(relation.crossing)]),
    unresolved: mechanics.relations.filter(relation => relation.to == null && isCodeRelation(relation)).map(relation => [index.get(relation.from), relation.source.line, relation.specifier]),
    arrows: map.arrows,
    open: map.open,
    entrySources: entries.sources,
    entries: entries.entries.map(entry => ({ id: entry.id, kind: entry.kind, name: entry.name, source: index.get(entry.source), line: lineOf(entry.at), runs: entry.runs.map(file => index.get(file)) })),
    channels: channelMap(mechanics.relations).map(channel => [index.get(channel.writer), lineOf(channel.writerAt), index.get(channel.reader), lineOf(channel.readerAt), channel.file]),
  }
}

function lineOf(at: string): number {
  return Number(at.slice(at.lastIndexOf(':') + 1))
}

export function mapOf(input: AtlasInput): ComponentMap | null {
  if (input.mechanics == null)
    return null
  return componentMap({ contours: [], ...input.mechanics }, input.model.interpretation?.components ?? [], input.repo.name.text)
}

export function atlasScript(input: AtlasInput, rootFromPage: string, map = mapOf(input)): string | null {
  if (input.mechanics == null || map == null)
    return null
  return ATLAS_SCRIPT.split(ATLAS_DATA_MARK).join(scriptSafeJson(pageData(map, input.mechanics, rootFromPage, input.links ?? RELATIVE_LINKS)))
}

export function sha256Source(source: string): string {
  return `'sha256-${createHash('sha256').update(source).digest('base64')}'`
}

export function contentPolicy(script: string | null, style: string): string {
  return [`default-src 'none'`, `style-src ${sha256Source(style)}`, `script-src ${script == null ? `'none'` : sha256Source(script)}`, `base-uri 'none'`, `form-action 'none'`].join('; ')
}

function legend(): string {
  const states = MAP_STATES.map(state => `<li data-state="${state}"><b>${state}</b> — ${escaped(WORDS.states[state])}</li>`).join('')
  const crossings = CROSSINGS.map(crossing => `<li data-crossing="${crossing}"><b>${crossing}</b> — ${escaped(WORDS.crossings[crossing])}</li>`).join('')
  const layers = Object.entries(WORDS.layers).map(([layer, meaning]) => `<li data-layer="${layer}"><b>${layer}</b> — ${escaped(meaning)}</li>`).join('')
  return `<section class="panelbox" aria-labelledby="atlas-legend-heading">
<div class="ph"><h2 id="atlas-legend-heading">${escaped(WORDS.legend)}</h2><span class="meta">${escaped(WORDS.legendKinds)}</span></div>
<ul class="legend">${states}${crossings}${layers}</ul>
</section>`
}

function filters(): string {
  const crossings = CROSSINGS.map(crossing => `<button type="button" data-filter="${crossing}" data-crossing="${crossing}" aria-pressed="true" title="${escaped(WORDS.crossings[crossing])}">${crossing}</button>`)
  const layers = Object.entries(WORDS.layers).map(([layer, meaning]) => `<button type="button" data-filter="${layer}" data-layer="${layer}" aria-pressed="true" title="${escaped(meaning)}">${layer}</button>`)
  return `<span class="tool-k">${escaped(WORDS.edges)}</span><div id="atlas-legend" role="group" aria-label="${escaped(WORDS.filters)}">${[...crossings, ...layers].join('')}</div>`
}

function sorts(): string {
  return `<span class="tool-k">${escaped(WORDS.sortParts)}</span><div id="atlas-sort" role="group" aria-label="${escaped(WORDS.sorts)}">${SORTS.map(sort => `<button type="button" data-sort="${sort}" aria-pressed="false">${sort}</button>`).join('')}</div>`
}

export function mapSection(script: string | null, generatedFrom = ''): string {
  if (script == null)
    return `<p class="notice" data-no-mechanics>${escaped(WORDS.noMechanics(generatedFrom))}</p>`
  return `<section class="panelbox atlas-map" aria-labelledby="atlas-map-heading">
<div class="ph"><h2 id="atlas-map-heading">${escaped(WORDS.heading)}</h2><span class="meta">${escaped(WORDS.levels)}</span><span class="meta">${escaped(WORDS.gestures)}</span></div>
<p class="hint"><b>${escaped(WORDS.click)}</b>${escaped(WORDS.hint)}</p>
<div class="tools"><div class="search-wrap"><input id="atlas-search" type="search" placeholder="${escaped(WORDS.searchPlaceholder)}" aria-label="${escaped(WORDS.search)}"></div><ul id="atlas-results"></ul></div>
<div class="tools">${filters()}${sorts()}</div>
<p id="atlas-hidden" class="empty" hidden></p>
<div class="canvas"><svg id="atlas-svg" role="img" aria-label="${escaped(WORDS.label)}"><g id="atlas-viewport"></g></svg><div id="atlas-tip" hidden></div><aside id="atlas-panel" aria-label="${escaped(WORDS.inspector)}"><p data-empty-hint><b>${escaped(WORDS.inspector)}</b><br>${escaped(WORDS.inspectorHint)}</p></aside></div>
</section>
${legend()}`
}
