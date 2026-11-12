import type { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runAdmit } from '../../../src/commands/intake/admit.js'
import { runAmend } from '../../../src/commands/intake/amend.js'
import { runExport } from '../../../src/commands/intake/export.js'
import { admittedBodyText, cardBodyText } from '../../core/card-bodies.js'
import { openBus } from '../../core/db.js'
import { reduce } from '../../core/reducer.js'
import { busCardAdmissions, busIntakePorts } from '../../intake/intake.js'
import { busProjections } from '../../supervisor/composition.js'

const CARD = 1784
const LINE = `#${CARD} card-${CARD} [implement/ghosts/S/cheap/owner] · depends — · blocks —`
const WIDENED = 'The widening admitted first.'
const SECOND = 'The note amended right after.'
const AT = new Date('2026-11-10T14:59:38.000Z')
const WIDENED_AT = new Date('2026-11-10T15:00:00.000Z')
const AMENDED_AT = new Date('2026-11-10T15:00:09.000Z')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-C', cwd, '-c', 'user.name=world', '-c', 'user.email=world@example.invalid', ...args], { encoding: 'utf8', stdio: 'pipe' })
}

interface World { repo: string, parked: string, bus: string }

function newWorld(): World {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'amend-latest-admission-')))
  roots.push(root)
  const repo = path.join(root, 'main-tree')
  mkdirSync(path.join(repo, 'src'), { recursive: true })
  writeFileSync(path.join(repo, 'src', 'a.ts'), '')
  git(root, ['init', '-q', '-b', 'main', repo])
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'world'])
  const parking = path.join(root, 'parking')
  mkdirSync(parking)
  const parked = path.join(parking, `${CARD}.md`)
  writeFileSync(parked, `card: ${LINE}\nbranch: feat/card-${CARD}\ntouches: src/a.ts\ncontinue: stop\nwho: shift\n\nDo the thing.\n`)
  return { repo, parked, bus: path.join(root, 'bus', 'bus.db') }
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

function intakeOf(w: World, db: DatabaseSync) {
  const ports = busIntakePorts(db, 'by-hand', () => 1)
  return { dir: w.repo, dryRun: false, autoConfirm: true, parkingRoot: path.dirname(w.parked), events: ports.cardEvents, cardStates: ports.cardStates, admissions: ports.cardAdmissions }
}

function admitThenWidenUnfolded(w: World, db: DatabaseSync): void {
  const intake = intakeOf(w, db)
  expect(runAdmit({ ...intake, file: w.parked }, () => AT).status).toBe('admitted')
  reduce(db, 'pending', busProjections())
  expect(runAmend({ ...intake, card: `#${CARD}`, flags: { note: WIDENED } }, () => WIDENED_AT).status).toBe('admitted')
  expect(cardBodyText(db, CARD)).not.toContain(WIDENED)
}

describe('--amend and --export read the body from the latest card.admitted, not from a fold behind it', () => {
  it('an amend right after an admit builds on the admitted text and does not revert it', () => {
    const w = newWorld()
    inBus(w, (db) => {
      admitThenWidenUnfolded(w, db)
      expect(runAmend({ ...intakeOf(w, db), card: `#${CARD}`, flags: { note: SECOND } }, () => AMENDED_AT).status).toBe('admitted')
      const latest = admittedBodyText(db, CARD)
      expect(latest).toContain(WIDENED)
      expect(latest).toContain(SECOND)
      reduce(db, 'pending', busProjections())
      expect(cardBodyText(db, CARD)).toBe(latest)
    })
  })

  it('an export right after an admit shows the admitted text while the fold still holds the older one', () => {
    const w = newWorld()
    inBus(w, (db) => {
      admitThenWidenUnfolded(w, db)
      const exported = runExport({ card: `#${CARD}`, admissions: busCardAdmissions(db) })
      expect(exported.status).not.toBe('refused')
      expect('text' in exported ? exported.text : '').toContain(WIDENED)
    })
  })
})
