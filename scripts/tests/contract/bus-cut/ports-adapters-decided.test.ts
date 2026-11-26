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

const ROLE_POLICY = 'scripts/ports/client/role-policy.ts'

const HOST_PORTS = [
  'scripts/ports/host-fault.ts',
  'scripts/ports/host-thermal.ts',
  'scripts/ports/host/macos-thermal.ts',
]

const ADAPTERS_MODULE = [...PURE_ADAPTERS.slice(0, 4), ROLE_POLICY, ...PURE_ADAPTERS.slice(4), ...HOST_PORTS]

const DECLARED_IN_BUS = [
  'scripts/ports/bus-read.ts',
  'scripts/ports/worktree-home.ts',
]

const NODE_TO_ADAPTER = [
  ['scripts/nodes/review/reviewer.ts', 'scripts/ports/git.ts'],
  ['scripts/nodes/answer/answerer.ts', 'scripts/ports/client/contract.ts'],
] as const

const PORTS_GRANTED_BY_D778 = ['card-record']

const NOT_ABOVE_ADAPTERS = ['layout', 'command-registry', 'ui', 'ports-adapters']

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

  it('ports-adapters holds exactly the five pure adapters, the role session policy (D-862) and the host ports (D-867)', () => {
    const adapters = MODULE_GRAPH.modules['ports-adapters']
    const ports = MODULE_GRAPH.modules.ports

    expect(adapters).toEqual({ owns: ADAPTERS_MODULE, contract: ADAPTERS_MODULE, may_use: ['layout', 'command-registry', 'ui'], status: 'decided' })
    expect(ports?.status).toBe('decided')
    expect(ports?.may_use).toEqual(['layout', 'command-registry', 'ui', 'ports-adapters'])
    expect(ports?.owns.filter(glob => glob.startsWith('!scripts/ports/')).map(glob => glob.slice(1)).sort()).toEqual([...ADAPTERS_MODULE, ...DECLARED_IN_BUS].sort())
    expect(DECLARED_IN_BUS.filter(file => MODULE_GRAPH.modules.bus?.owns.includes(file))).toEqual(DECLARED_IN_BUS)
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
