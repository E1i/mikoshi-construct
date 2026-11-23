import type { DaemonEntry, WindowGrants } from '../../cli/board-page/daemon-catalog.js'
import type { MikoBay, MikoPanelParts } from '../../cli/board-page/miko-panel.js'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'
import { allowRule, declaredCommands, frontmatterFields } from '../../../src/commands/attach/daemon-commands.js'
import { PROJECT_SETTINGS_FILE, SETTINGS_FILE } from '../../../src/commands/attach/settings.js'
import { LORE, PLAIN_LORE } from '../../../src/ui/lore.js'
import { ADAPTER_MANIFEST, adapterMutations, ADAPTERS_DIR, DAEMON_READER, daemonCatalog, daemonOf, installedDaemons, LOADED_SOURCE, manifestFields, windowGrants } from '../../cli/board-page/daemon-catalog.js'
import { ATTACH_RECORD, homeShort, mikoBay, mikoMode, mikoPanel } from '../../cli/board-page/miko-panel.js'

const SCRIPT = readFileSync(path.resolve(import.meta.dirname, '../../cli/board-page/script.js'), 'utf8')
const STYLE = readFileSync(path.resolve(import.meta.dirname, '../../cli/board-page/style.css'), 'utf8')
const PRESENCE = { model: null, core: null, status: null, handoffBytes: null, skills: [], crawlers: [] }
const PANEL: MikoPanelParts = { windows: [], bars: () => '', presence: PRESENCE, now: '2026-11-18T12:00:00.000Z', words: { role: 'FIXER', name: 'MIKO', plainTitle: '' }, opener: '', hint: '', idle: null }
const MANIFESTS: Readonly<Record<string, string>> = {
  'browser-lab': '---\nname: browser-lab\ndaemon: BROWSER_LAB\ndaemon-sketch: hex-iris\n---\n\nbody\n',
  'mcp-devkit': '---\nname: mcp-devkit\ndaemon: MCP_DEVKIT\ndaemon-sketch: adapter-chip\n---\n',
  'intake': '---\nname: intake\ndescription: not a daemon\n---\n',
}
const ADAPTERS = ['headed', 'hands']
const NOT_AN_ADAPTER = 'scratch'
const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../../..')
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
  for (const adapter of ADAPTERS) {
    mkdirSync(path.join(root, ADAPTERS_DIR, adapter), { recursive: true })
    writeFileSync(path.join(root, ADAPTERS_DIR, adapter, ADAPTER_MANIFEST), '{}')
  }
  mkdirSync(path.join(root, ADAPTERS_DIR, NOT_AN_ADAPTER), { recursive: true })
  if (attached) {
    mkdirSync(path.join(root, '.construct'), { recursive: true })
    writeFileSync(path.join(root, ATTACH_RECORD), '{}')
  }
  return root
}

function grantingAll(catalog: readonly DaemonEntry[]): WindowGrants {
  const commands = catalog.flatMap(entry => entry.commands)
  return { allow: new Set(commands.map(allowRule)), excluded: new Set(commands) }
}

