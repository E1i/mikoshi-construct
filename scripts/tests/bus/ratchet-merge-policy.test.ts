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

  it('under a shard gate:bus grows by at most one per new test file a witness run of the card names (D-883)', () => {
    const witness = 'scripts/tests/bus/a-new-witness.test.ts'
    const raised = (to: number): PatchedFile => ofRatchet(`@@ -52,3 +52,3 @@\n   "boundary:a->b": 3,\n-  "gate:bus": 659,\n+  "gate:bus": ${to},\n   "lines:a.ts": 900\n`)
    const withWitness = (to: number, overrides: Partial<MergeFacts> = {}): MergeFacts => facts(raised(to), { files: [RATCHET, witness], patched: [raised(to), { filename: witness, status: 'added', patch: '@@ -0,0 +1 @@\n+x' }], witnessRuns: [`pnpm exec vitest run ${witness}`], ...overrides })
    for (const lifted of LIFTED.slice(0, 2))
      expect(mergePolicy(withWitness(660, lifted)), JSON.stringify(lifted)).toMatchObject({ kind: 'allowed', rule: 'auto' })
    const denials = [
      withWitness(661, LIFTED[0]),
      withWitness(660, LIFTED[2]),
      withWitness(660, { ...LIFTED[0], witnessRuns: [] }),
      withWitness(660, { ...LIFTED[0], patched: [raised(660), { filename: witness, status: 'modified', patch: '@@ -1 +1 @@\n-x\n+y' }] }),
      facts(ofRatchet('@@ -1,2 +1,2 @@\n-  "boundary:a->b": 3,\n+  "boundary:a->b": 4,\n   "gate:bus": 659\n'), { ...LIFTED[0], files: [RATCHET, witness], patched: [ofRatchet('@@ -1,2 +1,2 @@\n-  "boundary:a->b": 3,\n+  "boundary:a->b": 4,\n   "gate:bus": 659\n'), { filename: witness, status: 'added' }], witnessRuns: [`pnpm exec vitest run ${witness}`] }),
    ]
    for (const denied of denials)
      expect(mergePolicy(denied), JSON.stringify(denied.patched)).toMatchObject({ kind: 'denied', rule: 'ratchet_grows' })
  })

  it('a pull request that does not change the ratchet is not read by this rule', () => {
    expect(mergePolicy(facts({ filename: 'scripts/other.ts', patch: '@@ -1 +1 @@\n-x\n+y' }, { files: ['scripts/other.ts'] }))).toMatchObject({ kind: 'allowed', rule: 'auto' })
  })
})
