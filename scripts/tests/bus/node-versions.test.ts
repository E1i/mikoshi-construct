import type { DatabaseSync } from 'node:sqlite'
import type { Factory } from '../../contract/factory.js'
import type { Lease } from '../../core/lease.js'
import type { NodeDeclaration, NodeStep } from '../../core/node.js'
import type { QueuedTask } from '../../core/queue.js'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NODE_DECLARATIONS, nodesSection } from '../../contract/factory/nodes.js'
import { BUS_VERSION, BUS_VERSION_BEFORE_LADDER_RUN, BUS_VERSION_RECORD, busVersionOf, CARD_VERSION, CARD_VERSION_BEFORE_TOUCH_SCOPE, CARD_VERSION_KEY, cardVersionIn, stampBusVersion, UNRECORDED_VERSION } from '../../core/bus-version.js'
import { admittedCardVersion, appendCardEvent } from '../../core/card-bodies.js'
import { appendEvent, openBus } from '../../core/db.js'
import { FACTORY_WORKERS } from '../../core/factory-paths.js'
import { completeTask } from '../../core/lease.js'
import { foreignVersion, Node, runNode, SWITCH_FLAG, UNDERSTOOD_NOW } from '../../core/node.js'
import { queueTaskWithin } from '../../core/queue.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { Clock } from './github-fake.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const A_NODE_CLASS = /\bextends Node</
const FOREIGN = 9
const CARD = 4242
const OTHER_CARD = 4243

const roots: string[] = []

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function busPath(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-node-versions-'))
  roots.push(root)
  return path.join(root, 'bus.db')
}

const DECLARATION: NodeDeclaration = { kind: 'review', on: ['probe.seen'], understands: UNDERSTOOD_NOW }

class DeclaredNode extends Node<NodeStep> {
  handled: string[] = []

  constructor(db: DatabaseSync, clock: Clock, private readonly found: QueuedTask[] = []) {
    super('review', { silentMs: SILENT_MS, db, clock: clock.now, session: 'versions', mode: 'live', env: {} })
    this.declare(DECLARATION)
  }

  protected candidates(): QueuedTask[] {
    return this.found
  }

  protected handle(lease: Lease): NodeStep {
    this.handled.push(lease.taskKey)
    completeTask(this.db, new Date().toISOString(), lease, [])
    return { kind: 'done', taskKey: lease.taskKey }
  }
}

const SIBLING_IMPORT = /from '\.\/([\w-]+)\.js'/g

function holdsANode(file: string): boolean {
  return A_NODE_CLASS.test(readFileSync(file, 'utf8'))
}

function nodeFileOf(entry: string): string[] {
  if (holdsANode(entry))
    return [entry]
  return [...readFileSync(entry, 'utf8').matchAll(SIBLING_IMPORT)]
    .map(match => path.join(path.dirname(entry), `${match[1]}.ts`))
    .filter(holdsANode)
}

function workerFiles(): string[] {
  return [...new Set(Object.values(FACTORY_WORKERS).flatMap(file => nodeFileOf(path.join(REPO_ROOT, file))))].sort()
}

function isDeclaration(value: unknown): value is NodeDeclaration {
  return value != null && typeof value === 'object' && 'kind' in value && 'on' in value && 'understands' in value
}

function storeCard(db: DatabaseSync, card: number, payload: Record<string, unknown>): void {
  appendEvent(db, { ts: new Date().toISOString(), type: 'probe.admitted', actor: 'owner', cardId: card, pr: null, head: null, dedupeKey: `probe.admitted:${card}`, payload, legacy: false })
  const admission = Number((db.prepare('SELECT MAX(id) AS id FROM events').get() as { id: number }).id)
  db.prepare('INSERT INTO card_bodies (card_id, admission_event_id, text, text_sha) VALUES (?, ?, ?, ?)').run(card, admission, '# card\n', 'sha')
}

function eventsOf(db: DatabaseSync, type: string): { card_id: number, payload: string }[] {
  return db.prepare('SELECT card_id, payload FROM events WHERE type = ? ORDER BY id').all(type) as { card_id: number, payload: string }[]
}

