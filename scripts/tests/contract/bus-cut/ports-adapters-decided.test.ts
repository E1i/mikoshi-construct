import { describe, expect, it } from 'vitest'
import { MODULE_GRAPH } from '../../../contract/factory/modules.js'
import { repositoryReport } from '../../../contract/module-graph/report.js'

const REPO_RUN_TIMEOUT = 180_000

const PURE_ADAPTERS = [
  'scripts/ports/git.ts',
  'scripts/ports/disk.ts',
  'scripts/ports/prompt-store.ts',
  'scripts/ports/client/contract.ts',
  'scripts/ports/client/codex/adapter.ts',
]

const NODE_TO_ADAPTER = [
  ['scripts/nodes/review/reviewer.ts', 'scripts/ports/git.ts'],
  ['scripts/nodes/answer/answerer.ts', 'scripts/ports/client/contract.ts'],
] as const

const PORTS_GRANTED_BY_D778 = ['card-record']

const NOT_ABOVE_ADAPTERS = ['layout', 'ports-adapters']

const NOT_ABOVE_PORTS = [...NOT_ABOVE_ADAPTERS, 'ports']

describe('ports-adapters is a decided module (D-503)', () => {
  it('a node imports a pure adapter without a violation', { timeout: REPO_RUN_TIMEOUT }, () => {
    const report = repositoryReport()
    const imported = new Set(report.graph.imports.map(({ from, to }) => `${from} -> ${to}`))
    const violating = new Set(report.violations.map(({ from, to }) => `${from} -> ${to}`))

    for (const [node, adapter] of NODE_TO_ADAPTER) {
      expect(imported, `${node} imports ${adapter}`).toContain(`${node} -> ${adapter}`)
      expect(violating, `${node} -> ${adapter} is lawful`).not.toContain(`${node} -> ${adapter}`)
    }
  })

  it('ports-adapters holds exactly the five pure adapters', () => {
    const adapters = MODULE_GRAPH.modules['ports-adapters']
    const ports = MODULE_GRAPH.modules.ports

    expect(adapters).toEqual({ owns: PURE_ADAPTERS, contract: PURE_ADAPTERS, may_use: ['layout'], status: 'decided' })
    expect(ports?.status).toBe('decided')
    expect(ports?.may_use).toEqual(['layout', 'ports-adapters'])
    const carvedOutOfPorts = ports?.owns.filter(glob => glob.startsWith('!scripts/ports/')).map(glob => glob.slice(1)) ?? []
    expect(carvedOutOfPorts.filter(file => adapters?.owns.includes(file)).sort()).toEqual([...PURE_ADAPTERS].sort())
    expect(carvedOutOfPorts.filter(file => !adapters?.owns.includes(file))).toEqual(['scripts/ports/result.ts'])
    expect(MODULE_GRAPH.modules.session?.owns).toContain('scripts/ports/result.ts')
  })

  it('the decided importers of the adapters are granted ports-adapters, and card-record keeps the ports grant D-778 gives it', () => {
    const granted = Object.entries(MODULE_GRAPH.modules).filter(([, spec]) => spec.may_use.includes('ports-adapters')).map(([id]) => id)
    const widePorts = Object.entries(MODULE_GRAPH.modules).filter(([, spec]) => spec.may_use.includes('ports')).map(([id]) => id)

    expect(granted).toEqual(expect.arrayContaining(['node-answer', 'node-close', 'node-launch', 'node-merge', 'node-restart', 'node-review', 'node-update', 'node-witness', 'session']))
    expect(widePorts).toEqual(expect.arrayContaining(PORTS_GRANTED_BY_D778))
    expect(granted.filter(id => NOT_ABOVE_ADAPTERS.includes(id))).toEqual([])
    expect(widePorts.filter(id => NOT_ABOVE_PORTS.includes(id))).toEqual([])
  })
})
