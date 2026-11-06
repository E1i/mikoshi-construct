import type { DepthSources } from '../../nodes/review/review-depth.js'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { touchesFollowed, worktreeCoverage } from '../../nodes/launch/tree-pr.js'
import { planReview } from '../../nodes/review/review-depth.js'
import { classify } from '../../policy/morse/rules.js'

const CARD_ID = 1679
const TOUCHED_MODULE = 'src/widget.ts'
const EXISTING_TEST = 'tests/widget.test.ts'
const ADDED_TEST = 'tests/widget-more.test.ts'
const UNRELATED_TEST = 'tests/other.test.ts'
const IMPORTS_THE_TOUCH = 'import { widget } from \'../src/widget.js\'\n\nexport const twice = widget * 2\n'
const GUARDED_TWIN = 'src/materialize/factory-manifest.ts'
const GUARDED_TWIN_SOURCE = 'architecture/decisions/window-allow-merge.md'

const roots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=bus', '-c', 'user.email=bus@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function write(root: string, files: Record<string, string>): void {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), text)
  }
}

interface Tree {
  root: string
  head: string
}

function treeWithHead(changed: Record<string, string>): Tree {
  const root = mkdtempSync(path.join(tmpdir(), 'touches-follow-one-rule-'))
  roots.push(root)
  git(root, ['init', '-q', '-b', 'main'])
  write(root, {
    [TOUCHED_MODULE]: 'export const widget = 1\n',
    [EXISTING_TEST]: 'export const unrelatedAtTheBase = 1\n',
    [UNRELATED_TEST]: 'export const other = 1\n',
    [GUARDED_TWIN]: 'export const manifest = 1\n',
    [GUARDED_TWIN_SOURCE]: 'a decision\n',
  })
  git(root, ['add', '-A'])
  git(root, ['commit', '-q', '-m', 'base'])
  git(root, ['checkout', '-q', '-b', 'feat/card'])
  write(root, changed)
  git(root, ['add', '-A'])
  git(root, ['commit', '-q', '-m', 'card'])
  return { root, head: git(root, ['rev-parse', 'HEAD']).trim() }
}

function sourcesOf(files: string[], touches: string[], added: string[] = []): DepthSources {
  return {
    base: () => 'b'.repeat(40),
    changed: () => files,
    predict: () => ({ prediction: classify(files.map(file => ({ path: file, status: added.includes(file) ? 'A' : 'M', additions: 1, deletions: 0 }))), files, added }),
    scope: () => ({ touches, creates: [], runs: [] }),
  }
}

function reviewFindings({ root, head }: Tree, files: string[], touches: string[], added: string[] = [], leaseHead: string = head): string[] {
  git(root, ['checkout', '-q', 'main'])
  vi.spyOn(process, 'cwd').mockReturnValue(root)
  const lease = { taskKey: `review:${CARD_ID}:974:${head}`, queue: 'review' as const, cardId: CARD_ID, pr: 974, head: leaseHead, leaseGen: 1, actor: 'worker:review:w' }
  const plan = planReview(lease, null, sourcesOf(files, touches, added))
  return plan.depth === 'diff' && plan.round === 'first' ? plan.touchFindings : [`the plan is ${plan.depth}`]
}

function fenceAtHead({ root }: Tree, outside: string[], touches: string[], added: string[] = []) {
  return touchesFollowed(outside, { touches, added: new Set(added), compositionRecords: [] }, worktreeCoverage(git, root))
}

describe('the fence and the review reach one verdict on what follows the touches', () => {
  it('a covering test recorded as followed is not a review touch finding', () => {
    const tree = treeWithHead({ [EXISTING_TEST]: IMPORTS_THE_TOUCH })

    expect(fenceAtHead(tree, [EXISTING_TEST], [TOUCHED_MODULE])).toEqual({ followed: [EXISTING_TEST], outside: [] })
    expect(reviewFindings(tree, [TOUCHED_MODULE, EXISTING_TEST], [TOUCHED_MODULE])).toEqual([])
  })

  it('a covering test that only the head holds is read from the head, not from the checkout of the repository', () => {
    const tree = treeWithHead({ [ADDED_TEST]: IMPORTS_THE_TOUCH })

    expect(fenceAtHead(tree, [ADDED_TEST], [TOUCHED_MODULE], [ADDED_TEST])).toEqual({ followed: [ADDED_TEST], outside: [] })
    expect(reviewFindings(tree, [TOUCHED_MODULE, ADDED_TEST], [TOUCHED_MODULE], [ADDED_TEST])).toEqual([])
  })

  it('a test that covers no touched file stays outside in both readers', () => {
    const tree = treeWithHead({ [UNRELATED_TEST]: 'export const other = 2\n' })

    expect(fenceAtHead(tree, [UNRELATED_TEST], [TOUCHED_MODULE])).toEqual({ followed: [], outside: [UNRELATED_TEST] })
    expect(reviewFindings(tree, [TOUCHED_MODULE, UNRELATED_TEST], [TOUCHED_MODULE])).toEqual([`${UNRELATED_TEST} is outside the touches of card #${CARD_ID} (${TOUCHED_MODULE})`])
  })

  it('a twin the table generates but the fence guards stays outside in both readers', () => {
    const tree = treeWithHead({ [GUARDED_TWIN]: 'export const manifest = 2\n' })

    expect(fenceAtHead(tree, [GUARDED_TWIN], [GUARDED_TWIN_SOURCE])).toEqual({ followed: [], outside: [GUARDED_TWIN] })
    expect(reviewFindings(tree, [GUARDED_TWIN_SOURCE, GUARDED_TWIN], [GUARDED_TWIN_SOURCE])).toEqual([`${GUARDED_TWIN} is outside the touches of card #${CARD_ID} (${GUARDED_TWIN_SOURCE})`])
  })

  it('a head the repository cannot read follows nothing, so the test stays a finding', () => {
    const tree = treeWithHead({ [EXISTING_TEST]: IMPORTS_THE_TOUCH })

    expect(reviewFindings(tree, [TOUCHED_MODULE, EXISTING_TEST], [TOUCHED_MODULE], [], 'f'.repeat(40))).toEqual([`${EXISTING_TEST} is outside the touches of card #${CARD_ID} (${TOUCHED_MODULE})`])
  })
})
