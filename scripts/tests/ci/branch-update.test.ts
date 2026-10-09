import type { HeadCommits, OpenPullRequest } from '../../ci/branch-update.js'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import YAML from 'yaml'
import { carriesReviewStatus, nextToUpdate, TOKEN_SECRET } from '../../ci/branch-update.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')

function pr(number: number, createdAt: string, overrides: Partial<OpenPullRequest> = {}): OpenPullRequest {
  return { number, createdAt, isDraft: false, isCrossRepository: false, autoMerge: true, mergeable: 'MERGEABLE', behindBy: 1, hasReviewStatus: false, ...overrides }
}

const DAY1 = '2026-09-01T10:00:00Z'
const DAY2 = '2026-09-02T10:00:00Z'
const DAY3 = '2026-09-03T10:00:00Z'

const CASES: { name: string, prs: OpenPullRequest[], chosen: number | undefined }[] = [
  { name: 'no open pull requests', prs: [], chosen: undefined },
  { name: 'one queued and behind', prs: [pr(7, DAY1)], chosen: 7 },
  { name: 'the oldest of several behind, whatever the list order', prs: [pr(9, DAY3), pr(4, DAY1), pr(6, DAY2)], chosen: 4 },
  { name: 'age, not number, when the two disagree', prs: [pr(3, DAY2), pr(8, DAY1)], chosen: 8 },
  { name: 'the lower number when two were opened at the same instant', prs: [pr(12, DAY1), pr(11, DAY1)], chosen: 11 },
  { name: 'none when the only behind one has auto-merge off', prs: [pr(5, DAY1, { autoMerge: false })], chosen: undefined },
  { name: 'a younger one with auto-merge over an older one without', prs: [pr(5, DAY1, { autoMerge: false }), pr(6, DAY2)], chosen: 6 },
  { name: 'none when every queued one is up to date', prs: [pr(5, DAY1, { behindBy: 0 }), pr(6, DAY2, { behindBy: 0 })], chosen: undefined },
  { name: 'a younger behind one over an older up-to-date one', prs: [pr(5, DAY1, { behindBy: 0 }), pr(6, DAY2)], chosen: 6 },
  { name: 'a younger one over an older draft', prs: [pr(5, DAY1, { isDraft: true }), pr(6, DAY2)], chosen: 6 },
  { name: 'none when the only candidate is from a fork', prs: [pr(5, DAY1, { isCrossRepository: true })], chosen: undefined },
  { name: 'a younger one over an older one known to conflict', prs: [pr(5, DAY1, { mergeable: 'CONFLICTING' }), pr(6, DAY2)], chosen: 6 },
  { name: 'an older one whose mergeability is not computed yet', prs: [pr(5, DAY1, { mergeable: 'UNKNOWN' }), pr(6, DAY2)], chosen: 5 },
  { name: 'none when the only behind one carries a review status at its head', prs: [pr(5, DAY1, { hasReviewStatus: true })], chosen: undefined },
  { name: 'a younger one without a review status over an older one with one', prs: [pr(5, DAY1, { hasReviewStatus: true }), pr(6, DAY2)], chosen: 6 },
  { name: 'none when every one is excluded for a different reason', prs: [pr(1, DAY1, { autoMerge: false }), pr(2, DAY1, { isDraft: true }), pr(3, DAY2, { isCrossRepository: true }), pr(4, DAY2, { mergeable: 'CONFLICTING' }), pr(5, DAY3, { behindBy: 0 }), pr(6, DAY3, { hasReviewStatus: true })], chosen: undefined },
]

describe('the pull request a push to main updates', () => {
  for (const { name, prs, chosen } of CASES) {
    it(`is ${chosen === undefined ? 'none' : `#${chosen}`} for ${name}`, () => {
      expect(nextToUpdate(prs)?.number).toBe(chosen)
    })
  }

  it('leaves the list it was given in its order', () => {
    const prs = [pr(9, DAY3), pr(4, DAY1)]
    nextToUpdate(prs)
    expect(prs.map(({ number }) => number)).toEqual([9, 4])
  })
})

function head(contexts: string[] | null): HeadCommits {
  return { nodes: [{ commit: { status: contexts === null ? null : { contexts: contexts.map(context => ({ context })) } } }] }
}

const HEAD_CASES: { name: string, commits: HeadCommits, carries: boolean }[] = [
  { name: 'a head with no commit status at all', commits: head(null), carries: false },
  { name: 'a head whose only status is another context', commits: head(['Secret scan']), carries: false },
  { name: 'a head with a review status', commits: head(['Secret scan', 'review']), carries: true },
  { name: 'a pull request with no commits read', commits: { nodes: [] }, carries: false },
]

describe('whether the head of a pull request carries a review status', () => {
  for (const { name, commits, carries } of HEAD_CASES) {
    it(`is ${carries} for ${name}`, () => {
      expect(carriesReviewStatus(commits)).toBe(carries)
    })
  }
})

interface Step { run?: string, env?: Record<string, string> }
const workflow = YAML.parse(readFileSync(path.join(REPO_ROOT, '.github/workflows/branch-update.yml'), 'utf8')) as {
  on: Record<string, { branches?: string[] }>
  concurrency: { 'group': string, 'cancel-in-progress': boolean }
  jobs: Record<string, { steps: Step[] }>
}

describe('branch-update.yml wiring', () => {
  const steps = Object.values(workflow.jobs).flatMap(job => job.steps)
  const update = steps.find(step => step.run?.includes('scripts/ci/update-branch.ts'))

  it('runs only on a push to main', () => {
    expect(Object.keys(workflow.on)).toEqual(['push'])
    expect(workflow.on.push!.branches).toEqual(['main'])
  })

  it('lets one run at a time choose, and never cancels one that is updating', () => {
    expect(Object.keys(workflow.jobs)).toHaveLength(1)
    expect(workflow.concurrency.group).toBe('branch-update')
    expect(workflow.concurrency['cancel-in-progress']).toBe(false)
  })

  it('pushes with the repository secret alone, never falling back to GITHUB_TOKEN', () => {
    expect(update?.env).toEqual({ GH_TOKEN: `\${{ secrets.${TOKEN_SECRET} }}` })
  })
})

describe('update-branch.ts without its token', () => {
  it('fails and names the secret instead of skipping', () => {
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'GH_TOKEN')), GITHUB_REPOSITORY: 'owner/name' }
    const result = spawnSync(process.execPath, [path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs'), path.join(REPO_ROOT, 'scripts/ci/update-branch.ts')], { env, encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(TOKEN_SECRET)
  })
})
