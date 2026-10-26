import type { DatabaseSync } from 'node:sqlite'
import type { ComposedTick } from '../../supervisor/run.js'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { busDirOf, decisionsFileOf, machineBusPath, repoHome } from '../../core/bus-path.js'
import { openBus } from '../../core/db.js'
import { DECISIONS_IMPORTED, REQUEST_DONE, REQUEST_REFUSED, WINDOW_REQUEST } from '../../core/events.js'
import { LIVE_FLAG } from '../../core/node.js'
import { OWNER_WORD_NOT_FOUND, ownerChannelOf, ownerChannelOfBus, sayToOwnerChannel } from '../../owner/channel.js'
import { inForceDecisions } from '../../policy/decisions.js'
import { TICK_MS } from '../../ports/netwatch.js'
import { composeBusTick } from '../../supervisor/run.js'
import { startingMode, wantedLaunches } from '../../supervisor/workers.js'
import { ANSWER_SOURCE, requestFromWindow } from '../../window/window-requests.js'
import { Clock, FakeGitHub } from '../bus/github-fake.js'

const ALLOW_LIVE_LAUNCH = '- D-1 · 2026-10-26 — [owner] allow-live launch · decisions:add'
const OTHER_REPO = 'E1i--other'

interface Bus {
  path: string
  db: DatabaseSync
  composed: ComposedTick
}

const roots: string[] = []
const opened: DatabaseSync[] = []

afterEach(() => {
  for (const db of opened.splice(0))
    db.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function newHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), 'decisions-per-bus-'))
  roots.push(home)
  return home
}

function busAt(home: string, busPath: string, clock: Clock): Bus {
  mkdirSync(path.dirname(busPath), { recursive: true })
  writeFileSync(decisionsFileOf(busPath), '# Owner decisions\n\n')
  const db = openBus(busPath)
  opened.push(db)
  return { path: busPath, db, composed: composeBusTick(db, busPath, new FakeGitHub().client, () => ({ status: 201, headers: {}, body: null }), clock.now, home) }
}

function twoBuses(): { home: string, clock: Clock, machine: Bus, repository: Bus } {
  const home = newHome()
  const clock = new Clock()
  return { home, clock, machine: busAt(home, machineBusPath(home), clock), repository: busAt(home, path.join(repoHome(home, OTHER_REPO), 'bus.db'), clock) }
}

function importedTexts(db: DatabaseSync): string[] {
  const rows = db.prepare('SELECT payload FROM events WHERE type = ?').all(DECISIONS_IMPORTED) as { payload: string }[]
  return rows.flatMap(row => (JSON.parse(row.payload) as { decisions: { text: string }[] }).decisions.map(decision => decision.text))
}

function answerOf(db: DatabaseSync, request: number): { type: string, detail: string } {
  const row = db.prepare('SELECT type, payload FROM events WHERE dedupe_key = ?').get(`${WINDOW_REQUEST}:${request}:answered`) as { type: string, payload: string }
  return { type: row.type, detail: (JSON.parse(row.payload) as { detail: string }).detail }
}

function liveLaunches(bus: Bus): string[] {
  startingMode(busDirOf(bus.path))
  return wantedLaunches(busDirOf(bus.path), () => [], inForceDecisions(bus.db)).filter(launch => launch.args.includes(LIVE_FLAG)).map(launch => launch.script)
}

describe('owner decisions belong to the bus of their repository', () => {
  it('names owner-decisions.md beside each bus, the machine bus keeping the machine file', () => {
    const home = newHome()
    expect(decisionsFileOf(machineBusPath(home))).toBe(path.join(home, '.construct', 'owner-decisions.md'))
    expect(decisionsFileOf(path.join(repoHome(home, OTHER_REPO), 'bus.db'))).toBe(path.join(home, '.construct', OTHER_REPO, 'owner-decisions.md'))
    expect(ownerChannelOfBus(home, machineBusPath(home))).toBe(ownerChannelOf(home))
    expect(ownerChannelOfBus(home, path.join(repoHome(home, OTHER_REPO), 'bus.db'))).toBe(path.join(ownerChannelOf(home), OTHER_REPO))
  })

  it('a decision written into the first bus\'s file never appears in a decisions.imported event of the second', () => {
    const { machine, repository } = twoBuses()
    writeFileSync(decisionsFileOf(machine.path), `# Owner decisions\n\n${ALLOW_LIVE_LAUNCH}\n`)

    expect(machine.composed.busTick.run()?.poll.kind).toBe('ticked')
    expect(repository.composed.busTick.run()?.poll.kind).toBe('ticked')

    expect(importedTexts(machine.db)).toEqual(['[owner] allow-live launch'])
    expect(importedTexts(repository.db)).toEqual([])
  })

  it('an allow-live launch decision of the first bus starts no node of the second with --live', () => {
    const { machine, repository } = twoBuses()
    writeFileSync(decisionsFileOf(machine.path), `# Owner decisions\n\n${ALLOW_LIVE_LAUNCH}\n`)
    machine.composed.busTick.run()
    repository.composed.busTick.run()

    expect(liveLaunches(machine)).not.toEqual([])
    expect(liveLaunches(repository)).toEqual([])
  })

  it('an owner word said for the first repository does not confirm decisions:add on the second', () => {
    const { home, clock, machine, repository } = twoBuses()
    const words = 'allow-live launch'
    sayToOwnerChannel(ownerChannelOfBus(home, machine.path), words, clock.now())
    const request = requestFromWindow(repository.db, clock.now().toISOString(), 'window-1', { kind: 'decisions:add', from: ANSWER_SOURCE, text: `[owner] ${words}` })

    repository.composed.busTick.run()

    expect(answerOf(repository.db, request)).toEqual({ type: REQUEST_REFUSED, detail: OWNER_WORD_NOT_FOUND })

    clock.advance(TICK_MS)
    sayToOwnerChannel(ownerChannelOfBus(home, repository.path), words, clock.now())
    const own = requestFromWindow(repository.db, clock.now().toISOString(), 'window-1', { kind: 'decisions:add', from: ANSWER_SOURCE, text: `[owner] ${words}` })
    expect(repository.composed.busTick.run()?.poll.kind).toBe('ticked')

    expect(answerOf(repository.db, own).type).toBe(REQUEST_DONE)
    expect(readFileSync(decisionsFileOf(repository.path), 'utf8')).toContain(`[owner] ${words}`)
    expect(readFileSync(decisionsFileOf(machine.path), 'utf8')).not.toContain(words)
  })
})
