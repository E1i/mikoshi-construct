import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..')
const CLI = path.join(REPO_ROOT, 'scripts', 'morse', 'cli.ts')
const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx')
const FIXTURES = path.join(import.meta.dirname, 'fixtures')
const WORLD_SH = path.join(FIXTURES, 'world.sh')

interface Run { status: number, stdout: string, stderr: string }

function run(args: string[], cwd: string = REPO_ROOT): Run {
  try {
    const stdout = execFileSync(TSX, [CLI, ...args], { cwd, encoding: 'utf8', stdio: 'pipe' })
    return { status: 0, stdout, stderr: '' }
  }
  catch (error) {
    const failure = error as { status: number | null, stdout: string, stderr: string }
    return { status: failure.status ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}

const createdWorlds: string[] = []

function world(): string {
  const w = execFileSync('bash', [WORLD_SH, 'new'], { encoding: 'utf8' }).trim()
  createdWorlds.push(w)
  return w
}

afterEach(() => {
  while (createdWorlds.length > 0)
    execFileSync('bash', [WORLD_SH, 'clean', createdWorlds.pop()!], { encoding: 'utf8' })
})

function sha(w: string, name: string): string {
  return readFileSync(path.join(w, 'sha', name), 'utf8').trim()
}

function expectedLine(w: string, head: string): unknown {
  return JSON.parse(readFileSync(path.join(w, '.world', 'expect', head), 'utf8'))
}

function gitQuiet(repo: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=world', '-c', 'user.email=world@example.invalid', '-c', 'commit.gpgsign=false', '-C', repo, ...args], { encoding: 'utf8' })
}

function repoUntouched(w: string): void {
  expect(gitQuiet(path.join(w, 'repo'), ['status', '--porcelain', '--untracked-files=all'])).toBe('')
}

const HEADS = execFileSync('bash', [WORLD_SH, 'heads'], { encoding: 'utf8' }).trim().split(' ')

describe('morse rules', () => {
  const ruleDirs = readdirSync(path.join(FIXTURES, 'rules')).sort()
  for (const dir of ruleDirs) {
    it(`rule ${dir}`, () => {
      const filesPath = path.join(FIXTURES, 'rules', dir, 'files.json')
      const expected = JSON.parse(readFileSync(path.join(FIXTURES, 'rules', dir, 'expected.json'), 'utf8'))
      const result = run(['classify', '--files', filesPath])
      expect(result.status).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual(expected)
    })
  }

  it('rule order follows RULES', () => {
    execFileSync(TSX, [path.join(FIXTURES, 'order-probe.mjs')], { cwd: REPO_ROOT, encoding: 'utf8' })
  })

  it('classify refuses an empty list', () => {
    const result = run(['classify', '--files', path.join(FIXTURES, 'classify', 'empty.json')])
    expect(result.status).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`.toLowerCase()).toContain('the diff is empty')
    expect(result.stdout).not.toContain('"verdict"')
  })
})

describe('morse predict', () => {
  for (const head of HEADS) {
    it(`predict ${head}`, () => {
      const w = world()
      const base = sha(w, 'base')
      const target = sha(w, head)
      const journal = path.join(w, 'morse.jsonl')
      const result = run(['predict', '--repo', path.join(w, 'repo'), '--base', base, '--head', target, '--task', `t-${head}`, '--journal', journal])
      expect(result.status).toBe(0)
      const expected = expectedLine(w, head)
      expect(JSON.parse(result.stdout.trim())).toEqual(expected)
      expect(JSON.parse(readFileSync(journal, 'utf8').trim())).toEqual(expected)
    })
  }

  it('predict without --repo', () => {
    const w = world()
    const base = sha(w, 'base')
    const target = sha(w, 'src')
    const journal = path.join(w, 'morse.jsonl')
    const result = run(['predict', '--base', base, '--head', target, '--task', 't-src', '--journal', journal], path.join(w, 'repo'))
    expect(result.status).toBe(0)
    const expected = expectedLine(w, 'src')
    expect(JSON.parse(result.stdout.trim())).toEqual(expected)
  })

  it('predict refuses a missing --journal', () => {
    const w = world()
    const base = sha(w, 'base')
    const target = sha(w, 'src')
    const result = run(['predict', '--repo', path.join(w, 'repo'), '--base', base, '--head', target, '--task', 't-src'])
    expect(result.status).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toContain('--journal')
    expect(readdirSync(w).sort()).toEqual(['.world', 'repo', 'sha'])
    repoUntouched(w)
  })

  it('predict refuses an empty diff', () => {
    const w = world()
    const base = sha(w, 'base')
    const journal = path.join(w, 'morse.jsonl')
    const result = run(['predict', '--repo', path.join(w, 'repo'), '--base', base, '--head', base, '--task', 't-empty', '--journal', journal])
    expect(result.status).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`.toLowerCase()).toContain('the diff is empty')
    expect(existsSync(journal)).toBe(false)
  })

  it('predict refuses an unknown revision', () => {
    const w = world()
    const base = sha(w, 'base')
    const journal = path.join(w, 'morse.jsonl')
    const result = run(['predict', '--repo', path.join(w, 'repo'), '--base', base, '--head', 'no-such-rev', '--task', 't-unknown', '--journal', journal])
    expect(result.status).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toContain('no-such-rev')
    expect(existsSync(journal)).toBe(false)
  })

  it('predict refuses a journal inside the repository', () => {
    const w = world()
    const base = sha(w, 'base')
    const target = sha(w, 'src')
    const journal = path.join(w, 'repo', 'docs', 'morse.jsonl')
    const result = run(['predict', '--repo', path.join(w, 'repo'), '--base', base, '--head', target, '--task', 't-src', '--journal', journal])
    expect(result.status).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toContain(journal)
    expect(existsSync(journal)).toBe(false)
    repoUntouched(w)
  })

  it('predict refuses a journal inside the working directory\'s repository', () => {
    const w = world()
    const here = world()
    const base = sha(w, 'base')
    const target = sha(w, 'src')
    const journal = path.join(here, 'repo', 'morse.jsonl')
    const result = run(['predict', '--repo', path.join(w, 'repo'), '--base', base, '--head', target, '--task', 't-src', '--journal', journal], path.join(here, 'repo'))
    expect(result.status).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toContain(journal)
    expect(existsSync(journal)).toBe(false)
    repoUntouched(here)
  })

  it('predict refuses a typechange', () => {
    const w = world()
    const repo = path.join(w, 'repo')
    const base = sha(w, 'base')
    rmSync(path.join(repo, 'src', 'a.ts'))
    symlinkSync('../README.md', path.join(repo, 'src', 'a.ts'))
    gitQuiet(repo, ['commit', '-q', '-am', 'typechange'])
    const target = gitQuiet(repo, ['rev-parse', 'HEAD']).trim()
    const journal = path.join(w, 'morse.jsonl')
    const result = run(['predict', '--repo', repo, '--base', base, '--head', target, '--task', 't-typechange', '--journal', journal])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('unhandled git status T for src/a.ts')
    expect(existsSync(journal)).toBe(false)
  })

  it('predict refuses a failing append', () => {
    const w = world()
    const base = sha(w, 'base')
    const target = sha(w, 'src')
    const jdir = path.join(w, 'jdir')
    mkdirSync(jdir)
    const result = run(['predict', '--repo', path.join(w, 'repo'), '--base', base, '--head', target, '--task', 't-src', '--journal', jdir])
    expect(result.status).not.toBe(0)
    expect(result.stdout).not.toContain('"task"')
    expect(readdirSync(jdir)).toEqual([])
  })
})

describe('morse backtest', () => {
  it('backtest synthetic', () => {
    const result = run(['backtest', '--prs', path.join(FIXTURES, 'backtest', 'synthetic.jsonl')])
    expect(result.status).toBe(0)
    const expected = JSON.parse(readFileSync(path.join(FIXTURES, 'backtest', 'synthetic.expected.json'), 'utf8'))
    expect(JSON.parse(result.stdout)).toEqual(expected)
  })

  const refusedDir = path.join(FIXTURES, 'backtest', 'refused')
  const refusedCases = readdirSync(refusedDir).filter(f => f.endsWith('.jsonl')).map(f => f.slice(0, -'.jsonl'.length)).sort()
  for (const name of refusedCases) {
    it(`backtest refuses ${name}`, () => {
      const names = readFileSync(path.join(refusedDir, `${name}.names`), 'utf8').split('\n').filter(Boolean)
      const result = run(['backtest', '--prs', path.join(refusedDir, `${name}.jsonl`)])
      expect(result.status).not.toBe(0)
      expect(result.stdout).not.toContain('"matrix"')
      const combined = `${result.stdout}${result.stderr}`
      for (const needle of names)
        expect(combined).toContain(needle)
    })
  }
})
