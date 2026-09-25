import { readFileSync } from 'node:fs'
import process from 'node:process'
import { loadCompositionModels, missingPaths } from './files.js'
import { extractEmbedded, renderEmbedded } from './render.js'

const problems: string[] = []

for (const { model, file, docPath } of loadCompositionModels()) {
  for (const missing of missingPaths(model))
    problems.push(`${file}: path "${missing}" does not exist`)
  const doc = readFileSync(docPath, 'utf8')
  if (extractEmbedded(doc, model, model.doc) !== renderEmbedded(model))
    problems.push(`${model.doc}: the ${model.id} diagram is out of date with ${file}; run pnpm composition:render`)
}

if (problems.length > 0) {
  console.error(problems.join('\n'))
  process.exit(1)
}
