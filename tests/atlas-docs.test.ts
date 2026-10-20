import type { AtlasMechanics } from '../src/atlas/view.js'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { componentMap } from '../src/atlas/components.js'
import { renderAtlasDocs } from '../src/atlas/docs.js'
import { renderAtlas } from '../src/atlas/page.js'
import { FILE_LEAF_LIMIT } from '../src/atlas/tree.js'
import { parseModel } from '../src/model/schema.js'
import { deriveModelState } from '../src/model/state.js'

const FILES = { map: 'atlas.html', docs: 'atlas-docs.html' }

function document(label: string): string {
  return JSON.stringify({
    modelVersion: 4,
    facts: [{ id: 'press-file', kind: 'file-exists', path: 'press/main.ts', authoredBy: 'discovery' }],
    claims: [],
    hypotheses: [],
    stages: [{ id: 'grow', label: 'Grow' }, { id: 'ship', label: 'Ship' }],
    nodes: [{ id: 'press', label, stage: 'grow', source: { path: 'press' }, supportedBy: ['press-file'] }],
    links: [],
  })
}

function input(label: string): Parameters<typeof renderAtlas>[0] {
  const root = mkdtempSync(path.join(tmpdir(), 'atlas-docs-'))
  mkdirSync(path.join(root, 'press'))
  writeFileSync(path.join(root, 'press/main.ts'), 'x\n')
  const model = parseModel(document(label), 'M')
  return { projectName: 'orchard', model, states: deriveModelState(model, root) }
}

describe('the docs view', () => {
  it('changing a node in the engram changes the map and the docs', () => {
    const before = [renderAtlas(input('Juice press'), 'm', '', FILES), renderAtlasDocs(input('Juice press'), 'm', '', FILES)]
    const after = [renderAtlas(input('Cider press'), 'm', '', FILES), renderAtlasDocs(input('Cider press'), 'm', '', FILES)]
    for (const [index, page] of before.entries()) {
      expect(page).toContain('Juice press')
      expect(after[index]).toContain('Cider press')
      expect(after[index]).not.toContain('Juice press')
    }
  })

  it('carries the switch to the other view and keeps empty stages', () => {
    const docs = renderAtlasDocs(input('Juice press'), 'm', '', FILES)
    expect(docs).toContain('<a href="atlas.html">Map</a>')
    expect(docs).toContain('<a href="atlas-docs.html" aria-current="page">Docs</a>')
    expect(docs).toContain('Nothing found in this stage.')
    expect(renderAtlas(input('Juice press'), 'm', '', FILES)).toContain('<a href="atlas-docs.html">Docs</a>')
  })

  it('fetches nothing and runs no script', () => {
    const docs = renderAtlasDocs(input('Juice press'), 'm', '', FILES)
    for (const forbidden of ['<script', '<link', '@import', 'url(', 'http'])
      expect(docs).not.toContain(forbidden)
  })

  it('draws no switch on a map written without a docs view', () => {
    expect(renderAtlas(input('Juice press'), 'm')).not.toContain('class="switch"')
  })
})

const EMPTY = { modelVersion: 4, facts: [], claims: [], hypotheses: [], stages: [], nodes: [], links: [] }

function found(file: string): AtlasMechanics['components'][number] {
  return { id: file, path: file, relations: 'found' }
}

const MANY: AtlasMechanics = {
  components: [...Array.from({ length: 40 }, (_, at) => `src/big/f${at}.ts`), 'src/small/a.ts', 'src/small/b.ts', 'lib/x.ts'].map(found),
  relations: [],
}

function docsOf(document: unknown, mechanics?: AtlasMechanics): string {
  const model = parseModel(JSON.stringify(document), 'M')
  return renderAtlasDocs({ projectName: 'orchard', model, states: deriveModelState(model, tmpdir()), mechanics }, 'construct.model.json', '', FILES)
}

