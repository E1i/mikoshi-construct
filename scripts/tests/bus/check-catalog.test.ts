import type { Graph } from '../../ci/layers.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildCatalog, kindOf, readBriefs, readParking, writeCatalog } from '../../bus/check-catalog.js'
import { openDatabase } from '../../bus/sqlite.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'catalog-'))
  roots.push(root)
  return root
}

const GRAPH: Graph = new Map([
  ['scripts/bus/merge-worker.ts', []],
  ['scripts/tests/bus/merge-worker.test.ts', ['scripts/bus/merge-worker.ts']],
  ['scripts/tests/bus/merge-worker.e2e.test.ts', ['scripts/bus/merge-worker.ts']],
])

const BRIEF = [
  'prose',
  'M1 | scripts/bus/merge-worker.ts | find: `a` → `b` | red: scripts/tests/bus/merge-worker.test.ts › merges',
  'M2 | scripts/bus/merge-worker.ts | edit: drop the guard | red: green',
  'M3 | broken',
].join('\n')

const JOURNAL = `${JSON.stringify({ event: 'mutation-judged', card: '#7', id: 'M1', outcome: 'killed', matched: true })}\nnot json\n`

function sources() {
  return {
    graph: GRAPH,
    testText: (test: string) => test.endsWith('.e2e.test.ts') ? 'describe(\'end to end\', () => {})' : 'describe(\'merges a pr\', () => {})',
    parking: [{ card: 7, text: 'Witnesses: scripts/tests/bus/merge-worker.test.ts' }],
    briefs: [{ card: 7, text: BRIEF }],
    journal: JOURNAL,
  }
}

describe('the check catalog is filled mechanically from tests, briefs and the journal', () => {
  it('classifies a test by path as e2e, contract or unit', () => {
    expect([kindOf('a.e2e.test.ts'), kindOf('tests/contract/surface.test.ts'), kindOf('tests/x.test.ts')]).toEqual(['e2e', 'contract', 'unit'])
  })

  it('records the layers a test imports, its first describe and the cards whose witnesses name it', () => {
    const { tests } = buildCatalog(sources())
    expect(tests).toEqual([
      { test: 'scripts/tests/bus/merge-worker.e2e.test.ts', layer: 'bus:merge', kind: 'e2e', what: 'end to end', witness: '' },
      { test: 'scripts/tests/bus/merge-worker.test.ts', layer: 'bus:merge', kind: 'unit', what: 'merges a pr', witness: '7' },
    ])
  })

  it('records each well-formed brief mutation with its killing test and its judged outcome, and skips a malformed line', () => {
    const { mutations } = buildCatalog(sources())
    expect(mutations).toEqual([
      { card: 7, id: 'M1', operator: 'a → b', file: 'scripts/bus/merge-worker.ts', layer: 'bus:merge', killedBy: 'scripts/tests/bus/merge-worker.test.ts', judged: 'killed' },
      { card: 7, id: 'M2', operator: 'drop the guard', file: 'scripts/bus/merge-worker.ts', layer: 'bus:merge', killedBy: null, judged: null },
    ])
  })

  it('writes the tables into a database and replaces them on a second write', () => {
    const db = openDatabase(path.join(scratch(), 'bus.db'))
    writeCatalog(db, buildCatalog(sources()))
    writeCatalog(db, buildCatalog(sources()))
    expect(db.prepare('SELECT test, layer, kind FROM check_tests ORDER BY test').all().map(row => ({ ...row }))).toEqual([
      { test: 'scripts/tests/bus/merge-worker.e2e.test.ts', layer: 'bus:merge', kind: 'e2e' },
      { test: 'scripts/tests/bus/merge-worker.test.ts', layer: 'bus:merge', kind: 'unit' },
    ])
    expect(db.prepare('SELECT id, judged FROM check_mutations ORDER BY id').all().map(row => ({ ...row }))).toEqual([{ id: 'M1', judged: 'killed' }, { id: 'M2', judged: null }])
    db.close()
  })

  it('reads briefs and parked cards from files, ignoring other names', () => {
    const root = scratch()
    mkdirSync(path.join(root, 'lane-1'))
    writeFileSync(path.join(root, 'brief-12.md'), 'b')
    writeFileSync(path.join(root, 'notes.md'), 'n')
    writeFileSync(path.join(root, 'lane-1', '5.md'), 'card')
    expect(readBriefs(root)).toEqual([{ card: 12, text: 'b' }])
    expect(readParking(root)).toEqual([{ card: 5, text: 'card' }])
    expect(readBriefs(path.join(root, 'missing'))).toEqual([])
  })
})
