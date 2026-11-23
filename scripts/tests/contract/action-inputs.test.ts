import type { GhCall } from '../../ports/gh.js'
import { readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ACTION_INPUTS_RECORD, actionYmlPaths, declaredInputs, fetchMissing, pinnedSteps, readRecordedInputs, refusals, renderRecordedInputs, workflowSteps } from '../../contract/action-inputs.js'

const fetchScript = vi.hoisted(() => ({
  record: 'contract/action-inputs.json',
  answer: undefined as ((apiPath: string) => GhCall) | undefined,
  recordedText: undefined as string | undefined,
  asked: [] as string[],
  written: [] as Array<{ file: string, text: string }>,
}))

vi.mock('../../ports/gh.js', async (original) => {
  const gh = await original<typeof import('../../ports/gh.js')>()
  return {
    ...gh,
    execGh: (args: string[]): GhCall => {
      const apiPath = args.at(-1) ?? ''
      fetchScript.asked.push(apiPath)
      return fetchScript.answer!(apiPath)
    },
  }
})

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  const readFileSync = ((file: Parameters<typeof fs.readFileSync>[0], options?: Parameters<typeof fs.readFileSync>[1]) =>
    fetchScript.recordedText !== undefined && String(file).endsWith(fetchScript.record) ? fetchScript.recordedText : fs.readFileSync(file, options)) as typeof fs.readFileSync
  const writeFileSync = ((file: Parameters<typeof fs.writeFileSync>[0], text: Parameters<typeof fs.writeFileSync>[1]) => {
    fetchScript.written.push({ file: String(file), text: String(text) })
  }) as typeof fs.writeFileSync
  return { ...fs, default: { ...fs, readFileSync, writeFileSync }, readFileSync, writeFileSync }
})

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const FETCH_SCRIPT = realpathSync(path.join(REPO_ROOT, 'scripts/contract/action-inputs-fetch.ts'))
const ARGV_ENTRY = process.argv[1]

afterEach(() => {
  process.argv[1] = ARGV_ENTRY!
  fetchScript.answer = undefined
  fetchScript.recordedText = undefined
  fetchScript.asked.length = 0
  fetchScript.written.length = 0
})

async function runFetchScript(answer: (apiPath: string) => GhCall): Promise<void> {
  fetchScript.answer = answer
  fetchScript.recordedText = '{}\n'
  process.argv[1] = FETCH_SCRIPT
  vi.resetModules()
  await import('../../contract/action-inputs-fetch.js')
}

function ghFailed(apiPath: string, detail: string): GhCall {
  return { kind: 'failed', cause: 'failed', reason: `gh api -H Accept: application/vnd.github.raw ${apiPath}: ${detail}`, stdout: '', stderr: detail, attempts: 1 }
}

const RELEASE_WORKFLOW = `
on: push
jobs:
  release:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v7
      - run: pnpm install
      - name: Version or publish
        uses: changesets/action@v2
        with:
          publish-script: pnpm release
          createGithubReleases: false
      - uses: ./local-action
        with:
          anything: true
`

const RECORDED = {
  'actions/checkout@v7': ['fetch-depth', 'ref'],
  'changesets/action@v2': ['commit-message', 'create-github-releases', 'publish-script', 'version-script'],
}

describe('a workflow step\'s with: keys are checked against the pinned action\'s recorded inputs', () => {
  it('a with key the pinned action does not declare is refused', () => {
    const refused = refusals(pinnedSteps('release.yml', RELEASE_WORKFLOW), RECORDED)
    expect(refused).toHaveLength(1)
    expect(refused[0]).toContain('changesets/action@v2')
    expect(refused[0]).toContain('\'createGithubReleases\'')
  })

  it('names the step a refusal is about by its one-based position in the job', () => {
    expect(pinnedSteps('release.yml', RELEASE_WORKFLOW).map(step => step.step)).toEqual([1, 3])
    expect(refusals(pinnedSteps('release.yml', RELEASE_WORKFLOW), RECORDED)[0]).toContain('release.yml release step 3 (changesets/action@v2)')
  })

  it('leaves a docker:// step unchecked, though its image is pinned with @', () => {
    const withDocker = `${RELEASE_WORKFLOW.replace('createGithubReleases', 'create-github-releases')}      - uses: docker://alpine@sha256:0123456789abcdef
        with:
          args: echo
`
    expect(pinnedSteps('release.yml', withDocker).map(step => step.uses)).toEqual(['actions/checkout@v7', 'changesets/action@v2'])
    expect(refusals(pinnedSteps('release.yml', withDocker), RECORDED)).toEqual([])
  })

  it('a pin with no recorded inputs is refused', () => {
    const { 'actions/checkout@v7': _checkout, ...withoutCheckout } = RECORDED
    const refused = refusals(pinnedSteps('release.yml', RELEASE_WORKFLOW.replace('createGithubReleases', 'create-github-releases')), withoutCheckout)
    expect(refused).toEqual([expect.stringContaining('actions/checkout@v7')])
    expect(refused[0]).toContain('no inputs recorded')
  })

  it('a pin is checked by its exact ref, so a bump to an unrecorded version is refused', () => {
    const bumped = RELEASE_WORKFLOW.replace('changesets/action@v2', 'changesets/action@v3').replace('createGithubReleases', 'create-github-releases')
    expect(refusals(pinnedSteps('release.yml', bumped), RECORDED)).toEqual([expect.stringContaining('changesets/action@v3')])
  })

  it('passes the declared kebab-case key and leaves a local action unchecked', () => {
    const declared = RELEASE_WORKFLOW.replace('createGithubReleases', 'create-github-releases')
    expect(pinnedSteps('release.yml', declared).map(step => step.uses)).toEqual(['actions/checkout@v7', 'changesets/action@v2'])
    expect(refusals(pinnedSteps('release.yml', declared), RECORDED)).toEqual([])
  })

  it('this repository\'s workflows pass against contract/action-inputs.json, offline', () => {
    expect(refusals(workflowSteps(REPO_ROOT), readRecordedInputs(REPO_ROOT))).toEqual([])
  })

  it('records the contract sorted by pin, as the writer renders it', () => {
    const text = readFileSync(path.join(REPO_ROOT, 'contract/action-inputs.json'), 'utf8')
    expect(renderRecordedInputs(readRecordedInputs(REPO_ROOT))).toBe(text)
  })

  it('renders a record whose fetched pin came last in pin order', () => {
    const appended = { 'changesets/action@v2': RECORDED['changesets/action@v2'], 'actions/checkout@v7': RECORDED['actions/checkout@v7'] }
    expect(Object.keys(JSON.parse(renderRecordedInputs(appended)) as object)).toEqual(['actions/checkout@v7', 'changesets/action@v2'])
  })
})

