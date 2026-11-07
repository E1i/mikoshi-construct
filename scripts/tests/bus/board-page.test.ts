import type { BusFacts } from '../../../src/commands/board/bus.js'
import type { BusSeed, SeedBeat, SeedEvent } from '../../../tests/board/bus-fixture.js'
import type { BoardData, BoardFiles } from '../../cli/board-page.js'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os, { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import vm from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runsFieldLine, witnessFieldsLine } from '../../../src/card/witness-fields.js'
import { busFacts, busReaderAt, CARD_STAGES } from '../../../src/commands/board/bus.js'
import { planLine, RELEASE_STAGES } from '../../../src/commands/board/goal.js'
import { printBoard as printConstructBoard, readBoard } from '../../../src/commands/board/index.js'
import { backlogCards } from '../../../src/commands/board/screens.js'
import { WINDOW_SILENT_MS } from '../../../src/commands/liveness.js'
import { createUi } from '../../../src/ui/console.js'
import { BANNER, LORE } from '../../../src/ui/lore.js'
import { resolveTheme } from '../../../src/ui/theme.js'
import { checkMatrix, subagent, writeBus } from '../../../tests/board/bus-fixture.js'
import { BOARD_DATA_FILE, boardProjection, DISK_FILES, escaped, filterRule, FLOW_META, printBoard, PROGRESS_ORDER, readEddiesLimits, readModelVersion, RELEASE_PROGRESS_ORDER, VIEW_KEY, writeBoardPage } from '../../cli/board-page.js'
import { defaultBusPath } from '../../core/db.js'
import { PROCESS_HEARTBEAT, REVIEW_RECORDED, SESSION_HEARTBEAT, WINDOW_HEARTBEAT, WITNESS_FIELDS_BACKFILLED, WITNESS_RECORDED } from '../../core/events.js'
import { nodeProcess } from '../../core/node.js'
import { witnessFieldsBackfillOf } from '../../intake/witness-fields-backfill.js'
import { TICK_MS } from '../../ports/netwatch.js'
import { slotsOf as slotsOfKind, slotsVariable } from '../../supervisor/scheduler.js'
import { BOARD_FILE, FRESH_MS } from '../../window/board.js'

const roots: string[] = []

