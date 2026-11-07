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
import { BUS_VERSION, busVersionOf, CARD_VERSION, CARD_VERSION_LINE, cardVersionOf, stampBusVersion, UNRECORDED_VERSION } from '../../core/bus-version.js'
import { appendEvent, openBus } from '../../core/db.js'
import { FACTORY_WORKERS } from '../../core/factory-paths.js'
import { completeTask } from '../../core/lease.js'
import { ForeignVersion, foreignVersion, Node, runNode, SWITCH_FLAG } from '../../core/node.js'
import { queueTaskWithin } from '../../core/queue.js'
import { Clock } from './github-fake.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const A_NODE_CLASS = /\bextends Node</
const FOREIGN = 9
const CARD = 4242

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

const DECLARATION: NodeDeclaration = { kind: 'review', on: ['probe.seen'], understands: { bus: [UNRECORDED_VERSION, BUS_VERSION], card: [CARD_VERSION] } }

class DeclaredNode extends Node<NodeStep> {
  handled: string[] = []

  constructor(db: DatabaseSync, clock: Clock, private readonly found: QueuedTask[] = []) {
    super('review', { db, clock: clock.now, session: 'versions', mode: 'live', env: {} })
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

function workerFiles(): string[] {
  return Object.values(FACTORY_WORKERS)
    .map(file => path.join(REPO_ROOT, file))
    .filter(file => A_NODE_CLASS.test(readFileSync(file, 'utf8')))
    .sort()
}

function isDeclaration(value: unknown): value is NodeDeclaration {
  return value != null && typeof value === 'object' && 'kind' in value && 'on' in value && 'understands' in value
}

function storeCard(db: DatabaseSync, text: string): void {
  appendEvent(db, { ts: new Date().toISOString(), type: 'probe.admitted', actor: 'owner', cardId: CARD, pr: null, head: null, dedupeKey: `probe.admitted:${CARD}`, payload: {}, legacy: false })
  const admission = Number((db.prepare('SELECT MAX(id) AS id FROM events').get() as { id: number }).id)
  db.prepare('INSERT INTO card_bodies (card_id, admission_event_id, text, text_sha) VALUES (?, ?, ?, ?)').run(CARD, admission, text, 'sha')
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

    expect(await runNode([SWITCH_FLAG], 'review', foreignBus, build, { pause: async () => {} })).toBe(1)
    expect(error).toHaveBeenCalledWith(expect.stringContaining(`stopped on a foreign version: the bus carries bus version ${FOREIGN}`))

    const db = openBus(busPath())
    const clock = new Clock()
    const task: QueuedTask = { queue: 'review', cardId: CARD }
    storeCard(db, `# card\n${CARD_VERSION_LINE} ${FOREIGN}\n`)
    queueTaskWithin(db, clock.now().toISOString(), task)
    const node = new DeclaredNode(db, clock, [task])

    const refusal = await runOnce(node).then(() => null, (thrown: unknown) => thrown)

    expect(refusal).toBeInstanceOf(ForeignVersion)
    expect((refusal as Error).message).toContain(`card #${CARD}`)
    expect((refusal as Error).message).toContain(`card version ${FOREIGN}`)
    expect(node.handled).toEqual([])
    db.close()
  })

  it('a bus and a card that carry no version read as version 1, and a node of this build works on them', async () => {
    const db = openBus(busPath())
    const clock = new Clock()
    const task: QueuedTask = { queue: 'review', cardId: CARD }
    storeCard(db, '# card\n')
    queueTaskWithin(db, clock.now().toISOString(), task)
    const node = new DeclaredNode(db, clock, [task])

    expect(busVersionOf(db)).toBe(UNRECORDED_VERSION)
    expect(cardVersionOf('# card\n')).toBe(UNRECORDED_VERSION)
    await runOnce(node)
    expect(node.handled).toHaveLength(1)
    expect(node.declared()).toBe(DECLARATION)
    db.close()
  })

  it('a stamped bus reads its stamp, and the refusal names the versions the node understands', () => {
    const db = openBus(busPath())
    stampBusVersion(db, BUS_VERSION)

    expect(busVersionOf(db)).toBe(BUS_VERSION)
    expect(() => stampBusVersion(db, 0)).toThrow('positive integer')
    expect(cardVersionOf(`${CARD_VERSION_LINE} 3\nrest`)).toBe(3)
    expect(foreignVersion(DECLARATION.understands, 'card', CARD_VERSION, 'card #1')).toBeNull()
    expect(foreignVersion(DECLARATION.understands, 'bus', FOREIGN, 'the bus')).toBe(`the bus carries bus version ${FOREIGN}, and this node understands bus versions ${UNRECORDED_VERSION}, ${BUS_VERSION}; it takes no work from it`)
    db.close()
  })
})
