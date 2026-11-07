import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { runsFieldLine } from '../../../src/card/witness-fields.js'
import { writeBus } from '../../../tests/board/bus-fixture.js'
import { printBoard } from '../../cli/board-page.js'

const NOW = new Date('2026-11-05T12:00:00.000Z')
const CARD = 872
const TOUCH = 'scripts/cli/board-page.ts'
const COVERED_TOUCH = 'tests/a/touched.test.ts'
const WITNESSES = ['Witnesses:', '- `pnpm exec vitest run tests/a.test.ts` exits 0']
const CATALOG_TESTS: [string, string][] = [['scripts/tests/bus/one.test.ts', 'bus'], ['scripts/tests/bus/two.test.ts', 'bus'], ['tests/src-only.test.ts', 'src']]
const CATALOG_MODULES: [string, string][] = [[TOUCH, 'bus']]

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function cardText(touch: string, ...tail: string[]): string {
  return [
    `card: #${CARD} lanes [implement/netwatch/S/cheap/owner] · depends — · blocks —`,
    'branch: feat/lanes',
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
  const root = mkdtempSync(path.join(tmpdir(), 'bus-board-runs-lanes-'))
  roots.push(root)
  const file = path.join(root, 'bus.db')
  writeBus(file, {
    cards: [{ id: CARD, state, lane: 'lane-1', line: `#${CARD} lanes`, since: NOW.toISOString(), pr: 40, text }],
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

function lanesOf(dialog: string): string[] {
  return dialog.match(/data-lane="[^"]*"/g) ?? []
}

describe('the board draws a card\'s runs as lanes', () => {
  it('runs a mask, a file under it and a file in another folder draw two lanes with the file inside the mask by its name alone', () => {
    const dialog = dialogOf(cardText(COVERED_TOUCH, runsFieldLine(['tests/a/**', 'tests/a/x.test.ts', 'tests/b/y.test.ts']), ...WITNESSES))
    expect(lanesOf(dialog)).toEqual(['data-lane="tests/a/**"', 'data-lane="tests/b"'])
    expect(dialog).toContain('<div class="runs-group" data-lane="tests/a/**" data-glob><p class="runs-name">tests/a/**</p><p><span class="tag">x.test.ts</span></p></div>')
    expect(dialog).toContain('<div class="runs-group" data-lane="tests/b"><p class="runs-name">tests/b</p><p><span class="tag">y.test.ts</span></p></div>')
    expect(dialog).not.toContain('tests/a/x.test.ts')
    expect(dialog).not.toContain('tests/b/y.test.ts')
  })

  it('a file sits in the narrowest mask that covers it, whatever the order of the runs', () => {
    const dialog = dialogOf(cardText(COVERED_TOUCH, runsFieldLine(['tests/a/b/x.test.ts', 'tests/a/**', 'tests/a/b/**', 'tests/a/y.test.ts']), ...WITNESSES))
    expect(lanesOf(dialog)).toEqual(['data-lane="tests/a/b/**"', 'data-lane="tests/a/**"'])
    expect(dialog).toContain('<div class="runs-group" data-lane="tests/a/b/**" data-glob><p class="runs-name">tests/a/b/**</p><p><span class="tag">x.test.ts</span></p></div>')
    expect(dialog).toContain('<div class="runs-group" data-lane="tests/a/**" data-glob><p class="runs-name">tests/a/**</p><p><span class="tag">y.test.ts</span></p></div>')
  })

  it('a mask with no explicit file draws one line for the whole folder', () => {
    const dialog = dialogOf(cardText(COVERED_TOUCH, runsFieldLine(['tests/a/**']), ...WITNESSES))
    expect(dialog).toContain('<div class="runs-group" data-lane="tests/a/**" data-glob><p class="runs-name">tests/a/** · вся папка</p></div>')
  })

  it('a mask with an explicit file does not read as the whole folder', () => {
    const dialog = dialogOf(cardText(COVERED_TOUCH, runsFieldLine(['tests/a/**', 'tests/a/x.test.ts']), ...WITNESSES))
    expect(dialog).not.toContain('вся папка')
  })

  it('a card with a layer heads its lanes by the layer', () => {
    const dialog = dialogOf(cardText(TOUCH, runsFieldLine(['layer:bus']), ...WITNESSES))
    expect(dialog).toContain('<div class="runs-group" data-group="bus"><p class="runs-name">layer bus</p><div class="runs-group" data-lane="scripts/tests/bus"><p class="runs-name">scripts/tests/bus</p><p><span class="tag">one.test.ts</span> <span class="tag">two.test.ts</span></p></div></div>')
  })

  it('the reason of a full run stands above the lanes', () => {
    const dialog = dialogOf(cardText('nowhere/x.ts', runsFieldLine(['tests/a/**', 'tests/b/y.test.ts']), ...WITNESSES))
    const reason = dialog.indexOf('<p class="runs-full">full run: nowhere/x.ts belongs to no layer of the check catalog</p>')
    expect(reason).toBeGreaterThan(-1)
    expect(lanesOf(dialog)).toEqual(['data-lane="tests/a/**"', 'data-lane="tests/b"'])
    expect(reason).toBeLessThan(dialog.indexOf('data-lane='))
  })
})
