import type { RepositoryModel } from '../src/model/schema.js'
import { describe, expect, it } from 'vitest'
import { parseModel } from '../src/model/schema.js'
import { mergeModel } from '../src/model/write.js'

const FRESH: RepositoryModel = { modelVersion: 4, facts: [], claims: [], hypotheses: [], stages: [], nodes: [], links: [] }

function existing(node: object): RepositoryModel {
  return parseModel(JSON.stringify({
    modelVersion: 4,
    facts: [{ id: 'only-a-node-stands-on-me', kind: 'file-exists', path: 'gone.txt', authoredBy: 'construct' }],
    claims: [],
    hypotheses: [],
    stages: [{ id: 's1', label: 'One' }],
    nodes: [node],
    links: [],
  }), 'M')
}

describe('merging a model that carries nodes', () => {
  it('keeps the stages and nodes, and a construct fact only a node supportedBy stands on', () => {
    const before = existing({ id: 'n1', label: 'N', stage: 's1', source: { path: 'a.txt' }, supportedBy: ['only-a-node-stands-on-me'] })
    const { model, retained } = mergeModel(before, FRESH)
    expect(model.stages).toEqual(before.stages)
    expect(model.nodes).toEqual(before.nodes)
    expect(model.links).toEqual(before.links)
    expect(retained).toEqual([{ id: 'only-a-node-stands-on-me', stoodOnBy: ['n1'] }])
    expect(() => parseModel(JSON.stringify(model), 'M')).not.toThrow()
  })

  it('keeps a construct fact only a node source.fact stands on, naming the node', () => {
    const before = existing({ id: 'n1', label: 'N', stage: 's1', source: { fact: 'only-a-node-stands-on-me' }, supportedBy: [] })
    const { model, retained } = mergeModel(before, FRESH)
    expect(model.facts.map(fact => fact.id)).toEqual(['only-a-node-stands-on-me'])
    expect(retained).toEqual([{ id: 'only-a-node-stands-on-me', stoodOnBy: ['n1'] }])
    expect(() => parseModel(JSON.stringify(model), 'M')).not.toThrow()
  })

  it('returns fresh itself when nothing exists', () => {
    expect(mergeModel(null, FRESH).model).toBe(FRESH)
  })
})
