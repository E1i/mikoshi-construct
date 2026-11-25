import type { DerivedReading, TwinTree } from '../../policy/touch-scope.js'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import * as coveringTests from '../../../src/card/covering-tests.js'
import * as intakeCheck from '../../../src/commands/intake/check.js'
import { GENERATED_FILES } from '../../core/generated-files.js'
import { FACTORY_MANIFEST, FOLLOWING_TABLE, followsTouches, narrowestMask, pathsIn, pathsOutside, refusedTwinAnswer, runsCover } from '../../policy/touch-scope.js'

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

  it('lets no path follow the touches that the repository does not hold, and the manifest list follows no card', () => {
    expect(Object.values(GENERATED_FILES).map(row => row.path).filter(file => !existsSync(path.join(REPOSITORY, file)))).toEqual([])
    expect(FOLLOWING_TABLE.map(row => row.kind)).not.toContain('the factory manifest')
    expect(FACTORY_MANIFEST.some(listed => followsTouches(path.relative(REPOSITORY, TOUCH_SCOPE), { ...NO_REACH, touches: [listed] }))).toBe(false)
  })
})

const TWIN = 'contract/factory.json'
const RATCHET_TWIN = 'contract/ratchet.json'
const TWIN_TOUCHED = 'scripts/nodes/answer/answer-executor.ts'
const NOT_DERIVED = 'README.md'
const TWIN_SCOPE = { touches: [TWIN_TOUCHED], creates: [] }

interface RecordingTree {
  files: Map<string, string | null>
  steps: string[]
  tree: TwinTree
}

function recordingTree(base: Record<string, string>, left: Record<string, string>, generated: (current: string | null, run: number) => string | null): RecordingTree {
  const files = new Map<string, string | null>(Object.entries({ ...base, ...left }))
  const steps: string[] = []
  let runs = 0
  const reading: DerivedReading = {
    current: file => files.get(file) ?? null,
    base: file => base[file] ?? null,
    rerun: (_command, outputs) => {
      runs += 1
      steps.push('rerun')
      return { kind: 'ran', outputs: new Map(outputs.map(file => [file, file in base ? generated(files.get(file) ?? null, runs) : files.get(file) ?? null])) }
    },
  }
  const tree: TwinTree = {
    drop: (dropped) => {
      steps.push('drop')
      dropped.forEach(file => files.set(file, base[file] ?? null))
    },
    reading: () => reading,
    write: (file, text) => {
      steps.push('write')
      files.set(file, text)
    },
  }
  return { files, steps, tree }
}

const fromCommitted = (current: string | null): string | null => current === null ? null : current.replace('1', '2')

describe('the answer node\'s judgement of a refused generated twin', () => {
  it('a refusal naming a twin and a non-derived path regenerates the twin and keeps the stop only for the other path', () => {
    const fake = recordingTree({ [TWIN]: '{"v":1}\n' }, { [TWIN]: '{"v":"hand"}\n' }, fromCommitted)

    expect(refusedTwinAnswer([TWIN, NOT_DERIVED], TWIN_SCOPE, fake.tree, [TWIN_TOUCHED, TWIN, NOT_DERIVED])).toEqual({ kind: 'regenerated', files: [TWIN], rest: [NOT_DERIVED] })
    expect(fake.files.get(TWIN)).toBe('{"v":2}\n')
  })

  it('the uncommitted twin is dropped before the generator reruns, so the rerun reads the committed file', () => {
    const fake = recordingTree({ [TWIN]: '{"v":1}\n' }, { [TWIN]: '{"v":"hand"}\n' }, fromCommitted)

    expect(refusedTwinAnswer([TWIN], TWIN_SCOPE, fake.tree, [TWIN])).toMatchObject({ kind: 'regenerated' })
    expect(fake.steps[0]).toBe('drop')
    expect(fake.files.get(TWIN)).toBe('{"v":2}\n')
  })

  it('a refusal naming the ratchet goes to the owner and leaves the tree untouched', () => {
    const fake = recordingTree({ [RATCHET_TWIN]: '{"lines:x":1}\n', [TWIN]: '{"v":1}\n' }, { [RATCHET_TWIN]: '{"lines:x":2}\n', [TWIN]: '{"v":"hand"}\n' }, () => '{"lines:x":2}\n')

    expect(refusedTwinAnswer([RATCHET_TWIN, TWIN], TWIN_SCOPE, fake.tree, [RATCHET_TWIN, TWIN])).toEqual({ kind: 'owner' })
    expect(fake.steps).toEqual([])
    expect(fake.files.get(RATCHET_TWIN)).toBe('{"lines:x":2}\n')
    expect(fake.files.get(TWIN)).toBe('{"v":"hand"}\n')
  })
})
