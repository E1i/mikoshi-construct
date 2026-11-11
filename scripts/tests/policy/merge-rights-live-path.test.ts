import type { InForceDecision } from '../../policy/decisions/index.js'
import type { MergeFacts } from '../../policy/policy.js'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ownerPathsOf } from '../../../src/commands/intake/check.js'
import { mergePolicy, OWNER_MERGES, OWNER_MERGES_RULES, OWNER_PR_MERGED_BY_THE_BUS, RELEASE_KIND } from '../../policy/policy.js'
import { readOwnerMergeKinds } from '../../policy/shredder/reader.js'

const root = path.resolve(import.meta.dirname, '../../..')
const TABLE = readFileSync(path.join(root, OWNER_MERGES), 'utf8')
const MERGE_EXECUTOR = readFileSync(path.join(root, 'scripts/nodes/merge/merge-executor.ts'), 'utf8')
const ORDINARY_PATH = 'scripts/core/queue.ts'
const DECISION_MERGING_OWNER_PRS: InForceDecision = { decisionId: OWNER_PR_MERGED_BY_THE_BUS, text: 'a pass and green CI merge an owner pull request', cards: [] }

function factsFor(overrides: Partial<MergeFacts>): MergeFacts {
  return {
    cardId: 1668,
    description: '#1668 merge-rights-test-live-path [implement/construct/S/cheap/auto] · depends — · blocks —',
    headRef: 'feat/merge-rights-test-live-path',
    title: 'merge-rights-test-live-path',
    files: [ORDINARY_PATH],
    patched: [],
    ownerMergesText: TABLE,
    shardActive: false,
    shardUnder: null,
    windowShard: null,
    decisions: [],
    ...overrides,
  }
}

function pathMeeting(glob: string): string {
  return glob.replace('**/', 'x/').replace('**', 'x').replace('*', 'x')
}

function underShardMark(kind: string): string | undefined {
  return new RegExp(`^\\| ${kind} \\|.*\\| (\\S+) \\|$`, 'm').exec(TABLE)?.[1]
}

const kinds = readOwnerMergeKinds(TABLE)
const pathClasses = kinds.flatMap(({ kind, globs }) => globs.map(glob => ({ kind, glob, file: pathMeeting(glob), mark: underShardMark(kind) })))
const neverUnderAShard = pathClasses.filter(({ mark }) => mark === 'no')
const underAShard = pathClasses.filter(({ mark }) => mark === 'yes')

describe('merge rights on the path the merge executor calls', () => {
  it('the merge executor decides by mergePolicy, and the module that only tests called is gone', () => {
    expect(MERGE_EXECUTOR).toMatch(/import \{[^}]*\bmergePolicy\b[^}]*\} from '\.\.\/\.\.\/policy\/policy\.js'/)
    expect(MERGE_EXECUTOR).toContain('mergePolicy(checked.facts)')
    expect(existsSync(path.join(root, 'scripts/policy/shredder/authority.ts'))).toBe(false)
  })

  it('every owner-only path class is denied by mergePolicy', () => {
    expect(pathClasses.length).toBeGreaterThan(0)
    expect(neverUnderAShard.length + underAShard.length).toBe(pathClasses.length)
    for (const { kind, glob, file } of pathClasses) {
      const verdict = mergePolicy(factsFor({ files: [file] }))
      expect(verdict.kind === 'denied' && OWNER_MERGES_RULES.has(verdict.rule), `${kind} ${glob} as ${file}: ${verdict.rule}`).toBe(true)
    }
  })

  it('a kind marked no stays denied under a shard, a window shard and the decision that merges owner pull requests', () => {
    expect(neverUnderAShard.length).toBeGreaterThan(0)
    for (const { file } of neverUnderAShard) {
      for (const lifted of [{ shardActive: true }, { windowShard: 'w1' }, { decisions: [DECISION_MERGING_OWNER_PRS] }])
        expect(mergePolicy(factsFor({ files: [file], ...lifted })), file).toMatchObject({ kind: 'denied', rule: 'no_shard_merge' })
    }
  })

  it('a kind marked yes is lifted by a shard and by nothing less', () => {
    expect(underAShard.length).toBeGreaterThan(0)
    for (const { file } of underAShard) {
      expect(mergePolicy(factsFor({ files: [file] })), file).toMatchObject({ kind: 'denied', rule: 'owner_without_shard' })
      expect(mergePolicy(factsFor({ files: [file], shardActive: true })), file).toMatchObject({ kind: 'allowed', rule: 'owner_under_shard' })
    }
  })

  it('the release kind is matched by its title and by the version branch, whatever the files', () => {
    const title = kinds.find(({ kind }) => kind === RELEASE_KIND)?.title
    expect(title).toEqual(expect.any(String))
    expect(mergePolicy(factsFor({ title: title! }))).toMatchObject({ kind: 'denied', rule: 'version_pr' })
    expect(mergePolicy(factsFor({ headRef: 'changeset-release/main' }))).toMatchObject({ kind: 'denied', rule: 'version_pr' })
  })

  it('every path owner by risk is denied without a shard', () => {
    const byRisk = ownerPathsOf(TABLE).byRisk.flatMap(row => row.globs)
    expect(byRisk.length).toBeGreaterThan(0)
    for (const glob of byRisk)
      expect(mergePolicy(factsFor({ files: [pathMeeting(glob)] })), glob).toMatchObject({ kind: 'denied', rule: 'owner_by_risk' })
  })

  it('the denial comes from the table: a path no row names is allowed, and a path whose row is gone is allowed again', () => {
    expect(mergePolicy(factsFor({}))).toMatchObject({ kind: 'allowed', rule: 'auto' })
    const accepted = pathClasses.find(({ kind }) => kind === 'accepted-model')!
    const withoutItsRow = TABLE.replace(/^\| accepted-model \|.*\n/m, '')
    expect(withoutItsRow).not.toBe(TABLE)
    expect(mergePolicy(factsFor({ files: [accepted.file] }))).toMatchObject({ kind: 'denied', rule: 'no_shard_merge' })
    expect(mergePolicy(factsFor({ files: [accepted.file], ownerMergesText: withoutItsRow }))).toMatchObject({ kind: 'allowed', rule: 'auto' })
  })
})
