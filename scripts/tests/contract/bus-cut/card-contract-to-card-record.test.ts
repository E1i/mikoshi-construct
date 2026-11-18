import { describe, expect, it } from 'vitest'
import { MODULE_GRAPH } from '../../../contract/factory/modules.js'
import { repositoryReport } from '../../../contract/module-graph/report.js'
import * as cardAutomaton from '../../../core/card-automaton.js'
import * as cardContract from '../../../intake/card-contract.js'

const REPO_RUN_TIMEOUT = 180_000

const CARD_CONTRACT = 'scripts/intake/card-contract.ts'
const CARD_AUTOMATON = 'scripts/core/card-automaton.ts'
const HEARTBEAT = 'scripts/supervisor/heartbeat.ts'
const CARD_RECORD = 'card-record'
const VIOLATING_IMPORTS_AT_MOST = 1076

describe('card-contract.ts is held by card-record (card-contract.md F1+A)', () => {
  it('card-record owns card-contract.ts and holds it as contract; card-model no longer does', () => {
    const { modules } = MODULE_GRAPH
    expect(modules[CARD_RECORD]?.owns).toContain(CARD_CONTRACT)
    expect(modules[CARD_RECORD]?.contract).toContain(CARD_CONTRACT)
    expect(modules['card-model']?.owns).not.toContain(CARD_CONTRACT)
    expect(modules['card-model']?.contract).not.toContain(CARD_CONTRACT)
  })

  it('notMine and NOT_MINE live in the card automaton, not in the card contract', () => {
    expect(Object.keys(cardAutomaton)).toEqual(expect.arrayContaining(['notMine', 'NOT_MINE']))
    expect(Object.keys(cardContract)).not.toContain('notMine')
    expect(Object.keys(cardContract)).not.toContain('NOT_MINE')
    expect(cardAutomaton.notMine({ id: 7, state: cardAutomaton.DROPPED_CARD }, 'merge')).toBe('card #7 is dropped in the bus, so no merge of it is the bus\'s to run')
    expect(cardAutomaton.notMine({ id: 7, state: cardAutomaton.IN_REVIEW_CARD }, 'merge')).toBeNull()
    expect(cardAutomaton.notMine(null, 'merge')).toBeNull()
  })

  it('the only reverse edge out of card-contract.ts goes to the heartbeat, and the violating imports fall', { timeout: REPO_RUN_TIMEOUT }, () => {
    const report = repositoryReport()
    const holder = new Map(report.files.map(({ file, holder: owner }) => [file, owner]))
    const granted = new Set([CARD_RECORD, ...(MODULE_GRAPH.modules[CARD_RECORD]?.may_use ?? [])])
    const outOfCardContract = report.graph.imports.filter(({ from }) => from === CARD_CONTRACT).map(({ to }) => to)

    expect(holder.get(CARD_CONTRACT)).toBe(CARD_RECORD)
    expect(outOfCardContract).not.toContain(CARD_AUTOMATON)

    const reverse = outOfCardContract.filter((to) => {
      const target = holder.get(to)
      return target !== undefined && MODULE_GRAPH.modules[target]?.status === 'decided' && !granted.has(target)
    })
    expect(reverse).toEqual([HEARTBEAT])
    expect(report.statistics.violatingImports).toBeLessThanOrEqual(VIOLATING_IMPORTS_AT_MOST)
    expect(report.statistics.mayUseCycles).toBe(0)
  })
})
