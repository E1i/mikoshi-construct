import { appendFileSync, readFileSync } from 'node:fs'
import process from 'node:process'
import { readStageRecord, STAGE_RECORD_FILE, stageFor, stageSummary } from './stage.js'

const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { name: string, version: string }
const summary = stageSummary(stageFor(readStageRecord(STAGE_RECORD_FILE), manifest.version), manifest.name)

console.log(summary)

if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)