describe('the inputs of a pin are fetched once from its action.yml', () => {
  it('reads the declared inputs of an action.yml, sorted', () => {
    expect(declaredInputs('name: x\ninputs:\n  version-script:\n    required: false\n  create-github-releases:\n    default: true\nruns:\n  using: node24\n')).toEqual(['create-github-releases', 'version-script'])
    expect(declaredInputs('name: x\nruns:\n  using: node24\n')).toEqual([])
  })

  it('reads action.yml then action.yaml at the pinned ref through the GitHub contents API, keeping a subpath', () => {
    expect(actionYmlPaths('changesets/action@v2')).toEqual([
      'repos/changesets/action/contents/action.yml?ref=v2',
      'repos/changesets/action/contents/action.yaml?ref=v2',
    ])
    expect(actionYmlPaths('github/codeql-action/init@v3')[0]).toBe('repos/github/codeql-action/contents/init/action.yml?ref=v3')
    expect(actionYmlPaths('changesets/action@v2').some(apiPath => apiPath.includes('raw.githubusercontent.com'))).toBe(false)
  })

  it('fetches only the pins with no recorded inputs, keeps the recorded ones, and refuses a pin with no action file', async () => {
    const asked: string[] = []
    const fetcher = async (apiPath: string): Promise<string | undefined> => {
      asked.push(apiPath)
      return apiPath.includes('/action.yaml?') ? 'inputs:\n  ref: {}\n  fetch-depth: {}\n' : undefined
    }
    const steps = pinnedSteps('release.yml', RELEASE_WORKFLOW)
    const recorded = await fetchMissing(steps, { 'changesets/action@v2': RECORDED['changesets/action@v2'] }, fetcher)
    expect(recorded).toEqual(RECORDED)
    expect(asked.every(apiPath => apiPath.startsWith('repos/actions/checkout/contents/') && apiPath.endsWith('?ref=v7'))).toBe(true)
    await expect(fetchMissing(steps, {}, async () => undefined)).rejects.toThrow('no action.yml found')
  })

  it('takes the inputs from action.yml when it exists and never asks for action.yaml', async () => {
    const asked: string[] = []
    const fetcher = async (apiPath: string): Promise<string | undefined> => {
      asked.push(apiPath)
      return apiPath.includes('/action.yml?') ? 'inputs:\n  ref: {}\n  fetch-depth: {}\n' : undefined
    }
    const recorded = await fetchMissing(pinnedSteps('release.yml', RELEASE_WORKFLOW), { 'changesets/action@v2': RECORDED['changesets/action@v2'] }, fetcher)
    expect(recorded['actions/checkout@v7']).toEqual(['fetch-depth', 'ref'])
    expect(asked).toEqual(['repos/actions/checkout/contents/action.yml?ref=v7'])
  })
})

describe('the fetching writer reads each action file through the GitHub port', () => {
  it('reads past an action.yml the port answers 404 to, and writes the inputs of action.yaml for every pin', async () => {
    await runFetchScript(apiPath => apiPath.includes('/action.yml?')
      ? ghFailed(apiPath, 'gh: Not Found (HTTP 404)')
      : { kind: 'ran', stdout: 'inputs:\n  token: {}\n', attempts: 1 })
    const pins = [...new Set(workflowSteps(REPO_ROOT).map(step => step.uses))].sort()
    expect(pins.length).toBeGreaterThan(0)
    expect(fetchScript.asked.filter(apiPath => apiPath.includes('/action.yaml?'))).toHaveLength(pins.length)
    expect(fetchScript.written).toHaveLength(1)
    expect(fetchScript.written[0]!.file).toBe(path.join(REPO_ROOT, ACTION_INPUTS_RECORD))
    expect(fetchScript.written[0]!.text).toBe(renderRecordedInputs(Object.fromEntries(pins.map(pin => [pin, ['token']]))))
  })

  it.each(['gh: Server Error (HTTP 500)', 'gh: Forbidden (HTTP 403)', 'gh: Gone (HTTP 410)'])('refuses on a GitHub port failure other than 404: %s', async (detail) => {
    await expect(runFetchScript(apiPath => ghFailed(apiPath, detail))).rejects.toThrow('the GitHub port could not read')
    expect(fetchScript.written).toEqual([])
  })
})
