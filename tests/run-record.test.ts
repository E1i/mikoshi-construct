import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUS_DB_VARIABLE } from '../scripts/core/bus-path.js'
import { openBus } from '../scripts/core/db.js'
import { LEDGER_FILE } from '../src/commands/cost/ledger.js'
import { printRunRecord, RUN_RECORD_EXIT, runRecord } from '../src/commands/run-record.js'
import { createUi } from '../src/ui/console.js'
import { LORE, PLAIN_LORE } from '../src/ui/lore.js'
import { resolveTheme } from '../src/ui/theme.js'

const NOW = new Date('2026-11-10T12:00:00.000Z')
const RECORD = { run: 'wf_1', at: '2026-11-10T11:00:00.000Z', task: 'a task', effort: 'low', status: 'done', rung: 'low', attempts: [{ rung: 1, effort: 'low', outcome: 'passed', reason: '' }], agents: 1, tokens: 10, toolUses: 2, seconds: 30 }

function noBus(): { dir: string, home: string, file: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'run-record-'))
  const dir = path.join(root, 'repo')
  return { dir, home: path.join(root, 'home'), file: path.join(dir, LEDGER_FILE) }
}

function recordIn(dir: string, home: string, text: string, env: NodeJS.ProcessEnv = {}) {
  return runRecord(text, { dir, env, home, now: () => NOW })
}

function printed(result: ReturnType<typeof runRecord>): { exit: number, lines: string[] } {
  const lines: string[] = []
  const exit = printRunRecord(createUi(resolveTheme({ plain: true }), line => lines.push(line)), result)
  return { exit, lines }
}

describe('construct run-record', () => {
  it.each([
    { name: 'text that is not JSON', text: '{"run":', reason: 'not JSON' },
    { name: 'a JSON array', text: '[1]', reason: 'not a run record' },
    { name: 'a record missing step 4 fields', text: JSON.stringify({ run: 'wf_1', status: 'done' }), reason: 'missing or invalid: at, task, effort, rung, agents, toolUses, seconds, tokens, attempts' },
    { name: 'a field step 4 does not name', text: JSON.stringify({ ...RECORD, verdict: 'pass' }), reason: 'undeclared fields: verdict' },
    { name: 'nothing at all', text: '  ', reason: 'not JSON' },
  ])('refuses $name, exits 2 and writes nothing', ({ text, reason }) => {
    const { dir, home, file } = noBus()
    const result = recordIn(dir, home, text)
    expect(result).toEqual({ kind: 'refused', reason })
    expect(existsSync(file)).toBe(false)
    const { exit, lines } = printed(result)
    expect(exit).toBe(RUN_RECORD_EXIT.refused)
    expect(lines.join('\n')).toContain(reason)
  })

  it('appends after a last line that lacks its newline, without gluing the two', () => {
    const { dir, home, file } = noBus()
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ ...RECORD, run: 'wf_0' }))
    recordIn(dir, home, JSON.stringify(RECORD))
    expect(readFileSync(file, 'utf8').split('\n')).toEqual([JSON.stringify({ ...RECORD, run: 'wf_0' }), JSON.stringify(RECORD), ''])
  })

  it('names where the run went, and says when the bus already held it', () => {
    const { dir, home, file } = noBus()
    expect(printed(recordIn(dir, home, JSON.stringify(RECORD)))).toEqual({ exit: RUN_RECORD_EXIT.recorded, lines: [expect.stringContaining(PLAIN_LORE.runRecorded('file', file))] })

    const busPath = path.join(path.dirname(dir), 'bus.db')
    openBus(busPath).close()
    const env = { [BUS_DB_VARIABLE]: busPath }
    expect(printed(recordIn(dir, home, JSON.stringify(RECORD), env)).lines).toEqual([expect.stringContaining(PLAIN_LORE.runRecorded('bus', busPath))])
    expect(printed(recordIn(dir, home, JSON.stringify(RECORD), env)).lines).toEqual([expect.stringContaining(PLAIN_LORE.runRecorded('present', busPath))])
  })

  it.each(['bus', 'file', 'present', 'refused'] as const)('says the %s outcome in lore and in plain', (outcome) => {
    expect(LORE.runRecorded(outcome, 'x')).toContain('x')
    expect(PLAIN_LORE.runRecorded(outcome, 'x')).toContain('x')
  })
})
