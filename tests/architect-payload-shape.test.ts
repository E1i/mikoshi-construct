import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, 'fixtures/architect')
const FIELD = /^[\s,]*"([^"]+)"\s*:\s*/

interface Rejection {
  outcome: 'unparsable' | 'empty'
  reportedBytes: number | null
  payload: string
}

function controlCharactersIn(text: string): string[] {
  return [...text].filter(character => character.codePointAt(0)! < 0x20)
}

function endOfValue(text: string, start: number): number | null {
  const open = text[start]
  if (open !== '"' && open !== '[')
    return null
  let depth = 0
  let quoted = false
  for (let index = start; index < text.length; index++) {
    const character = text[index]
    if (character === '\\') {
      index++
      continue
    }
    if (character === '"') {
      quoted = !quoted
      if (!quoted && open === '"')
        return index + 1
      continue
    }
    if (quoted)
      continue
    if (character === '[')
      depth++
    else if (character === ']' && --depth === 0)
      return index + 1
  }
  return null
}

function fieldsIn(payload: string): { complete: string[], incomplete: string | null } {
  const complete: string[] = []
  let index = payload.indexOf('{') + 1
  for (;;) {
    const key = FIELD.exec(payload.slice(index))
    if (key == null)
      return { complete, incomplete: null }
    const start = index + key[0].length
    const end = endOfValue(payload, start)
    if (end == null)
      return { complete, incomplete: key[1] }
    complete.push(key[1])
    index = end
  }
}

function valueOf(payload: string, field: string): string {
  const start = payload.indexOf(`"${field}":`) + `"${field}":`.length + 1
  const end = endOfValue(payload, start)
  expect(end, `${field} closes inside the window`).not.toBeNull()
  return JSON.parse(payload.slice(start, end as number))
}

function unparsable(): Array<[string, Rejection]> {
  return readdirSync(ROOT)
    .filter(entry => entry.endsWith('.json'))
    .map(entry => [entry.replace(/\.json$/, ''), JSON.parse(readFileSync(path.join(ROOT, entry), 'utf8')) as Rejection] as [string, Rejection])
    .filter(([, record]) => record.outcome === 'unparsable')
    .sort(([left], [right]) => left.localeCompare(right))
}

describe('where the rejected payloads break, as far as the record can say', () => {
  it('has a payload the runtime could not read for every size it reported', () => {
    expect(unparsable()).toHaveLength(7)
  })

  for (const [name, record] of unparsable()) {
    it(`${name} is a bare object, never a fenced block or prose around one`, () => {
      expect(record.payload.startsWith('{"')).toBe(true)
    })

    it(`${name} carries no raw control character in anything the journal kept`, () => {
      expect(controlCharactersIn(record.payload)).toEqual([])
    })

    it(`${name} closes decision and breaks off inside contractChanges`, () => {
      expect(fieldsIn(record.payload)).toEqual({ complete: ['decision'], incomplete: 'contractChanges' })
    })

    it(`${name} holds a decision that is long and well formed at the same time`, () => {
      const decision = valueOf(record.payload, 'decision')
      expect(decision.length).toBeGreaterThan(1000)
      expect(controlCharactersIn(decision)).toEqual([])
    })

    it(`${name} leaves more outside the window than a bound on decision could reach`, () => {
      expect(record.reportedBytes! - record.payload.length).toBeGreaterThan(1000)
    })
  }
})
