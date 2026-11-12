import type { SeedEvent } from '../../../tests/board/bus-fixture.js'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import vm from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'
import { LORE, PLAIN_LORE } from '../../../src/ui/lore.js'
import { writeBus } from '../../../tests/board/bus-fixture.js'
import { printBoard, VIEW_KEY } from '../../cli/board-page.js'
import { SESSION_HEARTBEAT, WINDOW_HEARTBEAT } from '../../core/events.js'

const NOW = new Date('2026-10-20T08:00:00.000Z')
const CARD = 861
const SESSION = 's-one'
const AGENT_SPEND = 1_000_000
const WARN_RATIO = 0.8
const CARD_TEXT = [
  `card: #${CARD} second [implement/netwatch/S/cheap/owner] · depends — · blocks —`,
  'branch: feat/second',
  'touches: scripts/cli/board-page.ts',
  'continue: stop',
  'who: shift',
  '',
  'The card.',
].join('\n')

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function minutesAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString()
}

function beat(minutes: number, session: string, step: string, fields: object = {}, card: number = CARD): SeedEvent {
  return { ts: minutesAgo(minutes), type: SESSION_HEARTBEAT, card, payload: JSON.stringify({ step, session, ...fields }) }
}

const CONTEXT_LIMIT = 1_000_000

function reading(name: string, spent: number, context = 50_000): object {
  return { name, context, spent, at: minutesAgo(2) }
}

function pageOf(events: SeedEvent[], roles: { role: string, status: string, state: string }[] = []): string {
  const root = mkdtempSync(path.join(tmpdir(), 'board-one-session-'))
  roots.push(root)
  const busPath = path.join(root, 'bus.db')
  writeBus(busPath, { cards: [{ id: CARD, state: 'running', lane: 'lane-1', line: `#${CARD} second`, since: minutesAgo(20), text: CARD_TEXT }], roles, events })
  const db = new DatabaseSync(busPath)
  db.exec('ALTER TABLE card_bodies ADD COLUMN admission_event_id INTEGER; ALTER TABLE card_bodies ADD COLUMN text_sha TEXT NOT NULL DEFAULT \'\'')
  db.exec('UPDATE card_bodies SET admission_event_id = (SELECT event_id FROM cards WHERE cards.card_id = card_bodies.card_id)')
  db.close()
  const eddiesFile = path.join(root, 'eddies.json')
  writeFileSync(eddiesFile, JSON.stringify({ contextLimit: CONTEXT_LIMIT, cardContextLine: 900_000, sessionSpend: 10_000_000, agentSpend: AGENT_SPEND, warnRatio: WARN_RATIO }))
  let html = ''
  expect(printBoard(busPath, NOW, (text) => {
    html += text
  }, path.join(root, 'miko.md'), 'html', eddiesFile)).toBe(0)
  return html
}

function tilesOf(html: string, role: string): string[] {
  return [...html.matchAll(new RegExp(`<div class="svc bevel" data-role="${role}"[\\s\\S]*?(?=<div class="svc bevel" |</section>)`, 'g'))].map(match => match[0])
}

function agentsCount(html: string): number {
  return Number(/agents at work <b>(\d+)<\/b>/.exec(html)![1])
}

function lineOf(tile: string): string {
  return /<button [^>]*data-agents="[^>]*>/.exec(tile)![0]
}

function heatOf(tag: string): 'over' | 'hot' | 'calm' {
  if (/\sdata-over[\s>]/.test(tag))
    return 'over'
  return /\sdata-hot[\s>]/.test(tag) ? 'hot' : 'calm'
}

function heatUnder(spent: number, context: number): { line: string, row: string } {
  const tile = tilesOf(pageOf([beat(1, SESSION, 'launch', { subagents: [reading('calm', 1), reading('implementer', spent, context)] })]), 'launch')[0]!
  const rows = [...tile.matchAll(/<li[^>]*>/g)].map(match => match[0])
  expect(heatOf(rows[0]!)).toBe('calm')
  return { line: heatOf(lineOf(tile)), row: heatOf(rows[1]!) }
}

interface FakeEvent {
  target: FakeNode
  key?: string
  prevented?: boolean
  preventDefault?: () => void
}

type Listener = (event: FakeEvent) => void

const DATASET_OF_SELECTOR: Record<string, string> = { '[data-open]': 'open', '[data-agents]': 'agents', '[data-agents-list]': 'agentsList' }

class FakeNode {
  readonly dataset: Record<string, string> = {}
  readonly attributes = new Map<string, string>()
  readonly listeners = new Map<string, Listener[]>()
  innerHTML = ''
  scrollTop = 0
  open = false

  constructor(readonly tagName: string, readonly parent: FakeNode | null = null, dataset: Record<string, string> = {}) {
    Object.assign(this.dataset, dataset)
  }

