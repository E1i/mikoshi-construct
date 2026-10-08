import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MODEL_FILE, MODEL_VERSION, parseModel } from '../src/model/schema.js'
import { readModel } from '../src/model/write.js'

const FIXTURES = path.resolve(import.meta.dirname, 'fixtures')
const FOREIGN = path.join(FIXTURES, 'engram/foreign-repo')

interface Document {
  modelVersion: number
  facts: object[]
  claims: object[]
  hypotheses: object[]
  stages?: object[]
  nodes?: Record<string, unknown>[]
  links?: object[]
}

function control(): Document {
  return {
    modelVersion: 4,
    facts: [{ id: 'f', kind: 'file-exists', path: 'a.txt', authoredBy: 'discovery' }],
    claims: [],
    hypotheses: [],
    stages: [{ id: 's1', label: 'One' }],
    nodes: [
      { id: 'n1', label: 'N', stage: 's1', source: { path: 'a.txt' }, supportedBy: ['f'] },
      { id: 'n2', label: 'M', stage: 's1', source: { fact: 'f' }, supportedBy: [] },
    ],
    links: [{ from: 'n1', to: 'n2' }],
  }
}

function refusal(change: (document: Document) => void): string {
  const document = control()
  change(document)
  try {
    parseModel(JSON.stringify(document), 'M')
  }
  catch (error) {
    return (error as Error).message
  }
  return ''
}

describe('the engram lists of modelVersion 4', () => {
  it('parses the control document', () => {
    expect(parseModel(JSON.stringify(control()), 'M').nodes).toHaveLength(2)
  })

  it('refuses a node without a source, naming the node and the key and not the version', () => {
    const message = refusal((document) => {
      delete document.nodes![0]!.source
    })
    expect(message).toContain('nodes[0]')
    expect(message).toContain('source')
    expect(message).not.toContain('modelVersion')
  })

  it.each([
    ['an unknown stage', 'nodes[0]', 'nope', (d: Document) => Object.assign(d.nodes![0]!, { stage: 'nope' })],
    ['an unknown source.fact', 'nodes[0]', 'nope', (d: Document) => Object.assign(d.nodes![0]!, { source: { fact: 'nope' } })],
    ['a link to a missing node', 'links[0]', 'n9', (d: Document) => Object.assign(d, { links: [{ from: 'n1', to: 'n9' }] })],
    ['a source with both keys', 'nodes[0]', 'source', (d: Document) => Object.assign(d.nodes![0]!, { source: { path: 'a.txt', fact: 'f' } })],
    ['a source with neither key', 'nodes[0]', 'source', (d: Document) => Object.assign(d.nodes![0]!, { source: {} })],
    ['a source with an extra key', 'nodes[0]', 'extra', (d: Document) => Object.assign(d.nodes![0]!, { source: { path: 'a.txt', extra: 1 } })],
    ['a node carrying a state', 'nodes[0]', 'state', (d: Document) => Object.assign(d.nodes![0]!, { state: 'held' })],
  ])('refuses %s, naming the location and the word and not the version', (_name, where, word, change) => {
    const message = refusal(change)
    expect(message).toContain(where)
    expect(message).toContain(word)
    expect(message).not.toContain('modelVersion')
  })

  it('words a dangling stage and link by location, property and value', () => {
    expect(refusal(d => Object.assign(d.nodes![0]!, { stage: 'nope' }))).toContain('nodes[0] stage "nope" names no stage this document declares')
    expect(refusal(d => Object.assign(d, { links: [{ from: 'n1', to: 'n9' }] }))).toContain('links[0] to "n9" names no node this document declares')
  })

  it('refuses duplicate stage ids and duplicate node ids', () => {
    expect(refusal(d => Object.assign(d, { stages: [{ id: 's1', label: 'A' }, { id: 's1', label: 'B' }] }))).toContain('stage ids must be unique')
    expect(refusal(d => Object.assign(d.nodes![1]!, { id: 'n1' }))).toContain('node ids must be unique')
  })

  it('refuses a list that is present and not a list of objects', () => {
    expect(refusal(d => Object.assign(d, { stages: null }))).toContain('"stages" must be a list of objects')
  })

  it('reads the parsed source as exactly the one key that is present', () => {
    const model = parseModel(JSON.stringify(control()), 'M')
    expect(model.nodes.map(node => Object.keys(node.source))).toEqual([['path'], ['fact']])
  })

  it('reads a version 4 document that omits the lists as empty', () => {
    const model = parseModel(JSON.stringify({ modelVersion: 4, facts: [], claims: [], hypotheses: [] }), 'M')
    expect([model.stages, model.nodes, model.links]).toEqual([[], [], []])
  })

  it.each([
    ['inline v3', JSON.stringify({ modelVersion: 3, facts: [], claims: [], hypotheses: [] })],
    ...['model/fresh-init', 'model/hypothesis', 'verification/node-service', 'verification/python-service']
      .map(name => [name, readFileSync(path.join(FIXTURES, name, MODEL_FILE), 'utf8')]),
  ])('reads %s at the current version with the lists empty', (_name, source) => {
    const model = parseModel(source!, 'M')
    expect(model.modelVersion).toBe(MODEL_VERSION)
    expect([model.stages, model.nodes, model.links]).toEqual([[], [], []])
  })

  it('reads a repository that is not a Mikoshi one, whose path sources all resolve', () => {
    const model = parseModel(readFileSync(path.join(FOREIGN, MODEL_FILE), 'utf8'), 'M')
    expect(model.modelVersion).toBe(5)
    expect(model.stages.length).toBeGreaterThanOrEqual(2)
    expect(model.nodes.length).toBeGreaterThanOrEqual(3)
    expect(model.links.length).toBeGreaterThanOrEqual(1)
    const sources = model.nodes.map(node => node.source)
    expect(sources.some(source => 'path' in source)).toBe(true)
    expect(sources.some(source => 'fact' in source)).toBe(true)
    for (const source of sources) {
      if ('path' in source)
        expect(readFileSync(path.join(FOREIGN, source.path), 'utf8')).not.toBe('')
    }
  })

  it('holds no construct.json, AGENTS.md or .construct in the foreign fixture', () => {
    const names = ['construct.json', 'AGENTS.md', '.construct']
    expect(names.map(name => path.join(FOREIGN, name)).filter(file => existsSync(file))).toEqual([])
  })

  it('has readModel guide a source fact that is gone through the same words as supportedBy', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'engram-gone-'))
    const document = control()
    document.nodes = [{ id: 'n1', label: 'N', stage: 's1', source: { fact: 'gone' }, supportedBy: [] }]
    document.links = []
    writeFileSync(path.join(root, MODEL_FILE), JSON.stringify(document))
    expect(() => readModel(root)).toThrow(/stands on a fact that is not in it: nodes\[0\]\.source names "gone"/)
  })
})
