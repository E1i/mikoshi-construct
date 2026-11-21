import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MODULE_GRAPH } from '../../contract/factory/modules.js'
import { boundaryKey, boundaryReport, boundaryViolations } from '../../contract/module-graph/boundary.js'
import { GENERATED_FILES, RATCHET_FILE } from '../../core/factory-paths.js'
import { boundaryRowOf, boundaryRowsOf, placementGraphOf, placementGrowth } from '../../policy/placement-growth.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')

function read(file: string): string {
  return readFileSync(path.join(REPO_ROOT, file), 'utf8')
}

describe('placement growth judges an import as the boundary ratchet does', () => {
  const report = boundaryReport(REPO_ROOT)

  it('every import edge of this repository lands in the row boundaryReport counts it in, or in none', () => {
    const graph = placementGraphOf(JSON.stringify({ modules: MODULE_GRAPH }))!
    const counted = new Map(boundaryViolations(MODULE_GRAPH, report.graph).map(violation => [`${violation.from}\n${violation.to}`, boundaryKey(violation)]))
    const judged = report.graph.map(edge => [`${edge.from}\n${edge.to}`, boundaryRowOf(graph, edge)] as const)
    expect(judged.filter(([key, row]) => (counted.get(key) ?? null) !== row)).toEqual([])
    expect(judged.filter(([, row]) => row !== null)).toHaveLength(counted.size)
  })

  it('the committed module graph and ratchet parse, and an edge already counted grows its recorded row by one', () => {
    const graph = placementGraphOf(read(GENERATED_FILES.factory.path))
    const recorded = boundaryRowsOf(read(RATCHET_FILE.path))
    expect(graph).not.toBeNull()
    expect(recorded).not.toBeNull()
    const violation = boundaryViolations(MODULE_GRAPH, report.graph)[0]!
    const row = boundaryKey(violation)
    expect(placementGrowth([violation, violation], graph!, recorded!)).toEqual([{ row, now: recorded![row], after: recorded![row]! + 1, imports: [violation] }])
  })

  it('text that is not a module graph or a ratchet reads as null', () => {
    expect(placementGraphOf('not json')).toBeNull()
    expect(placementGraphOf('{"modules":{"modules":{"a":{"owns":[]}}}}')).toBeNull()
    expect(boundaryRowsOf('[]')).toBeNull()
    expect(boundaryRowsOf('{"boundary:a->b":2,"lines:x":900,"boundary:c->d":"1"}')).toEqual({ 'boundary:a->b': 2 })
  })
})
