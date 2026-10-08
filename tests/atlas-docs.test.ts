import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderAtlasDocs } from '../src/atlas/docs.js'
import { renderAtlas } from '../src/atlas/page.js'
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

  it('draws no switch on a map written without a docs view', () => {
    expect(renderAtlas(input('Juice press'), 'm')).not.toContain('class="switch"')
  })
})
