import { describe, expect, it } from 'vitest'
import { parseCompositionModel } from '../../composition/model.js'
import { closingMarker, embed, extractEmbedded, openingMarker, renderEmbedded, renderMermaid } from '../../composition/render.js'

const model = parseCompositionModel(`
id: demo
title: Demo flow
description: Two steps.
doc: docs/demo.md
boundaries:
  - { id: api, label: "API \\"edge\\"" }
nodes:
  - { id: a, label: Start, boundary: api }
  - { id: b, label: End }
  - { id: c, label: Side }
edges:
  - { from: a, to: b, kind: sequence }
  - { from: a, to: c, kind: fan-out }
  - { from: c, to: b, kind: wires, label: provides }
`, 'demo.yaml')

describe('renderMermaid', () => {
  it('groups nodes by boundary, escapes quotes and styles edges by kind', () => {
    expect(renderMermaid(model)).toBe([
      'flowchart LR',
      '  subgraph b_api["API #quot;edge#quot;"]',
      '    a["Start"]',
      '  end',
      '  b["End"]',
      '  c["Side"]',
      '  a --> b',
      '  a -->|"fan-out"| c',
      '  c -.->|"provides"| b',
      '',
    ].join('\n'))
  })
})

describe('embed and extractEmbedded', () => {
  const doc = `# Doc\n\n${openingMarker('demo')}\nstale\n${closingMarker('demo')}\n\nTail\n`

  it('replaces only the marked block and reads it back unchanged', () => {
    const next = embed(doc, model, 'docs/demo.md')
    expect(next.startsWith('# Doc\n\n')).toBe(true)
    expect(next.endsWith('\n\nTail\n')).toBe(true)
    expect(next).toContain('Two steps.\n\n```mermaid\nflowchart LR')
    expect(extractEmbedded(next, model, 'docs/demo.md')).toBe(renderEmbedded(model))
    expect(extractEmbedded(doc, model, 'docs/demo.md')).not.toBe(renderEmbedded(model))
  })

  it('refuses a document without the markers', () => {
    expect(() => embed('# Doc\n', model, 'docs/demo.md')).toThrow('missing the <!-- composition:demo -->')
  })
})
