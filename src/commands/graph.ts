import type { ModelPicture, StateSource } from '../model/graph.js'
import type { Ui, Writer } from '../ui/console.js'
import path from 'node:path'
import { PICTURE_PROSE, pictureOfModel } from '../model/graph.js'
import { deriveModelState } from '../model/state.js'
import { readModel } from '../model/write.js'

export function modelPicture(dir: string, states: StateSource = deriveModelState): ModelPicture {
  const root = path.resolve(dir)
  return pictureOfModel(readModel(root), root, states)
}

export function printGraph(ui: Ui, picture: ModelPicture, write: Writer): number {
  if (picture.at === 'drawn') {
    write(picture.mermaid)
    return 0
  }
  ui.line(ui.lore.graphNothingDrawn(PICTURE_PROSE[picture.at]))
  return 0
}
