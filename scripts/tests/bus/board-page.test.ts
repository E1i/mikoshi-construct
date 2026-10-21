import type { SeedEvent } from '../../../tests/board/bus-fixture.js'
import type { BoardFiles } from '../../bus/board-page.js'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { busReaderAt } from '../../../src/commands/board/bus.js'
import { printBoard as printConstructBoard, readBoard } from '../../../src/commands/board/index.js'
import { createUi } from '../../../src/ui/console.js'
import { BANNER, LORE } from '../../../src/ui/lore.js'
import { resolveTheme } from '../../../src/ui/theme.js'
import { checkMatrix, subagent, writeBus } from '../../../tests/board/bus-fixture.js'
import { DISK_FILES, escaped, filterRule, printBoard, readEddiesLimits, readModelVersion, writeBoardPage } from '../../bus/board-page.js'
import { BOARD_FILE, FRESH_MS } from '../../bus/board.js'
import { defaultBusPath } from '../../bus/db.js'
import { SESSION_HEARTBEAT, WINDOW_HEARTBEAT } from '../../core/events.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

describe('writeBoardPage', () => {
  it('the board is built in a temporary file and renamed over board.html', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bus-board-page-'))
    roots.push(root)
    const board = path.join(root, BOARD_FILE)
    writeFileSync(board, '<p>the previous board</p>')
    const calls: string[][] = []
    const files: BoardFiles = {
      write: (file, text) => {
        calls.push(['write', file])
        expect(readFileSync(board, 'utf8')).toBe('<p>the previous board</p>')
        DISK_FILES.write(file, text)
      },
      rename: (from, to) => {
        calls.push(['rename', from, to])
        DISK_FILES.rename(from, to)
      },
    }
    writeBoardPage(board, '<p>the next board</p>', files)
    const temporary = calls[0]![1]!
    expect(calls).toEqual([['write', temporary], ['rename', temporary, board]])
    expect(temporary).not.toBe(board)
    expect(path.dirname(temporary)).toBe(root)
    expect(readFileSync(board, 'utf8')).toBe('<p>the next board</p>')
    expect(existsSync(temporary)).toBe(false)
    expect(readdirSync(root)).toEqual([BOARD_FILE])
  })
})

