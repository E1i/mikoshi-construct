import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runMerge } from '../../shift/merge.js'

const OWNER_MERGES = readFileSync(path.resolve(import.meta.dirname, '../../../architecture/owner-merges.md'), 'utf8')
const HEAD = 'a1b2c3d'

function cardLine(decision: 'owner' | 'auto'): string {
  return `#7 shift-task [implement/runner/S/cheap/${decision}] · depends — · blocks —`
}

function run(body: string, files: string[]): { calls: string[][], result: ReturnType<typeof runMerge> } {
  const calls: string[][] = []
  const gh = (args: string[]): string => {
    calls.push(args)
    return args[1] === 'view' ? JSON.stringify({ body, headRefOid: HEAD, files: files.map(file => ({ path: file })) }) : ''
  }
  return { calls, result: runMerge(['42'], { gh, ownerMergesText: () => OWNER_MERGES }) }
}

function armed(calls: string[][]): boolean {
  return calls.some(args => args[0] === 'pr' && args[1] === 'merge')
}

describe('runMerge', () => {
  it('arms nothing for a card whose decision is owner, even when every path is plain', () => {
    const { calls, result } = run(`${cardLine('owner')}\n\nbody`, ['scripts/board/derive.ts'])
    expect(armed(calls)).toBe(false)
    expect(result.stdout).toEqual(['[shift:merge] decision owner — PR #42 and the report, merge is Eli\'s'])
  })

  it('arms auto-merge at the head sha for decision auto when every path is plain', () => {
    const { calls, result } = run(cardLine('auto'), ['scripts/board/derive.ts', 'scripts/ghosts/entry.ts'])
    expect(calls).toContainEqual(['pr', 'merge', '42', '--auto', '--squash', '--match-head-commit', HEAD, '-R', 'E1i/mikoshi-construct'])
    expect(result.exitCode).toBe(0)
  })

  it('arms nothing for decision auto when one path is owner-merged, and names that path', () => {
    const { calls, result } = run(cardLine('auto'), ['scripts/board/derive.ts', 'scripts/shift/header.md'])
    expect(armed(calls)).toBe(false)
    expect(result.stdout).toEqual(['[shift:merge] owner path scripts/shift/header.md — merge is Eli\'s'])
  })

  it('arms nothing for a pull request that changes src/ with no matrix count line, and names the path', () => {
    const { calls, result } = run(cardLine('auto'), ['src/program.ts', 'scripts/board/derive.ts'])
    expect(armed(calls)).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toEqual(['[shift:merge] PR #42 changes src/program.ts and its description has no code matrix count line ■ n □ n · n (architecture/code-matrix.md); auto-merge not armed'])
  })

  it('arms nothing for a pull request that changes templates/ with no matrix count line', () => {
    const { calls, result } = run(cardLine('auto'), ['templates/base/architecture/principles.md'])
    expect(armed(calls)).toBe(false)
    expect(result.exitCode).toBe(1)
  })

  it('arms auto-merge for a pull request that changes src/ and ends with the matrix count line', () => {
    const { calls, result } = run(`${cardLine('auto')}\n\n|    | BD | E9 | FF |\n| 7A | ■ | · | · |\n\n■ 1 □ 0 · 5`, ['src/program.ts'])
    expect(armed(calls)).toBe(true)
    expect(result.exitCode).toBe(0)
  })

  it('arms auto-merge for a pull request that changes only scripts/ with no matrix', () => {
    const { calls } = run(cardLine('auto'), ['scripts/board/derive.ts'])
    expect(armed(calls)).toBe(true)
  })

  it('refuses a pull request whose first line is not a card', () => {
    const { calls, result } = run('Some description', ['scripts/board/derive.ts'])
    expect(armed(calls)).toBe(false)
    expect(result.exitCode).toBe(1)
  })

  it('refuses an argument that is not a pull request number', () => {
    expect(runMerge(['#42'], { gh: () => '', ownerMergesText: () => OWNER_MERGES }).exitCode).toBe(1)
  })
})
