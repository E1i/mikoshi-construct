import type { MikoBay, MikoPanelParts } from '../../cli/board-page/miko-panel.js'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'
import { LORE, PLAIN_LORE } from '../../../src/ui/lore.js'
import { DAEMON_READER, daemonCatalog, daemonOf, installedDaemons, LOADED_SOURCE, manifestFields } from '../../cli/board-page/daemon-catalog.js'
import { ATTACH_RECORD, mikoBay, mikoMode, mikoPanel } from '../../cli/board-page/miko-panel.js'

const SCRIPT = readFileSync(path.resolve(import.meta.dirname, '../../cli/board-page/script.js'), 'utf8')
const STYLE = readFileSync(path.resolve(import.meta.dirname, '../../cli/board-page/style.css'), 'utf8')
const PRESENCE = { model: null, core: null, status: null, handoffBytes: null, skills: [], crawlers: [] }
const PANEL: MikoPanelParts = { windows: [], bars: () => '', presence: PRESENCE, now: '2026-11-18T12:00:00.000Z', words: { role: 'FIXER', name: 'MIKO', plainTitle: '' }, opener: '', hint: '', idle: null }
const MANIFESTS: Readonly<Record<string, string>> = {
  'browser-lab': '---\nname: browser-lab\ndaemon: BROWSER_LAB\ndaemon-sketch: hex-iris\ndaemon-mutations: ver_headed, ver_hands\n---\n\nbody\n',
  'mcp-devkit': '---\nname: mcp-devkit\ndaemon: MCP_DEVKIT\ndaemon-sketch: adapter-chip\ndaemon-mutations: [ver_stdio]\n---\n',
  'intake': '---\nname: intake\ndescription: not a daemon\n---\n',
}
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function repository(attached = false): string {
  const root = mkdtempSync(path.join(tmpdir(), 'board-miko-daemons-'))
  roots.push(root)
  for (const [skill, text] of Object.entries(MANIFESTS)) {
    mkdirSync(path.join(root, '.claude/skills', skill), { recursive: true })
    writeFileSync(path.join(root, '.claude/skills', skill, 'SKILL.md'), text)
  }
  if (attached) {
    mkdirSync(path.join(root, '.construct'), { recursive: true })
    writeFileSync(path.join(root, ATTACH_RECORD), '{}')
  }
  return root
}

function bayOf(root: string, loaded: readonly string[]): MikoBay {
  return mikoBay(root, loaded, LORE)
}

function panelOf(root: string, loaded: readonly string[] = ['mcp-devkit', 'intake']): string {
  return mikoPanel({ ...PANEL, bay: bayOf(root, loaded) })
}

function slotOf(html: string, daemon: string): string {
  return new RegExp(`<li class="daemon-slot" data-daemon-slot="${daemon}"[\\s\\S]*?</li>`).exec(html)![0]
}

function paneOf(html: string, daemon: string): string {
  return new RegExp(`<div class="daemon-pane" data-daemon-pane="${daemon}"[\\s\\S]*?</ul></div>`).exec(html)![0]
}

function cssValue(name: string): string {
  return new RegExp(`\\s${name}:\\s*([^;]+);`).exec(STYLE)![1]!.trim()
}

