import { describe, expect, it } from 'vitest'
import { mikoHelp, mikoRoute, WINDOW_SCRIPTS } from '../../window/miko.js'

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
})
