import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { doneCheck } from '../../done/check.js'
import { realShell } from '../../ghosts/preflight-trees.js'

const LEGACY = 'export function legacy(value: number): number {\n  return 0\n}\n'
const REAL = 'function add(sum: number, item: number): number {\n  return sum + item\n}\n\nexport function total(items: number[]): number {\n  return items.reduce(add, 0)\n}\n'
const STUB = 'export function total(items: number[]): number {\n  return 0\n}\n'
const WIRED = 'import { total } from \'./total.js\'\n\nexport function main(): number {\n  return total([1, 2])\n}\n'
const TEST = 'import { expect, it } from \'vitest\'\nimport { total } from \'../src/total.js\'\n\nit(\'sums the items\', () => {\n  expect(total([])).toBe(0)\n})\n'

const fixtures: string[] = []

afterEach(() => {
  for (const fixture of fixtures.splice(0))
    rmSync(fixture, { recursive: true, force: true })
})

interface World {
  root: string
  base: string
  args: string
  journal: string
}

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' }).trim()
}

function put(root: string, file: string, text: string): void {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
  writeFileSync(path.join(root, file), text)
}

function world(total: string, wired: boolean, tracked: Record<string, [string, string]> = {}): World {
  const root = mkdtempSync(path.join(tmpdir(), 'done-check-'))
  fixtures.push(root, `${root}-args.json`, `${root}-handoff`)
  git(root, ['init', '-q'])
  put(root, 'package.json', '{"name":"fixture","type":"module","bin":"src/cli.ts"}\n')
  put(root, 'src/cli.ts', 'import { main } from \'./app.js\'\n\nmain()\n')
  put(root, 'src/app.ts', 'export function main(): number {\n  return 1\n}\n')
  put(root, 'src/legacy.ts', LEGACY)
  for (const [file, [before]] of Object.entries(tracked))
    put(root, file, before)
  git(root, ['add', '-A'])
  git(root, ['commit', '-q', '-m', 'base'])
  const base = git(root, ['rev-parse', 'HEAD'])
  put(root, 'src/total.ts', total)
  for (const [file, [, after]] of Object.entries(tracked))
    put(root, file, after)
  if (wired)
    put(root, 'src/app.ts', WIRED)
  put(root, 'tests/total.test.ts', TEST)
  put(root, 'tests/other.test.ts', 'import { expect, it } from \'vitest\'\n\nit(\'sums the items\', () => {\n  expect(3).toBe(3)\n})\n')
  put(root, 'tests/skipped.test.ts', 'import { it } from \'vitest\'\nimport { total } from \'../src/total.js\'\n\nit.skip(\'sums the items\', () => {\n  total([])\n})\n')
  const args = `${root}-args.json`
  writeFileSync(args, JSON.stringify({ acceptance: ['the total sums the items'], design: '- D1. total sums its items.' }))
  return { root, base, args, journal: `${root}-handoff/ghosts.jsonl` }
}

function row(id: string, line: number): { id: string, code: string[], tests: Array<{ file: string, title: string } | { witness: string }> } {
  return { id, code: [`src/total.ts:${line}`], tests: [{ file: 'tests/total.test.ts', title: 'sums the items' }] }
}

function run(w: World, rows: unknown, base = w.base): { passed: boolean, lines: string[] } {
  const map = path.join(tmpdir(), `done-map-${Math.random().toString(36).slice(2)}.json`)
  fixtures.push(map)
  writeFileSync(map, typeof rows === 'string' ? rows : JSON.stringify({ requirements: rows }))
  return doneCheck(w.root, { args: w.args, map, base, task: 't1' }, { shell: realShell, journal: w.journal })
}

function withoutMapPath(result: { lines: string[] }): string[] {
  return result.lines.map(line => line.replace(/^ {2}\S+: /, '  '))
}

const TOTAL_PASS = [
  'PASS',
  '2 requirements mapped, 3 functions checked, no stub, nothing unwired',
  'checked by name only:',
  '  src/app.ts:3 main',
  '  src/total.ts:1 add',
  '  src/total.ts:5 total',
]

