import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { actionFileBody, actionYmlPaths, declaredInputs, fetchMissing, pinnedSteps, readRecordedInputs, refusals, renderRecordedInputs, workflowSteps } from '../../contract/action-inputs.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const ACTION_YML = 'repos/actions/checkout/contents/action.yml?ref=v7'

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

describe('a read of an action file through the GitHub port', () => {
  it('answers the body of a read that ran', () => {
    expect(actionFileBody(ACTION_YML, { kind: 'ran', stdout: 'inputs:\n  ref: {}\n' })).toBe('inputs:\n  ref: {}\n')
  })

  it('reads a 404 as no such file, so action.yaml is tried after a missing action.yml', async () => {
    expect(actionFileBody(ACTION_YML, { kind: 'failed', reason: `gh api ${ACTION_YML}: gh: Not Found (HTTP 404)` })).toBeUndefined()
    const fetcher = async (apiPath: string): Promise<string | undefined> => actionFileBody(apiPath, apiPath.includes('/action.yml?')
      ? { kind: 'failed', reason: 'gh: Not Found (HTTP 404)' }
      : { kind: 'ran', stdout: 'inputs:\n  token: {}\n' })
    expect(await fetchMissing(pinnedSteps('release.yml', RELEASE_WORKFLOW), RECORDED, fetcher)).toEqual(RECORDED)
    expect((await fetchMissing(pinnedSteps('release.yml', RELEASE_WORKFLOW), {}, fetcher))['actions/checkout@v7']).toEqual(['token'])
  })

  it.each([
    'gh: Server Error (HTTP 500)',
    'gh: Forbidden (HTTP 403)',
    'gh: Gone (HTTP 410)',
    'gh timed out after 20 s',
    'gh timed out after 404 ms',
    'gh: Server Error (HTTP 500): upstream answered 404',
  ])('refuses any other failure of the port: %s', (reason) => {
    expect(() => actionFileBody(ACTION_YML, { kind: 'failed', reason })).toThrow(`the GitHub port could not read ${ACTION_YML}: ${reason}`)
  })
})
