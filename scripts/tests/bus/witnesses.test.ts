import type { ShellResult } from '../../ports/worktree.js'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cardWitnessesOf } from '../../policy/policy.js'
import { runOnTree, testTargetOf } from '../../ports/witnesses.js'
import { realShell, withWorktree } from '../../ports/worktree.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, '-c', 'user.name=bus', '-c', 'user.email=bus@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim()
}

function commit(repo: string, files: Record<string, string>): string {
  for (const [file, content] of Object.entries(files)) {
    writeFileSync(path.join(repo, file), content)
    git(repo, 'add', file)
  }
  git(repo, 'commit', '-q', '-m', Object.keys(files).join(' '))
  return git(repo, 'rev-parse', 'HEAD')
}

const OUTCOMES: Record<string, ShellResult> = {
  pass: { status: 0, output: ' Tests  1 passed (1)\n' },
  fail: { status: 1, output: ' Tests  1 failed (1)\n' },
  crash: { status: 1, output: 'Error: listen EPERM: operation not permitted\n' },
  unloadable: { status: 1, output: ' FAIL  old.test.ts [ old.test.ts ]\nError: Cannot find module \'./gone.js\'\n Test Files  1 failed (1)\n      Tests  no tests\n' },
  lifecycle: { status: 1, output: '/tree/src/a.ts\n  3:1  error  Unexpected console statement  no-console\n\n✖ 1 problem (1 error, 0 warnings)\n ELIFECYCLE  Command failed with exit code 1.\n' },
}

function fakeVitest(command: string, cwd: string): ShellResult {
  const [, file, name] = /vitest run (\S+) -t '([^']*)'/.exec(command)!
  const at = path.join(cwd, file)
  if (!existsSync(at))
    return { status: 1, output: 'No test files found, exiting with code 1\n' }
  const line = readFileSync(at, 'utf8').split('\n').find(entry => entry.startsWith(`${name}=`))
  if (line === undefined)
    return { status: 1, output: `the name filter /${name}/ matched no test: a witness that matches nothing cannot fail, so this run fails\n` }
  return OUTCOMES[line.slice(name.length + 1)]
}

function shell(command: string, cwd: string): ShellResult {
  return command.startsWith('pnpm exec vitest') ? fakeVitest(command, cwd) : realShell(command, cwd)
}

function vitest(criterion: string, file: string, name: string): { criterion: string, command: string } {
  return { criterion, command: `pnpm exec vitest run ${file} -t '${name}'` }
}

interface Outcome { refusals: string[], log: string[] }

function witnessOn(base: Record<string, string>, head: Record<string, string>, task: { acceptance?: ReturnType<typeof vitest>[], invariants?: ReturnType<typeof vitest>[] }): Outcome {
  const root = mkdtempSync(path.join(tmpdir(), 'witnesses-'))
  roots.push(root)
  const repo = path.join(root, 'repo')
  execFileSync('git', ['init', '-q', repo])
  const baseSha = commit(repo, { 'README.md': 'base\n', ...base })
  const headSha = commit(repo, head)
  const outcome: Outcome = { refusals: [], log: [] }
  withWorktree(repo, baseSha, tree => runOnTree(
    { tree, base: baseSha, shell, log: line => outcome.log.push(line), refuse: (step, problem) => {
      if (problem !== null)
        outcome.refusals.push(`${step}: ${problem}`)
    }, time: (_name, run) => run() },
    { acceptance: task.acceptance ?? [], invariants: task.invariants ?? [], harnessCommand: null, sketchSha: headSha, changed: [], witnessesDir: tree },
  ))
  return outcome
}

