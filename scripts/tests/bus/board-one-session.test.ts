import type { SeedEvent } from '../../../tests/board/bus-fixture.js'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { writeBus } from '../../../tests/board/bus-fixture.js'
import { printBoard } from '../../cli/board-page.js'
import { SESSION_HEARTBEAT } from '../../core/events.js'

const NOW = new Date('2026-10-20T08:00:00.000Z')
const CARD = 861
const CARD_OF_NO_STAGE = 862
const SESSION = 's-one'
const AGENT_SPEND = 1_000_000
const WARN_RATIO = 0.8
const CARD_TEXT = [
  `card: #${CARD} second [implement/netwatch/S/cheap/owner] · depends — · blocks —`,
  'branch: feat/second',
  'touches: scripts/cli/board-page.ts',
  'continue: stop',
  'who: shift',
  '',
  'The card.',
].join('\n')

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function minutesAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString()
}

function beat(minutes: number, session: string, step: string, fields: object = {}, card: number = CARD): SeedEvent {
  return { ts: minutesAgo(minutes), type: SESSION_HEARTBEAT, card, payload: JSON.stringify({ step, session, ...fields }) }
}

function pageOf(events: SeedEvent[], roles: { role: string, status: string, state: string }[] = []): string {
  const root = mkdtempSync(path.join(tmpdir(), 'board-one-session-'))
  roots.push(root)
  const busPath = path.join(root, 'bus.db')
  writeBus(busPath, { cards: [{ id: CARD, state: 'running', lane: 'lane-1', line: `#${CARD} second`, since: minutesAgo(20), text: CARD_TEXT }], roles, events })
  const db = new DatabaseSync(busPath)
  db.exec('ALTER TABLE card_bodies ADD COLUMN admission_event_id INTEGER; ALTER TABLE card_bodies ADD COLUMN text_sha TEXT NOT NULL DEFAULT \'\'')
  db.exec('UPDATE card_bodies SET admission_event_id = (SELECT event_id FROM cards WHERE cards.card_id = card_bodies.card_id)')
  db.close()
  const eddiesFile = path.join(root, 'eddies.json')
  writeFileSync(eddiesFile, JSON.stringify({ contextLimit: 1_000_000, cardContextLine: 900_000, sessionSpend: 10_000_000, agentSpend: AGENT_SPEND, warnRatio: WARN_RATIO }))
  let html = ''
  expect(printBoard(busPath, NOW, (text) => {
    html += text
  }, path.join(root, 'miko.md'), 'html', eddiesFile)).toBe(0)
  return html
}

function tilesOf(html: string, role: string): string[] {
  return [...html.matchAll(new RegExp(`<div class="svc bevel" data-role="${role}"[\\s\\S]*?(?=<div class="svc bevel" |</section>)`, 'g'))].map(match => match[0])
}

function agentsCount(html: string): number {
  return Number(/agents at work <b>(\d+)<\/b>/.exec(html)![1])
}

describe('the board draws one tile per session', () => {
  it('two beats with one session id draw one tile', () => {
    const html = pageOf([beat(3, SESSION, 'launch'), beat(1, SESSION, 'launch')])
    expect(tilesOf(html, 'launch')).toHaveLength(1)
    expect(agentsCount(html)).toBe(1)
  })

  it('a session that replaced another of the same card and role draws no second tile', () => {
    const html = pageOf([
      beat(9, 's-first', 'launch', { context: 111_000 }),
      beat(7, 's-second', 'launch', { context: 222_000 }),
      beat(5, 's-third', 'launch', { context: 333_000 }),
    ])
    const tiles = tilesOf(html, 'launch')
    expect(tiles).toHaveLength(1)
    expect(tiles[0]).toContain('333k')
    expect(tiles[0]).not.toContain('111k')
    expect(agentsCount(html)).toBe(1)
  })

  it('launch and answer sessions of one card each read the gauges of their own session', () => {
    const html = pageOf([
      beat(3, 's-launch', 'launch', { context: 120_000 }, CARD_OF_NO_STAGE),
      beat(2, 's-answer', 'answer', { context: 240_000 }, CARD_OF_NO_STAGE),
    ])
    const [launch] = tilesOf(html, 'launch')
    const [answer] = tilesOf(html, 'answer')
    expect(launch).toContain('120k')
    expect(launch).not.toContain('240k')
    expect(answer).toContain('240k')
    expect(answer).not.toContain('120k')
    expect(agentsCount(html)).toBe(2)
  })
})
