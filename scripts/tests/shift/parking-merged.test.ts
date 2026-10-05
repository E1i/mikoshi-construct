import type { ParkedTask } from '../../../src/card/parking.js'
import { describe, expect, it } from 'vitest'
import { mergedTasks } from '../../../src/card/closed.js'
import { parseParkingFile } from '../../../src/card/parking.js'
import { choose } from '../../shift/parking.js'

function parked(id: number, depends: string): ParkedTask {
  const parsed = parseParkingFile(`${id}.md`, `card: #${id} task-${id} [implement/ghosts/S/cheap/owner] · depends ${depends} · blocks —\nbranch: feat/${id}\ntouches: scripts/${id}/**\nwho: shift\n\ndo ${id}\n`)
  if (parsed.kind === 'refused')
    throw new Error(parsed.reason)
  return parsed.parked
}

describe('choose reads a depends as met only when it is merged', () => {
  it('leaves a card whose depends is done but not merged and takes it after a merge line', () => {
    const card = parked(180, '#179')
    const done = new Set(['179'])
    expect(choose([card], done, new Set())).toEqual({ chosen: [], left: [{ id: '180', reason: 'depends #179 not merged' }] })
    expect(choose([card], done, new Set(['179'])).chosen.map(task => task.id)).toEqual(['180'])
  })

  it('counts a probe closed by report as merged', () => {
    const journal = `${JSON.stringify({ event: 'path', task: '30', path: 'cheap', report: '/tmp/r.md', verification: 'report' })}\n`
    const merged = mergedTasks(journal)
    expect(choose([parked(31, '#30')], new Set(['30']), merged).chosen.map(task => task.id)).toEqual(['31'])
  })

  it('still names a done card closed and names every unmerged depends', () => {
    expect(choose([parked(5, '—')], new Set(['5']), new Set()).left).toEqual([{ id: '5', reason: 'closed' }])
    expect(choose([parked(8, '#10 #11')], new Set(['10']), new Set(['10'])).left).toEqual([{ id: '8', reason: 'depends #11 not merged' }])
  })
})
