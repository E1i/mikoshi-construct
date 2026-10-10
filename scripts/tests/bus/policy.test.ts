import type { MergeFacts } from '../../bus/policy.js'
import type { FakePull } from './github-fake.js'
import type { MergeBench } from './merge-bench.js'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { decisionsIntake } from '../../bus/decisions-import.js'
import { ownerInbox } from '../../bus/inbox.js'
import { mergePolicy } from '../../bus/policy.js'
import { cardBody } from './github-fake.js'
import { mergeBench } from './merge-bench.js'

const OWNER_MERGES = readFileSync('architecture/owner-merges.md', 'utf8')
const D77 = '# Owner decisions\n\n- D-76 · 2026-10-10 ~02:55Z — Путь работы выбирает MORSE.\n- D-77 · 2026-10-10 ~13:35Z — Owner-PR мержится шиной по pass ревью воркера и зелёному CI. Исключения за Эли: R1, security-invariants, version-PR.\n'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function underDecisions(text: string): MergeBench {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-policy-decisions-'))
  roots.push(root)
  const file = path.join(root, 'owner-decisions.md')
  writeFileSync(file, text)
  return mergeBench((db, clock) => decisionsIntake(db, file, clock.now))
}

function facts(overrides: Partial<MergeFacts> = {}): MergeFacts {
  return {
    cardId: 1042,
    description: cardBody(942),
    headRef: 'feat/card-1042',
    title: 'feat: card #1042',
    files: ['scripts/bus/policy.ts'],
    ownerMergesText: OWNER_MERGES,
    shardActive: false,
    decisions: [],
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

  it('under D-77 a PR with an owner path, a pass and green CI is merged without a shard', () => {
    const bench = underDecisions(D77)
    const pulls = [
      { number: 960, files: ['.claude/commands/plan.md'] },
      { number: 961, body: cardBody(961, 'owner'), files: ['scripts/bus/policy.ts'] },
    ]
    for (const pull of pulls)
      bench.gitHub.open({ review: 'success', ...pull })
    bench.tick()

    const outcomes = pulls.map(() => bench.merge(bench.lease()!))
    expect(outcomes.map(outcome => outcome.kind === 'merged' ? outcome.rule : outcome.kind)).toEqual(['owner_by_decision', 'owner_by_decision'])
    expect(bench.gitHub.puts.map(put => put.endpoint)).toEqual(pulls.map(pull => `repos/{owner}/{repo}/pulls/${pull.number}/merge`))
    expect(ownerInbox(bench.db)).toEqual([])
    bench.close()
  })

  it('an R1 PR is denied with kind authority and reaches the inbox', () => {
    const bench = underDecisions(D77)
    const cases: [number, string[], string][] = [
      [970, ['.claude/agents/review.md'], 'r1'],
      [971, ['.github/workflows/ci.yml'], 'r1'],
      [972, ['architecture/security-invariants.md'], 'security_invariants'],
    ]
    for (const [number, files] of cases)
      bench.gitHub.open({ number, review: 'success', body: cardBody(number, 'owner'), files })
    bench.tick()

    const outcomes = cases.map(() => bench.merge(bench.lease()!))
    expect(outcomes.map(outcome => outcome.kind === 'denied' && outcome.denial.kind === 'authority' ? [outcome.denial.kind, outcome.denial.rule, outcome.next] : outcome.kind))
      .toEqual(cases.map(([, , rule]) => ['authority', rule, 'withdrawn']))
    expect(bench.gitHub.puts).toEqual([])
    expect(ownerInbox(bench.db).map(line => [line.pr, JSON.parse(line.payload).rule])).toEqual(cases.map(([number, , rule]) => [number, rule]))
    bench.close()
  })

  it('without D-77 in force an owner PR still waits for a shard, and a decision reserving the card holds even under D-77', () => {
    const owner = { description: cardBody(942, 'owner') }
    const d77 = { decisionId: 77, text: 'Owner-PR мержится шиной.', cards: [] }
    expect(mergePolicy(facts({ ...owner, decisions: [{ ...d77, decisionId: 76 }] }))).toMatchObject({ kind: 'denied', rule: 'owner_without_shard' })
    expect(mergePolicy(facts({ ...owner, decisions: [d77] }))).toMatchObject({ kind: 'allowed', rule: 'owner_by_decision' })
    expect(mergePolicy(facts({ ...owner, decisions: [d77, { decisionId: 80, text: '#1042 reserved: Eli merges it.', cards: [1042] }] })))
      .toMatchObject({ kind: 'denied', rule: 'reserved', detail: 'D-80 reserves card #1042 for the owner' })
  })

  it('a reservation of another card does not reserve this one', () => {
    expect(mergePolicy(facts({ description: `${cardBody(942)}\n\n#10420 reserved, #104 reserved` }))).toMatchObject({ kind: 'allowed', rule: 'auto' })
  })
})
