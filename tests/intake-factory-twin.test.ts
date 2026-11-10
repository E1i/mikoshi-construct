import type { DraftCard } from '../src/commands/intake/draft.js'
import type { RepositoryFacts } from '../src/commands/intake/facts.js'
import { describe, expect, it } from 'vitest'
import { GENERATED_FILES } from '../scripts/core/factory-paths.js'
import { checkDraft, correctionText, FACTORY_TWIN_REASON, FACTORY_TWIN_SOURCE } from '../src/commands/intake/check.js'

const FACTORY_TWIN = GENERATED_FILES.factory.path
const PORT = 'scripts/ports/gh.ts'

const REPOSITORY: RepositoryFacts = {
  exists: relative => [FACTORY_TWIN, PORT].includes(relative),
  pathsNamed: () => [],
  commandResolves: () => true,
  testsCovering: () => [],
}

function draft(touches: string[]): DraftCard {
  return { name: 'factory-twin', kind: 'implement', milestone: 'construct', size: 'S', touches, depends: [], blocks: [], creates: [], task: 'Change the port.', witnesses: [], unclear: [] }
}

function checked(touches: string[]) {
  return checkDraft([draft(touches)], [1], { taken: new Set(), parked: new Set(), done: new Set(), merged: new Set(), repository: REPOSITORY })[0]!
}

describe('intake keeps the generated factory contract out of a card\'s touches', () => {
  it('a card with contract/factory.json in its touches is admitted without it', () => {
    const card = checked([PORT, FACTORY_TWIN])
    expect(card.touches).toEqual([PORT])
    expect(card.unclear).toEqual([])
    expect(card.corrections).toEqual([{ field: 'touches', was: FACTORY_TWIN, now: '(removed)', reason: FACTORY_TWIN_REASON }])
  })

  it('the correction the person sees names the source of the contract and the bus as its writer', () => {
    const line = correctionText(checked([FACTORY_TWIN]).corrections[0]!)
    expect(line).toContain(FACTORY_TWIN_SOURCE)
    expect(line).toContain('pnpm contract:update')
    expect(line).toMatch(/^touches — contract\/factory\.json → \(removed\) — /)
  })

  it('a card without the twin in its touches gets no correction', () => {
    const card = checked([PORT])
    expect(card.touches).toEqual([PORT])
    expect(card.corrections).toEqual([])
  })
})
