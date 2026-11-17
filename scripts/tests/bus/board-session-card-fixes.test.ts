import type { SeedBeat, SeedEvent } from '../../../tests/board/bus-fixture.js'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { writeBus } from '../../../tests/board/bus-fixture.js'
import { printBoard } from '../../cli/board-page.js'
import { modelLabel } from '../../cli/board-page/session-card.js'
import { PROCESS_HEARTBEAT, SESSION_HEARTBEAT, TASK_LEASED, WINDOW_HEARTBEAT, WINDOW_SUBAGENT_EVENT } from '../../core/events.js'

const NOW = new Date('2026-10-20T08:00:00.000Z')
const CARD = 861
const STYLE = fileURLToPath(new URL('../../cli/board-page/style.css', import.meta.url))
const WINDOW_ROLE = [{ role: 'miko', status: 'idle', state: 'awake' }]
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function minutesAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString()
}

function pageOf(events: SeedEvent[], seed: { beats?: SeedBeat[], roles?: typeof WINDOW_ROLE } = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), 'board-session-card-fixes-'))
  roots.push(root)
  const busPath = path.join(root, 'bus.db')
  writeBus(busPath, { cards: [{ id: CARD, state: 'changes', lane: 'lane-1', line: `#${CARD} answered [implement/construct/M/cheap/auto]`, since: minutesAgo(20) }], tasks: [{ queue: 'answer', card: CARD, pr: 15, head: 'abc1234', state: 'leased' }], roles: seed.roles ?? [], beats: seed.beats ?? [], events: [{ ts: minutesAgo(1), type: 'netwatch.tick', card: null, payload: '{}' }, ...events] })
  const db = new DatabaseSync(busPath)
  db.exec('ALTER TABLE card_bodies ADD COLUMN admission_event_id INTEGER; ALTER TABLE card_bodies ADD COLUMN text_sha TEXT NOT NULL DEFAULT \'\'')
  db.close()
  const eddiesFile = path.join(root, 'eddies.json')
  writeFileSync(eddiesFile, JSON.stringify({ contextLimit: 1_000_000, sessionSpend: 10_000_000, agentSpend: 1_000_000, warnRatio: 0.8 }))
  let html = ''
  expect(printBoard(busPath, NOW, (text) => {
    html += text
  }, path.join(root, 'miko.md'), 'html', eddiesFile)).toBe(0)
  return html
}

function windowBeat(payload: Record<string, unknown>): SeedEvent {
  return { ts: minutesAgo(2), type: WINDOW_HEARTBEAT, card: null, payload: JSON.stringify({ session: 'w-1', ...payload }) }
}

