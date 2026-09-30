import type { KnownCarrier } from '../../attach/earlier-carriers.js'
import { describe, expect, it } from 'vitest'
import { driftOf, growKnownSet, renderKnownSet, sourceOf } from '../../attach/earlier-carriers.js'

const PLAN = '.claude/commands/plan.md'
const WORKFLOW = 'scripts/construct/implement.workflow'

function entry(target: string, sha256: string, date: string): KnownCarrier {
  return { target, sha256, date }
}

describe('growKnownSet', () => {
  it('keeps the entries already in the file, in their order and as written', () => {
    const existing = [entry(WORKFLOW, 'b', '2026-09-20'), entry(PLAN, 'a', '2026-09-16')]
    const grown = growKnownSet(existing, [entry(PLAN, 'a', '2026-09-30'), entry(WORKFLOW, 'b', '2026-09-30')])
    expect(grown).toEqual(existing)
  })

  it('appends only the pairs the file lacks, after the existing ones', () => {
    const existing = [entry(PLAN, 'a', '2026-09-16')]
    const grown = growKnownSet(existing, [entry(PLAN, 'a', '2026-09-16'), entry(PLAN, 'c', '2026-09-17'), entry(WORKFLOW, 'a', '2026-09-17')])
    expect(grown).toEqual([entry(PLAN, 'a', '2026-09-16'), entry(PLAN, 'c', '2026-09-17'), entry(WORKFLOW, 'a', '2026-09-17')])
  })

  it('does not append a pair twice when the sources name it twice', () => {
    const grown = growKnownSet([], [entry(PLAN, 'a', '2026-09-16'), entry(PLAN, 'a', '2026-09-18')])
    expect(grown).toEqual([entry(PLAN, 'a', '2026-09-16')])
  })
})

describe('driftOf', () => {
  it('names a pair the sources have and the file lacks', () => {
    const drift = driftOf([entry(PLAN, 'a', '2026-09-16')], [entry(PLAN, 'a', '2026-09-16'), entry(PLAN, 'c', '2026-09-17')])
    expect(drift.missing).toEqual([entry(PLAN, 'c', '2026-09-17')])
    expect(drift.extra).toEqual([])
  })

  it('names a pair the file has and neither source has', () => {
    const drift = driftOf([entry(PLAN, 'a', '2026-09-16'), entry(PLAN, 'z', '2026-09-16')], [entry(PLAN, 'a', '2026-09-16')])
    expect(drift.extra).toEqual([entry(PLAN, 'z', '2026-09-16')])
    expect(drift.missing).toEqual([])
  })

  it('does not see a difference in the date alone', () => {
    const drift = driftOf([entry(PLAN, 'a', '2026-09-16')], [entry(PLAN, 'a', '2026-09-30')])
    expect(drift).toEqual({ missing: [], extra: [] })
  })
})

describe('the generator', () => {
  it('reads a .claude carrier from its _claude source and any other carrier from its own path', () => {
    expect(sourceOf(PLAN)).toBe('templates/ai/claude/_claude/commands/plan.md')
    expect(sourceOf(WORKFLOW)).toBe('templates/ai/claude/scripts/construct/implement.workflow')
  })

  it('renders the file as two-space JSON with a trailing newline', () => {
    expect(renderKnownSet([entry(PLAN, 'a', '2026-09-16')])).toBe(`${JSON.stringify([entry(PLAN, 'a', '2026-09-16')], null, 2)}\n`)
  })
})
