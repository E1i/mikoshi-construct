import type { AtlasMechanics } from '../src/atlas/view.js'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderAtlas } from '../src/atlas/page.js'
import { parseModel } from '../src/model/schema.js'
import { deriveModelState } from '../src/model/state.js'

const DOCUMENT = {
  modelVersion: 4,
  facts: [
    { id: 'press-file', kind: 'file-exists', path: 'press/main.ts', authoredBy: 'discovery' },
    { id: 'lid-missing', kind: 'file-exists', path: 'lids/none.ts', authoredBy: 'discovery' },
    { id: 'crate-tests', kind: 'report-covers', path: 'reports/crate.json', surface: ['crate'], format: 'vitest-json', authoredBy: 'discovery' },
  ],
  claims: [],
  hypotheses: [],
  stages: [{ id: 'grow', label: 'Grow' }, { id: 'pack', label: 'Pack' }, { id: 'ship', label: 'Ship' }],
  nodes: [
    { id: 'press', label: 'Juice press', stage: 'grow', source: { path: 'press' }, supportedBy: ['press-file'] },
    { id: 'lids', label: 'Lid stamping', stage: 'pack', source: { fact: 'lid-missing' }, supportedBy: ['lid-missing'] },
    { id: 'crate', label: 'Crating', stage: 'pack', source: { path: 'crate/index.ts' }, supportedBy: ['crate-tests'] },
    { id: 'route', label: 'Routing', stage: 'pack', source: { path: 'route' }, supportedBy: [] },
  ],
  links: [{ from: 'press', to: 'lids' }, { from: 'lids', to: 'crate' }],
}

const MECHANICS: AtlasMechanics = {
  components: [
    { id: 'press/main.ts', path: 'press/main.ts' },
    { id: 'press/squeeze.ts', path: 'press/squeeze.ts' },
    { id: 'tools/clock.ts', path: 'tools/clock.ts' },
  ],
  relations: [
    { from: 'press/main.ts', to: 'press/squeeze.ts', kind: 'imports', specifier: './squeeze.js', status: 'found', source: { path: 'press/main.ts', line: 1 } },
    { from: 'press/main.ts', to: null, kind: 'imports', specifier: './gone.js', status: 'unknown', source: { path: 'press/main.ts', line: 2 } },
  ],
}

function render(mechanics?: AtlasMechanics): string {
  const root = mkdtempSync(path.join(tmpdir(), 'atlas-'))
  mkdirSync(path.join(root, 'press'))
  writeFileSync(path.join(root, 'press/main.ts'), 'x\n')
  const model = parseModel(JSON.stringify(DOCUMENT), 'M')
  return renderAtlas({ projectName: 'orchard', model, states: deriveModelState(model, root), mechanics }, 'construct.model.json')
}

describe('the atlas page is built from the document alone', () => {
  it('builds the page from the stages and nodes of a repository that is not Mikoshi', () => {
    const html = render()
    expect(html).toContain('<h2>Grow</h2>')
    expect(html).toContain('<h2>Pack</h2>')
    expect(html).toContain('Juice press')
    expect(html).toContain('Nothing found in this stage.')
    expect(html).not.toMatch(/mikoshi|organism|spine/i)
  })

  it('draws a node nothing holds up with its state instead of leaving it out', () => {
    const html = render()
    expect(html).toMatch(/id="press" data-state="held"/)
    expect(html).toMatch(/id="lids" data-state="unsupported"/)
    expect(html).toMatch(/id="crate" data-state="runtime-report"/)
    expect(html).toMatch(/id="route" data-state="unknown"/)
  })

  it('resolves every link to a node and every source to a path the document declares', () => {
    const html = render()
    const ids = new Set([...html.matchAll(/ id="([^"]+)"/g)].map(match => match[1]))
    const hashes = [...html.matchAll(/href="#([^"]+)"/g)].map(match => match[1])
    expect(hashes.length).toBeGreaterThan(0)
    expect(hashes.filter(hash => !ids.has(hash))).toEqual([])
    const declared = new Set(['press', 'lids/none.ts', 'crate/index.ts', 'route'].concat(DOCUMENT.facts.map(fact => fact.path)))
    const sources = [...html.matchAll(/href="([^"#][^"]*)" data-source/g)].map(match => match[1])
    expect(sources).toHaveLength(DOCUMENT.nodes.length)
    expect(sources.filter(source => !declared.has(source ?? ''))).toEqual([])
  })

  it('opens a node by its id and marks where the reader is', () => {
    const html = render()
    expect(html).toContain('.node:target')
    expect(html).toContain('you are here')
    expect(html).toContain('.node:not(:target) .panel { display: none; }')
  })

  it('fetches nothing, runs no script and follows the light and the dark scheme on a narrow screen', () => {
    const html = render()
    expect(html).not.toMatch(/<script|https?:\/\/|<link|@import|url\(/)
    expect(html).toContain('color-scheme: light dark')
    expect(html).toContain('name="viewport"')
    expect(html).not.toMatch(/@media[^{]*(width|height)/)
  })
})

describe('mechanics are drawn when the document carries them and nothing otherwise', () => {
  it('draws the code under the node whose source holds it and names the rest as unclaimed', () => {
    const html = render(MECHANICS)
    expect(html).toContain('Code under it (2)')
    expect(html).toContain('press/squeeze.ts')
    expect(html).toContain('unknown: ./gone.js')
    expect(html).toContain('class="edge unknown"')
    expect(html).toContain('Code no part claims (1)')
    expect(html).toContain('data-layer="mechanics"')
  })

  it('draws nothing for mechanics when there are none', () => {
    const html = render()
    expect(html).not.toContain('data-layer="mechanics"')
    expect(html).not.toContain('Code under it')
    expect(html).not.toContain('<svg')
  })
})
