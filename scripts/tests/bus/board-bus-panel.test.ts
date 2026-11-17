import type { BusSeed, SeedEvent } from '../../../tests/board/bus-fixture.js'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { writeBus } from '../../../tests/board/bus-fixture.js'
import { BOARD_DATA_FILE, printBoard } from '../../cli/board-page.js'
import { BUS_PULSE, PROCESS_HEARTBEAT, SESSION_HEARTBEAT } from '../../core/events.js'

const NOW = new Date('2026-11-17T08:00:00.000Z')
const MINUTE_MS = 60_000
const REDUCER_LAG = 5
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function secondsAgo(seconds: number): string {
  return new Date(NOW.getTime() - seconds * 1_000).toISOString()
}

function tick(seconds: number): SeedEvent {
  return { ts: secondsAgo(seconds), type: BUS_PULSE, card: null, payload: JSON.stringify({ rate_remaining: 4200 }) }
}

function event(seconds: number, type: string, card: number | null, payload: Record<string, unknown> = {}): SeedEvent {
  return { ts: secondsAgo(seconds), type, card, payload: JSON.stringify(payload) }
}

interface Page {
  html: string
  root: string
}

function pageOf(seed: BusSeed, snapshotWrittenMinutesAgo: number | null = null, lag = 0): Page {
  const root = mkdtempSync(path.join(tmpdir(), 'board-bus-panel-'))
  roots.push(root)
  const busPath = path.join(root, 'bus.db')
  writeBus(busPath, seed)
  const db = new DatabaseSync(busPath)
  db.exec('ALTER TABLE card_bodies ADD COLUMN admission_event_id INTEGER; ALTER TABLE card_bodies ADD COLUMN text_sha TEXT NOT NULL DEFAULT \'\'')
  db.prepare('UPDATE projection_watermarks SET through_event_id = through_event_id - ?').run(lag)
  db.close()
  if (snapshotWrittenMinutesAgo !== null)
    writeFileSync(path.join(root, BOARD_DATA_FILE), `window.BOARD = ${JSON.stringify({ written: new Date(NOW.getTime() - snapshotWrittenMinutesAgo * MINUTE_MS).toISOString(), tickMs: MINUTE_MS })}\n`)
  const eddiesFile = path.join(root, 'eddies.json')
  writeFileSync(eddiesFile, JSON.stringify({}))
  let html = ''
  expect(printBoard(busPath, NOW, (text) => {
    html += text
  }, path.join(root, 'miko.md'), 'html', eddiesFile)).toBe(0)
  return { html, root }
}

function busPanelOf(html: string): string {
  const start = html.indexOf('<div class="bus-panel')
  expect(start).toBeGreaterThanOrEqual(0)
  return html.slice(start, html.indexOf('</section>', start))
}

function cellOf(panel: string, name: string): string {
  const start = panel.indexOf(`data-cell="${name}"`)
  expect(start).toBeGreaterThanOrEqual(0)
  const next = panel.indexOf('data-cell=', start + 1)
  return panel.slice(start, next === -1 ? undefined : next)
}

const LAUNCH_BEAT = { process: 'launch-node', type: PROCESS_HEARTBEAT, ts: secondsAgo(20), payload: JSON.stringify({ queue: 'launch', slots: 3 }) }