describe('the daemons cell', () => {
  it('one LOADED and one SLEEP daemon from the catalog render two SD cards, two LEDs, two slots and no empty one', () => {
    const html = panelOf(repository())
    expect(html).toContain('<div class="daemons-head">INSTALLED · 2</div>')
    expect(html.match(/<li class="daemon-slot"/g)).toHaveLength(2)
    expect(html.match(/<i class="slot-led"><\/i>/g)).toHaveLength(2)
    expect(html).toContain('SLOT 01')
    expect(html).toContain('SLOT 02')
    expect(html).not.toContain('SLOT 03')
    expect(slotOf(html, 'BROWSER_LAB')).toContain('data-state="sleep"')
    expect(slotOf(html, 'MCP_DEVKIT')).toContain('data-state="loaded"')
    expect(slotOf(html, 'BROWSER_LAB')).toContain('<g class="sd-sketch" data-sketch="hex-iris"><polygon')
    expect(slotOf(html, 'MCP_DEVKIT')).toContain('<g class="sd-sketch" data-sketch="adapter-chip"><rect')
    expect(slotOf(html, 'MCP_DEVKIT')).toContain('<span class="sd-name">MCP_DEVKIT</span>')
    expect(html).not.toContain('intake')
  })

  it('the frame, the sketch and the LED take the loaded colours, and a sleeping card rides 20 px out of its slot', () => {
    expect([cssValue('--daemon-on'), cssValue('--daemon-off'), cssValue('--daemon-ink'), cssValue('--daemon-ink-off'), cssValue('--led-on')]).toEqual(['#5ce1e6', '#5d6b88', '#e8eefb', '#7f8aa3', '#7ee2a8'])
    const slot = /\.daemon-slot \{[\s\S]*?\n\}/.exec(STYLE)![0]
    expect(slot).toContain('--_ink: var(--daemon-ink);')
    expect(slot).toContain('--_sketch: var(--daemon-on);')
    expect(slot).toContain('--_led: var(--led-on);')
    expect(slot).toContain('&[data-state="sleep"] { --_ink: var(--daemon-ink-off); --_sketch: var(--daemon-off); --_led: var(--daemon-off); --_ride: -20px; }')
    expect(STYLE).toContain('.sd-card { position: relative; display: grid; inline-size: 4rem; color: var(--_ink); translate: 0 var(--_ride);')
    expect(STYLE).toContain('.sd-frame { fill: var(--panel-raised); stroke: currentColor;')
    expect(STYLE).toContain('.sd-sketch { fill: none; stroke: var(--_sketch);')
  })

  it('with no hover the status pane shows the first LOADED daemon with its tag and its mutations', () => {
    const html = panelOf(repository())
    expect(paneOf(html, 'MCP_DEVKIT')).toContain('data-default data-shown')
    expect(paneOf(html, 'BROWSER_LAB')).not.toContain('data-shown')
    expect(paneOf(html, 'MCP_DEVKIT')).toContain('<span class="pane-tag">LOADED</span><span class="pane-head">MUTATIONS · 1</span><ul class="pane-mutations"><li>ver_stdio</li></ul>')
    expect(paneOf(html, 'BROWSER_LAB')).toContain('<span class="pane-tag">SLEEPING</span><span class="pane-head">MUTATIONS · 2</span><ul class="pane-mutations"><li>ver_headed</li><li>ver_hands</li></ul>')
  })

  it('an empty catalog names the reader it adds and where LOADED is observed', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'board-miko-empty-'))
    roots.push(root)
    const html = mikoPanel({ ...PANEL, bay: bayOf(root, []) })
    expect(html).toContain('INSTALLED · 0')
    expect(html).toContain(`no daemon in the catalog yet · ${DAEMON_READER} reads it · LOADED is observed in ${LOADED_SOURCE}`)
    expect(html).not.toContain('daemon-slot')
  })
})

class StubNode {
  readonly dataset: Record<string, string>
  readonly attributes = new Map<string, string>()
  parent: StubNode | null = null

  constructor(dataset: Record<string, string> = {}, attributes: readonly string[] = []) {
    this.dataset = { ...dataset }
    for (const name of attributes)
      this.attributes.set(name, '')
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name)
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name)
  }

  closest(selector: string): StubNode | null {
    if (selector === '[data-daemon-slot]' && 'daemonSlot' in this.dataset)
      return this
    return this.parent === null ? null : this.parent.closest(selector)
  }

  addEventListener(): void {}
}

function hoverPage() {
  const listeners = new Map<string, ((event: { target: StubNode }) => void)[]>()
  const slots = ['BROWSER_LAB', 'MCP_DEVKIT'].map(daemon => new StubNode({ daemonSlot: daemon }))
  const card = Object.assign(new StubNode(), { parent: slots[0]! })
  const panes = [new StubNode({ daemonPane: 'BROWSER_LAB' }), new StubNode({ daemonPane: 'MCP_DEVKIT' }, ['data-default', 'data-shown'])]
  const document = {
    body: { dataset: { written: '2026-11-18T12:00:00.000Z', tickMs: '' } },
    getElementById: (id: string) => id === 'drill' ? new StubNode() : null,
    querySelector: () => null,
    querySelectorAll: (selector: string) => selector === '[data-daemon-pane]' ? panes : [],
    addEventListener: (type: string, listener: (event: { target: StubNode }) => void) => listeners.set(type, [...listeners.get(type) ?? [], listener]),
  }
  const context: Record<string, unknown> = { BOARD_NAMES: { drill: 'drill', backlog: 'backlog', viewKey: 'view', round: {} }, document, localStorage: { getItem: () => null, setItem: () => {} }, location: { hash: '' }, addEventListener: () => {}, setTimeout: () => 0, Date }
  context.window = context
  vm.runInNewContext(SCRIPT, context)
  const shown = (): string[] => panes.filter(pane => pane.hasAttribute('data-shown')).map(pane => pane.dataset.daemonPane!)
  const over = (target: StubNode): void => listeners.get('mouseover')!.forEach(listener => listener({ target }))
  return { card, slots, shown, over }
}

