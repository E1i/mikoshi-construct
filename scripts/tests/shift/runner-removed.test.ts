import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(import.meta.dirname, '../../..')
const windowDoc = readFileSync(path.join(root, 'architecture/window.md'), 'utf8')
const SHIFT_SCRIPT = /\bshift:[a-z]+/g

describe('the instructions that lead into the shift runner', () => {
  it('architecture/window.md gives no instruction to run shift:*', () => {
    expect(windowDoc.match(SHIFT_SCRIPT) ?? []).toEqual([])
  })
})
