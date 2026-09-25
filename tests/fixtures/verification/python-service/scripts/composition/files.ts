import type { CompositionModel } from './model.js'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseCompositionModel } from './model.js'

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const COMPOSITION_DIR = path.join(REPO_ROOT, 'architecture/composition')

export interface LoadedModel {
  model: CompositionModel
  file: string
  docPath: string
}

export function loadCompositionModels(dir = COMPOSITION_DIR): LoadedModel[] {
  if (!existsSync(dir))
    return []
  return readdirSync(dir)
    .filter(file => file.endsWith('.yaml'))
    .sort()
    .map((file) => {
      const model = parseCompositionModel(readFileSync(path.join(dir, file), 'utf8'), file)
      if (`${model.id}.yaml` !== file)
        throw new Error(`${file}: the file must be named after its id "${model.id}"`)
      return { model, file, docPath: path.join(REPO_ROOT, model.doc) }
    })
}

export function missingPaths(model: CompositionModel, root = REPO_ROOT): string[] {
  return model.nodes
    .flatMap(node => (node.path == null ? [] : [node.path]))
    .filter(candidate => !existsSync(path.join(root, candidate)))
}
