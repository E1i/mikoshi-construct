import { describe, expect, it } from 'vitest'
import { DECISION_FORMAT, DECISIONS_IN_FORCE_LIMIT, decisionsRefusals, inForce, parseDecisions, spendDecisions } from '../../decisions/decisions.js'
import { runDecisionsRead } from '../../decisions/read.js'

const HEADER = '# Owner decisions\n\nOne line per decision, numbered D-N; a replaced one is marked superseded-by D-M.\n\n'

function file(...lines: string[]): string {
  return `${HEADER}${lines.join('\n')}\n`
}

const JOURNAL = '/h/ghosts.jsonl'

function read(text: string, args: string[] = ['/d/owner-decisions.md'], journal: string | null = null): { code: number, out: string[], err: string[], written: Record<string, string> } {
  const out: string[] = []
  const err: string[] = []
  const written: Record<string, string> = {}
  const code = runDecisionsRead(args, {
    home: '/home/x',
    journal: JOURNAL,
    exists: candidate => candidate === '/d/owner-decisions.md' || candidate === '/home/x/.construct/owner-decisions.md' || (candidate === JOURNAL && journal !== null),
    read: candidate => candidate === JOURNAL ? journal! : text,
    write: (candidate, content) => {
      written[candidate] = content
    },
    out: line => out.push(line),
    err: line => err.push(line),
  })
  return { code, out, err, written }
}

function journal(...entries: object[]): string {
  return entries.map(entry => `${JSON.stringify(entry)}\n`).join('')
}

function upToSpending(...lines: string[]): string {
  const filler = Array.from({ length: 53 }, (_, index) => `- D-${index + 1} · 2026-10-08 — decision ${index + 1}.`)
  return file(...filler, '- D-54 · 2026-10-09 — A decision bound to a card is spent once that card is merged or closed.', ...lines)
}