function crawlerCell(html: string): string {
  return /<div class="miko-crawlers"[\s\S]*?(?=<\/div>\n<div class="bus-panel)/.exec(html)![0]
}

function rule(css: string, selector: string): string {
  const start = css.indexOf(`\n${selector} {`)
  expect(start).toBeGreaterThanOrEqual(0)
  return css.slice(start, css.indexOf('}', start))
}

describe('the session card layout', () => {
  it('the page css carries the 20rem grid, min-width 0 and the six-line terminal', () => {
    const css = readFileSync(STYLE, 'utf8')
    expect(rule(css, '.svc-grid')).toContain('grid-template-columns: repeat(auto-fill, minmax(min(100%, 20rem), 1fr))')
    expect(rule(css, '.svc, .svc > *')).toContain('min-width: 0')
    const terminal = rule(css, '.term-cmd')
    expect(terminal).toContain('block-size: 6lh')
    expect(terminal).toContain('overflow-y: auto')
    expect(terminal).toContain('overscroll-behavior: contain')
  })
})

describe('the header slot counter', () => {
  it('three live launch sessions render LAUNCH 3/3', () => {
    const launches = [901, 902, 903].map((card, index): SeedEvent => ({ ts: minutesAgo(1), type: SESSION_HEARTBEAT, card, payload: JSON.stringify({ step: 'launch', session: `s-launch-${index}` }) }))
    const html = pageOf(launches, { beats: [{ process: 'launch-node', type: PROCESS_HEARTBEAT, ts: minutesAgo(1), payload: JSON.stringify({ queue: 'launch', slots: 3 }) }] })
    expect(html).toContain('launch 3/3')
    expect(html).not.toContain('launch 0/3')
  })
})

describe('the runner model', () => {
  describe('a heartbeat with model claude-sonnet-5-5 renders (SONNET 5.5)', () => {
    it('a heartbeat with model claude-sonnet-5-5 renders SONNET 5.5 in parentheses', () => {
      const html = pageOf([
        { ts: minutesAgo(8), type: TASK_LEASED, card: CARD, payload: JSON.stringify({ queue: 'answer', task_key: 'k', lease_gen: 1 }) },
        { ts: minutesAgo(1), type: SESSION_HEARTBEAT, card: CARD, payload: JSON.stringify({ step: 'answer', session: 's-one', context: 100_000, model: 'claude-sonnet-5-5' }) },
      ])
      const card = /<div class="svc bevel" data-role="answer"[\s\S]*?(?=<div class="svc bevel" |<\/section>)/.exec(html)![0]
      expect(card).toContain('<div class="round-who"><span class="round-model">(SONNET 5.5)</span><span class="round-label">')
    })
  })

  it('a heartbeat without a model hides the model line', () => {
    const html = pageOf([
      { ts: minutesAgo(8), type: TASK_LEASED, card: CARD, payload: JSON.stringify({ queue: 'answer', task_key: 'k', lease_gen: 1 }) },
      { ts: minutesAgo(1), type: SESSION_HEARTBEAT, card: CARD, payload: JSON.stringify({ step: 'answer', session: 's-one', context: 100_000 }) },
    ])
    expect(html).toContain('<div class="round-who"><span class="round-label">')
    expect(html).not.toContain('class="round-model"')
  })

  it('the model label keeps the family and its version and drops a date suffix', () => {
    expect(modelLabel('claude-opus-5-5')).toBe('OPUS 5.5')
    expect(modelLabel('claude-haiku-5-5-20261001')).toBe('HAIKU 5.5')
    expect(modelLabel(null)).toBeNull()
    expect(modelLabel('  ')).toBeNull()
  })
})

describe('the Miko panel', () => {
  it('a window.heartbeat with skills intake and window-recipes renders both names', () => {
    const html = pageOf([windowBeat({ context: 64_000, skills: ['intake', 'window-recipes'], core: 12, crawlers: [] })], { roles: WINDOW_ROLE })
    expect(html).toContain('<span class="miko-skill">intake</span><span class="miko-skill">window-recipes</span>')
    expect(html).toContain('window v12')
    const strip = /<div class="svc bevel" data-role="window"[^>]*data-strip>[\s\S]*?(?=<div class="miko-crawlers")/.exec(html)![0]
    expect(strip).not.toContain('—')
  })
})

describe('the crawlers cell', () => {
  it('two live crawlers render LIVE · 2 with CRAWLING and IDLE and their CTX and SPENT', () => {
    const crawlers = [
      { id: 'a1', kind: 'general-purpose', description: 'reads the diff', started_at: minutesAgo(5), state: 'CRAWLING', ctx: 120_000, spent: 40_000 },
      { id: 'a2', kind: 'explore', description: 'maps the tests', started_at: minutesAgo(3), state: 'IDLE', ctx: 30_000, spent: 9_000 },
    ]
    const cell = crawlerCell(pageOf([windowBeat({ crawlers })], { roles: WINDOW_ROLE }))
    expect(cell).toContain('<span class="crawlers-live" data-live>LIVE · 2</span>')
    expect(cell).toContain('<li class="miko-crawler" data-state="crawling">')
    expect(cell).toContain('<span class="crawler-chip">CRAWLING</span>')
    expect(cell).toContain('<span class="crawler-chip">IDLE</span>')
    expect(cell).toContain('<div class="crawler-use">CTX 120k · SPENT 40k</div>')
    expect(cell).toContain('<div class="crawler-use">CTX 30k · SPENT 9k</div>')
    expect(cell).not.toContain('FLATLINED')
  })

  it('zero live crawler processes render FLATLINED even when crawler tasks exist', () => {
    const html = pageOf([
      { ts: minutesAgo(3), type: WINDOW_SUBAGENT_EVENT, card: null, payload: JSON.stringify({ session: 'sub-1', role: 'review', task: '#1950', phase: 'started', step: 'reading the diff' }) },
      windowBeat({ subagents: [{ name: 'review', context: 10_000, spent: 1_000, at: minutesAgo(3) }], crawlers: [] }),
    ], { roles: WINDOW_ROLE })
    const cell = crawlerCell(html)
    expect(cell).toContain('<span class="flatline-stamp">FLATLINED</span>')
    expect(cell).toContain('NO ACTIVE CRAWLERS · SIGNAL LOST')
    expect(cell).toContain('<span class="crawlers-live">LIVE · 0</span>')
    expect(cell).not.toContain('miko-crawler-rows')
  })

  it('a window.heartbeat with one general-purpose subagent renders CRAWLER #01 · general-purpose with its description', () => {
    const crawlers = [{ id: 'a1', kind: 'general-purpose', description: 'finds the slot counter', started_at: minutesAgo(4), state: 'CRAWLING', ctx: 50_000, spent: 12_000 }]
    const cell = crawlerCell(pageOf([windowBeat({ crawlers })], { roles: WINDOW_ROLE }))
    expect(cell).toContain('<span class="crawlers-live" data-live>LIVE · 1</span>')
    expect(cell).toContain('<span class="crawler-name">CRAWLER #01 · general-purpose</span>')
    expect(cell).toContain('<div class="crawler-what">finds the slot counter · 4 min</div>')
  })

  it('a window.heartbeat with an empty subagent list renders FLATLINED', () => {
    const html = pageOf([windowBeat({ crawlers: [] })])
    expect(crawlerCell(html)).toContain('<div class="miko-crawlers" data-flatlined>')
    expect(crawlerCell(html)).toContain('FLATLINED')
  })
})
