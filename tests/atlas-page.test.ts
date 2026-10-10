import type { AtlasMechanics } from '../src/atlas/view.js'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderAtlas } from '../src/atlas/page.js'
import { ATLAS_STYLE } from '../src/atlas/style.js'
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
    { id: 'press/main.ts', path: 'press/main.ts', relations: 'found' },
    { id: 'press/squeeze.ts', path: 'press/squeeze.ts', relations: 'found' },
    { id: 'tools/clock.ts', path: 'tools/clock.ts', relations: 'found' },
  ],
  relations: [
    { from: 'press/main.ts', to: 'press/squeeze.ts', kind: 'imports', specifier: './squeeze.js', status: 'found', source: { path: 'press/main.ts', line: 1 } },
    { from: 'press/main.ts', to: null, kind: 'imports', specifier: './gone.js', status: 'unknown', source: { path: 'press/main.ts', line: 2 } },
  ],
}

interface PageData {
  files: string[]
  states: string[]
  reasons: Record<string, string>
  contours: { components: { name: string, files: number[] }[] }[]
  unresolved: [number, number, string][]
}

function scriptsOf(html: string): string[] {
  return [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)].map(match => `${match[1]}|${match[2]}`)
}

function pageData(html: string): PageData {
  return JSON.parse(/const DATA = (.*);\n/.exec(html)![1]!) as PageData
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
    expect(html).toMatch(/id="press" data-state="unknown"/)
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
    expect(html).toContain('<p class="here">you are here</p>')
    expect(html).toContain('.node:not(:target) .panel { display: none; }')
  })

  it('fetches nothing, runs only the one script written into it, whose hash the policy names, and follows the light and the dark scheme on a narrow screen', () => {
    for (const html of [render(), render(MECHANICS)]) {
      const scripts = scriptsOf(html)
      const markup = html.replace(/<script>[\s\S]*?<\/script>/g, '')
      expect(markup).not.toMatch(/<script|https?:\/\/|<link|@import|url\(/)
      expect(scripts.every(script => script.startsWith('|'))).toBe(true)
      for (const script of scripts) {
        expect(script).not.toMatch(/https?:\/\/|fetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|import\(|eval\(|new Function/)
        expect(html).toContain(`script-src 'sha256-${createHash('sha256').update(script.slice(1)).digest('base64')}'`)
      }
      expect(html).toContain(`default-src 'none'`)
      expect(html).toContain('color-scheme: light dark')
      expect(html).toContain('name="viewport"')
      expect(html).not.toMatch(/@media[^{]*(width|height)/)
    }
    expect(scriptsOf(render())).toEqual([])
    expect(scriptsOf(render(MECHANICS))).toHaveLength(1)
  })
})

describe('mechanics are drawn when the document carries them and nothing otherwise', () => {
  it('carries every file into a component of the map and every unresolved relation with its line', () => {
    const data = pageData(render(MECHANICS))
    expect(data.files).toEqual(['press/main.ts', 'press/squeeze.ts', 'tools/clock.ts'])
    expect(data.contours.flatMap(contour => contour.components.flatMap(component => component.files)).sort()).toEqual([0, 1, 2])
    expect(data.unresolved).toEqual([[0, 2, './gone.js']])
  })

  it('draws a file whose relations are unknown as unknown, with the reason', () => {
    const data = pageData(render({ ...MECHANICS, components: [...MECHANICS.components, { id: 'tools/logo.blend', path: 'tools/logo.blend', relations: 'unknown', reason: 'type-not-scanned' }] }))
    expect(data.states[data.files.indexOf('tools/logo.blend')]).toBe('unknown')
    expect(data.reasons).toEqual({ 'tools/logo.blend': 'type-not-scanned' })
  })

  it('draws nothing for mechanics when there are none', () => {
    const html = render()
    expect(html).not.toContain('data-layer="mechanics"')
    expect(html).not.toContain('Code under it')
    expect(html).not.toContain('<svg')
  })
})

describe('a node shows the status word and the reason derived from its proof', () => {
  it('shows unknown and not run on a node whose only witness has no report', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'atlas-'))
    const model = parseModel(JSON.stringify(DOCUMENT), 'M')
    const states = deriveModelState(model, root, { reports: 'read', constructPaths: [] })
    expect(states.nodes.crate).toEqual({ status: 'unknown', reason: 'not-run', state: 'unknown' })
    const html = renderAtlas({ projectName: 'orchard', model, states }, 'construct.model.json')
    const crate = html.slice(html.indexOf('id="crate"'), html.indexOf('</article>', html.indexOf('id="crate"')))
    expect(crate).toContain('<p class="status">unknown — not run</p>')
  })

  it('shows the status of every node, beside its painted state', () => {
    const html = render()
    expect([...html.matchAll(/<p class="status">([^<]+)<\/p>/g)].map(match => match[1])).toEqual([
      'assumption — written in the repository',
      'unknown — absent',
      'unknown — confirmed elsewhere',
      'unknown — written in the repository',
    ])
  })
})

