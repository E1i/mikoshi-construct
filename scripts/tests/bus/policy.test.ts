import type { MergeFacts } from '../../bus/policy.js'
import type { FakePull } from './github-fake.js'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ownerInbox } from '../../bus/inbox.js'
import { mergePolicy } from '../../bus/policy.js'
import { cardBody } from './github-fake.js'
import { mergeBench } from './merge-bench.js'

const OWNER_MERGES = readFileSync('architecture/owner-merges.md', 'utf8')

function facts(overrides: Partial<MergeFacts> = {}): MergeFacts {
  return {
    cardId: 1042,
    description: cardBody(942),
    headRef: 'feat/card-1042',
    title: 'feat: card #1042',
    files: ['scripts/bus/policy.ts'],
    ownerMergesText: OWNER_MERGES,
    shardActive: false,
    ...overrides,
  }
}

describe('the merge policy', () => {
  it('an auto card is allowed to merge', () => {
    expect(mergePolicy(facts())).toMatchObject({ kind: 'allowed', rule: 'auto' })
    expect(mergePolicy(facts({ shardActive: true }))).toMatchObject({ kind: 'allowed', rule: 'auto' })
  })

  it('an auto card that changes an owner path is the owner\'s, whatever its card says', () => {
    expect(mergePolicy(facts({ files: ['AGENTS.md'] }))).toMatchObject({ kind: 'denied', rule: 'owner_without_shard', detail: expect.stringContaining('changes AGENTS.md') as unknown })
  })

  it('an owner card merges only under an active shard', () => {
    const owner = { description: cardBody(942, 'owner') }
    expect(mergePolicy(facts(owner))).toMatchObject({ kind: 'denied', rule: 'owner_without_shard' })
    expect(mergePolicy(facts({ ...owner, shardActive: true }))).toMatchObject({ kind: 'allowed', rule: 'owner_under_shard' })
    expect(mergePolicy(facts({ ...owner, files: ['.github/workflows/release.yml'], shardActive: true }))).toMatchObject({ kind: 'allowed', rule: 'owner_under_shard' })
  })

  it('a decision is never taken by default', () => {
    expect(mergePolicy(facts({ description: 'no card here' }))).toMatchObject({ kind: 'denied', rule: 'decision_unread' })
    expect(mergePolicy(facts({ description: cardBody(943) }))).toMatchObject({ kind: 'denied', rule: 'decision_unread' })
    expect(mergePolicy(facts({ description: '#1042 a-probe [probe/netwatch/S/cheap/none] · depends — · blocks —' }))).toMatchObject({ kind: 'denied', rule: 'decision_unread' })
  })

  it('a version PR, security-invariants, owner by risk and a reserved card are denied with authority and reach the inbox', () => {
    const bench = mergeBench()
    const cases: [Partial<FakePull> & { number: number }, string][] = [
      [{ number: 950, ref: 'changeset-release/main' }, 'version_pr'],
      [{ number: 951, title: 'chore: version packages' }, 'version_pr'],
      [{ number: 952, files: ['architecture/security-invariants.md'] }, 'security_invariants'],
      [{ number: 953, files: ['templates/base/architecture/security-invariants.md'] }, 'security_invariants'],
      [{ number: 954, files: ['scripts/bus/policy.ts', 'scripts/ghosts/approve.ts'] }, 'owner_by_risk'],
      [{ number: 955, body: `${cardBody(955, 'owner')}\n\n#1055 reserved` }, 'reserved'],
    ]
    for (const [pull] of cases)
      bench.gitHub.open({ review: 'success', files: ['scripts/bus/policy.ts'], ...pull })
    bench.issueShard()
    bench.tick()

    const outcomes = cases.map(() => bench.merge(bench.lease()!))
    expect(outcomes.map(outcome => outcome.kind === 'denied' ? [outcome.denial.kind, 'rule' in outcome.denial ? outcome.denial.rule : outcome.denial.reason, outcome.next] : outcome.kind))
      .toEqual(cases.map(([, rule]) => ['authority', rule, 'withdrawn']))
    expect(bench.gitHub.puts).toEqual([])
    expect(ownerInbox(bench.db).map(line => [line.pr, JSON.parse(line.payload).rule])).toEqual(cases.map(([pull, rule]) => [pull.number, rule]))
    bench.close()
  })

  it('the reservations hold under a shard, where an owner card would merge', () => {
    for (const overrides of [{ headRef: 'changeset-release/main' }, { files: ['architecture/security-invariants.md'] }, { files: ['scripts/ghosts/approve.ts'] }, { description: `${cardBody(942, 'owner')}\n#1042 reserved` }])
      expect(mergePolicy(facts({ ...overrides, shardActive: true })).kind).toBe('denied')
  })

  it('a reservation of another card does not reserve this one', () => {
    expect(mergePolicy(facts({ description: `${cardBody(942)}\n\n#10420 reserved, #104 reserved` }))).toMatchObject({ kind: 'allowed', rule: 'auto' })
  })
})
