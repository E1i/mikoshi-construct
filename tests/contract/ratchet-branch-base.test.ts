import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { branchBase, checkRatchet, ownershipMoves } from '../../scripts/contract/ratchet.js'

const GIT_IDENTITY = ['-c', 'user.name=fixture', '-c', 'user.email=fixture', '-c', 'commit.gpgsign=false']
const GROWN_ROW = 'boundary:app->ports'
const ABSENT_MAIN = ['refs/heads/absent']
const ON_PULL_REQUEST = { GITHUB_EVENT_NAME: 'pull_request' }
const OUTSIDE_CI = {}
const roots: string[] = []

afterAll(() => {
  for (const root of roots)
    rmSync(root, { recursive: true, force: true })
})

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...GIT_IDENTITY, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
}

function commitFile(root: string, file: string): string {
  writeFileSync(path.join(root, file), file)
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '-m', file)
  return git(root, 'rev-parse', 'HEAD')
}

interface Diverged {
  root: string
  mainTip: string
  cardTip: string
}

function cardAndMainDiverged(): Diverged {
  const root = mkdtempSync(path.join(tmpdir(), 'ratchet-base-'))
  roots.push(root)
  git(root, 'init', '-q', '-b', 'main')
  commitFile(root, 'start')
  git(root, 'checkout', '-q', '-b', 'card')
  const cardTip = commitFile(root, 'card')
  git(root, 'checkout', '-q', 'main')
  const mainTip = commitFile(root, 'main')
  return { root, mainTip, cardTip }
}

function pullRequestMergeCommit(): Diverged {
  const diverged = cardAndMainDiverged()
  git(diverged.root, 'checkout', '-q', '--detach', 'main')
  git(diverged.root, 'merge', '-q', '--no-ff', '-m', 'merge card into main', 'card')
  return diverged
}

function mainMergedIntoCard(): Diverged {
  const diverged = cardAndMainDiverged()
  git(diverged.root, 'checkout', '-q', 'card')
  git(diverged.root, 'merge', '-q', '--no-ff', '-m', 'merge main into card', 'main')
  return diverged
}

function singleCommitCheckout(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'ratchet-base-'))
  roots.push(root)
  git(root, 'init', '-q', '-b', 'card')
  commitFile(root, 'only')
  return root
}

describe('the base the boundary ratchet reads a grown row against', () => {
  it('an unreachable base fails the check with its reason', () => {
    const root = singleCommitCheckout()
    const sources = { mainRefs: ABSENT_MAIN, env: ON_PULL_REQUEST }

    expect(() => branchBase(root, sources)).toThrow(/no base for this branch on a pull_request run: .*no merge-base with refs\/heads\/absent.*fetch-depth 2/)
    expect(() => ownershipMoves(root, [GROWN_ROW], sources)).toThrow(/finds no base for this branch/)
    expect(() => checkRatchet(root, {}, { [GROWN_ROW]: 1 }, sources)).toThrow(/finds no base for this branch/)
  })

  it('a check with no grown boundary row reads no base', () => {
    const root = singleCommitCheckout()

    expect(ownershipMoves(root, [], { mainRefs: ABSENT_MAIN, env: OUTSIDE_CI })).toEqual(new Set())
  })

  it('on a pull request merge commit the base is its first parent', () => {
    const { root, mainTip } = pullRequestMergeCommit()

    expect(git(root, 'rev-parse', 'HEAD^1')).toBe(mainTip)
    expect(branchBase(root, { mainRefs: ABSENT_MAIN, env: ON_PULL_REQUEST })).toBe(mainTip)
  })

  it('outside CI a merge of main into the card reads the merge-base, not the first parent', () => {
    const { root, mainTip, cardTip } = mainMergedIntoCard()

    expect(git(root, 'rev-parse', 'HEAD^1')).toBe(cardTip)
    expect(branchBase(root, { mainRefs: ['main'], env: OUTSIDE_CI })).toBe(mainTip)
  })

  it('a pull request run on a commit that is no merge reads the merge-base', () => {
    const { root, cardTip } = cardAndMainDiverged()
    git(root, 'checkout', '-q', 'card')
    const forkPoint = git(root, 'rev-parse', 'HEAD^1')
    commitFile(root, 'card-again')

    expect(git(root, 'rev-parse', 'HEAD^1')).toBe(cardTip)
    expect(branchBase(root, { mainRefs: ['main'], env: ON_PULL_REQUEST })).toBe(forkPoint)
  })
})
