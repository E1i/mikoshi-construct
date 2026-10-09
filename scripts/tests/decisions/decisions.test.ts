import { describe, expect, it } from 'vitest'
import { DECISION_FORMAT, DECISIONS_IN_FORCE_LIMIT, decisionsRefusals, inForce, parseDecisions } from '../../decisions/decisions.js'
import { runDecisionsRead } from '../../decisions/read.js'

const HEADER = '# Owner decisions\n\nOne line per decision, numbered D-N; a replaced one is marked superseded-by D-M.\n\n'

function file(...lines: string[]): string {
  return `${HEADER}${lines.join('\n')}\n`
}

function read(text: string, args: string[] = ['/d/owner-decisions.md']): { code: number, out: string[], err: string[] } {
  const out: string[] = []
  const err: string[] = []
  const code = runDecisionsRead(args, {
    home: '/home/x',
    exists: candidate => candidate === '/d/owner-decisions.md' || candidate === '/home/x/.construct/owner-decisions.md',
    read: () => text,
    out: line => out.push(line),
    err: line => err.push(line),
  })
  return { code, out, err }
}

describe('owner decisions are a numbered record', () => {
  it('numbers every decision: a list item without D-N is refused, one with D-N is read', () => {
    const numbered = file('- D-1 · 2026-10-08 — #686 stays whole.', '- D-2 · 2026-10-08 ~17:40Z — #705 has priority p0.')
    expect(decisionsRefusals(numbered)).toEqual([])
    expect(parseDecisions(numbered).decisions.map(decision => [decision.number, decision.body])).toEqual([[1, '#686 stays whole.'], [2, '#705 has priority p0.']])

    const unnumbered = file('- D-1 · 2026-10-08 — #686 stays whole.', '- 2026-10-08 — #685: variant A.')
    expect(decisionsRefusals(unnumbered)).toEqual(['[decisions] line 6: a decision without D-N; every decision is - D-N · <date> — <decision> [· superseded-by D-M]'])
    expect(read(unnumbered).code).toBe(1)
    expect(read(unnumbered).out).toEqual([])
  })

  it('numbers every decision once: a D-N on two lines is refused', () => {
    expect(decisionsRefusals(file('- D-1 · 2026-10-08 — one.', '- D-1 · 2026-10-08 — two.'))).toEqual(['[decisions] D-1: on line 5 and line 6; a number names one decision'])
  })

  it('reads only decisions in force: one marked superseded-by D-M is not read', () => {
    const text = file(
      '- D-1 · 2026-10-08 — #705 runs after #697. · superseded-by D-3',
      '- D-2 · 2026-10-08 — #686 stays whole.',
      '- D-3 · 2026-10-08 — #705 runs first, before #697.',
    )
    expect(inForce(parseDecisions(text).decisions).map(decision => decision.number)).toEqual([2, 3])
    const result = read(text)
    expect(result).toEqual({ code: 0, out: ['- D-2 · 2026-10-08 — #686 stays whole.', '- D-3 · 2026-10-08 — #705 runs first, before #697.'], err: [] })
    expect(result.out.join('\n')).not.toContain('after #697')
  })

  it('reads the home decisions file when none is named', () => {
    expect(read(file('- D-1 · 2026-10-08 — one.'), []).out).toEqual(['- D-1 · 2026-10-08 — one.'])
  })

  it('refuses a superseded-by that names no decision in the file, or the decision itself', () => {
    expect(decisionsRefusals(file('- D-1 · 2026-10-08 — one. · superseded-by D-9'))).toEqual(['[decisions] D-1: superseded-by D-9, which is not in the file'])
    expect(decisionsRefusals(file('- D-1 · 2026-10-08 — one. · superseded-by D-1'))).toEqual(['[decisions] D-1: superseded-by itself'])
  })

  it('refuses duplicate decisions in force, and takes them once one supersedes the other', () => {
    const duplicate = file('- D-1 · 2026-10-08 — #686 stays whole.', '- D-2 · 2026-10-08 ~18:00Z — #686  stays whole.')
    expect(decisionsRefusals(duplicate)).toEqual(['[decisions] D-2 repeats D-1, both in force; mark one superseded-by the other'])
    expect(read(duplicate).code).toBe(1)
    expect(decisionsRefusals(file('- D-1 · 2026-10-08 — #686 stays whole. · superseded-by D-2', '- D-2 · 2026-10-08 — #686 stays whole.'))).toEqual([])
  })

  it('refuses decisions in force over the size limit, and counts no superseded one toward it', () => {
    const long = (number: number, superseded = ''): string => `- D-${number} · 2026-10-08 — ${`decision ${number} `.repeat(300)}${superseded}`
    const over = file(long(1), long(2), long(3))
    const refusals = decisionsRefusals(over)
    expect(refusals).toHaveLength(1)
    expect(refusals[0]).toMatch(new RegExp(`^\\[decisions\\] decisions in force: \\d+ bytes over the limit of ${DECISIONS_IN_FORCE_LIMIT}; mark the replaced ones superseded-by D-M$`))
    expect(read(over).code).toBe(1)
    expect(decisionsRefusals(file(long(1, ' · superseded-by D-3'), long(2), long(3)))).toEqual([])
  })

  it('refuses a malformed number: D-01, D-0, D-1.5 and D-1-2 are no D-N', () => {
    for (const number of ['D-01', 'D-0', 'D-1.5', 'D-1-2']) {
      expect(decisionsRefusals(file(`- ${number} · 2026-10-08 — one.`)), number).toEqual([`[decisions] line 5: a decision off the format; every decision is ${DECISION_FORMAT}`])
      expect(read(file(`- ${number} · 2026-10-08 — one.`)).code, number).toBe(1)
    }
  })

  it('refuses a line off the format: no date, an empty body, a non-exact superseded-by, a line outside the list', () => {
    const offFormat = `every decision is ${DECISION_FORMAT}`
    const cases: Record<string, [string, string]> = {
      'no date': ['- D-1 just prose', 'a decision off the format'],
      'no separator': ['- D-1 · 2026-10-08 one.', 'a decision off the format'],
      'empty body': ['- D-1 · 2026-10-08 — ', 'a decision off the format'],
      'superseded-by with a note': ['- D-1 · 2026-10-08 — one. · superseded-by D-2 (owner)', 'a decision off the format'],
      'Superseded-by capitalised': ['- D-1 · 2026-10-08 — one. · Superseded-by D-2', 'a decision off the format'],
      'superseded-by inside the body': ['- D-1 · 2026-10-08 — one, superseded-by D-2 later.', 'a decision off the format'],
    }
    for (const [name, [line, reason]] of Object.entries(cases))
      expect(decisionsRefusals(file(line)), name).toEqual([`[decisions] line 5: ${reason}; ${offFormat}`])

    const outside: Record<string, [string, string]> = {
      'a dated line without a bullet': ['2026-10-09 — three.', 'a decision without D-N'],
      'an ordered item': ['1. three.', 'a decision without D-N'],
      'a D-N without a bullet': ['D-3 · 2026-10-09 — three.', 'a decision off the format'],
      'a heading': ['## Later', 'a decision without D-N'],
    }
    for (const [name, [line, reason]] of Object.entries(outside)) {
      const text = file('- D-1 · 2026-10-08 — one.', '', line, '- D-2 · 2026-10-08 — two.')
      expect(decisionsRefusals(text), name).toEqual([`[decisions] line 7: ${reason}; ${offFormat}`])
      expect(read(text).out, name).toEqual([])
    }
  })

  it('refuses a backward superseded-by: the replacement takes a later number, so no cycle empties the record', () => {
    expect(decisionsRefusals(file('- D-1 · 2026-10-08 — one.', '- D-2 · 2026-10-08 — two. · superseded-by D-1'))).toEqual(['[decisions] D-2: superseded-by D-1, an earlier number; the replacement takes a new, later number'])
    const cycle = file('- D-1 · 2026-10-08 — one. · superseded-by D-2', '- D-2 · 2026-10-08 — two. · superseded-by D-1')
    expect(decisionsRefusals(cycle)).toEqual(['[decisions] D-2: superseded-by D-1, an earlier number; the replacement takes a new, later number'])
    expect(read(cycle).code).toBe(1)
  })

  it('refuses numbers out of order: they run 1..n in file order', () => {
    expect(decisionsRefusals(file('- D-1 · 2026-10-08 — one.', '- D-3 · 2026-10-08 — three.'))).toEqual(['[decisions] D-3 on line 6: expected D-2; numbers run 1..n in file order'])
    expect(decisionsRefusals(file('- D-2 · 2026-10-08 — two.', '- D-1 · 2026-10-08 — one.'))).toEqual([
      '[decisions] D-2 on line 5: expected D-1; numbers run 1..n in file order',
      '[decisions] D-1 on line 6: expected D-3; numbers run 1..n in file order',
    ])
    expect(read(file('- D-1 · 2026-10-08 — one.', '- D-3 · 2026-10-08 — three.')).code).toBe(1)
  })

  it('refuses a missing file and a flag', () => {
    expect(read('', ['/nowhere.md']).err).toEqual(['[decisions] no decisions at /nowhere.md'])
    expect(read('', ['--all']).code).toBe(2)
  })
})
