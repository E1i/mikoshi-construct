import { readFileSync, writeFileSync } from 'node:fs'
import { loadCompositionModels } from './files.js'
import { embed } from './render.js'

for (const { model, docPath } of loadCompositionModels()) {
  const doc = readFileSync(docPath, 'utf8')
  const next = embed(doc, model, model.doc)
  if (next !== doc)
    writeFileSync(docPath, next)
  console.warn(`[composition] ${model.id} → ${model.doc}`)
}
