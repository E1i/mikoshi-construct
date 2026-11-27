import type { MergeFacts, PatchedFile } from '../../policy/policy.js'
import type { MergeBench } from './merge-bench.js'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendEvent } from '../../core/db.js'
import { CARD_ADMITTED, WITNESS_RECORDED } from '../../core/events.js'
import { mergePolicy, OWNER_MERGES_RULES } from '../../policy/policy.js'
import { cardBody, MAIN_1, sha } from './github-fake.js'
import { liveBench } from './merge-bench.js'

const judged = vi.hoisted(() => [] as MergeFacts[])

vi.mock('../../policy/policy.js', async (actual) => {
  const policy = await actual<typeof import('../../policy/policy.js')>()
  return { ...policy, mergePolicy: (facts: MergeFacts) => {
    judged.push(facts)
    return policy.mergePolicy(facts)
  } }
})

const benches: MergeBench[] = []

afterEach(() => {
  for (const bench of benches.splice(0))
    bench.close()
  judged.splice(0)
})

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

  it('the merge node hands the witness runs of the card to the merge policy, so D-883 holds on the live path', () => {
    const bench = liveBench()
    benches.push(bench)
    const pr = 1977
    const card = pr + 100
    const run = 'pnpm exec vitest run scripts/tests/bus/a-new-witness.test.ts'
    const text = `${cardBody(pr)}\n\nwitnesses: ${JSON.stringify([{ id: 'W1', run, test: null, head: 'pass', base: 'fail', proves: 'the new witness' }])}`
    const ts = bench.clock.now().toISOString()
    appendEvent(bench.db, { ts, type: CARD_ADMITTED, actor: 'policy', cardId: card, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${card}`, payload: { lane: 'lane-a', decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${card}`, bodySha: 'body-1', text }, legacy: false })
    appendEvent(bench.db, { ts, type: WITNESS_RECORDED, actor: 'worker:witness:witness-1', cardId: card, pr, head: sha('a'), dedupeKey: `${WITNESS_RECORDED}:${card}`, payload: { head: sha('a'), base: MAIN_1, cardBody: 'body-1', verdict: 'green', detail: 'green' }, legacy: false })
    bench.gitHub.open({ number: pr, review: 'success' })
    bench.tick()
    bench.merge(bench.lease()!)
    expect(judged.map(facts => [facts.cardId, facts.witnessRuns])).toEqual([[card, [run]]])
  })

  it('a pull request that does not change the ratchet is not read by this rule', () => {
    expect(mergePolicy(facts({ filename: 'scripts/other.ts', patch: '@@ -1 +1 @@\n-x\n+y' }, { files: ['scripts/other.ts'] }))).toMatchObject({ kind: 'allowed', rule: 'auto' })
  })
})
