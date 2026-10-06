import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readSubagentRecords, TURN_JOURNAL_FILE } from '../src/commands/cost/turns.js'

const USAGE = { calls: 1, input: 10, cacheWrite: 20, cacheRead: 30, output: 40, models: ['m-1'] }

function world(lines: object[] | null): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-subagents-'))
  if (lines != null) {
    mkdirSync(path.join(dir, '.construct'))
    writeFileSync(path.join(dir, TURN_JOURNAL_FILE), `${lines.map(line => JSON.stringify(line)).join('\n')}\n`)
  }
  return dir
}

describe('readSubagentRecords', () => {
  it('returns the subagent lines the turn journal reader accepts, with their agent, role and time', () => {
    const subagent = { v: 1, kind: 'subagent', session: 's', at: '2026-10-01T10:00:00.000Z', agent: 'a1', agentType: 'scan', usage: USAGE }
    const dir = world([subagent, { ...subagent, v: 2 }, { ...subagent, agent: undefined }, { v: 1, kind: 'turn', session: 's', usage: USAGE }])
    expect(readSubagentRecords(dir)).toEqual([{ agent: 'a1', agentType: 'scan', at: '2026-10-01T10:00:00.000Z', startedAt: null, usage: USAGE }])
  })

  it('carries the startedAt a subagent line records, and null for one that is not a string', () => {
    const subagent = { v: 1, kind: 'subagent', session: 's', at: '2026-10-01T10:05:00.000Z', startedAt: '2026-10-01T10:00:00.000Z', agent: 'a1', agentType: 'brief', usage: USAGE }
    const dir = world([subagent, { ...subagent, agent: 'a2', startedAt: 7 }])
    expect(readSubagentRecords(dir)?.map(record => record.startedAt)).toEqual(['2026-10-01T10:00:00.000Z', null])
  })

  it('is null when the turn journal is not there', () => {
    expect(readSubagentRecords(world(null))).toBeNull()
  })
})
