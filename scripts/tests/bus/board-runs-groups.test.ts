import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { runsFieldLine } from '../../../src/card/witness-fields.js'
import { writeBus } from '../../../tests/board/bus-fixture.js'
import { printBoard } from '../../cli/board-page.js'

const NOW = new Date('2026-11-05T12:00:00.000Z')
const CARD = 871
const TOUCH = 'scripts/cli/board-page.ts'
const WITNESSES = ['Witnesses:', '- `pnpm exec vitest run tests/a.test.ts` exits 0']
const CATALOG_TESTS: [string, string][] = [['scripts/tests/bus/one.test.ts', 'bus'], ['scripts/tests/bus/two.test.ts', 'bus'], ['tests/src-only.test.ts', 'src']]
const CATALOG_MODULES: [string, string][] = [[TOUCH, 'bus']]
const EXPLICIT_LANE = '<div class="runs-group" data-lane="tests"><p class="runs-name">tests</p><p><span class="tag">explicit.test.ts</span></p></div>'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function cardText(touch: string, ...tail: string[]): string {
  return [
    `card: #${CARD} groups [implement/netwatch/S/cheap/owner] · depends — · blocks —`,
    'branch: feat/groups',
    `touches: ${touch}`,
    'continue: stop',
    'who: shift',
    '',
    'The card.',
    '',
    ...tail,
    '',
  ].join('\n')
}

function dialogOf(text: string, state = 'in_review'): string {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-board-runs-groups-'))
  roots.push(root)
  const file = path.join(root, 'bus.db')
  writeBus(file, {
    cards: [{ id: CARD, state, lane: 'lane-1', line: `#${CARD} groups`, since: NOW.toISOString(), pr: 40, text }],
    prs: [{ pr: 40, card: CARD, state: 'open' }],
    events: [{ ts: NOW.toISOString(), type: 'netwatch.tick', card: null, payload: '{}' }],
  })
  const db = new DatabaseSync(file)
  db.exec('ALTER TABLE card_bodies ADD COLUMN admission_event_id INTEGER; ALTER TABLE card_bodies ADD COLUMN text_sha TEXT NOT NULL DEFAULT \'\'; ALTER TABLE prs ADD COLUMN head TEXT')
  db.exec('UPDATE card_bodies SET admission_event_id = (SELECT event_id FROM cards WHERE cards.card_id = card_bodies.card_id)')
  db.exec('CREATE TABLE check_tests (test TEXT, layer TEXT); CREATE TABLE check_modules (module TEXT, layers TEXT)')
  for (const row of CATALOG_TESTS)
    db.prepare('INSERT INTO check_tests VALUES (?, ?)').run(...row)
  for (const row of CATALOG_MODULES)
    db.prepare('INSERT INTO check_modules VALUES (?, ?)').run(...row)
  db.close()
  let html = ''
  expect(printBoard(file, NOW, (written) => {
    html += written
  }, path.join(root, 'miko.md'), 'html')).toBe(0)
  return new RegExp(`<template id="dialog-card-${CARD}">([\\s\\S]*?)</template>`).exec(html)![1]!
}

describe('the board groups a card\'s runs by layer', () => {
  it('the board draws a group per layer and the explicit paths apart', () => {
    const dialog = dialogOf(cardText(TOUCH, runsFieldLine(['layer:bus', 'tests/explicit.test.ts']), ...WITNESSES))
    expect(dialog).toContain('<div class="runs-group" data-group="bus"><p class="runs-name">layer bus</p>')
    expect(dialog).toContain('<span class="tag">one.test.ts</span> <span class="tag">two.test.ts</span>')
    expect(dialog).toContain(`<p>runs:</p>${EXPLICIT_LANE}`)
    expect(dialog).not.toContain('src-only.test.ts')
  })

  it('a derived reading is marked and a full reading prints its why', () => {
    const derived = dialogOf(cardText(TOUCH, ...WITNESSES))
    expect(derived).toContain('<div class="runs-group" data-group="bus" data-derived><p class="runs-name">layer bus · derived from touches</p>')
    const full = dialogOf(cardText('nowhere/x.ts', runsFieldLine(['tests/explicit.test.ts']), ...WITNESSES))
    expect(full).toContain('<p class="runs-full">full run: nowhere/x.ts belongs to no layer of the check catalog</p>')
    expect(full).toContain(`<p>runs:</p>${EXPLICIT_LANE}`)
    expect(full).not.toContain('data-group')
  })

  it('a card of explicit paths still shows them', () => {
    const dialog = dialogOf(cardText(TOUCH, runsFieldLine(['tests/explicit.test.ts']), ...WITNESSES))
    expect(dialog).toContain(`<p>runs:</p>${EXPLICIT_LANE}`)
  })

  it('a settled card prints what is written and derives nothing', () => {
    const dialog = dialogOf(cardText(TOUCH, runsFieldLine(['layer:bus', 'tests/explicit.test.ts']), ...WITNESSES), 'merged')
    expect(dialog).toContain(`<p>runs:</p>${EXPLICIT_LANE}<div class="runs-group" data-lane="layer:bus"><p class="runs-name">layer:bus</p></div>`)
    expect(dialog).not.toContain('data-group')
    expect(dialog).not.toContain('one.test.ts')
  })
})
