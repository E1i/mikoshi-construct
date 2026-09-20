import { Buffer } from 'node:buffer'

export const PARSE_FAILURES = ['control-character', 'ended-early', 'not-an-object', 'unnamed'] as const

export type ParseFailure = typeof PARSE_FAILURES[number]

export interface ControlCharacter {
  offset: number
  codePoint: number
  name: string
}

export interface PayloadFacts {
  bytes: number
  characters: number
  parses: boolean
  failure: ParseFailure | null
  failureOffset: number | null
  characterAtFailure: string | null
  contextAtFailure: string | null
  controlCharacters: ControlCharacter[]
  fields: string[]
  valueLengths: Record<string, number>
}

const CONTROL_NAMES: Record<number, string> = {
  0x09: 'tab',
  0x0A: 'newline',
  0x0D: 'carriage return',
}

const CONTEXT_RADIUS = 60

function controlCharactersIn(raw: string): ControlCharacter[] {
  return [...raw].flatMap((character, offset) => {
    const codePoint = character.codePointAt(0)!
    return codePoint < 0x20
      ? [{ offset, codePoint, name: CONTROL_NAMES[codePoint] ?? `control U+${codePoint.toString(16).padStart(4, '0')}` }]
      : []
  })
}

function offsetOf(error: unknown): number | null {
  const position = /position (\d+)/.exec(error instanceof Error ? error.message : '')
  return position == null ? null : Number(position[1])
}

function failureAt(raw: string, offset: number | null, error: unknown): ParseFailure {
  if (!raw.trimStart().startsWith('{'))
    return 'not-an-object'
  if (offset != null && (raw.codePointAt(offset) ?? 0x20) < 0x20)
    return 'control-character'
  const message = error instanceof Error ? error.message : ''
  return /end of (?:JSON )?(?:input|data)|Unterminated/i.test(message) || offset === raw.length ? 'ended-early' : 'unnamed'
}

function lengthsOf(value: Record<string, unknown>): Record<string, number> {
  return Object.fromEntries(Object.entries(value).map(([field, entry]) => [
    field,
    typeof entry === 'string' ? entry.length : Array.isArray(entry) ? entry.join('').length : 0,
  ]))
}

export function classifyPayload(raw: string): PayloadFacts {
  const controlCharacters = controlCharactersIn(raw)
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return {
      bytes: Buffer.byteLength(raw),
      characters: raw.length,
      parses: true,
      failure: null,
      failureOffset: null,
      characterAtFailure: null,
      contextAtFailure: null,
      controlCharacters,
      fields: Object.keys(parsed),
      valueLengths: lengthsOf(parsed),
    }
  }
  catch (error) {
    const offset = offsetOf(error)
    return {
      bytes: Buffer.byteLength(raw),
      characters: raw.length,
      parses: false,
      failure: failureAt(raw, offset, error),
      failureOffset: offset,
      characterAtFailure: offset == null ? null : raw[offset] ?? null,
      contextAtFailure: offset == null ? null : raw.slice(Math.max(0, offset - CONTEXT_RADIUS), offset + CONTEXT_RADIUS),
      controlCharacters,
      fields: [],
      valueLengths: {},
    }
  }
}
