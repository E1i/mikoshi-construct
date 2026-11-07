import { Buffer } from 'node:buffer'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeBus } from '../../../tests/board/bus-fixture.js'
import { boardFormatOf, printBoard, runBoardCli } from '../../cli/board-page.js'

const NOW = new Date('2026-11-06T12:00:00.000Z')
const WINDOW_CONTEXT_BYTES = 64 * 1024
const CARDS = 120
const FIRST_CARD = 3000
const BODY_FILLER = 'A sentence that makes the card body as long as a real one. '.repeat(40)

const roots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function cardText(id: number): string {
  return [
    `card: #${id} load [implement/netwatch/S/cheap/owner] · depends — · blocks —`,
    'branch: feat/load',
    'touches: scripts/cli/board-page.ts',
    'continue: stop',
    'who: shift',
    '',
    BODY_FILLER,
    '',
  ].join('\n')
}

function crowdedBus(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-board-default-'))
  roots.push(root)
  const file = path.join(root, 'bus.db')
  const ids = Array.from({ length: CARDS }, (_, index) => FIRST_CARD + index)
  writeBus(file, {
    cards: ids.map(id => ({ id, state: 'in_review', lane: 'lane-1', line: `#${id} load`, since: NOW.toISOString(), pr: id, text: cardText(id) })),
    prs: ids.map(id => ({ pr: id, card: id, state: 'open' })),
    events: [{ ts: NOW.toISOString(), type: 'netwatch.tick', card: null, payload: '{}' }],
  })
  const db = new DatabaseSync(file)
  db.exec('ALTER TABLE card_bodies ADD COLUMN admission_event_id INTEGER; ALTER TABLE card_bodies ADD COLUMN text_sha TEXT NOT NULL DEFAULT \'\'; ALTER TABLE prs ADD COLUMN head TEXT')
  db.exec('UPDATE card_bodies SET admission_event_id = (SELECT event_id FROM cards WHERE cards.card_id = card_bodies.card_id)')
  db.close()
  return file
}

function printed(busPath: string, args: readonly string[]): string {
  const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
  expect(runBoardCli(busPath, args)).toBe(0)
  const text = stdout.mock.calls.map(call => String(call[0])).join('')
  stdout.mockRestore()
  return text
}

describe('pnpm board with no flag prints a reading that fits a window, and the page stays one flag away', () => {
  it('the flags choose text by default, the page under --html and the JSON under --json', () => {
    expect(boardFormatOf([])).toBe('text')
    expect(boardFormatOf(['--html'])).toBe('html')
    expect(boardFormatOf(['--json'])).toBe('json')
  })

  it('pnpm board with no flag prints under 64 KB and no HTML, and --html prints the page', () => {
    const busPath = crowdedBus()
    const page = printed(busPath, ['--html'])
    expect(page.startsWith('<!doctype html>')).toBe(true)
    expect(Buffer.byteLength(page)).toBeGreaterThan(WINDOW_CONTEXT_BYTES)
    const reading = printed(busPath, [])
    expect(Buffer.byteLength(reading)).toBeLessThan(WINDOW_CONTEXT_BYTES)
    expect(reading).not.toMatch(/<!doctype|<html|<body|<style/i)
    expect(reading).toContain(`#${FIRST_CARD}`)
    expect(reading).toContain(`#${FIRST_CARD + CARDS - 1}`)
  })

  it('printBoard called with no format prints the same text reading as pnpm board with no flag', () => {
    const busPath = crowdedBus()
    let text = ''
    expect(printBoard(busPath, NOW, (written) => {
      text += written
    })).toBe(0)
    expect(text).not.toMatch(/<!doctype|<html/i)
    expect(Buffer.byteLength(text)).toBeLessThan(WINDOW_CONTEXT_BYTES)
    expect(text).toContain(`#${FIRST_CARD}`)
  })

  it('--json keeps printing the bus JSON', () => {
    const json = JSON.parse(printed(crowdedBus(), ['--json'])) as { status: string, cards: { id: number }[] }
    expect(json.status).toBe('live')
    expect(json.cards).toHaveLength(CARDS)
  })

  it('a stopped bus prints its text reading with no HTML', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bus-board-default-down-'))
    roots.push(root)
    const busPath = path.join(root, 'bus.db')
    const db = new DatabaseSync(busPath)
    db.close()
    let text = ''
    expect(printBoard(busPath, NOW, (written) => {
      text += written
    }, path.join(root, 'miko.md'), 'text')).toBe(1)
    expect(text).toMatch(/^the bus stopped at /)
    expect(text).toContain('no board snapshot to read')
    expect(text).not.toContain('<')
  })
})
