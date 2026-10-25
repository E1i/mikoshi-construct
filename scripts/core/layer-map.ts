import { readFileSync } from 'node:fs'
import path from 'node:path'
import { FACTORY_RUNTIME } from './factory-paths.js'

export const LAYER_MAP = FACTORY_RUNTIME.layerMap

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')

export interface LayerMap {
  files: Readonly<Record<string, string>>
  folders: Readonly<Record<string, string>>
}

export function readLayerMap(root: string = REPO_ROOT): LayerMap {
  return JSON.parse(readFileSync(path.join(root, LAYER_MAP), 'utf8')) as LayerMap
}

export function layersIn(map: LayerMap, file: string): string[] {
  const entry = map.files[file]
  if (entry !== undefined)
    return [entry]
  return Object.entries(map.folders).filter(([folder]) => file.startsWith(folder)).map(([, layer]) => layer)
}
