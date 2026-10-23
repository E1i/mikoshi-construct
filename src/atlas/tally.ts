import type { ComponentMap, MapFile, MapState } from './components.js'
import type { AtlasMechanics } from './view.js'
import { MAP_STATES } from './components.js'
import { entryMap } from './entries.js'

export interface DrawnFiles {
  files: string[]
  drawn: Map<string, MapFile>
}

export interface AtlasTally {
  contours: number
  parts: number
  files: number
  states: Record<MapState, number>
  entries: number
  relations: number
}

export function drawnFiles(map: ComponentMap, mechanics: AtlasMechanics): DrawnFiles {
  const drawn = new Map(map.contours.flatMap(contour => contour.components.flatMap(component => component.files.map(file => [file.path, file] as const))))
  const files = [...new Set([...mechanics.components.map(component => component.path), ...drawn.keys()])].sort()
  return { files, drawn }
}

export function tallyOf(map: ComponentMap, mechanics: AtlasMechanics): AtlasTally {
  const { files, drawn } = drawnFiles(map, mechanics)
  const states = Object.fromEntries(MAP_STATES.map(state => [state, 0])) as Record<MapState, number>
  files.forEach(file => states[drawn.get(file)?.state ?? 'unknown'] += 1)
  return {
    contours: map.contours.length,
    parts: map.contours.reduce((total, contour) => total + contour.components.length, 0),
    files: files.length,
    states,
    entries: entryMap(mechanics.relations).entries.length,
    relations: map.relations.length,
  }
}
