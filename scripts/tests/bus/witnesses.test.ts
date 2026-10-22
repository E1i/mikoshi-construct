import type { Witness } from '../../bus/witnesses.js'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runOnTree } from '../../bus/witnesses.js'
import { realShell, withWorktree } from '../../ports/worktree.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, '-c', 'user.name=bus', '-c', 'user.email=bus@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim()
}

function commit(repo: string, file: string): string {
  writeFileSync(path.join(repo, file), `${file}\n`)
  git(repo, 'add', file)
  git(repo, 'commit', '-q', '-m', file)
  return git(repo, 'rev-parse', 'HEAD')
}

function vitestLike(testFile: string): string {
  return `if [ -f ${testFile} ]; then echo '1 passed'; else echo 'No test files found, exiting with code 1'; exit 1; fi`
}

const DONE: Witness = { criterion: '`test -f done.txt` exits 0; red on main', command: 'test -f done.txt' }

interface Outcome { refusals: string[], log: string[] }

function witnessOn(head: string[], acceptance: Witness[], invariants: Witness[]): Outcome {
  const root = mkdtempSync(path.join(tmpdir(), 'witnesses-'))
  roots.push(root)
  const repo = path.join(root, 'repo')
  execFileSync('git', ['init', '-q', repo])
  const base = commit(repo, 'README.md')
  let sketch = base
  for (const file of head)
    sketch = commit(repo, file)
  const outcome: Outcome = { refusals: [], log: [] }
  withWorktree(repo, base, tree => runOnTree(
    { tree, base, shell: realShell, log: line => outcome.log.push(line), refuse: (step, problem) => {
      if (problem !== null)
        outcome.refusals.push(`${step}: ${problem}`)
    }, time: (_name, run) => run() },
    { acceptance, invariants, harnessCommand: null, sketchSha: sketch, changed: [], witnessesDir: tree },
  ))
  return outcome
}

describe('the witnesses on the base and the head', () => {
  it('a new invariant is not applicable on the base and green on the head allows the merge', () => {
    const invariant = { criterion: 'the new test passes', command: vitestLike('new.test.ts') }
    const outcome = witnessOn(['done.txt', 'new.test.ts'], [DONE], [invariant])

    expect(outcome.refusals).toEqual([])
    expect(outcome.log).toContainEqual(expect.stringMatching(/^invariant "the new test passes": not applicable on the base \w{7}: new test/))
  })

  it('a new invariant that stays red on the head is refused there', () => {
    const invariant = { criterion: 'the new test passes', command: vitestLike('new.test.ts') }
    const outcome = witnessOn(['done.txt'], [DONE], [invariant])

    expect(outcome.refusals).toEqual([expect.stringMatching(/^P8: invariant "the new test passes" exits 1 on the sketch/)])
  })

  it('an invariant that exists on the base and is red there is refused', () => {
    const invariant = { criterion: 'the old test passes', command: `echo 'Tests  1 failed'; test -f fixed.txt` }
    const outcome = witnessOn(['done.txt', 'fixed.txt'], [DONE], [invariant])

    expect(outcome.refusals).toEqual([expect.stringMatching(/^P7: invariant "the old test passes" exits 1 on the clean base/)])
  })

  it('an acceptance witness that matches no test on the base is refused', () => {
    const acceptance = { criterion: 'the named test passes; red on main', command: `test -f done.txt || { echo 'the name filter /named/ matched no test: a witness that matches nothing cannot fail, so this run fails'; exit 1; }` }
    const outcome = witnessOn(['done.txt'], [acceptance], [])

    expect(outcome.refusals).toEqual([expect.stringMatching(/^P7: witness "the named test passes; red on main" matched no test on the base/)])
  })
})
