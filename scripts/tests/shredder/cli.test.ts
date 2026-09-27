import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const CLI = path.join(import.meta.dirname, '..', '..', 'shredder', 'cli.ts')
const FIXTURES = path.join(import.meta.dirname, 'fixtures')
const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..')

function run(dir: string, extraArgs: string[] = []): { status: number, stdout: string, stderr: string } {
  const result = execFileSync('pnpm', ['exec', 'tsx', CLI, dir, ...extraArgs], { cwd: REPO_ROOT, encoding: 'utf8' })
  return { status: 0, stdout: result, stderr: '' }
}

function runAllowingFailure(dir: string, extraArgs: string[] = []) {
  try {
    return { status: 0, stdout: run(dir, extraArgs).stdout, stderr: '' }
  }
  catch (error) {
    const failure = error as { status: number, stdout: string, stderr: string }
    return { status: failure.status, stdout: failure.stdout, stderr: failure.stderr }
  }
}

describe('shredder fixtures', () => {
  it('matches expected.json for the day corpus', () => {
    const dir = path.join(FIXTURES, 'day-2026-09-27')
    const output = run(dir, ['--json']).stdout
    const expected = readFileSync(path.join(dir, 'expected.json'), 'utf8')
    expect(JSON.parse(output)).toEqual(JSON.parse(expected))
  })

  const ruleFixtures = readdirSync(path.join(FIXTURES, 'rules'))
  for (const name of ruleFixtures) {
    it(`matches expected.json for rules/${name}`, () => {
      const dir = path.join(FIXTURES, 'rules', name)
      const output = run(dir, ['--json']).stdout
      const expected = readFileSync(path.join(dir, 'expected.json'), 'utf8')
      expect(JSON.parse(output)).toEqual(JSON.parse(expected))
    })
  }

  it('prints the six-column table without --json', () => {
    const dir = path.join(FIXTURES, 'day-2026-09-27')
    const lines = run(dir).stdout.split('\n').filter(line => line.startsWith('|'))
    expect(lines[0]).toBe('| Task | Verification | Class | Why | Contour | unresolved |')
    expect(lines).toHaveLength(9)
  })

  it('refuses a snapshot without status.md', () => {
    const dir = path.join(FIXTURES, 'day-2026-09-27')
    const missing = runAllowingFailure(path.join(dir, 'tasks'))
    expect(missing.status).not.toBe(0)
    expect(missing.stdout.trim()).toBe('')
    expect(missing.stderr).toContain('status.md')
  })
})