beforeEach(() => {
  vi.stubEnv('BUS_RERUN', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
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

type Listener = (event: FakeEvent) => void

interface FakeEvent {
  target?: FakeElement
  key?: string
  preventDefault?: () => void
}

class FakeElement {
  readonly dataset: Record<string, string> = {}
  readonly listeners = new Map<string, Listener[]>()
  readonly attributes = new Map<string, string>()
  readonly prepended: FakeElement[] = []
  writes = 0
  private html = ''
  textContent = ''
  className = ''
  id = ''
  src = ''
  scrollTop = 0
  open = false
  removed = false
  onload: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(readonly tagName: string, opens?: string) {
    if (opens !== undefined)
      this.dataset.open = opens
  }

  get innerHTML(): string {
    return this.html
  }

  set innerHTML(next: string) {
    this.writes++
    this.html = next
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  prepend(child: FakeElement): void {
    this.prepended.unshift(child)
  }

  remove(): void {
    this.removed = true
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...this.listeners.get(type) ?? [], listener])
  }

  dispatch(type: string, event: FakeEvent = {}): void {
    for (const listener of this.listeners.get(type) ?? [])
      listener({ target: this, ...event })
  }

  closest(selector: string): FakeElement | null {
    return selector === '[data-open]' && this.dataset.open !== undefined ? this : null
  }

  showModal(): void {
    this.open = true
  }

  close(): void {
    if (!this.open)
      return
    this.open = false
    this.dispatch('close')
  }
}

class MemoryStorage {
  readonly items = new Map<string, string>()

  getItem(key: string): string | null {
    return this.items.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.items.set(key, value)
  }
}

const THROWING_STORAGE = 'throws'

function templatesOf(html: string): Map<string, string> {
  return new Map([...html.matchAll(/<template id="([^"]+)">([\s\S]*?)<\/template>/g)].map(match => [match[1]!, match[2]!]))
}

function openersOf(html: string): { tag: string, dialog: string }[] {
  return [...html.matchAll(/<(\w+) [^>]*data-open="([^"]+)"/g)].map(match => ({ tag: match[1]!.toUpperCase(), dialog: match[2]! }))
}

function idsOf(html: string): string[] {
  return [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]!)
}

const SLOT_ENDS: Record<string, string> = {
  kv: '</p></div>\n<div class="goal"',
  goal: '</div>\n</header>',
  waits: '</div>\n<div class="warnings"',
  warnings: '</div>\n<section class="panel bevel" id="slot-services"',
  services: '\n</section>',
  flow: '\n</section>',
  backlog: '</div>\n<div class="scroll"',
  rows: '\n</table>',
  status: '</footer>',
  dialogs: '</div>\n<script>',
}

function slotsOf(html: string): Map<string, string> {
  return new Map(Object.entries(SLOT_ENDS).map(([name, end]) => {
    const open = html.indexOf('>', html.indexOf(`id="slot-${name}"`)) + 1
    const from = html[open] === '\n' ? open + 1 : open
    return [name, html.slice(from, html.indexOf(end, from))]
  }))
}

function boardWindow(html: string, storage: MemoryStorage | typeof THROWING_STORAGE, hash = '') {
  const shellIds = new Set(idsOf(html))
  const elements = new Map<string, FakeElement>()
  for (const [name, inner] of slotsOf(html))
    elements.set(`slot-${name}`, Object.assign(new FakeElement('DIV'), { innerHTML: inner }))
  const slots = (): FakeElement[] => [...elements].filter(([id]) => id.startsWith('slot-')).map(([, slot]) => slot)
  const templates = (): Map<string, string> => templatesOf(elements.get('slot-dialogs')?.innerHTML ?? html)
  const known = (id: string): boolean => shellIds.has(id) || slots().some(slot => idsOf(slot.innerHTML).includes(id)) || elements.get('backlog')?.prepended.some(child => child.id === id) === true
  const element = (id: string): FakeElement => {
    const found = elements.get(id) ?? new FakeElement(id === 'drill' ? 'DIALOG' : 'DIV')
    const template = templates().get(id)
    if (template !== undefined)
      found.innerHTML = template
    elements.set(id, found)
    return found
  }
  const appended: FakeElement[] = []
  const timeouts: { run: () => void, ms: number }[] = []
  const body = /<body data-written="([^"]*)" data-tick-ms="([^"]*)">/.exec(html)!
  const document = Object.assign(new FakeElement('DOCUMENT'), { title: /<title>([^<]*)<\/title>/.exec(html)![1]!, body: { dataset: { written: body[1]!, tickMs: body[2]! } } })
  const page = new FakeElement('WINDOW')
  let current = hash
  const location = {
    get hash() {
      return current
    },
    set hash(next: string) {
      current = next
      page.dispatch('hashchange')
    },
  }
  const context: Record<string, unknown> = {
    document: Object.assign(document, {
      getElementById: (id: string) => known(id) ? elements.get('backlog')?.prepended.find(child => child.id === id) ?? element(id) : null,
      createElement: (tag: string) => new FakeElement(tag.toUpperCase()),
      querySelectorAll: () => [],
      head: { appendChild: (child: FakeElement) => appended.push(child) },
    }),
    location,
    addEventListener: (type: string, listener: Listener) => page.addEventListener(type, listener),
    setTimeout: (run: () => void, ms: number) => timeouts.push({ run, ms }),
    Date: { now: () => Date.parse(body[1]!), parse: Date.parse },
  }
  context.window = context
  if (storage === THROWING_STORAGE) {
    Object.defineProperty(context, 'localStorage', {
      get: () => {
        throw new Error('SecurityError: localStorage is off')
      },
    })
  }
  else {
    context.localStorage = storage
  }
  vm.createContext(context)
  vm.runInContext(/<script>([\s\S]*?)<\/script>/.exec(html)![1]!, context)
  const tick = (data: string | null): FakeElement => {
    expect(timeouts).toHaveLength(1)
    timeouts.splice(0)[0]!.run()
    const script = appended.at(-1)!
    if (data === null) {
      script.onerror?.()
      return script
    }
    try {
      vm.runInContext(data, context)
    }
    catch {}
    script.onload?.()
    return script
  }
  return {
    templates: templates(),
    currentTemplates: templates,
    elements,
    timeouts,
    document,
    tick,
    location,
    dialog: element('drill'),
    content: element('drill-content'),
    scroller: element('backlog-scroll'),
    click: (tag: string, dialog: string): void => document.dispatch('click', { target: new FakeElement(tag, dialog) }),
    key: (key: string, target = new FakeElement('BODY')): void => document.dispatch('keydown', { key, target, preventDefault: () => {} }),
  }
}

describe('board.html', () => {
  const NOW = new Date('2026-10-20T08:00:00.000Z')

  function minutesAgo(minutes: number): string {
    return new Date(NOW.getTime() - minutes * 60_000).toISOString()
  }

  const SECOND_CARD_TEXT = [
    'card: #861 second [implement/netwatch/S/cheap/owner] · depends — · blocks —',
    'branch: feat/second',
    'touches: scripts/cli/board-page.ts',
    'continue: stop',
    'who: shift',
    '',
    'The second card follows #860 and runs `pnpm card` once.',
    '',
    'Witnesses:',
    '- `pnpm exec vitest run scripts/tests/bus/board-page.test.ts` exits 0',
    '',
    'risk: R4 — low: tests close it',
  ].join('\n')
  const SECOND_CARD_SHA = 'c0ffee1181a5f00dbeef'

  function busWithRecords(file: string, seed: BusSeed): string {
    writeBus(file, seed)
    const db = new DatabaseSync(file)
    try {
      db.exec('ALTER TABLE card_bodies ADD COLUMN admission_event_id INTEGER; ALTER TABLE card_bodies ADD COLUMN text_sha TEXT NOT NULL DEFAULT \'\'')
      db.exec('UPDATE card_bodies SET admission_event_id = (SELECT event_id FROM cards WHERE cards.card_id = card_bodies.card_id)')
      db.prepare('UPDATE card_bodies SET text_sha = ? WHERE card_id = 861').run(SECOND_CARD_SHA)
    }
    finally {
      db.close()
    }
    return file
  }

  function seededBus(heartbeats: SeedEvent[] = [], beats: SeedBeat[] = []): string {
    const root = mkdtempSync(path.join(tmpdir(), 'bus-board-screens-'))
    roots.push(root)
    return busWithRecords(path.join(root, 'bus.db'), {
      cards: [
        { id: 860, state: 'queued', lane: 'lane-1', line: 'card: #860 first <task>', since: minutesAgo(30), pr: 13 },
        { id: 861, state: 'running', lane: 'lane-1', line: '#861 second', since: minutesAgo(20), text: SECOND_CARD_TEXT },
        { id: 862, state: 'in_review', lane: 'lane-2', line: null, since: minutesAgo(10), pr: 12 },
        { id: 863, state: 'merged', lane: null, line: '#863 done', since: minutesAgo(5) },
        { id: 864, state: 'merged', lane: 'lane-2', line: '#864 old-lease [implement/netwatch/M/cheap/owner] · depends #860 · blocks —', since: minutesAgo(1_200) },
      ],
      verdicts: [[12, null]],
      tasks: [{ queue: 'review', card: 862, pr: 12, head: 'abcdef1234567', state: 'leased' }],
      roles: [{ role: 'operator', status: 'idle', state: 'awake' }],
      decisions: [[216, 'Prerelease rights stay with the shard until #863 ships.']],
      events: [
        { ts: minutesAgo(1), type: 'netwatch.tick', card: null, payload: '{}' },
        subagent(minutesAgo(2), { role: 'implementer', task: '#861', session: 's1', tree: '/trees/mc-861', step: 'writing' }),
        checkMatrix(12, 'abcdef1234567', { killed: 3, survived: 1, notRun: 0 }),
        { ts: minutesAgo(1), type: REVIEW_RECORDED, card: 861, payload: JSON.stringify({ verdict: 'changes' }) },
        ...heartbeats,
      ],
      beats,
    })
  }

  function handoffBeside(busPath: string): string {
    return path.join(path.dirname(busPath), 'miko.md')
  }

  function constructBoardLines(busPath: string): string[] {
    let out = ''
    const ui = createUi(resolveTheme({ plain: true }), (text) => {
      out += text
    })
    printConstructBoard(ui, readBoard(path.dirname(busPath), { all: false, staleHours: 4, prs: undefined, readStdin: () => '', now: NOW, bus: busReaderAt(busPath, () => NOW) }))
    return out.trimEnd().split('\n')
  }

  function pageText(busPath: string, eddiesFile?: string): string {
    let html = ''
    expect(printBoard(busPath, NOW, (text) => {
      html += text
    }, handoffBeside(busPath), 'html', eddiesFile)).toBe(0)
    return html
  }

  function pageUnderLimits(limits: object, beat: object): string {
    const busPath = seededBus([
      { ts: minutesAgo(3), type: SESSION_HEARTBEAT, card: 861, payload: JSON.stringify({ step: 'launch', session: 's861', ...beat }) },
    ])
    const eddiesFile = path.join(path.dirname(busPath), 'eddies.json')
    writeFileSync(eddiesFile, JSON.stringify(limits))
    return pageText(busPath, eddiesFile)
  }

  function visibleText(html: string): string {
    return html.replace(/<style>[\s\S]*?<\/style>/g, ' ').replace(/<script>[\s\S]*?<\/script>/g, ' ').replace(/<title>[\s\S]*?<\/title>/g, ' ').replace(/<[^>]*>/g, ' ').replace(/&#39;|&quot;|&lt;|&gt;|&amp;/g, ' ')
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
    expect(html).toContain('<tr data-card="864" data-stage="merged" data-open="card-864" tabindex="0" aria-haspopup="dialog"><td class="id">#864</td><td class="slug">old-lease</td><td>implement</td><td>netwatch</td><td>M</td><td>cheap</td><td>owner</td><td>#860</td><td>—</td>')
  })

  it('every number on the page is in the bus, in eddies.json or in the machine load', () => {
    const load = 4.5
    const cores = 16
    vi.spyOn(os, 'loadavg').mockReturnValue([load, 0, 0])
    vi.spyOn(os, 'availableParallelism').mockReturnValue(cores)
    const busPath = seededBus([
      { ts: minutesAgo(3), type: SESSION_HEARTBEAT, card: 861, payload: JSON.stringify({ step: 'launch', session: 's861', context: 182_345, spent: 1_412_000 }) },
    ])
    const html = pageText(busPath)
    const limits = readEddiesLimits()
    const version = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../../package.json'), 'utf8')) as { version: string }
    const warnLine = limits.warnRatio === null ? [] : [Math.round(limits.warnRatio * 100)]
    const allowed = [load, cores, ...busNumbers(busPath), ...Object.values(limits).filter(value => typeof value === 'number'), ...limits.modelWindows.values(), ...warnLine, readModelVersion() ?? 0, ...version.version.split('.').map(Number), ...NOW.toISOString().split(/\D+/).filter(Boolean).map(Number)]
    const counts = Array.from({ length: 6 }, (_, at) => at)
    const tokens = [...visibleText(html).matchAll(/(?<![\w.#-])\d+(?:\.\d+)?[kM]?(?![\w.])/g)].map(match => match[0])
    expect(tokens).toEqual(expect.arrayContaining(['182k', '1.4M', '3M']))
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
    expect(html).not.toContain('http-equiv="refresh"')
    expect(html.indexOf('<header')).toBeLessThan(html.indexOf('id="h-services"'))
    expect(html.indexOf('id="h-services"')).toBeLessThan(html.indexOf('id="h-flow"'))
    expect(html.indexOf('id="h-flow"')).toBeLessThan(html.indexOf('id="h-backlog"'))
    expect(html.indexOf('id="h-backlog"')).toBeLessThan(html.indexOf('<footer class="statusline"'))
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

  it('a value equal to the card line is hot and not over', () => {
    const html = pageUnderLimits({ contextLimit: 250_000, cardContextLine: 150_000, warnRatio: 1 }, { context: 150_000 })
    expect(html).toContain('<div class="edd" data-hot><span class="edd-k">ctx</span>')
    expect(html).not.toContain('<div class="edd" data-over><span class="edd-k">ctx</span>')
  })

  it('a zero or negative model window is dropped and shows no denominator', () => {
    const modelWindows = { 'claude-zero': 0, 'claude-negative': -1_000_000, 'claude-sized': 1_000_000 }
    const pageOf = (model: string): string => pageUnderLimits({ contextLimit: 250_000, warnRatio: 0.8, modelWindows }, { context: 151_000, model })
    for (const model of ['claude-zero', 'claude-negative']) {
      const html = pageOf(model)
      expect(html, model).toContain('<span class="edd-v">151k</span>')
      expect(html, model).not.toContain('151k/')
    }
    expect(pageOf('claude-sized')).toContain('<span class="edd-v">151k/1M</span>')
  })

  it('the warnings strip stands above SERVICES and reads the gauge the tile reads', () => {
    const { contextLimit, cardContextLine } = readEddiesLimits()
    const html = pageText(seededBus([
      { ts: minutesAgo(3), type: SESSION_HEARTBEAT, card: 861, payload: JSON.stringify({ step: 'launch', session: 's861', context: contextLimit! + 35_000 }) },
    ]))
    const strip = slotsOf(html).get('warnings')!
    expect(strip).toContain(`<span class="warning" data-level="red">#861: ctx ${(contextLimit! + 35_000) / 1000}k of ${(cardContextLine ?? contextLimit!) / 1000}k, over the limit</span>`)
    expect(html.indexOf('id="slot-warnings"')).toBeLessThan(html.indexOf('id="slot-services"'))
    expect(html.indexOf('id="slot-warnings"')).toBeGreaterThan(html.indexOf('id="slot-waits"'))
  })

  it('a finished session above the line is no warning: only a session the board shows as live counts', () => {
    const { contextLimit } = readEddiesLimits()
    const html = pageText(seededBus([
      { ts: minutesAgo(3), type: SESSION_HEARTBEAT, card: 863, payload: JSON.stringify({ step: 'launch', session: 's863', context: contextLimit! + 35_000 }) },
    ]))
    expect(slotsOf(html).get('warnings')).toBe('')
  })

  it('a window past its last beat keeps its bar and gives no warning', () => {
    const { contextLimit } = readEddiesLimits()
    const context = contextLimit! + 35_000
    const gone = pageText(seededBus([{ ts: minutesAgo(WINDOW_SILENT_MS / 60_000 + 1), type: WINDOW_HEARTBEAT, card: null, payload: JSON.stringify({ session: 'w', context }) }]))
    expect(gone).toContain('<div class="edd" data-over><span class="edd-k">ctx</span>')
    expect(slotsOf(gone).get('warnings')).toBe('')
    const live = pageText(seededBus([{ ts: minutesAgo(2), type: WINDOW_HEARTBEAT, card: null, payload: JSON.stringify({ session: 'w', context }) }]))
    expect(slotsOf(live).get('warnings')).toContain('window: ctx')
    expect(slotsOf(live).get('warnings')!.match(/window: ctx/g)).toHaveLength(1)
  })

  it('the page takes its bars from the session facts of the bus and runs no heartbeat query of its own', () => {
    const html = pageText(seededBus([
      { ts: minutesAgo(4), type: SESSION_HEARTBEAT, card: 861, payload: JSON.stringify({ step: 'launch', session: 's861', context: 120_000 }) },
      { ts: minutesAgo(3), type: SESSION_HEARTBEAT, card: 861, payload: JSON.stringify({ step: 'launch', session: 's861', context: 240_000 }), legacy: true },
    ]))
    expect(html).toContain('<span class="edd-k">ctx</span>')
    expect(html).toContain('<span class="edd-v">120k')
    expect(html).not.toContain('240k')
    const source = readFileSync(path.resolve(import.meta.dirname, '../../cli/board-page.ts'), 'utf8')
    expect(source).toContain('service.gauges')
    expect(source).not.toContain('SESSION_HEARTBEAT')
    expect(source).not.toMatch(/FROM events/)
  })

  it('the board shows bars for every live session, the window tile included', () => {
    const html = pageText(seededBus([
      { ts: minutesAgo(3), type: SESSION_HEARTBEAT, card: 861, payload: JSON.stringify({ step: 'implement', session: 's861', context: 31_000, spent: 52_000 }) },
      { ts: minutesAgo(2), type: WINDOW_HEARTBEAT, card: null, payload: JSON.stringify({ session: 'w1', context: 64_000, spent: 97_000 }) },
    ]))
    const tileOf = (role: string, task: string): string | undefined => html.split('<div class="svc bevel" ').find(tile => tile.startsWith(`data-role="${role}"`) && tile.includes(`<span class="svc-target">${task}</span>`))
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
    const backlog = html.slice(html.indexOf('<section class="panel backlog bevel"'))
    expect(backlog.slice(0, backlog.indexOf('</section>'))).toContain('<span class="filter-target" id="show-all"></span>')
  })

  it('the page carries the flow, services and status lines construct board prints', () => {
    const busPath = seededBus()
    const lines = constructBoardLines(busPath)
    const html = pageText(busPath)
    expect(lines).toContain('in work (1): #861')
    expect(html).toContain('<span class="name">in work</span><span class="n">1</span><span class="ids"><button type="button" class="cid" data-open="card-861" tabindex="0" aria-haspopup="dialog">#861 ›</button></span>')
    for (const line of lines.slice(lines.indexOf('Services') + 1, -1))
      expect(html).toContain(`<div class="svc-line">${escaped(line)}</div>`)
    const footer = Object.fromEntries(lines.at(-1)!.split(' · ').map(part => part.split(': ') as [string, string]))
    const statusline = html.slice(html.indexOf('<footer class="statusline"'))
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
    const header = sectionOf(html, '<p class="kv"', '</p>')
    expect(header).toContain(`<span>model <b>v${readModelVersion()}</b></span>`)
    expect(header).toMatch(/<span>written <b>[^<]+<\/b><\/span>/)
    expect(header).toContain('<span>refresh <b>—</b></span>')
    expect(header).toMatch(/<span class="live" id="bus-live"( data-stale)?>bus (live|offline)<\/span>/)
    const services = sectionOf(html, '<h2 id="h-services">', '<div class="svc-grid">')
    expect(services).toMatch(/<span class="meta">quickhacks on the subnet · agents at work <b>\d+<\/b> · slots <b>[^<]+<\/b><\/span>/)
    const cardLine = limits.cardContextLine === null ? '' : ` · card line <b>${limits.cardContextLine / 1000}k</b>`
    expect(services).toContain(`<span class="meta right edd-note">eddies: warn line <b>${Math.round(limits.warnRatio! * 100)}%</b>${cardLine}</span>`)
    const flowNote = sectionOf(html, '<div class="flow-note">', '</div>')
    expect(flowNote).toMatch(/<span class="fail"( data-none)?>last failure <b>[^<]+<\/b><\/span>/)
    const statusline = sectionOf(html, '<footer class="statusline"', '</footer>')
    expect(statusline).toContain('<span class="mode">BOARD</span>')
    expect(statusline).toMatch(/<span>subnet <b class="live" id="bus-pulse"( data-stale)?>(pulse \d+ min|no pulse)<\/b><\/span>/)
    expect(statusline).toMatch(/<span class="fail"( data-none)?>last failure <b>[^<]+<\/b><\/span>/)
    expect(statusline).toContain('<span>geek mode <b>--geek</b></span>')
    expect(statusline).toContain('<span class="cursor">construct board</span>')
    expect(html).not.toContain('sample values')
  })

  function liveFacts(busPath: string): BusFacts {
    const db = new DatabaseSync(busPath, { readOnly: true })
    try {
      return busFacts(db, NOW)
    }
    finally {
      db.close()
    }
  }

  function numbersIn(html: string): number[] {
    return [...visibleText(html).matchAll(/\d+/g)].map(match => Number(match[0]))
  }

  it('a page rendered from a copy of the live bus draws the goal bar and the Flow legend from the board facts and no number outside the bus', () => {
    const busPath = liveBusCopy()
    const facts = liveFacts(busPath)
    const html = pageText(busPath)
    const slots = slotsOf(html)
    const flow = slots.get('flow')!
    const goal = slots.get('goal')!
    const shown = backlogCards(facts.cards, facts.at, false)
    const byStage = CARD_STAGES.map(stage => ({ stage, cards: shown.filter(card => card.stage === stage).map(card => card.id) }))
    const stages = PROGRESS_ORDER.map(stage => byStage.find(entry => entry.stage === stage)!)
    expect(new Set(PROGRESS_ORDER)).toEqual(new Set(CARD_STAGES))
    const legend = [...flow.matchAll(/<div class="stage"( data-empty)?><i class="sw" data-stage="([^"]+)"><\/i><span class="name">([^<]+)<\/span><span class="n">(\d+)<\/span>(?:<span class="ids">(.*?)<\/span>)?<\/div>/g)]
    expect(legend.map(row => ({ stage: row[2], name: row[3], n: Number(row[4]), empty: row[1] !== undefined }))).toEqual(stages.map(entry => ({ stage: entry.stage, name: entry.stage, n: entry.cards.length, empty: entry.cards.length === 0 })))
    for (const [at, row] of legend.entries()) {
      const shown = [...(row[5] ?? '').matchAll(/#(\d+)/g)].map(match => Number(match[1]))
      expect(shown, row[2]).toEqual(['merged', 'dropped'].includes(row[2]!) ? [] : stages[at]!.cards)
    }
    if (facts.goal === null) {
      expect(goal).toBe('')
    }
    else {
      const segments = [...goal.matchAll(/<i class="sw" data-stage="([^"]+)" style="--_n: (\d+)"/g)].map(match => Number(match[2]))
      expect(segments.reduce((sum, n) => sum + n, 0)).toBe(facts.goal.plans.reduce((sum, plan) => sum + plan.total, 0))
      for (const plan of facts.goal.plans)
        expect(goal).toContain(`<span class="goal-name">${escaped(planLine(plan, facts.goal.backlog))}</span>`)
    }
    const allowed = new Set([...busNumbers(busPath), ...stages.map(entry => entry.cards.length)])
    for (const number of numbersIn(flow.slice(0, flow.indexOf('<div class="flow-note">'))))
      expect(allowed.has(number), String(number)).toBe(true)
    for (const drawn of [goal, flow, slots.get('waits')!]) {
      expect(drawn).not.toContain('sample')
      expect(drawn).not.toContain('factory for all users')
    }
  })

  it('every card stage and every release stage has its swatch colour, stopped hatched, and a bus with no open plan draws no goal', () => {
    const html = pageText(seededBus())
    expect(slotsOf(html).get('goal')).toBe('')
    expect(slotsOf(html).get('flow')).toContain(`<span class="meta">${FLOW_META}</span>`)
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!
    const sw = /\n\.sw \{([\s\S]*?)\n\}/.exec(style)![1]!
    for (const stage of [...CARD_STAGES, ...RELEASE_STAGES])
      expect(sw, stage).toContain(`&[data-stage="${stage}"]`)
    expect(new Set(RELEASE_PROGRESS_ORDER)).toEqual(new Set(RELEASE_STAGES))
    expect(sw).toMatch(/&\[data-stage="stopped"\] \{[^}]*--_paint: repeating-linear-gradient\(135deg/)
  })

  function busOf(seed: BusSeed): string {
    const root = mkdtempSync(path.join(tmpdir(), 'bus-board-truth-'))
    roots.push(root)
    return busWithRecords(path.join(root, 'bus.db'), { events: [{ ts: minutesAgo(1), type: 'netwatch.tick', card: null, payload: '{}' }], ...seed })
  }

  function legendIds(html: string, stage: string): number[] | undefined {
    const row = new RegExp(`<i class="sw" data-stage="${stage}"></i><span class="name">[^<]+</span><span class="n">(\\d+)</span>(?:<span class="ids">(.*?)</span>)?</div>`).exec(slotsOf(html).get('flow')!)
    return row === null ? undefined : [...(row[2] ?? '').matchAll(/#(\d+)/g)].map(match => Number(match[1]))
  }

  it('a stopped card with an answer in lease shows as answer/changes in FLOW and LIVE', () => {
    const busPath = busOf({
      cards: [{ id: 870, state: 'stopped', lane: 'lane-1', line: 'card: #870 asks [implement/netwatch/S/cheap/owner] · depends — · blocks —', since: minutesAgo(30), pr: 14 }],
      tasks: [{ queue: 'answer', card: 870, pr: 14, head: 'abcdef1234567', state: 'leased' }],
    })
    const html = pageText(busPath)
    expect(liveFacts(busPath).cards.map(card => card.stage)).toEqual(['answer/changes'])
    expect(legendIds(html, 'answer/changes')).toEqual([870])
    expect(legendIds(html, 'stopped')).toEqual([])
    expect(html).toContain('<tr data-card="870" data-stage="answer/changes" data-live')
    expect(constructBoardLines(busPath)).toContain('in work (1): #870')
  })

  it('a stopped card shows in the STOPPED row', () => {
    const busPath = busOf({
      cards: [
        { id: 871, state: 'stopped', lane: 'lane-1', line: 'card: #871 asks', since: minutesAgo(30) },
        { id: 873, state: 'merged', lane: null, line: 'card: #873 done', since: minutesAgo(10) },
        { id: 874, state: 'queued', lane: 'lane-1', line: 'card: #874 next', since: minutesAgo(10) },
      ],
      tasks: [{ queue: 'answer', card: 871, pr: null, head: null, state: 'queued' }],
    })
    const html = pageText(busPath)
    expect(legendIds(html, 'stopped')).toEqual([871])
    expect(slotsOf(html).get('flow')).toContain('<span class="name">merged</span><span class="n">1</span>')
    expect(legendIds(html, 'planned')).toEqual([874])
    expect(html).toContain('<tr data-card="871" data-stage="stopped" data-open')
  })

  it('one process is one tile', () => {
    const busPath = busOf({
      cards: [{ id: 872, state: 'changes', lane: 'lane-1', line: 'card: #872 fixes', since: minutesAgo(30), pr: 15 }],
      tasks: [{ queue: 'answer', card: 872, pr: 15, head: '52918a5abcdef', state: 'leased' }],
      events: [{ ts: minutesAgo(1), type: SESSION_HEARTBEAT, card: 872, payload: JSON.stringify({ step: 'answer', session: 's872', context: 169_000 }) }],
    })
    const html = pageText(busPath)
    const tiles = html.split('<div class="svc bevel" ').filter(tile => tile.includes('<span class="svc-target">#872</span>'))
    expect(tiles).toHaveLength(1)
    expect(tiles[0]).toContain('answer · pulse 1 min ago')
    expect(tiles[0]).toContain('<span class="edd-v">169k')
    const facts = liveFacts(busPath)
    expect(new Set(facts.services.map(service => `${service.role} ${service.task}`)).size).toBe(facts.services.length)
  })

  it('a services tile with six-digit CTX and SPENT shows each number whole', () => {
    const html = pageText(seededBus([
      { ts: minutesAgo(3), type: SESSION_HEARTBEAT, card: 861, payload: JSON.stringify({ step: 'launch', session: 's861', context: 182_345, spent: 2_950_000 }) },
    ]))
    const { sessionSpend } = readEddiesLimits()
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!
    const edd = /\n\.edd \{([\s\S]*?)\n\}/.exec(style)![1]!
    expect(edd).toContain('max-content')
    expect(style).toMatch(/\.edd-v \{[^}]*white-space: nowrap/)
    expect(html).toContain('<span class="edd-v">182k</span>')
    expect(html).toMatch(new RegExp(`<span class="edd-v">3M${sessionSpend === null ? '' : '/\\d+(?:\\.\\d)?[kM]'}</span>`))
  })

  it('the board page lays out each eddies gauge as a three-column grid with a filled bar', () => {
    const { sessionSpend } = readEddiesLimits()
    const html = pageText(seededBus([
      { ts: minutesAgo(3), type: SESSION_HEARTBEAT, card: 861, payload: JSON.stringify({ step: 'launch', session: 's861', context: 120_000, spent: 120_000 }) },
    ]))
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!
    const edd = /\n\.edd \{([\s\S]*?)\n\}/.exec(style)![1]!
    expect(edd).toContain('display: grid;')
    expect(edd).not.toContain('flex')
    expect(edd).toMatch(/grid-template-columns: \S+ minmax\(0, 1fr\) max-content;/)
    expect(edd).toContain('column-gap: var(--space-s);')
    expect(edd).toContain('min-inline-size: 0;')
    const bar = /\n\.edd-bar \{([\s\S]*?)\n\}/.exec(style)![1]!
    expect(bar).toContain('min-inline-size: 0;')
    expect(bar).not.toContain('flex')
    expect(style).toMatch(/\.edd-v \{[^}]*justify-self: end/)
    const gaugeRules = [edd, bar, /\.edd-k \{[^}]*\}/.exec(style)![0], /\.edd-v \{[^}]*\}/.exec(style)![0]]
    for (const rule of gaugeRules)
      expect(rule.replace(/^\s*--[\w-]+:.*$/gm, '')).not.toMatch(/\d(?:\.\d+)?rem/)
    if (sessionSpend !== null)
      expect(html).toMatch(/<div class="edd"[^>]*><span class="edd-k">spent<\/span><span class="edd-bar" style="--_fill: \d+%/)
  })

  it('a pull request number in prose stays text and only a card number opens its card', () => {
    const busPath = busOf({
      cards: [{ id: 861, state: 'running', lane: 'lane-1', line: 'card: #861 second', since: minutesAgo(20) }],
      decisions: [[217, 'PR #861 merges after #861 ships.']],
    })
    const html = pageText(busPath)
    expect(html).toContain('<span>PR #861 merges after <button type="button" class="cid" data-open="card-861" tabindex="0" aria-haspopup="dialog">#861 ›</button> ships.</span>')
  })

  it('the waits-for-you strip is absent when the fact is empty', () => {
    const busPath = seededBus()
    expect(liveFacts(busPath).waits).toEqual([])
    const html = pageText(busPath)
    expect(slotsOf(html).get('waits')).toBe('')
    expect(html).not.toContain('<section class="owner-strip bevel"')
    expect(visibleText(html)).not.toContain('waits for you')
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!
    expect(style).toContain('.waits:empty { display: none; }')
  })

  function withOwnerWaits(busPath: string, waits: { id: string, need: string, text: string, command: string | null, card: number | null, pr: number | null }[]): string {
    const db = new DatabaseSync(busPath)
    try {
      const insert = db.prepare('INSERT INTO owner_waits (id, need, text, command, card_id, pr, state, opened_at, event_id) VALUES (?, ?, ?, ?, ?, ?, \'open\', ?, 0)')
      for (const wait of waits)
        insert.run(wait.id, wait.need, wait.text, wait.command, wait.card, wait.pr, minutesAgo(20))
    }
    finally {
      db.close()
    }
    return busPath
  }

  it('the waits-for-you strip opens a waiting card and draws a wait with no card grey and inert', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bus-board-waits-'))
    roots.push(root)
    const busPath = withOwnerWaits(busWithRecords(path.join(root, 'bus.db'), {
      cards: [{ id: 870, state: 'stopped', lane: 'lane-1', line: 'card: #870 asks', since: minutesAgo(30) }],
      prs: [{ pr: 669, card: null, state: 'open' }],
      events: [{ ts: minutesAgo(20), type: 'card.stopped', card: 870, payload: JSON.stringify({ reason: 'question.owner', detail: 'which path?' }) }],
    }), [
      { id: 'Q1', need: 'decision', text: 'which path?', command: null, card: 870, pr: null },
      { id: 'Q2', need: 'merge', text: 'changes architecture/security-invariants.md', command: null, card: null, pr: 669 },
      { id: 'Q3', need: 'command', text: 'the merge queue merges with no owner decision in force naming it live', command: 'pnpm decisions:add "[owner] allow-live merge"', card: null, pr: null },
    ])
    const html = pageText(busPath)
    expect(html.indexOf('id="slot-goal"')).toBeLessThan(html.indexOf('id="slot-waits"'))
    expect(html.indexOf('id="slot-waits"')).toBeLessThan(html.indexOf('id="slot-services"'))
    expect(slotsOf(html).get('waits')).toBe([
      '<section class="owner-strip bevel" aria-label="Waits for you"><span class="lbl">waits for you</span>',
      '<button type="button" class="ask" data-open="card-870" tabindex="0" aria-haspopup="dialog"><span class="kind">D</span><span class="what">Q1 #870 — which path? · owner runs: pnpm decisions:add --card #870 &quot;[owner] &lt;decision&gt;&quot;</span><span class="open-hint">open ›</span></button>',
      '<span class="ask" data-static><span class="kind">M</span><span class="what">Q2 PR #669 — changes architecture/security-invariants.md · owner runs: gh pr merge 669</span></span>',
      '<span class="ask" data-static><span class="kind">C</span><span class="what">Q3 — the merge queue merges with no owner decision in force naming it live · owner runs: pnpm decisions:add &quot;[owner] allow-live merge&quot;</span></span>',
      '</section>',
    ].join(''))
    expect(templatesOf(html).has('dialog-card-870')).toBe(true)
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!
    expect(/\n\.ask \{([\s\S]*?)\n\}/.exec(style)![1]).toContain('&[data-static] { --_what: var(--dim); }')
  })

  it('a bus pulse older than the threshold shows the pulse stale, not blinking', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bus-board-stale-'))
    roots.push(root)
    const page = (minutes: number): string => pageText(busWithRecords(path.join(root, `bus-${minutes}.db`), { events: [{ ts: minutesAgo(minutes), type: 'netwatch.tick', card: null, payload: '{}' }] }))
    const fresh = page(FRESH_MS / 60_000)
    expect(fresh).toContain(`<b class="live" id="bus-pulse">pulse ${FRESH_MS / 60_000} min</b>`)
    const stale = page(FRESH_MS / 60_000 + 1)
    expect(stale).toContain(`<b class="live" id="bus-pulse" data-stale>pulse ${FRESH_MS / 60_000 + 1} min</b>`)
    const style = /<style>([\s\S]*?)<\/style>/.exec(stale)![1]!
    const live = /\n\.live \{([\s\S]*?)\n\}/.exec(style)![1]!
    expect(live).toMatch(/&\[data-stale\] \{ --_fg: var\(--signal\); --_blink: none; \}/)
    expect(live).toMatch(/&::before \{[^}]*animation: var\(--_blink\)/)
    expect(pageText(busWithRecords(path.join(root, 'silent.db'), {}))).toContain('<span class="live" id="bus-live" data-stale>bus offline</span>')
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
    expect(sectionOf(failed, '<footer class="statusline"', '</footer>')).toContain(line)
    expect(pageText(seededBus())).toContain('<span class="fail" data-none>last failure <b>none</b></span>')
    const style = /<style>([\s\S]*?)<\/style>/.exec(failed)![1]!
    expect(style).toMatch(/\n\.fail \{\n {2}--_fg: var\(--signal\);/)
  })

  it('a node under CONSTRUCT_BUS_SLOTS_ANSWER=5 shows answer used/5 from the heartbeat', () => {
    const slots = slotsOfKind('answer', { [slotsVariable('answer')]: '5' })
    const html = pageText(seededBus([], [{ process: nodeProcess('answer'), type: PROCESS_HEARTBEAT, ts: minutesAgo(1), payload: JSON.stringify({ process: nodeProcess('answer'), queue: 'answer', slots }) }]))
    expect(html).toContain('slots in use: answer 0/5, review 1')
    expect(sectionOf(html, '<h2 id="h-services">', '<div class="svc-grid">')).toContain('slots <b>answer 0/5, review 1</b></span>')
    expect(html).not.toContain('records no capacity')
  })

  it('the page reads liveness from the bus pulse and lists no process', () => {
    const html = pageText(seededBus())
    expect(html).toContain('bus · pulse · — · pulse 1 min ago · slots in use: review 1')
    expect(html).not.toContain('pid ')
    expect(html).not.toContain('<h2>Health</h2>')
  })

  const HANDOFF_TEXT = [
    '## STOP — window, session 9',
    'current card: #861',
    'in-flight:',
    '- #862 review',
    '- #863 merged',
    'owner waits: none',
    '',
    'The window waits for the review of #862.',
    'STATUS: CONTINUE',
  ].join('\n')

  function pageWithHandoff(): { busPath: string, html: string } {
    const busPath = seededBus([{ ts: minutesAgo(3), type: SESSION_HEARTBEAT, card: 861, payload: JSON.stringify({ step: 'launch', session: 's861' }) }])
    writeFileSync(handoffBeside(busPath), HANDOFF_TEXT)
    return { busPath, html: pageText(busPath) }
  }

  it('every clickable element opens its own dialog', () => {
    const { html } = pageWithHandoff()
    const board = boardWindow(html, new MemoryStorage())
    const openers = openersOf(html)
    const rows = [...html.matchAll(/<tr data-card="(\d+)"[^>]*>/g)]
    expect(rows.length).toBeGreaterThan(1)
    for (const row of rows)
      expect(row[0]).toContain(`data-open="card-${row[1]}"`)
    expect(sectionOf(html, '<div class="flow">', '</section>')).toContain('data-open="card-861"')
    expect(html).toMatch(/<div class="svc bevel" data-role="launch" data-open="card-861"/)
    expect(html).toMatch(/<div class="svc bevel" data-role="window" data-open="handoff"/)
    const statusline = sectionOf(html, '<footer class="statusline"', '</footer>')
    expect(statusline).toContain('data-open="handoff"')
    expect(statusline).toContain('data-open="decisions"')
    expect(new Set(openers.map(opener => opener.dialog))).toEqual(new Set([...board.templates.keys()].map(id => id.replace(/^dialog-/, ''))))
    for (const opener of openers) {
      board.click(opener.tag, opener.dialog)
      expect(board.dialog.open, opener.dialog).toBe(true)
      expect(board.content.innerHTML).toBe(board.templates.get(`dialog-${opener.dialog}`))
      expect(board.content.innerHTML).toContain(`<span class="drill-kind">${opener.dialog.replace(/-\d+$/, '')}</span>`)
      board.dialog.close()
    }
    for (const [key, dialog] of [['H', 'handoff'], ['d', 'decisions']] as const) {
      board.key(key)
      expect(board.content.innerHTML).toBe(board.templates.get(`dialog-${dialog}`))
      board.dialog.close()
    }
    board.key('Enter', new FakeElement('TR', 'card-860'))
    expect(board.content.innerHTML).toBe(board.templates.get('dialog-card-860'))
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!
    expect([...style.matchAll(/cursor: pointer/g)]).toHaveLength(1)
    expect(style).toMatch(/\[data-open\], \[data-link\], \[data-agents\], \.drill-close \{\n {2}cursor: pointer;\n {2}color: var\(--wire\);[\s\S]*?&:focus-visible \{ outline: 2px solid var\(--amber\)/)
    expect(style).not.toMatch(/\.svc-target \{[^}]*color/)
  })

  it('a card dialog carries the punch card, the prose, the matrix and the chain from the bus', () => {
    const { busPath, html } = pageWithHandoff()
    const templates = templatesOf(html)
    const second = templates.get('dialog-card-861')!
    expect(second.indexOf('class="punch"')).toBeLessThan(second.indexOf('>prose<'))
    expect(second.indexOf('>prose<')).toBeLessThan(second.indexOf('>chain<'))
    expect(second).toContain('<span class="pf-k">branch</span><span class="pf-v">feat/second</span>')
    expect(second).toContain(`<span class="pf-k">text_sha</span><span class="pf-v">${SECOND_CARD_SHA}</span>`)
    expect(second).toContain('<p>The second card follows <button type="button" class="cid" data-open="card-860" tabindex="0" aria-haspopup="dialog">#860 ›</button> and runs <code>pnpm card</code> once.</p>')
    expect(second).toContain('<h3>Witnesses</h3><ul><li><code>pnpm exec vitest run scripts/tests/bus/board-page.test.ts</code> exits 0</li></ul>')
    expect(second).not.toContain('>matrix<')
    const db = new DatabaseSync(busPath, { readOnly: true })
    const ids = db.prepare('SELECT id, type FROM events WHERE card_id = 861 ORDER BY id').all() as { id: number, type: string }[]
    db.close()
    const admitted = ids.find(row => row.type === 'card.state')!.id
    const reviewed = ids.find(row => row.type === REVIEW_RECORDED)!.id
    expect(second).toContain(`<li><span class="when">event ${admitted}</span><span class="dot"></span><span class="ev">card text admitted</span></li><li><span class="when">event ${reviewed}</span><span class="dot"></span><span class="ev">review recorded · changes</span></li>`)
    expect(second).toContain('<code>pnpm card 861 --chain</code>')
    const reviewedCard = templates.get('dialog-card-862')!
    expect(reviewedCard).toContain('<tr><th scope="row">killed</th><td>3</td></tr><tr><th scope="row">survived</th><td>1</td></tr>')
    expect(reviewedCard).toContain('risk matrix')
    expect(reviewedCard.indexOf('>prose<')).toBeLessThan(reviewedCard.indexOf('>matrix<'))
    expect(reviewedCard.indexOf('>matrix<')).toBeLessThan(reviewedCard.indexOf('>chain<'))
    const first = templates.get('dialog-card-860')!
    expect(first).not.toContain('>matrix<')
    expect(first).not.toContain('risk matrix')
  })

  it('a card with no pull request has no matrix block', () => {
    const { html } = pageWithHandoff()
    const second = templatesOf(html).get('dialog-card-861')!
    expect(second).not.toContain('>matrix<')
    expect(second).not.toContain('class="note">No pull request')
    expect(html).not.toContain('No pull request for this card in the bus yet.')
    expect(html).not.toContain('The bus holds no check matrix')
  })

  describe('the witnesses of a card', () => {
    const HEAD = 'a'.repeat(40)
    const fieldCard = (id: number, ...tail: string[]): string => [
      `card: #${id} fielded [implement/netwatch/S/cheap/owner] · depends — · blocks —`,
      `branch: feat/fielded-${id}`,
      'touches: scripts/cli/board-page.ts',
      'continue: stop',
      'who: shift',
      '',
      'The fielded card.',
      '',
      ...tail,
      '',
    ].join('\n')

    function busOfFields(id: number, text: string, events: SeedEvent[], head: string | null = HEAD): string {
      const root = mkdtempSync(path.join(tmpdir(), 'bus-board-witnesses-'))
      roots.push(root)
      const file = busWithRecords(path.join(root, 'bus.db'), {
        cards: [{ id, state: 'in_review', lane: 'lane-1', line: `#${id} fielded`, since: minutesAgo(5), pr: 40, text }],
        prs: [{ pr: 40, card: id, state: 'open' }],
        events: [{ ts: minutesAgo(1), type: 'netwatch.tick', card: null, payload: '{}' }, ...events],
      })
      const db = new DatabaseSync(file)
      db.exec('ALTER TABLE prs ADD COLUMN head TEXT')
      db.prepare('UPDATE prs SET head = ? WHERE pr = 40').run(head)
      db.close()
      return file
    }

    function witnessRecord(head: string, verdict: string, detail: string): SeedEvent {
      return { ts: minutesAgo(1), type: WITNESS_RECORDED, card: 870, pr: 40, head, payload: JSON.stringify({ verdict, detail }) }
    }

    const FIELDS = [
      { id: 'W1', run: 'pnpm exec vitest run tests/a.test.ts', test: 'the <thing>', head: 'pass', base: 'fail', proves: 'follows #870' },
      { id: 'W2', run: 'test -f a.txt', test: null, head: 'pass', base: 'pass', proves: 'a stays' },
    ] as const
    const FIELD_CARD = fieldCard(870, runsFieldLine(['tests/board/**', 'tests/a.test.ts']), witnessFieldsLine(FIELDS))

    it('the board shows the witness fields of a card as a table', () => {
      const dialog = templatesOf(pageText(busOfFields(870, FIELD_CARD, [witnessRecord(HEAD, 'green', 'every card witness red on the base and green on head')]))).get('dialog-card-870')!
      expect(dialog).toContain('<table class="mx" data-witnesses><thead><tr><th scope="col">id</th><th scope="col">run</th><th scope="col">test</th><th scope="col">head/base</th><th scope="col">proves</th></tr></thead>')
      expect(dialog).toContain('<tr><th scope="row">W1</th><td><code>pnpm exec vitest run tests/a.test.ts</code></td><td>the &lt;thing&gt;</td><td>pass/fail · last green</td><td>follows <button')
      expect(dialog).toContain('<tr><th scope="row">W2</th><td><code>test -f a.txt</code></td><td>—</td><td>pass/pass · last green</td><td>a stays</td></tr>')
      expect(dialog).toContain('<p>runs:</p><div class="runs-group" data-lane="tests/board/**" data-glob><p class="runs-name">tests/board/** · вся папка</p></div><div class="runs-group" data-lane="tests"><p class="runs-name">tests</p><p><span class="tag">a.test.ts</span></p></div>')
      expect(dialog).not.toContain('witnesses: [')
    })

    it('a card with three paths in runs renders three separate elements', () => {
      const text = fieldCard(870, runsFieldLine(['tests/a.test.ts', 'tests/b.test.ts', 'tests/other/**']), witnessFieldsLine(FIELDS))
      const dialog = templatesOf(pageText(busOfFields(870, text, []))).get('dialog-card-870')!
      expect(dialog).toContain('<p>runs:</p><div class="runs-group" data-lane="tests"><p class="runs-name">tests</p><p><span class="tag">a.test.ts</span> <span class="tag">b.test.ts</span></p></div><div class="runs-group" data-lane="tests/other/**" data-glob><p class="runs-name">tests/other/** · вся папка</p></div>')
      const style = /<style>([\s\S]*?)<\/style>/.exec(pageText(seededBus()))![1]!
      expect(style).toContain('&[data-glob] { --_accent-style: dashed; }')
    })

    it('a witness table with an empty runs still shows the none mark', () => {
      const dialog = templatesOf(pageText(busOfFields(870, fieldCard(870, witnessFieldsLine(FIELDS)), []))).get('dialog-card-870')!
      expect(dialog).toContain('<p>runs: —</p>')
    })

    it('the witness table fits the dialog with no inline scrolling', () => {
      const style = /<style>([\s\S]*?)<\/style>/.exec(pageText(seededBus()))![1]!
      const rule = /&\[data-witnesses\] \{\n([\s\S]*?)\n {2}\}/.exec(style)![1]!
      expect(rule).toContain('inline-size: 100%;')
      expect(rule).toContain('table-layout: fixed;')
      expect(rule).toContain('& th, & td { overflow-wrap: anywhere; }')
      expect(rule).toContain('& thead th:nth-child(1) { inline-size: 3.5rem; }')
      expect(rule).toContain('& thead th:nth-child(4) { inline-size: 8rem; }')
      expect(rule).toContain('& td:nth-child(2) { font-family: var(--font-mono); }')
      expect(rule).not.toContain('overflow-x')
      expect(style).toContain('&:has(> [data-witnesses]) { --_inline-overflow: visible; }')
      expect(style).toContain('--_inline-overflow: auto;')
      expect(style).toContain('.drill-body { overflow: auto; padding: var(--space-l); display: grid; gap: var(--space-l); & > * { min-inline-size: 0; } }')
      expect(style).toContain('& > :not(.mx-wrap) { max-inline-size: 78ch; }')
    })

    it('a pull request with no matrix or an empty one has no matrix block, and a full run alone keeps it', () => {
      const dialogOf = (events: SeedEvent[]): string => templatesOf(pageText(busOfFields(870, FIELD_CARD, events))).get('dialog-card-870')!
      const absent = dialogOf([])
      expect(absent).not.toContain('>matrix<')
      expect(absent).not.toContain('The bus holds no check matrix')
      expect(dialogOf([checkMatrix(40, HEAD, { killed: 0, survived: 0, notRun: 0 })])).not.toContain('>matrix<')
      expect(dialogOf([checkMatrix(40, HEAD, { killed: 0, survived: 0, notRun: 1 })])).toContain('>matrix<')
      expect(dialogOf([checkMatrix(40, HEAD, { full: 'interrupted', killed: 0, survived: 0, notRun: 0 })])).toContain('>matrix<')
    })

    it('the last result of a witness is the record on the current head, by witness', () => {
      const criterion = 'W1: `pnpm exec vitest run tests/a.test.ts -t \'the <thing>\'` · head pass · base fail · acceptance'
      const dialogOf = (events: SeedEvent[]): string => templatesOf(pageText(busOfFields(870, FIELD_CARD, events))).get('dialog-card-870')!
      const red = dialogOf([witnessRecord(HEAD, 'red', `P8: positive control "${criterion}" exits 1`)])
      expect(red).toContain('<td>pass/fail · last red</td>')
      expect(red).toContain('<td>pass/pass · last not reached</td>')
      const none = dialogOf([witnessRecord('b'.repeat(40), 'green', 'on an older head')])
      expect(none).toContain('<td>pass/fail · last not run</td>')
      expect(none).toContain('<td>pass/pass · last not run</td>')
    })

    it('a witness that could not check reads apart from red on the board', () => {
      const dialogOf = (events: SeedEvent[]): string => templatesOf(pageText(busOfFields(870, FIELD_CARD, events))).get('dialog-card-870')!
      const unchecked = dialogOf([witnessRecord(HEAD, 'unchecked', 'http://127.0.0.1:1/ did not answer, so "`pnpm exec vitest run tests/a.test.ts`" did not run')])
      expect(unchecked).toContain('<td>pass/fail · last could not check</td>')
      expect(unchecked).toContain('<td>pass/pass · last could not check</td>')
      expect(unchecked).not.toContain('last red')
    })

    it('a backfilled card shows its table and no second runs line', () => {
      const text = fieldCard(870, 'Runs: tests/board/**', 'Witnesses:', '- `pnpm exec vitest run tests/a.test.ts -t \'the thing\'` exits 0; red on main')
      const backfill = witnessFieldsBackfillOf([{ card: 870, text }])
      const event: SeedEvent = { ts: minutesAgo(1), type: WITNESS_FIELDS_BACKFILLED, card: null, payload: JSON.stringify(backfill) }
      const dialog = templatesOf(pageText(busOfFields(870, text, [event]))).get('dialog-card-870')!
      expect(dialog).toContain('<tr><th scope="row">W1</th><td><code>pnpm exec vitest run tests/a.test.ts</code></td><td>the thing</td><td>pass/fail · last not run</td>')
      expect(dialog).toContain('<p>runs:</p><div class="runs-group" data-lane="tests/board/**" data-glob><p class="runs-name">tests/board/** · вся папка</p></div>')
      expect(dialog).not.toContain('Runs: tests/board/**')
      expect(dialog).not.toContain('<ul><li>')
    })

    it('a card with no witness fields shows its witnesses as prose', () => {
      const text = fieldCard(870, 'Witnesses:', '- `pnpm exec vitest run tests/a.test.ts` exits 0')
      const dialog = templatesOf(pageText(busOfFields(870, text, []))).get('dialog-card-870')!
      expect(dialog).toContain('<h3>Witnesses</h3><ul><li><code>pnpm exec vitest run tests/a.test.ts</code> exits 0</li></ul>')
      expect(dialog).not.toContain('data-witnesses')
    })

    it('the services grid column is 16rem in the rendered css', () => {
      const style = /<style>([\s\S]*?)<\/style>/.exec(pageText(seededBus()))![1]!
      expect(style).toContain('.svc-grid { display: grid; gap: var(--space-xs); padding: var(--space-xs); grid-template-columns: repeat(auto-fill, minmax(min(100%, 16rem), 1fr)); }')
    })
  })

  it('the handoff and decisions dialogs carry miko.md and the decisions in force', () => {
    const { html } = pageWithHandoff()
    const templates = templatesOf(html)
    const handoff = templates.get('dialog-handoff')!
    expect(handoff).toContain('<span class="pf-k">current card</span><span class="pf-v"><button type="button" class="cid" data-open="card-861"')
    expect(handoff).toContain('<div class="pf" data-wide><span class="pf-k">in-flight</span>')
    expect(handoff).toContain('<span class="st">CONTINUE</span>')
    expect(handoff).toContain('<p>## STOP — window, session 9</p><p>The window waits for the review of <button type="button" class="cid" data-open="card-862"')
    const decisions = templates.get('dialog-decisions')!
    expect(decisions).toContain('<div><b>D-216</b><span>Prerelease rights stay with the shard until <button type="button" class="cid" data-open="card-863"')
  })

  it('after a refresh the filter and the open dialog are restored', () => {
    const { html } = pageWithHandoff()
    const storage = new MemoryStorage()
    const before = boardWindow(html, storage)
    before.location.hash = '#show-planned'
    before.scroller.scrollTop = 120
    before.scroller.dispatch('scroll')
    before.click('TR', 'card-862')
    expect(JSON.parse(storage.getItem(VIEW_KEY)!)).toEqual({ filter: '#show-planned', scroll: 120, open: 'card-862', agents: {} })
    const after = boardWindow(html, storage)
    expect(after.location.hash).toBe('#show-planned')
    expect(after.scroller.scrollTop).toBe(120)
    expect(after.dialog.open).toBe(true)
    expect(after.content.innerHTML).toBe(after.templates.get('dialog-card-862'))
    const kept = boardWindow(html, storage, '#show-merged')
    expect(kept.location.hash).toBe('#show-merged')
    expect(JSON.parse(storage.getItem(VIEW_KEY)!).filter).toBe('#show-merged')
  })

  function projected(busPath: string, now: Date, tickMs: number = TICK_MS): { html: string, data: string } {
    const db = new DatabaseSync(busPath, { readOnly: true })
    try {
      const projection = boardProjection(db, busPath, tickMs, DISK_FILES, handoffBeside(busPath))
      projection.project(now)
      return { html: readFileSync(projection.file, 'utf8'), data: readFileSync(projection.dataFile, 'utf8') }
    }
    finally {
      db.close()
    }
  }

  function projectedWithHandoff(now: Date = NOW, tickMs: number = TICK_MS, heartbeats: SeedEvent[] = []): { html: string, data: string } {
    const busPath = seededBus(heartbeats)
    writeFileSync(handoffBeside(busPath), HANDOFF_TEXT)
    return projected(busPath, now, tickMs)
  }

  function boardOf(data: string): BoardData {
    const window: { BOARD?: BoardData } = {}
    vm.runInNewContext(data, { window })
    return window.BOARD!
  }

  function busGoneDown(waits: Parameters<typeof withOwnerWaits>[1], handoff: string): string {
    const busPath = withOwnerWaits(seededBus(), waits)
    writeFileSync(handoffBeside(busPath), handoff)
    projected(busPath, NOW)
    writeFileSync(busPath, 'database disk image is malformed: not a database')
    return busPath
  }

  function downPage(busPath: string, at: Date, format: 'html' | 'json' = 'html'): string {
    let text = ''
    expect(printBoard(busPath, at, (chunk) => {
      text += chunk
    }, handoffBeside(busPath), format)).toBe(1)
    return text
  }

  const DOWN_WAITS = [{ id: 'Q9', need: 'decision', text: 'restore the bus from the backup?', command: null, card: null, pr: null }]

  it('with the bus unreachable the board shows the bus status and the open owner waits', () => {
    const busPath = busGoneDown(DOWN_WAITS, 'STATUS: OWNER — boundary: bus corruption\n')
    const pulse = minutesAgo(1)
    const stale = downPage(busPath, new Date(NOW.getTime() + 2 * TICK_MS + 60_000))
    const text = visibleText(stale)
    expect(text).toMatch(new RegExp(`the bus stopped at ${pulse}: \\S`))
    expect(text).toContain('Q9 — restore the bus from the backup?')
    expect(text).toContain('handoff STATUS: OWNER — boundary: bus corruption')
    expect(stale).toMatch(/<span class="live" data-snapshot data-stale>snapshot written 2026-10-20T08:00:00.000Z · age 3 min<\/span>/)
    const fresh = downPage(busPath, new Date(NOW.getTime() + 2 * TICK_MS))
    expect(fresh).toContain('<span class="live" data-snapshot>snapshot written')
    const json = JSON.parse(downPage(busPath, NOW, 'json')) as { status: string, stoppedAt: string, waits: { id: string }[], snapshot: { stale: boolean } }
    expect(json).toMatchObject({ status: 'stopped', stoppedAt: pulse, snapshot: { stale: false } })
    expect(json.waits.map(wait => wait.id)).toEqual(['Q9'])
  })

  it('with the bus unreachable and no snapshot the board still names the error and marks the age red', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bus-board-down-'))
    roots.push(root)
    const busPath = path.join(root, 'bus.db')
    writeFileSync(busPath, 'not a database')
    const page = downPage(busPath, NOW)
    expect(visibleText(page)).toMatch(/the bus stopped at an unknown time: \S/)
    expect(page).toContain('<span class="live" data-snapshot data-stale>no board snapshot to read</span>')
    expect(visibleText(page)).toContain('No open owner wait in the last snapshot or the handoff.')
  })

  it('board --json parses as JSON and holds the stage of a card', () => {
    let text = ''
    expect(printBoard(seededBus(), NOW, (chunk) => {
      text += chunk
    }, undefined, 'json')).toBe(0)
    const board = JSON.parse(text) as { status: string, cards: { id: number, stage: string, pr: number | null, events: { type: string }[] }[], tasks: { queue: string, card: number, state: string }[] }
    expect(board.status).toBe('live')
    expect(board.cards.find(card => card.id === 861)).toMatchObject({ stage: 'in work' })
    expect(board.cards.find(card => card.id === 862)).toMatchObject({ stage: 'review', pr: 12 })
    expect(board.cards.find(card => card.id === 861)!.events.map(event => event.type)).toContain(REVIEW_RECORDED)
    expect(board.tasks).toEqual([expect.objectContaining({ queue: 'review', card: 862, state: 'leased' })])
  })

  const LATER = new Date(NOW.getTime() + 60_000)
  const STOPPED = [{ ts: minutesAgo(4), type: 'card.stopped', card: 861, payload: JSON.stringify({ reason: 'fault', detail: 'no pull request' }) }]

  it('a data tick keeps the shell DOM and replaces only the panel nodes', () => {
    const { html } = projectedWithHandoff()
    const storage = new MemoryStorage()
    const board = boardWindow(html, storage)
    board.location.hash = '#show-planned'
    board.scroller.scrollTop = 120
    board.scroller.dispatch('scroll')
    board.click('TR', 'card-862')
    const opened = board.content.innerHTML
    const view = storage.getItem(VIEW_KEY)
    const shell = new Map([...board.elements].filter(([id]) => !id.startsWith('slot-')))
    const { data } = projectedWithHandoff(LATER, TICK_MS, STOPPED)
    const fresh = boardOf(data)
    expect(fresh.written).toBe(LATER.toISOString())
    expect(Object.keys(fresh.slots)).toEqual(Object.keys(SLOT_ENDS))
    expect(slotsOf(html).get('status')).not.toContain('card #861 stopped on a fault')
    expect(fresh.slots.status).toContain('card #861 stopped on a fault')
    const script = board.tick(data)
    expect(script.src).toMatch(new RegExp(`^${BOARD_DATA_FILE.replace('.', '\\.')}\\?t=\\d+$`))
    expect(script.removed).toBe(true)
    for (const [name, inner] of Object.entries(fresh.slots))
      expect(board.elements.get(`slot-${name}`)!.innerHTML, name).toBe(inner)
    for (const [id, element] of shell)
      expect(board.elements.get(id), id).toBe(element)
    expect(board.document.title).toBe(`construct board · ${fresh.written}`)
    expect(board.dialog.open).toBe(true)
    expect(board.content.innerHTML).toBe(opened)
    expect(board.scroller.scrollTop).toBe(120)
    expect(board.location.hash).toBe('#show-planned')
    expect(storage.getItem(VIEW_KEY)).toBe(view)
    expect(board.currentTemplates().get('dialog-card-861')).toBe(templatesOf(fresh.slots.dialogs).get('dialog-card-861'))
    expect(board.elements.get('backlog')?.prepended.map(target => target.id) ?? []).toEqual(fresh.filters.filter(id => !idsOf(html).includes(id)))
    expect(html).not.toContain('http-equiv="refresh"')
  })

  it('two polls in a row with the same written leave the DOM untouched', () => {
    const { html, data } = projectedWithHandoff()
    const board = boardWindow(html, new MemoryStorage())
    board.click('TR', 'card-862')
    const opened = board.content.innerHTML
    const slots = [...board.elements].filter(([id]) => id.startsWith('slot-'))
    const writes = (): number[] => slots.map(([, slot]) => slot.writes)
    const before = writes()
    const templates = board.currentTemplates()
    const title = board.document.title
    const same = boardOf(data)
    expect(same.written).toBe(/data-written="([^"]+)"/.exec(html)![1])
    board.tick(data)
    const reshaped = `window.BOARD = ${JSON.stringify({ ...same, slots: Object.fromEntries(Object.keys(same.slots).map(name => [name, '<p>other</p>'])) })}\n`
    board.tick(reshaped)
    expect(writes()).toEqual(before)
    expect(board.currentTemplates()).toEqual(templates)
    expect(board.document.title).toBe(title)
    expect(board.content.innerHTML).toBe(opened)
    expect(board.dialog.open).toBe(true)
    expect(board.elements.get('bus-live')?.attributes.has('data-stale') ?? false).toBe(false)
    const { data: later } = projectedWithHandoff(LATER)
    board.tick(later)
    expect(writes().every((count, at) => count === before[at]! + 1)).toBe(true)
    board.tick(later)
    expect(writes().every((count, at) => count === before[at]! + 1)).toBe(true)
    expect(board.content.innerHTML).toBe(opened)
  })

  it('the poll period is BOARD.tickMs', () => {
    const { html, data } = projectedWithHandoff(NOW, 45_000)
    expect(boardOf(data).tickMs).toBe(45_000)
    expect(html).toContain('data-tick-ms="45000"')
    expect(html).toContain('<span>refresh <b>45s</b></span>')
    const board = boardWindow(html, new MemoryStorage())
    expect(board.timeouts.map(timeout => timeout.ms)).toEqual([45_000])
    const { data: faster } = projectedWithHandoff(LATER, 7_000)
    board.tick(faster)
    expect(board.timeouts.map(timeout => timeout.ms)).toEqual([7_000])
    board.tick(null)
    expect(board.timeouts.map(timeout => timeout.ms)).toEqual([7_000])
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!
    expect(script).not.toMatch(/setInterval|setTimeout\(update, \d/)
    expect(script).toContain('setTimeout(update, period)')
    const snapshot = boardWindow(pageText(seededBus()), new MemoryStorage())
    expect(snapshot.timeouts).toEqual([])
    const { html: projectedShell } = projectedWithHandoff(NOW, TICK_MS)
    expect(projectedShell).toContain(`<span>refresh <b>${TICK_MS / 1000}s</b></span>`)
  })

  it('a broken board-data.js keeps the previous data and shows bus offline, the word a silent factory renders', () => {
    const { html } = projectedWithHandoff(NOW, TICK_MS, [{ ts: minutesAgo(2), type: WINDOW_HEARTBEAT, card: null, payload: '{}' }])
    expect(html).toContain('<span class="live" id="bus-live">bus live</span>')
    const { html: silent } = projectedWithHandoff(NOW, TICK_MS)
    expect(silent).toContain('<span class="live" id="bus-live" data-stale>bus offline</span>')
    for (const data of ['window.BOARD = {"written": ', 'window.BOARD = 42', 'window.BOARD = {"written": "x", "tickMs": 60000, "slots": null, "filters": []}', null]) {
      const board = boardWindow(html, new MemoryStorage())
      const script = board.tick(data)
      expect(script.removed, String(data)).toBe(true)
      for (const [name, inner] of slotsOf(html))
        expect(board.elements.get(`slot-${name}`)!.innerHTML, `${data} ${name}`).toBe(inner)
      const live = board.elements.get('bus-live')!
      expect(live.attributes.get('data-stale'), String(data)).toBe('')
      expect(live.textContent).toBe('bus offline')
      expect(board.elements.get('bus-pulse')!.attributes.get('data-stale')).toBe('')
      expect(board.timeouts).toHaveLength(1)
    }
  })

  it('pressing Esc closes the dialog', () => {
    const { html } = pageWithHandoff()
    const storage = new MemoryStorage()
    const board = boardWindow(html, storage)
    board.click('BUTTON', 'decisions')
    expect(board.dialog.open).toBe(true)
    board.key('Escape')
    expect(board.dialog.open).toBe(false)
    expect(JSON.parse(storage.getItem(VIEW_KEY)!).open).toBeNull()
    expect(boardWindow(html, storage).dialog.open).toBe(false)
  })

  it('the page renders when localStorage throws', () => {
    const { html } = pageWithHandoff()
    expect(html).toContain('</html>')
    const board = boardWindow(html, THROWING_STORAGE)
    board.click('TR', 'card-861')
    expect(board.dialog.open).toBe(true)
    expect(board.content.innerHTML).toBe(board.templates.get('dialog-card-861'))
    board.key('Escape')
    expect(board.dialog.open).toBe(false)
  })
})