describe('doneCheck', () => {
  it('a stub counted as done fails', () => {
    const w = world(STUB, true)
    expect(run(w, [row('A1', 2), row('D1', 2)])).toEqual({
      passed: false,
      lines: ['FAIL', 'stubs:', '  src/total.ts:1 total: it returns a literal and never reads its parameters'],
    })
  })

  it('a function nothing outside tests names fails as unwired', () => {
    const w = world(REAL, false)
    expect(run(w, [row('A1', 6), row('D1', 6)])).toEqual({
      passed: false,
      lines: ['FAIL', 'unwired:', '  src/total.ts:5 total: nothing outside tests names it', '  src/total.ts: no file outside tests imports or names it'],
    })
  })

  it('a wired implementation with every requirement mapped passes', () => {
    const w = world(REAL, true)
    expect(run(w, [row('A1', 6), row('D1', 6)])).toEqual({ passed: true, lines: TOTAL_PASS })
  })

  it('a requirement with no evidence fails', () => {
    const w = world(REAL, true)
    const ok = [row('A1', 6)]
    const problems = (rows: unknown): string[] => run(w, rows).lines.slice(2)
    expect(problems(ok)).toEqual(['  D1: no evidence in the map'])
    expect(problems([...ok, { id: 'D1', code: [], tests: [] }])).toEqual(['  D1: no code cited', '  D1: no test cited'])
    expect(problems([...ok, row('D1', 99)])).toEqual(['  D1: src/total.ts:99 does not resolve to a line in the tree'])
    expect(problems([...ok, row('D1', 4)])).toEqual(['  D1: src/total.ts:4 does not resolve to a line in the tree'])
    expect(problems([...ok, { ...row('D1', 6), code: ['src/total.ts'] }])).toEqual(['  D1: src/total.ts is not a path:line'])
    expect(problems([...ok, { ...row('D1', 6), tests: [{ file: 'tests/total.test.ts', title: 'adds' }] }])).toEqual(['  D1: tests/total.test.ts has no it or test titled "adds"'])
    expect(problems([...ok, { ...row('D1', 6), tests: [{ file: 'tests/skipped.test.ts', title: 'sums the items' }] }])).toEqual(['  D1: tests/skipped.test.ts has no it or test titled "sums the items"'])
    expect(problems([...ok, { ...row('D1', 6), tests: [{ file: 'tests/other.test.ts', title: 'sums the items' }] }])).toEqual(['  D1: tests/other.test.ts does not reach src/total.ts'])
    expect(problems([...ok, { ...row('D1', 6), tests: [{ file: 'src/app.ts', title: 'sums the items' }] }])).toEqual(['  D1: src/app.ts is not a test file in the tree'])
    expect(problems([row('A1', 6), row('D1', 6), row('D9', 6)])).toEqual(['  D9: the brief has no such requirement'])
  })

  it('an input the check cannot read fails, never passes', () => {
    const w = world(REAL, true)
    const full = [row('A1', 6), row('D1', 6)]
    const input = (result: { passed: boolean, lines: string[] }): void => {
      expect(result.passed).toBe(false)
      expect(result.lines.slice(0, 2)).toEqual(['FAIL', 'input:'])
      expect(result.lines).toHaveLength(3)
    }
    input(run(w, '{ not json'))
    input(run(w, '[]'))
    input(run(w, full, '0000000000000000000000000000000000000000'))
    expect(run(w, full, 'no-such-ref').lines[2]).toBe('  --base no-such-ref is not a commit')
    writeFileSync(w.args, JSON.stringify({ acceptance: [] }))
    input(run(w, full))
  })

  it('a map row carrying a key the map does not define fails as input and names the key', () => {
    const w = world(REAL, true)
    expect(withoutMapPath(run(w, [row('A1', 6), { ...row('D1', 6), more: 'x' }]))).toEqual(['FAIL', 'input:', '  requirements[1] has an unknown key "more"'])
  })

  it('a test entry carrying a key the map does not define fails as input and names the key', () => {
    const w = world(REAL, true)
    const noted = { ...row('D1', 6), tests: [{ file: 'tests/total.test.ts', title: 'sums the items', note: 'x' }] }
    expect(withoutMapPath(run(w, [row('A1', 6), noted]))).toEqual(['FAIL', 'input:', '  requirements[1].tests[0] has an unknown key "note"'])
  })

  it('a map whose rows and test entries carry only the keys the map defines passes', () => {
    const w = world(REAL, true)
    expect(run(w, [row('A1', 6), row('D1', 6)])).toEqual({ passed: true, lines: TOTAL_PASS })
  })

  it('a function the change leaves untouched is not checked', () => {
    const w = world(REAL, true)
    const result = run(w, [row('A1', 6), row('D1', 6)])
    expect(result.lines.join('\n')).not.toContain('legacy')
  })

  it('a function the change leaves untouched inside a changed file is not checked', () => {
    const kept = 'export function kept(value: number): number {\n  return 0\n}\n'
    const w = world(REAL, true, { 'src/grown.ts': [kept, `${kept}\nexport function grown(value: number): number {\n  return 0\n}\n`] })
    expect(run(w, [row('A1', 6), row('D1', 6)]).lines).toEqual([
      'FAIL',
      'stubs:',
      '  src/grown.ts:5 grown: it returns a literal and never reads its parameters',
      'unwired:',
      '  src/grown.ts:5 grown: nothing outside tests names it',
      '  src/grown.ts: no file outside tests imports or names it',
    ])
  })

  it('a function the change adds is checked whether or not the map cites it', () => {
    const extra = `${REAL}\nexport function average(items: number[]): number {\n  throw new Error('not implemented')\n}\n`
    const w = world(extra, true)
    expect(run(w, [row('A1', 6), row('D1', 6)]).lines).toEqual([
      'FAIL',
      'stubs:',
      '  src/total.ts:9 average: it only throws that it is not implemented',
      'unwired:',
      '  src/total.ts:9 average: nothing outside tests names it',
    ])
  })

  it('a witness entry counts only when the brief holds that witness under its digest', () => {
    const w = world(REAL, true)
    const witness = { criterion: 'the total sums the items', command: 'echo one' }
    const brief = (sha256: string): void => writeFileSync(w.args, JSON.stringify({ acceptance: ['the total sums the items'], design: '- D1. total sums its items.', witnesses: [witness], witnessDigests: [{ criterion: witness.criterion, sha256 }] }))
    const byWitness = (name: string): unknown => [{ ...row('A1', 6), tests: [{ witness: name }] }, row('D1', 6)]
    brief(createHash('sha256').update(witness.command).digest('hex'))
    expect(run(w, byWitness('W1'))).toEqual({ passed: true, lines: TOTAL_PASS })
    expect(run(w, byWitness('W2')).lines).toEqual(['FAIL', 'requirements:', '  A1: W2 is not a witness of the brief'])
    expect(run(w, byWitness('W0')).lines).toEqual(['FAIL', 'requirements:', '  A1: W0 is not a witness of the brief'])
    brief(createHash('sha256').update('echo two').digest('hex'))
    expect(run(w, byWitness('W1')).lines).toEqual(['FAIL', 'requirements:', '  A1: W1 does not match its digest'])
  })

  it('a row held only by text needs no test and a PASS counts and lists it', () => {
    const w = world(REAL, true)
    put(w.root, 'NOTES.md', '# Notes\n\nthe total sums the items\n')
    const prose = { id: 'A1', code: ['NOTES.md:3'], tests: [] }
    const testFileOnly = { id: 'D1', code: ['tests/total.test.ts:1'], tests: [] }
    expect(run(w, [prose, testFileOnly])).toEqual({
      passed: true,
      lines: ['PASS · text only 2', ...TOTAL_PASS.slice(1), 'text only:', '  A1: NOTES.md:3', '  D1: tests/total.test.ts:1'],
    })
    expect(run(w, [{ ...prose, code: ['NOTES.md:3', 'src/total.ts:6'] }, testFileOnly]).lines).toEqual(['FAIL', 'requirements:', '  A1: no test cited'])
  })

  it('a grep witness with no match on the head is refused and journalled', () => {
    const w = world(REAL, true)
    const witnesses = [
      { criterion: 'the total is written', command: 'cat src/total.ts | grep -q total' },
      { criterion: 'the average is written', command: 'cat src/total.ts | grep -q average' },
      { criterion: 'the test exits 0', command: 'test -e src/total.ts' },
    ]
    writeFileSync(w.args, JSON.stringify({ acceptance: ['the total sums the items'], design: '- D1. total sums its items.', witnesses }))
    const short = w.base.slice(0, 7)

    expect(existsSync(w.journal)).toBe(false)
    expect(run(w, [row('A1', 6), row('D1', 6)]).lines).toEqual([
      'FAIL',
      'witnesses:',
      `  grep witness "the average is written" matches its pattern on neither the base ${short} nor the head ${short}: nothing it reads prints what it looks for, so its red on the base is not red for a reason; grep where the output is written (a reporter with an outputFile writes there, not to stdout)`,
    ])
    expect(readFileSync(w.journal, 'utf8').trim().split('\n').map(line => JSON.parse(line) as unknown)).toEqual([
      { event: 'grep-witness', task: 't1', criterion: 'the total is written', head: w.base, matched: true },
      { event: 'grep-witness', task: 't1', criterion: 'the average is written', head: w.base, matched: false },
    ])
    expect(git(w.root, ['worktree', 'list']).split('\n')).toHaveLength(1)
  })

  it('a file whose path git quotes in its diff keeps its added lines', () => {
    const grown = (name: string): [string, string] => ['export const one = 1\n', `export const one = 1\n\nexport function ${name}(value: number): number {\n  return 0\n}\n`]
    const w = world(REAL, true, { 'src/a b.ts': grown('spaced'), 'src/é.ts': grown('accented'), 'src/q"t.ts': grown('quoted') })
    const lines = run(w, [row('A1', 6), row('D1', 6)]).lines
    expect(lines.slice(0, 5)).toEqual([
      'FAIL',
      'stubs:',
      '  src/a b.ts:3 spaced: it returns a literal and never reads its parameters',
      '  src/q"t.ts:3 quoted: it returns a literal and never reads its parameters',
      '  src/é.ts:3 accented: it returns a literal and never reads its parameters',
    ])
  })
})
