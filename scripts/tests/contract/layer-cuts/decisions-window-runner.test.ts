import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { repositoryReport } from '../../../contract/module-graph/report.js'
import { openBus } from '../../../core/db.js'
import { ANSWER_SOURCE } from '../../../core/inbox.js'
import { ANSWER_SESSION, runOwnerAnswer } from '../../../owner/answer.js'
import { requestDecision, requestFromOwnerShell } from '../../../policy/decisions/add.js'

const ADD = 'scripts/policy/decisions/add.ts'
const ANSWER = 'scripts/owner/answer.ts'
const WINDOW_REQUESTS = 'scripts/window/window-requests.ts'
const DOOR = 'scripts/policy/decisions/window-door.ts'
const INBOX = 'scripts/core/inbox.ts'
const REPO = path.resolve(import.meta.dirname, '../../../..')
const MAIN_GUARD = /^if \(process\.argv\[1\] !== undefined/
const DOOR_IMPORT = /from '[^']*window-door\.js'/
const RUNNERS_OF: Record<string, readonly string[]> = { [ADD]: ['runRequest', 'SESSION_VARIABLE'], [ANSWER]: ['requestFromWindow'] }
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

function sourceLines(file: string): string[] {
  return readFileSync(path.join(REPO, file), 'utf8').split('\n')
}

function linesNaming(lines: readonly string[], name: string): number[] {
  const word = new RegExp(`\\b${name}\\b`)
  return lines.flatMap((line, at) => word.test(line) && !DOOR_IMPORT.test(line) ? [at] : [])
}

function decisionsViolationsInto(holder: string): string[] {
  return repositoryReport().violations.filter(v => v.fromModule === 'decisions' && v.toHolder === holder).map(({ from, to }) => `${from} -> ${to}`)
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
  it('the door is imported only by the two entry files and is their only way into the window', () => {
    const { graph } = repositoryReport()
    const sourceImporters = graph.imports.filter(({ from, to }) => to === DOOR && !from.startsWith('scripts/tests/')).map(({ from }) => from).sort()
    expect(sourceImporters).toEqual([ANSWER, ADD])
    expect(graph.imports.filter(({ from, to }) => (from === ADD || from === ANSWER) && to.startsWith('scripts/window/'))).toEqual([])
  })

  it('the door carries only the window runners and the session variable, and answer.ts takes ANSWER_SOURCE from inbox', () => {
    const exported = /export \{([^}]*)\}/.exec(readFileSync(path.join(REPO, DOOR), 'utf8'))![1]!.split(',').map(name => name.trim()).sort()
    expect(exported).toEqual(['SESSION_VARIABLE', 'requestFromWindow', 'runRequest'])
    expect(repositoryReport().graph.imports.some(({ from, to }) => from === ANSWER && to === INBOX)).toBe(true)
  })

  it.each(Object.entries(RUNNERS_OF))('%s names what it takes from the door only in its entry block', (file, names) => {
    const lines = sourceLines(file)
    const guard = lines.findIndex(line => MAIN_GUARD.test(line))
    expect(guard).toBeGreaterThan(0)
    for (const name of names) {
      const named = linesNaming(lines, name)
      expect(named.length, name).toBeGreaterThan(0)
      expect(named.filter(at => at < guard), name).toEqual([])
    }
  })

  it('the decisions row into window stays the one door import, and ports, a lower layer, is no violation', () => {
    expect(decisionsViolationsInto('window')).toEqual([`${DOOR} -> ${WINDOW_REQUESTS}`])
    expect(decisionsViolationsInto('ports')).toEqual([])
    const ratchet = JSON.parse(readFileSync(path.join(REPO, 'contract/ratchet.json'), 'utf8')) as Record<string, number>
    expect([ratchet['boundary:decisions->window'], ratchet['boundary:decisions->ports']]).toEqual([1, undefined])
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
