import type { Ui } from '../ui/console.js'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { detectExisting } from '../detect/existing.js'
import { readAtlasRecord } from '../manifest.js'
import { writeEngram } from '../model/discovery.js'
import { MODEL_FILE } from '../model/schema.js'
import { deriveModelState } from '../model/state.js'
import { readModel } from '../model/write.js'
import { PLAIN_LORE } from '../ui/lore.js'
import { renderAtlasDocs } from './docs.js'
import { repoIdentity } from './identity.js'
import { renderAtlas } from './page.js'
import { readRemoteBlob } from './remote.js'
import { editorTemplate } from './source-link.js'
import { docsFileOf } from './switch.js'

export const ATLAS_PAGE_FILE = 'atlas.html'
export const OWNED_ATLAS_PAGE = '.construct/atlas.html'

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
  interpreted: boolean
}

export class AtlasRefusedUnconstructed extends Error {
  constructor() {
    super(PLAIN_LORE.atlasRefusedUnconstructed)
  }
}

function defaultPage(root: string, ownsDir: boolean, engram: string): string {
  return ownsDir ? path.join(root, OWNED_ATLAS_PAGE) : path.join(path.dirname(engram), ATLAS_PAGE_FILE)
}

function rootFrom(page: string, root: string): string {
  return path.relative(path.dirname(page), root).split(path.sep).join('/')
}

export function runAtlas(options: AtlasOptions): AtlasWritten {
  const root = path.resolve(options.dir)
  const constructed = detectExisting(root).constructJson
  if (!constructed && !options.attached)
    throw new AtlasRefusedUnconstructed()
  const engram = writeEngram(root, { attached: options.attached || !constructed, home: options.home })
  const model = readModel(path.dirname(engram))
  if (model == null)
    throw new Error(`${engram} was written and cannot be read back`)
  const page = options.out == null ? defaultPage(root, constructed || options.attached, engram) : path.resolve(options.out)
  mkdirSync(path.dirname(page), { recursive: true })
  const links = { template: constructed ? editorTemplate(readAtlasRecord(root)?.open) : null, remote: readRemoteBlob(root) }
  const input = { repo: repoIdentity(root), model, states: deriveModelState(model, root), mechanics: model.mechanics, links }
  const modeFiles = constructed && !options.attached ? { map: path.basename(page), docs: docsFileOf(page) } : undefined
  writeFileSync(page, renderAtlas(input, MODEL_FILE, rootFrom(page, root), modeFiles))
  if (modeFiles != null)
    writeFileSync(path.join(path.dirname(page), modeFiles.docs), renderAtlasDocs(input, MODEL_FILE, rootFrom(page, root), modeFiles))
  return { engram, page, interpreted: (model.interpretation?.components.length ?? 0) > 0 }
}

export function printAtlas(ui: Ui, written: AtlasWritten): number {
  if (!written.interpreted)
    ui.line(ui.lore.atlasNothingInterpreted)
  ui.line(ui.lore.atlasPageWritten(written.page))
  return ATLAS_EXIT.written
}
