import type { BusFamily } from '../../../src/commands/board/bus-panel.js'
import type { BusFacts, BusPanelFacts, BusSlot } from '../../../src/commands/board/bus.js'
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
const MOTION_MS = 700
const SCROLLED = 120
const ELEMENT = 1
const TEXT = 3
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
const TOKEN = /<\/([\w-]+)\s*>|<([\w-]+)((?:\s+[\w:-]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g
const ATTRIBUTE = /([\w:-]+)(?:="([^"]*)")?/g
const VOID = new Set(['BR', 'HR', 'IMG', 'INPUT', 'META', 'LINK'])

class MiniNode {
  parentNode: MiniElement | null = null

  constructor(readonly nodeType: number, readonly nodeName: string) {}

  get nextSibling(): MiniNode | null {
    const siblings = this.parentNode?.childNodes ?? []
    return siblings[siblings.indexOf(this) + 1] ?? null
  }

  remove(): void {
    this.parentNode?.detach(this)
  }

  html(): string {
    return ''
  }
}

class MiniText extends MiniNode {
  constructor(public nodeValue: string) {
    super(TEXT, '#text')
  }

  override html(): string {
    return this.nodeValue
  }
}

function datasetName(attribute: string): string {
  return attribute.slice('data-'.length).replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase())
}

class MiniElement extends MiniNode {
  childNodes: MiniNode[] = []
  readonly attrs = new Map<string, string>()
  readonly props = new Map<string, string>()
  readonly style = { setProperty: (name: string, value: string): void => void this.props.set(name, value) }
  readonly classList = {
    add: (name: string): void => this.setAttribute('class', [...this.classes().filter(each => each !== name), name].join(' ')),
    remove: (name: string): void => this.setAttribute('class', this.classes().filter(each => each !== name).join(' ')),
  }

  reflows = 0
  scrollTop = 0
  open = false
  onload: (() => void) | null = null

  constructor(tag: string) {
    super(ELEMENT, tag.toUpperCase())
  }

  get offsetWidth(): number {
    this.reflows += 1
    return 0
  }

  get content(): MiniElement | undefined {
    return this.nodeName === 'TEMPLATE' ? this : undefined
  }

  get attributes(): { name: string, value: string }[] {
    return [...this.attrs].map(([name, value]) => ({ name, value }))
  }

  get dataset(): Record<string, string> {
    return Object.fromEntries([...this.attrs].filter(([name]) => name.startsWith('data-')).map(([name, value]) => [datasetName(name), value]))
  }

  get firstChild(): MiniNode | null {
    return this.childNodes[0] ?? null
  }

  get innerHTML(): string {
    return this.childNodes.map(child => child.html()).join('')
  }

  set innerHTML(markup: string) {
    this.childNodes.forEach((child) => {
      child.parentNode = null
    })
    this.childNodes = []
    parseInto(this, markup)
  }

  classes(): string[] {
    return (this.getAttribute('class') ?? '').split(' ').filter(each => each !== '')
  }

  override html(): string {
    const attributes = [...this.attrs].map(([name, value]) => ` ${name}="${value}"`).join('')
    const tag = this.nodeName.toLowerCase()
    return `<${tag}${attributes}>${this.innerHTML}</${tag}>`
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null
  }

  hasAttribute(name: string): boolean {
    return this.attrs.has(name)
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value)
  }

  removeAttribute(name: string): void {
    this.attrs.delete(name)
  }

  detach(child: MiniNode): void {
    this.childNodes = this.childNodes.filter(each => each !== child)
    child.parentNode = null
  }

  insertBefore(child: MiniNode, before: MiniNode | null): MiniNode {
    child.remove()
    const at = before === null ? -1 : this.childNodes.indexOf(before)
    this.childNodes.splice(at < 0 ? this.childNodes.length : at, 0, child)
    child.parentNode = this
    return child
  }

  appendChild(child: MiniNode): MiniNode {
    return this.insertBefore(child, null)
  }

  prepend(child: MiniNode): void {
    this.insertBefore(child, this.firstChild)
  }

  descendants(): MiniElement[] {
    return this.childNodes.filter(child => child instanceof MiniElement).flatMap(child => [child, ...child.descendants()])
  }

  querySelectorAll(selector: string): MiniElement[] {
    const attribute = /^\[([\w-]+)\]$/.exec(selector)?.[1]
    return attribute === undefined ? [] : this.descendants().filter(node => node.hasAttribute(attribute))
  }

  querySelector(selector: string): MiniElement | null {
    return this.querySelectorAll(selector)[0] ?? null
  }

  addEventListener(): void {}
}

