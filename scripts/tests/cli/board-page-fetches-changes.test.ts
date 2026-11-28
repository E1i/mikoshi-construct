import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { BOARD_DATA_FILE } from '../../cli/board-page.js'
import { BOARD_STAMP_FILE, SECTION_FILE_PREFIX } from '../../cli/board-page/sections.js'

const SCRIPT = readFileSync(path.resolve(import.meta.dirname, '../../cli/board-page/script.js'), 'utf8')
const TICK_MS = 10_000
const FIRST = '2026-11-28T12:00:00.000Z'
const SECOND = '2026-11-28T12:00:10.000Z'
const THIRD = '2026-11-28T12:00:20.000Z'
const QUIET_BUILD_AGE_MS = 50_000
const LIVE_READING = 'bus live'
const NAMES = { drill: 'drill', drillContent: 'drill-content', backlogScroll: 'backlog-scroll', viewKey: 'board:view', dialogPrefix: 'dialog-', handoffDialog: 'handoff', decisionsDialog: 'decisions', busLive: 'bus-live', offlineReading: 'offline', pulse: 'pulse', titlePrefix: 'board · ', slotPrefix: 'slot-', backlog: 'backlog', staleTicks: 2, staleReading: 'stale', dataFile: BOARD_DATA_FILE, stampFile: BOARD_STAMP_FILE, sectionPrefix: SECTION_FILE_PREFIX, refreshIn: 'refresh-in', round: {}, filterAttribute: 'data-filter' }

class StubElement {
  id = ''
  innerHTML = ''
  textContent = ''
  src = ''
  readonly attributes = new Map<string, string>()
  parentNode: StubElement | null = null
  readonly children: StubElement[] = []
  readonly dataset: Record<string, string> = {}
  onload: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(readonly tagName: string) {}

  addEventListener(): void {}
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name)
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name)
  }

  appendChild(child: StubElement): StubElement {
    child.parentNode = this
    this.children.push(child)
    return child
  }

  replaceChild(next: StubElement, was: StubElement): void {
    this.children[this.children.indexOf(was)] = next
    next.parentNode = this
  }

  remove(): void {
    this.parentNode?.children.splice(this.parentNode.children.indexOf(this), 1)
  }

  all(): StubElement[] {
    return this.children.flatMap(child => [child, ...child.all()])
  }
}

function page(written: string) {
  const root = new StubElement('BODY')
  for (const id of ['drill', 'drill-content', 'slot-kv', 'slot-rows', 'slot-dialogs', 'bus-live']) {
    const node = root.appendChild(new StubElement('DIV'))
    node.id = id
  }
  markLive(root)
  let now = Date.parse(written || FIRST)
  const appended: StubElement[] = []
  const timeouts: (() => void)[] = []
  const document = {
    title: '',
    body: { dataset: { written, tickMs: String(TICK_MS) } },
    head: { appendChild: (child: StubElement) => appended.push(child) },
    getElementById: (id: string) => root.all().find(node => node.id === id) ?? null,
    createElement: (tag: string) => new StubElement(tag.toUpperCase()),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
  }
  const context: Record<string, unknown> = { BOARD_NAMES: NAMES, document, localStorage: { getItem: () => null, setItem: () => {} }, location: { hash: '' }, addEventListener: () => {}, setTimeout: (run: () => void) => timeouts.push(run), Date: { now: () => now, parse: Date.parse } }
  context.window = context
  vm.createContext(context)
  vm.runInContext(SCRIPT, context)
  const slot = (name: string): string => document.getElementById(`slot-${name}`)!.innerHTML
  const deliver = (global: string, value: unknown): void => {
    context[global] = value
    appended.at(-1)!.onload!()
  }
  const section = (script: StubElement, name: string, hash: string, html: string): void => {
    (context.BOARD_SECTION as (name: string, hash: string, html: string) => void)(name, hash, html)
    script.onload!()
  }
  const at = (iso: string): void => {
    now = Date.parse(iso)
  }
  const carrying = (id: string): StubElement[] => root.all().filter(node => node.id === id)
  return { appended, timeouts, slot, deliver, section, document, at, carrying, live: document.getElementById('bus-live')! }
}

function markLive(root: StubElement): void {
  root.all().find(node => node.id === 'bus-live')!.textContent = LIVE_READING
}

const WHOLE = { written: FIRST, tickMs: TICK_MS, slots: { kv: 'kv one', rows: 'rows one', dialogs: `<template id="dialog-card-7">${'card seven '.repeat(10_000)}</template>` }, filters: [], alarms: [], hashes: { 'kv': 'k1', 'rows': 'r1', 'dialog-card-7': 'c1' } }

