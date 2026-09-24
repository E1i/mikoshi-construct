import { appendFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { requestCancel, runIdentityFrom } from './cancel-run.js'
import { readReleaseRoute } from './changesets.js'
import { describeOutcome, describeStaged, EXIT_CODE, pollForVersion, REGISTRY, withStage } from './registry.js'
import { readStageRecord, STAGE_ARTIFACT, STAGE_RECORD_FILE, stageFor } from './stage.js'

const TIMEOUT_MS = 180_000
const DELAY_MS = 15_000
const CANCEL_GRACE_MS = 120_000

const sleep = async (milliseconds: number): Promise<void> => new Promise(resolve => setTimeout(resolve, milliseconds))

const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { name: string, version: string }
const request = { packageName: manifest.name, version: manifest.version }
const stage = stageFor(readStageRecord(path.join(STAGE_ARTIFACT, STAGE_RECORD_FILE)), manifest.version)

const polled = await pollForVersion(request, {
  fetchers: REGISTRY,
  now: () => Date.now(),
  sleep,
  timeoutMs: TIMEOUT_MS,
  delayMs: DELAY_MS,
})

const outcome = withStage(polled, stage)
const message = stage && outcome === 'staged' ? describeStaged(stage, manifest.name) : describeOutcome(polled, request, readReleaseRoute())
const summaryPath = process.env.GITHUB_STEP_SUMMARY

if (outcome === 'installable')
  console.log(message)
else if (outcome === 'staged')
  console.log(`::notice title=Release pending approval::${message}`)
else
  console.error(message)

if (summaryPath)
  appendFileSync(summaryPath, `${message}\n`)

if (outcome === 'staged') {
  const run = runIdentityFrom(process.env)
  if (run && await requestCancel(run, fetch))
    await sleep(CANCEL_GRACE_MS)
  console.error('This run could not be held as pending, so it ends red rather than green; the stage still awaits approval.')
}

process.exit(EXIT_CODE[outcome])