describe('the status pane on hover', () => {
  it('hover over a card switches the pane to that daemon, and leaving the cards brings back the first LOADED one', () => {
    const page = hoverPage()
    expect(page.shown()).toEqual(['MCP_DEVKIT'])
    page.over(page.card)
    expect(page.shown()).toEqual(['BROWSER_LAB'])
    page.over(page.slots[1]!)
    expect(page.shown()).toEqual(['MCP_DEVKIT'])
    page.over(new StubNode())
    expect(page.shown()).toEqual(['MCP_DEVKIT'])
    page.over(page.slots[0]!)
    page.over(new StubNode())
    expect(page.shown()).toEqual(['MCP_DEVKIT'])
  })
})

describe('the mode', () => {
  it('hIJACK draws the red chip and reads breached <path>, with a red left edge', () => {
    const root = repository(true)
    const html = panelOf(root)
    expect(html).toContain('data-mode="hijack" data-strip>')
    expect(html).toContain(`<div class="svc-line miko-where"><span class="mode-chip">HIJACK</span><span>breached ${root}</span></div>`)
    expect(cssValue('--hijack')).toBe('#ff4d6d')
    expect(STYLE).toContain('.svc[data-role="window"][data-mode="hijack"] { --_accent: var(--hijack); }')
    expect(STYLE).toContain('.mode-chip { padding: 0 0.35rem; background: var(--hijack); color: var(--void);')
  })

  it('iNIT draws no chip and reads own repo <path>, with a cyan left edge', () => {
    const root = repository()
    const html = panelOf(root)
    expect(html).toContain('data-mode="init" data-strip>')
    expect(html).toContain(`<div class="svc-line miko-where"><span>own repo ${root}</span></div>`)
    expect(html).not.toContain('mode-chip')
    expect(html).not.toContain('breached')
    expect(STYLE).toContain('.svc[data-role="window"][data-mode="init"] { --_accent: var(--wire); }')
  })

  it('the mode is HIJACK exactly when the repository holds the attach record', () => {
    expect(mikoMode('/r', file => file === path.join('/r', ATTACH_RECORD))).toEqual({ hijacked: true, path: '/r' })
    expect(mikoMode('/r', () => false)).toEqual({ hijacked: false, path: '/r' })
  })

  it('the plain twin names the same mode without the lore', () => {
    expect(PLAIN_LORE.boardMikoChip).toBe('ATTACHED')
    expect(PLAIN_LORE.boardMikoWhere(true, '/r')).toBe('attached to /r')
    expect(PLAIN_LORE.boardMikoWhere(false, '/r')).toBe(LORE.boardMikoWhere(false, '/r'))
  })
})

describe('the daemon catalog reader', () => {
  it('reads the daemon, its sketch and only its ver_* mutations from the skill manifest frontmatter', () => {
    expect(manifestFields('---\na: 1\nb:\n---\nc: 3\n')).toEqual(new Map([['a', '1'], ['b', '']]))
    expect(daemonOf('lab', '---\ndaemon: LAB\ndaemon-mutations: ver_a, other, ver_b\n---\n')).toEqual({ daemon: 'LAB', skill: 'lab', sketch: null, mutations: ['ver_a', 'ver_b'] })
    expect(daemonOf('intake', MANIFESTS.intake!)).toBeNull()
    expect(daemonOf('x', 'no frontmatter')).toBeNull()
  })

  it('lists daemons by skill directory and marks LOADED only the skills of the current session', () => {
    const daemons = installedDaemons(daemonCatalog(repository()), ['browser-lab'])
    expect(daemons.map(daemon => [daemon.daemon, daemon.loaded])).toEqual([['BROWSER_LAB', true], ['MCP_DEVKIT', false]])
    expect(daemonCatalog(path.join(tmpdir(), 'no-such-repository-for-daemons'))).toEqual([])
  })
})
