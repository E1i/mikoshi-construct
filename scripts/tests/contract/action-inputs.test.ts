import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { actionYmlUrls, declaredInputs, fetchMissing, pinnedSteps, readRecordedInputs, refusals, renderRecordedInputs, workflowSteps } from '../../contract/action-inputs.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')

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
})

describe('the inputs of a pin are fetched once from its action.yml', () => {
  it('reads the declared inputs of an action.yml, sorted', () => {
    expect(declaredInputs('name: x\ninputs:\n  version-script:\n    required: false\n  create-github-releases:\n    default: true\nruns:\n  using: node24\n')).toEqual(['create-github-releases', 'version-script'])
    expect(declaredInputs('name: x\nruns:\n  using: node24\n')).toEqual([])
  })

  it('looks for action.yml then action.yaml at the pinned ref, keeping a subpath', () => {
    expect(actionYmlUrls('changesets/action@v2')).toEqual([
      'https://raw.githubusercontent.com/changesets/action/v2/action.yml',
      'https://raw.githubusercontent.com/changesets/action/v2/action.yaml',
    ])
    expect(actionYmlUrls('github/codeql-action/init@v3')[0]).toBe('https://raw.githubusercontent.com/github/codeql-action/v3/init/action.yml')
  })

  it('fetches only the pins with no recorded inputs, and refuses a pin with no action file', async () => {
    const asked: string[] = []
    const fetcher = async (url: string): Promise<string | undefined> => {
      asked.push(url)
      return url.endsWith('/action.yaml') ? 'inputs:\n  ref: {}\n  fetch-depth: {}\n' : undefined
    }
    const steps = pinnedSteps('release.yml', RELEASE_WORKFLOW)
    const recorded = await fetchMissing(steps, { 'changesets/action@v2': RECORDED['changesets/action@v2'] }, fetcher)
    expect(recorded['actions/checkout@v7']).toEqual(['fetch-depth', 'ref'])
    expect(asked.every(url => url.includes('actions/checkout/v7'))).toBe(true)
    await expect(fetchMissing(steps, {}, async () => undefined)).rejects.toThrow('no action.yml found')
  })
})