describe('owner decisions are a numbered record', () => {
  it('numbers every decision: a list item without D-N is refused, one with D-N is read', () => {
    const numbered = file('- D-1 · 2026-10-08 — #686 stays whole.', '- D-2 · 2026-10-08 ~17:40Z — #705 has priority p0.')
    expect(decisionsRefusals(numbered)).toEqual([])
    expect(parseDecisions(numbered).decisions.map(decision => [decision.number, decision.body])).toEqual([[1, '#686 stays whole.'], [2, '#705 has priority p0.']])

    const unnumbered = file('- D-1 · 2026-10-08 — #686 stays whole.', '- 2026-10-08 — #685: variant A.')
    expect(decisionsRefusals(unnumbered)).toEqual([`[decisions] line 6: a decision without D-N; every decision is ${DECISION_FORMAT}`])
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
    expect(result).toEqual({ code: 0, written: {}, out: ['- D-2 · 2026-10-08 — #686 stays whole.', '- D-3 · 2026-10-08 — #705 runs first, before #697.'], err: [] })
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

  it('a decision line without the decisions:add marker is refused', () => {
    const written = '- D-2 · 2026-10-09 ~09:12Z — [owner] two. · decisions:add'
    expect(decisionsRefusals(file('- D-1 · 2026-10-08 — one, before the writer.', written))).toEqual([])
    const handAppended = file('- D-1 · 2026-10-08 — one.', written, '- D-3 · 2026-10-09 — three, by hand.')
    expect(decisionsRefusals(handAppended)).toEqual(['[decisions] D-3 on line 7: no decisions:add marker after D-2, which has one; append a decision with pnpm decisions:add'])
    expect(read(handAppended)).toMatchObject({ code: 1, out: [] })
    expect(decisionsRefusals(file('- D-1 · 2026-10-08 — one. · card #7 · decisions:add · superseded-by D-2', '- D-2 · 2026-10-09 — two. · decisions:add'))).toEqual([])
  })

  it('takes the numbers the archive holds as taken, and refuses one in both', () => {
    const archive = file('- D-1 · 2026-10-08 — one. · superseded-by D-3')
    expect(decisionsRefusals(file('- D-2 · 2026-10-08 — two.', '- D-3 · 2026-10-08 — three.'), archive)).toEqual([])
    expect(decisionsRefusals(file('- D-2 · 2026-10-08 — two.', '- D-3 · 2026-10-08 — three.'))).toEqual(['[decisions] D-2 on line 5: expected D-1; numbers run 1..n in file order'])
    expect(decisionsRefusals(file('- D-1 · 2026-10-08 — one.', '- D-2 · 2026-10-08 — two.'), archive)).toEqual(['[decisions] D-1: on line 5 and in the archive; a number names one decision'])
  })

  it('refuses a missing file and a flag', () => {
    expect(read('', ['/nowhere.md']).err).toEqual(['[decisions] no decisions at /nowhere.md'])
    expect(read('', ['--all']).code).toBe(2)
  })
})

describe('a decision bound to a card is spent once the card is merged or closed', () => {
  it('names the card tail in the format, before superseded-by', () => {
    expect(DECISION_FORMAT).toBe('- D-N · <date> — <decision> [· card #A #B] [· decisions:add] [· superseded-by D-M]')
    const text = file('- D-1 · 2026-10-08 — one. · card #686 #687', '- D-2 · 2026-10-08 — two. · card #5 · superseded-by D-3', '- D-3 · 2026-10-08 — three.')
    expect(decisionsRefusals(text)).toEqual([])
    expect(parseDecisions(text).decisions.map(decision => [decision.body, decision.cards, decision.supersededBy])).toEqual([['one.', [686, 687], null], ['two.', [5], 3], ['three.', [], null]])
  })

  it('marks a decision whose card has a merge line superseded-by D-54, and writes the file', () => {
    const text = upToSpending('- D-55 · 2026-10-09 — #730 runs on lane-1. · card #730')
    const result = read(text, undefined, journal({ event: 'merge', task: '730', pr: 674, by: 'E1i', commit: 'abc', ts: '2026-10-09T06:00:00Z' }))
    expect(result.code).toBe(0)
    expect(result.out).not.toContain('- D-55 · 2026-10-09 — #730 runs on lane-1. · card #730')
    expect(result.written['/d/owner-decisions.md']).toBe(text.replace('· card #730', '· card #730 · superseded-by D-54'))
    expect(decisionsRefusals(result.written['/d/owner-decisions.md']!)).toEqual([])
  })

  it('marks a decision whose card is closed by a path line with a report or a verification', () => {
    const text = upToSpending('- D-55 · 2026-10-09 — probe one. · card #728', '- D-56 · 2026-10-09 — fix two. · card #729')
    const result = read(text, undefined, journal(
      { event: 'path', task: '728', path: 'cheap', report: '/r/report.md', verification: 'run', ts: '2026-10-09T06:00:00Z' },
      { event: 'path', task: '729', path: 'ladder', pr: 1, verification: 'review', ts: '2026-10-09T06:00:00Z' },
    ))
    expect(result.written['/d/owner-decisions.md']).toContain('probe one. · card #728 · superseded-by D-54')
    expect(result.written['/d/owner-decisions.md']).toContain('fix two. · card #729 · superseded-by D-54')
  })

  it('keeps in force a line with no card tail that names a merged card, and one whose tail holds an unmerged card', () => {
    const text = upToSpending('- D-55 · 2026-10-09 — #730 runs on lane-1.', '- D-56 · 2026-10-09 — two cards. · card #730 #731')
    const result = read(text, undefined, journal(
      { event: 'merge', task: '730', pr: 674, by: 'E1i', commit: 'abc', ts: '2026-10-09T06:00:00Z' },
      { event: 'path', task: '731', path: 'cheap', started: '2026-10-09T05:00:00Z', ts: '2026-10-09T05:00:00Z' },
    ))
    expect(result.code).toBe(0)
    expect(result.written).toEqual({})
    expect(result.out).toContain('- D-55 · 2026-10-09 — #730 runs on lane-1.')
    expect(result.out).toContain('- D-56 · 2026-10-09 — two cards. · card #730 #731')
  })

  it('spends before the size check, so a file over the limit only by spent decisions is read', () => {
    const long = `${'decision '.repeat(1000)}`
    const text = upToSpending(`- D-55 · 2026-10-09 — ${long} · card #730`)
    expect(decisionsRefusals(text)).toHaveLength(1)
    const result = read(text, undefined, journal({ event: 'merge', task: '730', by: 'E1i', commit: 'abc', ts: '2026-10-09T06:00:00Z' }))
    expect(result.err).toEqual([])
    expect(result.code).toBe(0)
  })

  it('touches nothing without a journal or without D-54 in the file', () => {
    expect(read(upToSpending('- D-55 · 2026-10-09 — x. · card #730')).written).toEqual({})
    expect(spendDecisions(file('- D-1 · 2026-10-08 — x. · card #730'), () => true)).toBe(file('- D-1 · 2026-10-08 — x. · card #730'))
  })
})
