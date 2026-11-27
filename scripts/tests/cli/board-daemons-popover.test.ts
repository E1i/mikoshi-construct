import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { LORE } from '../../../src/ui/lore.js'
import { daemonOf, installedDaemons } from '../../cli/board-page/daemon-catalog.js'
import { daemonsCell } from '../../cli/board-page/miko-panel.js'

const SCRIPT = readFileSync(path.resolve(import.meta.dirname, '../../cli/board-page/script.js'), 'utf8')
const STYLE = readFileSync(path.resolve(import.meta.dirname, '../../cli/board-page/style.css'), 'utf8')
const DAEMONS = [
  { skill: 'lab', daemon: 'LAB', description: 'drives a headed browser for checks' },
  { skill: 'kit', daemon: 'KIT', description: 'speaks MCP to the dev servers' },
  { skill: 'eye', daemon: 'EYE', description: 'reads the screenshots back' },
]
const PANE = /<div class="daemon-pane"[\s\S]*?<\/ul><\/div>/g

function threeDaemons(): string {
  const catalog = DAEMONS.map(each => daemonOf(each.skill, `---\nname: ${each.skill}\ndaemon: ${each.daemon}\ndescription: ${each.description}\n---\n`)!)
  return daemonsCell({ daemons: installedDaemons(catalog, ['kit'], { allow: new Set(), excluded: new Set() }), reader: 'reader', loadedIn: 'heartbeat' }, LORE)
}

function slotOf(html: string, daemon: string): string {
  return new RegExp(`<li class="daemon-slot" data-daemon-slot="${daemon}"[\\s\\S]*?</ul></div></li>`).exec(html)![0]
}

class Node {
  readonly dataset: Record<string, string>
  readonly attributes = new Set<string>()
  parent: Node | null = null

  constructor(dataset: Record<string, string> = {}) {
    this.dataset = { ...dataset }
  }

  setAttribute(name: string): void {
    this.attributes.add(name)
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name)
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name)
  }

  closest(selector: string): Node | null {
    if (selector === '[data-daemon-slot]' && 'daemonSlot' in this.dataset)
      return this
    return this.parent === null ? null : this.parent.closest(selector)
  }

  addEventListener(): void {}
}

type Listener = (event: Record<string, unknown>) => void

function page() {
  const listeners = new Map<string, Listener[]>()
  const slots = DAEMONS.map(each => new Node({ daemonSlot: each.daemon }))
  const card = Object.assign(new Node(), { parent: slots[1]! })
  const elsewhere = new Node()
  const document = {
    body: { dataset: { written: '2026-11-27T12:00:00.000Z', tickMs: '' } },
    getElementById: (id: string) => id === 'drill' ? Object.assign(new Node(), { open: false, close: () => {} }) : null,
    querySelector: () => null,
    querySelectorAll: (selector: string) => selector === '[data-daemon-slot]' ? slots : [],
    addEventListener: (type: string, listener: Listener) => listeners.set(type, [...listeners.get(type) ?? [], listener]),
  }
  const context: Record<string, unknown> = { BOARD_NAMES: { drill: 'drill', backlog: 'backlog', viewKey: 'view', round: {} }, document, localStorage: { getItem: () => null, setItem: () => {} }, location: { hash: '' }, addEventListener: () => {}, setTimeout: () => 0, Date }
  context.window = context
  vm.runInNewContext(SCRIPT, context)
  const fire = (type: string, event: Record<string, unknown>): void => listeners.get(type)!.forEach(listener => listener(event))
  const popped = (): string[] => slots.filter(slot => slot.hasAttribute('data-pop')).map(slot => slot.dataset.daemonSlot!)
  const tap = (target: Node, pointerType = 'touch'): void => {
    fire('pointerdown', { target, pointerType })
    fire('click', { target })
  }
  return { slots, card, elsewhere, fire, popped, tap }
}

describe('the DAEMONS tile with several daemons', () => {
  it('three daemons render three cards and the description only in the popover of the focused card', () => {
    const html = threeDaemons()
    expect(html.match(/<li class="daemon-slot"/g)).toHaveLength(3)
    expect(html.match(/<div class="sd-card">/g)).toHaveLength(3)
    expect(html).toContain('<span class="daemons-chip">INSTALLED · 3</span>')
    const outside = html.replace(PANE, '')
    for (const each of DAEMONS) {
      expect(outside).not.toContain(each.description)
      const slot = slotOf(html, each.daemon)
      expect(slot).toContain(`aria-describedby="daemon-pane-${each.daemon}"`)
      expect(slot).toContain(`<div class="daemon-pane" id="daemon-pane-${each.daemon}" role="tooltip"`)
      expect(slot).toContain(`<span class="pane-description">${each.description}</span>`)
      expect(html.split(each.description)).toHaveLength(2)
    }
    expect(slotOf(html, 'KIT')).toContain('<span class="pane-tag">LOADED</span>')
    expect(slotOf(html, 'LAB')).toContain('<span class="pane-tag">SLEEPING</span>')
    expect(html).not.toContain('daemon-status')
    expect(html).not.toContain('data-pop')

    const board = page()
    expect(board.popped()).toEqual([])
    board.fire('focusin', { target: board.slots[2]! })
    expect(board.popped()).toEqual(['EYE'])
    expect(slotOf(html, board.popped()[0]!)).toContain(DAEMONS[2]!.description)
    board.fire('focusout', { target: board.slots[2]!, relatedTarget: null })
    expect(board.popped()).toEqual([])
  })

  it('hover opens the popover of the card under the pointer and leaving the cards closes it', () => {
    const board = page()
    board.fire('mouseover', { target: board.card })
    expect(board.popped()).toEqual(['KIT'])
    board.fire('mouseover', { target: board.slots[0]! })
    expect(board.popped()).toEqual(['LAB'])
    board.fire('mouseover', { target: board.elsewhere })
    expect(board.popped()).toEqual([])
  })

  it('escape closes an open popover, and a focus on another card moves it there', () => {
    const board = page()
    board.fire('focusin', { target: board.slots[0]! })
    board.fire('focusin', { target: board.slots[1]! })
    expect(board.popped()).toEqual(['KIT'])
    board.fire('keydown', { key: 'Escape', target: board.slots[1]! })
    expect(board.popped()).toEqual([])
  })

  it('a tap toggles the popover on touch, and a tap elsewhere closes it', () => {
    const board = page()
    board.tap(board.card)
    expect(board.popped()).toEqual(['KIT'])
    board.tap(board.card)
    expect(board.popped()).toEqual([])
    board.tap(board.slots[2]!)
    expect(board.popped()).toEqual(['EYE'])
    board.tap(board.elsewhere)
    expect(board.popped()).toEqual([])
    board.tap(board.slots[0]!, 'mouse')
    board.tap(board.slots[0]!, 'mouse')
    expect(board.popped()).toEqual(['LAB'])
  })

  it('the popover floats over the tile and never resizes it, and the cards wrap to rows of one size', () => {
    const pane = /\.daemon-pane \{[\s\S]*?\n\}/.exec(STYLE)![0]
    expect(pane).toContain('position: absolute;')
    expect(pane).toContain('display: none;')
    expect(STYLE).toContain('.daemon-slot[data-pop] > .daemon-pane { display: grid; }')
    expect(/\.daemon-slot \{[\s\S]*?\n\}/.exec(STYLE)![0]).toContain('position: relative;')
    expect(STYLE).toContain('.daemon-slots { display: flex; flex-wrap: wrap;')
    expect(STYLE).toContain('inline-size: 116px; block-size: 138px;')
  })
})
