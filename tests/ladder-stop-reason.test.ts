import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readLedger, STOP_REASONS } from '../src/commands/cost/index.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const SKILLS = ['.claude/skills/implement/SKILL.md', 'templates/ai/claude/_claude/skills/implement/SKILL.md']

function entry(fields: Record<string, unknown>): string {
  return JSON.stringify({
    run: 'wf_abc',
    at: '2026-09-24T10:00:00.000Z',
    task: 'the recorded surface',
    effort: 'medium',
    status: 'stopped',
    rung: 'medium',
    attempts: [{ rung: 1, effort: 'medium', outcome: 'harness failed', reason: 'timed out' }],
    agents: 3,
    tokens: 'unknown',
    toolUses: 54,
    seconds: 993,
    ...fields,
  })
}

function read(lines: string[]): ReturnType<typeof readLedger> {
  const cwd = mkdtempSync(path.join(tmpdir(), 'construct-ledger-'))
  mkdirSync(path.join(cwd, '.construct'))
  writeFileSync(path.join(cwd, '.construct', 'runs.jsonl'), `${lines.join('\n')}\n`)
  return readLedger(cwd)
}

describe('a stopped run carries why it was stopped, and nothing else does', () => {
  it('reads a stopped entry with each reason the vocabulary names', () => {
    const reading = read(STOP_REASONS.map(stopReason => entry({ stopReason })))
    expect(reading.malformed).toEqual([])
    expect(reading.entries.map(item => item.stopReason)).toEqual([...STOP_REASONS])
  })

  it('names environment and human as the two reasons', () => {
    expect([...STOP_REASONS]).toEqual(['environment', 'human'])
  })

  it('reads a stopped entry without a reason as malformed, naming stopReason', () => {
    expect(read([entry({})]).malformed).toEqual([{ line: 1, reason: 'missing or invalid: stopReason' }])
  })

  it('reads a reason outside the vocabulary as malformed', () => {
    expect(read([entry({ stopReason: 'cancelled' })]).malformed).toEqual([{ line: 1, reason: 'missing or invalid: stopReason' }])
  })

  it('reads a reason on a run that was not stopped as malformed, so the field answers one question', () => {
    expect(read([entry({ status: 'failed', stopReason: 'human' })]).malformed).toEqual([{ line: 1, reason: 'missing or invalid: stopReason' }])
  })
})

describe('the /implement skill explains the stopped status and every reason', () => {
  for (const skill of SKILLS) {
    it(`${skill} lists stopped as the eighth status and explains each reason`, () => {
      const text = readFileSync(path.join(REPO_ROOT, skill), 'utf8')
      expect(text).toContain('- `stopped`')
      expect(text).toContain('one of the eight in step 3')
      for (const reason of STOP_REASONS)
        expect(text, reason).toMatch(new RegExp(`\`${reason}\` —`))
    })
  }
})
