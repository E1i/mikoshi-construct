import { describe, expect, it } from 'vitest'
import { MODULE_GRAPH } from '../../../contract/factory/modules.js'
import { repositoryReport } from '../../../contract/module-graph/report.js'
import * as cardHold from '../../../core/card-hold.js'
import * as events from '../../../core/events.js'

const REPO_RUN_TIMEOUT = 180_000

const EVENTS = 'scripts/core/events.ts'

const DECIDED_IMPORTERS = [
  ['scripts/supervisor/run.ts', EVENTS],
  ['scripts/core/card-automaton.ts', EVENTS],
] as const

const SESSION_STOP_EXPORTS = ['sessionStopOf', 'SESSION_STOP_CODES'] as const

describe('events is a decided module (D-502)', () => {
  it('a decided importer of the event catalogue is not a violation', { timeout: REPO_RUN_TIMEOUT }, () => {
    const report = repositoryReport()
    const imported = new Set(report.graph.imports.map(({ from, to }) => `${from} -> ${to}`))
    const violating = new Set(report.violations.map(({ from, to }) => `${from} -> ${to}`))

    for (const [importer, catalogue] of DECIDED_IMPORTERS) {
      expect(imported, `${importer} imports ${catalogue}`).toContain(`${importer} -> ${catalogue}`)
      expect(violating, `${importer} -> ${catalogue} is lawful`).not.toContain(`${importer} -> ${catalogue}`)
    }
  })

  it('session-stop parsing lives in card-hold, not in the event catalogue', () => {
    for (const name of SESSION_STOP_EXPORTS) {
      expect(Object.keys(cardHold), `card-hold exports ${name}`).toContain(name)
      expect(Object.keys(events), `events does not export ${name}`).not.toContain(name)
    }
    expect(cardHold.SESSION_STOP_CODES).toEqual([events.OUTSIDE_TOUCHES, events.OPEN_QUESTION])
  })

  it('events is decided with its whole file as contract and every decided importer is granted it', () => {
    expect(MODULE_GRAPH.modules.events).toEqual({ owns: [EVENTS], contract: [EVENTS], may_use: [], status: 'decided' })

    const granted = Object.entries(MODULE_GRAPH.modules).filter(([, spec]) => spec.may_use.includes('events')).map(([id]) => id).sort()
    expect(granted).toEqual(['bus', 'card-record', 'node-answer', 'node-close', 'node-launch', 'node-merge', 'node-restart', 'node-review', 'node-update', 'node-witness', 'plan', 'pr-record', 'session'])
  })
})