describe('the bus panel', () => {
  it('a bus fixture renders the event rate, the reducer lag, a red SNAPSHOT past two intervals and LAUNCH 3/3 as a full yellow bar', () => {
    const { html } = pageOf({
      tasks: [1, 2, 3].map(card => ({ queue: 'launch', card, pr: null, head: null, state: 'leased' })),
      beats: [LAUNCH_BEAT],
      events: [tick(70), event(40, 'review.verdict', 7, { verdict: 'pass' }), event(30, 'review.verdict', 8, { verdict: 'changes' }), event(20, 'pr.merged', 9), tick(10)],
    }, 5, REDUCER_LAG)
    const panel = busPanelOf(html)
    expect(panel).toContain('BUS LIVE V1')
    expect(panel).toContain('● PULSE · 10s')
    expect(cellOf(panel, 'flow')).toContain('<div class="flow-rate"><b>4</b> events/min</div>')
    expect(cellOf(panel, 'flow').match(/class="flow-bar"/g)).toHaveLength(30)
    expect(panel).toContain(`<li class="bevel" data-node="reducer" data-health="yellow"><span>REDUCER</span><b>lag ${REDUCER_LAG} events</b></li>`)
    expect(panel).toContain('<li class="bevel" data-node="snapshot" data-health="red"><span>SNAPSHOT</span><b>published 5m ago</b></li>')
    expect(panel).toContain('<li class="bevel" data-node="netwatch" data-health="green"><span>NETWATCH</span><b>rate 4200 left</b></li>')
    expect(panel).toContain('<li class="bevel" data-node="workers" data-health="green"><span>WORKERS</span><b>1/1 alive</b></li>')
    expect(panel).toContain('<li data-slot-queue="launch" data-used="3" data-total="3" data-full><span>LAUNCH</span><span class="slot-segs"><i data-seg data-on></i><i data-seg data-on></i><i data-seg data-on></i></span><b>3/3</b></li>')
    expect(cellOf(panel, 'families')).toContain('<li><span>review</span><b>40%</b></li>')
  })

  it('a reducer at the last event is green and a snapshot inside one interval is green', () => {
    const panel = busPanelOf(pageOf({ beats: [LAUNCH_BEAT], events: [tick(70), tick(10)] }, 0.5).html)
    expect(panel).toContain('data-node="reducer" data-health="green"><span>REDUCER</span><b>lag 0 events</b>')
    expect(panel).toContain('data-node="snapshot" data-health="green"')
    expect(panel).toContain('<li data-slot-queue="launch" data-used="0" data-total="3"><span>LAUNCH</span>')
  })

  it('recent activity skips session.heartbeat and netwatch.tick', () => {
    const panel = busPanelOf(pageOf({
      events: [
        tick(300),
        event(250, 'card.admitted', 5),
        event(200, 'review.verdict', 7, { verdict: 'pass' }),
        event(150, 'card.stopped', 8, { reason: 'question' }),
        event(100, 'task.leased', 9, { queue: 'launch' }),
        event(50, 'pr.merged', 10),
        event(20, SESSION_HEARTBEAT, 10, { step: 'launch' }),
        tick(10),
      ],
    }).html)
    const recent = cellOf(panel, 'recent')
    expect(recent).not.toMatch(/session\.heartbeat|netwatch\.tick|card\.admitted/)
    expect([...recent.matchAll(/<li class="bevel" data-event="\d+"><span class="when">([^<]+)<\/span><span>([^<]+)<\/span><b>([^<]+)<\/b><\/li>/g)].map(match => match.slice(1))).toEqual([
      ['07:59:10', 'pr.merged', '#10'],
      ['07:58:20', 'task.leased · launch', '#9'],
      ['07:57:30', 'card.stopped · question', '#8'],
      ['07:56:40', 'review.verdict · pass', '#7'],
    ])
  })

  it('an open board.alarm reads red with its card, a cleared one does not', () => {
    const open = busPanelOf(pageOf({ events: [tick(70), { ...event(30, 'board.alarm', 12, { reason: 'lease-lost' }), dedupe: 'alarm:a' }, tick(10)] }).html)
    expect(open).toContain('<li class="bevel" data-node="alarms" data-health="red"><span>ALARMS</span><b>lease-lost · #12</b></li>')
    const cleared = busPanelOf(pageOf({ events: [tick(70), { ...event(30, 'board.alarm', 12, { reason: 'lease-lost' }), dedupe: 'alarm:a' }, event(20, 'board.alarm.cleared', null, { alarm: 'alarm:a' }), tick(10)] }).html)
    expect(cleared).toContain('data-node="alarms" data-health="green"><span>ALARMS</span><b>none open</b>')
  })

  it('no pulse for three intervals renders FLATLINED and BUS DOWN', () => {
    const { html } = pageOf({ events: [tick(240), tick(180)] })
    const panel = busPanelOf(html)
    expect(panel).toContain('<div class="bus-panel bevel" data-down role="region" aria-label="bus">')
    expect(panel).toContain('BUS DOWN V1')
    expect(panel).toContain('● NO PULSE · 3m')
    expect(panel).toContain('<span class="flatline-stamp">FLATLINED</span><span class="flatline-line">NO PULSE · NODES SILENT</span>')
    expect(panel).toContain('last event #2 · 3m · start the bus with pnpm bus:run')
    expect(panel).not.toMatch(/bus-body|NODE HEALTH|EVENT FLOW/)
  })

  it('a bus that never pulsed is down', () => {
    const panel = busPanelOf(pageOf({}).html)
    expect(panel).toContain('BUS DOWN V1')
    expect(panel).toContain('● NO PULSE · —')
    expect(panel).toContain('last event — · — · start the bus with pnpm bus:run')
  })
})
