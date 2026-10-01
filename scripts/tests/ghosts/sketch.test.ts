import { describe, expect, it } from 'vitest'
import { describeSketch, parseSketch } from '../../ghosts/sketch.js'

const SHA = '0123456789abcdef0123456789abcdef01234567'
const DASH = String.fromCharCode(8212)

describe('parseSketch', () => {
  it('reads a branch and its sha from line 2', () => {
    expect(parseSketch(`/implement x\nSketch: sketch/t @ ${SHA}\n\nEffort: low`)).toEqual({ kind: 'branch', branch: 'sketch/t', sha: SHA })
  })

  it('reads none and its reason', () => {
    expect(parseSketch(`/implement x\nSketch: none ${DASH} independent implementation is the witness\n`)).toEqual({ kind: 'none', reason: 'independent implementation is the witness' })
  })

  it('refuses a text whose line 2 is not a Sketch: line, naming line 2', () => {
    for (const text of ['/implement x\n\nEffort: low', `/implement x\nEffort: low\nSketch: none ${DASH} late`, '/implement x']) {
      expect(() => parseSketch(text)).toThrow('line 2')
    }
  })

  it('refuses a malformed Sketch: line, quoting it', () => {
    for (const line of ['Sketch: sketch/t @ abc123', 'Sketch: sketch/t', 'Sketch: none', 'Sketch: none - reason', `Sketch: none ${DASH}`, `Sketch: ${SHA.toUpperCase()}`]) {
      expect(() => parseSketch(`/implement x\n${line}`)).toThrow(JSON.stringify(line))
    }
  })
})

describe('describeSketch', () => {
  it('names the branch and the short sha for a sketch', () => {
    expect(describeSketch({ kind: 'branch', branch: 'sketch/t', sha: SHA })).toBe('from sketch sketch/t @ 0123456')
  })

  it('names the reason for a clean tree', () => {
    expect(describeSketch({ kind: 'none', reason: 'because' })).toBe('clean tree (because)')
  })
})