  closest(selector: string): FakeNode | null {
    return this.dataset[DATASET_OF_SELECTOR[selector]!] !== undefined ? this : this.parent?.closest(selector) ?? null
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...this.listeners.get(type) ?? [], listener])
  }

  dispatch(type: string, event: FakeEvent): void {
    for (const listener of this.listeners.get(type) ?? [])
      listener(event)
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

function pageWindow(html: string, storage: MemoryStorage) {
  const tile = new FakeNode('DIV', null, { open: /data-open="(card-\d+)"/.exec(tilesOf(html, 'launch')[0]!)![1]! })
  const line = new FakeNode('BUTTON', tile, { agents: /data-agents="([^"]*)"/.exec(html)![1]! })
  const list = new FakeNode('UL', tile, { agentsList: '' })
  const elements = new Map<string, FakeNode>()
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]!))
  const element = (id: string): FakeNode | null => {
    if (!ids.has(id))
      return null
    const found = elements.get(id) ?? new FakeNode(id === 'drill' ? 'DIALOG' : 'DIV')
    elements.set(id, found)
    return found
  }
  const body = /<body data-written="([^"]*)" data-tick-ms="([^"]*)">/.exec(html)!
  const document = Object.assign(new FakeNode('DOCUMENT'), {
    body: { dataset: { written: body[1]!, tickMs: body[2]! } },
    getElementById: element,
    querySelectorAll: () => [line],
  })
  const context: Record<string, unknown> = {
    document,
    location: { hash: '' },
    localStorage: storage,
    addEventListener: () => {},
    setTimeout: () => {},
  }
  context.window = context
  vm.createContext(context)
  vm.runInContext(/<script>([\s\S]*?)<\/script>/.exec(html)![1]!, context)
  return {
    tile,
    line,
    list,
    expanded: () => line.attributes.get('aria-expanded'),
    cardOpened: () => element('drill')!.open,
    closeCard: () => element('drill')!.close(),
    click: (target: FakeNode) => document.dispatch('click', { target }),
    press: (target: FakeNode, key: string): boolean => {
      let prevented = false
      document.dispatch('keydown', { target, key, preventDefault: () => {
        prevented = true
      } })
      return prevented
    },
  }
}

function storedAgents(storage: MemoryStorage): Record<string, boolean> {
  return (JSON.parse(storage.getItem(VIEW_KEY)!) as { agents: Record<string, boolean> }).agents
}

describe('the subagents of the window', () => {
  it('the subagents of the window are the count of its tile and draw no tiles of their own', () => {
    const html = pageOf([
      { ts: minutesAgo(1), type: WINDOW_HEARTBEAT, card: null, payload: JSON.stringify({ session: 'w-1', context: 100_000, subagents: [reading('scan', 40_000), reading('review', 60_000)] }) },
    ], [{ role: 'miko', status: 'idle', state: 'awake' }])
    const tiles = tilesOf(html, 'window')
    expect(tiles).toHaveLength(1)
    expect(tiles[0]).toContain(PLAIN_LORE.boardAgentsLine(2, '60k', '1M'))
    expect(tilesOf(html, 'scan')).toEqual([])
    expect(agentsCount(html)).toBe(1)
  })
})

describe('the subagent line of a session tile', () => {
  it('a session with three subagents draws one tile with the count 3 and the largest spend', () => {
    const html = pageOf([beat(1, SESSION, 'launch', { subagents: [reading('implementer', 100_000), reading('scan', 500_000), reading('review', 300_000)] })])
    const tiles = tilesOf(html, 'launch')
    expect(tiles).toHaveLength(1)
    expect(tiles[0]).toContain(PLAIN_LORE.boardAgentsLine(3, '500k', '1M'))
  })

  it('both lore pairs read CRAWLERS for the agents line and pulse for the agent pulse', () => {
    for (const lore of [LORE, PLAIN_LORE]) {
      expect(lore.boardAgentsLine(3, '500k', '1M')).toBe('CRAWLERS 3 · top spend 500k / 1M cap')
      expect(lore.boardAgentPulse(4)).toBe('pulse 4 min ago')
    }
  })

  it('the board agents line and agent rows carry no Cyrillic letter', () => {
    const tile = tilesOf(pageOf([beat(1, SESSION, 'launch', { subagents: [reading('implementer', 100_000), reading('scan', 500_000)] })]), 'launch')[0]!
    const agents = /<button [^>]*data-agents=[\s\S]*?<\/ul>/.exec(tile)![0]
    expect(agents).toContain('CRAWLERS 2')
    expect(agents).toContain('pulse 2 min ago')
    expect(agents).not.toMatch(/\p{Script=Cyrillic}/u)
  })

  it('the agents arrow is drawn from aria-expanded and turns by rotation', () => {
    const html = pageOf([beat(1, SESSION, 'launch', { subagents: [reading('scan', 100_000)] })])
    const line = /<button [^>]*data-agents="[^>]*>([^<]*)<\/button>/.exec(html)!
    expect(line[1]).not.toMatch(/[▸▾►▼]/)
    expect(html).toContain('&::before { content: "\\25B8"; display: inline-block; margin-inline-end: var(--space-xs); transition: transform 160ms ease-out; }')
    expect(html).toContain('&[aria-expanded="true"]::before { transform: rotate(90deg); }')
    expect(html).toContain('.svc .svc-agents::before { transition: none; }')
    expect(html.indexOf('.svc .svc-agents::before { transition: none; }')).toBeGreaterThan(html.indexOf('@media (prefers-reduced-motion: reduce)'))
    const page = pageWindow(html, new MemoryStorage())
    expect(page.expanded()).toBe('false')
    page.click(page.line)
    expect(page.expanded()).toBe('true')
  })

  it('agent context at the warn ratio is yellow and at the limit red on the row and the CRAWLERS line', () => {
    const warn = CONTEXT_LIMIT * WARN_RATIO
    expect(heatUnder(1, warn - 1)).toEqual({ line: 'calm', row: 'calm' })
    expect(heatUnder(1, warn)).toEqual({ line: 'hot', row: 'hot' })
    expect(heatUnder(1, CONTEXT_LIMIT - 1)).toEqual({ line: 'hot', row: 'hot' })
    expect(heatUnder(1, CONTEXT_LIMIT)).toEqual({ line: 'over', row: 'over' })
    expect(heatUnder(1, CONTEXT_LIMIT + 1)).toEqual({ line: 'over', row: 'over' })
  })

  it('agent spend at the warn ratio is yellow and at the limit red on the row and the CRAWLERS line', () => {
    const warn = AGENT_SPEND * WARN_RATIO
    expect(heatUnder(warn - 1, 1)).toEqual({ line: 'calm', row: 'calm' })
    expect(heatUnder(warn, 1)).toEqual({ line: 'hot', row: 'hot' })
    expect(heatUnder(AGENT_SPEND - 1, 1)).toEqual({ line: 'hot', row: 'hot' })
    expect(heatUnder(AGENT_SPEND, 1)).toEqual({ line: 'over', row: 'over' })
  })

  it('the board paints the agent row and the line yellow and red by the tile gauge colours', () => {
    const html = pageOf([beat(1, SESSION, 'launch', { subagents: [reading('scan', 100_000)] })])
    expect(html).toContain('&[data-hot] { --_fg: var(--amber); }')
    expect(html).toContain('&[data-over] { --_fg: var(--signal); }')
    expect(html).toContain('& li[data-hot] { color: var(--amber); }')
    expect(html).toContain('& li[data-over] { color: var(--signal); }')
  })

  it('the subagent dialog lists type or name CTX SPENT and pulse per subagent', () => {
    const html = pageOf([beat(1, SESSION, 'launch', { subagents: [reading('implementer', 100_000), reading('scan', 500_000)] })])
    const rows = [...tilesOf(html, 'launch')[0]!.matchAll(/<li>([\s\S]*?)<\/li>/g)].map(match => match[1]!.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim())
    expect(rows).toEqual([
      `implementer CTX 50k SPENT 100k ${PLAIN_LORE.boardAgentPulse(2)}`,
      `scan CTX 50k SPENT 500k ${PLAIN_LORE.boardAgentPulse(2)}`,
    ])
  })

  it('the subagent list expands in place collapsed by default and a session with no subagents has no line', () => {
    const html = pageOf([beat(1, SESSION, 'launch', { subagents: [reading('scan', 100_000)] })])
    const tile = tilesOf(html, 'launch')[0]!
    expect(lineOf(tile)).toContain('aria-expanded="false"')
    expect(tile).toMatch(/<\/button><ul class="svc-agent-list" data-agents-list>/)
    expect(html).toContain('&[aria-expanded="false"] + .svc-agent-list { display: none; }')
    expect(tilesOf(pageOf([beat(1, SESSION, 'launch', { context: 100_000 })]), 'launch')[0]).not.toContain('data-agents')
  })
})

describe('the page script of the subagent line', () => {
  const html = (): string => pageOf([beat(1, SESSION, 'launch', { subagents: [reading('scan', 100_000)] })])

  it('click Enter and Space on the subagent line expand it and do not open the card while a click on the tile still does', () => {
    const page = pageWindow(html(), new MemoryStorage())
    expect(page.expanded()).toBe('false')

    page.click(page.line)
    expect(page.expanded()).toBe('true')
    expect(page.cardOpened()).toBe(false)

    expect(page.press(page.line, 'Enter')).toBe(true)
    expect(page.expanded()).toBe('false')
    expect(page.cardOpened()).toBe(false)

    expect(page.press(page.line, ' ')).toBe(true)
    expect(page.expanded()).toBe('true')
    expect(page.cardOpened()).toBe(false)

    page.click(page.list)
    expect(page.cardOpened()).toBe(false)

    page.click(page.tile)
    expect(page.cardOpened()).toBe(true)
    page.closeCard()

    page.press(page.tile, 'Enter')
    expect(page.cardOpened()).toBe(true)
  })

  it('an expanded list stays expanded after the page reloads', () => {
    const storage = new MemoryStorage()
    const first = pageWindow(html(), storage)
    first.click(first.line)
    expect(storedAgents(storage)).toEqual({ [SESSION]: true })

    expect(pageWindow(html(), storage).expanded()).toBe('true')

    const gone = pageWindow(pageOf([beat(1, 's-another', 'launch', { subagents: [reading('scan', 100_000)] })]), storage)
    expect(gone.expanded()).toBe('false')
    expect(storedAgents(storage)).toEqual({})
  })
})
