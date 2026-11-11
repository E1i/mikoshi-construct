import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import * as coveringTests from '../../../src/card/covering-tests.js'
import * as intakeCheck from '../../../src/commands/intake/check.js'
import { followsTouches, narrowestMask, pathsIn, pathsOutside, runsCover } from '../../policy/touch-scope.js'

const REPOSITORY = path.resolve(import.meta.dirname, '..', '..', '..')
const TOUCH_SCOPE = path.join(REPOSITORY, 'scripts', 'policy', 'touch-scope.ts')
const SPECIFIER = /\bfrom\s+'([^']+)'/g
const NO_REACH = { touches: [], added: new Set<string>(), compositionRecords: [] }

function specifiersOf(file: string): string[] {
  return [...readFileSync(file, 'utf8').matchAll(SPECIFIER)].map(([, specifier]) => specifier!)
}

describe('the touch scope of a card is decided in scripts/policy/touch-scope.ts, which imports nothing from src', () => {
  it('imports nothing that resolves under src/', () => {
    const reached = specifiersOf(TOUCH_SCOPE)
      .filter(specifier => specifier.startsWith('.'))
      .map(specifier => path.relative(REPOSITORY, path.resolve(path.dirname(TOUCH_SCOPE), specifier)))
    expect(reached.filter(file => file.startsWith(`src${path.sep}`))).toEqual([])
  })

  it('holds the four functions, and their former homes no longer export them', () => {
    expect(['pathsIn', 'pathsOutside', 'runsCover'].filter(name => name in coveringTests)).toEqual([])
    expect('followsTouches' in intakeCheck).toBe(false)
    expect(pathsIn('see src/a.ts and README.md.')).toEqual(['src/a.ts', 'README.md'])
    expect(pathsOutside(['src/**'], ['docs/new.md (plain)'], ['src/a.ts', 'docs/new.md', 'tests/b.test.ts'])).toEqual(['tests/b.test.ts'])
    expect(runsCover('tests/b.test.ts', ['tests/**'])).toBe(true)
    expect(runsCover('src/a.ts', ['src/**'])).toBe(false)
    expect(followsTouches('tests/b.test.ts', NO_REACH)).toBe(true)
    expect(followsTouches('.claude/agents/review.md', NO_REACH)).toBe(false)
  })

  it('names the narrowest mask that holds a file, and none when no mask holds it', () => {
    expect(narrowestMask('scripts/tests/bus/a.test.ts', ['scripts/tests/**', 'scripts/tests/bus/**'])).toBe('scripts/tests/bus/**')
    expect(narrowestMask('tests/a.test.ts', ['scripts/tests/**'])).toBeUndefined()
  })
})