function parseInto(root: MiniElement, markup: string): void {
  const open: MiniElement[] = [root]
  for (const [, closing, tag, attributes, selfClosing, text] of markup.matchAll(TOKEN)) {
    const parent = open.at(-1)!
    if (text !== undefined) {
      parent.appendChild(new MiniText(text))
      continue
    }
    if (closing !== undefined) {
      open.pop()
      continue
    }
    const element = new MiniElement(tag!)
    for (const [, name, value] of (attributes ?? '').matchAll(ATTRIBUTE))
      element.setAttribute(name!, value ?? '')
    parent.appendChild(element)
    if (selfClosing === '' && !VOID.has(element.nodeName))
      open.push(element)
  }
}

interface Reading {
  at: string
  minutes?: number[]
  families?: BusFamily[]
  slots?: BusSlot[]
  cards?: string[]
}

const NO_PANEL: BusPanelFacts = { lastEvent: null, minutes: [], families: [], familyTotal: 0, reducerLag: 0, rateRemaining: null, pulses: [], workers: [], alarm: null, recent: [] }

function servicesHtml(reading: Reading): string {
  const families = reading.families ?? []
  const panel = { ...NO_PANEL, minutes: reading.minutes ?? [], families, familyTotal: families.reduce((sum, each) => sum + each.count, 0) }
  const facts = { at: reading.at, pulse: reading.at, slots: reading.slots ?? [], waits: [], panel } as unknown as BusFacts
  const session = `<div class="svc bevel" data-open="session-s1"><button class="svc-agents" data-agents="s1">agents</button></div>`
  return `${session}${busPanel({ facts, freshMs: FRESH_MS, snapshot: null, startCommand: 'pnpm bus:run' })}`
}

function backlogHtml(reading: Reading): string {
  const rows = (reading.cards ?? []).map(card => `<tr data-card="${card}" data-stage="${reading.at}"><td class="id">#${card}</td></tr>`).join('')
  return `<div id="backlog-scroll" class="scroll"><table><tbody class="task-group" data-task="t1"><tr class="task"><th><button data-fold="t1">t1</button></th></tr>${rows}</tbody></table></div>`
}

interface Board {
  root: MiniElement
  deliver: (reading: Reading) => void
  timeouts: { callback: () => void, delay: number }[]
}

function board(first: Reading): Board {
  const root = new MiniElement('body')
  root.innerHTML = `<div id="slot-services">${servicesHtml(first)}</div><div id="slot-backlog">${backlogHtml(first)}</div><dialog id="drill"></dialog><div id="drill-content"></div>`
  const timeouts: { callback: () => void, delay: number }[] = []
  const appended: MiniElement[] = []
  const stored = JSON.stringify({ folds: { t1: true } })
  const document = {
    title: '',
    body: { dataset: { written: WRITTEN, tickMs: String(TICK_MS) } },
    head: { appendChild: (child: MiniElement) => appended.push(child) },
    getElementById: (id: string) => root.descendants().find(node => node.getAttribute('id') === id) ?? null,
    createElement: (tag: string) => new MiniElement(tag),
    querySelector: (selector: string) => root.querySelector(selector),
    querySelectorAll: (selector: string) => root.querySelectorAll(selector),
    addEventListener: () => {},
  }
  const context: Record<string, unknown> = {
    BOARD_NAMES: NAMES,
    document,
    localStorage: { getItem: () => stored, setItem: () => {} },
    location: { hash: '' },
    addEventListener: () => {},
    setTimeout: (callback: () => void, delay: number) => timeouts.push({ callback, delay }),
    Date: { now: () => Date.parse(WRITTEN), parse: Date.parse },
  }
  context.window = context
  vm.createContext(context)
  vm.runInContext(SCRIPT, context)
  const deliver = (reading: Reading): void => {
    timeouts.filter(each => each.delay !== MOTION_MS).at(-1)!.callback()
    context.BOARD = { written: reading.at, tickMs: TICK_MS, slots: { services: servicesHtml(reading), backlog: backlogHtml(reading) }, filters: [] }
    appended.at(-1)!.onload!()
  }
  return { root, deliver, timeouts }
}

