import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { BOARD_DATA_FILE, BOARD_STAMP_FILE, SECTION_FILE_PREFIX } from '../../cli/board-page.js'

const SCRIPT = readFileSync(path.resolve(import.meta.dirname, '../../cli/board-page/script.js'), 'utf8')
const TICK_MS = 10_000
const FIRST = '2026-11-28T12:00:00.000Z'
const SECOND = '2026-11-28T12:00:10.000Z'
const THIRD = '2026-11-28T12:00:20.000Z'
const NAMES = { drill: 'drill', drillContent: 'drill-content', backlogScroll: 'backlog-scroll', viewKey: 'board:view', dialogPrefix: 'dialog-', handoffDialog: 'handoff', decisionsDialog: 'decisions', busLive: 'bus-live', offlineReading: 'offline', pulse: 'pulse', titlePrefix: 'board · ', slotPrefix: 'slot-', backlog: 'backlog', staleTicks: 2, staleReading: 'stale', dataFile: BOARD_DATA_FILE, stampFile: BOARD_STAMP_FILE, sectionPrefix: SECTION_FILE_PREFIX, refreshIn: 'refresh-in', round: {}, filterAttribute: 'data-filter' }

class StubElement {
  id = ''
  innerHTML = ''
  src = ''
  parentNode: StubElement | null = null
  readonly children: StubElement[] = []
  readonly dataset: Record<string, string> = {}
  onload: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(readonly tagName: string) {}

  addEventListener(): void {}
  setAttribute(): void {}
  removeAttribute(): void {}
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
  for (const id of ['drill', 'drill-content', 'slot-kv', 'slot-rows', 'slot-dialogs']) {
    const node = root.appendChild(new StubElement('DIV'))
    node.id = id
  }
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
  const context: Record<string, unknown> = { BOARD_NAMES: NAMES, document, localStorage: { getItem: () => null, setItem: () => {} }, location: { hash: '' }, addEventListener: () => {}, setTimeout: (run: () => void) => timeouts.push(run), Date: { now: () => Date.parse(written || FIRST), parse: Date.parse } }
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
  return { appended, timeouts, slot, deliver, section, document }
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
})