describe('the witnesses on the base and the head', () => {
  it('a new acceptance whose test file is not in the base tree is red on the base by absence and green on the head, and is admitted', () => {
    const outcome = witnessOn({}, { 'new.test.ts': 'the thing=pass\n' }, { acceptance: [vitest('the thing; red on main', 'new.test.ts', 'the thing')] })

    expect(outcome.refusals).toEqual([])
    expect(outcome.log).toContainEqual(expect.stringMatching(/^witness "the thing; red on main": red on the base \w{7} by absence/))
  })

  it('a new acceptance whose test name is not in the base file is red on the base by absence', () => {
    const outcome = witnessOn({ 'old.test.ts': 'the old one=pass\n' }, { 'old.test.ts': 'the old one=pass\nthe thing=pass\n' }, { acceptance: [vitest('the thing; red on main', 'old.test.ts', 'the thing')] })

    expect(outcome.refusals).toEqual([])
  })

  it('a new acceptance that matches no test on the head is refused', () => {
    const outcome = witnessOn({}, { 'new.test.ts': 'another thing=pass\n' }, { acceptance: [vitest('the thing; red on main', 'new.test.ts', 'the thing')] })

    expect(outcome.refusals).toEqual([expect.stringMatching(/^P8: positive control "the thing; red on main" matched no test on the sketch/)])
  })

  it('an existing acceptance that fails on the base with an environment error is refused, not red', () => {
    const outcome = witnessOn({ 'old.test.ts': 'the thing=crash\n' }, { 'old.test.ts': 'the thing=pass\n' }, { acceptance: [vitest('the thing; red on main', 'old.test.ts', 'the thing')] })

    expect(outcome.refusals).toEqual([expect.stringMatching(/^P7: witness "the thing; red on main" exits 1 on the base \w{7} with no failing test/)])
  })

  it('an existing acceptance whose suite cannot load on the base is refused, not red', () => {
    const outcome = witnessOn({ 'old.test.ts': 'the thing=unloadable\n' }, { 'old.test.ts': 'the thing=pass\n' }, { acceptance: [vitest('the thing; red on main', 'old.test.ts', 'the thing')] })

    expect(outcome.refusals).toEqual([expect.stringMatching(/^P7: witness "the thing; red on main" exits 1 on the base \w{7} with no failing test/)])
  })

  it('an existing acceptance with a failing test on the base and green on the head is admitted', () => {
    const outcome = witnessOn({ 'old.test.ts': 'the thing=fail\n' }, { 'old.test.ts': 'the thing=pass\n' }, { acceptance: [vitest('the thing; red on main', 'old.test.ts', 'the thing')] })

    expect(outcome.refusals).toEqual([])
  })

  it('an invariant that exists on the base and is red there is refused', () => {
    const outcome = witnessOn({ 'old.test.ts': 'the old test=fail\n' }, { 'old.test.ts': 'the old test=pass\n' }, { invariants: [vitest('the old test passes', 'old.test.ts', 'the old test')] })

    expect(outcome.refusals).toEqual([expect.stringMatching(/^P7: invariant "the old test passes" exits 1 on the clean base/)])
  })

  it('a green refusal carries the output tail, not only its last ELIFECYCLE line', () => {
    const outcome = witnessOn({ 'old.test.ts': 'the old test=lifecycle\n' }, { 'old.test.ts': 'the old test=pass\n' }, { invariants: [vitest('the old test passes', 'old.test.ts', 'the old test')] })

    expect(outcome.refusals).toEqual([expect.stringMatching(/^P7: invariant "the old test passes" exits 1 on the clean base \w{7}: \/tree\/src\/a\.ts · 3:1 {2}error {2}Unexpected console statement {2}no-console · ✖ 1 problem \(1 error, 0 warnings\) · ELIFECYCLE {2}Command failed with exit code 1\.$/)])
  })

  it('a new invariant is not applicable on the base and green on the head allows the merge', () => {
    const outcome = witnessOn({}, { 'new.test.ts': 'the new test=pass\n' }, { invariants: [vitest('the new test passes', 'new.test.ts', 'the new test')] })

    expect(outcome.refusals).toEqual([])
    expect(outcome.log).toContainEqual(expect.stringMatching(/^invariant "the new test passes": not applicable on the base \w{7}: new test/))
  })

  it('a new invariant that stays red on the head is refused there', () => {
    const outcome = witnessOn({}, { 'new.test.ts': 'the new test=fail\n' }, { invariants: [vitest('the new test passes', 'new.test.ts', 'the new test')] })

    expect(outcome.refusals).toEqual([expect.stringMatching(/^P8: invariant "the new test passes" exits 1 on the sketch/)])
  })

  it('reads the test file and the name filter out of a vitest witness', () => {
    expect(testTargetOf(`pnpm exec vitest run tests/a.test.ts -t 'a name'`)).toEqual({ file: 'tests/a.test.ts', name: 'a name' })
    expect(testTargetOf('pnpm exec vitest run tests/a.test.ts')).toEqual({ file: 'tests/a.test.ts', name: null })
    expect(testTargetOf('test -f done.txt')).toBeNull()
  })
})

describe('a card witness that fails on base is read as acceptance', () => {
  const COMMAND = 'pnpm exec vitest run tests/a.test.ts'
  const cardWith = (item: string): string => `Witnesses:\n- ${item}\n`

  it.each(['fails on base', 'fails on the base', 'fails on main'])('a witness that exits 0 on head and %s is acceptance', (phrase) => {
    const item = `\`${COMMAND}\` exits 0 on head and ${phrase}`

    expect(cardWitnessesOf(cardWith(item))).toEqual({ acceptance: [{ criterion: item, command: COMMAND }], invariants: [] })
  })

  it('a witness that names no failure on the base stays an invariant', () => {
    const item = `\`${COMMAND}\` exits 0 on head and fails nowhere`

    expect(cardWitnessesOf(cardWith(item))).toEqual({ acceptance: [], invariants: [{ criterion: item, command: COMMAND }] })
  })
})
