import { describe, expect, it } from 'vitest'
import { closedTasks } from '../../src/card/closed.js'

describe('closedTasks', () => {
  it('a start line does not close, a closing path line with a verification does, and a line that is not JSON is skipped', () => {
    const journal = [
      JSON.stringify({ event: 'path', task: '77', path: 'cheap', verification: 'run' }),
      JSON.stringify({ event: 'start', task: '78' }),
      JSON.stringify({ event: 'path', task: '79', path: 'cheap' }),
      'not json',
      'null',
    ].join('\n')
    expect([...closedTasks(journal)]).toEqual([['77', 'run']])
    expect(closedTasks(null).size).toBe(0)
  })
})