async function runOnce(node: Node<NodeStep>): Promise<void> {
  const controller = new AbortController()
  await node.run({ pause: async () => controller.abort(), signal: controller.signal })
}

describe('the node versions', () => {
  it('every node declares its subscription and the versions it understands', async () => {
    const files = workerFiles()
    const recorded = (JSON.parse(readFileSync(path.join(REPO_ROOT, 'contract', 'factory.json'), 'utf8')) as Factory).nodes

    expect(files.length).toBe(NODE_DECLARATIONS.length)
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      const declarations = Object.values(await import(pathToFileURL(file).href) as Record<string, unknown>).filter(isDeclaration)

      expect(text, file).toContain('this.declare(')
      expect(text, file).not.toContain('this.subscribe(')
      expect(declarations, file).toHaveLength(1)
      const [declaration] = declarations

      expect(NODE_DECLARATIONS, file).toContain(declaration)
      expect(declaration!.on.length, file).toBeGreaterThan(0)
      expect(declaration!.understands.bus, file).toEqual(expect.arrayContaining([UNRECORDED_VERSION, BUS_VERSION]))
      expect(declaration!.understands.card, file).toContain(CARD_VERSION)
      expect(recorded.declared[declaration!.kind], file).toEqual(nodesSection([declaration!]).declared[declaration!.kind])
    }
    expect(recorded).toEqual(JSON.parse(JSON.stringify(nodesSection())))
  })

  it('a node refuses a foreign card or bus version', async () => {
    const foreignBus = busPath()
    const stamped = openBus(foreignBus)
    stampBusVersion(stamped, FOREIGN)
    stamped.close()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const build = (db: DatabaseSync): Node<NodeStep> => new DeclaredNode(db, new Clock())

    expect(await runNode([SWITCH_FLAG], 'review', foreignBus, build, { pause: async () => {}, codeSha: () => null })).toBe(1)
    expect(error).toHaveBeenCalledWith(expect.stringContaining(`stopped on a foreign version: the bus carries bus version ${FOREIGN}`))

    const db = openBus(busPath())
    const clock = new Clock()
    const foreign: QueuedTask = { queue: 'review', cardId: CARD }
    const known: QueuedTask = { queue: 'review', cardId: OTHER_CARD }
    storeCard(db, CARD, { [CARD_VERSION_KEY]: FOREIGN })
    storeCard(db, OTHER_CARD, {})
    queueTaskWithin(db, clock.now().toISOString(), foreign)
    queueTaskWithin(db, clock.now().toISOString(), known)
    const node = new DeclaredNode(db, clock, [foreign, known])

    await runOnce(node)
    await runOnce(node)

    expect(node.handled).toHaveLength(1)
    expect(node.handled[0]).toContain(String(OTHER_CARD))
    const failed = eventsOf(db, 'task.failed').filter(row => row.card_id === CARD)
    expect(failed).toHaveLength(1)
    expect(JSON.parse(failed[0]!.payload)).toMatchObject({ next: 'withdrawn', reason: expect.stringContaining(`card version ${FOREIGN}`) as unknown })
    expect(db.prepare('SELECT state FROM tasks WHERE card_id = ?').get(CARD)).not.toEqual({ state: 'leased' })
    const stopped = eventsOf(db, 'card.stopped')
    expect(stopped.map(row => row.card_id)).toEqual([CARD])
    expect(JSON.parse(stopped[0]!.payload)).toMatchObject({ reason: 'fault', detail: expect.stringContaining(`card #${CARD}`) as unknown })
    db.close()
  })

  it('a bus and a card that carry no version read as version 1, a node of this build works on them and stamps the bus', async () => {
    const db = openBus(busPath())
    const clock = new Clock()
    const task: QueuedTask = { queue: 'review', cardId: CARD }
    storeCard(db, CARD, {})
    queueTaskWithin(db, clock.now().toISOString(), task)
    const node = new DeclaredNode(db, clock, [task])

    expect(busVersionOf(db)).toBe(UNRECORDED_VERSION)
    expect(admittedCardVersion(db, CARD)).toBe(UNRECORDED_VERSION)
    expect(admittedCardVersion(db, OTHER_CARD)).toBeNull()
    await runOnce(node)
    expect(node.handled).toHaveLength(1)
    expect(node.declared()).toBe(DECLARATION)
    expect(busVersionOf(db)).toBe(BUS_VERSION)
    db.close()
  })

  it('a bus stamped before ladder.run keeps its stamp and a node of this build still takes its work', async () => {
    const db = openBus(busPath())
    const clock = new Clock()
    const task: QueuedTask = { queue: 'review', cardId: CARD }
    stampBusVersion(db, BUS_VERSION_BEFORE_LADDER_RUN)
    storeCard(db, CARD, {})
    queueTaskWithin(db, clock.now().toISOString(), task)
    const node = new DeclaredNode(db, clock, [task])

    expect(UNDERSTOOD_NOW.bus).toEqual([UNRECORDED_VERSION, BUS_VERSION_BEFORE_LADDER_RUN, BUS_VERSION])
    await runOnce(node)
    expect(node.handled).toHaveLength(1)
    expect(busVersionOf(db)).toBe(BUS_VERSION_BEFORE_LADDER_RUN)
    db.close()
  })

  it('a card admitted at card version 1 is read by a node of this build without a new admission, and a new admission carries version 2', async () => {
    const db = openBus(busPath())
    const clock = new Clock()
    const task: QueuedTask = { queue: 'review', cardId: CARD }
    storeCard(db, CARD, { [CARD_VERSION_KEY]: CARD_VERSION_BEFORE_TOUCH_SCOPE })
    queueTaskWithin(db, clock.now().toISOString(), task)
    const node = new DeclaredNode(db, clock, [task])

    expect(UNDERSTOOD_NOW.card).toEqual([CARD_VERSION_BEFORE_TOUCH_SCOPE, CARD_VERSION])
    expect(CARD_VERSION).toBe(CARD_VERSION_BEFORE_TOUCH_SCOPE + 1)
    await runOnce(node)
    expect(node.handled).toHaveLength(1)
    expect(admittedCardVersion(db, CARD)).toBe(CARD_VERSION_BEFORE_TOUCH_SCOPE)
    expect(eventsOf(db, 'card.admitted')).toEqual([])
    appendCardEvent(db, 'owner', { type: 'card.admitted', cardId: OTHER_CARD, ts: clock.now().toISOString(), dedupeKey: `card.admitted:${OTHER_CARD}`, payload: { text: '# card\n' } })
    expect(cardVersionIn(eventsOf(db, 'card.admitted')[0]!.payload)).toBe(CARD_VERSION)
    db.close()
  })

  it('an admitted card body carries the card version this build writes', () => {
    const db = openBus(busPath())
    appendCardEvent(db, 'owner', { type: 'card.admitted', cardId: CARD, ts: new Date().toISOString(), dedupeKey: `card.admitted:${CARD}`, payload: { text: '# card\n' } })

    expect(cardVersionIn(eventsOf(db, 'card.admitted')[0]!.payload)).toBe(CARD_VERSION)
    db.close()
  })

  it('a stamped bus reads its stamp, and the refusal names the versions the node understands', () => {
    const db = openBus(busPath())
    stampBusVersion(db, BUS_VERSION)

    expect(busVersionOf(db)).toBe(BUS_VERSION)
    expect(() => stampBusVersion(db, 0)).toThrow('positive integer')
    db.exec(`${BUS_VERSION_RECORD} = -1`)
    expect(busVersionOf(db)).toBe(-1)
    expect(cardVersionIn(null)).toBe(UNRECORDED_VERSION)
    expect(cardVersionIn(JSON.stringify({ [CARD_VERSION_KEY]: 3 }))).toBe(3)
    expect(foreignVersion(DECLARATION.understands, 'card', CARD_VERSION, 'card #1')).toBeNull()
    expect(foreignVersion(DECLARATION.understands, 'bus', FOREIGN, 'the bus')).toBe(`the bus carries bus version ${FOREIGN}, and this node understands bus versions ${UNRECORDED_VERSION}, ${BUS_VERSION_BEFORE_LADDER_RUN}, ${BUS_VERSION}; it takes no work from it`)
    db.close()
  })
})
