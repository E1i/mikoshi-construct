import type { ParkedTask } from '../../src/card/parking.js'
import { describe, expect, it } from 'vitest'
import { declaredGhostsFile } from '../../scripts/shredder/reader.js'
import { parkingFileText, parseCreatesEntry, parseParkingFile } from '../../src/card/parking.js'
import { checkDraft } from '../../src/commands/intake/check.js'
import { parseDraft } from '../../src/commands/intake/draft.js'

function parked(id: number, header: string, extra = ''): ParkedTask {
  const parsed = parseParkingFile(`${id}.md`, `card: #${id} task-${id} [implement/ghosts/S/cheap/owner] · depends ${extra || '—'} · blocks —\nbranch: feat/${id}\ntouches: scripts/${id}/**\n${header}\n\ndo ${id}\n`)
  if (parsed.kind === 'refused')
    throw new Error(parsed.reason)
  return parsed.parked
}

describe('parseParkingFile', () => {
  it('reads who and priority beside the task file header and keeps the task as the shift reads it', () => {
    const card = parked(187, 'who: shift\npriority: p0')
    expect(card).toMatchObject({ who: 'shift', priority: 'p0', task: { file: '187.md', id: '187', branch: 'feat/187', touches: ['scripts/187/**'], body: 'do 187', continue: 'stop' } })
  })

  it('reads a card without priority as null', () => {
    expect(parked(19, 'who: window').priority).toBeNull()
  })

  it.each([
    ['no who', 'card: #5 a [implement/ghosts/S/cheap/owner] · depends — · blocks —\nbranch: b\ntouches: a\n\nbody', `5.md: a parked card names who takes it: 'who: shift' or the column's other value`],
    ['a priority other than p0', 'card: #5 a [implement/ghosts/S/cheap/owner] · depends — · blocks —\nbranch: b\ntouches: a\nwho: shift\npriority: high\n\nbody', `5.md: priority 'high' is not one of p0`],
    ['a repeated who', 'card: #5 a [implement/ghosts/S/cheap/owner] · depends — · blocks —\nbranch: b\ntouches: a\nwho: shift\nwho: window\n\nbody', `5.md: header key 'who' appears twice`],
    ['a file not named after the card', 'card: #6 a [implement/ghosts/S/cheap/owner] · depends — · blocks —\nbranch: b\ntouches: a\nwho: shift\n\nbody', '5.md: a parked card\'s file is named after its id: 6.md'],
    ['a refused task header', 'branch: b\ntouches: a\nwho: shift\n\nbody', '5.md: header is missing card; a parked card also takes who, priority'],
  ])('refuses %s', (_, text, reason) => {
    expect(parseParkingFile('5.md', text)).toEqual({ kind: 'refused', reason })
  })

  it('reads who: only in the header, never from the body', () => {
    const parsed = parseParkingFile('5.md', 'card: #5 a [implement/ghosts/S/cheap/owner] · depends — · blocks —\nbranch: b\ntouches: a\nwho: shift\n\nwho: window\n')
    expect(parsed).toMatchObject({ kind: 'parked', parked: { who: 'shift', task: { body: 'who: window' } } })
  })
})

describe('parkingFileText', () => {
  it('writes a file parseParkingFile reads back field for field', () => {
    const text = parkingFileText({ card: '#12 a [implement/ghosts/S/cheap/owner] · depends — · blocks —', branch: 'feat/a', touches: ['src/**', 'tests/**'], continue: 'auto', who: 'window', body: '\nDo a.\n\nWitnesses:\n- one\n' })
    expect(parseParkingFile('12.md', text)).toMatchObject({ kind: 'parked', parked: { who: 'window', priority: null, task: { id: '12', branch: 'feat/a', touches: ['src/**', 'tests/**'], continue: 'auto', body: 'Do a.\n\nWitnesses:\n- one' } } })
  })
})

describe('parseCreatesEntry', () => {
  it.each([
    ['a bare path', 'src/a.ts', { kind: 'created', path: 'src/a.ts', fileKind: null }],
    ['a path with its kind', 'scripts/ghosts/a.ts (plain)', { kind: 'created', path: 'scripts/ghosts/a.ts', fileKind: 'plain' }],
    ['a kind outside the list', 'scripts/ghosts/a.ts (bogus)', { kind: 'refused', reason: `creates entry 'scripts/ghosts/a.ts (bogus)' names kind 'bogus', not one of ghosts, plain` }],
    ['trailing words', 'scripts/ghosts/a.ts (plain) too', { kind: 'refused', reason: `creates entry 'scripts/ghosts/a.ts (plain) too' is '<path>' or '<path> (<kind>)', the kind one of ghosts, plain` }],
  ])('reads %s', (_, entry, parsed) => {
    expect(parseCreatesEntry(entry)).toEqual(parsed)
  })
})

describe('one creates parse for the shift guard and intake', () => {
  const FRESH = 'scripts/ghosts/worktree-home.ts'

  function intakeAccepts(entry: string): boolean {
    const draft = parseDraft(JSON.stringify({ cards: [{ name: 'fresh', kind: 'implement', milestone: 'ghosts', size: 'S', touches: [FRESH], creates: [entry], task: 'Do it.', witnesses: ['`true` passes'] }] }))
    if (draft.kind === 'refused')
      return false
    const repository = { exists: () => false, pathsNamed: () => [], commandResolves: () => true }
    const [checked] = checkDraft(draft.cards, [1], { taken: new Set(), parked: new Set(), done: new Set(), merged: new Set(), repository })
    return checked!.unclear.length === 0
  }

  it.each([
    [`${FRESH} (plain)`, true],
    [`${FRESH} (ghosts)`, true],
    [`${FRESH} (bogus)`, false],
    [`${FRESH} (plain) too`, false],
  ])('one creates line is accepted or refused alike by the shift guard and by intake: %s', (entry, accepted) => {
    expect(declaredGhostsFile(entry) !== null).toBe(accepted)
    expect(intakeAccepts(entry)).toBe(accepted)
  })
})
