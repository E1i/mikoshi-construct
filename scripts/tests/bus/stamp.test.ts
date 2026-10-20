import { describe, expect, it } from 'vitest'
import { LineStamper } from '../../bus/stamp.js'

const AT = new Date('2026-10-20T11:36:00.000Z')

describe('the bus log stamper', () => {
  it('prefixes each complete line with the ISO time and holds a partial line until it completes', () => {
    const stamper = new LineStamper(() => AT)
    expect(stamper.push('one\ntw')).toBe('2026-10-20T11:36:00.000Z one\n')
    expect(stamper.push('o\n\nthree')).toBe('2026-10-20T11:36:00.000Z two\n2026-10-20T11:36:00.000Z \n')
    expect(stamper.end()).toBe('2026-10-20T11:36:00.000Z three\n')
    expect(stamper.end()).toBe('')
  })
})
