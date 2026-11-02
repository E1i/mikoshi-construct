import type { CheckFacts } from '../src/commands/intake/check.js'
import type { DraftCard } from '../src/commands/intake/draft.js'
import type { RepositoryFacts } from '../src/commands/intake/facts.js'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runOnTree } from '../scripts/ports/witnesses.js'
import { realShell, withWorktree } from '../scripts/ports/worktree.js'
import { checkDraft } from '../src/commands/intake/check.js'

const CREATED = 'zerotouch/alpha.md'
const OVER_CREATED = `grep -qx alpha ${CREATED}`
const BASE_GREEN = 'pnpm exec changeset status'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function draftCard(fields: Partial<DraftCard> = {}): DraftCard {
  return { name: 'p7creates', kind: 'implement', milestone: 'runner', size: 'S', contour: 'cheap', decision: 'auto', touches: ['scripts/a.ts'], task: 'A card.', witnesses: [], depends: [], blocks: [], creates: [], unclear: [], ...fields }
}

function repositoryFacts(existing: readonly string[]): RepositoryFacts {
  return { exists: relative => existing.includes(relative), pathsNamed: () => [], commandResolves: () => true, testsCovering: () => [] }
}

function facts(existing: readonly string[]): CheckFacts {
  return { taken: new Set(), parked: new Set(), done: new Set(), merged: new Set(), repository: repositoryFacts(existing) }
}

function witnessReasons(card: DraftCard, existing: readonly string[] = ['scripts/a.ts', '.changeset']): string[] {
  const [checked] = checkDraft([card], [2], facts(existing))
  return checked!.unclear.filter(field => field.field === 'witnesses').map(field => field.reason)
}

describe('intake over the witnesses of a card', () => {
  it('intake marks unclear an implement witness that cannot be red on the base', () => {
    const change = `\`${BASE_GREEN}\` exits 0 on head and fails on base`

    expect(witnessReasons(draftCard({ witnesses: [change] }))).toEqual([expect.stringContaining('cannot be red on the base')])
    expect(witnessReasons(draftCard({ witnesses: [`\`${BASE_GREEN}\` exits 0`] }))).toEqual([])
    expect(witnessReasons(draftCard({ kind: 'probe', decision: 'none', witnesses: [change] }))).toEqual([])
    expect(witnessReasons(draftCard({ witnesses: ['`pnpm exec vitest run tests/a.test.ts -t \'x\'` exits 0 on head and fails on base'] }), ['scripts/a.ts', 'tests/a.test.ts'])).toEqual([])
  })

  it('a witness over a path the card creates is not marked unclear', () => {
    const witnesses = [`\`${OVER_CREATED}\` exits 0 on head and fails on base`, `\`${OVER_CREATED}\` exits 0`]

    expect(witnessReasons(draftCard({ creates: [CREATED], witnesses }))).toEqual([])
    expect(witnessReasons(draftCard({ witnesses }))).toEqual([
      expect.stringContaining('reads nothing the tree under test can change'),
      expect.stringContaining('cannot be red on the base'),
      expect.stringContaining('reads nothing the tree under test can change'),
    ])
  })
})

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, '-c', 'user.name=bus', '-c', 'user.email=bus@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim()
}

function commit(repo: string, files: Record<string, string>): string {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
    writeFileSync(path.join(repo, file), content)
    git(repo, 'add', file)
  }
  git(repo, 'commit', '-q', '-m', Object.keys(files).join(' '))
  return git(repo, 'rev-parse', 'HEAD')
}

interface Outcome { refusals: string[], log: string[] }

function invariantOverCreated(creates: readonly string[]): Outcome {
  const root = mkdtempSync(path.join(tmpdir(), 'p7creates-'))
  roots.push(root)
  const repo = path.join(root, 'repo')
  execFileSync('git', ['init', '-q', repo])
  const base = commit(repo, { 'README.md': 'base\n' })
  const head = commit(repo, { [CREATED]: 'alpha\n' })
  const outcome: Outcome = { refusals: [], log: [] }
  withWorktree(repo, base, tree => runOnTree(
    { tree, base, shell: realShell, log: line => outcome.log.push(line), refuse: (step, problem) => {
      if (problem !== null)
        outcome.refusals.push(`${step}: ${problem}`)
    }, time: (_name, run) => run() },
    { acceptance: [], invariants: [{ criterion: 'alpha is written', command: OVER_CREATED }], harnessCommand: null, sketchSha: head, changed: [], witnessesDir: tree, creates },
  ))
  return outcome
}

describe('the base run over a witness the card creates the paths of', () => {
  // eslint-disable-next-line test/prefer-lowercase-title
  it('P7 takes a witness over created paths as a change witness', () => {
    const taken = invariantOverCreated([CREATED])

    expect(taken.refusals).toEqual([])
    expect(taken.log).toContainEqual(expect.stringMatching(/^invariant "alpha is written": every path it names is in the card's creates; a change witness/))
    expect(invariantOverCreated([]).refusals).toEqual([expect.stringMatching(/^P7: invariant "alpha is written" exits \d+ on the clean base/)])
  })
})
