import type { BusService } from '../../../src/commands/board/bus.js'
import type { SeedEvent } from '../../../tests/board/bus-fixture.js'
import type { MikoPanelParts, MikoPresence } from '../../cli/board-page/miko-panel.js'
import type { SessionCardParts, SessionView } from '../../cli/board-page/session-card.js'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { readTranscript } from '../../../src/commands/liveness.js'
import { writeBus } from '../../../tests/board/bus-fixture.js'
import { escaped, printBoard } from '../../cli/board-page.js'
import { mikoPanel } from '../../cli/board-page/miko-panel.js'
import { ROUND_COLOURS, roundColour, sessionCard, terminalOf } from '../../cli/board-page/session-card.js'
import { ANSWER_STEP, SESSION_HEARTBEAT, TASK_LEASED, WINDOW_HEARTBEAT } from '../../core/events.js'

const NOW = new Date('2026-10-20T08:00:00.000Z')
const CARD = 861
const EXPECTED_MS = 20 * 60_000
const SERVICE: BusService = { role: 'answer', task: `#${CARD}`, tree: null, step: 'answer · pulse 1 min ago · now Bash ls for 2 min', session: 's-one' }
const PARTS: SessionCardParts = { opener: '', hint: '', bars: '', agents: '', over: false, now: NOW.toISOString() }

const WINDOW: BusService = { role: 'window', task: 'miko', tree: null, step: 'window · awake' }
const PRESENCE: MikoPresence = { model: null, core: null, status: null, handoffBytes: null, skills: [], crawlers: [] }
const PANEL: MikoPanelParts = { windows: [WINDOW], bars: () => '', presence: PRESENCE, now: NOW.toISOString(), words: { role: 'FIXER', name: 'Miko', plainTitle: '' }, busLines: ['bus · pulse 1 min ago · slots in use 1/3'], busLive: true, opener: '', hint: '', idle: null }

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function minutesAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString()
}

function viewAt(share: number, expectedMs: number | null = EXPECTED_MS): SessionView {
  return { startedAt: new Date(NOW.getTime() - share * EXPECTED_MS).toISOString(), expectedMs, steps: [], terminal: null }
}

function roundOf(html: string): string {
  return /<div class="round"[\s\S]*?<div class="round-meta">[^<]*<\/div><\/div>/.exec(html)![0]
}

function transcript(id: string, command: string, ended: boolean): string {
  const use = { timestamp: minutesAgo(6), message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } }
  const result = { timestamp: minutesAgo(1), message: { content: [{ type: 'tool_result', tool_use_id: id }] } }
  return [use, ...ended ? [result] : []].map(line => JSON.stringify(line)).join('\n')
}

function terminalIn(text: string): ReturnType<typeof terminalOf> {
  return terminalOf(text, read => readTranscript(read).actions)
}

