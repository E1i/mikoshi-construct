import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const FACTORY_CONTRACT = path.join(REPO_ROOT, 'contract/factory.json')

interface Layer {
  modules: readonly string[]
  ordered: boolean
}

const NODES = ['node-answer', 'node-close', 'node-launch', 'node-merge', 'node-restart', 'node-review', 'node-update', 'node-witness']

const TARGET_LAYERS: readonly Layer[] = [
  { modules: ['layout', 'command-registry', 'ui', 'ports-adapters', 'ports'], ordered: true },
  { modules: ['events', 'bus'], ordered: true },
  { modules: ['card-model', 'card-record', 'project', 'plan', 'order', 'decisions', 'session', 'model', 'quality', 'intake', 'rules', 'pr-record', 'factory-contract'], ordered: true },
  { modules: NODES, ordered: false },
  { modules: ['cli', 'atlas', 'release', 'cost', 'window', 'board'], ordered: true },
]

const TOOLS = ['contract-generator', 'node-laws']

interface RecordedModule {
  may_use: string[]
  status: string
}

const MODULES = (JSON.parse(readFileSync(FACTORY_CONTRACT, 'utf8')) as { modules: { modules: Record<string, RecordedModule> } }).modules.modules

const PLACES = new Map(TARGET_LAYERS.flatMap(({ modules, ordered }, layer) => modules.map((id, position) => [id, { layer, position, ordered }] as const)))

function isBelow(user: string, used: string): boolean {
  const [from, to] = [PLACES.get(user)!, PLACES.get(used)!]
  return to.layer < from.layer || (to.layer === from.layer && from.ordered && to.position < from.position)
}

const graphModules = Object.entries(MODULES).filter(([, spec]) => spec.status !== 'tool').map(([id]) => id)

describe('every module of the factory graph is placed in its layer', () => {
  it('no module of the factory graph is undecided', () => {
    expect(Object.entries(MODULES).filter(([, spec]) => spec.status === 'undecided').map(([id]) => id)).toEqual([])
    expect(TOOLS.map(id => MODULES[id]?.status)).toEqual(TOOLS.map(() => 'tool'))
  })

  it('may_use reaches only lower layers and earlier modules of the same layer', () => {
    expect(graphModules.filter(id => !PLACES.has(id))).toEqual([])
    expect([...PLACES.keys()].filter(id => MODULES[id] === undefined)).toEqual([])
    const upward = graphModules.flatMap(id => MODULES[id]!.may_use.filter(used => !PLACES.has(used) || !isBelow(id, used)).map(used => `${id} -> ${used}`))
    const nodeToNode = NODES.flatMap(id => MODULES[id]!.may_use.filter(used => NODES.includes(used)).map(used => `${id} -> ${used}`))

    expect(upward).toEqual([])
    expect(nodeToNode).toEqual([])
  })

  it('a placed module may use every module below it, so a downward edge is decided by may_use alone', () => {
    const narrower = graphModules.filter(id => [...PLACES.keys()].some(lower => isBelow(id, lower) && !MODULES[id]!.may_use.includes(lower)))
    expect(narrower).toEqual([])
  })
})
