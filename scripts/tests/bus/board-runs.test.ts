import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { runsFieldLine } from '../../../src/card/witness-fields.js'
import { writeBus } from '../../../tests/board/bus-fixture.js'
import { printBoard } from '../../cli/board-page.js'

const NOW = new Date('2026-11-05T12:00:00.000Z')
const CARD = 870
const WITNESSES = ['Witnesses:', '- `pnpm exec vitest run tests/a.test.ts` exits 0']

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function cardText(...tail: string[]): string {
  return [
    `card: #${CARD} prose [implement/netwatch/S/cheap/owner] · depends — · blocks —`,
    'branch: feat/prose',
    'touches: scripts/cli/board-page.ts',
    'continue: stop',
    'who: shift',
    '',
    'The prose card.',
    '',
    ...tail,
    '',
  ].join('\n')
}

function dialogOf(text: string): string {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-board-runs-'))
  roots.push(root)
  const file = path.join(root, 'bus.db')
  writeBus(file, {
    cards: [{ id: CARD, state: 'in_review', lane: 'lane-1', line: `#${CARD} prose`, since: NOW.toISOString(), pr: 40, text }],
    prs: [{ pr: 40, card: CARD, state: 'open' }],
    events: [{ ts: NOW.toISOString(), type: 'netwatch.tick', card: null, payload: '{}' }],
  })
  const db = new DatabaseSync(file)
  db.exec('ALTER TABLE card_bodies ADD COLUMN admission_event_id INTEGER; ALTER TABLE card_bodies ADD COLUMN text_sha TEXT NOT NULL DEFAULT \'\'; ALTER TABLE prs ADD COLUMN head TEXT')
  db.exec('UPDATE card_bodies SET admission_event_id = (SELECT event_id FROM cards WHERE cards.card_id = card_bodies.card_id)')
  db.close()
  let html = ''
  expect(printBoard(file, NOW, (written) => {
    html += written
  }, path.join(root, 'miko.md'), 'html')).toBe(0)
  return new RegExp(`<template id="dialog-card-${CARD}">([\\s\\S]*?)</template>`).exec(html)![1]!
}

const RUNS_LANES = '<p>runs:</p><div class="runs-group" data-lane="tests/board/**" data-glob><p class="runs-name">tests/board/** · вся папка</p></div><div class="runs-group" data-lane="tests"><p class="runs-name">tests</p><p><span class="tag">a.test.ts</span></p></div>'

describe('the board draws a card\'s runs from the parsed field', () => {
  it('a card with a prose Runs line and no witness fields shows its runs as a list and no prose Runs line', () => {
    const dialog = dialogOf(cardText('Runs: tests/board/**, tests/a.test.ts', '', ...WITNESSES))
    expect(dialog).toContain(RUNS_LANES)
    expect(dialog).not.toContain('Runs:')
    expect(dialog).toContain('<h3>Witnesses</h3><ul><li>')
    expect(dialog).not.toContain('data-witnesses')
  })

  it('a card with a runs field and text witnesses shows the same list', () => {
    const dialog = dialogOf(cardText(runsFieldLine(['tests/board/**', 'tests/a.test.ts']), ...WITNESSES))
    expect(dialog).toContain(RUNS_LANES)
    expect(dialog).not.toContain('runs: [')
  })

  it('a card with no runs shows no runs line', () => {
    expect(dialogOf(cardText(...WITNESSES))).not.toContain('<p>runs:')
  })
})
