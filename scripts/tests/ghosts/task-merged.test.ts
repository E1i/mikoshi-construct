import { describe, expect, it } from 'vitest'
import { recordMerges } from '../../ghosts/task-merged.js'

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

  it('notes a pull request whose body is no card or whose lookup throws, and goes on', () => {
    let journal = CLOSING
    const gh = (args: string[]): string => {
      if (args[2] === '700')
        throw new Error('gh down')
      return JSON.stringify({ state: 'MERGED', mergedAt: '2026-10-05T08:30:00Z', mergedBy: { login: 'E1i' }, mergeCommit: { oid: 'c0ffee' }, body: 'not a card' })
    }
    const { written, notes } = recordMerges({ gh, journal: '/j', readJournal: () => journal, append: (_file, text) => {
      journal += text
    }, now: () => NOW })
    expect(written).toEqual([])
    expect(notes).toHaveLength(2)
    expect(notes[0]).toContain('700')
    expect(notes[1]).toContain('701')
    expect(mergeLines(journal)).toEqual([])
  })
})
