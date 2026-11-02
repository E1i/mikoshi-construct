import type { MergeFacts } from '../../policy/policy.js'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { mergePolicy, OWNER_MERGES } from '../../policy/policy.js'
import { ownerMerges } from '../../policy/shredder/authority.js'
import { readOwnerMergeKinds } from '../../policy/shredder/reader.js'

const TABLE = readFileSync(OWNER_MERGES, 'utf8')
const TEMPLATE_TABLE = readFileSync(`templates/base/${OWNER_MERGES}`, 'utf8')
const SANDBOX_SETTINGS = ['scripts/ports/shift-settings.ts', 'scripts/ports/isolation.ts']
const OWN_INSTRUCTIONS_ROW = /^\| own-instructions \|.*$/m
const TABLE_WITHOUT_ITS_OWN_ROW = TABLE.replace(OWN_INSTRUCTIONS_ROW, '| own-instructions | `.claude/**` | this repository\'s own agent instructions | — | no |')
const TABLE_MARKING_ITSELF_YES = TABLE.replace(OWN_INSTRUCTIONS_ROW, '| own-instructions | `.claude/**`, `architecture/owner-merges.md` | this repository\'s own agent instructions | — | yes |')

function underShard(overrides: Partial<MergeFacts>): MergeFacts {
  return {
    cardId: 1450,
    description: '#1450 securitypath [implement/construct/M/cheap/auto] · depends — · blocks —',
    headRef: 'feat/securitypath',
    title: 'securitypath',
    files: ['scripts/core/queue.ts'],
    ownerMergesText: TABLE,
    shardActive: true,
    shardUnder: null,
    windowShard: null,
    decisions: [],
    ...overrides,
  }
}

describe('the security path of the merge policy', () => {
  it('a PR changing the session sandbox settings is owner-merged under a shard', () => {
    for (const file of SANDBOX_SETTINGS) {
      for (const ownerMergesText of [TABLE, TEMPLATE_TABLE])
        expect(mergePolicy(underShard({ files: ['scripts/core/queue.ts', file], ownerMergesText })), file).toMatchObject({ kind: 'denied', rule: 'no_shard_merge', detail: expect.stringContaining(`${file} (security-invariants)`) as unknown })
      expect(mergePolicy(underShard({ files: [file], windowShard: 'w1', shardActive: false }))).toMatchObject({ kind: 'denied', rule: 'no_shard_merge' })
      expect(ownerMerges([file], readOwnerMergeKinds(TABLE)).ownerMerged).toBe(true)
    }
    expect(mergePolicy(underShard({}))).toMatchObject({ kind: 'allowed', rule: 'auto' })
  })

  it('a PR changing owner-merges.md is owner-merged whatever either table says', () => {
    for (const ownerMergesText of [TABLE, TABLE_WITHOUT_ITS_OWN_ROW, TABLE_MARKING_ITSELF_YES, TEMPLATE_TABLE]) {
      expect(mergePolicy(underShard({ files: [OWNER_MERGES], ownerMergesText })), ownerMergesText.slice(-200)).toMatchObject({ kind: 'denied', rule: 'no_shard_merge', detail: expect.stringContaining('whatever either table says') as unknown })
      expect(mergePolicy(underShard({ files: [OWNER_MERGES], ownerMergesText, shardActive: false, windowShard: 'w1' }))).toMatchObject({ kind: 'denied', rule: 'no_shard_merge' })
      expect(ownerMerges([OWNER_MERGES], readOwnerMergeKinds(ownerMergesText)).ownerMerged).toBe(true)
    }
    expect(TABLE_WITHOUT_ITS_OWN_ROW).not.toBe(TABLE)
    expect(TABLE_MARKING_ITSELF_YES).not.toBe(TABLE)
    expect(mergePolicy(underShard({ ownerMergesText: TABLE_MARKING_ITSELF_YES }))).toMatchObject({ kind: 'allowed', rule: 'auto' })
  })

  it('an owner «I merge it» recorded as #N reserved keeps the PR the owner\'s under a shard', () => {
    expect(mergePolicy(underShard({ decisions: [{ decisionId: 400, text: 'Илай: #1450 reserved — I merge it', cards: [1450] }] }))).toMatchObject({ kind: 'denied', rule: 'reserved' })
  })

  it('the template table carries the sandbox settings under security-invariants, as the repository\'s does', () => {
    const globsOf = (text: string): string[] | undefined => readOwnerMergeKinds(text).find(kind => kind.kind === 'security-invariants')?.globs
    expect(globsOf(TEMPLATE_TABLE)).toEqual(expect.arrayContaining(SANDBOX_SETTINGS))
    expect(globsOf(TABLE)).toEqual(expect.arrayContaining(SANDBOX_SETTINGS))
  })
})
