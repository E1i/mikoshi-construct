import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { weightsFromVitestReport } from './shard.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')
const report = process.argv[2] ?? '.construct/reports/vitest.json'
const weights = weightsFromVitestReport(JSON.parse(readFileSync(path.resolve(REPO_ROOT, report), 'utf8')), REPO_ROOT)
writeFileSync(path.join(REPO_ROOT, 'scripts/ci/test-weights.json'), `${JSON.stringify(weights, null, 2)}\n`)
console.log(`scripts/ci/test-weights.json: ${Object.keys(weights).length} files from ${report}`)
