import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { REPO_ROOT } from '../scripts/release-notes/changelog.js'
import {
  changelogAtTag,
  GITHUB_RELEASE_BODY_LIMIT,
  headingCounts,
  RELEASE_BODY_BUDGET,
  RELEASE_BODY_FILE,
  releaseBodyFault,
  releaseOutputs,
  renderReleaseBody,
  SUMMARY_LINE_LIMIT,
  summaryLine,
} from '../scripts/release-notes/release-body.js'

const REPOSITORY = 'owner/package'

function changeset(index: number): string {
  const first = `- [#${index}](https://github.com/${REPOSITORY}/pull/${index}) [\`abc${index}\`](https://github.com/${REPOSITORY}/commit/abc${index}) Thanks [@someone](https://github.com/someone)! - Changeset ${index} changes one thing. ${'It then explains at length why. '.repeat(40)}`
  return `${first}\n\n  ${'A further paragraph of detail. '.repeat(30)}`
}

function hugeChangelog(version: string, count: number): string {
  return `# pkg\n\n## ${version}\n\n### Minor Changes\n\n${Array.from({ length: count }, (_, index) => changeset(index)).join('\n\n')}\n\n## 0.0.1\n\n- [#0](x) Older.\n`
}

describe('the GitHub release body is a summary within a fixed budget', () => {
  it('the release body of a huge changelog section stays within the budget and links the changelog at the tag', () => {
    const changelog = hugeChangelog('1.2.3', 200)
    const section = changelog.slice(changelog.indexOf('## 1.2.3'), changelog.indexOf('## 0.0.1'))
    expect(section.length).toBeGreaterThan(GITHUB_RELEASE_BODY_LIMIT)

    const rendered = renderReleaseBody({ version: '1.2.3', changelog }, REPOSITORY)

    expect(rendered.kind).toBe('within')
    const body = rendered.kind === 'within' ? rendered.body : ''
    expect(body.length).toBeLessThanOrEqual(RELEASE_BODY_BUDGET)
    expect(body).toContain(`(${changelogAtTag('1.2.3', REPOSITORY)})`)
    expect(changelogAtTag('1.2.3', REPOSITORY)).toBe(`https://github.com/${REPOSITORY}/blob/v1.2.3/CHANGELOG.md#123`)
    expect(body).toContain('### Minor Changes')
    expect(body).toContain('Changeset 199 changes one thing.')
    expect(body).not.toContain('A further paragraph')
    expect(body).not.toContain('Older.')
  })

  it('keeps one line per changeset: its pull request link and its first sentence', () => {
    expect(summaryLine(`- [#7](https://github.com/${REPOSITORY}/pull/7) [\`abc\`](https://github.com/${REPOSITORY}/commit/abc) Thanks [@a](https://github.com/a)! - Fixes \`a.ts\`. More words.`))
      .toBe(`- [#7](https://github.com/${REPOSITORY}/pull/7) Fixes \`a.ts\`.`)
    expect(summaryLine('- A changeset with no pull request.')).toBe('- A changeset with no pull request.')
  })

  it('cuts a first sentence longer than the line limit at a word and closes an open code span', () => {
    const line = summaryLine(`- Starts \`${'code '.repeat(SUMMARY_LINE_LIMIT)}\` ends.`)

    expect(line.length).toBeLessThanOrEqual(SUMMARY_LINE_LIMIT + 4)
    expect(line.endsWith('`…')).toBe(true)
  })

  it('is over the budget, not silently cut, when even the summary does not fit', () => {
    const rendered = renderReleaseBody({ version: '1.2.3', changelog: hugeChangelog('1.2.3', 200) }, REPOSITORY, 1000)

    expect(rendered.kind).toBe('over-budget')
  })

  it('names every heading of an over-budget body with its count of changesets and characters', () => {
    const rendered = renderReleaseBody({ version: '1.2.3', changelog: hugeChangelog('1.2.3', 200) }, REPOSITORY, 1000)
    const body = rendered.kind === 'over-budget' ? rendered.body : ''
    const characters = body.split('\n').filter(line => line.startsWith('- ')).reduce((sum, line) => sum + line.length + 1, 0)

    expect(headingCounts(body)).toEqual([{ heading: '### Minor Changes', changesets: 200, characters }])
    expect(releaseBodyFault(rendered)).toContain(`### Minor Changes: 200 changesets, ${characters} characters`)
  })

  it('reports a version the changelog has no entry for', () => {
    expect(renderReleaseBody({ version: '9.9.9', changelog: hugeChangelog('1.2.3', 1) }).kind).toBe('absent')
  })

  it('hands the workflow the tag and the body file it wrote as step outputs', () => {
    const rendered = renderReleaseBody({ version: '1.2.3', changelog: hugeChangelog('1.2.3', 1) }, REPOSITORY)
    if (rendered.kind !== 'within')
      throw new Error(rendered.kind)

    expect(releaseOutputs(rendered, RELEASE_BODY_FILE)).toBe(`tag=v1.2.3\nbody-file=${RELEASE_BODY_FILE}\n`)
  })
})

interface Step {
  id?: string
  uses?: string
  if?: string
  run?: string
  with?: Record<string, unknown>
  env?: Record<string, unknown>
}

const PINNED_CHANGESETS_ACTION = 'changesets/action@v2'
const PINNED_CHANGESETS_ACTION_INPUTS = [
  'version-script',
  'publish-script',
  'commit-message',
  'pr-title',
  'cwd',
  'branch',
  'setup-git-user',
  'create-github-releases',
  'push-git-tags',
]

describe('the release workflow creates the GitHub release itself', () => {
  const steps = (parseYaml(readFileSync(path.join(REPO_ROOT, '.github/workflows/release.yml'), 'utf8')) as { jobs: { release: { steps: Step[] } } }).jobs.release.steps

  it('the release workflow creates the GitHub release from the rendered body, not from changesets', () => {
    const action = steps.findIndex(step => step.uses?.startsWith('changesets/action@') === true)
    expect(action).toBeGreaterThanOrEqual(0)
    expect(steps[action]!.uses).toBe(PINNED_CHANGESETS_ACTION)
    const inputs = steps[action]!.with ?? {}
    expect(Object.keys(inputs).filter(key => !PINNED_CHANGESETS_ACTION_INPUTS.includes(key))).toEqual([])
    expect(inputs['create-github-releases']).toBe(false)
    expect(inputs['push-git-tags']).toBe(true)

    const release = steps.findIndex(step => step.run?.includes('scripts/release-notes/release-body.ts') === true)
    expect(release).toBeGreaterThan(action)
    const published = `steps.${steps[action]!.id}.outputs.published == 'true'`
    expect(steps[release]!.if).toBe(published)

    const create = steps.findIndex(step => step.uses?.startsWith('actions/github-script@') === true)
    expect(create).toBeGreaterThan(release)
    expect(steps[create]!.if).toBe(published)
    expect(steps[create]!.env?.BODY_FILE).toBe(`\${{ steps.${steps[release]!.id}.outputs.body-file }}`)
    expect(steps[create]!.env?.TAG).toBe(`\${{ steps.${steps[release]!.id}.outputs.tag }}`)
    expect(String(steps[create]!.with?.script)).toMatch(/createRelease\(/)
    expect(steps.some(step => step.run !== undefined && /\bgh\s+release\b/.test(step.run))).toBe(false)
  })
})
