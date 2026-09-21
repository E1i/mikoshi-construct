import { readFileSync } from 'node:fs'
import process from 'node:process'
import { pictureOfModel } from '../../src/model/graph.js'
import { readModel } from '../../src/model/write.js'
import { PICTURE_DOC, PICTURE_DOC_PATH, REPO_ROOT, staleProblems } from './render.js'

const problems = staleProblems(readFileSync(PICTURE_DOC_PATH, 'utf8'), pictureOfModel(readModel(REPO_ROOT), REPO_ROOT), PICTURE_DOC)

if (problems.length > 0) {
  console.error(problems.join('\n'))
  process.exit(1)
}