function bayOf(root: string, loaded: readonly string[]): MikoBay {
  return mikoBay(root, loaded, LORE, existsSync, '', grantingAll(daemonCatalog(root, undefined, '')))
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
    expect(html).toContain('<div class="daemons-head"><span class="daemons-title">DAEMONS</span><span class="daemons-chip">INSTALLED · 2</span></div>')
    expect(html.match(/<li class="daemon-slot"/g)).toHaveLength(2)
    expect(html.match(/<i class="slot-led"><\/i>/g)).toHaveLength(2)
    expect(html).toContain('SLOT 01')
    expect(html).toContain('SLOT 02')
    expect(html).not.toContain('SLOT 03')
    expect(slotOf(html, 'BROWSER_LAB')).toContain('data-state="sleep"')
    expect(slotOf(html, 'MCP_DEVKIT')).toContain('data-state="loaded"')
    expect(slotOf(html, 'BROWSER_LAB')).toContain('<g class="sd-sketch" data-sketch="hex-iris"><path class="sd-eye"')
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
    expect(slot).toContain('&[data-state="sleep"] { --_ink: var(--daemon-ink-off); --_sketch: var(--daemon-off); --_face: #0f1525; --_led: var(--daemon-off); --_ride: -20px; --_lit: 0.75; --_glow: none; }')
    expect(STYLE).toContain('background: var(--_ink); color: var(--_ink); clip-path: var(--_notch); opacity: var(--_lit); translate: 0 var(--_ride);')
    expect(STYLE).toContain('.sd-face { display: flex; flex-direction: column; align-items: center; gap: 6px; box-sizing: border-box; block-size: 122px; padding: 8px; background: var(--_face);')
    expect(STYLE).toContain('.sd-sketch { fill: none; stroke: var(--_sketch);')
  })

  it('with no hover the status pane shows the first LOADED daemon with its tag and its mutations', () => {
    const html = panelOf(repository())
    expect(paneOf(html, 'MCP_DEVKIT')).toContain('data-default data-shown')
    expect(paneOf(html, 'BROWSER_LAB')).not.toContain('data-shown')
    expect(paneOf(html, 'MCP_DEVKIT')).toContain('<span class="pane-tag">LOADED</span><span class="pane-head">MUTATIONS · 0</span><ul class="pane-mutations"></ul>')
    expect(paneOf(html, 'BROWSER_LAB')).toContain('<span class="pane-tag">SLEEPING</span><span class="pane-head">MUTATIONS · 2</span><ul class="pane-mutations"><li>ver_hands</li><li>ver_headed</li></ul>')
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

const MONO_ADVANCE_EM = 0.6
const SD_FACE_INNER_PX = 104 - 2 * 1.5 - 2 * 8

function pixels(rule: string, property: string): number {
  return Number(new RegExp(`\\.${rule} \\{[^}]*?[\\s{]${property}: (-?[\\d.]+)px`).exec(STYLE)![1])
}

describe('the DAEMONS cell as the design draws it', () => {
  it('matches the Daemons7 design', () => {
    const home = path.dirname(REPOSITORY_ROOT)
    const html = mikoPanel({ ...PANEL, bay: mikoBay(REPOSITORY_ROOT, [], LORE, () => false, home, grantingAll(daemonCatalog(REPOSITORY_ROOT, undefined, home))) })
    const self = html.indexOf('<div class="miko-self">')
    const crawlers = html.indexOf('<div class="miko-crawlers"')
    const daemons = html.indexOf('<div class="miko-daemons bevel">')
    expect([self >= 0, crawlers > self, daemons > crawlers]).toEqual([true, true, true])
    expect(STYLE).toContain('&[data-strip] { grid-template-columns: minmax(12rem, 1fr) minmax(12rem, 0.85fr) minmax(0, 1.25fr);')

    expect(html).toContain('<div class="miko-daemons bevel"><div class="daemons-head"><span class="daemons-title">DAEMONS</span><span class="daemons-chip">INSTALLED · 1</span></div>')
    expect([LORE.boardDaemonsHead.title, PLAIN_LORE.boardDaemonsHead.title]).toEqual(['DAEMONS', 'DAEMONS'])
    expect(STYLE).toContain('.miko-daemons { --cut: 10px; --_frame: #232c40; --_surface: #0f1525;')
    expect(STYLE).toContain('.daemons-head { display: flex; justify-content: space-between;')

    expect(STYLE).toContain('--_ride: -20px; --_lit: 0.75; --_glow: none; }')
    expect(STYLE).toContain('--_ride: 0px;\n  --_lit: 1;')
    const bayInner = pixels('slot-bay', 'block-size') - 2 - pixels('slot-bay', 'padding-block-end')
    const card = pixels('sd-face', 'block-size') + 2 * 1.5
    expect(bayInner - card).toBeLessThan(20)
    expect(bayInner - card).toBeGreaterThanOrEqual(0)

    const chars = Number(/<ol class="daemon-slots" style="--_chars: (\d+)">/.exec(html)![1])
    expect(chars).toBe('BROWSER_LAB'.length)
    const font = /\.sd-name \{[^}]*font: 700 min\((\d+)px, calc\((\d+)px \/ \(var\(--_chars, \d+\) \* ([\d.]+)\)\)\) var\(--font-mono\); letter-spacing: ([\d.]+)em;/.exec(STYLE)!
    const [cap, room, perChar, spacing] = font.slice(1).map(Number) as [number, number, number, number]
    const size = Math.min(cap, room / (chars * perChar))
    expect(perChar).toBeGreaterThanOrEqual(MONO_ADVANCE_EM + spacing)
    expect(chars * (MONO_ADVANCE_EM + spacing) * size).toBeLessThanOrEqual(SD_FACE_INNER_PX)
    expect(STYLE).toContain('white-space: nowrap;')

    const sketch = /<g class="sd-sketch" data-sketch="hex-iris">([\s\S]*?)<\/g>/.exec(html)![1]!
    expect(sketch).toContain('<path class="sd-eye" d="M7 32 L15 24 H33 L41 32 L33 40 H15 Z"/>')
    expect(sketch).toContain('<polygon class="sd-fill"')
    expect(sketch).toContain('<circle class="sd-pupil"')
    expect(/<path class="sd-bracket" d="([^"]+)"/.exec(sketch)![1]!.match(/M/g)).toHaveLength(4)

    expect(html).toContain(`<span>own repo ~/${path.basename(REPOSITORY_ROOT)}</span>`)
    expect([homeShort('/h/u/r', '/h/u'), homeShort('/h/u', '/h/u'), homeShort('/h/user/r', '/h/u'), homeShort('/r', '')]).toEqual(['~/r', '~', '/h/user/r', '/r'])
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

describe('a daemon the window cannot run', () => {
  const LAB_COMMAND = 'node <home>/.construct/browser-lab/bin/browser-lab.mjs *'

  function declaringRepository(): { root: string, home: string, command: string } {
    const root = repository()
    const home = mkdtempSync(path.join(tmpdir(), 'board-miko-home-'))
    roots.push(home)
    writeFileSync(path.join(root, '.claude/skills/browser-lab/SKILL.md'), MANIFESTS['browser-lab']!.replace('daemon-sketch: hex-iris\n', `daemon-sketch: hex-iris\ndaemon-command: ${LAB_COMMAND}\n`))
    return { root, home, command: LAB_COMMAND.replace('<home>', home) }
  }

  function grantIn(file: string, settings: unknown): void {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(settings))
  }

  function panelIn(root: string, home: string): string {
    return mikoPanel({ ...PANEL, bay: mikoBay(root, ['browser-lab', 'mcp-devkit'], LORE, existsSync, home) })
  }

  it('a daemon whose command the window settings miss shows as not installed', () => {
    const { root, home, command } = declaringRepository()
    const missing = panelIn(root, home)
    expect(missing).toContain('<span class="daemons-chip">INSTALLED · 1</span>')
    expect(slotOf(missing, 'BROWSER_LAB')).toContain('data-state="sleep" data-installed="false"')
    expect(paneOf(missing, 'BROWSER_LAB')).toContain('<span class="pane-tag">SLEEPING</span>')
    expect(paneOf(missing, 'MCP_DEVKIT')).toContain('data-default data-shown')
    grantIn(path.join(root, SETTINGS_FILE), { sandbox: { excludedCommands: [command] } })
    expect(panelIn(root, home)).toContain('INSTALLED · 1')
    grantIn(path.join(root, SETTINGS_FILE), { permissions: { allow: [allowRule(command)] }, sandbox: { excludedCommands: [command] } })
    const granted = panelIn(root, home)
    expect(granted).toContain('<span class="daemons-chip">INSTALLED · 2</span>')
    expect(slotOf(granted, 'BROWSER_LAB')).not.toContain('data-installed')
    expect(paneOf(granted, 'BROWSER_LAB')).toContain('<span class="pane-tag">LOADED</span>')
  })

  it('the window grant may come from the user settings, and a grant made for another home does not count', () => {
    const { root, home, command } = declaringRepository()
    grantIn(path.join(home, PROJECT_SETTINGS_FILE), { permissions: { allow: [allowRule(command)] }, sandbox: { excludedCommands: [command] } })
    expect(panelIn(root, home)).toContain('INSTALLED · 2')
    expect(panelIn(root, path.join(home, 'elsewhere'))).toContain('INSTALLED · 1')
  })
})

describe('the daemon catalog reader', () => {
  it('reads the daemon and its sketch from the skill manifest frontmatter, and no mutation from it', () => {
    expect(manifestFields('---\na: 1\nb:\n---\nc: 3\n')).toEqual(new Map([['a', '1'], ['b', '']]))
    expect(daemonOf('lab', '---\ndaemon: LAB\ndaemon-mutations: ver_a, ver_b\n---\n')).toEqual({ daemon: 'LAB', skill: 'lab', sketch: null, mutations: [], commands: [] })
    expect(daemonOf('lab', '---\ndaemon: LAB\ndaemon-command: node <home>/lab.mjs *\n---\n', '/h')?.commands).toEqual(['node /h/lab.mjs *'])
    expect(daemonOf('intake', MANIFESTS.intake!)).toBeNull()
    expect(daemonOf('x', 'no frontmatter')).toBeNull()
  })

  it('every adapter directory holding an adapter.json is a ver_<name> mutation of BROWSER_LAB, and of no other daemon', () => {
    const root = repository()
    expect(adapterMutations(root)).toEqual(['ver_hands', 'ver_headed'])
    expect(daemonCatalog(root).map(entry => [entry.daemon, entry.mutations])).toEqual([['BROWSER_LAB', ['ver_hands', 'ver_headed']], ['MCP_DEVKIT', []]])
  })

  it('the real repository catalogs BROWSER_LAB', () => {
    const catalog = daemonCatalog(REPOSITORY_ROOT)
    expect(catalog.map(entry => [entry.daemon, entry.skill, entry.sketch])).toEqual([['BROWSER_LAB', 'browser-lab', 'hex-iris']])
    expect(catalog[0]!.mutations).toEqual(adapterMutations(REPOSITORY_ROOT))
    expect(mikoPanel({ ...PANEL, bay: bayOf(REPOSITORY_ROOT, []) })).toContain('<span class="daemons-chip">INSTALLED · 1</span>')
  })

  it('the real repository renders BROWSER_LAB as the design draws it: an SD card in a recessed bay, a LED under it, a divided status pane', () => {
    const html = mikoPanel({ ...PANEL, bay: bayOf(REPOSITORY_ROOT, ['browser-lab']) })
    const slot = slotOf(html, 'BROWSER_LAB')
    expect(slot).toContain('<span class="slot-bay"><div class="sd-card">')
    expect(slot).toContain('<g class="sd-sketch" data-sketch="hex-iris"><path class="sd-eye"')
    expect(slot).toContain('<span class="slot-foot"><i class="slot-led"></i>SLOT 01</span>')
    expect(paneOf(html, 'BROWSER_LAB')).toContain('data-default data-shown')
    expect(paneOf(html, 'BROWSER_LAB')).toContain('<span class="pane-tag">LOADED</span>')
    expect(STYLE).toContain('.slot-bay { position: relative; display: flex; justify-content: center; align-items: end; box-sizing: border-box; inline-size: 116px; block-size: 138px; padding-block-end: 6px; background: #080c16; border: 1px solid #232c40;')
    expect(STYLE).toContain('.daemon-slot:hover .slot-bay, .daemon-slot:focus-visible .slot-bay { border-color: var(--daemon-on); }')
    expect(STYLE).toContain('--_glow: 0 0 6px var(--_led);')
    expect(STYLE).toContain('--_ride: -20px; --_lit: 0.75; --_glow: none; }')
    expect(STYLE).toContain('box-shadow: var(--_glow); }')
    expect(STYLE).toContain('.daemon-status { display: grid; min-inline-size: 8rem; padding-inline-start: 14px; border-inline-start: 1px solid var(--line); }')
    expect(STYLE).toContain('.pane-mutations li::before { content: \'↳ \'; }')
  })

  it('the board reads a daemon manifest through the same frontmatter parser the install grants from', () => {
    const text = '---\r\nname: lab\r\ndaemon: LAB\r\ndaemon-command: node <home>/a.mjs *\r\ndaemon-command: node <home>/b.mjs *\r\n---\r\n'
    expect(manifestFields(text)).toEqual(new Map(frontmatterFields(text)))
    expect(daemonOf('lab', text, '/h')?.commands).toEqual(declaredCommands(text, '/h'))
    expect(declaredCommands(text, '/h')).toEqual(['node /h/a.mjs *', 'node /h/b.mjs *'])
  })

  it('lists daemons by skill directory and marks LOADED only the skills of the current session', () => {
    const root = repository()
    const daemons = installedDaemons(daemonCatalog(root), ['browser-lab'], windowGrants(root, ''))
    expect(daemons.map(daemon => [daemon.daemon, daemon.loaded])).toEqual([['BROWSER_LAB', true], ['MCP_DEVKIT', false]])
    expect(daemonCatalog(path.join(tmpdir(), 'no-such-repository-for-daemons'))).toEqual([])
  })
})
