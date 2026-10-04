import { describe, expect, it } from 'vitest'
import { ENTRY_RESULT, entryLine, entryOf } from '../../ghosts/entry.js'

const SIGNAL = { CONTRACT: 'c', EXPECT: 'e', ACTION: 'a', RESULT: ENTRY_RESULT }

describe('the entry line', () => {
  it('is one JSON line of event entry with the task, the four fields and the time', () => {
    expect(JSON.parse(entryLine('7', SIGNAL, 't'))).toEqual({ event: 'entry', task: '7', ...SIGNAL, ts: 't' })
    expect(entryLine('7', SIGNAL, 't').endsWith('\n')).toBe(true)
  })

  it('is read back for its own task, the last one, past lines that are not entries', () => {
    const journal = [entryLine('7', { ...SIGNAL, CONTRACT: 'old' }, 't'), '{not json', JSON.stringify({ event: 'path', task: '7' }), entryLine('8', SIGNAL, 't'), entryLine('7', SIGNAL, 't')].join('')
    expect(entryOf(journal, '7')).toMatchObject(SIGNAL)
    expect(entryOf(journal, '9')).toBeUndefined()
  })

  it('does not read an entry line missing a field', () => {
    expect(entryOf(JSON.stringify({ event: 'entry', task: '7', CONTRACT: 'c' }), '7')).toBeUndefined()
  })
})
