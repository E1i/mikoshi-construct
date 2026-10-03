import type { SignalField } from '../src/ui/signal.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SIGNAL_FIELDS } from '../src/ui/signal.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const SKILL = readFileSync(path.join(REPO_ROOT, 'templates/ai/claude/_claude/skills/implement/SKILL.md'), 'utf8')

const SOURCES: Record<SignalField, string[]> = {
  CONTRACT: ['the handle the build printed in step 2', '`task`', '`effort`', '`acceptance`', '`immutable`'],
  EXPECT: ['the forecast the repository records'],
  ACTION: ['the Workflow run identifier from step 3', '`attempts`', '`effort`', '`outcome`'],
  RESULT: ['the `status` step 4 wrote to `.construct/runs.jsonl`', 'verbatim'],
}

function relayStep(): string {
  const start = SKILL.indexOf('\n5. Relay the result')
  const end = SKILL.indexOf('\n6. Never commit')
  expect(start, 'step 5').toBeGreaterThan(-1)
  expect(end, 'step 6').toBeGreaterThan(start)
  return SKILL.slice(start, end)
}

function bulletOf(field: SignalField): { at: number, text: string } {
  const step = relayStep()
  const at = step.indexOf(`\n   - \`${field.toLowerCase()}:\``)
  if (at === -1)
    return { at, text: '' }
  const next = step.indexOf('\n   - ', at + 1)
  const close = step.indexOf('\n   Never compose', at + 1)
  const ends = [next, close].filter(index => index > at)
  return { at, text: step.slice(at, ends.length > 0 ? Math.min(...ends) : undefined) }
}

function statedOrder(): string[] {
  const line = relayStep().split('\n').find(text => text.endsWith(', in this order.')) ?? ''
  return [...line.matchAll(/`(\w+):`/g)].map(match => match[1] ?? '')
}

describe('the implement skill relays its result as the four signal fields', () => {
  it('opens the relay with the four fields in SIGNAL_FIELDS order, each naming its machine source', () => {
    const bullets = SIGNAL_FIELDS.map(field => ({ field, ...bulletOf(field) }))

    expect(statedOrder()).toEqual(SIGNAL_FIELDS.map(field => field.toLowerCase()))

    for (const { field, at, text } of bullets) {
      expect(at, `${field} line`).toBeGreaterThan(-1)
      for (const source of SOURCES[field])
        expect(text, `${field} names ${source}`).toContain(source)
    }
    expect(bullets.map(bullet => bullet.at)).toEqual([...bullets.map(bullet => bullet.at)].sort((a, b) => a - b))
  })

  it('forbids composing a value, and an estimate of its own in expect', () => {
    expect(relayStep()).toContain('Never compose, estimate or round a value')
    expect(bulletOf('EXPECT').text).toContain('never an estimate of your own')
  })

  it('writes a value no source holds as <what> not recorded <where>', () => {
    expect(relayStep()).toContain('a value its source does not hold is written\n   `<what> not recorded <where>`, naming the place that holds no record, and no line is left empty')
    expect(bulletOf('EXPECT').text).toContain('`expect not recorded in .construct/runs.jsonl`')
  })
})
