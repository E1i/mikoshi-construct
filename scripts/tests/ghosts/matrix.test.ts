import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { lookupMatrixRow, matrixKeyFor } from '../../ghosts/matrix.js'

function matrixFile(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ghosts-matrix-'))
  const file = path.join(dir, 'matrix.json')
  writeFileSync(file, JSON.stringify({
    vocabulary: [],
    rows: [
      { task: 'g1', class: 'R2', contour: { after: [], notes: [] } },
      { task: '#272', class: 'R3', contour: { after: [], notes: ['numeric'] } },
    ],
    notChecked: [],
  }))
  return file
}

describe('matrixKeyFor', () => {
  it('prefixes an all-digit id with #', () => {
    expect(matrixKeyFor('272')).toBe('#272')
  })

  it('leaves a non-numeric id unchanged', () => {
    expect(matrixKeyFor('g1')).toBe('g1')
  })
})

describe('lookupMatrixRow', () => {
  it('is null when there is no matrix path', () => {
    expect(lookupMatrixRow(undefined, 'g1')).toBeNull()
  })

  it('reads a non-numeric id from its bare row, never the #-prefixed row', () => {
    const file = matrixFile()
    expect(lookupMatrixRow(file, 'g1')).toEqual({ class: 'R2', contour: { after: [], notes: [] } })
  })

  it('reads an all-digit id from its #-prefixed row, never the bare row', () => {
    const file = matrixFile()
    expect(lookupMatrixRow(file, '272')).toEqual({ class: 'R3', contour: { after: [], notes: ['numeric'] } })
  })

  it('is null when no row matches the id', () => {
    const file = matrixFile()
    expect(lookupMatrixRow(file, 'g99')).toBeNull()
  })
})
