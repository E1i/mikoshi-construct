import type { BusCard, BusFacts } from '../../../src/commands/board/bus.js'
import type { BoardPage } from '../../cli/board-page.js'
import type { UiVersionPin } from '../../cli/board-page/live-cards.js'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { LORE, PLAIN_LORE } from '../../../src/ui/lore.js'
import { cardRowOf, headerReadings, warningsSlot } from '../../cli/board-page.js'
import { daemonOf, installedDaemons } from '../../cli/board-page/daemon-catalog.js'
import { CAPPED_CLASS, readUiVersionPin, UI_VERSION_FILE } from '../../cli/board-page/live-cards.js'
import { daemonsCell } from '../../cli/board-page/miko-panel.js'

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../../..')
const BOARD_PAGE = path.join(REPOSITORY_ROOT, 'scripts/cli/board-page.ts')
const BOARD_DIR = path.join(REPOSITORY_ROOT, 'scripts/cli/board-page')
const STYLE_FILE = 'scripts/cli/board-page/style.css'
const BUMP = 'board UI changed: bump ui-version.json'
const FIRST_UI_VERSION = 4
const SCRIPT = readFileSync(path.join(BOARD_DIR, 'script.js'), 'utf8')
const STYLE = readFileSync(path.join(BOARD_DIR, 'style.css'), 'utf8')
const WRITTEN = '2026-11-27T08:00:00.000Z'
const TICK_MS = 10_000
const MINUTE_MS = 60_000
const ELEMENT = 1
const TEXT = 3
const DEPENDENCIES = 40
const NAMES = { drill: 'drill', drillContent: 'drill-content', backlogScroll: 'backlog-scroll', viewKey: 'board:view', dialogPrefix: 'dialog-', busLive: 'bus-live', pulse: 'pulse', titlePrefix: 'board · ', slotPrefix: 'slot-', backlog: 'backlog', staleTicks: 3, dataFile: 'board-data.js', refreshIn: 'refresh-in', round: {} }
const TOKEN = /<\/([\w-]+)\s*>|<([\w-]+)((?:\s+[\w:-]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g
const ATTRIBUTE = /([\w:-]+)(?:="([^"]*)")?/g

function boardUiFiles(): Map<string, string> {
  const files = [BOARD_PAGE, ...readdirSync(BOARD_DIR).map(name => path.join(BOARD_DIR, name)).filter(file => file !== UI_VERSION_FILE)]
  return new Map(files.map(file => [path.relative(REPOSITORY_ROOT, file).split(path.sep).join('/'), readFileSync(file, 'utf8')]))
}

function uiHash(files: ReadonlyMap<string, string>): string {
  const hash = createHash('sha256')
  for (const name of [...files.keys()].sort())
    hash.update(name).update('\0').update(files.get(name)!).update('\0')
  return hash.digest('hex')
}

function pinProblem(files: ReadonlyMap<string, string>, pin: UiVersionPin): string | null {
  return uiHash(files) === pin.hash ? null : BUMP
}

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
}

class MiniText extends MiniNode {
  constructor(public nodeValue: string) {
    super(TEXT, '#text')
  }
}

class MiniElement extends MiniNode {
  childNodes: MiniNode[] = []
  readonly attrs = new Map<string, string>()
  readonly listeners = new Map<string, ((event: { target: MiniElement }) => void)[]>()
  readonly style = { setProperty: (): void => {} }
  readonly classList = {
    add: (name: string): void => this.setAttribute('class', [...this.classes().filter(each => each !== name), name].join(' ')),
    remove: (name: string): void => this.setAttribute('class', this.classes().filter(each => each !== name).join(' ')),
  }

  open = false
  onload: (() => void) | null = null

  constructor(tag: string) {
    super(ELEMENT, tag.toUpperCase())
  }

  get content(): MiniElement | undefined {
    return this.nodeName === 'TEMPLATE' ? this : undefined
  }

  get attributes(): { name: string, value: string }[] {
    return [...this.attrs].map(([name, value]) => ({ name, value }))
  }

