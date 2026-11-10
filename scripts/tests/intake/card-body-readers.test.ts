import type { DatabaseSync } from 'node:sqlite'
import type { TaskStartDeps } from '../../ports/task-start.js'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { runAdmit } from '../../../src/commands/intake/admit.js'
import { runAmend } from '../../../src/commands/intake/amend.js'
import { BUS_DB_VARIABLE } from '../../core/bus-path.js'
import { admittedBodyText, busAdmittedBodies, cardBodyText } from '../../core/card-bodies.js'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_ADMITTED, CARD_STARTED } from '../../core/events.js'
import { reduce } from '../../core/reducer.js'
import { busIntakePorts } from '../../intake/intake.js'
import { realDeps, runTaskStart } from '../../ports/task-start.js'

const CARD = 1783
const LINE = `#${CARD} card-${CARD} [implement/ghosts/S/cheap/owner] · depends — · blocks —`
const AMENDED = 'The amended line.'
const AT = new Date('2026-11-10T09:00:00.000Z')
const AMENDED_AT = new Date('2026-11-10T09:01:00.000Z')
const roots: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=world', '-c', 'user.email=world@example.invalid', ...args], { encoding: 'utf8', stdio: 'pipe' })
}

function bodyOf(prose: string): string {
  return `card: ${LINE}\nbranch: feat/card-${CARD}\ntouches: src/a.ts\ncontinue: stop\nwho: window\n\n${prose}\n`
}

interface World { root: string, repo: string, parked: string, bus: string }

function newWorld(): World {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'card-body-readers-')))
  roots.push(root)
  const origin = path.join(root, 'origin.git')
  const repo = path.join(root, 'main-tree')
  mkdirSync(origin)
  git(origin, ['init', '-q', '--bare', '-b', 'main'])
  git(root, ['clone', '-q', origin, repo])
  mkdirSync(path.join(repo, 'src'))
  writeFileSync(path.join(repo, 'src', 'a.ts'), '')
  git(repo, ['checkout', '-q', '-b', 'main'])
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'world'])
  git(repo, ['push', '-q', 'origin', 'main'])
  const parking = path.join(root, 'parking')
  mkdirSync(parking)
  const parked = path.join(parking, `${CARD}.md`)
  writeFileSync(parked, bodyOf('Do the thing.'))
  return { root, repo, parked, bus: path.join(root, 'bus', 'bus.db') }
}

function inBus<T>(w: World, read: (db: DatabaseSync) => T): T {
  const db = openBus(w.bus)
  try {
    return read(db)
  }
  finally {
    db.close()
  }
}

function admitThenAmend(w: World): void {
  inBus(w, (db) => {
    const ports = busIntakePorts(db, 'by-hand', () => 1)
    const intake = { dir: w.repo, dryRun: false, autoConfirm: true, parkingRoot: path.dirname(w.parked), events: ports.cardEvents, cardStates: ports.cardStates, admissions: ports.cardAdmissions }
    expect(runAdmit({ ...intake, file: w.parked }, () => AT).status).toBe('admitted')
    reduce(db)
    expect(runAmend({ ...intake, card: `#${CARD}`, flags: { note: AMENDED } }, () => AMENDED_AT).status).toBe('admitted')
  })
}

function depsOf(w: World): TaskStartDeps {
  vi.stubEnv(BUS_DB_VARIABLE, w.bus)
  return {
    cwd: w.repo,
    git: (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }),
    install: () => {},
    exists: existsSync,
    bus: w.bus,
    now: () => AMENDED_AT,
    session: undefined,
    cardBody: realDeps().cardBody,
  }
}

function admittedLine(w: World): string {
  return inBus(w, db => (admittedBodyText(db, CARD) ?? '').split('\n')[0]!.slice('card: '.length))
}

function starts(w: World): Record<string, unknown>[] {
  return inBus(w, db => (db.prepare('SELECT payload FROM events WHERE type = ? AND card_id = ?').all(CARD_STARTED, CARD) as { payload: string }[]).map(row => JSON.parse(row.payload) as Record<string, unknown>))
}

describe('the card body is read from card.* events; the parking file is a projection nobody reads as input', () => {
  it('task start reads the body from events and ignores a differing parking file', () => {
    const w = newWorld()
    admitThenAmend(w)
    writeFileSync(w.parked, bodyOf('A parking body nobody admitted.'))
    const result = runTaskStart([`feat/card-${CARD}`, '--card', admittedLine(w)], depsOf(w))
    expect(result.stderr).toEqual([])
    expect(result.exitCode).toBe(0)
    expect(starts(w)).toMatchObject([{ who: 'window', admission: { by: 'bus' } }])
    expect(readFileSync(w.parked, 'utf8')).toContain('A parking body nobody admitted.')
  })

  it('the event reader holds the amended body before the reducer folds it, and the fold agrees after', () => {
    const w = newWorld()
    admitThenAmend(w)
    writeFileSync(w.parked, bodyOf('A parking body nobody admitted.'))
    const read = busAdmittedBodies(w.bus)
    expect(read(CARD)).toContain(AMENDED)
    expect(read(CARD)).not.toContain('A parking body nobody admitted.')
    inBus(w, (db) => {
      expect(cardBodyText(db, CARD)).not.toContain(AMENDED)
      reduce(db)
      expect(cardBodyText(db, CARD)).toBe(admittedBodyText(db, CARD))
    })
  })

  it('a card.admitted whose text does not match its textSha, a legacy one, or one without a text is not a body, and no bus is no body', () => {
    const w = newWorld()
    const legacyText = bodyOf('legacy')
    inBus(w, (db) => {
      appendEvent(db, { ts: AT.toISOString(), type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:forged`, payload: { card: LINE, text: bodyOf('forged'), textSha: 'f'.repeat(64) }, legacy: false })
      appendEvent(db, { ts: AT.toISOString(), type: CARD_ADMITTED, actor: 'journal', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:legacy`, payload: { card: LINE, text: legacyText, textSha: textSha(legacyText) }, legacy: true })
      appendEvent(db, { ts: AT.toISOString(), type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:no-text`, payload: { card: LINE, textSha: textSha('') }, legacy: false })
      appendEvent(db, { ts: AT.toISOString(), type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:number-text`, payload: { card: LINE, text: 42, textSha: textSha('42') }, legacy: false })
      expect(db.prepare('SELECT COUNT(*) AS n FROM events WHERE type = ? AND card_id = ?').get(CARD_ADMITTED, CARD)).toEqual({ n: 4 })
    })
    expect(busAdmittedBodies(w.bus)(CARD)).toBeNull()
    expect(busAdmittedBodies(path.join(w.root, 'no-bus.db'))(CARD)).toBeNull()
  })
})
