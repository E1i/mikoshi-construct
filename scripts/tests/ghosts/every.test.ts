import { describe, expect, it } from 'vitest'
import { parseEverySeconds } from '../../ghosts/every.js'

describe('parseEverySeconds', () => {
  it.each(['1', '5', '600'])('reads %s as whole seconds', (raw) => {
    expect(parseEverySeconds(raw)).toBe(Number(raw))
  })

  it.each(['0', '-5', '1.5', 'soon', '', ' 3'])('refuses \'%s\', naming --every', (raw) => {
    expect(() => parseEverySeconds(raw)).toThrow(`--every must be a whole number of seconds of at least 1, got '${raw}'`)
  })
})