describe('board.html', () => {
  const NOW = new Date('2026-10-20T08:00:00.000Z')

  function minutesAgo(minutes: number): string {
    return new Date(NOW.getTime() - minutes * 60_000).toISOString()
  }

  function seededBus(heartbeats: SeedEvent[] = []): string {
    const root = mkdtempSync(path.join(tmpdir(), 'bus-board-screens-'))
    roots.push(root)
    return writeBus(path.join(root, 'bus.db'), {
      cards: [
        { id: 860, state: 'queued', lane: 'lane-1', line: 'card: #860 first <task>', since: minutesAgo(30) },
        { id: 861, state: 'running', lane: 'lane-1', line: '#861 second', since: minutesAgo(20) },
        { id: 862, state: 'in_review', lane: 'lane-2', line: null, since: minutesAgo(10), pr: 12 },
        { id: 863, state: 'merged', lane: null, line: '#863 done', since: minutesAgo(5) },
        { id: 864, state: 'merged', lane: 'lane-2', line: '#864 old-lease [implement/netwatch/M/cheap/owner] · depends #860 · blocks —', since: minutesAgo(1_200) },
      ],
      verdicts: [[12, null]],
      tasks: [{ queue: 'review', card: 862, pr: 12, head: 'abcdef1234567', state: 'leased' }],
      roles: [{ role: 'operator', status: 'idle', state: 'awake' }],
      events: [
        { ts: minutesAgo(1), type: 'netwatch.tick', card: null, payload: '{}' },
        subagent(minutesAgo(2), { role: 'implementer', task: '#861', session: 's1', tree: '/trees/mc-861', step: 'writing' }),
        checkMatrix(12, 'abcdef1234567', { killed: 3, survived: 1, notRun: 0 }),
        ...heartbeats,
      ],
    })
  }

  function constructBoardLines(busPath: string): string[] {
    let out = ''
    const ui = createUi(resolveTheme({ plain: true }), (text) => {
      out += text
    })
    printConstructBoard(ui, readBoard(path.dirname(busPath), { all: false, staleHours: 4, prs: undefined, readStdin: () => '', now: NOW, bus: busReaderAt(busPath, () => NOW) }))
    return out.trimEnd().split('\n')
  }

  function pageText(busPath: string): string {
    let html = ''
    expect(printBoard(busPath, NOW, (text) => {
      html += text
    })).toBe(0)
    return html
  }

  function visibleText(html: string): string {
    return html.replace(/<style>[\s\S]*?<\/style>/g, ' ').replace(/<title>[\s\S]*?<\/title>/g, ' ').replace(/<[^>]*>/g, ' ').replace(/&#39;|&quot;|&lt;|&gt;|&amp;/g, ' ')
  }

  function busNumbers(busPath: string): Set<number> {
    const db = new DatabaseSync(busPath, { readOnly: true })
    try {
      const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]
      const dump = JSON.stringify(tables.map(table => db.prepare(`SELECT * FROM ${table.name}`).all()))
      return new Set([...dump.matchAll(/\d+/g)].map(match => Number(match[0])))
    }
    finally {
      db.close()
    }
  }

  function readingOf(token: string): number {
    const unit = token.endsWith('M') ? 1_000_000 : token.endsWith('k') ? 1_000 : 1
    return Number.parseFloat(token) * unit
  }

  function backlogOf(lines: string[]): { card: string, state: string }[] {
    return lines.slice(lines.indexOf('Backlog') + 1, lines.indexOf('Services')).filter(line => line.startsWith('  ')).map((row) => {
      const parts = row.trim().split(' · ')
      return { card: /#(\d+)/.exec(parts[0]!)![1]!, state: parts.at(-1)! }
    })
  }

  it('the state filter shows the same cards as construct board --all', () => {
    const busPath = seededBus()
    let out = ''
    const ui = createUi(resolveTheme({ plain: true }), (text) => {
      out += text
    })
    printConstructBoard(ui, readBoard(path.dirname(busPath), { all: true, staleHours: 4, prs: undefined, readStdin: () => '', now: NOW, bus: busReaderAt(busPath, () => NOW) }))
    const expected = backlogOf(out.trimEnd().split('\n'))
    const html = pageText(busPath)
    const rows = [...html.matchAll(/<tr data-card="(\d+)" data-stage="([^"]*)"/g)].map(match => ({ card: match[1]!, state: match[2]! }))
    expect(rows).toEqual(expected)
    const states = [...new Set(expected.map(row => row.state))]
    expect(states.length).toBeGreaterThan(1)
    for (const state of states) {
      expect(html).toContain(`<a class="chip" href="#show-${state.replace(/\W/g, '_')}">${state}</a>`)
      expect(html).toContain(filterRule(state))
      expect(filterRule(state)).toContain(`tr[data-card]:not([data-stage="${state}"])`)
    }
    expect(html).toContain('<a class="chip" href="#show-all">all</a>')
    expect(html).toContain('<tr data-card="864" data-stage="merged"><td class="id">#864</td><td class="slug">old-lease</td><td>implement</td><td>netwatch</td><td>M</td><td>cheap</td><td>owner</td><td>#860</td><td>—</td>')
  })

  it('every number on the page is in the bus or in eddies.json', () => {
    const busPath = seededBus([
      { ts: minutesAgo(3), type: SESSION_HEARTBEAT, card: 861, payload: JSON.stringify({ step: 'launch', session: 's861', context: 182_345, spent: 1_412_000 }) },
    ])
    const html = pageText(busPath)
    const limits = readEddiesLimits()
    const version = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../../package.json'), 'utf8')) as { version: string }
    const warnLine = limits.warnRatio === null ? [] : [Math.round(limits.warnRatio * 100)]
    const allowed = [...busNumbers(busPath), ...Object.values(limits).filter(value => value !== null), ...warnLine, readModelVersion() ?? 0, ...version.version.split('.').map(Number), ...NOW.toISOString().split(/\D+/).filter(Boolean).map(Number)]
    const counts = Array.from({ length: 6 }, (_, at) => at)
    const tokens = [...visibleText(html).matchAll(/(?<![\w.#-])\d+(?:\.\d+)?[kM]?(?![\w.])/g)].map(match => match[0])
    expect(tokens).toEqual(expect.arrayContaining(['182k', '250k', '1.4M', '3M']))
    for (const token of tokens) {
      const reading = readingOf(token)
      const tolerance = token.endsWith('M') ? 50_000 : token.endsWith('k') ? 500 : 0
      expect([...allowed, ...counts].some(value => Math.abs(value - reading) <= tolerance), token).toBe(true)
    }
  })

  it('the header carries the version from package.json and the banner from lore', () => {
    const html = pageText(seededBus())
    const version = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../../package.json'), 'utf8')) as { version: string }
    expect(html).toContain(`<pre class="banner" aria-label="MIKOSHI">${escaped(BANNER.replace(/^\n/, ''))}</pre>`)
    expect(html).toContain(`<p class="subtitle">${escaped(LORE.subtitle(version.version))}</p>`)
    expect(html).toContain(`<meta http-equiv="refresh" content="30">`)
    expect(html.indexOf('<header')).toBeLessThan(html.indexOf('id="h-services"'))
    expect(html.indexOf('id="h-services"')).toBeLessThan(html.indexOf('id="h-flow"'))
    expect(html.indexOf('id="h-flow"')).toBeLessThan(html.indexOf('id="h-backlog"'))
    expect(html.indexOf('id="h-backlog"')).toBeLessThan(html.indexOf('<footer class="statusline">'))
  })

  it('an eddies tile has no bar while the bus holds no context or spent for it', () => {
    const silent = pageText(seededBus([
      { ts: minutesAgo(3), type: SESSION_HEARTBEAT, card: 861, payload: JSON.stringify({ step: 'launch', session: 's861' }) },
    ]))
    expect(silent).toContain('launch · #861 · — · launch · pulse 3 min ago')
    expect(silent).not.toContain('class="edd')
    const spentOnly = pageText(seededBus([
      { ts: minutesAgo(3), type: SESSION_HEARTBEAT, card: 861, payload: JSON.stringify({ step: 'launch', session: 's861', spent: 2_600_000 }) },
    ]))
    expect(spentOnly).not.toContain('<span class="edd-k">ctx</span>')
    expect(spentOnly).toContain('<div class="edd" data-hot><span class="edd-k">spent</span>')
  })

  it('a gauge above its limit is drawn in the refusal colour', () => {
    const { contextLimit, sessionSpend } = readEddiesLimits()
    const html = pageText(seededBus([
      { ts: minutesAgo(3), type: SESSION_HEARTBEAT, card: 861, payload: JSON.stringify({ step: 'launch', session: 's861', context: contextLimit! + 25_000, spent: sessionSpend! }) },
    ]))
    expect(html).toContain('<div class="edd" data-over><span class="edd-k">ctx</span>')
    expect(html).toContain('<div class="edd" data-hot><span class="edd-k">spent</span>')
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!
    expect(style).toContain('&[data-over] { --_bar: var(--signal); --_value: var(--signal); }')
    expect(style.indexOf('&[data-over]')).toBeGreaterThan(style.indexOf('&[data-hot]'))
  })

  it('the page takes its bars from the projection beside pulse and runs no heartbeat query of its own', () => {
    const html = pageText(seededBus([
      { ts: minutesAgo(4), type: SESSION_HEARTBEAT, card: 861, payload: JSON.stringify({ step: 'launch', session: 's861', context: 120_000 }) },
      { ts: minutesAgo(3), type: SESSION_HEARTBEAT, card: 861, payload: JSON.stringify({ step: 'launch', session: 's861', context: 240_000 }), legacy: true },
    ]))
    expect(html).toContain('<span class="edd-k">ctx</span>')
    expect(html).toContain('<span class="edd-v">120k')
    expect(html).not.toContain('240k')
    const source = readFileSync(path.resolve(import.meta.dirname, '../../bus/board-page.ts'), 'utf8')
    expect(source).toContain('cardGauges(db)')
    expect(source).not.toContain('SESSION_HEARTBEAT')
    expect(source).not.toMatch(/FROM events/)
  })

  it('the board shows bars for every live session, the window tile included', () => {
    const html = pageText(seededBus([
      { ts: minutesAgo(3), type: SESSION_HEARTBEAT, card: 861, payload: JSON.stringify({ step: 'implement', session: 's861', context: 31_000, spent: 52_000 }) },
      { ts: minutesAgo(2), type: WINDOW_HEARTBEAT, card: null, payload: JSON.stringify({ session: 'w1', context: 64_000, spent: 97_000 }) },
    ]))
    const tileOf = (role: string, task: string): string | undefined => html.split('<div class="svc" ').find(tile => tile.startsWith(`data-role="${role}"`) && tile.includes(`<span class="svc-target">${task}</span>`))
    const card = tileOf('implement', '#861')
    expect(card).toContain('<span class="edd-v">31k')
    expect(card).toContain('<span class="edd-v">52k')
    const window = tileOf('window', 'operator')
    expect(window).toContain('<span class="edd-k">ctx</span>')
    expect(window).toContain('<span class="edd-v">64k')
    expect(window).toContain('<span class="edd-v">97k')
  })

  it('the page style declares no custom property it never reads', () => {
    const style = /<style>([\s\S]*?)<\/style>/.exec(pageText(seededBus()))![1]!
    const declared = new Set([...style.matchAll(/(--[\w-]+)\s*:/g)].map(match => match[1]!))
    const read = new Set([...style.matchAll(/var\((--[\w-]+)/g)].map(match => match[1]!))
    expect([...declared].filter(name => !read.has(name))).toEqual([])
  })

  it('a filter anchor is positioned inside the backlog, not the page', () => {
    const html = pageText(seededBus())
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!
    expect(style).toMatch(/\.filter-target \{[^}]*position: absolute/)
    expect(style).toMatch(/\.backlog \{[^}]*position: relative/)
    const backlog = html.slice(html.indexOf('<section class="panel backlog"'))
    expect(backlog.slice(0, backlog.indexOf('</section>'))).toContain('<span class="filter-target" id="show-all"></span>')
  })

  it('the page carries the flow, services and status lines construct board prints', () => {
    const busPath = seededBus()
    const lines = constructBoardLines(busPath)
    const html = pageText(busPath)
    expect(lines).toContain('in work (1): #861')
    expect(html).toContain('<span class="n">1</span><span class="name">in work</span><span class="ids">#861</span>')
    for (const line of lines.slice(lines.indexOf('Services') + 1, -1))
      expect(html).toContain(`<div class="svc-line">${escaped(line)}</div>`)
    const footer = Object.fromEntries(lines.at(-1)!.split(' · ').map(part => part.split(': ') as [string, string]))
    const statusline = html.slice(html.indexOf('<footer class="statusline">'))
    expect(statusline).toContain(`<span>agents <b>${footer['agents at work']}</b></span>`)
    expect(statusline).toContain(`<span>review queue <b>${footer['review queue']}</b></span>`)
    expect(statusline).toContain(`last failure <b>${escaped(footer['last failure']!)}</b>`)
  })

  function sectionOf(html: string, start: string, end: string): string {
    const from = html.indexOf(start)
    expect(from, start).toBeGreaterThanOrEqual(0)
    return html.slice(from, html.indexOf(end, from))
  }

  function liveBusCopy(): string {
    const live = defaultBusPath()
    if (!existsSync(live))
      return seededBus()
    const root = mkdtempSync(path.join(tmpdir(), 'bus-board-live-'))
    roots.push(root)
    const copy = path.join(root, 'bus.db')
    const db = new DatabaseSync(live, { readOnly: true })
    try {
      db.exec(`VACUUM INTO '${copy.replace(/'/g, '\'\'')}'`)
    }
    finally {
      db.close()
    }
    return copy
  }

  it('a page rendered from a copy of the live bus carries every header, Services, Flow and status line element of the sketch', () => {
    const html = pageText(liveBusCopy())
    const limits = readEddiesLimits()
    const header = sectionOf(html, '<p class="kv">', '</p>')
    expect(header).toContain(`<span>model <b>v${readModelVersion()}</b></span>`)
    expect(header).toMatch(/<span>written <b>[^<]+<\/b><\/span>/)
    expect(header).toContain('<span>refresh <b>30s</b></span>')
    expect(header).toMatch(/<span class="live"( data-stale)?>bus (live|stale)<\/span>/)
    const services = sectionOf(html, '<h2 id="h-services">', '<div class="svc-grid">')
    expect(services).toMatch(/<span class="meta">quickhacks on the subnet · agents at work <b>\d+<\/b> · slots <b>[^<]+<\/b> \(bus records no capacity\)<\/span>/)
    expect(services).toContain(`<span class="meta right edd-note">eddies: warn line <b>${Math.round(limits.warnRatio! * 100)}%</b></span>`)
    const flowNote = sectionOf(html, '<div class="flow-note">', '</div>')
    expect(flowNote).toMatch(/<span class="fail"( data-none)?>last failure <b>[^<]+<\/b><\/span>/)
    const statusline = sectionOf(html, '<footer class="statusline">', '</footer>')
    expect(statusline).toContain('<span class="mode">BOARD</span>')
    expect(statusline).toMatch(/<span>subnet <b class="live"( data-stale)?>(pulse \d+ min|no pulse)<\/b><\/span>/)
    expect(statusline).toMatch(/<span class="fail"( data-none)?>last failure <b>[^<]+<\/b><\/span>/)
    expect(statusline).toContain('<span>geek mode <b>--geek</b></span>')
    expect(statusline).toContain('<span class="cursor">construct board</span>')
    expect(html).not.toContain('sample values')
  })

  it('a bus pulse older than the threshold shows bus stale, not blinking', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bus-board-stale-'))
    roots.push(root)
    const page = (minutes: number): string => pageText(writeBus(path.join(root, `bus-${minutes}.db`), { events: [{ ts: minutesAgo(minutes), type: 'netwatch.tick', card: null, payload: '{}' }] }))
    const fresh = page(FRESH_MS / 60_000)
    expect(fresh).toContain('<span class="live">bus live</span>')
    expect(fresh).toContain(`<b class="live">pulse ${FRESH_MS / 60_000} min</b>`)
    const stale = page(FRESH_MS / 60_000 + 1)
    expect(stale).toContain('<span class="live" data-stale>bus stale</span>')
    expect(stale).toContain(`<b class="live" data-stale>pulse ${FRESH_MS / 60_000 + 1} min</b>`)
    expect(stale).not.toContain('bus live')
    const style = /<style>([\s\S]*?)<\/style>/.exec(stale)![1]!
    const live = /\n\.live \{([\s\S]*?)\n\}/.exec(style)![1]!
    expect(live).toMatch(/&\[data-stale\] \{ --_fg: var\(--signal\); --_blink: none; \}/)
    expect(live).toMatch(/&::before \{[^}]*animation: var\(--_blink\)/)
    expect(pageText(writeBus(path.join(root, 'silent.db'), {}))).toContain('<span class="live" data-stale>bus stale</span>')
  })

  it('the blink stops under prefers-reduced-motion', () => {
    const style = /<style>([\s\S]*?)<\/style>/.exec(pageText(seededBus()))![1]!
    expect(style).toMatch(/@keyframes --animation-blink \{/)
    expect(style).toMatch(/--_blink: --animation-blink /)
    expect(style).toMatch(/\.cursor::after \{[^}]*animation: --animation-blink /)
    const reduced = /@media \(prefers-reduced-motion: reduce\) \{([^}]*)\}/.exec(style)![1]!
    const selectors = reduced.slice(0, reduced.indexOf('{')).split(',').map(selector => selector.trim())
    expect(selectors).toEqual(expect.arrayContaining(['.live::before', '.statusline .cursor::after']))
    expect(reduced).toContain('animation: none;')
  })

  it('the last failure is red in Flow and in the status line, and dim when there is none', () => {
    const failed = pageText(seededBus([{ ts: minutesAgo(4), type: 'card.stopped', card: 861, payload: JSON.stringify({ reason: 'fault', detail: 'no pull request' }) }]))
    const line = `<span class="fail">last failure <b>card #861 stopped on a fault at ${minutesAgo(4)}</b></span>`
    expect(sectionOf(failed, '<div class="flow-note">', '</div>')).toContain(line)
    expect(sectionOf(failed, '<footer class="statusline">', '</footer>')).toContain(line)
    expect(pageText(seededBus())).toContain('<span class="fail" data-none>last failure <b>none</b></span>')
    const style = /<style>([\s\S]*?)<\/style>/.exec(failed)![1]!
    expect(style).toMatch(/\n\.fail \{\n {2}--_fg: var\(--signal\);/)
  })

  it('the page reads liveness from the bus pulse and lists no process', () => {
    const html = pageText(seededBus())
    expect(html).toContain('bus · pulse · — · pulse 1 min ago · slots in use: review 1')
    expect(html).not.toContain('pid ')
    expect(html).not.toContain('<h2>Health</h2>')
  })
})
