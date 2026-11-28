import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { BOARD_DATA_FILE, BOARD_STAMP_FILE, SECTION_FILE_PREFIX } from '../../cli/board-page.js'

const SCRIPT = readFileSync(path.resolve(import.meta.dirname, '../../cli/board-page/script.js'), 'utf8')
const TICK_MS = 10_000
const WRITTEN = '2026-11-28T12:00:00.000Z'
const PERIODS = 5
const NAMES = { drill: 'drill', drillContent: 'drill-content', backlogScroll: 'backlog-scroll', viewKey: 'board:view', dialogPrefix: 'dialog-', handoffDialog: 'handoff', decisionsDialog: 'decisions', busLive: 'bus-live', offlineReading: 'offline', pulse: 'pulse', titlePrefix: 'board · ', slotPrefix: 'slot-', backlog: 'backlog', staleTicks: 2, staleReading: 'stale', dataFile: BOARD_DATA_FILE, stampFile: BOARD_STAMP_FILE, sectionPrefix: SECTION_FILE_PREFIX, refreshIn: 'refresh-in', round: {}, filterAttribute: 'data-filter' }

class StubElement {
  id = ''
  innerHTML = ''
  src = ''
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  readonly dataset: Record<string, string> = {}
  addEventListener(): void {}
  setAttribute(): void {}
  removeAttribute(): void {}
  remove(): void {}
}

function hiddenPage(written: string) {
  const slots = new Map(['drill', 'drill-content', 'slot-kv'].map((id) => {
    const node = new StubElement()
    node.id = id
    return [id, node]
  }))
  let now = Date.parse(WRITTEN)
  const appended: StubElement[] = []
  const timeouts: { run: () => void, at: number }[] = []
  const listeners = new Map<string, (() => void)[]>()
  const document = {
    title: '',
    visibilityState: 'hidden',
    body: { dataset: { written, tickMs: String(TICK_MS) } },
    head: { appendChild: (child: StubElement) => appended.push(child) },
    getElementById: (id: string) => slots.get(id) ?? null,
    createElement: () => new StubElement(),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: (type: string, listener: () => void) => listeners.set(type, [...listeners.get(type) ?? [], listener]),
  }
  const context: Record<string, unknown> = { BOARD_NAMES: NAMES, document, localStorage: { getItem: () => null, setItem: () => {} }, location: { hash: '' }, addEventListener: () => {}, setTimeout: (run: () => void, ms: number) => timeouts.push({ run, at: now + ms }), Date: { now: () => now, parse: Date.parse } }
  context.window = context
  vm.createContext(context)
  vm.runInContext(SCRIPT, context)
  const elapse = (ms: number): void => {
    now += ms
    for (const due of timeouts.splice(0).filter(timeout => timeout.at <= now))
      due.run()
  }
  const show = (): void => {
    document.visibilityState = 'visible'
    listeners.get('visibilitychange')?.forEach(listener => listener())
  }
  const deliver = (board: unknown): void => {
    context.BOARD = board
    appended.at(-1)!.onload!()
  }
  return { appended, timeouts, elapse, show, deliver, slot: () => slots.get('slot-kv')!.innerHTML }
}

describe('a hidden board tab is idle', () => {
  it('a hidden page issues no fetch and resumes on focus', () => {
    const board = hiddenPage(WRITTEN)
    for (let period = 0; period < PERIODS; period += 1)
      board.elapse(TICK_MS)
    expect(board.appended).toHaveLength(0)
    expect(board.timeouts).toHaveLength(0)
    expect(board.slot()).toBe('')

    board.show()
    expect(board.appended.map(script => script.src)).toEqual([expect.stringMatching(new RegExp(`^${BOARD_DATA_FILE.replace('.', '\\.')}\\?t=`))])
    board.deliver({ written: new Date(Date.parse(WRITTEN) + PERIODS * TICK_MS).toISOString(), tickMs: TICK_MS, slots: { kv: 'kv after focus' }, filters: [], alarms: [] })
    expect(board.slot()).toBe('kv after focus')
    expect(board.timeouts).toHaveLength(1)
    board.show()
    expect(board.appended).toHaveLength(1)
  })

  it('a shell page opened in a hidden tab fetches nothing until it is shown', () => {
    const board = hiddenPage('')
    expect(board.appended).toHaveLength(0)
    board.show()
    expect(board.appended).toHaveLength(1)
  })
})
