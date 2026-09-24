import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { ESLint } from 'eslint'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '..')
const CONFIG_FILES = ['eslint.config.mjs', 'internal-modules.json']
const PROBE = 'src/probe.ts'
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'probe', GIT_AUTHOR_EMAIL: 'probe@example.invalid', GIT_COMMITTER_NAME: 'probe', GIT_COMMITTER_EMAIL: 'probe@example.invalid' }

let checkout: string

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, env: GIT_ENV, stdio: 'ignore' })
}

function checkoutWithTheWorkingConfig(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'construct-nested-worktree-')))
  for (const file of CONFIG_FILES)
    copyFileSync(path.join(ROOT, file), path.join(dir, file))
  symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'))
  writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n')
  mkdirSync(path.join(dir, 'src'))
  writeFileSync(path.join(dir, PROBE), 'export const probe = 1\n')
  git(dir, 'init', '-q')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'base')
  return dir
}

async function linted(): Promise<string[]> {
  const results = await new ESLint({ cwd: checkout }).lintFiles(['.'])
  return results.map(result => path.relative(checkout, result.filePath).split(path.sep).join('/')).sort()
}

beforeAll(() => {
  checkout = checkoutWithTheWorkingConfig()
  git(checkout, 'worktree', 'add', '-q', '--detach', 'nested-checkout', 'HEAD')
  mkdirSync(path.join(checkout, '.claude/worktrees'), { recursive: true })
  git(checkout, 'worktree', 'add', '-q', '--detach', '.claude/worktrees/agent', 'HEAD')
})

afterAll(() => {
  rmSync(checkout, { recursive: true, force: true })
})

describe('eslint . from the root leaves nested git worktrees alone, wherever they sit', () => {
  it('lints the checkout\'s own source, so an ignore that swallowed everything would fail here', async () => {
    expect(await linted()).toContain(PROBE)
  })

  it('lints nothing inside a nested worktree in a directory with no leading dot', async () => {
    expect((await linted()).filter(file => file.startsWith('nested-checkout/'))).toEqual([])
  })

  it('lints nothing inside an agent worktree under .claude/worktrees', async () => {
    expect((await linted()).filter(file => file.startsWith('.claude/'))).toEqual([])
  })
})
