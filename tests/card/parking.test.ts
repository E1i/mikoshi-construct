import type { ParkedTask } from '../../src/card/parking.js'
import { describe, expect, it } from 'vitest'
import { parkingFileText, parseParkingFile } from '../../src/card/parking.js'

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
