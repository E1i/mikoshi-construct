import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { writeBus } from '../../../tests/board/bus-fixture.js'
import { printBoard } from '../../cli/board-page.js'

const NOW = new Date('2026-10-20T08:00:00.000Z')

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function emptyPage(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'board-dialog-scroll-'))
  roots.push(root)
  const busPath = path.join(root, 'bus.db')
  writeBus(busPath, { cards: [], roles: [], events: [] })
  const db = new DatabaseSync(busPath)
  db.exec('ALTER TABLE card_bodies ADD COLUMN admission_event_id INTEGER; ALTER TABLE card_bodies ADD COLUMN text_sha TEXT NOT NULL DEFAULT \'\'')
  db.close()
  let html = ''
  expect(printBoard(busPath, NOW, (text) => {
    html += text
  }, path.join(root, 'miko.md'), 'html')).toBe(0)
  return html
}

function ruleOf(html: string, selector: string): string {
  const start = html.indexOf(`\n${selector} {`)
  expect(start).toBeGreaterThanOrEqual(0)
  return html.slice(start, nextRuleEnd(html, start))
}

function nextRuleEnd(html: string, start: number): number {
  let depth = 0
  for (let at = html.indexOf('{', start); at < html.length; at += 1) {
    if (html[at] === '{')
      depth += 1
    if (html[at] === '}')
      depth -= 1
    if (depth === 0)
      return at + 1
  }
  return html.length
}

describe('the card dialog scroll', () => {
  it('the dialog clips and holds the height once, so only the drill body scrolls under a fixed head', () => {
    const html = emptyPage()
    const dialog = ruleOf(html, 'dialog.drill')
    const wrap = ruleOf(html, '.drill-wrap')
    const body = ruleOf(html, '.drill-body')
    expect(dialog).toContain('overflow: hidden')
    expect(dialog).toContain('max-block-size: calc(100dvh - 3rem)')
    expect(dialog).toContain('&[open] { display: flex; flex-direction: column; }')
    expect(wrap).not.toContain('max-block-size')
    expect(wrap).not.toContain('overflow')
    expect(wrap).toContain('min-block-size: 0')
    expect(body).toContain('overflow: auto')
  })
})
