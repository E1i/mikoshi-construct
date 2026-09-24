import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CAUSES, readLedger, TOKEN_SOURCES } from '../src/commands/cost/index.js'

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

const STATUSES_WITH_A_CAUSE = Object.keys(CAUSES) as (keyof typeof CAUSES)[]

describe('a run that ended without passing carries its cause, and no other run does', () => {
  it('names the statuses that need a cause and the causes each may name', () => {
    expect(CAUSES).toEqual({ stopped: ['environment', 'human'], failed: ['environment', 'task'] })
  })

  it('reads every status with each cause its vocabulary names', () => {
    const lines = STATUSES_WITH_A_CAUSE.flatMap(status => CAUSES[status].map(cause => entry({ status, cause })))
    const reading = read(lines)
    expect(reading.malformed).toEqual([])
    expect(reading.entries.map(item => `${item.status}/${item.cause}`)).toEqual(STATUSES_WITH_A_CAUSE.flatMap(status => CAUSES[status].map(cause => `${status}/${cause}`)))
  })

  it('reads a stopped entry without a cause as malformed, naming cause, because no stopped entry predates the field', () => {
    expect(read([entry({ status: 'stopped' })]).malformed).toEqual([{ line: 1, reason: 'missing or invalid: cause' }])
  })

  it('reads a failed entry without a cause as one whose cause was not recorded, because failed entries written before the field cannot be repaired', () => {
    const reading = read([entry({ status: 'failed' })])
    expect(reading.malformed).toEqual([])
    expect(reading.entries[0].cause).toBe('not recorded')
  })

  it('reads a cause that belongs to another status as malformed', () => {
    expect(read([entry({ status: 'failed', cause: 'human' })]).malformed).toEqual([{ line: 1, reason: 'missing or invalid: cause' }])
    expect(read([entry({ status: 'stopped', cause: 'task' })]).malformed).toEqual([{ line: 1, reason: 'missing or invalid: cause' }])
  })

  it('reads a cause on a run that passed as malformed, so the field answers one question', () => {
    expect(read([entry({ status: 'done', cause: 'environment' })]).malformed).toEqual([{ line: 1, reason: 'missing or invalid: cause' }])
  })

  it('no longer reads the retired name stopReason as a cause', () => {
    expect(read([entry({ status: 'stopped', stopReason: 'human' })]).malformed).toEqual([{ line: 1, reason: 'missing or invalid: cause' }])
  })
})

describe('the /implement skill explains the stopped status and every cause', () => {
  for (const skill of SKILLS) {
    it(`${skill} lists stopped as the eighth status and explains each cause per status`, () => {
      const text = readFileSync(path.join(REPO_ROOT, skill), 'utf8')
      expect(text).toContain('- `stopped`')
      expect(text).toContain('one of the eight in step 3')
      expect(text).not.toContain('stopReason')
      for (const status of STATUSES_WITH_A_CAUSE) {
        for (const cause of CAUSES[status])
          expect(text, `${status}/${cause}`).toContain(`\`${status}\` / \`${cause}\` —`)
      }
    })
  }
})

describe('a token figure may name the measure it came from, and its absence means the standard one', () => {
  it('reads an entry with no tokensSource, which is the Workflow tool\'s own report', () => {
    const reading = read([entry({ cause: 'human' })])
    expect(reading.malformed).toEqual([])
    expect(reading.entries[0].tokensSource).toBeUndefined()
  })

  it('reads each source the vocabulary names', () => {
    const reading = read(TOKEN_SOURCES.map(tokensSource => entry({ cause: 'environment', tokens: 207835, tokensSource })))
    expect(reading.malformed).toEqual([])
    expect(reading.entries.map(item => item.tokensSource)).toEqual([...TOKEN_SOURCES])
  })

  it('reads a source outside the vocabulary as malformed', () => {
    expect(read([entry({ cause: 'human', tokensSource: 'estimate' })]).malformed).toEqual([{ line: 1, reason: 'missing or invalid: tokensSource' }])
  })

  for (const skill of SKILLS) {
    it(`${skill} explains tokensSource as optional and every source it may name`, () => {
      const text = readFileSync(path.join(REPO_ROOT, skill), 'utf8')
      expect(text).toContain('`tokensSource` — optional')
      for (const source of TOKEN_SOURCES)
        expect(text, source).toMatch(new RegExp(`\`${source}\` —`))
    })
  }
})
