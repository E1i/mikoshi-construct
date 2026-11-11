import type { DecisionsPort } from '../scripts/policy/decisions/decisions.js'
import type { AdmitOptions, AdmitResult } from '../src/commands/intake/admit.js'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openBus } from '../scripts/core/db.js'
import { reduce } from '../scripts/core/reducer.js'
import { busCardAdmissions, busCardEvents } from '../scripts/intake/intake.js'
import { decisionsOfProjection } from '../scripts/policy/decisions/decisions.js'

import { runAdmit } from '../src/commands/intake/admit.js'

const AT = new Date('2026-10-13T09:00:00.000Z')

function heldIn(file: string): DecisionsPort {
  return { inForce: () => decisionsOfProjection(existsSync(file) ? readFileSync(file, 'utf8') : '', AT).inForce() }
}
const FIRST = '`pnpm exec vitest run tests/a.test.ts` exits 0; red on main'
const SECOND = '`pnpm exec vitest run tests/b.test.ts` exits 0; red on main'
const INVARIANT = '`pnpm exec vitest run tests/c.test.ts` exits 0'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

interface World { root: string, parking: string, repo: string }

function world(): World {
  const root = mkdtempSync(path.join(tmpdir(), 'ownerrule-'))
  roots.push(root)
  const repo = path.join(root, 'repo')
  mkdirSync(path.join(repo, 'src', 'board'), { recursive: true })
  writeFileSync(path.join(repo, 'src', 'board', 'run.ts'), '')
  return { root, parking: path.join(root, 'parking'), repo }
}

function park(w: World, id: number, ...witnesses: string[]): string {
  mkdirSync(w.parking, { recursive: true })
  const file = path.join(w.parking, `${id}.md`)
  const body = `Do the thing.\n\nWitnesses:\n${witnesses.map(witness => `- ${witness}`).join('\n')}`
  writeFileSync(file, `card: #${id} card-${id} [implement/runner/S/cheap/owner] · depends — · blocks —\nbranch: feat/card-${id}\ntouches: src/board/**\ncontinue: stop\nwho: shift\n\n${body}\n`)
  return file
}

function decisionsOf(w: World): string {
  return path.join(w.root, 'owner-decisions.md')
}

