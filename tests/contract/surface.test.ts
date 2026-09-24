import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { generateSurface, renderSurface } from '../../scripts/contract/surface.js'

const RECORDED = path.resolve(import.meta.dirname, '../../contract/surface.json')

function leaves(value: unknown, at = ''): Map<string, string> {
  if (value != null && typeof value === 'object')
    return new Map(Object.entries(value).flatMap(([key, child]) => [...leaves(child, at === '' ? key : `${at}.${key}`)]))
  return new Map([[at, JSON.stringify(value)]])
}

function changedPaths(generated: string, recorded: string): string[] {
  const now = leaves(JSON.parse(generated))
  const then = leaves(JSON.parse(recorded))
  return [...new Set([...now.keys(), ...then.keys()])].filter(key => now.get(key) !== then.get(key)).sort()
}

describe('contract/surface.json records the surface the generator observes', () => {
  it('matches the generated surface byte for byte; the test compares and never writes', () => {
    const generated = renderSurface(generateSurface())
    const recorded = readFileSync(RECORDED, 'utf8')
    const changed = changedPaths(generated, recorded)

    expect(changed, `the command-line surface changed at ${changed.join(', ')}: run \`pnpm contract:update\` and put its diff in the pull request`).toEqual([])
    expect(generated, 'contract/surface.json differs in layout only: run `pnpm contract:update`').toBe(recorded)
  }, 180_000)
})
