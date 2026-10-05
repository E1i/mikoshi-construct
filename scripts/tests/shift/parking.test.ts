import type { ParkedTask } from '../../../src/card/parking.js'
import { describe, expect, it } from 'vitest'
import { parseParkingFile } from '../../../src/card/parking.js'
import { choose, leftSummary, queueText } from '../../shift/parking.js'

function parked(id: number, header: string, extra = ''): ParkedTask {
  const parsed = parseParkingFile(`${id}.md`, `card: #${id} task-${id} [implement/ghosts/S/cheap/owner] · depends ${extra || '—'} · blocks —\nbranch: feat/${id}\ntouches: scripts/${id}/**\n${header}\n\ndo ${id}\n`)
  if (parsed.kind === 'refused')
    throw new Error(parsed.reason)
  return parsed.parked
}

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

  it('names a closed card closed, whoever it was parked for', () => {
    expect(choose([parked(542, 'who: window')], new Set(['542'])).left).toEqual([{ id: '542', reason: 'closed' }])
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

describe('leftSummary', () => {
  it('counts the cards left by reason, the largest first, keeping who apart and folding the ids of depends and conflicts', () => {
    const left = [
      { id: '1', reason: 'who window' },
      { id: '2', reason: 'closed' },
      { id: '3', reason: 'closed' },
      { id: '4', reason: 'depends #9 not closed' },
      { id: '5', reason: 'conflicts with #7' },
      { id: '6', reason: 'who owner' },
      { id: '8', reason: 'depends #10, #11 not closed' },
    ]
    expect(leftSummary(left)).toBe('left: 2 closed · 2 depends · 1 who window · 1 conflicts · 1 who owner')
  })

  it('says none when nothing is left', () => {
    expect(leftSummary([])).toBe('left: none')
  })

  it('writes the queue as one leaves line per card, closed ones included', () => {
    expect(queueText([{ id: '1', reason: 'closed' }, { id: '2', reason: 'who window' }])).toBe('leaves #1 (closed)\nleaves #2 (who window)\n')
  })
})
