import type { DraftCard } from '../../../src/commands/intake/draft.js'
import type { RepositoryFacts } from '../../../src/commands/intake/facts.js'
import { describe, expect, it } from 'vitest'
import { GENERATED_FILES, RATCHET_FILE } from '../../../scripts/core/factory-paths.js'
import { checkDraft } from '../../../src/commands/intake/check.js'
import { parseDraft } from '../../../src/commands/intake/draft.js'
import { sliceCards } from '../../../src/commands/intake/slice.js'

const CHECK = 'src/commands/intake/check.ts'
const TOUCH_SCOPE = 'scripts/policy/touch-scope.ts'
const OWNER_COMMANDS = 'scripts/core/owner-commands.ts'
const NEW_RULE = 'scripts/policy/new-rule.ts'
const GROWN_ROW = 'boundary:intake->rules'
const NO_SOURCES = { read: () => null, filesUnder: () => [] }

const GRAPH = {
  modules: {
    'intake': { owns: ['src/commands/intake/**'], contract: [], may_use: ['command-registry'], status: 'undecided', concepts: [] },
    'rules': { owns: [TOUCH_SCOPE, NEW_RULE], contract: [], may_use: [], status: 'undecided', concepts: [] },
    'command-registry': { owns: [OWNER_COMMANDS], contract: [OWNER_COMMANDS], may_use: [], status: 'decided', concepts: [] },
  },
  composition_roots: ['src/program.ts'],
  composition_imports: {},
  exclusions: { tests: ['tests/**'] },
}

const RECORDS: Readonly<Record<string, string>> = {
  [GENERATED_FILES.factory.path]: JSON.stringify({ modules: GRAPH }),
  [RATCHET_FILE.path]: JSON.stringify({ [GROWN_ROW]: 6, threshold: 800 }),
}

const repository: RepositoryFacts & { read: (relative: string) => string | null } = {
  exists: () => true,
  pathsNamed: () => [],
  commandResolves: () => true,
  testsCovering: () => [],
  read: relative => RECORDS[relative] ?? null,
}

const facts = { taken: new Set<number>(), parked: new Set<number>(), done: new Set<string>(), merged: new Set<string>(), repository }

const draft: DraftCard = { name: 'placed', kind: 'implement', milestone: 'netwatch', size: 'S', contour: 'cheap', decision: 'auto', touches: [CHECK], depends: [], blocks: [], creates: [], task: 'Change the code.', witnesses: ['`pnpm exec vitest run tests/a.test.ts` exits 0'], unclear: [] }

function touchesUnclear(card: DraftCard): string[] {
  return checkDraft([card], [7], facts)[0]!.unclear.filter(entry => entry.field === 'touches').map(entry => entry.reason)
}

describe('intake measures the imports a placement requires against the boundary ratchet', () => {
  it('a placement whose required import grows a boundary row marks touches unclear', () => {
    const checked = checkDraft([{ ...draft, imports: [{ from: CHECK, to: NEW_RULE }] }], [7], facts)
    expect(checked[0]!.unclear.map(entry => entry.field)).toEqual(['touches'])
    const slice = sliceCards(checked, [7], NO_SOURCES)
    expect(slice.kind === 'sliced' ? slice.cards[0]!.who : slice.reasons).toBe('window')
    expect(slice.kind === 'sliced' ? slice.cards[0]!.text : '').toContain(GROWN_ROW)
  })

  it('a placement inside an allowed boundary row is admitted unchanged', () => {
    const allowed = { ...draft, imports: [{ from: CHECK, to: 'src/commands/intake/draft.ts' }, { from: 'src/program.ts', to: CHECK }, { from: CHECK, to: OWNER_COMMANDS }, { from: 'tests/a.test.ts', to: NEW_RULE }] }
    const [placed] = checkDraft([allowed], [7], facts)
    const [unplaced] = checkDraft([draft], [7], facts)
    expect(placed!.unclear).toEqual([])
    expect({ ...placed!, imports: undefined }).toEqual({ ...unplaced!, imports: undefined })
  })

  it('the draft imports field names the row with its counts and both files', () => {
    const parsed = parseDraft(JSON.stringify({ cards: [{ ...draft, unclear: undefined, depends: undefined, blocks: undefined, creates: undefined, imports: [{ from: CHECK, to: NEW_RULE }, { from: 'src/commands/intake/draft.ts', to: NEW_RULE }] }] }))
    expect(parsed.kind).toBe('draft')
    const card = parsed.kind === 'draft' ? parsed.cards[0]! : draft
    expect(card.imports).toEqual([{ from: CHECK, to: NEW_RULE }, { from: 'src/commands/intake/draft.ts', to: NEW_RULE }])
    expect(touchesUnclear(card)).toEqual([
      `the placement grows ${GROWN_ROW} from 6 to 8 over ${RATCHET_FILE.path}: ${CHECK} imports ${NEW_RULE}; src/commands/intake/draft.ts imports ${NEW_RULE}; growth is the owner's, so a person re-places the card inside a recorded row`,
    ])
  })

  it('a new row starts from zero, and an import into a composition root is a row', () => {
    expect(touchesUnclear({ ...draft, imports: [{ from: TOUCH_SCOPE, to: CHECK }] })).toEqual([
      `the placement grows boundary:rules->intake from 0 to 1 over ${RATCHET_FILE.path}: ${TOUCH_SCOPE} imports ${CHECK}; growth is the owner's, so a person re-places the card inside a recorded row`,
    ])
    expect(touchesUnclear({ ...draft, imports: [{ from: CHECK, to: 'src/program.ts' }] })).toEqual([
      `the placement grows boundary:intake->composition-root from 0 to 1 over ${RATCHET_FILE.path}: ${CHECK} imports src/program.ts; growth is the owner's, so a person re-places the card inside a recorded row`,
    ])
  })

  it('a draft whose imports entry is not { from, to } is refused', () => {
    for (const imports of [[{ from: CHECK }], [{ from: CHECK, to: NEW_RULE, why: 'x' }], 'src/a.ts']) {
      const parsed = parseDraft(JSON.stringify({ cards: [{ ...draft, imports }] }))
      expect(parsed.kind === 'refused' ? parsed.reasons.join('\n') : '').toContain('\'imports\' must be a list of { "from"')
    }
  })

  it('a repository with no ratchet measures nothing, and an unreadable graph holds the card', () => {
    const imports = [{ from: CHECK, to: NEW_RULE }]
    const bare = { ...repository, read: () => null }
    expect(checkDraft([{ ...draft, imports }], [7], { ...facts, repository: bare })[0]!.unclear).toEqual([])
    const broken = { ...repository, read: (relative: string) => relative === RATCHET_FILE.path ? RECORDS[relative]! : '{}' }
    expect(checkDraft([{ ...draft, imports }], [7], { ...facts, repository: broken })[0]!.unclear.map(entry => entry.reason)).toEqual([
      `the imports of this card's placement cannot be measured: ${GENERATED_FILES.factory.path} holds no module graph; a person places the card`,
    ])
  })
})
