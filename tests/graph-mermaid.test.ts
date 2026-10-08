import type { RepositoryModel } from '../src/model/schema.js'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { graphOfModel, mermaidFromGraph, PICTURE_STATES } from '../src/model/graph.js'
import { MODEL_VERSION } from '../src/model/schema.js'
import { deriveModelState } from '../src/model/state.js'
import { writeModel } from '../src/model/write.js'

const THREE_STATES: RepositoryModel = {
  modelVersion: MODEL_VERSION,
  facts: [
    { id: 'present', kind: 'file-exists', path: 'there.md', authoredBy: 'construct' },
    { id: 'absent', kind: 'file-exists', path: 'gone.md', authoredBy: 'construct' },
    { id: 'needle', kind: 'file-contains', path: 'there.md', authoredBy: 'discovery', needle: 'a "quoted" needle' },
  ],
  claims: [
    {
      id: 'holds-everywhere',
      statement: 'held',
      authoredBy: 'construct',
      enforcement: { mechanism: 'm', level: 'L3', supportedBy: ['present'] },
      verification: { mechanism: 'v', supportedBy: ['present'] },
    },
    {
      id: 'stands-on-what-is-gone',
      statement: 'unsupported',
      authoredBy: 'construct',
      enforcement: { mechanism: 'm', level: 'L0', supportedBy: ['absent'] },
      verification: { mechanism: 'v', supportedBy: ['present'] },
    },
    { id: 'names-nothing', statement: 'unknown', authoredBy: 'discovery', enforcement: null, verification: null },
  ],
  hypotheses: [
    { id: 'a-held-hypothesis', statement: 'h', authoredBy: 'discovery', baseSha: 'abc', evidenceClean: true, supportedBy: ['present'] },
    { id: 'an-unsupported-hypothesis', statement: 'h', authoredBy: 'discovery', baseSha: null, evidenceClean: false, supportedBy: ['absent', 'needle'] },
  ],
  stages: [],
  nodes: [],
  links: [],
}

function treeWith(model: RepositoryModel): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-mermaid-'))
  writeFileSync(path.join(dir, 'there.md'), 'no needle here\n')
  writeModel(dir, model)
  return dir
}

function graphOf(model: RepositoryModel, root: string) {
  return graphOfModel(model, deriveModelState(model, root))
}

const PINNED_MERMAID = readFileSync(path.resolve(import.meta.dirname, 'fixtures/model/three-states.mmd'), 'utf8')

describe('the mermaid construct graph prints', () => {
  it('serializes the mermaid from the structure exactly as the pinned rendering does', () => {
    const root = treeWith(THREE_STATES)

    expect(mermaidFromGraph(graphOf(THREE_STATES, root))).toBe(PINNED_MERMAID)
  })

  it('names every derived state in the entry’s own words, not only in its colour', () => {
    const root = treeWith(THREE_STATES)
    const graph = graphOf(THREE_STATES, root)
    const mermaid = mermaidFromGraph(graph)

    expect(new Set(graph.nodes.map(node => node.state))).toEqual(new Set(PICTURE_STATES))
    expect(mermaid).toContain('enforcement L0 unsupported')
    expect(mermaid).toContain('unknown, no fact named')
  })
})