describe('the board page fetches only what changed', () => {
  it('a refresh with one changed section fetches less than the whole board data', () => {
    const board = page('')
    expect(board.appended.map(script => script.src)).toEqual([expect.stringMatching(new RegExp(`^${BOARD_DATA_FILE.replace('.', '\\.')}\\?t=`))])
    board.deliver('BOARD', WHOLE)
    expect(board.slot('rows')).toBe('rows one')

    board.timeouts.at(-1)!()
    expect(board.appended[1]!.src).toMatch(new RegExp(`^${BOARD_STAMP_FILE.replace('.', '\\.')}\\?t=`))
    const stamp = { written: SECOND, tickMs: TICK_MS, filters: [], alarms: [], hashes: { ...WHOLE.hashes, rows: 'r2' } }
    board.deliver('BOARD_STAMP', stamp)
    expect(board.appended.slice(2).map(script => script.src)).toEqual([`${SECTION_FILE_PREFIX}rows.js?h=r2`])
    board.section(board.appended[2]!, 'rows', 'r2', 'rows two')
    expect(board.slot('rows')).toBe('rows two')
    expect(board.slot('kv')).toBe('kv one')
    expect(board.document.title).toBe(`board · ${SECOND}`)

    const fetched = Buffer.byteLength(JSON.stringify(stamp)) + Buffer.byteLength(JSON.stringify(['rows', 'r2', 'rows two']))
    expect(fetched).toBeLessThan(Buffer.byteLength(JSON.stringify(WHOLE)))
    expect(board.appended.filter(script => script.src.startsWith(BOARD_DATA_FILE))).toHaveLength(1)
  })

  it('an unchanged stamp fetches no section, and a changed dialog replaces its template alone', () => {
    const board = page('')
    board.deliver('BOARD', WHOLE)
    board.timeouts.at(-1)!()
    board.deliver('BOARD_STAMP', { written: SECOND, tickMs: TICK_MS, filters: [], alarms: [], hashes: WHOLE.hashes })
    expect(board.appended).toHaveLength(2)

    board.timeouts.at(-1)!()
    board.deliver('BOARD_STAMP', { written: THIRD, tickMs: TICK_MS, filters: [], alarms: [], hashes: { ...WHOLE.hashes, 'dialog-card-7': 'c2' } })
    expect(board.appended.at(-1)!.src).toBe(`${SECTION_FILE_PREFIX}dialog-card-7.js?h=c2`)
    board.section(board.appended.at(-1)!, 'dialog-card-7', 'c2', 'card seven, moved')
    expect(board.document.getElementById('dialog-card-7')!.innerHTML).toBe('card seven, moved')
    expect(board.slot('rows')).toBe('rows one')
  })

  it('a missing stamp falls back to the whole board data on the next refresh', () => {
    const board = page('')
    board.deliver('BOARD', WHOLE)
    board.timeouts.at(-1)!()
    board.appended.at(-1)!.onerror!()
    board.timeouts.at(-1)!()
    expect(board.appended.at(-1)!.src.startsWith(`${BOARD_DATA_FILE}?t=`)).toBe(true)
  })

  it('a full load built on a quiet bus reads STALE only until a fresh stamp confirms the board current', () => {
    const board = page('')
    board.at(new Date(Date.parse(FIRST) + QUIET_BUILD_AGE_MS).toISOString())
    board.deliver('BOARD', WHOLE)
    expect(board.live.textContent).toBe(NAMES.staleReading)
    expect(board.live.hasAttribute('data-stale')).toBe(true)
    board.timeouts.at(-1)!()
    board.deliver('BOARD_STAMP', { written: new Date(Date.parse(FIRST) + QUIET_BUILD_AGE_MS).toISOString(), tickMs: TICK_MS, filters: [], alarms: [], hashes: WHOLE.hashes })
    expect(board.appended).toHaveLength(2)
    expect(board.live.textContent).toBe(LIVE_READING)
    expect(board.live.hasAttribute('data-stale')).toBe(false)
  })

  it('a section that only left the stamp removes its dialog template from the page', () => {
    const board = page('')
    board.deliver('BOARD', WHOLE)
    board.timeouts.at(-1)!()
    board.deliver('BOARD_STAMP', { written: SECOND, tickMs: TICK_MS, filters: [], alarms: [], hashes: { ...WHOLE.hashes, 'dialog-card-7': 'c2' } })
    board.section(board.appended.at(-1)!, 'dialog-card-7', 'c2', 'card seven')
    expect(board.document.getElementById('dialog-card-7')).not.toBeNull()
    board.timeouts.at(-1)!()
    board.deliver('BOARD_STAMP', { written: THIRD, tickMs: TICK_MS, filters: [], alarms: [], hashes: { kv: 'k1', rows: 'r1' } })
    expect(board.document.getElementById('dialog-card-7')).toBeNull()
    expect(board.slot('rows')).toBe('rows one')
    const fetched = board.appended.length
    board.timeouts.at(-1)!()
    board.deliver('BOARD_STAMP', { written: THIRD, tickMs: TICK_MS, filters: [], alarms: [], hashes: { kv: 'k1', rows: 'r1' } })
    expect(board.appended).toHaveLength(fetched + 1)
  })

  it('a section that leaves the stamp and comes back with the same hash is fetched again', () => {
    const board = page('')
    board.deliver('BOARD', WHOLE)
    board.timeouts.at(-1)!()
    board.deliver('BOARD_STAMP', { written: SECOND, tickMs: TICK_MS, filters: [], alarms: [], hashes: { kv: 'k1', rows: 'r1' } })
    expect(board.appended).toHaveLength(2)
    board.timeouts.at(-1)!()
    board.deliver('BOARD_STAMP', { written: THIRD, tickMs: TICK_MS, filters: [], alarms: [], hashes: WHOLE.hashes })
    expect(board.appended.at(-1)!.src).toBe(`${SECTION_FILE_PREFIX}dialog-card-7.js?h=c1`)
    board.section(board.appended.at(-1)!, 'dialog-card-7', 'c1', 'card seven, back')
    expect(board.document.getElementById('dialog-card-7')!.innerHTML).toBe('card seven, back')
  })

  it('a dialog changed twice replaces its template, so one element alone carries its id', () => {
    const board = page('')
    board.deliver('BOARD', WHOLE)
    for (const [written, hash] of [[SECOND, 'c2'], [THIRD, 'c3']] as const) {
      board.timeouts.at(-1)!()
      board.deliver('BOARD_STAMP', { written, tickMs: TICK_MS, filters: [], alarms: [], hashes: { ...WHOLE.hashes, 'dialog-card-7': hash } })
      board.section(board.appended.at(-1)!, 'dialog-card-7', hash, `card seven ${hash}`)
    }
    expect(board.carrying('dialog-card-7').map(node => node.innerHTML)).toEqual(['card seven c3'])
  })
})
