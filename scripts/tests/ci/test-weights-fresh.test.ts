import type { TestWeights } from '../../ci/shard.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAX_UNWEIGHTED_SHARE, WEIGHTS_PATH, weightsFreshness } from '../../ci/test-weights.js'
import { pnpmCommand } from '../../core/owner-commands.js'
import { processGit } from '../../ports/git.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const committed = JSON.parse(readFileSync(path.join(REPO_ROOT, WEIGHTS_PATH), 'utf8')) as TestWeights
const trackedFiles = (): string[] => (processGit.readOrNull(REPO_ROOT, ['ls-files']) ?? '').split('\n').filter(file => file !== '')

describe('the shard weight table never goes stale silently', () => {
  const files = Array.from({ length: 20 }, (_, at) => `tests/t${String(at).padStart(2, '0')}.test.ts`)
  const weighted = (count: number): TestWeights => Object.fromEntries(files.slice(0, count).map(file => [file, 1]))

  it('a table that leaves more test files unweighted than the threshold is red and names the recompute command', () => {
    const verdict = weightsFreshness([...files, 'src/not-a-test.ts'], weighted(17))
    expect(verdict).toMatchObject({ tests: 20, stale: true })
    expect(verdict.unweighted).toEqual(files.slice(17))
    expect(verdict.line).toContain(pnpmCommand('test:weights', '--from', 'main'))
  })

  it('a table that leaves the threshold share or less unweighted is green', () => {
    expect(weightsFreshness(files, weighted(18)).stale).toBe(false)
    expect(weightsFreshness(files, weighted(20))).toMatchObject({ unweighted: [], stale: false })
  })

  it('the committed table weighs every test file but the threshold', () => {
    const verdict = weightsFreshness(trackedFiles(), committed)
    expect(verdict.tests).toBeGreaterThan(100)
    expect(verdict.unweighted.length / verdict.tests, verdict.line).toBeLessThanOrEqual(MAX_UNWEIGHTED_SHARE)
  })
})
