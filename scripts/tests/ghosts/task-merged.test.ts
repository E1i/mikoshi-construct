import { describe, expect, it } from 'vitest'
import { mergedDetails, mergedSummary, recheckArgument, recheckMerge, recheckSummary, recordMerges } from '../../ghosts/task-merged.js'

const NOW = new Date('2026-10-05T09:00:00.000Z')
const BODY = (id: number): string => `#${id} some-task [implement/runner/S/cheap/auto] · depends — · blocks —\n\nbody`
const CLOSING = [
  { event: 'path', task: 'ghost-name', path: 'ladder', pr: 700, verification: 'run' },
  { event: 'path', task: '574', path: 'ladder', pr: 701, verification: 'run' },
  { event: 'path', task: '580', path: 'cheap', report: '/tmp/r.md', verification: 'report' },
].map(line => `${JSON.stringify(line)}\n`).join('')

function view(state: 'MERGED' | 'OPEN', id: number): string {
  return JSON.stringify({ state, mergedAt: state === 'MERGED' ? '2026-10-05T08:30:00Z' : null, mergedBy: state === 'MERGED' ? { login: 'E1i' } : null, mergeCommit: state === 'MERGED' ? { oid: 'c0ffee' } : null, body: BODY(id) })
}

function sweep(journalText: string, states: Record<number, 'MERGED' | 'OPEN'>, cardOf: Record<number, number>): { journal: string, calls: string[][], notes: string[] } {
  let journal = journalText
  const calls: string[][] = []
  const gh = (args: string[]): string => {
    calls.push(args)
    const number = Number(args[2])
    return view(states[number]!, cardOf[number]!)
  }
  const { notes } = recordMerges({ gh, journal: '/j', readJournal: () => journal, append: (_file, text) => {
    journal += text
  }, now: () => NOW })
  return { journal, calls, notes }
}

function mergeLines(journal: string): Record<string, unknown>[] {
  return journal.split('\n').filter(line => line !== '').map(line => JSON.parse(line) as Record<string, unknown>).filter(line => line.event === 'merge')
}

describe('recordMerges', () => {
  it('writes one merge line keyed by the card of the pull request body, none for an open one, and nothing on a second run', () => {
    const first = sweep(CLOSING, { 700: 'MERGED', 701: 'OPEN' }, { 700: 570, 701: 574 })
    expect(mergeLines(first.journal)).toEqual([{ event: 'merge', task: '570', pr: 700, by: 'E1i', commit: 'c0ffee', merged: '2026-10-05T08:30:00Z', ts: NOW.toISOString() }])
    expect(first.calls.map(args => args.slice(0, 5))).toEqual([['pr', 'view', '700', '-R', 'E1i/mikoshi-construct'], ['pr', 'view', '701', '-R', 'E1i/mikoshi-construct']])
    const second = sweep(first.journal, { 700: 'MERGED', 701: 'OPEN' }, { 700: 570, 701: 574 })
    expect(mergeLines(second.journal)).toHaveLength(1)
    expect(second.calls.map(args => args[2])).toEqual(['701'])
  })

  it('records a pull request without a card or closed without merge as a merge-skip line, asked of gh once', () => {
    let journal = CLOSING
    const calls: string[] = []
    const gh = (args: string[]): string => {
      calls.push(args[2]!)
      return JSON.stringify(args[2] === '700'
        ? { state: 'MERGED', mergedAt: '2026-10-05T08:30:00Z', mergedBy: { login: 'E1i' }, mergeCommit: { oid: 'c0ffee' }, body: 'not a card' }
        : { state: 'CLOSED', mergedAt: null, mergedBy: null, mergeCommit: null, body: null })
    }
    const deps = { gh, journal: '/j', readJournal: () => journal, append: (_file: string, text: string) => {
      journal += text
    }, now: () => NOW }
    const result = recordMerges(deps)
    expect(result.notes).toEqual([])
    expect(mergedSummary(result)).toBe('merged: 0 new · 1 PR without a card skipped · 1 PR closed without merge skipped')
    expect(mergedDetails(result)[1]).toBe('PR #701 closed without merge')
    expect(journal.split('\n').filter(line => line.includes('merge-skip')).map(line => JSON.parse(line) as unknown)).toEqual([
      { event: 'merge-skip', pr: 700, skip: 'no-card', ts: NOW.toISOString() },
      { event: 'merge-skip', pr: 701, skip: 'closed', ts: NOW.toISOString() },
    ])
    const again = recordMerges(deps)
    expect(calls).toEqual(['700', '701'])
    expect(mergedSummary(again)).toBeNull()
  })

  it('notes a pull request whose lookup throws, and goes on', () => {
    let journal = CLOSING
    const gh = (args: string[]): string => {
      if (args[2] === '700')
        throw new Error('gh down')
      return view('MERGED', 574)
    }
    const result = recordMerges({ gh, journal: '/j', readJournal: () => journal, append: (_file, text) => {
      journal += text
    }, now: () => NOW })
    expect(result.notes).toEqual(['PR #700 not read: gh down'])
    expect(mergeLines(journal).map(line => line.pr)).toEqual([701])
    expect(mergedSummary(result)).toBe('merged: 1 new · 1 PR not read')
  })
})

