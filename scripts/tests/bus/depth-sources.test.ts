import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parkingFileText } from '../../../src/card/parking.js'
import { gitDepthSources } from '../../bus/depth-sources.js'

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
  it('read the merge base, the changed files, the MORSE prediction into its journal and the card touches from the parking', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bus-depth-sources-'))
    roots.push(root)
    const repo = path.join(root, 'repo')
    const parking = path.join(root, 'parking')
    const journal = path.join(root, 'morse.jsonl')
    mkdirSync(repo)
    git(repo, ['init', '--quiet', '-b', 'main'])
    const main = commit(repo, { 'docs/guide.md': 'one\n', 'scripts/bus/queue.ts': 'export {}\n' })
    git(repo, ['update-ref', 'refs/remotes/origin/main', main])
    git(repo, ['checkout', '--quiet', '-b', 'feature'])
    const first = commit(repo, { 'docs/guide.md': 'one\ntwo\n' })
    const second = commit(repo, { 'docs/cli.md': 'flags\n' })
    mkdirSync(path.join(parking, 'lane-x'), { recursive: true })
    writeFileSync(path.join(parking, 'lane-x', '1971.md'), parkingFileText({ card: '#1971 a-card [implement/netwatch/M/cheap/auto] · depends — · blocks —', branch: 'feat/a-card', touches: ['docs/**'], continue: 'stop', who: 'shift', body: 'Do the card.' }))

    const sources = gitDepthSources(repo, journal, parking)

    expect(sources.base(second)).toBe(main)
    expect(sources.changed(first, second)).toEqual(['docs/cli.md'])
    expect(sources.predict('review:1971:971:x', main, second)).toEqual({ prediction: { task: 'review:1971:971:x', base: main, head: second, verdict: 'cheap', rule: 'docs-only', why: ['docs/cli.md', 'docs/guide.md'] }, files: ['docs/cli.md', 'docs/guide.md'] })
    expect(readFileSync(journal, 'utf8').trim().split('\n').map(line => JSON.parse(line) as unknown)).toEqual([{ task: 'review:1971:971:x', base: main, head: second, verdict: 'cheap', rule: 'docs-only', why: ['docs/cli.md', 'docs/guide.md'] }])
    expect(sources.touches(1971)).toEqual(['docs/**'])
    expect(sources.touches(1972)).toBeNull()
  })
})