  get dataset(): Record<string, string> {
    return Object.fromEntries([...this.attrs].filter(([name]) => name.startsWith('data-')).map(([name, value]) => [name.slice('data-'.length).replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase()), value]))
  }

  get firstChild(): MiniNode | null {
    return this.childNodes[0] ?? null
  }

  get innerHTML(): string {
    return ''
  }

  set innerHTML(markup: string) {
    this.childNodes = []
    parseInto(this, markup)
  }

  classes(): string[] {
    return (this.getAttribute('class') ?? '').split(' ').filter(each => each !== '')
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

  closest(selector: string): MiniElement | null {
    const attribute = /^\[([\w-]+)\]$/.exec(selector)?.[1]
    if (attribute !== undefined && this.hasAttribute(attribute))
      return this
    return this.parentNode?.closest(selector) ?? null
  }

  addEventListener(name: string, listener: (event: { target: MiniElement }) => void): void {
    this.listeners.set(name, [...this.listeners.get(name) ?? [], listener])
  }

  removeEventListener(name: string, listener: (event: { target: MiniElement }) => void): void {
    this.listeners.set(name, (this.listeners.get(name) ?? []).filter(each => each !== listener))
  }

  fire(name: string): void {
    for (const listener of this.listeners.get(name) ?? [])
      listener({ target: this })
  }
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
    if (selfClosing === '')
      open.push(element)
  }
}

function servicesHtml(sessions: readonly string[]): string {
  return `<div class="svc-wrap" data-svc-wrap><div class="svc-grid">${sessions.map(session => `<div class="svc bevel" data-svc="${session}">${session}</div>`).join('')}</div></div>`
}

const WARNINGS = [{ level: 'red' as const, text: 'main is red' }, { level: 'amber' as const, text: 'saving is off' }]

interface Reading {
  sessions: string[]
  minutes: number
}

interface Board {
  root: MiniElement
  storage: Map<string, string>
  deliver: (reading: Reading) => void
  click: (target: MiniElement) => void
  card: (session: string) => MiniElement | undefined
}

function board(first: Reading | null, stored: Record<string, unknown> = {}): Board {
  const root = new MiniElement('body')
  root.innerHTML = `<div id="slot-services">${first === null ? '' : servicesHtml(first.sessions)}</div><div id="slot-warnings">${first === null ? '' : warningsSlot(WARNINGS)}</div><dialog id="drill"></dialog><div id="drill-content"></div>`
  const timeouts: (() => void)[] = []
  const appended: MiniElement[] = []
  const clicks: ((event: { target: MiniElement }) => void)[] = []
  const storage = new Map([[NAMES.viewKey, JSON.stringify(stored)]])
  const document = {
    title: '',
    body: { dataset: { written: first === null ? '' : WRITTEN, tickMs: String(TICK_MS) } },
    head: { appendChild: (child: MiniElement) => appended.push(child) },
    getElementById: (id: string) => root.descendants().find(node => node.getAttribute('id') === id) ?? null,
    createElement: (tag: string) => new MiniElement(tag),
    querySelector: (selector: string) => root.querySelector(selector),
    querySelectorAll: (selector: string) => root.querySelectorAll(selector),
    addEventListener: (name: string, listener: (event: { target: MiniElement }) => void) => name === 'click' && clicks.push(listener),
  }
  const context: Record<string, unknown> = {
    BOARD_NAMES: NAMES,
    document,
    localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    location: { hash: '' },
    addEventListener: () => {},
    setTimeout: (callback: () => void) => timeouts.push(callback),
    Date: { now: () => Date.parse(WRITTEN), parse: Date.parse },
  }
  context.window = context
  vm.createContext(context)
  vm.runInContext(SCRIPT, context)
  let loaded = 0
  const deliver = (reading: Reading): void => {
    if (appended.length === loaded)
      timeouts.at(-1)!()
    const written = new Date(Date.parse(WRITTEN) + reading.minutes * MINUTE_MS).toISOString()
    context.BOARD = { written, tickMs: TICK_MS, slots: { services: servicesHtml(reading.sessions), warnings: warningsSlot(WARNINGS) }, filters: [] }
    loaded = appended.length
    appended.at(-1)!.onload!()
  }
  const click = (target: MiniElement): void => clicks.forEach(listener => listener({ target }))
  const card = (session: string): MiniElement | undefined => root.descendants().find(node => node.getAttribute('data-svc') === session)
  return { root, storage, deliver, click, card }
}