function minutesLater(minutes: number): string {
  return new Date(Date.parse(WRITTEN) + minutes * MINUTE_MS).toISOString()
}

function keyed(root: MiniElement, attribute: string, value: string): MiniElement {
  return root.descendants().find(node => node.getAttribute(attribute) === value)!
}

function flowStrip(root: MiniElement): MiniElement {
  return root.querySelector('[data-flow-minute]')!
}

describe('the board patches a refresh in place', () => {
  it('two refreshes keep the same element instances', () => {
    const slot = (used: number): BusSlot => ({ queue: 'launch', used, total: 3 }) as BusSlot
    const families = (review: number): BusFamily[] => [{ family: 'review', count: review }, { family: 'pr', count: 4 }]
    const { root, deliver } = board({ at: WRITTEN, minutes: [1, 2], families: families(6), slots: [slot(1)], cards: ['11', '12'] })
    const scroller = keyed(root, 'id', 'backlog-scroll')
    scroller.scrollTop = SCROLLED
    const before = {
      session: keyed(root, 'data-agents', 's1'),
      card: keyed(root, 'data-card', '12'),
      group: keyed(root, 'data-task', 't1'),
      queue: keyed(root, 'data-slot-queue', 'launch'),
      review: keyed(root, 'data-family', 'review'),
      pr: keyed(root, 'data-family', 'pr'),
      strip: flowStrip(root),
    }
    deliver({ at: minutesLater(1), minutes: [2, 3], families: families(2), slots: [slot(2)], cards: ['10', '11', '12'] })
    deliver({ at: minutesLater(2), minutes: [3, 4], families: families(1), slots: [slot(3)], cards: ['10', '11', '12'] })
    expect(keyed(root, 'id', 'backlog-scroll')).toBe(scroller)
    expect(scroller.scrollTop).toBe(SCROLLED)
    expect(keyed(root, 'data-agents', 's1')).toBe(before.session)
    expect(keyed(root, 'data-card', '12')).toBe(before.card)
    expect(before.card.getAttribute('data-stage')).toBe(minutesLater(2))
    expect(root.querySelectorAll('[data-card]').map(row => row.getAttribute('data-card'))).toEqual(['10', '11', '12'])
    expect(keyed(root, 'data-task', 't1')).toBe(before.group)
    expect(before.group.hasAttribute('data-collapsed')).toBe(false)
    expect(keyed(root, 'data-slot-queue', 'launch')).toBe(before.queue)
    expect(before.queue.getAttribute('data-used')).toBe('3')
    expect(keyed(root, 'data-family', 'review')).toBe(before.review)
    expect(keyed(root, 'data-family', 'pr')).toBe(before.pr)
    expect(flowStrip(root)).toBe(before.strip)
  })

  it('a slot take flickers the taken segment and a free blinks the freed one', () => {
    const slot = (used: number): BusSlot => ({ queue: 'launch', used, total: 3 }) as BusSlot
    const { root, deliver } = board({ at: WRITTEN, slots: [slot(1)] })
    const segments = keyed(root, 'data-slot-queue', 'launch').querySelectorAll('[data-seg]')
    deliver({ at: minutesLater(1), slots: [slot(2)] })
    expect(segments[1]!.classes()).toEqual(['seg-in'])
    deliver({ at: minutesLater(2), slots: [slot(1)] })
    expect(keyed(root, 'data-slot-queue', 'launch').querySelectorAll('[data-seg]')).toEqual(segments)
    expect(segments[1]!.classes()).toEqual(['seg-out'])
    expect(segments[1]!.hasAttribute('data-on')).toBe(false)
  })
})