describe('a hostile document', () => {
  it('carries no markup and no script address from a hostile document', () => {
    const hostile = { ...DOCUMENT, nodes: [{ id: 'bad', label: '<script>alert(1)</script>', stage: 'grow', source: { path: 'javascript:alert(1)' }, supportedBy: [] }, { id: 'worse', label: 'Worse', stage: 'grow', source: { path: '//evil.test/x' }, supportedBy: [] }], links: [] }
    const model = parseModel(JSON.stringify(hostile), 'M')
    const html = renderAtlas({ projectName: 'orchard', model, states: deriveModelState(model, tmpdir()) }, 'M')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('href="javascript:')
    expect(html).not.toMatch(/href="\/\//)
  })
})

describe('what the review of the renderer found', () => {
  const sibling = { ...MECHANICS, components: [...MECHANICS.components, { id: 'pressure/x.ts', path: 'pressure/x.ts', relations: 'found' as const }] }

  it('draws no code section for a node no component lies under', () => {
    const html = render(MECHANICS)
    expect(html).not.toContain('Code under it (0)')
    const route = html.slice(html.indexOf('id="route"'), html.indexOf('</article>', html.indexOf('id="route"')))
    expect(route).not.toContain('Code under it')
  })

  it('does not hand pressure/x to the component of press', () => {
    const data = pageData(render(sibling))
    const press = data.contours[0]!.components.find(component => component.name === 'press')!
    expect(press.files.map(file => data.files[file])).toEqual(['press/main.ts', 'press/squeeze.ts'])
  })

  it('gives two ids that clean up to one anchor two different anchors', () => {
    const twins = { ...DOCUMENT, nodes: [{ id: 'a b', label: 'First', stage: 'grow', source: { path: 'a' }, supportedBy: [] }, { id: 'a_b', label: 'Second', stage: 'grow', source: { path: 'b' }, supportedBy: [] }], links: [{ from: 'a b', to: 'a_b' }] }
    const model = parseModel(JSON.stringify(twins), 'M')
    const html = renderAtlas({ projectName: 'orchard', model, states: deriveModelState(model, tmpdir()) }, 'M')
    const ids = [...html.matchAll(/<article class="node" id="([^"]+)"/g)].map(match => match[1])
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
  })

  it('leads back with ← to the source of a link and forward with → to its target', () => {
    const html = render()
    const lids = html.slice(html.indexOf('id="lids"'), html.indexOf('</article>', html.indexOf('id="lids"')))
    expect(lids).toMatch(/<summary>← comes from<\/summary><ul><li><a href="#press">Juice press<\/a><\/li><\/ul>/)
    expect(lids).toMatch(/<summary>leads to →<\/summary><ul><li><a href="#crate">Crating<\/a><\/li><\/ul>/)
  })

  it('sizes no text in pixels', () => {
    expect(ATLAS_STYLE.split(';').filter(declaration => declaration.includes('font') && declaration.includes('px'))).toEqual([])
  })
})
