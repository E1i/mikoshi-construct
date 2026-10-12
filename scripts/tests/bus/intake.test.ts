import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runMain } from 'citty'
import { afterEach, describe, expect, it } from 'vitest'
import { runAdmit } from '../../../src/commands/intake/admit.js'
import { CARD_ADMITTED, CARD_MOVED } from '../../../src/commands/intake/index.js'
import { runMove } from '../../../src/commands/intake/move.js'
import { createMain } from '../../../src/program.js'
import { parkingLane } from '../../bus/admissions.js'
import { openBus } from '../../bus/db.js'
import { importJournalFile } from '../../bus/import.js'
import { busCardEvents } from '../../bus/intake.js'

const NOW = new Date('2026-10-12T16:00:00.000Z')
const CARD = '#90 port-card [implement/netwatch/S/cheap/auto] · depends — · blocks —'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

interface World { root: string, parking: string, journal: string, repo: string, bus: string }

function world(): World {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-intake-'))
  roots.push(root)
  const repo = path.join(root, 'repo')
  mkdirSync(path.join(repo, 'src'), { recursive: true })
  writeFileSync(path.join(repo, 'src', 'a.ts'), '')
  return { root, parking: path.join(root, 'parking'), journal: path.join(root, 'handoff', 'ghosts.jsonl'), repo, bus: path.join(root, 'bus.db') }
}

function park(w: World, dir: string): string {
  const lane = path.join(w.parking, dir)
  mkdirSync(lane, { recursive: true })
  const file = path.join(lane, '90.md')
  writeFileSync(file, `card: ${CARD}\nbranch: feat/port-card\ntouches: src/a.ts\ncontinue: stop\nwho: shift\n\nDo the thing.\n`)
  return file
}

function cardEvents(w: World): Record<string, unknown>[] {
  const db = openBus(w.bus)
  try {
    return (db.prepare('SELECT type, actor, card_id, payload FROM events WHERE legacy = 0 ORDER BY id').all() as { type: string, actor: string, card_id: number, payload: string }[])
      .map(row => ({ type: row.type, actor: row.actor, cardId: row.card_id, payload: JSON.parse(row.payload) as unknown }))
  }
  finally {
    db.close()
  }
}

function withPort<T>(w: World, act: (events: ReturnType<typeof busCardEvents>) => T): T {
  const db = openBus(w.bus)
  try {
    return act(busCardEvents(db, 's1'))
  }
  finally {
    db.close()
  }
}

describe('pnpm intake writes card events to bus.db', () => {
  it('an --admit through the port writes card.admitted to the bus as the intake worker', () => {
    const w = world()
    const file = park(w, 'lane-7')
    expect(withPort(w, events => runAdmit({ file, dir: w.repo, journal: w.journal, dryRun: false, autoConfirm: false, parkingRoot: w.parking, events }, () => NOW)).status).toBe('admitted')
    expect(cardEvents(w)).toMatchObject([{ type: CARD_ADMITTED, actor: 'worker:intake:s1', cardId: 90, payload: { card: CARD, lane: 'lane-7', depends: [], decision: 'auto', contour: 'cheap' } }])
  })

  it('a move into a lane writes card.moved and a card.admitted that carries the card and the lane', () => {
    const w = world()
    park(w, '')
    expect(withPort(w, events => runMove({ move: '#90', to: 'lane-8', draft: undefined, taken: undefined, admit: undefined, parking: w.parking, journal: w.journal, events }, () => NOW)).status).toBe('moved')
    const [moved, admitted] = cardEvents(w)
    expect(moved).toMatchObject({ type: CARD_MOVED, cardId: 90, payload: { lane: 'lane-8' } })
    expect(admitted).toMatchObject({ type: CARD_ADMITTED, actor: 'worker:intake:s1', cardId: 90, payload: { card: CARD, lane: 'lane-8', depends: [], decision: 'auto', contour: 'cheap' } })
  })

  it('a move into a directory that is no lane writes card.moved alone', () => {
    const w = world()
    park(w, 'lane-7')
    expect(withPort(w, events => runMove({ move: '#90', to: 'notes', draft: undefined, taken: undefined, admit: undefined, parking: w.parking, journal: w.journal, events }, () => NOW)).status).toBe('moved')
    expect(cardEvents(w).map(event => event.type)).toEqual([CARD_MOVED])
  })

  it('the one-time import does not admit a second time a card the port admitted', () => {
    const w = world()
    const file = park(w, 'lane-7')
    withPort(w, events => runAdmit({ file, dir: w.repo, journal: w.journal, dryRun: false, autoConfirm: false, parkingRoot: w.parking, events }, () => NOW))
    const db = openBus(w.bus)
    expect(importJournalFile(db, w.journal, parkingLane(w.parking), () => NOW)).toMatchObject({ imported: 1, admitted: 0 })
    db.close()
    expect(cardEvents(w).filter(event => event.type === CARD_ADMITTED)).toHaveLength(1)
  })

  it('the CLI createMain builds reaches the port with the intake command\'s --admit', async () => {
    const w = world()
    const file = park(w, '')
    const db = openBus(w.bus)
    try {
      await runMain(createMain({ cardEvents: busCardEvents(db) }), { rawArgs: ['intake', '--admit', file, '--dir', w.repo, '--journal', w.journal, '--plain'] })
    }
    finally {
      db.close()
    }
    expect(cardEvents(w)).toMatchObject([{ type: CARD_ADMITTED, cardId: 90, payload: { card: CARD, lane: null } }])
    expect(readFileSync(w.journal, 'utf8')).toContain('"event":"intake"')
  })
})
