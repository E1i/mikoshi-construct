import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { FILTER_ATTRIBUTE, filterId, filterRule, LIVE_FILTER } from '../../cli/board-page/live-cards.js'

const SCRIPT = readFileSync(path.resolve(import.meta.dirname, '../../cli/board-page/script.js'), 'utf8')
const STYLE = readFileSync(path.resolve(import.meta.dirname, '../../cli/board-page/style.css'), 'utf8')
const WRITTEN = '2026-11-16T10:00:00.000Z'
const TICK_MS = 10_000
const WRITE_SLACK_MS = 1_500
const NAMES = {
  drill: 'drill',
  drillContent: 'drill-content',
  backlogScroll: 'backlog-scroll',
  viewKey: 'board:view',
  dialogPrefix: 'dialog-',
  handoffDialog: 'handoff',
  decisionsDialog: 'decisions',
  busLive: 'bus-live',
  offlineReading: 'offline',
  pulse: 'pulse',
  titlePrefix: 'board · ',
  slotPrefix: 'slot-',
  backlog: 'backlog',
  staleTicks: 3,
  staleReading: 'stale',
  dataFile: 'board-data.js',
  refreshIn: 'refresh-in',
  round: { over: '#ff0000', warn: '#ffff00', calm: '#00ff00', warnShare: 0.75, overTime: 'over', remaining: 'left' },
  filterAttribute: FILTER_ATTRIBUTE,
  icon: { id: 'board-icon', calm: 'data:image/svg+xml,calm', alarm: 'data:image/svg+xml,alarm' },
}

type Listener = (event: { target: StubNode, key?: string }) => void

function datasetKey(selector: string): string | null {
  const match = /^\[data-([\w-]+)\]$/.exec(selector)
  return match === null ? null : match[1]!.replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase())
}

class StubNode {
  readonly dataset: Record<string, string> = {}
  readonly attributes = new Map<string, string>()
  readonly listeners = new Map<string, Listener[]>()
  readonly children: StubNode[] = []
  parent: StubNode | null = null
  textContent = ''
  innerHTML = ''
  className = ''
  id = ''
  src = ''
  open = false
  removed = false
  onload: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(readonly tagName: string, dataset: Record<string, string> = {}) {
    Object.assign(this.dataset, dataset)
  }

  add(child: StubNode): StubNode {
    child.parent = this
    this.children.push(child)
    return child
  }

  prepend(child: StubNode): StubNode {
    child.parent = this
    this.children.unshift(child)
    return child
  }

  matches(selector: string): boolean {
    const key = datasetKey(selector)
    return key !== null && key in this.dataset
  }

  closest(selector: string): StubNode | null {
    if (this.matches(selector))
      return this
    return this.parent === null ? null : this.parent.closest(selector)
  }

  descendants(): StubNode[] {
    return this.children.flatMap(child => [child, ...child.descendants()])
  }

