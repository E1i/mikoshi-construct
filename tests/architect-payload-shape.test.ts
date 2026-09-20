import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, 'fixtures/architect')
const LOG_WINDOW = 2048

interface Rejection {
  attempt: number
  outcome: 'unparsable' | 'empty'
  stopReason: string | null
  outputTokens: number | null
  reportedBytes: number | null
  journaledChars: number
  payload: string
}

function controlCharactersIn(text: string): string[] {
  return [...text].filter(character => character.codePointAt(0)! < 0x20)
}

function endOfString(text: string, start: number): number | null {
  for (let index = start + 1; index < text.length; index++) {
    if (text[index] === '\\') {
      index++
      continue
    }
    if (text[index] === '"')
      return index + 1
  }
  return null
}

function firstField(payload: string): { name: string, value: string } | null {
  const key = /^\{\s*"([^"]+)"\s*:\s*"/.exec(payload)
  if (key == null)
    return null
  const start = key[0].length - 1
  const end = endOfString(payload, start)
  return end == null ? null : { name: key[1], value: JSON.parse(payload.slice(start, end)) }
}

function records(): Array<[string, Rejection]> {
  return readdirSync(ROOT)
    .filter(entry => entry.endsWith('.json'))
    .sort()
    .map(entry => [entry.replace(/\.json$/, ''), JSON.parse(readFileSync(path.join(ROOT, entry), 'utf8')) as Rejection])
}

function unparsable(): Array<[string, Rejection]> {
  return records().filter(([, record]) => record.outcome === 'unparsable')
}

function empty(): Array<[string, Rejection]> {
  return records().filter(([, record]) => record.outcome === 'empty')
}

describe('the seven unreadable payloads are cut by the log, not by the model', () => {
  it('keeps seven of them', () => {
    expect(unparsable()).toHaveLength(7)
  })

  it('cuts every one of them at the same offset, which is where the log stops', () => {
    expect(unparsable().map(([, record]) => record.journaledChars)).toEqual(Array.from({ length: 7 }).fill(LOG_WINDOW))
  })

  it('cannot say where any of them became invalid, because each ran well past that offset', () => {
    for (const [name, record] of unparsable())
      expect(record.reportedBytes, `${name} reported more bytes than the log kept`).toBeGreaterThan(LOG_WINDOW)
  })

  for (const [name, record] of unparsable()) {
    it(`${name} is a bare object, never a fenced block or prose around one`, () => {
      expect(record.payload.startsWith('{"')).toBe(true)
    })

    it(`${name} opens with a decision that is long and well formed at the same time`, () => {
      const first = firstField(record.payload)
      expect(first?.name).toBe('decision')
      expect(first!.value.length).toBeGreaterThan(1000)
      expect(controlCharactersIn(first!.value)).toEqual([])
    })

    it(`${name} carries no raw control character in the part the log kept`, () => {
      expect(controlCharactersIn(record.payload)).toEqual([])
    })

    it(`${name} stopped because the model called the tool, not because it ran out of room`, () => {
      expect(record.stopReason == null || record.stopReason === 'tool_use').toBe(true)
    })
  }

  it('shows no common ceiling the answers could have been cut against', () => {
    const sizes = unparsable().map(([, record]) => record.outputTokens).filter((size): size is number => size != null)
    expect(new Set(sizes).size).toBe(sizes.length)
    expect(Math.max(...sizes)).toBeGreaterThan(Math.min(...sizes) * 3)
  })
})

describe('the three empty calls are a different failure, and the only one recorded whole', () => {
  it('keeps three of them', () => {
    expect(empty()).toHaveLength(3)
  })

  for (const [name, record] of empty()) {
    it(`${name} is the entire payload the runtime received, with nothing cut away`, () => {
      expect(record.payload).toBe('{}')
      expect(record.journaledChars).toBe(record.payload.length)
      expect(record.reportedBytes).toBeNull()
    })

    it(`${name} spent tokens on a turn and then passed no arguments at all`, () => {
      expect(record.outputTokens).toBeGreaterThan(200)
      expect(record.outputTokens).toBeLessThan(500)
      expect(record.stopReason).toBe('tool_use')
    })

    it(`${name} follows attempts that were already refused`, () => {
      expect(record.attempt).toBeGreaterThan(3)
    })
  }
})
