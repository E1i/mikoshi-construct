import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const SCRIPT = readFileSync(path.resolve(import.meta.dirname, '../../cli/board-page/script.js'), 'utf8')
const STYLE = readFileSync(path.resolve(import.meta.dirname, '../../cli/board-page/style.css'), 'utf8')
const DAEMONS = ['LAB', 'KIT', 'EYE']
const PANE_RULE = /\.daemon-pane \{[\s\S]*?\n\}/
const SHOWN_RULE = '.daemon-slot[data-pop] > .daemon-pane { display: grid; }'

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
  const slots = DAEMONS.map(daemon => new Node({ daemonSlot: daemon }))
  const panes = slots.map(slot => Object.assign(new Node({ daemonPane: slot.dataset.daemonSlot! }), { parent: slot }))
  const card = Object.assign(new Node(), { parent: slots[1]! })
  const elsewhere = new Node()
  const document = {
    body: { dataset: { written: '2026-11-27T12:00:00.000Z', tickMs: '' } },
    getElementById: (id: string) => id === 'drill' ? Object.assign(new Node(), { open: false, close: () => {} }) : null,
    querySelector: () => null,
    querySelectorAll: (selector: string) => selector === '[data-daemon-slot]' ? slots : selector === '[data-daemon-pane]' ? panes : [],
    addEventListener: (type: string, listener: Listener) => listeners.set(type, [...listeners.get(type) ?? [], listener]),
  }
  const context: Record<string, unknown> = { BOARD_NAMES: { drill: 'drill', backlog: 'backlog', viewKey: 'view', round: {} }, document, localStorage: { getItem: () => null, setItem: () => {} }, location: { hash: '' }, addEventListener: () => {}, setTimeout: () => 0, Date }
  context.window = context
  vm.runInNewContext(SCRIPT, context)
  const fire = (type: string, event: Record<string, unknown>): void => listeners.get(type)!.forEach(listener => listener(event))
  const popped = (): string[] => slots.filter(slot => slot.hasAttribute('data-pop')).map(slot => slot.dataset.daemonSlot!)
  const shownPanes = (): string[] => STYLE.includes(SHOWN_RULE) ? popped() : []
  const tap = (target: Node, pointerType = 'touch'): void => {
    fire('pointerdown', { target, pointerType })
    fire('click', { target })
  }
  return { slots, panes, card, elsewhere, fire, popped, shownPanes, tap }
}

describe('the DAEMONS popover in the page', () => {
  it('three daemons render three cards and the description only in the popover of the focused card', () => {
    const pane = PANE_RULE.exec(STYLE)![0]
    expect(pane).toContain('display: none;')
    expect(pane).toContain('position: absolute;')
    expect(STYLE).toContain(SHOWN_RULE)

    const board = page()
    expect(board.shownPanes()).toEqual([])
    board.fire('focusin', { target: board.slots[2]! })
    expect(board.shownPanes()).toEqual(['EYE'])
    expect(board.panes.map(each => each.hasAttribute('data-shown'))).toEqual([false, false, false])
    board.fire('focusout', { target: board.slots[2]!, relatedTarget: null })
    expect(board.shownPanes()).toEqual([])
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
    expect(/\.daemon-slot \{[\s\S]*?\n\}/.exec(STYLE)![0]).toContain('position: relative;')
    expect(STYLE).toContain('.daemon-slots { display: flex; flex-wrap: wrap;')
    expect(STYLE).toContain('inline-size: 116px; block-size: 138px;')
  })
})
