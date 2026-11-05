import type { SeedEvent } from '../../../tests/board/bus-fixture.js'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { LORE, PLAIN_LORE } from '../../../src/ui/lore.js'
import { writeBus } from '../../../tests/board/bus-fixture.js'
import { printBoard } from '../../cli/board-page.js'

const NOW = new Date('2026-10-20T08:00:00.000Z')
const CARD = 861
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

describe('the window tile', () => {
  it('the window tile and handoff dialog read FIXER MIKO in lore and window Miko in plain', () => {
    const html = pageOf([], [{ role: 'miko', status: 'idle', state: 'awake' }])
    expect(tilesOf(html, 'window')[0]).toContain('<span class="svc-kind">FIXER</span><span class="lore">MIKO</span>')
    expect(/<template id="[^"]*handoff">([\s\S]*?)<\/template>/.exec(html)![1]).toContain('MIKO')
    expect(html).not.toContain('Мико')
    expect([LORE.boardWindowRole, LORE.boardWindowName]).toEqual(['FIXER', 'MIKO'])
    expect([PLAIN_LORE.boardWindowRole, PLAIN_LORE.boardWindowName]).toEqual(['window', 'Miko'])
  })
})
