import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const VITEST = path.join(REPO_ROOT, 'node_modules', '.bin', 'vitest')
const WITNESS_FILE = 'tests/witness.test.ts'

const FIXTURE = `describe('the fixture', () => {
  it('holds', () => expect(1).toBe(1))
  it('breaks', () => expect(1).toBe(2))
})
`

let tree: string
let outside: string

function git(...args: string[]): string {
  return spawnSync('git', args, { cwd: tree, encoding: 'utf8' }).stdout
}

function witness(...args: string[]): { status: number | null, stdout: string, output: string } {
  const result = spawnSync(VITEST, ['run', WITNESS_FILE, '--config', path.join(REPO_ROOT, 'vitest.config.ts'), '--root', tree, '--globals', ...args], {
    cwd: tree,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', CI: '1' },
  })
  return { status: result.status, stdout: result.stdout, output: `${result.stdout}${result.stderr}` }
}

beforeEach(() => {
  tree = mkdtempSync(path.join(tmpdir(), 'witness-tree-'))
  outside = mkdtempSync(path.join(tmpdir(), 'witness-report-'))
  mkdirSync(path.join(tree, 'tests'))
  writeFileSync(path.join(tree, WITNESS_FILE), FIXTURE)
  writeFileSync(path.join(tree, '.gitignore'), 'node_modules/\n')
  git('init', '--quiet')
  git('add', '.')
  git('-c', 'user.name=witness', '-c', 'user.email=witness@example.invalid', 'commit', '--quiet', '-m', 'fixture')
})

afterEach(() => {
  rmSync(tree, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

describe('a witness run through vitest.config.ts', () => {
  it('a typo in the test name fails the run', () => {
    const run = witness('-t', 'hodls')
    expect(run.status).toBe(1)
    expect(run.output).toContain('the name filter /hodls/ matched no test')
  })

  it('a typo in the test name fails the run under a reporter given on the command line', () => {
    const run = witness('-t', 'hodls', '--reporter=dot')
    expect(run.status).toBe(1)
    expect(run.output).toContain('matched no test')
  })

  it('a filter that matches a passing test passes', () => {
    const run = witness('-t', 'holds')
    expect(run.status).toBe(0)
    expect(run.output).not.toContain('matched no test')
  })

  it('an honest red on base passes', () => {
    const run = witness('-t', 'breaks')
    expect(run.status).toBe(1)
    expect(run.output).toContain('expected 1 to be 2')
    expect(run.output).not.toContain('matched no test')
  })

  it('a grep on stdout the report is not written to is refused', () => {
    const run = witness('-t', 'holds', '--reporter=json')
    expect(run.status).not.toBe(0)
    expect(run.output).toContain('the json report has no outputFile')
    expect(run.stdout).not.toContain('"numPassedTests"')
    expect(existsSync(path.join(tree, '.vitest'))).toBe(false)
  })

  it('a witness run leaves the tree clean', () => {
    const report = path.join(outside, 'report.json')
    const run = witness('-t', 'holds', '--reporter=json', `--outputFile.json=${report}`)
    expect(run.status).toBe(0)
    expect(readFileSync(report, 'utf8')).toContain('"numPassedTests":1')
    expect(git('status', '--porcelain', '--untracked-files=all')).toBe('')
  })
})