function pageOf(events: SeedEvent[], roles: { role: string, status: string, state: string }[] = []): string {
  const root = mkdtempSync(path.join(tmpdir(), 'board-session-card-'))
  roots.push(root)
  const busPath = path.join(root, 'bus.db')
  writeBus(busPath, { cards: [{ id: CARD, state: 'changes', lane: 'lane-1', line: `#${CARD} answered [implement/construct/M/cheap/auto]`, since: minutesAgo(20) }], tasks: [{ queue: 'answer', card: CARD, pr: 15, head: 'abc1234', state: 'leased' }], roles, events })
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

describe('the round timer of a session card', () => {
  it('a session card at 50, 90 and 130 percent of the expected round is blue, yellow-red and red OVER TIME', () => {
    const calm = roundOf(sessionCard(SERVICE, viewAt(0.5), PARTS))
    expect(calm).toContain('data-phase="calm"')
    expect(calm).toContain(`--_round: ${roundColour(0.5)}`)
    expect(calm).toContain('ROUND TIME REMAINING')
    expect(calm).toContain('<span class="round-clock">10:00.00</span>')
    expect(calm).toContain('--_left: 50%')
    expect(calm).toContain('round of ~20 min')
    const warn = roundOf(sessionCard(SERVICE, viewAt(0.9), PARTS))
    expect(warn).toContain('data-phase="warn"')
    expect(warn).toContain(`--_round: ${roundColour(0.9)}`)
    expect(roundColour(0.8)).toBe(ROUND_COLOURS.warn)
    expect(roundColour(0)).toBe(ROUND_COLOURS.calm)
    expect([roundColour(0.9), roundColour(0.5)]).not.toContain(ROUND_COLOURS.over)
    const over = roundOf(sessionCard(SERVICE, viewAt(1.3), PARTS))
    expect(over).toContain('data-phase="over"')
    expect(over).toContain(`--_round: ${ROUND_COLOURS.over}`)
    expect(over).toContain('OVER TIME')
    expect(over).toContain('<span class="round-clock">+06:00.00</span>')
    expect(over).toContain('--_left: 0%')
  })

  it('a session card at exactly 100 percent of the expected round is OVER TIME, not a countdown', () => {
    const edge = roundOf(sessionCard(SERVICE, viewAt(1), PARTS))
    expect(edge).toContain('data-phase="over"')
    expect(edge).toContain('OVER TIME')
    expect(edge).toContain('<span class="round-clock">+00:00.00</span>')
  })

  it('a session card with no measured round shows the elapsed time and no data without an alarm colour', () => {
    const round = roundOf(sessionCard(SERVICE, viewAt(0.5, null), PARTS))
    expect(round).toContain('data-phase="none"')
    expect(round).toContain('<span class="round-clock">10:00.00</span>')
    expect(round).toContain('no data')
    expect(round).not.toContain('--_round')
    expect(round).not.toContain('OVER TIME')
    expect(round).not.toContain('data-round-expected-ms')
  })
})

describe('the terminal block of a session card', () => {
  it('the terminal block shows the whole current command wrapped, not cut', () => {
    const command = `pnpm exec vitest run ${'scripts/tests/bus/a-long-test-name.test.ts '.repeat(6)}--reporter <dot> && echo "done"`
    const running = sessionCard(SERVICE, { ...viewAt(0.2), terminal: terminalIn(transcript('t-1', command, false)) }, PARTS)
    expect(running).toContain(`<pre class="term-cmd">$ ${escaped(command)}<span class="term-cursor"></span></pre>`)
    expect(running).toContain('NOW · BASH · 6 MIN')
    const ended = sessionCard(SERVICE, { ...viewAt(0.2), terminal: terminalIn(transcript('t-2', 'ls', true)) }, PARTS)
    expect(ended).toContain(`LAST · BASH · ENDED ${minutesAgo(1).slice(11, 19)}`)
  })
})

describe('the Miko strip', () => {
  it('each crawler of Miko is a numbered row with its kind, state chip, what it does, its age and its usage', () => {
    const crawlers = [
      { id: 'a1', kind: 'review', description: 'reading the diff', startedAt: new Date(NOW.getTime() - 4 * 60_000).toISOString(), state: 'CRAWLING', context: 100_000, spent: 50_000 },
      { id: 'a2', kind: 'implementer', description: null, startedAt: null, state: 'IDLE', context: null, spent: null },
    ]
    const html = mikoPanel({ ...PANEL, presence: { ...PRESENCE, crawlers } })
    const rows = /<ul class="miko-crawler-rows">([\s\S]*?)<\/ul>/.exec(html)![1]!
    expect(rows).toBe([
      '<li class="miko-crawler" data-state="crawling"><div class="crawler-top"><span class="crawler-name">CRAWLER #01 · review</span><span class="crawler-chip">CRAWLING</span></div><div class="crawler-what">reading the diff · 4 min</div><div class="crawler-use">CTX 100k · SPENT 50k</div></li>',
      '<li class="miko-crawler" data-state="idle"><div class="crawler-top"><span class="crawler-name">CRAWLER #02 · implementer</span><span class="crawler-chip">IDLE</span></div></li>',
    ].join(''))
    expect(html.indexOf('miko-crawlers')).toBeGreaterThan(html.indexOf('miko-self'))
    expect(html.indexOf('miko-crawlers')).toBeLessThan(html.indexOf('miko-bus'))
    expect(mikoPanel(PANEL)).not.toContain('miko-crawler-rows')
    expect(mikoPanel(PANEL)).toContain('FLATLINED')
  })

  it('a stale bus heads the strip with BUS STALE and marks the column stale', () => {
    expect(mikoPanel(PANEL)).toContain('<div class="miko-bus"><div class="miko-bus-head">BUS LIVE</div>')
    const stale = mikoPanel({ ...PANEL, busLive: false })
    expect(stale).toContain('<div class="miko-bus" data-stale><div class="miko-bus-head">BUS STALE</div>')
    expect(stale).not.toContain('BUS LIVE')
  })
})

describe('the round steps of a session card', () => {
  it('a step under a minute old reads in seconds', () => {
    const view: SessionView = { startedAt: new Date(NOW.getTime() - 75_000).toISOString(), expectedMs: null, steps: [{ step: 'lease', seconds: 30 }], terminal: null }
    expect(sessionCard(SERVICE, view, PARTS)).toContain('<span class="round-step-now">tree · 45s</span>')
  })
})

describe('the board page', () => {
  it('the board has no BUS card and the bus pulse and slots sit in the Miko panel', () => {
    const html = pageOf([
      { ts: minutesAgo(1), type: 'netwatch.tick', card: null, payload: '{}' },
      { ts: minutesAgo(2), type: WINDOW_HEARTBEAT, card: null, payload: JSON.stringify({ session: 'w-1', context: 64_000, spent: 97_000 }) },
    ], [{ role: 'miko', status: 'idle', state: 'awake' }])
    expect(html).not.toContain('<div class="svc bevel" data-role="bus"')
    const strip = /<div class="svc bevel" data-role="window"[^>]*data-strip>[\s\S]*?(?=<\/section>)/.exec(html)![0]
    expect(strip).toContain('<span class="svc-kind">FIXER</span><span class="lore">MIKO</span>')
    expect(strip).toMatch(/<div class="miko-bus"><div class="miko-bus-head">BUS LIVE<\/div><div class="svc-line">bus · pulse [^<]*slots in use[^<]*<\/div>/)
    const services = html.slice(html.indexOf('id="slot-services"'), html.indexOf('</section>', html.indexOf('id="slot-services"')))
    expect(services.match(/data-role="window"/g)).toHaveLength(1)
    expect(services).not.toMatch(/data-role="bus"|<span class="lore">Subnet<\/span>/)
  })

  it('a window crawler takes its kind, description and age from the crawler list of window.heartbeat', () => {
    const crawlers = [{ id: 'a1', kind: 'review', description: 'reading the diff', started_at: minutesAgo(3), state: 'CRAWLING', ctx: 10_000, spent: 2_000 }]
    const html = pageOf([
      { ts: minutesAgo(1), type: 'netwatch.tick', card: null, payload: '{}' },
      { ts: minutesAgo(2), type: WINDOW_HEARTBEAT, card: null, payload: JSON.stringify({ session: 'w-1', crawlers }) },
    ], [{ role: 'miko', status: 'idle', state: 'awake' }])
    expect(html).toContain('<div class="crawler-what">reading the diff · 3 min</div>')
  })

  it('a live answer round shows its passed steps and the current one from answer.step', () => {
    const html = pageOf([
      { ts: minutesAgo(1), type: 'netwatch.tick', card: null, payload: '{}' },
      { ts: minutesAgo(8), type: TASK_LEASED, card: CARD, payload: JSON.stringify({ queue: 'answer', task_key: 'k', lease_gen: 1 }) },
      { ts: minutesAgo(7), type: ANSWER_STEP, card: CARD, payload: JSON.stringify({ step: 'lease', seconds: 30 }) },
      { ts: minutesAgo(7), type: ANSWER_STEP, card: CARD, payload: JSON.stringify({ step: 'tree', seconds: 30 }) },
      { ts: minutesAgo(1), type: SESSION_HEARTBEAT, card: CARD, payload: JSON.stringify({ step: 'answer', session: 's-one', context: 100_000 }) },
    ])
    const card = /<div class="svc bevel" data-role="answer"[\s\S]*?(?=<div class="svc bevel" |<\/section>)/.exec(html)![0]
    expect(card).toContain('<li data-passed>lease</li><li data-passed>tree</li><li data-current>spawn</li>')
    expect(card).toContain('<span class="round-step-now">spawn · 7 min</span>')
    expect(card).toContain(`data-round-start="${minutesAgo(8)}"`)
    expect(card).toContain('no data · started 07:52:00 · pulse 1 min ago')
  })
})
