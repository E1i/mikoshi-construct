import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { repositoryReport } from '../../../contract/module-graph/report.js'
import { openBus } from '../../../core/db.js'
import { ANSWER_SESSION, runOwnerAnswer } from '../../../owner/answer.js'
import { requestDecision, requestFromOwnerShell } from '../../../policy/decisions/add.js'
import { ANSWER_SOURCE } from '../../../window/window-requests.js'

const ADD = 'scripts/policy/decisions/add.ts'
const ANSWER = 'scripts/owner/answer.ts'
const WINDOW_REQUESTS = 'scripts/window/window-requests.ts'
const NOW = new Date('2026-11-21T10:00:00.000Z')
const GIVEN_REQUEST = 41

const opened: DatabaseSync[] = []
const dirs: string[] = []

function scratch(): { db: DatabaseSync, channel: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'decisions-window-runner-'))
  dirs.push(dir)
  const db = openBus(path.join(dir, 'bus.db'))
  opened.push(db)
  return { db, channel: path.join(dir, 'channel') }
}

function eventCount(db: DatabaseSync): number {
  return (db.prepare('SELECT COUNT(*) AS count FROM events').get() as { count: number }).count
}

afterEach(() => {
  for (const db of opened.splice(0))
    db.close()
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

describe('add.ts and answer.ts take the window runner from their entry block', () => {
  it('neither file reaches the window requests module past the one door it already has', () => {
    const { graph } = repositoryReport()
    expect(graph.imports.filter(({ from, to }) => (from === ADD || from === ANSWER) && to === WINDOW_REQUESTS)).toEqual([])
  })

  it('requestDecision carries the decision through the runner it is given, and the bus sees nothing else', () => {
    const { db } = scratch()
    const before = eventCount(db)
    const asked: { argv: readonly string[], session: string }[] = []
    const out: string[] = []
    const code = requestDecision(['--from', 'answer', '--card', '#5', '--creates', 'src/new.ts', '[owner] x.'], db, NOW, 'window-1', line => out.push(line), (argv, _db, _now, session, said) => {
      asked.push({ argv, session })
      said(`window.request ${GIVEN_REQUEST} (${argv[0]})`)
      return 0
    })
    expect(code).toBe(0)
    expect(asked).toEqual([
      { argv: ['amend', '--card', '5', '--touches', '+src/new.ts', '--auto-confirm'], session: 'window-1' },
      { argv: ['decisions:add', '--from', 'answer', '--card', '#5', '[owner] x.'], session: 'window-1' },
    ])
    expect(out.join('\n')).toContain(`window.request ${GIVEN_REQUEST}`)
    expect(eventCount(db)).toBe(before)
  })

  it('the owner shell passes its runner down to the decision request', () => {
    const { db, channel } = scratch()
    const asked: (readonly string[])[] = []
    expect(requestFromOwnerShell(['[owner] y.'], channel, db, NOW, () => {}, () => {}, (argv) => {
      asked.push(argv)
      return 0
    })).toBe(0)
    expect(asked).toEqual([['decisions:add', '--from', 'answer', '[owner] y.']])
  })

  it('runOwnerAnswer hands an answer and a stop to the window through the request it is given', () => {
    const { db, channel } = scratch()
    const before = eventCount(db)
    const handed: { session: string, request: Record<string, unknown> }[] = []
    const toWindow = (_db: DatabaseSync, _ts: string, session: string, request: Record<string, unknown>): number => {
      handed.push({ session, request })
      return GIVEN_REQUEST
    }
    const out: string[] = []
    expect(runOwnerAnswer(['Q7', 'go'], db, channel, NOW, line => out.push(line), toWindow)).toBe(0)
    expect(runOwnerAnswer(['#9', 'stop: wrong path'], db, channel, NOW, line => out.push(line), toWindow)).toBe(0)
    expect(handed).toEqual([
      { session: ANSWER_SESSION, request: { kind: 'owner.answer', id: 'Q7', text: 'go', from: ANSWER_SOURCE } },
      { session: ANSWER_SESSION, request: { kind: 'owner.stop', card: 9, reason: 'wrong path', from: ANSWER_SOURCE } },
    ])
    expect(out.every(line => line.includes(`window.request ${GIVEN_REQUEST}`))).toBe(true)
    expect(eventCount(db)).toBe(before)
  })
})
