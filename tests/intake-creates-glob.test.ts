import type { DraftCard } from '../src/commands/intake/draft.js'
import { describe, expect, it } from 'vitest'
import { pathsOutside } from '../src/card/covering-tests.js'
import { checkDraft, nonPathTouchRefusals } from '../src/commands/intake/check.js'

const GLOB = 'apps/api/**'
const CREATED_TEST = 'apps/api/tests/health.controller.test.ts'
const CHANGE_WITNESS = `\`pnpm exec vitest run ${CREATED_TEST}\` exits 0 on head and fails on main`

function draftCard(fields: Partial<DraftCard> = {}): DraftCard {
  return { name: 'createsglob', kind: 'implement', milestone: 'runner', size: 'S', contour: 'cheap', decision: 'auto', touches: ['scripts/a.ts'], task: 'A card.', witnesses: [], depends: [], blocks: [], creates: [], unclear: [], ...fields }
}

function checked(card: DraftCard, existing: readonly string[] = ['scripts/a.ts'], named: readonly string[] = []) {
  const repository = { exists: (relative: string) => existing.includes(relative), pathsNamed: () => [...named], commandResolves: () => true, testsCovering: () => [] }
  const [result] = checkDraft([card], [2], { taken: new Set(), parked: new Set(), done: new Set(), merged: new Set(), repository })
  return result!
}

describe('a witness under a creates glob', () => {
  it('a witness under a creates glob is not unclear in intake check', () => {
    expect(checked(draftCard({ creates: [GLOB], witnesses: [CHANGE_WITNESS] })).unclear).toEqual([])
  })

  it('a witness under a creates glob with a kind is not unclear', () => {
    expect(checked(draftCard({ creates: [`${GLOB} (plain)`], witnesses: [CHANGE_WITNESS] })).unclear).toEqual([])
  })

  it('a grep witness over a path under a creates glob depends on the head', () => {
    expect(checked(draftCard({ creates: [GLOB], witnesses: [`\`grep -q health ${CREATED_TEST}\` exits 0`] })).unclear).toEqual([])
  })

  it('stays unclear for a sibling that only shares the prefix text, and for a directory named without the glob', () => {
    for (const creates of ['apps/ap/**', 'apps/api/test/**', 'apps/api'])
      expect(checked(draftCard({ creates: [creates], witnesses: [CHANGE_WITNESS] })).unclear).toEqual([expect.objectContaining({ field: 'witnesses', reason: expect.stringContaining('names no path of the repository') })])
  })
})

describe('pathsOutside over a creates glob', () => {
  it('a path under a creates glob is not outside', () => {
    expect(pathsOutside(['scripts/a.ts'], [GLOB], [CREATED_TEST])).toEqual([])
    expect(pathsOutside(['scripts/a.ts'], [`${GLOB} (plain)`], [CREATED_TEST])).toEqual([])
  })

  it('a path beside the glob is outside, and the touches still count', () => {
    expect(pathsOutside(['scripts/a.ts'], [GLOB], ['apps/api-gateway/main.ts', 'apps/api', 'scripts/a.ts'])).toEqual(['apps/api-gateway/main.ts', 'apps/api'])
  })
})

describe('touches against a creates glob', () => {
  it('a touches path under a creates glob is read as created, not as does not exist', () => {
    const result = checked(draftCard({ touches: ['apps/api/src/main.ts'], creates: [GLOB] }), [])

    expect(result.unclear).toEqual([])
    expect(result.touches).toEqual(['apps/api/src/main.ts'])
  })

  it('a touches path under a creates glob is not rewritten to the only path of that name', () => {
    const result = checked(draftCard({ touches: ['apps/api/src/main.ts'], creates: [GLOB] }), [], ['apps/web/src/main.ts'])

    expect(result.corrections).toEqual([])
    expect(result.touches).toEqual(['apps/api/src/main.ts'])
  })

  it('a touches path outside the glob still does not exist', () => {
    const result = checked(draftCard({ touches: ['apps/web/main.ts'], creates: [GLOB] }), [])

    expect(result.unclear).toEqual([expect.objectContaining({ field: 'touches', reason: expect.stringContaining('\'apps/web/main.ts\' does not exist') })])
  })

  it('an existing file under the glob is no correction of an entry the card never wrote, while the glob itself still is', () => {
    expect(checked(draftCard({ touches: ['apps/api/old.ts'], creates: [GLOB] }), ['apps/api/old.ts']).corrections).toEqual([])
    expect(checked(draftCard({ touches: [GLOB], creates: [GLOB] }), ['apps/api']).corrections).toEqual([expect.objectContaining({ field: 'creates', was: GLOB, now: '(exists, not new)' })])
  })

  it('a touches path under a creates glob is not refused for its shape', () => {
    const refused = (creates: string[]) => nonPathTouchRefusals([draftCard({ touches: ['@org/pkg/index.ts'], creates })], { exists: () => false, pathsNamed: () => [], commandResolves: () => true, testsCovering: () => [] })

    expect(refused(['@org/pkg/**'])).toEqual([])
    expect(refused([])).toEqual([expect.stringContaining('reads as a package name')])
  })
})
