import { describe, expect, it } from 'vitest'
import { parseCompositionModel } from '../../composition/model.js'

const valid = `
id: demo
title: Demo flow
doc: docs/demo.md
boundaries:
  - { id: api, label: API }
nodes:
  - { id: a, label: Start, path: package.json, boundary: api }
  - { id: b, label: End }
edges:
  - { from: a, to: b, kind: sequence, label: next }
`

describe('parseCompositionModel', () => {
  it('reads a valid model', () => {
    const model = parseCompositionModel(valid, 'demo.yaml')
    expect(model.id).toBe('demo')
    expect(model.nodes.map(node => node.id)).toEqual(['a', 'b'])
    expect(model.edges[0]).toEqual({ from: 'a', to: 'b', kind: 'sequence', label: 'next' })
  })

  it('rejects an edge that points at an unknown node', () => {
    expect(() => parseCompositionModel(valid.replace('to: b', 'to: ghost'), 'demo.yaml'))
      .toThrow('edges[0] refers to unknown node "ghost"')
  })

  it('rejects an edge kind outside the vocabulary', () => {
    expect(() => parseCompositionModel(valid.replace('kind: sequence', 'kind: maybe'), 'demo.yaml'))
      .toThrow('kind "maybe" is not one of')
  })

  it('rejects a node in an undeclared boundary and an id Mermaid cannot render', () => {
    expect(() => parseCompositionModel(valid.replace('boundary: api', 'boundary: web'), 'demo.yaml'))
      .toThrow('unknown boundary "web"')
    expect(() => parseCompositionModel(valid.replace('id: a,', 'id: 1a,'), 'demo.yaml'))
      .toThrow('must match')
  })
})
