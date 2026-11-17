import type { BusFamily } from '../../../src/commands/board/bus-panel.js'
import type { BusFacts, BusPanelFacts } from '../../../src/commands/board/bus.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { busPanel } from '../../cli/board-page/bus-panel.js'

const SCRIPT = readFileSync(path.resolve(import.meta.dirname, '../../cli/board-page/script.js'), 'utf8')
const STYLE = readFileSync(path.resolve(import.meta.dirname, '../../cli/board-page/style.css'), 'utf8')
const WRITTEN = '2026-11-17T08:00:00.000Z'
const TICK_MS = 10_000
const FRESH_MS = 600_000
const MINUTE_MS = 60_000
const FLOW_MINUTES = 30
const NAMES = {
  drill: 'drill',
  drillContent: 'drill-content',
  backlogScroll: 'backlog-scroll',
  viewKey: 'board:view',
  dialogPrefix: 'dialog-',
  busLive: 'bus-live',
  pulse: 'pulse',
  titlePrefix: 'board · ',
  slotPrefix: 'slot-',
  backlog: 'backlog',
  staleTicks: 3,
  dataFile: 'board-data.js',
  refreshIn: 'refresh-in',
  round: {},
}
const FLOW_STRIP = /<div class="flow-bars" data-flow-minute="(\d+)"[^>]*>([\s\S]*?)<\/div>/
const FLOW_BAR = /<i class="flow-bar" data-flow-bar/g
const FAMILY_LIST = /<ul class="bus-families" data-families/
const FAMILY_ROW = /<li data-family="([^"]+)" data-rank="(\d+)" data-share="(\d+)"[^>]*>([\s\S]*?)<\/li>/g

function datasetKey(selector: string): string | null {
  const match = /^\[data-([\w-]+)\]$/.exec(selector)
  return match === null ? null : match[1]!.replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase())
}

class StubNode {
  readonly dataset: Record<string, string> = {}
  readonly classes = new Set<string>()
  readonly classList = { add: (name: string): void => void this.classes.add(name) }
  readonly props = new Map<string, string>()
  readonly style = { setProperty: (name: string, value: string): void => void this.props.set(name, value) }
  readonly attributes = new Map<string, string>()
  children: StubNode[] = []
  parent: StubNode | null = null
  id = ''
  src = ''
  open = false
  removed = false
  onload: (() => void) | null = null
  private html = ''

  get className(): string {
    return [...this.classes].join(' ')
  }

  set className(name: string) {
    this.classes.clear()
    name.split(' ').filter(part => part !== '').forEach(part => this.classes.add(part))
  }

  get innerHTML(): string {
    return this.html
  }

  set innerHTML(html: string) {
    this.html = html
    this.children = []
    const strip = FLOW_STRIP.exec(html)
    if (strip !== null) {
      const node = this.adopt(Object.assign(new StubNode(), { dataset: { flowMinute: strip[1]! } }))
      Array.from(strip[2]!.matchAll(FLOW_BAR)).forEach(() => node.adopt(Object.assign(new StubNode(), { dataset: { flowBar: '' } })))
    }
    if (FAMILY_LIST.test(html)) {
      const list = this.adopt(Object.assign(new StubNode(), { dataset: { families: '' } }))
      for (const [, family, rank, share, inner] of html.matchAll(FAMILY_ROW)) {
        const row = list.adopt(Object.assign(new StubNode(), { dataset: { family: family!, rank: rank!, share: share! } }))
        row.html = inner!
      }
    }
  }

  adopt(child: StubNode): StubNode {
    child.parent = this
    this.children.push(child)
    return child
  }

  appendChild(child: StubNode): StubNode {
    return this.adopt(child)
  }

  descendants(): StubNode[] {
    return this.children.flatMap(child => [child, ...child.descendants()])
  }

  querySelector(selector: string): StubNode | null {
    return this.querySelectorAll(selector)[0] ?? null
  }

