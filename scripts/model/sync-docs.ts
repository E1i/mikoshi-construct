import { readFileSync, writeFileSync } from 'node:fs'
import { pictureOfModel } from '../../src/model/graph.js'
import { readModel } from '../../src/model/write.js'
import { embed, PICTURE_DOC, PICTURE_DOC_PATH, REPO_ROOT } from './render.js'

const picture = pictureOfModel(readModel(REPO_ROOT), REPO_ROOT)
const doc = readFileSync(PICTURE_DOC_PATH, 'utf8')
const next = embed(doc, picture, PICTURE_DOC)
if (next !== doc)
  writeFileSync(PICTURE_DOC_PATH, next)
console.warn(`[model] ${picture.at} → ${PICTURE_DOC}`)
