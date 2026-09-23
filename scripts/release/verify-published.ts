import { appendFileSync, readFileSync } from 'node:fs'
import process from 'node:process'
import { readReleaseRoute } from './changesets.js'
import { describeOutcome, EXIT_CODE, pollForVersion, REGISTRY } from './registry.js'

const TIMEOUT_MS = 180_000
const DELAY_MS = 15_000

const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { name: string, version: string }
const request = { packageName: manifest.name, version: manifest.version }

const outcome = await pollForVersion(request, {
  fetchers: REGISTRY,
  now: () => Date.now(),
  sleep: async milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  timeoutMs: TIMEOUT_MS,
  delayMs: DELAY_MS,
})

const message = describeOutcome(outcome, request, readReleaseRoute())
const summaryPath = process.env.GITHUB_STEP_SUMMARY

if (outcome === 'installable')
  console.log(message)
else
  console.error(message)

if (summaryPath)
  appendFileSync(summaryPath, `${message}\n`)

process.exit(EXIT_CODE[outcome])
