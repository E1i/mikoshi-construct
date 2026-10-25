import type { CloseFacts, MergeFacts } from '../../policy/policy.js'
import type { FakePull } from './github-fake.js'
import type { MergeBench } from './merge-bench.js'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { decisionsIntake } from '../../policy/decisions-import.js'
import { ownerInbox } from '../../core/inbox.js'
import { closePolicy, mergePolicy, MERGES_UNDER_A_SHARD, OWNER_MERGES_RULES } from '../../policy/policy.js'
import { cardBody } from './github-fake.js'
import { liveBench } from './merge-bench.js'

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
  return liveBench((db, clock) => decisionsIntake(db, file, clock.now))
}

function facts(overrides: Partial<MergeFacts> = {}): MergeFacts {
  return {
    cardId: 1042,
    description: cardBody(942),
    headRef: 'feat/card-1042',
    title: 'feat: card #1042',
    files: ['scripts/policy/policy.ts'],
    ownerMergesText: OWNER_MERGES,
    shardActive: false,
    shardUnder: null,
    windowShard: null,
    decisions: [],
    ...overrides,
  }
}

describe('the merge policy', () => {
  it('an auto card is allowed to merge', () => {
    expect(mergePolicy(facts())).toMatchObject({ kind: 'allowed', rule: 'auto' })
    expect(mergePolicy(facts({ shardActive: true }))).toMatchObject({ kind: 'allowed', rule: 'auto' })
  })

  it('an auto card that changes src/ or templates/ with no matrix count line is denied with the no_matrix_count_line reason', () => {
    for (const file of ['src/cli.ts', 'templates/base/AGENTS.md.eta'])
      expect(mergePolicy(facts({ files: ['scripts/policy/policy.ts', file] }))).toEqual({ kind: 'denied', rule: 'no_matrix_count_line', detail: `changes ${file} and its description has no code matrix count line ■ n □ n · n (architecture/code-matrix.md)` })
  })

  it('with scripts/shift/merge.ts deleted the bus still denies a src/ change with no matrix count line', () => {
    expect(existsSync('scripts/shift/merge.ts')).toBe(false)
    expect(mergePolicy(facts({ files: ['src/cli.ts'] }))).toEqual({ kind: 'denied', rule: 'no_matrix_count_line', detail: 'changes src/cli.ts and its description has no code matrix count line ■ n □ n · n (architecture/code-matrix.md)' })
  })

  it('an auto card that changes src/ with a matrix count line is allowed to merge', () => {
    expect(mergePolicy(facts({ description: `${cardBody(942)}\n\n■ 3 □ 1 · 2`, files: ['src/cli.ts'] }))).toMatchObject({ kind: 'allowed', rule: 'auto' })
  })

  it('an auto card that changes only scripts/ with no matrix count line is allowed to merge', () => {
    expect(mergePolicy(facts({ files: ['scripts/policy/policy.ts', 'scripts/shift/merge.ts'] }))).toMatchObject({ kind: 'allowed', rule: 'auto' })
  })

  it('an auto card that changes an owner path is the owner\'s, whatever its card says', () => {
    expect(mergePolicy(facts({ files: ['AGENTS.md'] }))).toMatchObject({ kind: 'denied', rule: 'owner_without_shard', detail: expect.stringContaining('changes AGENTS.md') as unknown })
  })

  it('an owner card merges only under an active shard', () => {
    const owner = { description: cardBody(942, 'owner') }
    expect(mergePolicy(facts(owner))).toMatchObject({ kind: 'denied', rule: 'owner_without_shard' })
    expect(mergePolicy(facts({ ...owner, shardActive: true }))).toMatchObject({ kind: 'allowed', rule: 'owner_under_shard' })
    expect(mergePolicy(facts({ ...owner, files: ['.github/workflows/release.yml'], shardActive: true }))).toMatchObject({ kind: 'denied', rule: 'no_shard_merge' })
  })

  it('a pull request changing .github/workflows/ci.yml under an active D-216 shard is denied for the owner, not owner_under_shard', () => {
    const d216 = { decisionId: 216, text: 'Delegation of owner pull requests to the bus.', cards: [] }
    expect(mergePolicy(facts({ description: cardBody(942, 'owner'), files: ['.github/workflows/ci.yml'], shardActive: true, shardUnder: 216, decisions: [d216] })))
      .toEqual({ kind: 'denied', rule: 'no_shard_merge', detail: 'changes .github/workflows/ci.yml (workflows), which does not merge under a shard or a decision, and stays the owner\'s' })
  })

  it('a pull request changing .github/workflows/ci.yml under the window shard and under D-77 is denied for the owner', () => {
    const d77 = { decisionId: 77, text: 'Owner-PR мержится шиной.', cards: [] }
    const ci = { description: cardBody(942, 'owner'), files: ['.github/workflows/ci.yml'] }
    expect(mergePolicy(facts({ ...ci, windowShard: 'shard-window' }))).toMatchObject({ kind: 'denied', rule: 'no_shard_merge' })
    expect(mergePolicy(facts({ ...ci, decisions: [d77] }))).toMatchObject({ kind: 'denied', rule: 'no_shard_merge' })
  })

  it('a pull request changing architecture/security-invariants.md under an active D-216 shard is policy.denied, not owner_under_shard', () => {
    const d216 = { decisionId: 216, text: 'Delegation of owner pull requests to the bus.', cards: [] }
    for (const file of ['architecture/security-invariants.md', 'templates/base/architecture/security-invariants.md']) {
      expect(mergePolicy(facts({ description: cardBody(942, 'owner'), files: [file], shardActive: true, shardUnder: 216, decisions: [d216] })))
        .toMatchObject({ kind: 'denied', rule: 'no_shard_merge', detail: expect.stringContaining(`${file} (security-invariants)`) as unknown })
    }
  })

  it('a pull request with an ordinary owner file by risk under a shard is still owner_under_shard', () => {
    const d216 = { decisionId: 216, text: 'Delegation of owner pull requests to the bus.', cards: [] }
    const owner = { description: cardBody(942, 'owner'), files: ['scripts/ladder/approve.ts'] }
    expect(mergePolicy(facts({ ...owner, shardActive: true, shardUnder: 216, decisions: [d216] }))).toMatchObject({ kind: 'allowed', rule: 'owner_under_shard', detail: expect.stringContaining('D-216') as unknown })
    expect(mergePolicy(facts({ ...owner, files: ['AGENTS.md'], shardActive: true, shardUnder: 216, decisions: [d216] }))).toMatchObject({ kind: 'allowed', rule: 'owner_under_shard' })
    expect(mergePolicy(facts({ ...owner, windowShard: 'shard-window' }))).toMatchObject({ kind: 'allowed', rule: 'owner_under_shard' })
  })

  it('an unknown value of the no-shard-merge mark is denied', () => {
    const shard = { description: cardBody(942, 'owner'), files: ['.github/workflows/ci.yml'], shardActive: true, shardUnder: 216, decisions: [{ decisionId: 216, text: 'Delegation.', cards: [] }] }
    for (const value of ['maybe', '']) {
      const ownerMergesText = OWNER_MERGES.replace(/(\| workflows \|.*\| )no \|/, `$1${value} |`)
      expect(ownerMergesText).not.toBe(OWNER_MERGES)
      expect(mergePolicy(facts({ ...shard, ownerMergesText }))).toMatchObject({ kind: 'denied', rule: 'owner_merges_unread', detail: expect.stringContaining(`«${value}», neither yes nor no`) as unknown })
    }
    const unmarkedAgents = OWNER_MERGES.replace(/(\| own-instructions \|.*\| )yes \|/, '$1maybe |')
    expect(mergePolicy(facts({ ...shard, files: ['scripts/core/queue.ts'], ownerMergesText: unmarkedAgents }))).toMatchObject({ kind: 'allowed', rule: 'owner_under_shard' })
  })

  it('an owner-merges.md that does not parse is denied', () => {
    const withoutColumn = OWNER_MERGES.replace(`| ${MERGES_UNDER_A_SHARD} |\n|---|---|---|---|---|`, '|\n|---|---|---|---|')
    const ragged = OWNER_MERGES.replace(/(\| workflows \|.*\| )no \|/, '$1')
    expect(withoutColumn).not.toBe(OWNER_MERGES)
    expect(ragged).not.toBe(OWNER_MERGES)
    for (const ownerMergesText of ['', '# Owner-merged kinds\n\nno table here\n', withoutColumn, ragged]) {
      for (const overrides of [{}, { description: cardBody(942, 'owner'), shardActive: true, shardUnder: 216, decisions: [{ decisionId: 216, text: 'Delegation.', cards: [] }] }, { windowShard: 'shard-window' }])
        expect(mergePolicy(facts({ ...overrides, ownerMergesText })), ownerMergesText.slice(0, 40)).toMatchObject({ kind: 'denied', rule: 'owner_merges_unread' })
    }
  })

  it('a no-shard-merge or unread owner-merges denial opens an owner merge wait', () => {
    expect([...OWNER_MERGES_RULES]).toEqual(expect.arrayContaining(['no_shard_merge', 'owner_merges_unread']))
  })

  it('a decision is never taken by default', () => {
    expect(mergePolicy(facts({ description: 'no card here' }))).toMatchObject({ kind: 'denied', rule: 'decision_unread' })
    expect(mergePolicy(facts({ description: cardBody(943) }))).toMatchObject({ kind: 'denied', rule: 'decision_unread' })
    expect(mergePolicy(facts({ description: '#1042 a-probe [probe/netwatch/S/cheap/none] · depends — · blocks —' }))).toMatchObject({ kind: 'denied', rule: 'decision_unread' })
  })

  it('a version PR, security-invariants, owner by risk and a reserved card are denied with authority and reach the inbox', () => {
    const bench = liveBench()
    const cases: [Partial<FakePull> & { number: number }, string][] = [
      [{ number: 950, ref: 'changeset-release/main' }, 'version_pr'],
      [{ number: 951, title: 'chore: version packages' }, 'version_pr'],
      [{ number: 952, files: ['architecture/security-invariants.md'] }, 'no_shard_merge'],
      [{ number: 953, files: ['templates/base/architecture/security-invariants.md'] }, 'no_shard_merge'],
      [{ number: 954, files: ['scripts/policy/policy.ts', 'scripts/ladder/approve.ts'] }, 'owner_by_risk'],
      [{ number: 955, body: `${cardBody(955, 'owner')}\n\n#1055 reserved` }, 'reserved'],
    ]
    for (const [pull] of cases)
      bench.gitHub.open({ review: 'success', files: ['scripts/policy/policy.ts'], ...pull })
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
    for (const overrides of [{ headRef: 'changeset-release/main' }, { files: ['architecture/security-invariants.md'] }, { files: ['scripts/ladder/approve.ts'] }, { description: `${cardBody(942, 'owner')}\n#1042 reserved` }])
      expect(mergePolicy(facts({ ...overrides, shardActive: true })).kind).toBe('denied')
  })

  it('a window shard lifts owner_by_risk and R1 and leaves the version pull request, security-invariants and a reserved card the owner\'s', () => {
    const owner = { description: cardBody(942, 'owner'), windowShard: 'shard-window' }
    for (const files of [['scripts/ladder/approve.ts'], ['scripts/core/queue.ts']])
      expect(mergePolicy(facts({ ...owner, files }))).toMatchObject({ kind: 'allowed', rule: 'owner_under_shard', detail: expect.stringContaining('shard-window') as unknown })
    expect(mergePolicy(facts({ ...owner, headRef: 'changeset-release/main' }))).toMatchObject({ kind: 'denied', rule: 'version_pr' })
    expect(mergePolicy(facts({ ...owner, files: ['architecture/security-invariants.md'] }))).toMatchObject({ kind: 'denied', rule: 'no_shard_merge' })
    expect(mergePolicy(facts({ ...owner, description: `${cardBody(942, 'owner')}\n#1042 reserved` }))).toMatchObject({ kind: 'denied', rule: 'reserved' })
  })

  it('whatever the until, the version pull request and a reserved card get policy.denied authority under a shard --under D-N', () => {
    const d82 = { decisionId: 82, text: 'Delegation. until 2026-10-12T04:30Z', cards: [] }
    const owner = { description: cardBody(942, 'owner'), shardActive: true, shardUnder: 82 }
    for (const decisions of [[d82], []]) {
      expect(mergePolicy(facts({ ...owner, decisions, headRef: 'changeset-release/main' }))).toMatchObject({ kind: 'denied', rule: 'version_pr' })
      expect(mergePolicy(facts({ ...owner, decisions, title: 'chore: version packages' }))).toMatchObject({ kind: 'denied', rule: 'version_pr' })
      expect(mergePolicy(facts({ ...owner, decisions, description: `${cardBody(942, 'owner')}\n#1042 reserved` }))).toMatchObject({ kind: 'denied', rule: 'reserved' })
      expect(mergePolicy(facts({ ...owner, decisions: [...decisions, { decisionId: 84, text: '#1042 reserved: Eli merges it.', cards: [1042] }] }))).toMatchObject({ kind: 'denied', rule: 'reserved' })
    }
    expect(mergePolicy(facts({ ...owner, decisions: [d82], files: ['architecture/security-invariants.md', 'scripts/ladder/approve.ts'] }))).toMatchObject({ kind: 'denied', rule: 'no_shard_merge' })
    expect(mergePolicy(facts({ ...owner, decisions: [d82], files: ['scripts/ladder/approve.ts'] }))).toMatchObject({ kind: 'allowed', rule: 'owner_under_shard', detail: expect.stringContaining('D-82') as unknown })
    expect(mergePolicy(facts({ ...owner, decisions: [], files: ['scripts/ladder/approve.ts'] }))).toMatchObject({ kind: 'denied', rule: 'owner_by_risk' })
  })

  it('under D-77 a PR with an owner path, a pass and green CI is merged without a shard', () => {
    const bench = underDecisions(D77)
    const pulls = [
      { number: 960, files: ['.claude/commands/plan.md'] },
      { number: 961, body: cardBody(961, 'owner'), files: ['scripts/policy/policy.ts'] },
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
      [971, ['.github/workflows/ci.yml'], 'no_shard_merge'],
      [972, ['architecture/security-invariants.md'], 'no_shard_merge'],
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

describe('the close policy', () => {
  const closeFacts = (over: Partial<CloseFacts> = {}): CloseFacts => ({ pr: 980, state: 'open', headRef: 'feat/card-1080', body: cardBody(980), cardId: 1080, mergeLeased: false, ...over })

  it('allows the open pull request of the named card under no merge lease', () => {
    expect(closePolicy(closeFacts())).toMatchObject({ kind: 'allowed', rule: 'card_pr' })
  })

  it('refuses each pull request it must not close, by the rule that holds it', () => {
    expect(closePolicy(closeFacts({ headRef: 'changeset-release/main' }))).toMatchObject({ kind: 'denied', rule: 'version_pr' })
    expect(closePolicy(closeFacts({ state: 'closed' }))).toMatchObject({ kind: 'denied', rule: 'not_open', detail: 'PR #980 is closed, not open' })
    expect(closePolicy(closeFacts({ body: 'no card line' }))).toMatchObject({ kind: 'denied', rule: 'no_card' })
    expect(closePolicy(closeFacts({ cardId: 1081 }))).toMatchObject({ kind: 'denied', rule: 'other_card' })
    expect(closePolicy(closeFacts({ mergeLeased: true }))).toMatchObject({ kind: 'denied', rule: 'merge_leased' })
  })
})
