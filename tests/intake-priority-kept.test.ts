import type { AdmitResult } from '../src/commands/intake/admit.js'
import type { AmendFlags } from '../src/commands/intake/amend.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openBus } from '../scripts/core/db.js'
import { CARD_ADMITTED } from '../scripts/core/events.js'
import { reduce } from '../scripts/core/reducer.js'
import { busCardAdmissions, busCardEvents } from '../scripts/intake/intake.js'
import { parseParkingFile } from '../src/card/parking.js'
import { runAdmit } from '../src/commands/intake/admit.js'
import { amendedText, runAmend } from '../src/commands/intake/amend.js'
import { parseDraft } from '../src/commands/intake/draft.js'

const START = Date.parse('2026-11-10T09:00:00.000Z')
let tick = 0

function now(): Date {
  tick += 1
  return new Date(START + tick * 1000)
}
const CARD = '#80 order-card [implement/runner/S/cheap/owner] · depends — · blocks —'
const WITNESS = '`pnpm exec vitest run tests/a.test.ts` exits 0; red on main'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

interface World { parking: string, repo: string, bus: string, decisions: string }

function world(): World {
  const root = mkdtempSync(path.join(tmpdir(), 'intake-priority-'))
  roots.push(root)
  const repo = path.join(root, 'repo')
  mkdirSync(path.join(repo, 'src', 'board'), { recursive: true })
  writeFileSync(path.join(repo, 'src', 'board', 'run.ts'), '')
  const parking = path.join(root, 'parking')
  mkdirSync(parking, { recursive: true })
  return { parking, repo, bus: path.join(root, 'bus.db'), decisions: path.join(root, 'owner-decisions.md') }
}

function cardText(body: string, priority?: string): string {
  const header = [`card: ${CARD}`, 'branch: feat/card-80', 'touches: src/board/run.ts', 'continue: stop', 'who: shift', ...(priority === undefined ? [] : [`priority: ${priority}`])]
  return `${header.join('\n')}\n\n${body}\n\nWitnesses:\n- ${WITNESS}\n`
}

function withBus<T>(w: World, run: (ports: { events: ReturnType<typeof busCardEvents>, admissions: ReturnType<typeof busCardAdmissions> }) => T): T {
  const db = openBus(w.bus)
  try {
    const result = run({ events: busCardEvents(db), admissions: busCardAdmissions(db) })
    reduce(db)
    return result
  }
  finally {
    db.close()
  }
}

function admit(w: World, text: string): AdmitResult {
  const file = path.join(w.parking, '80.md')
  writeFileSync(file, text)
  const result = withBus(w, ({ events, admissions }) => runAdmit({ file, dir: w.repo, dryRun: false, autoConfirm: true, parkingRoot: w.parking, decisions: w.decisions, events, admissions, cardStates: () => new Map() }, now))
  rmSync(file)
  return result
}

function amend(w: World, flags: AmendFlags): AdmitResult {
  return withBus(w, ({ events, admissions }) => runAmend({ card: '#80', flags, dir: w.repo, dryRun: false, autoConfirm: true, parkingRoot: w.parking, decisions: w.decisions, events, admissions, cardStates: () => new Map() }, now))
}

function latest(w: World): { text: string, bodySha: string } {
  const db = openBus(w.bus)
  try {
    return db.prepare(`SELECT json_extract(payload, '$.text') AS text, json_extract(payload, '$.bodySha') AS bodySha FROM events WHERE type = ? AND card_id = 80 ORDER BY id DESC LIMIT 1`).get(CARD_ADMITTED) as { text: string, bodySha: string }
  }
  finally {
    db.close()
  }
}

function priorityOf(text: string): string | null {
  const parsed = parseParkingFile('80.md', text)
  return parsed.kind === 'parked' ? parsed.parked.priority : null
}

describe('the owner order survives an amend or a readmission', () => {
  it('a readmission whose text has no priority line keeps the priority of the latest admission', () => {
    const w = world()
    expect(admit(w, cardText('Do the thing.', 'p2'))).toMatchObject({ status: 'admitted' })
    expect(priorityOf(latest(w).text)).toBe('p2')

    expect(admit(w, cardText('Do the thing, sliced again.'))).toMatchObject({ status: 'admitted', source: 'amend' })
    expect(priorityOf(latest(w).text)).toBe('p2')
    expect(latest(w).text).toContain('Do the thing, sliced again.')

    expect(amend(w, { note: 'A note.' })).toMatchObject({ status: 'admitted', source: 'amend' })
    expect(priorityOf(latest(w).text)).toBe('p2')
  })

  it('a readmission that names a priority of its own takes it', () => {
    const w = world()
    admit(w, cardText('Do the thing.', 'p2'))
    expect(admit(w, cardText('Do the thing.', 'p0'))).toMatchObject({ status: 'admitted', source: 'amend' })
    expect(priorityOf(latest(w).text)).toBe('p0')
  })

  it('a first admission with no priority line stays without one', () => {
    const w = world()
    admit(w, cardText('Do the thing.'))
    expect(priorityOf(latest(w).text)).toBeNull()
  })

  it('an amend with --priority sets the priority and leaves the card body alone', () => {
    const w = world()
    admit(w, cardText('Do the thing.'))
    const before = latest(w).bodySha
    expect(amend(w, { priority: 'p1' })).toMatchObject({ status: 'admitted', source: 'amend' })
    expect(priorityOf(latest(w).text)).toBe('p1')
    expect(latest(w).bodySha).toBe(before)
    expect(amend(w, { priority: 'p0' })).toMatchObject({ status: 'admitted' })
    expect(priorityOf(latest(w).text)).toBe('p0')
  })

  it('an amend with --priority none clears the priority', () => {
    const w = world()
    admit(w, cardText('Do the thing.', 'p0'))
    expect(amend(w, { priority: 'none' })).toMatchObject({ status: 'admitted', source: 'amend' })
    expect(priorityOf(latest(w).text)).toBeNull()

    expect(admit(w, cardText('Do the thing again.'))).toMatchObject({ status: 'admitted' })
    expect(priorityOf(latest(w).text)).toBeNull()
  })

  it('an amend with a priority outside p0, p1, p2 and none is refused', () => {
    expect(amendedText(cardText('Do the thing.'), { priority: 'p9' })).toEqual({ kind: 'refused', why: '--priority p9 is one of p0, p1, p2, none' })
    expect(amendedText(cardText('Do the thing.', 'p1'), { priority: 'none' })).toEqual({ kind: 'edited', text: cardText('Do the thing.') })
  })
})

describe('a JSON draft carries a priority', () => {
  const card = { name: 'order-card', kind: 'implement', milestone: 'runner', size: 'S', task: 'Do the thing.', touches: ['src/board/run.ts'], witnesses: [WITNESS] }

  it('accepts p0, p1 or p2', () => {
    expect(parseDraft(JSON.stringify({ cards: [{ ...card, priority: 'p1' }] }))).toMatchObject({ kind: 'draft', cards: [{ priority: 'p1' }] })
  })

  it('refuses any other priority', () => {
    expect(parseDraft(JSON.stringify({ cards: [{ ...card, priority: 'urgent' }] }))).toEqual({ kind: 'refused', reasons: [`card 1: 'priority' is one of p0, p1, p2 when given`] })
  })
})