describe('the bus panel motion on a patched board', () => {
  it('a new minute adds the slide transform to the event flow strip', () => {
    const { root, deliver } = board({ at: WRITTEN, minutes: [1, 1, 1] })
    const strip = flowStrip(root)
    deliver({ at: minutesLater(1), minutes: [1, 1, 2] })
    expect(strip.classes()).toEqual(['flow-bars', 'flow-shift'])
    expect(strip.props.get('--_shift')).toBe('1')
    expect(strip.querySelectorAll('[data-flow-bar]').at(-1)!.classes()).toEqual(['flow-bar', 'flow-new'])
    const reflows = strip.reflows
    deliver({ at: minutesLater(2), minutes: [1, 2, 3] })
    expect(flowStrip(root)).toBe(strip)
    expect(strip.classes()).toEqual(['flow-bars', 'flow-shift'])
    expect(strip.reflows).toBeGreaterThan(reflows)
    expect(STYLE).toContain('@keyframes --animation-flow-shift { from { transform: translateX(calc(100% * var(--_shift, 0) / var(--_bars, 1))); } }')
  })

  it('a rank change moves a top events row with a transition', () => {
    const { root, deliver } = board({ at: WRITTEN, families: [{ family: 'review', count: 6 }, { family: 'pr', count: 4 }] })
    const pr = keyed(root, 'data-family', 'pr')
    expect(pr.getAttribute('style')).toContain('--_rank:1;')
    deliver({ at: minutesLater(1), families: [{ family: 'pr', count: 7 }, { family: 'review', count: 3 }] })
    expect(keyed(root, 'data-family', 'pr')).toBe(pr)
    expect(pr.getAttribute('style')).toContain('--_rank:0;')
    expect(pr.getAttribute('style')).toContain('--_share:70%;')
    expect(STYLE).toMatch(/\.bus-families \{[^}]*& li \{[^}]*top: calc\(var\(--_rank\) \* var\(--_row\)\);[^}]*transition: top 0\.7s ease-out;/)
    expect(STYLE).toMatch(/\.family-bar \{[^}]*&::before \{[^}]*inline-size: var\(--_share\);[^}]*transition: inline-size 0\.7s ease-out;/)
  })

  it('event families render distinct bar colours', () => {
    const names = ['card', 'pr', 'review', 'worker', 'child', 'task', 'answer', 'launch', 'witness', 'merge', 'owner', 'bus']
    const { root } = board({ at: WRITTEN, families: names.map(family => ({ family, count: 1 })) })
    const hues = root.querySelectorAll('[data-family]').map(row => /--_hue:(\d+)/.exec(row.getAttribute('style')!)![1])
    expect(hues).toHaveLength(names.length)
    expect(new Set(hues).size).toBe(names.length)
    expect(STYLE).toMatch(/\.family-bar \{[^}]*&::before \{[^}]*background: oklch\(0\.8 0\.15 var\(--_hue, 195\)\);/)
  })

  it('the bus emblem is the octagon svg with the terminal glyph and pulse ring', () => {
    const { root } = board({ at: WRITTEN })
    const emblem = root.descendants().find(node => node.getAttribute('class') === 'bus-emblem')!
    expect(emblem.nodeName).toBe('SVG')
    const parts = Object.fromEntries((emblem.childNodes as MiniElement[]).map(part => [part.getAttribute('class'), part]))
    expect(parts['bus-emblem-ring']!.nodeName).toBe('CIRCLE')
    expect(parts['bus-emblem-octagon']!.getAttribute('points')!.split(' ')).toHaveLength(8)
    expect(parts['bus-emblem-glyph']!.getAttribute('d')).toBe('M10 11.5 L14.5 16 L10 20.5 M16.5 21 H22')
    expect(STYLE).toContain('.bus-emblem {\n  --_emblem: var(--wire);')
    expect(STYLE).toContain('.bus-panel[data-down] .bus-emblem { --_emblem: var(--signal); }')
    expect(STYLE).toContain('animation: --animation-bus-pulse 2s ease-out infinite;')
  })
})
