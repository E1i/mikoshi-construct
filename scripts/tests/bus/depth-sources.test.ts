import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parkingFileText } from '../../../src/card/parking.js'
import { gitDepthSources, gitReviewPlanner, NOTHING_WIDENED } from '../../nodes/review/depth-sources.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=world', '-c', 'user.email=world@example.invalid', '-c', 'commit.gpgsign=false', '-C', repo, ...args], { encoding: 'utf8' }).trim()
}

function commit(repo: string, files: Record<string, string>): string {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
    writeFileSync(path.join(repo, file), text)
  }
  git(repo, ['add', '-A'])
  git(repo, ['commit', '--quiet', '-m', 'step'])
  return git(repo, ['rev-parse', 'HEAD'])
}

describe('git depth sources', () => {
  it('read the merge base, the changed files, the MORSE prediction into its journal and the card touches from its body', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bus-depth-sources-'))
    roots.push(root)
    const repo = path.join(root, 'repo')
    const journal = path.join(root, 'morse.jsonl')
    mkdirSync(repo)
    git(repo, ['init', '--quiet', '-b', 'main'])
    const main = commit(repo, { 'docs/guide.md': 'one\n', 'scripts/core/queue.ts': 'export {}\n' })
    git(repo, ['update-ref', 'refs/remotes/origin/main', main])
    git(repo, ['checkout', '--quiet', '-b', 'feature'])
    const first = commit(repo, { 'docs/guide.md': 'one\ntwo\n' })
    const second = commit(repo, { 'docs/cli.md': 'flags\n' })
    const body = parkingFileText({ card: '#1971 a-card [implement/netwatch/M/cheap/auto] · depends — · blocks —', branch: 'feat/a-card', touches: ['docs/**'], continue: 'stop', who: 'shift', body: 'Do the card.' })

    const sources = gitDepthSources(repo, journal, cardId => cardId === 1971 ? body : null)

    expect(sources.base(second)).toBe(main)
    expect(sources.changed(first, second)).toEqual(['docs/cli.md'])
    expect(sources.predict('review:1971:971:x', main, second)).toEqual({ prediction: { task: 'review:1971:971:x', base: main, head: second, verdict: 'cheap', rule: 'docs-only', why: ['docs/cli.md', 'docs/guide.md'] }, files: ['docs/cli.md', 'docs/guide.md'], added: ['docs/cli.md'] })
    expect(readFileSync(journal, 'utf8').trim().split('\n').map(line => JSON.parse(line) as unknown)).toEqual([{ task: 'review:1971:971:x', base: main, head: second, verdict: 'cheap', rule: 'docs-only', why: ['docs/cli.md', 'docs/guide.md'] }])
    expect(sources.scope(1971)).toMatchObject({ touches: ['docs/**'], runs: [] })
    expect(sources.scope(1972)).toBeNull()
  })

  it('the card scope reads creates from the body without the kind of an entry', () => {
    const fields = { card: '#1971 a-card [implement/netwatch/M/cheap/auto] · depends — · blocks —', branch: 'feat/a-card', touches: ['docs/**'], continue: 'stop', who: 'shift', body: 'Do the card.' }
    const bodies: Record<number, string> = {
      1971: parkingFileText({ ...fields, creates: ['scripts/created.ts (plain)', 'docs/created.md'] }),
      1973: parkingFileText({ ...fields, card: '#1973 a-card [implement/netwatch/M/cheap/auto] · depends — · blocks —' }),
    }
    const sources = gitDepthSources('/nowhere', '/nowhere/morse.jsonl', cardId => bodies[cardId] ?? null)

    expect(sources.scope(1971)).toMatchObject({ touches: ['docs/**'], creates: ['scripts/created.ts', 'docs/created.md'] })
    expect(sources.scope(1973)).toMatchObject({ creates: [] })
  })

  it('plans the depth when the first fetch loses the origin/main ref to a concurrent fetch with cannot lock ref', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bus-depth-sources-'))
    roots.push(root)
    const repo = path.join(root, 'repo')
    mkdirSync(repo)
    git(repo, ['init', '--quiet', '-b', 'main'])
    const main = commit(repo, { 'docs/guide.md': 'one\n' })
    git(repo, ['update-ref', 'refs/remotes/origin/main', main])
    git(repo, ['checkout', '--quiet', '-b', 'feature'])
    const head = commit(repo, { 'docs/guide.md': 'one\ntwo\n' })
    const body = parkingFileText({ card: '#1971 a-card [implement/netwatch/M/cheap/auto] · depends — · blocks —', branch: 'feat/a-card', touches: ['docs/**'], continue: 'stop', who: 'shift', body: 'Do the card.' })
    const fetches: string[][] = []
    const run = (dir: string, args: string[]): string => {
      if (args[0] !== 'fetch')
        return git(dir, args)
      fetches.push(args)
      if (fetches.length === 1)
        throw Object.assign(new Error('Command failed: git fetch'), { stderr: `error: cannot lock ref 'refs/remotes/origin/main': is at f9df51b4 but expected 79526af1\n` })
      return ''
    }

    const plan = gitReviewPlanner(repo, path.join(root, 'morse.jsonl'), cardId => cardId === 1971 ? body : null, run, NOTHING_WIDENED)({ taskKey: 'review:1971:1233:x', queue: 'review', cardId: 1971, pr: 1233, head, leaseGen: 1, actor: 'worker:review:x' }, null)

    expect(fetches).toEqual([['fetch', '--quiet', 'origin', 'main', 'pull/1233/head'], ['fetch', '--quiet', 'origin', 'main', 'pull/1233/head']])
    expect(plan).toMatchObject({ depth: 'diff', round: 'first', since: main, touchFindings: [] })
  })

  it('an again round on a head that merged main diffs from the merge-base, so a file main brought in is not a change of the card', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bus-depth-sources-'))
    roots.push(root)
    const repo = path.join(root, 'repo')
    mkdirSync(repo)
    git(repo, ['init', '--quiet', '-b', 'main'])
    commit(repo, { 'docs/guide.md': 'one\n' })
    git(repo, ['checkout', '--quiet', '-b', 'feature'])
    const reviewed = commit(repo, { 'docs/guide.md': 'one\ntwo\n' })
    git(repo, ['checkout', '--quiet', 'main'])
    const main = commit(repo, { 'scripts/ports/prepare-tree.ts': 'export {}\n' })
    git(repo, ['update-ref', 'refs/remotes/origin/main', main])
    git(repo, ['checkout', '--quiet', 'feature'])
    git(repo, ['merge', '--quiet', '--no-edit', 'main'])
    const head = commit(repo, { 'docs/guide.md': 'one\ntwo\nthree\n' })
    const run = (dir: string, args: string[]): string => args[0] === 'fetch' ? '' : git(dir, args)
    const lease = { taskKey: `review:1971:1233:${head}`, queue: 'review' as const, cardId: 1971, pr: 1233, head, leaseGen: 1, actor: 'worker:review:x' }

    const plan = gitReviewPlanner(repo, path.join(root, 'morse.jsonl'), () => null, run, NOTHING_WIDENED)(lease, { head: reviewed, verdict: 'changes', findings: ['docs/guide.md: the heading is wrong'] })

    expect(git(repo, ['diff', '--name-only', reviewed, head]).split('\n')).toContain('scripts/ports/prepare-tree.ts')
    expect(plan).toEqual({ depth: 'diff', round: 'again', why: `${reviewed}..${head} changes only files the earlier changes verdict's findings name`, since: main, reviewed, findings: ['docs/guide.md: the heading is wrong'] })
  })

  it('still fails a fetch whose error is not a lost ref race, without a retry', () => {
    let fetches = 0
    const run = (_dir: string, args: string[]): string => {
      if (args[0] === 'fetch')
        fetches += 1
      throw new Error('fatal: could not read from remote repository')
    }

    expect(() => gitReviewPlanner('/nowhere', '/nowhere/morse.jsonl', () => null, run, NOTHING_WIDENED)({ taskKey: 'review:1:2:x', queue: 'review', cardId: 1, pr: 2, head: 'abc', leaseGen: 1, actor: 'worker:review:x' }, null)).toThrow('could not read from remote')
    expect(fetches).toBe(1)
  })
})
