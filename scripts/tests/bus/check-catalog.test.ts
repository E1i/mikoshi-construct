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

  it('gives a test the layer it reaches by spawning a script or through a helper it imports', () => {
    const graph: Graph = new Map([
      ['scripts/morse/cli.ts', []],
      ['scripts/tests/morse/cli.test.ts', []],
      ['scripts/ghosts/launch.ts', []],
      ['scripts/tests/ghosts/helper.ts', []],
      ['scripts/tests/ghosts/watch.test.ts', ['scripts/tests/ghosts/helper.ts']],
    ])
    const text = (test: string) => test === 'scripts/tests/morse/cli.test.ts' ? 'execFileSync(tsx, [\'scripts/morse/cli.ts\'])' : test === 'scripts/tests/ghosts/helper.ts' ? 'spawn(\'scripts/ghosts/launch.ts\')' : ''
    const layers = Object.fromEntries(buildCatalog({ ...sources(), graph, testText: text, parking: [] }).tests.map(row => [row.test, row.layer]))
    expect(layers).toEqual({ 'scripts/tests/morse/cli.test.ts': 'morse', 'scripts/tests/ghosts/watch.test.ts': 'ghosts' })
  })

  it('credits a card that names a test by its path, and not one that names a longer path ending in the same path', () => {
    const graph: Graph = new Map([['tests/x.test.ts', []]])
    const witnessOf = (text: string) => buildCatalog({ ...sources(), graph, testText: () => '', parking: [{ card: 3, text }] }).tests[0]!.witness
    expect(witnessOf('Witnesses: scripts/tests/x.test.ts')).toBe('')
    expect(witnessOf('Witnesses: tests/x.test.ts passes')).toBe('3')
  })

  it('credits a card whose witness is an it title, not one that lists the test only on touches', () => {
    const graph: Graph = new Map([['tests/x.test.ts', []]])
    const testText = () => 'describe(\'the x suite\', () => {\n  it(\'keeps the x\\\'s order\', () => {})\n})'
    const witnessOf = (text: string) => buildCatalog({ ...sources(), graph, testText, parking: [{ card: 3, text }] }).tests[0]!.witness
    expect(witnessOf('card: #3\n\nWitnesses:\n- `pnpm exec vitest run -t \'keeps the x\'s order\'` exits 0\n')).toBe('3')
    expect(witnessOf('card: #3\ntouches: tests/x.test.ts\n\nNames the x suite.\n\nWitnesses:\n- `pnpm exec vitest run tests/y.test.ts` exits 0\n\nrisk: keeps the x\'s order')).toBe('')
  })

  it('a witness is credited by an it.each or test title', () => {
    const graph: Graph = new Map([['tests/x.test.ts', []]])
    const testText = () => [
      'describe(\'the x suite\', () => {',
      '  it.each([[\'a\', 1], [\'b\', 2]])(\'orders %s before %d\', () => {})',
      '  test(\'keeps the y\\\'s order\', () => {})',
      '})',
    ].join('\n')
    const witnessOf = (text: string) => buildCatalog({ ...sources(), graph, testText, parking: [{ card: 3, text }] }).tests[0]!.witness
    expect(witnessOf('Witnesses:\n- `pnpm exec vitest run -t \'orders a before 1\'` exits 0\n')).toBe('3')
    expect(witnessOf('Witnesses:\n- `pnpm exec vitest run -t \'keeps the y\'\\\'\'s order\'` exits 0\n')).toBe('3')
    expect(witnessOf('Witnesses:\n- `pnpm exec vitest run -t \'orders the rest\'` exits 0\n')).toBe('')
  })

  it('a member .test call, a literal $ or %% and a bare placeholder title credit no witness', () => {
    const graph: Graph = new Map([['tests/x.test.ts', []]])
    const witnessOf = (body: string, text: string) => buildCatalog({ ...sources(), graph, testText: () => `describe('the x suite', () => {\n${body}\n})`, parking: [{ card: 3, text }] }).tests[0]!.witness
    expect(witnessOf('  it(\'reads\', () => { expect(/a/.test(\'abc\')).toBe(true) })', 'Witnesses:\n- `pnpm exec vitest run -t \'abc\'` exits 0\n')).toBe('')
    expect(witnessOf('  it(\'costs $5 at 100%% of x\', () => {})', 'Witnesses:\n- `pnpm exec vitest run -t \'costs 7 at 100 of x\'` exits 0\n')).toBe('')
    expect(witnessOf('  it(\'costs $5 at 100%% of x\', () => {})', 'Witnesses:\n- `pnpm exec vitest run -t \'costs $5 at 100%% of x\'` exits 0\n')).toBe('3')
    expect(witnessOf('  it.each([[\'a\']])(\'%s\', () => {})', 'Witnesses:\n- `pnpm exec vitest run -t \'anything\'` exits 0\n')).toBe('')
    expect(witnessOf('  it.each([{ n: 1 }])(\'counts $n at 100%% of $5\', () => {})', 'Witnesses:\n- `pnpm exec vitest run -t \'counts 1 at 100% of $5\'` exits 0\n')).toBe('3')
    expect(witnessOf('  it.each([{ n: 1 }])(\'counts $n at 100%% of $5\', () => {})', 'Witnesses:\n- `pnpm exec vitest run -t \'counts 1 at 100%% of $5\'` exits 0\n')).toBe('')
    expect(witnessOf('  it.each([[1]])(\'keeps %%s literal\', () => {})', 'Witnesses:\n- `pnpm exec vitest run -t \'keeps %s literal\'` exits 0\n')).toBe('3')
  })

  it('a placeholder in a plain it title stays literal', () => {
    const graph: Graph = new Map([['tests/x.test.ts', []]])
    const witnessOf = (body: string, text: string) => buildCatalog({ ...sources(), graph, testText: () => `describe('the x suite', () => {\n${body}\n})`, parking: [{ card: 3, text }] }).tests[0]!.witness
    expect(witnessOf('  it(\'reads $HOME and %s\', () => {})', 'Witnesses:\n- `pnpm exec vitest run -t \'reads x and y\'` exits 0\n')).toBe('')
    expect(witnessOf('  it(\'reads $HOME and %s\', () => {})', 'Witnesses:\n- `pnpm exec vitest run -t \'reads $HOME and %s\'` exits 0\n')).toBe('3')
  })

  it('an it.each tagged template or a table holding parentheses keeps its own title and the next one', () => {
    const graph: Graph = new Map([['tests/x.test.ts', []]])
    const testText = () => [
      'describe(\'the x suite\', () => {',
      '  it.each`',
      '    a    | b',
      '    1    | 2',
      '  `(\'adds $a to $b\', () => {})',
      '  it(\'keeps the tail\', () => {})',
      '  it.each([[f(g(1))], [(2)]])(\'wraps %s\', () => {})',
      '  it(\'keeps the end\', () => {})',
      '  it.each(rows)',
      '  it(\'stands alone\', () => {})',
      '})',
    ].join('\n')
    const witnessOf = (title: string) => buildCatalog({ ...sources(), graph, testText, parking: [{ card: 3, text: `Witnesses:\n- \`pnpm exec vitest run -t '${title}'\` exits 0\n` }] }).tests[0]!.witness
    expect(witnessOf('adds 1 to 2')).toBe('3')
    expect(witnessOf('keeps the tail')).toBe('3')
    expect(witnessOf('wraps 1')).toBe('3')
    expect(witnessOf('keeps the end')).toBe('3')
    expect(witnessOf('stands alone')).toBe('3')
    expect(witnessOf('adds the rest')).toBe('')
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
