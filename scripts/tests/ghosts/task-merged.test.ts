import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../bus/db.js'
import { prClosed } from '../../bus/observations.js'
import { busMerges, mergedDetails, mergedSummary, recordMerges } from '../../ghosts/task-merged.js'

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

  it('keys the merge line by the card of a body whose first line starts with card: ', () => {
    let journal = CLOSING
    const gh = (args: string[]): string => args[2] === '700'
      ? JSON.stringify({ state: 'MERGED', mergedAt: '2026-10-05T08:30:00Z', mergedBy: { login: 'E1i' }, mergeCommit: { oid: 'c0ffee' }, body: `card: ${BODY(667)}` })
      : view('OPEN', 574)
    recordMerges({ gh, journal: '/j', readJournal: () => journal, append: (_file, text) => {
      journal += text
    }, now: () => NOW })
    expect(mergeLines(journal).map(line => [line.task, line.pr])).toEqual([['667', 700]])
  })

  it('task:merged after the cutoff writes no merge line', () => {
    let journal = CLOSING
    const deps = { gh: (args: string[]): string => args[2] === '701' ? JSON.stringify({ state: 'CLOSED', mergedAt: null, mergedBy: null, mergeCommit: null, body: null }) : view('MERGED', 570), journal: '/j', readJournal: () => journal, append: (_file: string, text: string) => {
      journal += text
    }, now: () => new Date('2026-10-13T18:00:00.000Z') }
    const result = recordMerges(deps)
    expect(mergeLines(journal)).toEqual([])
    expect(result.notInBus).toEqual([700])
    expect(result.skipped.map(line => [line.pr, line.skip])).toEqual([[701, 'closed']])
    expect(mergedSummary(result)).toBe('merged: 0 new · 1 PR closed without merge skipped · 1 PR merged with no merged pr.closed in the bus yet, nothing written')
    expect(mergedDetails(result)).toEqual(['PR #701 closed without merge', 'PR #700 merged; no merged pr.closed in the bus yet, and from 2026-10-12T17:04:00.000Z no merge line is written'])
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

describe('the merge fact in the bus', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0))
      rmSync(root, { recursive: true, force: true })
  })

  function busWith(closings: { ts: string, pr: number, cardId: number | null, merged: boolean, legacy?: boolean }[]): string {
    const root = mkdtempSync(path.join(tmpdir(), 'task-merged-bus-'))
    roots.push(root)
    const file = path.join(root, 'bus.db')
    const db = openBus(file)
    for (const closing of closings) {
      const event = prClosed(closing.ts, { pr: closing.pr, cardId: closing.cardId, merged: closing.merged, commit: closing.merged ? 'c0ffee' : null, mergedBy: closing.merged ? 'E1i' : null, mergedAt: closing.merged ? '2026-10-13T08:30:00Z' : null })
      appendEvent(db, closing.legacy === true ? { ...event, actor: null, legacy: true } : event)
    }
    db.close()
    return file
  }

  function sweepWithBus(bus: string, journalText: string): { journal: string, calls: string[], notes: string[] } {
    let journal = journalText
    const calls: string[] = []
    const deps = { gh: (args: string[]): string => {
      calls.push(args[2]!)
      return view('MERGED', 570)
    }, journal: '/j', readJournal: () => journal, append: (_file: string, text: string) => {
      journal += text
    }, now: () => NOW, mergedInBus: new Set(busMerges(bus).map(merge => merge.pr)) }
    const { notes } = recordMerges(deps)
    return { journal, calls, notes }
  }

  it('a pull request whose merge pr.closed holds is not looked up and gets no merge line', () => {
    const bus = busWith([
      { ts: '2026-10-13T08:31:00.000Z', pr: 700, cardId: 570, merged: true },
      { ts: '2026-10-13T08:32:00.000Z', pr: 701, cardId: 574, merged: false },
    ])
    expect(busMerges(bus)).toEqual([{ task: '570', pr: 700, by: 'E1i', commit: 'c0ffee', merged: '2026-10-13T08:30:00Z', event: 1 }])
    const swept = sweepWithBus(bus, CLOSING)
    expect(swept.calls).toEqual(['701'])
    expect(mergeLines(swept.journal).map(line => line.pr)).toEqual([701])
  })

  it('a pr.closed written before the cutoff leaves the pull request to the journal', () => {
    const bus = busWith([
      { ts: '2026-10-12T17:03:59.999Z', pr: 700, cardId: 570, merged: true },
      { ts: '2026-10-13T08:31:00.000Z', pr: 702, cardId: null, merged: true },
    ])
    expect(busMerges(bus)).toEqual([])
    const swept = sweepWithBus(bus, CLOSING)
    expect(swept.calls).toEqual(['700', '701'])
    expect(mergeLines(swept.journal).map(line => line.pr)).toEqual([700, 701])
  })

  it('reads no merge fact from a bus that does not exist', () => {
    expect(busMerges(path.join(tmpdir(), 'no-such-dir-934', 'bus.db'))).toEqual([])
  })

  it('holds a merged pr.closed written at the very instant the journal half of history ends, and leaves out a legacy one', () => {
    const bus = busWith([
      { ts: '2026-10-12T17:04:00.000Z', pr: 700, cardId: 570, merged: true },
      { ts: '2026-10-13T08:31:00.000Z', pr: 701, cardId: 574, merged: true, legacy: true },
    ])
    expect(busMerges(bus).map(merge => merge.pr)).toEqual([700])
    const swept = sweepWithBus(bus, CLOSING)
    expect(swept.calls).toEqual(['701'])
  })
})
