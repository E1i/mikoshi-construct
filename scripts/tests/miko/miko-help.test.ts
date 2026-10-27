import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { mikoHelp, mikoRoute, WINDOW_SCRIPTS } from '../../window/miko.js'

const MIKO = fileURLToPath(new URL('../../window/miko.ts', import.meta.url))
const TSX_LOADER = pathToFileURL(path.resolve(import.meta.dirname, '..', '..', '..', 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')).href

describe('miko --help', () => {
  const lines = mikoHelp().split('\n')

  it('holds one line for handoff write', () => {
    expect(lines.filter(line => line.includes('handoff write'))).toHaveLength(1)
  })

  it('holds one line for handoff check', () => {
    expect(lines.filter(line => line.includes('handoff check'))).toHaveLength(1)
  })

  it('names every command of the window table', () => {
    for (const [words] of WINDOW_SCRIPTS)
      expect(lines.some(line => line.includes(`miko ${words.join(' ')}`))).toBe(true)
  })

  it('leaves the product CLI reachable for --help', () => {
    expect(mikoRoute(['--help'], '/x/scripts/window/miko.ts').script).toMatch(/cli\.ts$/)
  })

  it('prints one line for each handoff command when spawned with --help', () => {
    const run = spawnSync(process.execPath, ['--import', TSX_LOADER, MIKO, '--help'], { encoding: 'utf8' })
    const printed = run.stdout.split('\n')
    expect(printed.filter(line => line.includes('miko handoff write'))).toHaveLength(1)
    expect(printed.filter(line => line.includes('miko handoff check'))).toHaveLength(1)
  })
})
