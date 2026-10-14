import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { textSha } from '../../src/card/text-sha.js'

describe('textSha', () => {
  it('is the sha256 hex of the whole text, so one changed byte changes it', () => {
    const text = 'card: #1 a [implement/x/S/cheap/auto] · depends — · blocks —\n'
    expect(textSha(text)).toBe(createHash('sha256').update(text).digest('hex'))
    expect(textSha(`${text} `)).not.toBe(textSha(text))
  })
})
