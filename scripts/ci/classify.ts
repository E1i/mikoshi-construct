import { appendFileSync } from 'node:fs'
import process from 'node:process'
import { isFastPath } from './fast-path.js'

const paths = process.argv.slice(2)
const fastPath = isFastPath(paths)

console.log(fastPath ? `Fast path: ${paths.length} path(s), all under docs/ or top-level architecture/*.md; the package and the preset matrix are skipped.` : 'Full path: the package and the preset matrix run.')

if (process.env.GITHUB_OUTPUT)
  appendFileSync(process.env.GITHUB_OUTPUT, `fast-path=${fastPath}\n`)
