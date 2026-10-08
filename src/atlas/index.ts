import type { Ui } from '../ui/console.js'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { detectExisting } from '../detect/existing.js'
import { writeEngram } from '../model/discovery.js'
import { MODEL_FILE } from '../model/schema.js'
import { deriveModelState } from '../model/state.js'
import { readModel } from '../model/write.js'
import { renderAtlas } from './page.js'

export const ATLAS_PAGE_FILE = 'atlas.html'
export const OWNED_DIR = '.construct'

export const ATLAS_EXIT = {
  written: 0,
} as const

export interface AtlasOptions {
  dir: string
  home: string
  attached: boolean
  out?: string
}

export interface AtlasWritten {
  engram: string
  page: string
}

function defaultPage(root: string, ownsDir: boolean, engram: string): string {
  return ownsDir ? path.join(root, OWNED_DIR, ATLAS_PAGE_FILE) : path.join(path.dirname(engram), ATLAS_PAGE_FILE)
}

function rootFrom(page: string, root: string): string {
  return path.relative(path.dirname(page), root).split(path.sep).join('/')
}

export function runAtlas(options: AtlasOptions): AtlasWritten {
  const root = path.resolve(options.dir)
  const constructed = detectExisting(root).constructJson
  const engram = writeEngram(root, { attached: !constructed, home: options.home })
  const model = readModel(path.dirname(engram))
  if (model == null)
    throw new Error(`${engram} was written and cannot be read back`)
  const page = options.out == null ? defaultPage(root, constructed || options.attached, engram) : path.resolve(options.out)
  mkdirSync(path.dirname(page), { recursive: true })
  const input = { projectName: path.basename(root), model, states: deriveModelState(model, root), mechanics: model.mechanics }
  writeFileSync(page, renderAtlas(input, MODEL_FILE, rootFrom(page, root)))
  return { engram, page }
}

export function printAtlas(ui: Ui, written: AtlasWritten): number {
  ui.line(ui.lore.graphPageWritten(written.page))
  return ATLAS_EXIT.written
}
