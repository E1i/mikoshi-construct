import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const OWNED = JSON.parse(readFileSync(path.join(ROOT, 'contract/module-files.json'), 'utf8')) as Record<string, string[]>
const BUS_FILES = new Set(OWNED.bus)
const SHARED_FIXTURES = ['tests/board/bus-fixture.ts', 'scripts/tests/bus/bus-fake.ts']
const CONFORMANCE = 'scripts/tests/bus/bus-fake-conformance.test.ts'

function resolved(file: string, specifier: string): string | null {
  const joined = path.posix.join(path.posix.dirname(file), specifier)
  const candidates = [joined.replace(/\.js$/, '.ts'), joined.replace(/\.mjs$/, '.mts'), joined, `${joined}.ts`, `${joined}/index.ts`]
  return candidates.find(candidate => existsSync(path.join(ROOT, candidate)) && /\.m?ts$/.test(candidate)) ?? null
}

function relativeImportsOf(file: string): string[] {
  const { importedFiles } = ts.preProcessFile(readFileSync(path.join(ROOT, file), 'utf8'), true, true)
  return [...new Set(importedFiles
    .map(imported => imported.fileName)
    .filter(specifier => specifier.startsWith('.'))
    .flatMap(specifier => resolved(file, specifier) ?? []))]
}

function busChainsFrom(seed: string): string[] {
  const parent = new Map<string, string>()
  const frontier = [seed]
  const chains: string[] = []
  for (let file = frontier.shift(); file !== undefined; file = frontier.shift()) {
    for (const next of relativeImportsOf(file).filter(each => each !== seed && !parent.has(each))) {
      parent.set(next, file)
      if (!BUS_FILES.has(next)) {
        frontier.push(next)
        continue
      }
      const chain = [next]
      for (let back = parent.get(next); back !== undefined; back = parent.get(back))
        chain.unshift(back)
      chains.push(chain.join(' -> '))
    }
  }
  return chains
}

describe('merge-bench and bus-fixture reach no bus file: bus-fixture and bus-fake in #2119, merge-bench in #2278 merge-bench-on-fake', () => {
  it.each(SHARED_FIXTURES)('%s reaches no bus file, directly or through what it imports', (fixture) => {
    expect(busChainsFrom(fixture)).toEqual([])
  })

  it.todo('scripts/tests/bus/merge-bench.ts reaches no bus file: #2278 merge-bench-on-fake, once merge-executor.ts reaches core/sqlite.ts through cli/check-catalog.ts no longer and composition.ts no longer wires the bus adapter, node, queue and reducer')

  it('a test that takes the real bus as its subject imports it itself, and the walk sees it', () => {
    expect(busChainsFrom(CONFORMANCE)).toContain(`${CONFORMANCE} -> scripts/core/db.ts`)
  })
})
