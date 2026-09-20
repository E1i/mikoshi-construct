import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { classifyPayload } from '../../bench/classify.js'

const SOURCE = path.resolve(import.meta.dirname, '../../bench/classify.ts')

const WELL_FORMED = '{"decision": "keep it here", "files": ["a.ts", "b.ts"]}'

const CASES: Record<string, { raw: string, parses: boolean, failure: string | null, controlCharacters: number }> = {
  'a well formed object': { raw: WELL_FORMED, parses: true, failure: null, controlCharacters: 0 },
  'an escaped newline inside a value': { raw: '{"decision": "first\\nsecond"}', parses: true, failure: null, controlCharacters: 0 },
  'a raw newline inside a value': { raw: '{"decision": "first\nsecond"}', parses: false, failure: 'control-character', controlCharacters: 1 },
  'a raw tab inside a value': { raw: '{"decision": "first\tsecond"}', parses: false, failure: 'control-character', controlCharacters: 1 },
  'an answer that stopped mid string': { raw: '{"decision": "it ends here', parses: false, failure: 'ended-early', controlCharacters: 0 },
  'an answer that stopped mid object': { raw: '{"decision": "done",', parses: false, failure: 'ended-early', controlCharacters: 0 },
  'prose wrapped around the object': { raw: `Here is the spec:\n${WELL_FORMED}`, parses: false, failure: 'not-an-object', controlCharacters: 1 },
  'an unescaped quote inside a value': { raw: '{"decision": "the "must be empty" rule"}', parses: false, failure: 'unnamed', controlCharacters: 0 },
}

describe('what a captured payload is, told apart from why it was refused', () => {
  for (const [name, expected] of Object.entries(CASES)) {
    it(`reads ${name}`, () => {
      const { raw, ...wanted } = expected
      const facts = classifyPayload(raw)
      expect({
        parses: facts.parses,
        failure: facts.failure,
        controlCharacters: facts.controlCharacters.length,
      }).toEqual(wanted)
    })
  }

  it('exercises every failure the classifier can name', () => {
    const declared = /export type ParseFailure =([\s\S]*?)\n\n/.exec(readFileSync(SOURCE, 'utf8'))?.[1] ?? ''
    const names = [...declared.matchAll(/'([a-z-]+)'/g)].map(match => match[1])
    expect(names.length).toBeGreaterThan(3)
    const covered = new Set(Object.values(CASES).map(entry => entry.failure))
    expect(names.filter(name => !covered.has(name))).toEqual([])
  })

  it('names the control character, its offset and the character sitting there', () => {
    const facts = classifyPayload('{"decision": "first\nsecond"}')
    expect(facts.controlCharacters).toEqual([{ offset: 19, codePoint: 0x0A, name: 'newline' }])
    expect(facts.characterAtFailure).toBe('\n')
    expect(facts.failureOffset).toBe(19)
    expect(facts.contextAtFailure).toContain('first')
  })

  it('separates an escaped newline from a raw one, which is the whole question', () => {
    expect(classifyPayload('{"decision": "first\\nsecond"}').controlCharacters).toEqual([])
    expect(classifyPayload('{"decision": "first\nsecond"}').controlCharacters).toHaveLength(1)
  })

  it('measures the payload whole, never a prefix of it', () => {
    const long = `{"decision": "${'x'.repeat(50000)}"}`
    const facts = classifyPayload(long)
    expect(facts.parses).toBe(true)
    expect(facts.characters).toBe(long.length)
    expect(facts.valueLengths.decision).toBe(50000)
  })

  it('reports the fields and the size of each value it could read', () => {
    const facts = classifyPayload(WELL_FORMED)
    expect(facts.fields).toEqual(['decision', 'files'])
    expect(facts.valueLengths).toEqual({ decision: 12, files: 8 })
  })
})
