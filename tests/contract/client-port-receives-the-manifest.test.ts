import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const CLIENT_INDEX = path.join(ROOT, 'scripts', 'ports', 'client', 'index.ts')
const FORBIDDEN_SPECIFIERS = [/src\/manifest\.js$/, /ports\/shift-settings\.js$/]

function importSpecifiersOf(source: string): string[] {
  return [...source.matchAll(/^(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/gm)].map(match => match[1]!)
}

describe('the client port receives the manifest and the shift settings from its builder', () => {
  it('the client port imports neither the manifest nor the shift settings', () => {
    const specifiers = importSpecifiersOf(readFileSync(CLIENT_INDEX, 'utf8'))
    expect(specifiers.length).toBeGreaterThan(0)
    expect(specifiers.filter(specifier => FORBIDDEN_SPECIFIERS.some(forbidden => forbidden.test(specifier)))).toEqual([])
  })
})
