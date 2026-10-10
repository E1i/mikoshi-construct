import type { ComponentMap } from './components.js'
import type { AtlasInput } from './view.js'
import { createHash } from 'node:crypto'
import { escaped } from '../model/page.js'
import { ATLAS_DATA_MARK, ATLAS_SCRIPT } from './client.js'
import { componentMap, CROSSINGS, MAP_STATES } from './components.js'

const WORDS = {
  label: 'The map of contours, their parts and the arrows between them',
  search: 'Find a file by name',
  hint: 'Click a contour to unfold its parts, a part to list its files, a file to see what it reaches and what reaches it. Drag to pan, scroll to zoom.',
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
}

const SCRIPT_SAFE: Record<string, string> = { '<': '\\u003c', '>': '\\u003e', '&': '\\u0026', '\u2028': '\\u2028', '\u2029': '\\u2029' }

export function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, character => SCRIPT_SAFE[character])
}

function pageData(map: ComponentMap, mechanics: NonNullable<AtlasInput['mechanics']>, rootFromPage: string): unknown {
  const paths = new Set(mechanics.components.map(component => component.path))
  for (const contour of map.contours) {
    for (const component of contour.components)
      component.files.forEach(file => paths.add(file.path))
  }
  const files = [...paths].sort()
  const index = new Map(files.map((file, at) => [file, at]))
  const stateOf = new Map(map.contours.flatMap(contour => contour.components.flatMap(component => component.files.map(file => [file.path, file] as const))))
  const countsOf = (counts: { held: number, unknown: number, absent: number }): number[] => MAP_STATES.map(state => counts[state])
  return {
    root: rootFromPage,
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
      components: contour.components.map(component => ({ id: component.id, name: component.name, purpose: component.purpose, undeclaredContour: component.undeclaredContour, state: component.state, counts: countsOf(component.counts), files: component.files.map(file => index.get(file.path)) })),
    })),
    relations: map.relations.map(relation => [index.get(relation.from), index.get(relation.to), Number(relation.at.slice(relation.at.lastIndexOf(':') + 1)), CROSSINGS.indexOf(relation.crossing)]),
    unresolved: mechanics.relations.filter(relation => relation.to == null).map(relation => [index.get(relation.from), relation.source.line, relation.specifier]),
    arrows: map.arrows,
    open: map.open,
  }
}

export function atlasScript(input: AtlasInput, rootFromPage: string): string | null {
  if (input.mechanics == null)
    return null
  const map = componentMap({ contours: [], ...input.mechanics }, input.model.interpretation?.components ?? [], input.projectName)
  return ATLAS_SCRIPT.split(ATLAS_DATA_MARK).join(scriptSafeJson(pageData(map, input.mechanics, rootFromPage)))
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
  return `<ul class="legend">${states}${crossings}</ul>`
}

export function mapSection(script: string | null): string {
  if (script == null)
    return ''
  return `<section class="atlas-map" aria-label="${escaped(WORDS.label)}">
<p class="prose">${escaped(WORDS.hint)}</p>
<div class="tools"><input id="atlas-search" type="search" placeholder="${escaped(WORDS.search)}" aria-label="${escaped(WORDS.search)}"><ul id="atlas-results"></ul></div>
<div class="canvas"><svg id="atlas-svg" role="img" aria-label="${escaped(WORDS.label)}"><g id="atlas-viewport"></g></svg><div id="atlas-tip" hidden></div><aside id="atlas-panel"></aside></div>
${legend()}
</section>`
}
