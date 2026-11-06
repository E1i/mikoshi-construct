import type { MergeFacts, PatchedFile } from '../../policy/policy.js'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { mergePolicy, OWNER_MERGES_RULES } from '../../policy/policy.js'
import { cardBody } from './github-fake.js'

const OWNER_MERGES = readFileSync('architecture/owner-merges.md', 'utf8')
const RATCHET = 'contract/ratchet.json'
const LIFTED = [{ shardActive: true }, { windowShard: 'shard-1' }, { shardActive: false, windowShard: null }]

function facts(patched: PatchedFile, overrides: Partial<MergeFacts> = {}): MergeFacts {
  return {
    cardId: 1042,
    description: cardBody(942),
    headRef: 'feat/card-1042',
    title: 'feat: card #1042',
    files: [RATCHET],
    patched: [patched],
    ownerMergesText: OWNER_MERGES,
    shardActive: false,
    shardUnder: null,
    windowShard: null,
    decisions: [],
    ...overrides,
  }
}

function ofRatchet(patch: string | undefined): PatchedFile {
  return { filename: RATCHET, ...(patch === undefined ? {} : { patch }) }
}

describe('the merge policy on the ratchet', () => {
  it('a raised number, a new key or a missing patch of the ratchet stays with the owner under every shard', () => {
    const growing = [
      '@@ -1,3 +1,3 @@\n {\n-  "lines:a.ts": 900,\n+  "lines:a.ts": 901,\n   "threshold": 800\n',
      '@@ -1,3 +1,3 @@\n {\n   "lines:a.ts": 900,\n-  "threshold": 800\n+  "threshold": 900\n',
      '@@ -1,2 +1,3 @@\n {\n+  "lines:b.ts": 801,\n   "threshold": 800\n',
      '@@ -0,0 +1,3 @@\n+{\n+  "threshold": 800\n+}\n',
      '@@ -1,2 +1,2 @@\n-  "threshold": 800\n+  "threshold": "free"\n',
      undefined,
    ]
    for (const patch of growing) {
      for (const lifted of LIFTED)
        expect(mergePolicy(facts(ofRatchet(patch), lifted)), `${patch} ${JSON.stringify(lifted)}`).toMatchObject({ kind: 'denied', rule: 'ratchet_grows' })
    }
    expect(OWNER_MERGES_RULES.has('ratchet_grows')).toBe(true)
    expect(mergePolicy(facts({ filename: 'scripts/other.ts', patch: '@@ -1 +1 @@\n-x\n+y' }))).toMatchObject({ kind: 'denied', rule: 'ratchet_grows' })
  })

  it('a patch that only lowers or removes numbers of the ratchet merges as an ordinary card', () => {
    const shrinking = [
      '@@ -1,3 +1,3 @@\n {\n-  "lines:a.ts": 900,\n+  "lines:a.ts": 899,\n   "threshold": 800\n',
      '@@ -1,3 +1,2 @@\n {\n-  "lines:a.ts": 900,\n   "threshold": 800\n',
      '@@ -1,3 +1,2 @@\n {\n-  "lines:a.ts": 900,\n-  "threshold": 800\n+  "threshold": 800\n',
      '@@ -1,3 +1,3 @@\n {\n-  "threshold": 800\n+  "threshold": 700\n }\n',
    ]
    for (const patch of shrinking)
      expect(mergePolicy(facts(ofRatchet(patch))), patch).toMatchObject({ kind: 'allowed', rule: 'auto' })
  })

  it('a pull request that does not change the ratchet is not read by this rule', () => {
    expect(mergePolicy(facts({ filename: 'scripts/other.ts', patch: '@@ -1 +1 @@\n-x\n+y' }, { files: ['scripts/other.ts'] }))).toMatchObject({ kind: 'allowed', rule: 'auto' })
  })
})