function longestList(html: string): number {
  return Math.max(0, ...[...html.matchAll(/<ul[^>]*>([\s\S]*?)<\/ul>/g)].map(match => [...match[1]!.matchAll(/<li>[^<]*<\/li>/g)].length))
}

describe('the docs page reads as parts, not as a file list', () => {
  it('with an empty model the docs page lists no file list longer than the folder tree and names the start command', () => {
    for (const mechanics of [MANY, undefined]) {
      const docs = docsOf(EMPTY, mechanics)
      expect(docs).toContain('/construct-discover')
      expect(longestList(docs)).toBeLessThanOrEqual(FILE_LEAF_LIMIT)
      expect(docs).not.toContain('src/big/f0.ts')
      expect(docs).not.toContain('<li>f0.ts</li>')
    }
    const none = docsOf(EMPTY)
    expect(none).toContain('data-no-model')
    expect(none).not.toContain('<ul class="tree">')
  })

  it('with a model the docs page shows the summary and the parts in order', () => {
    const document = {
      ...EMPTY,
      stages: [{ id: 'grow', label: 'Grow' }, { id: 'ship', label: 'Ship' }],
      nodes: [
        { id: 'crate', label: 'Crating', stage: 'ship', source: { path: 'crate' }, supportedBy: [] },
        { id: 'press', label: 'Juice press', stage: 'grow', source: { path: 'press' }, supportedBy: [] },
      ],
      interpretation: { authoredBy: 'discovery', components: [{ id: 'squeeze', contour: '.', name: 'Squeeze', purpose: 'Turns fruit into juice.', files: ['press/main.ts'] }] },
    }
    const docs = docsOf(document, { components: ['press/main.ts', 'press/squeeze.ts', 'crate/box.ts', 'tools/clock.ts'].map(found), relations: [] })
    expect(docs).toContain('<p class="summary">2 parts · 3 of 4 files bound to a part (75%) · 1 not bound</p>')
    expect(docs.indexOf('<h2>Grow</h2>')).toBeLessThan(docs.indexOf('<h3>Juice press</h3>'))
    expect(docs.indexOf('<h3>Juice press</h3>')).toBeLessThan(docs.indexOf('<h2>Ship</h2>'))
    expect(docs.indexOf('<h2>Ship</h2>')).toBeLessThan(docs.indexOf('<h3>Crating</h3>'))
    expect(docs).toContain('<b>What it does:</b> Turns fruit into juice.')
    expect(docs).toContain('<details><summary>Code under it (2 files)</summary>')
    expect(docs).toContain('Code no part claims (1)')
    expect(docs).toContain('<summary>tools/ (1)</summary>')
    expect(docs.match(/How to bind it/g)).toHaveLength(1)
  })

  it('with parts and no scanned file the summary names what would count them instead of reading 0 of 0', () => {
    const document = { ...EMPTY, stages: [{ id: 'grow', label: 'Grow' }], nodes: [{ id: 'press', label: 'Juice press', stage: 'grow', source: { path: 'press' }, supportedBy: [] }] }
    const docs = docsOf(document)
    expect(docs).toContain('<p class="summary">1 part · no file scanned yet, so none is counted as bound; construct atlas scans the tracked files</p>')
    expect(docs).not.toContain('0 of 0')
  })

  it('a model with mechanics and no stages or nodes shows parts from the components, not a file list', () => {
    const docs = docsOf(EMPTY, MANY)
    const map = componentMap({ contours: [], ...MANY }, [], 'orchard')
    const names = map.contours.flatMap(contour => contour.components.map(component => component.name))
    expect(names.length).toBeGreaterThan(1)
    const headings = [...docs.matchAll(/<h3>([^<]+)<\/h3>/g)].map(match => match[1])
    expect(headings).toEqual(names)
    expect(docs).toContain(`<p class="summary">${names.length} parts · 43 of 43 files bound to a part (100%) · 0 not bound</p>`)
    expect(docs).not.toContain('Code no part claims')
    expect(docs).toContain('/construct-discover')
  })
})