function reducedMotionBlock(): string {
  return STYLE.slice(STYLE.indexOf('@media (prefers-reduced-motion: reduce)'))
}

function busCard(id: number, stage: BusCard['stage'], line: string): BusCard {
  return { id, state: 'queued', stage, lane: null, line, since: WRITTEN, body: true, closed: false, closedAt: null }
}

describe('board ui v4', () => {
  it('the ui-version pin fails on a changed board file with an unchanged version', () => {
    const pin = readUiVersionPin()
    const files = boardUiFiles()
    expect(files.has(STYLE_FILE)).toBe(true)
    expect(files.has('scripts/cli/board-page.ts')).toBe(true)
    expect([...files.keys()].some(name => name.endsWith('ui-version.json'))).toBe(false)
    expect(pin.version).toBeGreaterThanOrEqual(FIRST_UI_VERSION)
    expect(uiHash(files), BUMP).toBe(pin.hash)
    expect(pinProblem(files, pin)).toBeNull()
    const changed = new Map(files).set(STYLE_FILE, `${files.get(STYLE_FILE)}\n.unbumped { color: var(--text); }\n`)
    expect(pinProblem(changed, pin)).toBe(BUMP)
    expect(pinProblem(changed, { version: pin.version + 1, hash: uiHash(changed) })).toBeNull()
  })

  it('the header reads the board ui version from ui-version.json', () => {
    const page = { version: '9.8.7', modelVersion: 3, tickMs: null, machine: { load: 1, cores: 2 }, liveness: 'live', facts: { at: WRITTEN, cards: [] } } as unknown as BoardPage
    const kv = headerReadings(page)
    expect(kv).toContain(`<span>ui <b>v${readUiVersionPin().version}</b></span>`)
    expect(JSON.parse(readFileSync(UI_VERSION_FILE, 'utf8'))).toEqual({ version: readUiVersionPin().version, hash: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(kv).not.toContain('9.8.7')
  })

  it('the warnings block renders a button with aria-expanded and the warning count', () => {
    const slot = warningsSlot(WARNINGS)
    expect(slot).toContain(`<button type="button" class="lbl" data-warnings-toggle aria-expanded="true">warnings<span class="warning-count">${WARNINGS.length}</span></button>`)
    expect(warningsSlot([])).toBe('')
    expect(STYLE).toContain('.warning-strip:has(> .lbl[aria-expanded="false"]) {')
    expect(STYLE).toMatch(/\.warning-strip:has\(> \.lbl\[aria-expanded="false"\]\)::before \{[^}]*conic-gradient\(from var\(--a\), var\(--signal\), var\(--amber\), var\(--signal\)\)[^}]*animation: --animation-warnings-glow /)
    expect(reducedMotionBlock()).toContain('.warning-strip:has(> .lbl[aria-expanded="false"])::before')
    const { root, storage, deliver, click } = board({ sessions: [], minutes: 0 })
    const toggle = (): MiniElement => root.querySelector('[data-warnings-toggle]')!
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    click(toggle())
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(JSON.parse(storage.get(NAMES.viewKey)!)).toMatchObject({ warningsCollapsed: true })
    deliver({ sessions: [], minutes: 1 })
    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    click(toggle())
    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    const remembered = board({ sessions: [], minutes: 0 }, { warningsCollapsed: true })
    expect(remembered.root.querySelector('[data-warnings-toggle]')!.getAttribute('aria-expanded')).toBe('false')
  })

  it('service cards carry the enter and leave hooks and style.css defines their animations and the reduced-motion rule', () => {
    const { root, deliver, card } = board({ sessions: ['s1', 's2'], minutes: 0 })
    const leaving = card('s1')!
    deliver({ sessions: ['s2', 's3'], minutes: 1 })
    expect(card('s3')!.classes()).toContain('enter')
    expect(card('s2')!.classes()).not.toContain('enter')
    expect(leaving.classes()).toContain('leave')
    expect(leaving.parentNode).toBe(root.querySelector('[data-svc-wrap]')!.childNodes[0])
    leaving.fire('animationend')
    expect(card('s1')).toBeUndefined()
    card('s3')!.fire('animationend')
    expect(card('s3')!.classes()).not.toContain('enter')
    const shell = board(null)
    shell.deliver({ sessions: ['s1'], minutes: 1 })
    expect(shell.card('s1')!.classes()).not.toContain('enter')
    shell.deliver({ sessions: ['s1', 's2'], minutes: 2 })
    expect(shell.card('s2')!.classes()).toContain('enter')
    for (const name of ['--animation-svc-in', '--animation-svc-out', '--animation-svc-noise'])
      expect(STYLE).toContain(`@keyframes ${name} {`)
    expect(STYLE).toContain('.svc.enter { animation: --animation-svc-in 0.65s steps(7, end) both; }')
    expect(STYLE).toContain('.svc.leave { pointer-events: none; animation: --animation-svc-out 0.6s steps(7, end) both; }')
    expect(STYLE).toContain('oklch(from var(--text) l c h / 0.14) 0 1px')
    expect(STYLE).toContain('oklch(from var(--wire) l c h / 0.1) 0 2px')
    expect(STYLE).not.toMatch(/rgba\(/)
    expect(STYLE).toContain('.svc-wrap { overflow: clip; transition: height 0.42s cubic-bezier(0.2, 0.8, 0.2, 1); }')
    expect(reducedMotionBlock()).toContain('.svc.enter, .svc.leave, .svc.enter::before, .svc.leave::before')
    expect(reducedMotionBlock()).toContain('.svc-wrap { transition: none; }')
  })

  it('a daemon with a SKILL.md description renders it in its pane', () => {
    const described = daemonOf('lab', '---\nname: lab\ndaemon: LAB\ndescription: drives a headed browser for checks\n---\n')!
    const bare = daemonOf('kit', '---\nname: kit\ndaemon: KIT\n---\n')!
    expect([described.description, bare.description]).toEqual(['drives a headed browser for checks', null])
    const grants = { allow: new Set<string>(), excluded: new Set<string>() }
    const cell = daemonsCell({ daemons: installedDaemons([described, bare], [], grants), reader: 'reader', loadedIn: 'heartbeat' }, LORE)
    expect(cell).toContain('<span class="pane-description">drives a headed browser for checks</span>')
    expect(cell).toContain(`<span class="pane-description" data-none>${PLAIN_LORE.boardDaemonPane.noDescription}</span>`)
    expect([LORE.boardDaemonPane.noDescription, PLAIN_LORE.boardDaemonPane.noDescription]).toEqual(['no description', 'no description'])
  })

  it('the depends and state cells carry the capped-width wrapping class', () => {
    const dependencies = Array.from({ length: DEPENDENCIES }, (_, at) => 7000 + at)
    const line = `card: #7100 many-dependencies [implement/construct/S/cheap/auto] · depends ${dependencies.map(id => `#${id}`).join(', ')} · blocks —`
    const waiting = busCard(7100, 'planned', line)
    const cards = [waiting, ...dependencies.map(id => busCard(id, 'planned', `card: #${id} dependency [implement/construct/S/cheap/auto] · depends — · blocks —`))]
    const facts = { at: WRITTEN, cards, waits: [] } as unknown as BusFacts
    const row = cardRowOf(facts, { releases: new Map(), held: new Map() })(waiting)
    expect(row).toContain(`<td><span class="${CAPPED_CLASS}">${dependencies.map(id => `<span>#${id}</span>`).join('')}</span></td>`)
    expect(row).toContain(`<td><span class="${CAPPED_CLASS}"><span class="st" data-stage="planned">planned</span><span class="why">`)
    expect(row).toContain('blocked by #7000, #7001')
    const capped = /\n\.capped \{[^\n]*\}/.exec(STYLE)![0]
    expect(capped).toContain('display: flex; flex-wrap: wrap;')
    expect(capped).toContain('max-inline-size: 28ch;')
  })
})
