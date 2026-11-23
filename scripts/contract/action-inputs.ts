import { readdirSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

export const ACTION_INPUTS_RECORD = 'contract/action-inputs.json'
const WORKFLOWS_DIR = '.github/workflows'
export const REPO_ROOT = path.resolve(import.meta.dirname, '../..')

export type RecordedInputs = Record<string, string[]>

export interface PinnedStep {
  workflow: string
  job: string
  step: number
  uses: string
  keys: string[]
}

export type Fetcher = (apiPath: string) => Promise<string | undefined>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isPinnedAction(uses: string): boolean {
  return !uses.startsWith('./') && !uses.startsWith('docker://') && uses.includes('@')
}

export function pinnedSteps(workflow: string, text: string): PinnedStep[] {
  const document: unknown = parse(text)
  const jobs = isRecord(document) && isRecord(document.jobs) ? document.jobs : {}
  return Object.entries(jobs).flatMap(([job, body]) => {
    const steps = isRecord(body) && Array.isArray(body.steps) ? body.steps : []
    return steps.flatMap((step: unknown, index: number) => {
      if (!isRecord(step) || typeof step.uses !== 'string' || !isPinnedAction(step.uses))
        return []
      const keys = isRecord(step.with) ? Object.keys(step.with) : []
      return [{ workflow, job, step: index + 1, uses: step.uses, keys }]
    })
  })
}

export function refusals(steps: PinnedStep[], recorded: RecordedInputs): string[] {
  return steps.flatMap((step) => {
    const where = `${step.workflow} ${step.job} step ${step.step} (${step.uses})`
    const inputs = recorded[step.uses]
    if (inputs === undefined)
      return [`${where}: no inputs recorded for this pin in ${ACTION_INPUTS_RECORD}; the contract:actions:fetch script records them`]
    return step.keys.filter(key => !inputs.includes(key)).map(key => `${where}: with key '${key}' is not an input the pinned action declares (${inputs.join(', ')})`)
  })
}

export function declaredInputs(actionYml: string): string[] {
  const document: unknown = parse(actionYml)
  return isRecord(document) && isRecord(document.inputs) ? Object.keys(document.inputs).sort() : []
}

export function actionYmlPaths(uses: string): string[] {
  const [location = '', ref = ''] = uses.split('@')
  const [owner, repo, ...subpath] = location.split('/')
  const base = ['repos', owner, repo, 'contents', ...subpath].join('/')
  return [`${base}/action.yml?ref=${ref}`, `${base}/action.yaml?ref=${ref}`]
}

export function workflowSteps(root: string): PinnedStep[] {
  const dir = path.join(root, WORKFLOWS_DIR)
  return readdirSync(dir)
    .filter(name => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort()
    .flatMap(name => pinnedSteps(`${WORKFLOWS_DIR}/${name}`, readFileSync(path.join(dir, name), 'utf8')))
}

export function readRecordedInputs(root: string): RecordedInputs {
  return JSON.parse(readFileSync(path.join(root, ACTION_INPUTS_RECORD), 'utf8')) as RecordedInputs
}

export function renderRecordedInputs(recorded: RecordedInputs): string {
  return `${JSON.stringify(Object.fromEntries(Object.keys(recorded).sort().map(pin => [pin, recorded[pin]!])), null, 2)}\n`
}

export async function fetchMissing(steps: PinnedStep[], recorded: RecordedInputs, fetcher: Fetcher): Promise<RecordedInputs> {
  const missing = [...new Set(steps.map(step => step.uses))].filter(pin => recorded[pin] === undefined)
  const fetched: RecordedInputs = {}
  for (const pin of missing) {
    let body: string | undefined
    for (const apiPath of actionYmlPaths(pin)) {
      body = await fetcher(apiPath)
      if (body !== undefined)
        break
    }
    if (body === undefined)
      throw new Error(`no action.yml found for ${pin}`)
    fetched[pin] = declaredInputs(body)
  }
  return { ...recorded, ...fetched }
}

function main(): void {
  const refused = refusals(workflowSteps(REPO_ROOT), readRecordedInputs(REPO_ROOT))
  for (const line of refused)
    console.error(line)
  if (refused.length > 0)
    process.exitCode = 1
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  main()
