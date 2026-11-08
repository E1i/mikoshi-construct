import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { writeBus } from '../../../tests/board/bus-fixture.js'
import { printBoard, renderBusDown } from '../../cli/board-page.js'

const NOW = new Date('2026-11-05T12:00:00.000Z')
const ANIMATED = ['header.panel::before', '.warning-strip::before', '.owner-strip::before', 'dialog.drill[open]::before']
const STATIC_BLOCKS = ['.bevel', '.panel', '.svc', '.warning-strip', '.owner-strip', 'dialog.drill']
const WARNING_STRIP = '<section class="warning-strip bevel"'
const OWNER_STRIP = '<section class="owner-strip bevel"'

const BLOCK_MARKUP: Record<string, string> = {
  'header': '<header class="panel bevel">',
  'WAITS FOR YOU': OWNER_STRIP,
  'WARNINGS': WARNING_STRIP,
  'SERVICES': '<section class="panel bevel" id="slot-services"',
  'FLOW': '<section class="panel bevel" id="slot-flow"',
  'BACKLOG': '<section class="panel backlog bevel"',
  'tile': '<div class="svc bevel" data-role="window"',
  'dialog': '<dialog class="drill bevel"',
}

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function pageOf(records: boolean): string {
  const root = mkdtempSync(path.join(tmpdir(), 'board-bevel-'))
  roots.push(root)
  const busPath = path.join(root, 'bus.db')
  writeBus(busPath, { cards: [], roles: [], events: [] })
  const db = new DatabaseSync(busPath)
  db.exec('ALTER TABLE card_bodies ADD COLUMN admission_event_id INTEGER; ALTER TABLE card_bodies ADD COLUMN text_sha TEXT NOT NULL DEFAULT \'\'')
  if (records)
    db.prepare('INSERT INTO owner_waits (id, need, text, command, card_id, pr, state, opened_at, event_id) VALUES (?, ?, ?, ?, ?, ?, \'open\', ?, 0)').run('Q1', 'decision', 'which path?', null, null, null, NOW.toISOString())
  db.close()
  let html = ''
  expect(printBoard(busPath, NOW, (text) => {
    html += text
  }, path.join(root, 'miko.md'), 'html')).toBe(0)
  return html
}

function styleOf(html: string): string {
  return /<style>([\s\S]*?)<\/style>/.exec(html)![1]!
}

function markupOf(html: string): string {
  return html.slice(html.indexOf('</head>'))
}

function ruleOf(style: string, selector: string): string {
  const start = style.indexOf(`\n${selector} {`)
  expect(start, selector).toBeGreaterThanOrEqual(0)
  let depth = 0
  for (let at = style.indexOf('{', start); at < style.length; at += 1) {
    if (style[at] === '{')
      depth += 1
    if (style[at] === '}')
      depth -= 1
    if (depth === 0)
      return style.slice(start, at + 1)
  }
  return style.slice(start)
}

function nestedRule(rule: string, selector: string): string {
  return ruleOf(rule.replace(/\n {2}/g, '\n'), selector)
}

