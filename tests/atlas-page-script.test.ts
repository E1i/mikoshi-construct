import type { AtlasMechanics } from '../src/atlas/view.js'
import { tmpdir } from 'node:os'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { renderAtlas } from '../src/atlas/page.js'
import { parseModel } from '../src/model/schema.js'
import { deriveModelState } from '../src/model/state.js'

type Listener = (event: FakeEvent) => void

class FakeEvent {
  target: FakeElement | null = null
  constructor(readonly type: string, readonly init: { bubbles?: boolean } = {}) {}
  get bubbles(): boolean {
    return this.init.bubbles === true
  }

  preventDefault(): void {}
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"' }

class FakeElement {
  readonly attributes = new Map<string, string>()
  readonly listeners = new Map<string, Listener[]>()
  children: FakeElement[] = []
  hidden = false
  value = ''
  private html = ''

  constructor(readonly parent: FakeElement | null = null) {}

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name)
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...this.listeners.get(type) ?? [], listener])
  }

  set innerHTML(html: string) {
    this.html = html
    this.children = [...html.matchAll(/<(?:g|button)\s([^>]*)>/g)].map((match) => {
      const element = new FakeElement(this)
      for (const [, name, value] of match[1]!.matchAll(/([\w-]+)="([^"]*)"/g))
        element.setAttribute(name!, value!.replaceAll(/&(?:amp|lt|gt|quot);/g, entity => ENTITIES[entity]!))
      return element
    })
  }

  get innerHTML(): string {
    return this.html
  }

  querySelectorAll(selector: string): FakeElement[] {
    const name = /^\[([\w-]+)\]$/.exec(selector)![1]!
    return this.children.filter(child => child.attributes.has(name))
  }

  closest(selector: string): FakeElement | null {
    const names = selector.split(',').map(part => /\[([\w-]+)\]/.exec(part)![1]!)
    return names.some(name => this.attributes.has(name)) ? this : null
  }

  dispatchEvent(event: FakeEvent): boolean {
    event.target ??= this
    this.listeners.get(event.type)?.forEach(listener => listener(event))
    if (event.bubbles)
      this.parent?.dispatchEvent(event)
    return true
  }

  getBoundingClientRect(): { left: number, top: number, width: number, height: number } {
    return { left: 0, top: 0, width: 1200, height: 800 }
  }

  getBBox(): { width: number, height: number } {
    return { width: 900, height: 600 }
  }
}

interface Run {
  page: Record<string, FakeElement>
  delivered: string[]
}

const IDS = ['atlas-svg', 'atlas-viewport', 'atlas-panel', 'atlas-tip', 'atlas-search', 'atlas-results']

function run(script: string, hash: string): Run {
  const page = Object.fromEntries(IDS.map(id => [id, new FakeElement()])) as Record<string, FakeElement>
  const viewport = page['atlas-viewport']!
  const delivered: string[] = []
  const register = viewport.addEventListener.bind(viewport)
  viewport.addEventListener = (type, listener) => register(type, type === 'click'
    ? (event) => {
        delivered.push(event.target?.getAttribute('data-file') ?? event.target?.getAttribute('data-node') ?? '')
        listener(event)
      }
    : listener)
  const context = {
    document: { getElementById: (id: string) => page[id] },
    window: new FakeElement(),
    location: { hash },
    MouseEvent: FakeEvent,
  }
  vm.runInNewContext(script, context)
  return { page, delivered }
}

function click(target: Run, attribute: string, value: string): void {
  const element = target.page['atlas-viewport']!.querySelectorAll(`[${attribute}]`).find(candidate => candidate.getAttribute(attribute) === value)
  expect(element, `${attribute}=${value} is drawn`).toBeDefined()
  element!.dispatchEvent(new FakeEvent('click', { bubbles: true }))
}

const DOCUMENT = { modelVersion: 6, facts: [], claims: [], hypotheses: [], stages: [], nodes: [], links: [] }

const FILES = ['packages/app/src/main.ts', 'packages/core/src/index.ts', 'packages/core/src/price.ts', 'packages/core/src/tax.ts']