  querySelector(selector: string): StubNode | null {
    return this.descendants().find(node => node.matches(selector)) ?? null
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name)
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...this.listeners.get(type) ?? [], listener])
  }

  dispatch(type: string, target: StubNode = this): void {
    for (const listener of this.listeners.get(type) ?? [])
      listener({ target })
  }

  remove(): void {
    this.removed = true
  }

  showModal(): void {
    this.open = true
  }

  close(): void {
    this.open = false
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

interface BoardPageStub {
  root: StubNode
  byId: Map<string, StubNode>
  storage: MemoryStorage
  loadedAt: number
}

function boardPage(storage = new MemoryStorage(), loadedAt = Date.parse(WRITTEN)): BoardPageStub {
  const root = new StubNode('BODY')
  const byId = new Map<string, StubNode>()
  for (const id of [NAMES.drill, NAMES.drillContent, NAMES.refreshIn, NAMES.busLive, NAMES.pulse, NAMES.backlog]) {
    const node = root.add(new StubNode(id === NAMES.drill ? 'DIALOG' : 'DIV'))
    node.id = id
    byId.set(id, node)
  }
  return { root, byId, storage, loadedAt }
}

function withFoldGroup(page: BoardPageStub, task: string): StubNode {
  const group = page.root.add(new StubNode('SECTION', { task }))
  group.add(new StubNode('BUTTON', { fold: task }))
  return group
}

function withCounter(page: BoardPageStub, count: string): StubNode {
  const counter = page.root.add(new StubNode('SPAN', { count }))
  counter.textContent = count
  return counter
}

function run(page: BoardPageStub, written = WRITTEN, hash = '') {
  let now = page.loadedAt
  let frames: (() => void)[] = []
  const timeouts: { run: () => void, ms: number }[] = []
  const appended: StubNode[] = []
  const location = { hash }
  const windowListeners = new Map<string, (() => void)[]>()
  const document = Object.assign(new StubNode('DOCUMENT'), {
    title: '',
    body: { dataset: { written, tickMs: String(TICK_MS) } },
    head: { appendChild: (child: StubNode) => appended.push(child) },
    getElementById: (id: string) => page.byId.get(id) ?? page.root.descendants().find(node => node.id === id) ?? null,
    createElement: (tag: string) => new StubNode(tag.toUpperCase()),
    querySelector: (selector: string) => page.root.querySelector(selector),
    querySelectorAll: (selector: string) => page.root.descendants().filter(node => node.matches(selector)),
  })
  const context: Record<string, unknown> = {
    BOARD_NAMES: NAMES,
    document,
    localStorage: page.storage,
    location,
    addEventListener: (type: string, listener: () => void) => windowListeners.set(type, [...windowListeners.get(type) ?? [], listener]),
    setTimeout: (callback: () => void, ms: number) => timeouts.push({ run: callback, ms }),
    requestAnimationFrame: (callback: () => void) => frames.push(callback),
    Date: { now: () => now, parse: Date.parse },
  }
  context.window = context
  vm.createContext(context)
  vm.runInContext(SCRIPT, context)
  return {
    timeouts,
    appended,
    context,
    location,
    fire: (type: string): void => windowListeners.get(type)?.forEach(listener => listener()),
    receive: (board: Record<string, unknown>): void => {
      const latest = appended.at(-1)!
      context.BOARD = { written: new Date(Date.parse(WRITTEN) + appended.length * 1_000).toISOString(), tickMs: TICK_MS, slots: {}, filters: [], ...board }
      latest.onload!()
    },
    refresh: (): void => timeouts.at(-1)!.run(),
    advance: (ms: number): void => {
      now += ms
    },
    paint: (): void => {
      const due = frames
      frames = []
      for (const frame of due)
        frame()
    },
    click: (target: StubNode): void => document.dispatch('click', target),
  }
}

const TAB_IDS = ['all', LIVE_FILTER, 'review'].map(filterId)
const TARGET_AFTER_REDRAW = ':not(:has(.filter-target:target))'
const NESTED_LIGHT = /^(\S+) \{.*& (\.chip\[href="#[\w-]+"\]) \{ (--_bg: var\(--wire\))/
const LIT_RULE = /([^{}]+)\{\s*--_bg: var\(--wire\)/g
const LIT_SELECTOR = /^(\S+) \.chip\[href="(#[\w-]+)"\]$/

function chipLighters(): { backlog: string, chip: string }[] {
  const flattened = ['live', 'review'].map(filterRule).map(rule => NESTED_LIGHT.exec(rule)!).map(match => `${match[1]} ${match[2]} { ${match[3]}; }`)
  const selectors = [...[STYLE, ...flattened].join('\n').matchAll(LIT_RULE)].flatMap(match => match[1]!.split(',').map(selector => selector.trim()))
  return selectors.flatMap((selector) => {
    const lit = LIT_SELECTOR.exec(selector)
    return lit === null ? [] : [{ backlog: lit[1]!, chip: lit[2]! }]
  })
}

function holds(selector: string, backlog: StubNode): boolean {
  expect(selector.startsWith('.backlog')).toBe(true)
  let rest = selector.slice('.backlog'.length)
  let held = true
  while (rest !== '') {
    const attribute = /^\[([\w-]+)="([^"]*)"\]/.exec(rest)
    if (attribute !== null) {
      held &&= backlog.attributes.get(attribute[1]!) === attribute[2]
      rest = rest.slice(attribute[0].length)
    }
    else if (/^:not\(\[[\w-]+\]\)/.test(rest)) {
      const absent = /^:not\(\[([\w-]+)\]\)/.exec(rest)!
      held &&= !backlog.attributes.has(absent[1]!)
      rest = rest.slice(absent[0].length)
    }
    else if (rest.startsWith(TARGET_AFTER_REDRAW)) {
      rest = rest.slice(TARGET_AFTER_REDRAW.length)
    }
    else {
      throw new Error(`no reading for ${rest}`)
    }
  }
  return held
}

function redrawChips(page: BoardPageStub, ids: readonly string[] = TAB_IDS): void {
  const backlog = page.byId.get(NAMES.backlog)!
  backlog.children.splice(0, backlog.children.length, ...backlog.children.filter(child => child.className !== 'chip'))
  for (const id of ids) {
    const chip = backlog.add(new StubNode('A'))
    chip.className = 'chip'
    chip.setAttribute('href', `#${id}`)
  }
}

function activeChips(page: BoardPageStub): string[] {
  const backlog = page.byId.get(NAMES.backlog)!
  const lighters = chipLighters()
  return backlog.children.filter(child => child.className === 'chip').map(chip => chip.attributes.get('href')!).filter(href => lighters.some(lighter => lighter.chip === href && holds(lighter.backlog, backlog)))
}

function storedView(storage: MemoryStorage): { folds: Record<string, boolean> } {
  return JSON.parse(storage.getItem(NAMES.viewKey) ?? '{}') as { folds: Record<string, boolean> }
}

describe('the board page script', () => {
  it('a folded section stays folded after a reload', () => {
    const storage = new MemoryStorage()
    const first = boardPage(storage)
    const folded = withFoldGroup(first, '1978')
    const opened = withFoldGroup(first, '1979')
    const page = run(first)
    expect(folded.attributes.has('data-collapsed')).toBe(true)
    expect(opened.attributes.has('data-collapsed')).toBe(true)
    page.click(opened.children[0]!)
    page.click(folded.children[0]!)
    page.click(folded.children[0]!)
    expect(storedView(storage).folds).toEqual({ 1979: true })

    const second = boardPage(storage)
    const foldedAgain = withFoldGroup(second, '1978')
    const openedAgain = withFoldGroup(second, '1979')
    run(second)
    expect(foldedAgain.attributes.has('data-collapsed')).toBe(true)
    expect(foldedAgain.children[0]!.attributes.get('aria-expanded')).toBe('false')
    expect(openedAgain.attributes.has('data-collapsed')).toBe(false)
    expect(openedAgain.children[0]!.attributes.get('aria-expanded')).toBe('true')
  })

  it('the refresh countdown counts from the written time, not from the load', () => {
    const fresh = run(boardPage())
    expect(fresh.timeouts.map(timeout => timeout.ms)).toEqual([TICK_MS])

    const loadedLater = 4_000
    const reloaded = boardPage(new MemoryStorage(), Date.parse(WRITTEN) + loadedLater)
    const page = run(reloaded)
    const left = TICK_MS + WRITE_SLACK_MS - loadedLater
    expect(page.timeouts.map(timeout => timeout.ms)).toEqual([left])
    page.paint()
    expect(reloaded.byId.get(NAMES.refreshIn)!.textContent).toBe(` · next in ${Math.ceil(left / 1000)}s`)
    page.advance(3_000)
    page.paint()
    expect(reloaded.byId.get(NAMES.refreshIn)!.textContent).toBe(` · next in ${Math.ceil((left - 3_000) / 1000)}s`)
  })

  it('a shell with no data reads board-data.js at once and reopens the saved dialog only once the data is in', () => {
    const storage = new MemoryStorage()
    storage.setItem(NAMES.viewKey, JSON.stringify({ open: NAMES.handoffDialog }))
    const stub = boardPage(storage)
    const page = run(stub, '')
    expect(page.appended).toHaveLength(1)
    expect(page.timeouts).toHaveLength(0)
    const template = new StubNode('TEMPLATE')
    stub.byId.set(`${NAMES.dialogPrefix}${NAMES.handoffDialog}`, template)
    expect(stub.byId.get(NAMES.drill)!.open).toBe(false)
    page.context.BOARD = { written: WRITTEN, tickMs: TICK_MS, slots: {}, filters: [] }
    page.appended[0]!.onload!()
    expect(stub.byId.get(NAMES.drill)!.open).toBe(true)
    expect(page.timeouts).toHaveLength(1)
  })

  it('a click on data-pull re-reads the board at once', () => {
    const stub = boardPage()
    const pull = stub.root.add(new StubNode('BUTTON', { pull: '' }))
    const page = run(stub)
    expect(page.appended).toHaveLength(0)
    page.advance(1_000)
    page.click(pull)
    expect(page.appended).toHaveLength(1)
    expect(page.appended[0]!.src).toBe(`${NAMES.dataFile}?t=${Date.parse(WRITTEN) + 1_000}`)

    const rewritten = '2026-11-16T10:00:01.000Z'
    page.context.BOARD = { written: rewritten, tickMs: TICK_MS, slots: {}, filters: [] }
    page.appended[0]!.onload!()
    expect(page.appended[0]!.removed).toBe(true)
    expect((page.context.document as { title: string }).title).toBe(`${NAMES.titlePrefix}${rewritten}`)
    expect(page.timeouts).toHaveLength(2)
    page.timeouts[0]!.run()
    expect(page.appended).toHaveLength(1)
    page.timeouts[1]!.run()
    expect(page.appended).toHaveLength(2)
  })

  it('the load counter animates to the data-count value', () => {
    const stub = boardPage()
    const counter = withCounter(stub, '4.5')
    const page = run(stub)
    page.paint()
    expect(counter.textContent).toBe('0.0')
    page.advance(300)
    page.paint()
    expect(counter.textContent).toBe((4.5 * (1 - 0.5 ** 3)).toFixed(1))
    page.advance(300)
    page.paint()
    expect(counter.textContent).toBe('4.5')
    counter.textContent = 'settled'
    page.advance(300)
    page.paint()
    expect(counter.textContent).toBe('settled')

    counter.dataset.count = '6.0'
    page.timeouts[0]!.run()
    page.context.BOARD = { written: '2026-11-16T10:00:11.500Z', slots: {}, filters: [] }
    page.appended[0]!.onload!()
    page.paint()
    expect(counter.textContent).toBe('4.5')
    page.advance(600)
    page.paint()
    expect(counter.textContent).toBe('6.0')
  })

  it('exactly one chip is active after load, reload, hashchange and every refresh, on every tab', () => {
    for (const [index, id] of TAB_IDS.entries()) {
      const storage = new MemoryStorage()
      const loaded = boardPage(storage)
      const page = run(loaded, '', `#${id}`)
      redrawChips(loaded)
      page.receive({ filters: TAB_IDS })
      expect(activeChips(loaded), `load ${id}`).toEqual([`#${id}`])
      redrawChips(loaded)
      page.refresh()
      page.receive({ filters: TAB_IDS })
      expect(activeChips(loaded), `refresh ${id}`).toEqual([`#${id}`])

      const other = TAB_IDS[(index + 1) % TAB_IDS.length]!
      page.location.hash = `#${other}`
      page.fire('hashchange')
      expect(activeChips(loaded), `hashchange ${id} → ${other}`).toEqual([`#${other}`])
      page.location.hash = `#${id}`
      page.fire('hashchange')

      for (const hash of [`#${id}`, '']) {
        const again = boardPage(storage)
        const reloaded = run(again, '', hash)
        redrawChips(again)
        reloaded.receive({ filters: TAB_IDS })
        expect(activeChips(again), `reload ${id} with hash '${hash}'`).toEqual([`#${id}`])
        redrawChips(again)
        reloaded.refresh()
        reloaded.receive({ filters: TAB_IDS })
        expect(activeChips(again), `refresh after reload ${id} with hash '${hash}'`).toEqual([`#${id}`])
      }

      const [all] = TAB_IDS
      const left = TAB_IDS.filter(tab => tab !== id)
      if (id === all)
        continue
      const gone = boardPage(storage)
      const stale = run(gone, '', `#${id}`)
      redrawChips(gone)
      stale.receive({ filters: TAB_IDS })
      redrawChips(gone, left)
      stale.refresh()
      stale.receive({ filters: left })
      expect(activeChips(gone), `refresh after ${id} left the board`).toEqual([`#${all}`])
      for (const hash of [`#${id}`, '']) {
        const after = boardPage(storage)
        const reloaded = run(after, '', hash)
        redrawChips(after, left)
        reloaded.receive({ filters: left })
        expect(activeChips(after), `reload with hash '${hash}' after ${id} left the board`).toEqual([`#${all}`])
      }
    }

    const [all, live, review] = TAB_IDS
    const rendered = boardPage()
    redrawChips(rendered, [all!, live!])
    const target = rendered.byId.get(NAMES.backlog)!.add(new StubNode('SPAN'))
    target.className = 'filter-target'
    target.id = live!
    run(rendered, WRITTEN, `#${live}`)
    expect(activeChips(rendered), `rendered page loaded with #${live} before any data`).toEqual([`#${live}`])

    const staleRendered = boardPage()
    redrawChips(staleRendered, [all!, live!])
    run(staleRendered, WRITTEN, `#${review}`)
    expect(activeChips(staleRendered), `rendered page loaded with #${review}, which it does not carry, before any data`).toEqual([`#${all}`])
  })

  it('favicon: the page script swaps the icon to the alarm one while an alarm is open and back when it closes', () => {
    const stub = boardPage()
    const icon = stub.root.add(new StubNode('LINK'))
    icon.id = NAMES.icon.id
    const page = run(stub, '')
    page.receive({ alarms: [] })
    expect(icon.attributes.get('href')).toBe(NAMES.icon.calm)
    page.refresh()
    page.receive({ alarms: ['disk'] })
    expect(icon.attributes.get('href')).toBe(NAMES.icon.alarm)
    page.refresh()
    page.receive({ alarms: [] })
    expect(icon.attributes.get('href')).toBe(NAMES.icon.calm)
  })
})
