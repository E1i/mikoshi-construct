import type { Needs, RunJob } from './required.js'
import { appendFileSync } from 'node:fs'
import process from 'node:process'
import { GhCiRuns } from '../ports/ci-reading.js'
import { ABANDONED_TITLE, blockingJobs, ranNeeds, requiredSummary, rerunDue } from './required.js'

function jobsOfThisRun(env: NodeJS.ProcessEnv): RunJob[] | null {
  const runId = Number(env.GITHUB_RUN_ID)
  if (!Number.isInteger(runId) || runId <= 0)
    return null
  const read = new GhCiRuns().jobsOfRun(runId)
  return read.kind === 'read' ? read.value.jobs : null
}

const needs = JSON.parse(process.env.NEEDS ?? '{}') as Needs
const blocking = blockingJobs(needs, ranNeeds(needs, jobsOfThisRun(process.env)))
const summary = requiredSummary(blocking)

if (process.env.GITHUB_STEP_SUMMARY !== undefined)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`)

if (blocking.length > 0) {
  if (rerunDue(blocking))
    console.log(`::error title=${ABANDONED_TITLE}::${summary}`)
  console.error(summary)
  process.exit(1)
}

console.log(summary)