describe('recheckMerge', () => {
  const SKIPPED = `${CLOSING}${JSON.stringify({ event: 'merge-skip', pr: 700, skip: 'no-card', ts: 'x' })}\n`
  const merged = (body: string): string => JSON.stringify({ state: 'MERGED', mergedAt: '2026-10-05T08:30:00Z', mergedBy: { login: 'E1i' }, mergeCommit: { oid: 'c0ffee' }, body })

  function run(journalText: string, body: string, recheck: boolean): { journal: string, calls: number, notes: string[], written: number } {
    let journal = journalText
    let calls = 0
    const deps = { gh: () => {
      calls++
      return merged(body)
    }, journal: '/j', readJournal: () => journal, append: (_file: string, text: string) => {
      journal += text
    }, now: () => NOW }
    const result = recheck ? recheckMerge(deps, 700) : recordMerges(deps)
    return { journal, calls, notes: result.notes, written: result.written.length }
  }

  it('writes the merge line of a skipped no-card pull request whose body now opens with the card line', () => {
    const otherMerged = `${JSON.stringify({ event: 'merge', task: '574', pr: 701, by: 'E1i', commit: 'beef', merged: 'x', ts: 'x' })}\n`
    const rechecked = run(`${SKIPPED}${otherMerged}`, BODY(581), true)
    expect(mergeLines(rechecked.journal).filter(line => line.pr === 700)).toEqual([{ event: 'merge', task: '581', pr: 700, by: 'E1i', commit: 'c0ffee', merged: '2026-10-05T08:30:00Z', ts: NOW.toISOString() }])
  })

  it('writes no merge line for the skipped pull request without --recheck, and asks gh only about the unrecorded one', () => {
    const plain = run(SKIPPED, BODY(581), false)
    expect(plain.calls).toBe(1)
    expect(mergeLines(plain.journal).filter(line => line.pr === 700)).toEqual([])
  })

  it('refuses a pull request with no merge-skip no-card line, without asking gh', () => {
    const result = run(CLOSING, BODY(581), true)
    expect(result.calls).toBe(0)
    expect(result.notes).toEqual([expect.stringContaining('has no merge-skip line with skip no-card')])
    expect(result.journal).toBe(CLOSING)
  })

  it('refuses a pull request that still has no card line, writing nothing', () => {
    const result = run(SKIPPED, 'not a card', true)
    expect(result.notes).toEqual([expect.stringContaining('still without a card')])
    expect(result.journal).toBe(SKIPPED)
  })

  it('refuses a second recheck once the merge line is written', () => {
    const first = run(SKIPPED, BODY(581), true)
    const second = run(first.journal, BODY(581), true)
    expect(second.notes).toEqual([expect.stringContaining('already has a merge line')])
    expect(mergeLines(second.journal)).toHaveLength(1)
  })

  it('refuses a pull request that is still open, writing nothing', () => {
    let journal = SKIPPED
    const result = recheckMerge({ gh: () => JSON.stringify({ state: 'OPEN', mergedAt: null, mergedBy: null, mergeCommit: null, body: BODY(581) }), journal: '/j', readJournal: () => journal, append: (_file, text) => {
      journal += text
    }, now: () => NOW }, 700)
    expect(result.notes).toEqual(['PR #700 is open; nothing written'])
    expect(journal).toBe(SKIPPED)
  })

  function rechecked(body: string): ReturnType<typeof recheckMerge> {
    let journal = SKIPPED
    return recheckMerge({ gh: () => merged(body), journal: '/j', readJournal: () => journal, append: (_file, text) => {
      journal += text
    }, now: () => NOW }, 700)
  }

  it('prints the reason of a refused recheck, not a count of PRs not read', () => {
    expect(recheckSummary(rechecked('not a card'))).toEqual([expect.stringContaining('still without a card')])
  })

  it('prints one new merge for a recheck that wrote its line', () => {
    expect(recheckSummary(rechecked(BODY(581)))).toEqual(['merged: 1 new'])
  })

  it.each([
    [['--recheck', '700'], 700],
    [[], null],
    [['--recheck'], 'invalid'],
    [['--recheck', 'x'], 'invalid'],
    [['--recheck', '0'], 'invalid'],
    [['--recheck=700'], 'invalid'],
  ] as const)('reads the --recheck argument %j as %s', (argv, expected) => {
    expect(recheckArgument(argv)).toBe(expected)
  })

  it('refuses a pull request whose only skip line is closed, writing nothing', () => {
    const closed = `${CLOSING}${JSON.stringify({ event: 'merge-skip', pr: 700, skip: 'closed', ts: 'x' })}\n`
    const result = run(closed, BODY(581), true)
    expect(result.calls).toBe(0)
    expect(result.notes).toEqual([expect.stringContaining('has no merge-skip line with skip no-card')])
    expect(result.journal).toBe(closed)
  })
})
