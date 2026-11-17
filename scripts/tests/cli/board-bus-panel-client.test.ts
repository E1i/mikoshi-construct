import type { BusFacts, BusSlot } from '../../../src/commands/board/bus.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { busPanel } from '../../cli/board-page/bus-panel.js'

const SCRIPT = readFileSync(path.resolve(import.meta.dirname, '../../cli/board-page/script.js'), 'utf8')
const WRITTEN = '2026-11-17T08:00:00.000Z'
const NEXT = '2026-11-17T08:00:10.000Z'
const TICK_MS = 10_000
const FRESH_MS = 600_000
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
const SLOT_ROW = /<li data-slot-queue="([^"]+)" data-used="(\d+)"[^>]*>([\s\S]*?)<\/li>/g
const SEGMENT = /<i data-seg/g

function datasetKey(selector: string): string | null {
  const match = /^\[data-([\w-]+)\]$/.exec(selector)
  return match === null ? null : match[1]!.replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase())
}

class StubNode {
  readonly dataset: Record<string, string> = {}
  readonly classes = new Set<string>()
  readonly classList = { add: (name: string): void => void this.classes.add(name) }
  children: StubNode[] = []
  id = ''
  src = ''
  open = false
  onload: (() => void) | null = null
  private html = ''

  get innerHTML(): string {
    return this.html
  }

  set innerHTML(html: string) {
    this.html = html
    this.children = [...html.matchAll(SLOT_ROW)].map(([, queue, used, inner]) => {
      const row = new StubNode()
      Object.assign(row.dataset, { slotQueue: queue, used })
      row.children = [...inner!.matchAll(SEGMENT)].map(() => Object.assign(new StubNode(), { dataset: { seg: '' } }))
      return row
    })
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

  setAttribute(): void {}
  removeAttribute(): void {}
  addEventListener(): void {}
  remove(): void {}
}

function panelHtml(slots: BusSlot[]): string {
  return busPanel({ facts: { at: WRITTEN, pulse: WRITTEN, slots, waits: [] } as unknown as BusFacts, freshMs: FRESH_MS, snapshot: null, startCommand: 'pnpm bus:run' })
}

function refresh(before: BusSlot[], after: BusSlot[]): StubNode {
  const services = new StubNode()
  services.innerHTML = panelHtml(before)
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
  context.BOARD = { written: NEXT, tickMs: TICK_MS, slots: { services: panelHtml(after) }, filters: [] }
  appended.at(-1)!.onload!()
  return services
}

function segmentClasses(services: StubNode, queue: string): string[] {
  const row = services.children.find(child => child.dataset.slotQueue === queue)!
  return row.children.map(segment => [...segment.classes].join(' '))
}

describe('the bus panel client', () => {
  it('a slot taken from 1/3 to 2/3 fades in and a slot freed from 1/3 to 0/3 blinks', () => {
    const services = refresh(
      [{ queue: 'launch', used: 1, total: 3 }, { queue: 'review', used: 1, total: 3 }],
      [{ queue: 'launch', used: 2, total: 3 }, { queue: 'review', used: 0, total: 3 }],
    )
    expect(segmentClasses(services, 'launch')).toEqual(['', 'seg-in', ''])
    expect(segmentClasses(services, 'review')).toEqual(['seg-out', '', ''])
  })

  it('an unchanged reading and a queue new on the page mark nothing', () => {
    const services = refresh([{ queue: 'launch', used: 2, total: 3 }], [{ queue: 'launch', used: 2, total: 3 }, { queue: 'merge', used: 1, total: 1 }])
    expect(segmentClasses(services, 'launch')).toEqual(['', '', ''])
    expect(segmentClasses(services, 'merge')).toEqual([''])
  })
})
