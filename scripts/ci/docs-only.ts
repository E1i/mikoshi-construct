import { appendFileSync } from 'node:fs'
import process from 'node:process'
import { isDocsOnly } from './required.js'

const paths = process.argv.slice(2)
const docsOnly = isDocsOnly(paths)

console.log(docsOnly ? `Docs-only: ${paths.length} path(s) under .changeset/, docs/ or CHANGELOG.md; the preset matrix is skipped.` : 'Not docs-only; the preset matrix runs.')

if (process.env.GITHUB_OUTPUT)
  appendFileSync(process.env.GITHUB_OUTPUT, `docs-only=${docsOnly}\n`)
