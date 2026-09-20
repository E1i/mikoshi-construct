import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, 'fixtures/architect')
const RUN = 'wf_3ef46fa8-e99'

interface Rejection {
  run: string
  agent: string
  attempt: number
  timestamp: string
  effort: string
  stopReason: string | null
  outputTokens: number | null
  outcome: 'unparsable' | 'empty'
  reportedBytes: number | null
  journaledChars: number
  validatorError: string
  payload: string
}

const RECORDED: Record<string, Pick<Rejection, 'agent' | 'attempt' | 'outcome' | 'reportedBytes' | 'journaledChars'>> = {
  'design-a-attempt-1': { agent: 'a1a6efe61c4ecf594', attempt: 1, outcome: 'unparsable', reportedBytes: 4564, journaledChars: 2048 },
  'design-a-attempt-2': { agent: 'a1a6efe61c4ecf594', attempt: 2, outcome: 'unparsable', reportedBytes: 4030, journaledChars: 2048 },
  'design-a-attempt-3': { agent: 'a1a6efe61c4ecf594', attempt: 3, outcome: 'unparsable', reportedBytes: 3436, journaledChars: 2048 },
  'design-a-attempt-4': { agent: 'a1a6efe61c4ecf594', attempt: 4, outcome: 'empty', reportedBytes: null, journaledChars: 2 },
  'design-a-attempt-5': { agent: 'a1a6efe61c4ecf594', attempt: 5, outcome: 'unparsable', reportedBytes: 3659, journaledChars: 2048 },
  'design-b-attempt-1': { agent: 'a465360f4e6aa4769', attempt: 1, outcome: 'unparsable', reportedBytes: 10293, journaledChars: 2048 },
  'design-b-attempt-2': { agent: 'a465360f4e6aa4769', attempt: 2, outcome: 'unparsable', reportedBytes: 9293, journaledChars: 2048 },
  'design-b-attempt-3': { agent: 'a465360f4e6aa4769', attempt: 3, outcome: 'unparsable', reportedBytes: 7396, journaledChars: 2048 },
  'design-b-attempt-4': { agent: 'a465360f4e6aa4769', attempt: 4, outcome: 'empty', reportedBytes: null, journaledChars: 2 },
  'design-b-attempt-5': { agent: 'a465360f4e6aa4769', attempt: 5, outcome: 'empty', reportedBytes: null, journaledChars: 2 },
}

const SANITIZED_VOCABULARY = [
  'west_europe, east_europe, central_europe, northern_europe, north_america, central_asia, southeast_asia, other',
  'under_5k, from_5k_to_10k, from_10k_to_25k, from_25k_to_50k, from_50k_to_100k, over_100k',
  'service regions',
]

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']

function rejection(name: string): Rejection {
  return JSON.parse(readFileSync(path.join(ROOT, `${name}.json`), 'utf8'))
}

function readme(): string {
  return readFileSync(path.join(ROOT, 'README.md'), 'utf8')
}

describe('the harvested architect rejections stay a record', () => {
  it('holds exactly the ten calls the run produced, and its README', () => {
    expect(readdirSync(ROOT).sort()).toEqual(['README.md', ...Object.keys(RECORDED).map(name => `${name}.json`)].sort())
  })

  for (const [name, expected] of Object.entries(RECORDED)) {
    it(`${name} carries what the runtime reported`, () => {
      const record = rejection(name)
      expect(record.run).toBe(RUN)
      expect(record.effort).toBe('xhigh')
      expect({
        agent: record.agent,
        attempt: record.attempt,
        outcome: record.outcome,
        reportedBytes: record.reportedBytes,
        journaledChars: record.journaledChars,
      }).toEqual(expected)
    })

    it(`${name} stores no more payload than the journal kept`, () => {
      const record = rejection(name)
      expect(record.payload.length).toBeLessThanOrEqual(record.journaledChars)
      if (record.outcome === 'empty')
        expect(record.payload).toHaveLength(record.journaledChars)
    })

    it(`${name} reports a size when, and only when, the runtime could not read the input`, () => {
      const record = rejection(name)
      if (record.outcome === 'unparsable') {
        expect(record.validatorError).toContain('could not be parsed as JSON')
        expect(record.validatorError).toContain(`of ${record.reportedBytes} bytes`)
        return
      }
      expect(record.payload).toBe('{}')
      expect(record.reportedBytes).toBeNull()
      expect(record.validatorError).toContain('must have required property')
    })

    it(`${name} names no completion that ran out of room`, () => {
      const { stopReason } = rejection(name)
      expect(stopReason == null || stopReason === 'tool_use').toBe(true)
    })
  }

  it('records a retry that shortened the answer and was refused again', () => {
    for (const agent of ['a', 'b']) {
      const sizes = Object.keys(RECORDED)
        .filter(name => name.startsWith(`design-${agent}-`))
        .map(name => rejection(name).reportedBytes)
        .filter((size): size is number => size != null)
      expect(sizes.length).toBeGreaterThan(2)
      expect(Math.min(...sizes)).toBeLessThan(Math.max(...sizes))
    }
  })

  it('keeps the invented vocabulary the sanitization put there', () => {
    const everything = Object.keys(RECORDED).map(name => rejection(name).payload).join('\n')
    for (const phrase of SANITIZED_VOCABULARY)
      expect(everything, 'a re-import of the raw journals would drop this').toContain(phrase)
  })

  it('counts the calls that never parsed the same way the README beside it does', () => {
    const names = Object.keys(RECORDED)
    const unparsable = names.filter(name => rejection(name).outcome === 'unparsable').length
    expect(readme()).toContain(`${NUMBER_WORDS[unparsable]} of these ${NUMBER_WORDS[names.length]} never parsed`)
  })

  it('explains every field it records, in the README beside it', () => {
    const explained = readme()
    for (const field of Object.keys(rejection('design-a-attempt-1')))
      expect(explained, `the README beside the fixtures explains ${field}`).toContain(`\`${field}\``)
  })
})
