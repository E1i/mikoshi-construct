import { realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { execGh } from '../ports/gh.js'
import { ACTION_INPUTS_RECORD, fetchMissing, readRecordedInputs, renderRecordedInputs, REPO_ROOT, workflowSteps } from './action-inputs.js'

async function readThroughGithubPort(apiPath: string): Promise<string | undefined> {
  const result = execGh(['api', '-H', 'Accept: application/vnd.github.raw', apiPath])
  if (result.kind === 'ran')
    return result.stdout
  if (/HTTP 404/.test(result.reason))
    return undefined
  throw new Error(`the GitHub port could not read ${apiPath}: ${result.reason}`)
}

async function main(): Promise<void> {
  const recorded = await fetchMissing(workflowSteps(REPO_ROOT), readRecordedInputs(REPO_ROOT), readThroughGithubPort)
  writeFileSync(path.join(REPO_ROOT, ACTION_INPUTS_RECORD), renderRecordedInputs(recorded))
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  await main()
