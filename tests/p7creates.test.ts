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
import { witnessDowngrades } from '../src/commands/intake/admit.js'
import { checkDraft, isChangeWitness } from '../src/commands/intake/check.js'

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

  it('a file-less vitest name witness is not marked as cannot be red on the base', () => {
    for (const command of ['pnpm exec vitest run -t \'depends on a card merged in an archived month\'', 'pnpm exec vitest run --testNamePattern="a name"'])
      expect(witnessReasons(draftCard({ witnesses: [`\`${command}\` exits 0 on head; red on main`] }))).toEqual([])
    expect(witnessReasons(draftCard({ witnesses: ['`pnpm exec vitest run` exits 0 on head; red on main'] }))).toEqual([expect.stringContaining('cannot be red on the base')])
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

interface Run { headFiles?: Record<string, string>, creates?: string[], sketch?: boolean }

function invariantOn(command: string, baseFiles: Record<string, string> = {}, run: Run = {}): Outcome {
  const { headFiles = { [CREATED]: 'alpha\n' }, creates, sketch = true } = run
  const root = mkdtempSync(path.join(tmpdir(), 'p7creates-'))
  roots.push(root)
  const repo = path.join(root, 'repo')
  execFileSync('git', ['init', '-q', repo])
  const base = commit(repo, { 'README.md': 'base\n', ...baseFiles })
  const head = commit(repo, headFiles)
  const outcome: Outcome = { refusals: [], log: [] }
  withWorktree(repo, base, tree => runOnTree(
    { tree, base, shell: realShell, log: line => outcome.log.push(line), refuse: (step, problem) => {
      if (problem !== null)
        outcome.refusals.push(`${step}: ${problem}`)
    }, time: (_name, run) => run() },
    { acceptance: [], invariants: [{ criterion: 'alpha is written', command }], harnessCommand: null, sketchSha: sketch ? head : null, changed: sketch ? [] : null, witnessesDir: tree, creates },
  ))
  return outcome
}

describe('the base run over a witness the card creates the paths of', () => {
  // eslint-disable-next-line test/prefer-lowercase-title
  it('P7 takes a witness over created paths as a change witness', () => {
    const taken = invariantOn(OVER_CREATED)

    expect(taken.refusals).toEqual([])
    expect(taken.log).toContainEqual(expect.stringMatching(/^invariant "alpha is written": red on the base \w{7} over paths the head creates, and nothing else; a change witness/))
    expect(invariantOn(`grep -qx alpha README.md ${CREATED}`).refusals).toEqual([expect.stringMatching(/^P7: invariant "alpha is written" exits \d+ on the clean base/)])
  })

  it('keeps a red invariant over a directory the base already has, though the head adds a file under it', () => {
    expect(invariantOn('grep -rqx alpha docs', { 'docs/a.md': 'beta\n' }, { headFiles: { 'docs/b.md': 'alpha\n' } }).refusals).toEqual([expect.stringMatching(/^P7: invariant "alpha is written" exits 1 on the clean base/)])
    expect(invariantOn('grep -rqx alpha zerotouch').refusals).toEqual([])
  })

  it('reads the paths of a witness as intake reads them, in every written form', () => {
    for (const command of [`grep -qx alpha ./${CREATED}`, `grep -qx alpha '${CREATED}'`, `test -f "${CREATED}"`, `cat ${CREATED} 2>/dev/null`]) {
      expect(witnessReasons(draftCard({ creates: [CREATED], witnesses: [`\`${command}\` fails on base`] }))).toEqual([])
      expect(invariantOn(command).refusals).toEqual([])
      expect(invariantOn(`! ${command}`).refusals).toEqual([expect.stringMatching(/^P8: invariant "alpha is written" exits 1 on the sketch/)])
    }
  })

  it('a witness the head creates the file for but stays red on is refused as a positive control', () => {
    const outcome = invariantOn(OVER_CREATED, {}, { headFiles: { [CREATED]: 'beta\n' } })

    expect(outcome.refusals).toEqual([expect.stringMatching(/^P8: positive control "alpha is written" exits 1 on the sketch/)])
  })

  it('an invariant red on the base that names no repository path is refused on the clean base', () => {
    for (const command of ['grep -qx alpha /no/such/file', 'grep -qx alpha nowhere'])
      expect(invariantOn(command).refusals[0]).toMatch(/^P7: invariant "alpha is written" exits 2 on the clean base/)
  })

  it('reads a path the head creates from the card\'s creates, as intake does', () => {
    expect(invariantOn(OVER_CREATED, {}, { sketch: false, creates: [CREATED] }).refusals).toEqual([])
    expect(invariantOn(OVER_CREATED, {}, { sketch: false }).refusals).toEqual([expect.stringMatching(/^P7: invariant "alpha is written" exits 2 on the clean base/)])
    expect(invariantOn('grep -qx alpha README.md', {}, { sketch: false, creates: ['README.md'] }).refusals).toEqual([expect.stringMatching(/^P7: invariant "alpha is written" exits 1 on the clean base/)])
  })
})

describe('one reading of a change witness', () => {
  it('counts every wording intake and admit use for a witness red on the base', () => {
    for (const witness of ['`x` Red on main', '`x` red on the base', '`x` exits 0 on head and fails on base', '`x` · acceptance'])
      expect(isChangeWitness(witness)).toBe(true)
    expect(isChangeWitness('`x` exits 0')).toBe(false)
  })

  it('intake --admit reads a downgrade by the predicate intake reads a change witness by', () => {
    const change = '`x` exits 0 on head and fails on base'

    expect(witnessDowngrades([change], [`${change} · invariant`])).toEqual([change])
    expect(witnessDowngrades([change], [change])).toEqual([])
  })
})
