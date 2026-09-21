import type { RepositoryModel } from '../src/model/schema.js'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { modelGraph, pageOfGraph, writeGraphPage } from '../src/commands/graph.js'
import { graphOfModel, mermaidFromGraph, PICTURE_STATES } from '../src/model/graph.js'
import { MODEL_FILE, MODEL_VERSION, parseModel } from '../src/model/schema.js'
import { deriveModelState } from '../src/model/state.js'
import { COLOUR_IS_NOT_STRENGTH, svgFromGraph } from '../src/model/svg.js'
import { writeModel } from '../src/model/write.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const CLI_DOC = path.resolve(REPO_ROOT, 'docs/cli.md')

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
}

function treeWith(model: RepositoryModel): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-picture-'))
  writeFileSync(path.join(dir, 'there.md'), 'no needle here\n')
  writeModel(dir, model)
  return dir
}

function repositoryModel(): RepositoryModel {
  return parseModel(readFileSync(path.join(REPO_ROOT, MODEL_FILE), 'utf8'), MODEL_FILE)
}

function graphOf(model: RepositoryModel, root: string) {
  return graphOfModel(model, deriveModelState(model, root))
}

function asMermaidWritesIt(line: string): string {
  return line.replaceAll('"', '#quot;')
}

function asXmlWritesIt(line: string): string {
  return line.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

const SVG_NAMESPACE = 'xmlns="http://www.w3.org/2000/svg"'

const PINNED_MERMAID = readFileSync(path.resolve(import.meta.dirname, 'fixtures/model/three-states.mmd'), 'utf8')

describe('one structure, two serializers', () => {
  it('names the same nodes and the same edges in both, so a picture cannot disagree with the diagram', () => {
    const root = treeWith(THREE_STATES)
    const graph = graphOf(THREE_STATES, root)
    const mermaid = mermaidFromGraph(graph)
    const svg = svgFromGraph(graph)

    for (const node of graph.nodes) {
      expect(mermaid, `${node.entryId} in the mermaid`).toContain(asMermaidWritesIt(node.lines[0]))
      expect(svg, `${node.entryId} in the svg`).toContain(asXmlWritesIt(node.lines[0]))
    }
    expect(graph.nodes.map(node => node.id)).toHaveLength(new Set(graph.nodes.map(node => node.id)).size)
    expect(graph.edges.every(edge => graph.nodes.some(node => node.id === edge.from) && graph.nodes.some(node => node.id === edge.to))).toBe(true)
  })

  it('draws one node and one edge per entry of the structure, in both serializers', () => {
    const root = treeWith(THREE_STATES)
    const graph = graphOf(THREE_STATES, root)
    const svg = svgFromGraph(graph)

    expect([...svg.matchAll(/class="box /g)]).toHaveLength(graph.nodes.length)
    expect([...svg.matchAll(/class="edge /g)]).toHaveLength(graph.edges.length)
    expect([...mermaidFromGraph(graph).matchAll(/^ {2}\w+ -->/gm)]).toHaveLength(graph.edges.length)
  })
})

describe('stdout is untouched by the page', () => {
  it('serializes the mermaid from the structure exactly as the pinned rendering does', () => {
    const root = treeWith(THREE_STATES)

    expect(mermaidFromGraph(graphOf(THREE_STATES, root))).toBe(PINNED_MERMAID)
  })

  it('renders this repository the same whether or not a page is asked for', () => {
    const graph = graphOf(repositoryModel(), REPO_ROOT)
    const before = mermaidFromGraph(graph)
    pageOfGraph(graph, 'fixture')

    expect(mermaidFromGraph(graph)).toBe(before)
  })
})

describe('the page a person opens', () => {
  it('renders all three derived states, and each is legible in the entry rather than only in the legend', () => {
    const root = treeWith(THREE_STATES)
    const graph = graphOf(THREE_STATES, root)
    const page = pageOfGraph(graph, 'fixture')

    expect(new Set(graph.nodes.map(node => node.state))).toEqual(new Set(PICTURE_STATES))
    for (const state of PICTURE_STATES) {
      expect(page, `${state} as a shape class`).toContain(`class="box ${state}"`)
      expect(page, `${state} in the legend`).toContain(`data-state="${state}"`)
    }
    expect(page).toContain('enforcement L0 unsupported')
    expect(page).toContain('unknown, no fact named')
  })

  it('fetches nothing when opened: no script, no remote reference, no network of any kind', () => {
    const page = pageOfGraph(graphOf(repositoryModel(), REPO_ROOT), 'fixture')
    const withoutTheNamespaceIdentifier = page.replaceAll(SVG_NAMESPACE, '')

    expect(page).toContain(SVG_NAMESPACE)
    expect(page).not.toMatch(/<script/i)
    expect(withoutTheNamespaceIdentifier).not.toMatch(/https?:\/\//)
    expect(page).not.toMatch(/\ssrc=/i)
    expect(page).not.toMatch(/@import|url\(/i)
    expect(page).not.toMatch(/\shref=/i)
  })

  it('says beside the legend that colour is the derived state and not the enforcement level', () => {
    const page = pageOfGraph(graphOf(repositoryModel(), REPO_ROOT), 'fixture')

    expect(page).toContain(COLOUR_IS_NOT_STRENGTH)
    expect(page.indexOf(COLOUR_IS_NOT_STRENGTH)).toBeGreaterThan(page.indexOf('class="legend"'))
  })

  it('is repeated in the CLI reference from the same constant, so the page and the document cannot drift', () => {
    const prose = readFileSync(CLI_DOC, 'utf8').replaceAll(/\s+/g, ' ')

    expect(prose).toContain(COLOUR_IS_NOT_STRENGTH.replaceAll(/\s+/g, ' '))
  })

  it('still has more than one enforcement level to confuse, so the sentence is still earned here', () => {
    const model = repositoryModel()
    const levels = new Set(model.claims.flatMap(claim => (claim.enforcement == null ? [] : [claim.enforcement.level])))

    expect(
      levels.size,
      'Every claim in this repository now sits at one enforcement level, so the reading the legend sentence corrects can no longer occur here. Re-examine whether the sentence is still earned. Do not lower a claim\u2019s level to make this pass: that trades enforcement for a green test, and raising a level is exactly the change expected to reach this line first.',
    ).toBeGreaterThan(1)
  })

  it('draws those levels in one colour, which is the confusion the sentence names', () => {
    const graph = graphOf(repositoryModel(), REPO_ROOT)
    const statesOfClaims = new Set(graph.nodes.filter(node => node.kind === 'claim').map(node => node.state))

    expect(
      statesOfClaims.size,
      'A claim in this repository stopped being held, so its claims no longer share one colour. This is not about the legend sentence: read it in the enforcement trace, not here.',
    ).toBe(1)
  })

  it('escapes what the model puts in a label, so a needle cannot close a tag', () => {
    const root = treeWith(THREE_STATES)
    const page = pageOfGraph(graphOf(THREE_STATES, root), '<script>alert(1)</script>')

    expect(page).toContain('&quot;quoted&quot;')
    expect(page).not.toContain('<script>alert(1)</script>')
  })

  it('writes the file where it was asked to, and writes nothing where nothing is drawn', () => {
    const root = treeWith(THREE_STATES)
    const target = path.join(root, 'picture.html')

    expect(writeGraphPage(root, target)).toBe(target)
    expect(readFileSync(target, 'utf8')).toContain('<svg')

    const empty = mkdtempSync(path.join(tmpdir(), 'construct-picture-none-'))
    expect(modelGraph(empty)).toBeNull()
    expect(writeGraphPage(empty, path.join(empty, 'picture.html'))).toBeNull()
  })
})
