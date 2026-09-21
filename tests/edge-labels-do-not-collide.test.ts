import type { RepositoryModel } from '../src/model/schema.js'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { graphOfModel } from '../src/model/graph.js'
import { MODEL_FILE, MODEL_VERSION, parseModel } from '../src/model/schema.js'
import { deriveModelState } from '../src/model/state.js'
import { LABEL_SEPARATION, svgFromGraph } from '../src/model/svg.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')

const TWO_EDGES_TO_ONE_FACT: RepositoryModel = {
  modelVersion: MODEL_VERSION,
  facts: [{ id: 'one-file', kind: 'file-exists', path: 'there.md', authoredBy: 'construct' }],
  claims: [
    {
      id: 'both-stages-stand-on-it',
      statement: 'two edges between one pair of nodes',
      authoredBy: 'construct',
      enforcement: { mechanism: 'm', level: 'L3', supportedBy: ['one-file'] },
      verification: { mechanism: 'v', supportedBy: ['one-file'] },
    },
    {
      id: 'and-so-does-this-one',
      statement: 'two more',
      authoredBy: 'construct',
      enforcement: { mechanism: 'm', level: 'L3', supportedBy: ['one-file'] },
      verification: { mechanism: 'v', supportedBy: ['one-file'] },
    },
  ],
  hypotheses: [],
}

interface LabelPosition {
  x: number
  y: number
}

function labelPositions(model: RepositoryModel, root: string): LabelPosition[] {
  const svg = svgFromGraph(graphOfModel(model, deriveModelState(model, root)))
  return [...svg.matchAll(/<text x="(-?\d+)" y="(-?\d+)" class="stage"/g)]
    .map(match => ({ x: Number(match[1]), y: Number(match[2]) }))
}

function treeWithThePathTheFactsName(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-labels-'))
  writeFileSync(path.join(dir, 'there.md'), 'present\n')
  return dir
}

function visibleFirstLines(model: RepositoryModel, root: string): string[] {
  const svg = svgFromGraph(graphOfModel(model, deriveModelState(model, root)))
  return [...svg.matchAll(/class="label first">([^<]*)</g)].map(match => match[1] ?? '')
}

function repeated(lines: string[]): string[] {
  return [...new Set(lines.filter((line, index) => lines.indexOf(line) !== index))]
}

function closestPair(positions: LabelPosition[]): number {
  let closest = Number.POSITIVE_INFINITY
  for (const [index, one] of positions.entries()) {
    for (const other of positions.slice(index + 1))
      closest = Math.min(closest, Math.hypot(one.x - other.x, one.y - other.y))
  }
  return closest
}

const MARGIN_ON_THIS_REPOSITORY = closestPair(labelPositions(
  parseModel(readFileSync(path.join(REPO_ROOT, MODEL_FILE), 'utf8'), MODEL_FILE),
  REPO_ROOT,
))

describe('edge labels are held apart by distance, which is not the same as being readable', () => {
  it('separates every pair of stage labels by at least one line height, on a model whose edges run in parallel', () => {
    const positions = labelPositions(TWO_EDGES_TO_ONE_FACT, treeWithThePathTheFactsName())

    expect(positions.length).toBeGreaterThan(1)
    expect(closestPair(positions)).toBeGreaterThanOrEqual(LABEL_SEPARATION)
  })

  it('separates them on this repository\'s own model, where several claims stand on one file', () => {
    const model = parseModel(readFileSync(path.join(REPO_ROOT, MODEL_FILE), 'utf8'), MODEL_FILE)
    const positions = labelPositions(model, REPO_ROOT)

    expect(positions.length).toBeGreaterThan(1)
    expect(closestPair(positions)).toBeGreaterThanOrEqual(LABEL_SEPARATION)
  })

  it(`carries ${MARGIN_ON_THIS_REPOSITORY}px between its closest pair against a threshold of ${LABEL_SEPARATION}px, so the room left is in the result line rather than only in a pass`, () => {
    expect(MARGIN_ON_THIS_REPOSITORY).toBeGreaterThanOrEqual(LABEL_SEPARATION)
  })

  it('takes the threshold from the renderer rather than repeating a number of its own', () => {
    expect(LABEL_SEPARATION).toBeGreaterThan(0)
    expect(readFileSync(path.join(REPO_ROOT, 'tests/edge-labels-do-not-collide.test.ts'), 'utf8'))
      .not
      .toMatch(/toBeGreaterThanOrEqual\(\s*\d/)
  })
})

describe('elided labels stay distinguishable \u2014 a property nothing in this repository violates today', () => {
  it('shows no two entries as the same line on this repository\u0027s own model', () => {
    const model = parseModel(readFileSync(path.join(REPO_ROOT, MODEL_FILE), 'utf8'), MODEL_FILE)

    expect(repeated(visibleFirstLines(model, REPO_ROOT))).toEqual([])
  })

  it('is violable in the middle, which is the part elision drops, and the check sees it', () => {
    const differingOnlyInTheMiddle: RepositoryModel = {
      modelVersion: MODEL_VERSION,
      facts: [
        { id: 'one', kind: 'file-exists', path: 'templates/presets/node-backend/one/scripts/tests/lint/syntax-policy.test.ts', authoredBy: 'construct' },
        { id: 'two', kind: 'file-exists', path: 'templates/presets/node-backend/two/scripts/tests/lint/syntax-policy.test.ts', authoredBy: 'construct' },
      ],
      claims: [],
      hypotheses: [],
    }
    const lines = visibleFirstLines(differingOnlyInTheMiddle, treeWithThePathTheFactsName())

    expect(differingOnlyInTheMiddle.facts[0]?.path).not.toBe(differingOnlyInTheMiddle.facts[1]?.path)
    expect(repeated(lines)).toHaveLength(1)
  })

  it('keeps the tail, so two facts on one long path stay apart by what follows it', () => {
    const shared = 'templates/presets/node-frontend/sample/scripts/tests/lint/syntax-policy.test.ts'
    const sameLongPath: RepositoryModel = {
      modelVersion: MODEL_VERSION,
      facts: [
        { id: 'exists', kind: 'file-exists', path: shared, authoredBy: 'discovery' },
        { id: 'contains', kind: 'file-contains', path: shared, authoredBy: 'discovery', needle: 'ROLES' },
      ],
      claims: [],
      hypotheses: [],
    }

    expect(repeated(visibleFirstLines(sameLongPath, treeWithThePathTheFactsName()))).toEqual([])
  })
})
