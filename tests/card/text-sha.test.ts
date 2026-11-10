import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { priorityLineOf, textSha, withKeptPriority } from '../../src/card/text-sha.js'

const HEADER = 'card: #1 a [implement/x/S/cheap/auto] · depends — · blocks —\nwho: shift'

describe('textSha', () => {
  it('is the sha256 hex of the whole text, so one changed byte changes it', () => {
    const text = 'card: #1 a [implement/x/S/cheap/auto] · depends — · blocks —\n'
    expect(textSha(text)).toBe(createHash('sha256').update(text).digest('hex'))
    expect(textSha(`${text} `)).not.toBe(textSha(text))
  })
})

describe('priorityLineOf and withKeptPriority', () => {
  it('reads the priority line of the header only', () => {
    expect(priorityLineOf(`${HEADER}\npriority: p1\n\nDo the thing.\n`)).toBe('priority: p1')
    expect(priorityLineOf(`${HEADER}\n\npriority: p1\n`)).toBeUndefined()
  })

  it('carries the latest priority into a text with none, and leaves a text with its own', () => {
    const latest = `${HEADER}\npriority: p2\n\nOld.\n`
    expect(withKeptPriority(`${HEADER}\n\nNew.\n`, latest)).toBe(`${HEADER}\npriority: p2\n\nNew.\n`)
    expect(withKeptPriority(`${HEADER}\npriority: p0\n\nNew.\n`, latest)).toBe(`${HEADER}\npriority: p0\n\nNew.\n`)
    expect(withKeptPriority(`${HEADER}\n\nNew.\n`, `${HEADER}\n\nOld.\n`)).toBe(`${HEADER}\n\nNew.\n`)
    expect(withKeptPriority(`${HEADER}\n\nNew.\n`, undefined)).toBe(`${HEADER}\n\nNew.\n`)
  })
})