const MECHANICS: AtlasMechanics = {
  contours: [
    { id: '.', name: 'shop', kind: 'package', declaredBy: 'package.json', entries: [] },
    { id: 'packages/core', name: '@shop/core', kind: 'workspace', declaredBy: 'packages/core/package.json', entries: ['packages/core/src/index.ts'] },
  ],
  components: FILES.map(file => ({ id: file, path: file, relations: 'found' as const })),
  relations: [
    { from: 'packages/app/src/main.ts', to: 'packages/core/src/price.ts', kind: 'imports', specifier: '../../core/src/price.js', status: 'found', source: { path: 'packages/app/src/main.ts', line: 2 } },
    { from: 'packages/core/src/price.ts', to: 'packages/core/src/tax.ts', kind: 'imports', specifier: './tax.js', status: 'found', source: { path: 'packages/core/src/price.ts', line: 1 } },
  ],
}

function pageOf(interpretation?: unknown): string {
  const model = parseModel(JSON.stringify(interpretation == null ? DOCUMENT : { ...DOCUMENT, interpretation }), 'M')
  return renderAtlas({ projectName: 'shop', model, states: deriveModelState(model, tmpdir()), mechanics: MECHANICS }, 'construct.model.json')
}

function scriptOf(html: string): string {
  return /<script>([\s\S]*?)<\/script>/.exec(html)![1]!
}

const TARGET = 'packages/core/src/price.ts'

describe('the page script reaches a file by the same handler a reader\'s click runs', () => {
  it('a click on a file and a navigation to its hash run the same handler', () => {
    const script = scriptOf(pageOf())
    const navigated = run(script, `#${TARGET}`)
    expect(navigated.delivered.at(-1)).toBe(TARGET)

    const clicked = run(script, '')
    expect(clicked.page['atlas-panel']!.getAttribute('data-file')).toBeNull()
    const steps = navigated.delivered
    for (const step of steps)
      click(clicked, step === TARGET ? 'data-file' : 'data-node', step)
    expect(clicked.delivered).toEqual(steps)

    for (const reached of [navigated, clicked]) {
      const panel = reached.page['atlas-panel']!
      expect(panel.getAttribute('data-file')).toBe(TARGET)
      expect(panel.innerHTML).toContain('data-at="packages/app/src/main.ts:2"')
      expect(panel.innerHTML).toContain('data-at="packages/core/src/price.ts:1"')
    }
    expect(navigated.page['atlas-panel']!.innerHTML).toBe(clicked.page['atlas-panel']!.innerHTML)
  })

  it('reaches no file and draws no panel for a hash that names none', () => {
    const navigated = run(scriptOf(pageOf()), '#no/such/file.ts')
    expect(navigated.delivered).toEqual([])
    expect(navigated.page['atlas-panel']!.getAttribute('data-file')).toBeNull()
  })

  it('finds a file by name and opens it through the same handler', () => {
    const searched = run(scriptOf(pageOf()), '')
    const search = searched.page['atlas-search']!
    search.value = 'price'
    search.dispatchEvent(new FakeEvent('input'))
    const results = searched.page['atlas-results']!
    expect(results.children.map(child => child.getAttribute('data-reveal'))).toEqual([TARGET])
    results.children[0]!.dispatchEvent(new FakeEvent('click', { bubbles: true }))
    expect(searched.delivered.at(-1)).toBe(TARGET)
    expect(searched.page['atlas-panel']!.getAttribute('data-file')).toBe(TARGET)
  })
})

describe('the data the script carries', () => {
  it('keeps a hostile name and purpose inside the one data block', () => {
    const html = pageOf({ authoredBy: 'discovery', components: [{ id: 'x', contour: 'packages/core', name: '</script><script>alert(1)</script>', purpose: `<!-- ${String.fromCharCode(0x2028)} & </SCRIPT>`, files: ['packages/core/src/tax.ts'] }] })
    expect(html.match(/<script/gi)).toHaveLength(1)
    expect(html.match(/<\/script/gi)).toHaveLength(1)
    const navigated = run(scriptOf(html), '#packages/core/src/tax.ts')
    expect(navigated.page['atlas-panel']!.getAttribute('data-file')).toBe('packages/core/src/tax.ts')
  })
})