  querySelectorAll(selector: string): StubNode[] {
    const key = datasetKey(selector)
    return this.descendants().filter(node => key !== null && key in node.dataset)
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  remove(): void {
    this.removed = true
    if (this.parent !== null)
      this.parent.children = this.parent.children.filter(child => child !== this)
  }

  removeAttribute(): void {}
  addEventListener(): void {}
}

const NO_PANEL: BusPanelFacts = { lastEvent: null, minutes: [], families: [], familyTotal: 0, reducerLag: 0, rateRemaining: null, pulses: [], workers: [], alarm: null, recent: [] }

function panelHtml(at: string, minutes: number[], families: BusFamily[]): string {
  const panel = { ...NO_PANEL, minutes, families, familyTotal: families.reduce((sum, row) => sum + row.count, 0) }
  return busPanel({ facts: { at, pulse: at, slots: [], waits: [], panel } as unknown as BusFacts, freshMs: FRESH_MS, snapshot: null, startCommand: 'pnpm bus:run' })
}

interface Reading {
  at: string
  minutes?: number[]
  families?: BusFamily[]
}

interface Refreshed {
  services: StubNode
  timeouts: (() => void)[]
}

function refresh(before: Reading, after: Reading): Refreshed {
  const services = new StubNode()
  services.innerHTML = panelHtml(before.at, before.minutes ?? [], before.families ?? [])
  const byId = new Map<string, StubNode>([[NAMES.drill, new StubNode()], [NAMES.drillContent, new StubNode()], [`${NAMES.slotPrefix}services`, services]])
  const timeouts: (() => void)[] = []
  const appended: StubNode[] = []
  const document = {
    title: '',
    body: { dataset: { written: WRITTEN, tickMs: String(TICK_MS) } },
    head: { appendChild: (child: StubNode) => appended.push(child) },
    getElementById: (id: string) => byId.get(id) ?? null,
    createElement: () => new StubNode(),
    querySelector: (selector: string) => services.querySelector(selector),
    querySelectorAll: (selector: string) => services.querySelectorAll(selector),
    addEventListener: () => {},
  }
  const context: Record<string, unknown> = {
    BOARD_NAMES: NAMES,
    document,
    localStorage: { getItem: () => null, setItem: () => {} },
    location: { hash: '' },
    addEventListener: () => {},
    setTimeout: (callback: () => void) => timeouts.push(callback),
    Date: { now: () => Date.parse(WRITTEN), parse: Date.parse },
  }
  context.window = context
  vm.createContext(context)
  vm.runInContext(SCRIPT, context)
  timeouts.shift()!()
  context.BOARD = { written: after.at, tickMs: TICK_MS, slots: { services: panelHtml(after.at, after.minutes ?? [], after.families ?? []) }, filters: [] }
  appended.at(-1)!.onload!()
  return { services, timeouts }
}

function minutesLater(minutes: number): string {
  return new Date(Date.parse(WRITTEN) + minutes * MINUTE_MS).toISOString()
}

function flat(count: number): number[] {
  return Array.from<number>({ length: FLOW_MINUTES }).fill(count)
}

function row(services: StubNode, family: string): StubNode {
  return services.querySelectorAll('[data-family]').find(node => node.dataset.family === family)!
}

describe('the bus panel motion', () => {
  it('a refresh marks the new event flow bar and shifts the strip', () => {
    const { services } = refresh({ at: WRITTEN, minutes: flat(1) }, { at: minutesLater(2), minutes: flat(2) })
    const strip = services.querySelector('[data-flow-minute]')!
    expect(strip.classes.has('flow-shift')).toBe(true)
    expect(strip.props.get('--_shift')).toBe('2')
    const bars = strip.querySelectorAll('[data-flow-bar]')
    expect(bars).toHaveLength(FLOW_MINUTES)
    expect(bars.map(bar => bar.classes.has('flow-new'))).toEqual([...Array.from<boolean>({ length: FLOW_MINUTES - 1 }).fill(false), true])
  })

  it('a refresh inside the same minute does not move the strip', () => {
    const { services } = refresh({ at: WRITTEN, minutes: flat(1) }, { at: new Date(Date.parse(WRITTEN) + TICK_MS).toISOString(), minutes: flat(2) })
    const strip = services.querySelector('[data-flow-minute]')!
    expect(strip.classes.size).toBe(0)
    expect(strip.querySelectorAll('[data-flow-bar]').some(bar => bar.classes.has('flow-new'))).toBe(false)
  })

  it('a shift longer than the strip moves it by the strip at most', () => {
    const { services } = refresh({ at: WRITTEN, minutes: flat(1) }, { at: minutesLater(90), minutes: flat(1) })
    expect(services.querySelector('[data-flow-minute]')!.props.get('--_shift')).toBe(String(FLOW_MINUTES))
  })

  it('a share that rose flashes, a share that fell does not', () => {
    const { services } = refresh(
      { at: WRITTEN, families: [{ family: 'review', count: 6 }, { family: 'pr', count: 4 }] },
      { at: minutesLater(1), families: [{ family: 'review', count: 7 }, { family: 'pr', count: 3 }] },
    )
    expect([...row(services, 'review').classes]).toEqual(['share-up'])
    expect([...row(services, 'pr').classes]).toEqual([])
  })

  it('a family entering the top fades in and one leaving fades out at its old rank', () => {
    const { services, timeouts } = refresh(
      { at: WRITTEN, families: [{ family: 'review', count: 5 }, { family: 'card', count: 5 }] },
      { at: minutesLater(1), families: [{ family: 'review', count: 5 }, { family: 'pr', count: 5 }] },
    )
    expect(row(services, 'pr').classes.has('rank-in')).toBe(true)
    const list = services.querySelector('[data-families]')!
    const ghost = list.children.find(child => child.classes.has('rank-out'))!
    expect(ghost.props.get('--_rank')).toBe('1')
    expect(ghost.attributes.get('aria-hidden')).toBe('true')
    expect(ghost.innerHTML).toContain('<span>card</span>')
    timeouts.forEach(callback => callback())
    expect(ghost.removed).toBe(true)
  })

  it('every new keyframe is a dashed animation ident and stops under reduced motion', () => {
    const reduced = STYLE.slice(STYLE.indexOf('@media (prefers-reduced-motion: reduce)'))
    for (const selector of ['.flow-bars.flow-shift', '.flow-bar.flow-new', '.bus-families li:is(.rank-in, .rank-out)', '.bus-families li, .family-bar::before { transition: none; }', '.pulse-dot', '.svc-state::before', '.crawler-chip::before', '.bus-health li > span::before'])
      expect(reduced).toContain(selector)
    expect([...STYLE.matchAll(/@keyframes (\S+)/g)].map(match => match[1]).every(name => name!.startsWith('--animation-'))).toBe(true)
  })
})
