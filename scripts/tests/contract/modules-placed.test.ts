import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { belowInTheLayers, LAYERS, MODULE_GRAPH } from '../../contract/factory/modules.js'
import { boundaryReport } from '../../contract/module-graph/boundary.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const REPO_RUN_TIMEOUT = 180_000
const NODE_LAYER = 'nodes'
const UNDECIDED_REASONS = ['from-undecided', 'into-undecided']

interface Place {
  layer: number
  position: number
  ordered: boolean
}

const PLACES = new Map<string, Place>(LAYERS.flatMap(({ modules, ordered }, layer) => modules.map((id, position) => [id, { layer, position, ordered }] as const)))

function isBelow(user: string, used: string): boolean {
  const [from, to] = [PLACES.get(user)!, PLACES.get(used)!]
  return to.layer < from.layer || (to.layer === from.layer && from.ordered && to.position < from.position)
}

const graphModules = Object.entries(MODULE_GRAPH.modules).filter(([, spec]) => spec.status !== 'tool').map(([id]) => id)

describe('every module of the factory graph is placed in its layer', () => {
  it('no module of the factory graph is undecided', () => {
    expect(Object.entries(MODULE_GRAPH.modules).filter(([, spec]) => spec.status === 'undecided').map(([id]) => id)).toEqual([])
    expect(MODULE_GRAPH.modules['node-laws']?.status).toBe('tool')
  })

  it('every graph module sits in exactly one layer, and no tool sits in one', () => {
    const placed = LAYERS.flatMap(layer => layer.modules)
    expect([...placed].sort()).toEqual([...graphModules].sort())
    expect(new Set(placed).size).toBe(placed.length)
  })

  it('may_use reaches only lower layers and earlier modules of the same layer', () => {
    const upward = graphModules.flatMap(id => MODULE_GRAPH.modules[id]!.may_use.filter(used => !isBelow(id, used)).map(used => `${id} -> ${used}`))
    const nodes = LAYERS.find(layer => layer.name === NODE_LAYER)!.modules
    const nodeToNode = nodes.flatMap(id => MODULE_GRAPH.modules[id]!.may_use.filter(used => nodes.includes(used)).map(used => `${id} -> ${used}`))

    expect(upward).toEqual([])
    expect(nodeToNode).toEqual([])
  })

  it('a placed module may use every module below it, so a downward edge is decided by may_use alone', () => {
    const narrower = graphModules.filter(id => belowInTheLayers(id).some(lower => !MODULE_GRAPH.modules[id]!.may_use.includes(lower)))
    expect(narrower).toEqual([])
  })

  it('the repository counts no edge for an undecided side, and an upward edge stays a violation', { timeout: REPO_RUN_TIMEOUT }, () => {
    const { violations } = boundaryReport(REPO_ROOT)
    const undecided = violations.filter(({ reasons }) => reasons.some(reason => UNDECIDED_REASONS.includes(reason)))
    const upward = violations.filter(({ fromModule, toHolder }) => PLACES.has(fromModule) && PLACES.has(toHolder) && isBelow(toHolder, fromModule))

    expect(undecided.map(({ from, to }) => `${from} -> ${to}`)).toEqual([])
    expect(upward.every(({ reasons }) => reasons.includes('not-in-may-use'))).toBe(true)
    expect(upward.length).toBeGreaterThan(0)
  })
})
