import type { IntakeOptions, IntakeResult } from '../src/commands/intake/index.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openBus } from '../scripts/core/db.js'
import { reduce } from '../scripts/core/reducer.js'
import { busCardEvents } from '../scripts/intake/intake.js'
import { parseCard } from '../src/card/grammar.js'
import { witnessDowngrades } from '../src/commands/intake/admit.js'
import { parseDraft } from '../src/commands/intake/draft.js'
import { runIntake } from '../src/commands/intake/index.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'intakecut-'))
  roots.push(root)
  return root
}

function card(name: string, touches: string[], task: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { name, kind: 'implement', milestone: 'runner', size: 'S', contour: 'cheap', decision: 'auto', who: 'shift', touches, task, witnesses: ['`pnpm exec vitest run` exits 0'], ...extra }
}

function intake(root: string, draft: unknown, files: Record<string, string>, options: Partial<IntakeOptions> = {}): IntakeResult {
  const repo = path.join(root, 'repo')
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
    writeFileSync(path.join(repo, file), text)
  }
  const draftFile = path.join(root, 'draft.json')
  writeFileSync(draftFile, JSON.stringify(draft))
  return runIntake({ draft: draftFile, taken: '-', parking: path.join(root, 'parking'), parkingRoot: path.join(root, 'parking'), dir: repo, dryRun: false, autoConfirm: true, readStdin: () => '1', ...options })
}

function detail(result: IntakeResult): string {
  return result.status === 'refused' ? result.detail.join('\n') : ''
}

describe('intake cuts cards that run without window edits', () => {
  it('duplicate slice text is refused and the consumer depends on its foundation', () => {
    const files = { 'src/a.ts': 'export const a = 1\n', 'src/b.ts': 'import { a } from \'./a.js\'\nexport const b = a\n' }
    const duplicated = intake(scratch(), { cards: [card('one', ['src/a.ts'], 'Do the thing.'), card('two', ['src/b.ts'], 'Do the thing.')] }, files)
    expect(duplicated.status).toBe('refused')
    expect(detail(duplicated)).toContain('one and two carry the same task text')

    const ordered = intake(scratch(), { cards: [card('consumer', ['src/b.ts'], 'Read a in b.'), card('foundation', ['src/a.ts'], 'Export a.')] }, files, { dryRun: true })
    if (ordered.status !== 'dryRun')
      throw new Error(detail(ordered))
    const [consumer, foundation] = ordered.cards.map(each => parseCard(each.line))
    if (consumer?.kind !== 'card' || foundation?.kind !== 'card')
      throw new Error('the cards do not parse')
    expect(consumer.card.depends).toEqual([foundation.card.id])
    expect(foundation.card.blocks).toEqual([consumer.card.id])
    expect(foundation.card.depends).toEqual([])
  })

  it('the witness kind is a field, not the phrase red on main', () => {
    const parsed = parseDraft(JSON.stringify({ cards: [card('one', ['src/a.ts'], 'Do it.', { witnesses: [{ witness: '`pnpm exec vitest run tests/a.test.ts` exits 0', kind: 'acceptance' }, '`pnpm exec vitest run tests/b.test.ts` exits 0'] })] }))
    if (parsed.kind !== 'draft')
      throw new Error(parsed.reasons.join('; '))
    expect(parsed.cards[0]!.witnesses).toEqual(['`pnpm exec vitest run tests/a.test.ts` exits 0 · acceptance', '`pnpm exec vitest run tests/b.test.ts` exits 0'])
    expect(parseDraft(JSON.stringify({ cards: [card('one', ['src/a.ts'], 'Do it.', { witnesses: [{ witness: '`x`', kind: 'red' }] })] })).kind).toBe('refused')

    const acceptance = '`pnpm exec vitest run tests/a.test.ts` exits 0 · acceptance'
    const invariant = '`pnpm exec vitest run tests/a.test.ts` exits 0 · invariant'
    expect(witnessDowngrades([acceptance], [invariant])).toEqual([acceptance])
    expect(witnessDowngrades([invariant], [acceptance])).toEqual([])
    expect(witnessDowngrades(['`pnpm exec vitest run tests/a.test.ts` exits 0, red on main · invariant'], [invariant])).toEqual([])
  })

  it('intake registers the plan from an in-repo plan file and a refusal says how to add the slice table', () => {
    const root = scratch()
    const db = openBus(path.join(root, 'bus.db'))
    const files = { 'src/a.ts': '', 'src/c.ts': '', 'docs/plan.md': '# Plan\n\n| item | change |\n|---|---|\n| A | the first |\n| B | the second |\n', 'docs/bare.md': '# Plan\n\nno table\n' }
    const plan = { id: 'p1', title: 'The plan', goal: 'Both halves land', file: 'docs/plan.md' }
    const draft = { plan, cards: [card('first', ['src/a.ts'], 'First half.', { item: 'A' }), card('second', ['src/c.ts'], 'Second half.', { item: 'B' })] }
    const result = intake(root, draft, files, { events: busCardEvents(db, 's1', () => 3) })
    if (result.status !== 'written')
      throw new Error(detail(result))
    reduce(db)
    const ids = result.cards.map(each => each.id)
    expect(db.prepare('SELECT plan_id, state, plan_file FROM plans').all()).toEqual([{ plan_id: 'p1', state: 'open', plan_file: path.join(root, 'repo', 'docs/plan.md') }])
    expect(db.prepare('SELECT item_id, cards FROM plan_items ORDER BY item_id').all()).toEqual([{ item_id: 'A', cards: JSON.stringify([ids[0]]) }, { item_id: 'B', cards: JSON.stringify([ids[1]]) }])
    expect(db.prepare('SELECT DISTINCT actor FROM events WHERE type LIKE \'plan.%\'').all()).toEqual([{ actor: 'owner' }])
    db.close()

    const bare = intake(scratch(), { ...draft, plan: { ...plan, file: 'docs/bare.md' } }, files, { dryRun: true })
    expect(detail(bare)).toContain('has no slice table; add a markdown table whose first column names each item')
    const outside = intake(scratch(), { ...draft, plan: { ...plan, file: '../plan.md' } }, files, { dryRun: true })
    expect(detail(outside)).toContain('is outside the repository')
    const unknownItem = intake(scratch(), { ...draft, cards: [card('first', ['src/a.ts'], 'First half.', { item: 'Z' })] }, files, { dryRun: true })
    expect(detail(unknownItem)).toContain('item \'Z\' has no row in the slice table')
  })
})
