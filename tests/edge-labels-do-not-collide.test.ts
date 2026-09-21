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

function closestPair(positions: LabelPosition[]): number {
  let closest = Number.POSITIVE_INFINITY
  for (const [index, one] of positions.entries()) {
    for (const other of positions.slice(index + 1))
      closest = Math.min(closest, Math.hypot(one.x - other.x, one.y - other.y))
  }
  return closest
}

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

  it('takes the threshold from the renderer rather than repeating a number of its own', () => {
    expect(LABEL_SEPARATION).toBeGreaterThan(0)
    expect(readFileSync(path.join(REPO_ROOT, 'tests/edge-labels-do-not-collide.test.ts'), 'utf8'))
      .not
      .toMatch(/toBeGreaterThanOrEqual\(\s*\d/)
  })
})