function declaresBevelAnimation(style: string): string[] {
  return [...style.matchAll(/^(\S.*?) \{[^{}]*animation: --animation-bevel/gm)].map(match => match[1]!)
}

describe('the bevel primitive', () => {
  it('every cut block carries the bevel whose before and after rules draw polygons with a diagonal', () => {
    const style = styleOf(pageOf(false))
    const bevel = ruleOf(style, '.bevel')
    const frame = nestedRule(bevel, '&::before')
    const surface = nestedRule(bevel, '&::after')
    expect(bevel).toContain('--_surface-cut: calc(var(--cut) - var(--edge) * 0.41)')
    expect(frame).toContain('inset: 0')
    expect(frame).toContain('var(--_frame)')
    expect(frame).toContain('polygon(0 0, calc(100% - var(--cut)) 0, 100% var(--cut), 100% 100%, var(--cut) 100%, 0 calc(100% - var(--cut)))')
    expect(surface).toContain('inset: var(--edge)')
    expect(surface).toContain('background: var(--_surface)')
    expect(surface).toContain('polygon(0 0, calc(100% - var(--_surface-cut)) 0, 100% var(--_surface-cut), 100% 100%, var(--_surface-cut) 100%, 0 calc(100% - var(--_surface-cut)))')
    const shown = markupOf(pageOf(true))
    for (const [block, markup] of Object.entries(BLOCK_MARKUP))
      expect(shown, block).toContain(markup)
  })

  it('the blocks the primitive replaced keep no clip path and no border of their own', () => {
    const style = styleOf(pageOf(false))
    for (const selector of [...STATIC_BLOCKS.slice(1), 'header.panel']) {
      const rule = ruleOf(style, selector)
      expect(rule, selector).not.toContain('clip-path')
      expect(rule, selector).not.toMatch(/border(?:-color|-inline-start)?: (?!0;)/)
    }
  })

  it('the dialog\'s pseudo elements stay out of its flow and scroll', () => {
    const bevel = ruleOf(styleOf(pageOf(false)), '.bevel')
    expect(bevel).toContain('&::before, &::after { content: ""; position: absolute; z-index: -1; pointer-events: none; }')
    expect(bevel).toContain('&:not(dialog) { position: relative; }')
  })
})

describe('the sweep', () => {
  // eslint-disable-next-line test/prefer-lowercase-title
  it('WARNINGS and WAITS with no records render no animated element', () => {
    const empty = markupOf(pageOf(false))
    expect(empty).not.toContain(WARNING_STRIP)
    expect(empty).not.toContain(OWNER_STRIP)
    const held = markupOf(pageOf(true))
    expect(held).toContain(WARNING_STRIP)
    expect(held).toContain(OWNER_STRIP)
    const down = renderBusDown({ at: NOW.toISOString(), stoppedAt: null, error: 'gone', snapshot: null, handoffStatus: null })
    expect(markupOf(down)).not.toContain(OWNER_STRIP)
  })

  it('the reduced motion block sets animation none on every animated bevel', () => {
    const style = styleOf(pageOf(false))
    const reduced = ruleOf(style, '@media (prefers-reduced-motion: reduce)')
    const declared = declaresBevelAnimation(style)
    expect(new Set(declared)).toEqual(new Set(ANIMATED))
    const line = reduced.split('\n').find(text => text.includes('--_sweep: transparent'))!
    for (const selector of declared)
      expect(line, selector).toContain(selector)
    expect(line).toContain('animation: none')
  })

  it('the header runs 14s, WARNINGS 6s reversed, WAITS 6s, the dialog one pass of 1.2s, and the panels declare no animation', () => {
    const style = styleOf(pageOf(false))
    expect(style).toContain('@property --a { syntax: "<angle>"; inherits: false; initial-value: 0deg; }')
    expect(nestedRule(ruleOf(style, '.bevel'), '&::before')).toContain('conic-gradient(from var(--a)')
    expect(ruleOf(style, 'header.panel::before')).toContain('animation: --animation-bevel-sweep 14s linear infinite;')
    expect(ruleOf(style, '.warning-strip::before')).toContain('animation: --animation-bevel-sweep 6s linear infinite reverse;')
    expect(ruleOf(style, '.owner-strip::before')).toContain('animation: --animation-bevel-sweep 6s linear infinite;')
    expect(ruleOf(style, 'dialog.drill[open]::before')).toContain('animation: --animation-bevel-pass 1.2s linear 1;')
    for (const selector of STATIC_BLOCKS)
      expect(ruleOf(style, selector), selector).not.toContain('animation')
    expect(style).toContain('@keyframes --animation-bevel-sweep { to { --a: 360deg; } }')
  })

  it('the waits and warnings strips take a cut of 0.6rem and their labels a cut tab', () => {
    const style = styleOf(pageOf(false))
    expect(ruleOf(style, '.warning-strip')).toContain('--cut: 0.6rem;')
    expect(ruleOf(style, '.owner-strip')).toContain('--cut: 0.6rem;')
    expect(ruleOf(style, ':is(.warning-strip, .owner-strip) .lbl')).toContain('clip-path: polygon(0 0, calc(100% - var(--_surface-cut)) 0, 100% var(--_surface-cut)')
  })
})
