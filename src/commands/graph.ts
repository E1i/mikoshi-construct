import type { ModelGraph, ModelPicture, StateSource } from '../model/graph.js'
import type { Ui, Writer } from '../ui/console.js'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { graphOfModel, PICTURE_PROSE, pictureOfModel } from '../model/graph.js'
import { htmlFromGraph } from '../model/page.js'
import { MODEL_FILE } from '../model/schema.js'
import { deriveModelState } from '../model/state.js'
import { readModel } from '../model/write.js'

export function modelPicture(dir: string, states: StateSource = deriveModelState): ModelPicture {
  const root = path.resolve(dir)
  return pictureOfModel(readModel(root), root, states)
}

export function modelGraph(dir: string, states: StateSource = deriveModelState): ModelGraph | null {
  const root = path.resolve(dir)
  const model = readModel(root)
  if (model == null || (model.facts.length === 0 && model.claims.length === 0 && model.hypotheses.length === 0))
    return null
  return graphOfModel(model, states(model, root))
}

export function pageOfGraph(graph: ModelGraph, projectName: string): string {
  return htmlFromGraph(graph, {
    title: `What ${projectName} claims, and what holds it up`,
    prose: PICTURE_PROSE.drawn,
    generatedFrom: MODEL_FILE,
  })
}

export const GRAPH_EXIT = {
  drawn: 0,
  nothingDrawn: 0,
} as const

export function printGraph(ui: Ui, picture: ModelPicture, write: Writer): number {
  if (picture.at === 'drawn') {
    write(picture.mermaid)
    return GRAPH_EXIT.drawn
  }
  ui.line(ui.lore.graphNothingDrawn(PICTURE_PROSE[picture.at]))
  return GRAPH_EXIT.nothingDrawn
}

export function writeGraphPage(dir: string, out: string, states: StateSource = deriveModelState): string | null {
  const graph = modelGraph(dir, states)
  if (graph == null)
    return null
  const target = path.resolve(out)
  writeFileSync(target, pageOfGraph(graph, path.basename(path.resolve(dir))))
  return target
}
