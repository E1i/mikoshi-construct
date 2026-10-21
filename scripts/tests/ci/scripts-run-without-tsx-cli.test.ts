import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const scripts = (JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts

const TSX_CLI = /^(?:\S*\/)?tsx(?:\/dist\/cli\.m?js)?$/
const LOADER_FLAGS = new Set(['--import', '--loader', '--require', '-r'])

function startsTsxCli(command: string): boolean {
  const words = command.split(/[\s;&|()]+/).filter(word => word !== '')
  return words.some((word, index) => TSX_CLI.test(word) && !LOADER_FLAGS.has(words[index - 1] ?? ''))
}

describe('the package.json scripts load TypeScript through node --import tsx', () => {
  it('tells the tsx CLI from the tsx loader', () => {
    expect(startsTsxCli('tsx scripts/a.ts')).toBe(true)
    expect(startsTsxCli('pnpm build && tsx scripts/a.ts')).toBe(true)
    expect(startsTsxCli('node --import tsx scripts/lock.ts tsx scripts/run.ts')).toBe(true)
    expect(startsTsxCli('node node_modules/tsx/dist/cli.mjs scripts/a.ts')).toBe(true)
    expect(startsTsxCli('node --import tsx scripts/a.ts')).toBe(false)
    expect(startsTsxCli('node --import tsx scripts/lock.ts node --import tsx scripts/run.ts')).toBe(false)
    expect(startsTsxCli('vitest run scripts/tsx.test.ts')).toBe(false)
  })

  it('no package.json script starts the tsx CLI', () => {
    expect(Object.keys(scripts).length).toBeGreaterThan(10)
    expect(Object.entries(scripts).filter(([, command]) => startsTsxCli(command)).map(([name]) => name)).toEqual([])
  })
})