function ownerSays(w: World, text: string, cards: readonly number[], tail = ''): void {
  writeFileSync(decisionsOf(w), `# Owner decisions\n\n- D-5 · 2026-10-13 — [owner] ${text} · card ${cards.map(id => `#${id}`).join(' ')} · decisions:add${tail}\n`)
}

function admit(w: World, file: string, options: Partial<AdmitOptions> = {}): AdmitResult {
  const db = openBus(path.join(w.root, 'bus.db'))
  try {
    const result = runAdmit({ file, dir: w.repo, dryRun: false, autoConfirm: false, parkingRoot: w.parking, events: busCardEvents(db), admissions: busCardAdmissions(db), cardStates: () => new Map(), decisions: heldIn(decisionsOf(w)), ...options }, () => AT)
    reduce(db)
    return result
  }
  finally {
    db.close()
  }
}

function admitThenDowngrade(w: World, id: number, before: readonly string[], after: readonly string[]): string {
  const file = park(w, id, ...before)
  expect(admit(w, file)).toMatchObject({ status: 'admitted', source: 'admit' })
  park(w, id, ...after)
  return file
}

describe('a general owner word on witness downgrades', () => {
  it('one owner word naming several cards allows the downgrade on each of them', () => {
    const w = world()
    const cards = [86, 85, 84]
    const files = cards.map(id => admitThenDowngrade(w, id, [FIRST], [INVARIANT]))
    ownerSays(w, `разрешить понижение свидетеля ${FIRST} у #86, #85 и #84`, cards)
    for (const file of files)
      expect(admit(w, file)).toMatchObject({ status: 'admitted', source: 'amend' })
  })

  it('one owner word that repeats the allowance per card allows it on each card it names', () => {
    const w = world()
    const six = admitThenDowngrade(w, 86, [FIRST], [INVARIANT])
    const five = admitThenDowngrade(w, 85, [FIRST], [INVARIANT])
    ownerSays(w, `разрешить понижение свидетеля ${FIRST} у #86; разрешить понижение свидетеля ${FIRST} у #85`, [86, 85])
    expect(admit(w, six)).toMatchObject({ status: 'admitted', source: 'amend' })
    expect(admit(w, five)).toMatchObject({ status: 'admitted', source: 'amend' })
  })

  it('a general owner word covers every witness of a named card', () => {
    const w = world()
    const file = admitThenDowngrade(w, 80, [FIRST, SECOND], [INVARIANT])
    ownerSays(w, 'разрешить понижение свидетелей у #80', [80])
    expect(admit(w, file)).toMatchObject({ status: 'admitted', source: 'amend' })
  })

  it('a general owner word does not reach a card it does not name', () => {
    const w = world()
    const file = admitThenDowngrade(w, 80, [FIRST], [INVARIANT])
    ownerSays(w, 'разрешить понижение свидетелей у #81', [81])
    expect(admit(w, file)).toMatchObject({ status: 'ownerWait', downgrades: [FIRST] })
  })

  it('an owner word naming one witness still holds another witness of the same card', () => {
    const w = world()
    const file = admitThenDowngrade(w, 80, [FIRST, SECOND], [INVARIANT])
    ownerSays(w, `разрешить понижение свидетеля ${FIRST} у #80`, [80])
    expect(admit(w, file)).toMatchObject({ status: 'ownerWait', downgrades: [FIRST, SECOND] })
  })
  it('a general owner word allows only the cards its own words name, not every card of its card list', () => {
    const w = world()
    const file = admitThenDowngrade(w, 80, [FIRST], [INVARIANT])
    ownerSays(w, 'разрешить понижение свидетелей у #81', [81, 80])
    expect(admit(w, file)).toMatchObject({ status: 'ownerWait', downgrades: [FIRST] })
  })

  it('an owner word allows nothing on a card its card list does not name', () => {
    const w = world()
    const file = admitThenDowngrade(w, 80, [FIRST], [INVARIANT])
    ownerSays(w, 'разрешить понижение свидетелей у #80', [81])
    expect(admit(w, file)).toMatchObject({ status: 'ownerWait', downgrades: [FIRST] })
  })

  it('a decision that quotes the witness without the allowance phrase allows nothing', () => {
    const w = world()
    const file = admitThenDowngrade(w, 80, [FIRST], [INVARIANT])
    ownerSays(w, `заметка: ${FIRST} у #80 краснеет на main`, [80])
    expect(admit(w, file)).toMatchObject({ status: 'ownerWait', downgrades: [FIRST] })
  })

  it('an allowance for one witness does not reach another witness the same line merely mentions', () => {
    const w = world()
    const file = admitThenDowngrade(w, 80, [FIRST, SECOND], [INVARIANT])
    ownerSays(w, `разрешить понижение свидетеля ${FIRST} у #80; ${SECOND} остаётся`, [80])
    expect(admit(w, file)).toMatchObject({ status: 'ownerWait', downgrades: [FIRST, SECOND] })
  })

  it('an allowance phrase naming the card for a different witness holds the downgraded one', () => {
    const w = world()
    const file = admitThenDowngrade(w, 80, [FIRST], [INVARIANT])
    ownerSays(w, `разрешить понижение свидетеля ${SECOND} у #80`, [80])
    expect(admit(w, file)).toMatchObject({ status: 'ownerWait', downgrades: [FIRST] })
  })

  it('a superseded general or per-witness owner word allows nothing', () => {
    for (const text of ['разрешить понижение свидетелей у #80', `разрешить понижение свидетеля ${FIRST} у #80`]) {
      const w = world()
      const file = admitThenDowngrade(w, 80, [FIRST], [INVARIANT])
      ownerSays(w, text, [80], ' · superseded-by D-6')
      expect(admit(w, file)).toMatchObject({ status: 'ownerWait', downgrades: [FIRST] })
    }
  })
})
