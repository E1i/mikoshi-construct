import type { SignalField } from '../src/ui/signal.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SIGNAL_FIELDS } from '../src/ui/signal.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const SKILL = readFileSync(path.join(REPO_ROOT, 'templates/ai/claude/_claude/skills/implement/SKILL.md'), 'utf8')

const FLAG_SOURCES: Partial<Record<SignalField, { flag: string, value: string, sources: string[] }>> = {
  ACTION: { flag: '--action', value: 'action', sources: ['the Workflow run identifier from step 3', '`attempts`', '`effort`', '`outcome`'] },
  RESULT: { flag: '--result', value: 'status', sources: ['the `status` step 4 wrote to `.construct/runs.jsonl`', 'verbatim'] },
}
const CARD_FIELDS: SignalField[] = ['CONTRACT', 'EXPECT']

function section(from: string, to: string): string {
  const start = SKILL.indexOf(from)
  const end = SKILL.indexOf(to)
  expect(start, from).toBeGreaterThan(-1)
  expect(end, to).toBeGreaterThan(start)
  return SKILL.slice(start, end)
}

const relayStep = (): string => section('\n5. Relay the result', '\n6. Never commit')
const entryStep = (): string => section('\n0. Before the first token', '\n1. Classify the effort class')

describe('the implement skill prints its entry card and relays its result as the same card', () => {
  it('prints the entry card from the card mode before classification and any agent, never retyped', () => {
    const step = entryStep()
    expect(step).toContain('check-acceptance.mjs card --brief .construct/implement-agreed.txt')
    expect(step).toContain('print\n   its stdout unchanged, never retyped')
    for (const field of SIGNAL_FIELDS)
      expect(step, field).toContain(`\`${field}\``)
    expect(step).toContain('`accepted · not started`')
  })

  it('opens the relay with the exit card, whose CONTRACT and EXPECT are the entry\'s byte for byte', () => {
    const step = relayStep()
    expect(step).toContain('It opens with the exit card: run')
    expect(step).toContain('--brief .construct/implement-agreed.txt --action \'<action>\' --result \'<status>\'')
    for (const field of CARD_FIELDS)
      expect(step, field).toContain(`\`${field}\``)
    expect(step).toContain('rows are the entry card\'s byte for byte')
  })

  it('names the machine source of each of the two flags', () => {
    const step = relayStep()
    for (const { flag, value, sources } of Object.values(FLAG_SOURCES)) {
      const at = step.indexOf(`\n   - \`<${value}>\``)
      expect(at, flag).toBeGreaterThan(-1)
      for (const source of sources)
        expect(step.slice(at), `${flag} names ${source}`).toContain(source)
    }
  })

  it('forbids composing a value, and writes a value no source holds as <what> not recorded <where>', () => {
    const step = relayStep()
    expect(step).toContain('Never compose, estimate or round a value')
    expect(step).toContain('a value its source does not hold is written\n   `<what> not recorded <where>`, naming the place that holds no record, and no row is left empty')
  })
})
