import type { ParkedTask } from '../../shift/parking.js'
import { describe, expect, it } from 'vitest'
import { choose, parseParkingFile } from '../../shift/parking.js'

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

describe('choose', () => {
  it('takes the cards for the shift, p0 first and then by id, and names why every other card is left', () => {
    const cards = [
      parked(99, 'who: shift'),
      parked(19, 'who: shift'),
      parked(189, 'who: shift\npriority: p0'),
      parked(187, 'who: shift\npriority: p0'),
      parked(171, 'who: window'),
      parked(180, 'who: shift', '#179'),
      parked(178, 'who: shift'),
    ]
    const choice = choose(cards, new Set(['178']))
    expect(choice.chosen.map(task => task.id)).toEqual(['187', '189', '19', '99'])
    expect(choice.left).toEqual([
      { id: '171', reason: 'who window' },
      { id: '178', reason: 'closed' },
      { id: '180', reason: 'depends #179 not closed' },
    ])
  })

  it('takes a card whose depends are all closed', () => {
    expect(choose([parked(180, 'who: shift', '#179')], new Set(['179'])).chosen.map(task => task.id)).toEqual(['180'])
  })

  it('leaves a card that conflicts with one already taken, and keeps the one taken first', () => {
    const first = parked(1, 'who: shift')
    const second = parked(2, 'who: shift')
    const overlapping = { ...second, task: { ...second.task, touches: ['scripts/1/x.ts'] } }
    expect(choose([overlapping, first], new Set())).toEqual({ chosen: [first.task], left: [{ id: '2', reason: 'conflicts with #1' }] })
  })
})
