import { describe, expect, it } from 'vitest'
import { lastRunSketch, patchPath, shortSketch, sketchSuperseded } from '../../ghosts/supersede.js'

describe('supersede', () => {
  it('treats null and none as equal', () => {
    expect(sketchSuperseded(null, 'none')).toBe(false)
    expect(sketchSuperseded('a'.repeat(40), 'a'.repeat(40))).toBe(false)
    expect(sketchSuperseded(null, 'b'.repeat(40))).toBe(true)
    expect(sketchSuperseded('a'.repeat(40), 'none')).toBe(true)
  })

  it('names the patch by the old sketch, none when there was none', () => {
    expect(shortSketch('abcdef0123')).toBe('abcdef0')
    expect(patchPath('/r', 'g1', null)).toBe('/r/ghost-g1.done-none.patch')
    expect(patchPath('/r', 'g1', 'abcdef0123')).toBe('/r/ghost-g1.done-abcdef0.patch')
  })

  it('reads the sketch of the last task line of the run', () => {
    const text = [
      { event: 'task', task: 'g1', sketch: 'a'.repeat(40) },
      { event: 'task', task: 'other', sketch: 'c'.repeat(40) },
      { event: 'task', task: 'g1', sketch: null },
    ].map(line => JSON.stringify(line)).join('\n')
    expect(lastRunSketch(text, value => value === 'g1')).toEqual({ task: 'g1', sketch: null })
    expect(lastRunSketch('', () => true)).toBeUndefined()
  })
})
