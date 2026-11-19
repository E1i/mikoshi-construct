import type { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NODE_DECLARATIONS, nodesSection } from '../../contract/factory/nodes.js'
import { TICK_MS } from '../../core/cadence.js'
import { openBus } from '../../core/db.js'
import { DECISION_RECORDED, DECISIONS_IMPORTED } from '../../core/events.js'
import { decisionsFileOf } from '../../policy/decisions/decisions.js'
import { inForceDecisions, recordDecision } from '../../policy/decisions/index.js'
import { composeBusTick } from '../../supervisor/run.js'
import { Clock, FakeGitHub } from '../bus/github-fake.js'

const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..')
const NODES_WOKEN_BY_A_DECISION = ['answer', 'merge']
const roots: string[] = []
const opened: DatabaseSync[] = []

beforeEach(() => {
  vi.stubEnv('BUS_RERUN', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
  for (const db of opened.splice(0))
    db.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function busWithDecisionsFile(text: string): { db: DatabaseSync, file: string, tick: () => void, clock: Clock } {
  const home = mkdtempSync(path.join(tmpdir(), 'no-decisions-import-'))
  roots.push(home)
  const busPath = path.join(home, 'bus', 'bus.db')
  mkdirSync(path.dirname(busPath), { recursive: true })
  const file = decisionsFileOf(busPath)
  writeFileSync(file, text)
  const db = openBus(busPath)
  opened.push(db)
  const clock = new Clock()
  const { busTick } = composeBusTick(db, busPath, new FakeGitHub().client, () => ({ status: 201, headers: {}, body: null }), clock.now, home)
  const tick = (): void => {
    expect(busTick.run()?.poll.kind).toBe('ticked')
    clock.advance(TICK_MS)
  }
  return { db, file, clock, tick }
}

function eventsOfType(db: DatabaseSync, type: string): number {
  return Number((db.prepare('SELECT count(*) AS n FROM events WHERE type = ?').get(type) as { n: number }).n)
}

describe('owner-decisions.md is not an input of the bus', () => {
  it('a bus tick imports nothing from owner-decisions.md', () => {
    const bus = busWithDecisionsFile('# Owner decisions\n\n- D-5 · 2026-11-17 — [owner] a line written by hand.\n')
    bus.tick()
    writeFileSync(bus.file, '# Owner decisions\n\n- D-5 · 2026-11-17 — [owner] a line written by hand.\n- D-6 · 2026-11-17 — [owner] a new entry.\n')
    bus.tick()

    expect(eventsOfType(bus.db, DECISIONS_IMPORTED)).toBe(0)
    expect(inForceDecisions(bus.db)).toEqual([])

    recordDecision(bus.db, { ts: bus.clock.now().toISOString(), decisionId: 7, text: '[owner] recorded through the bus.', cards: [] })
    bus.tick()
    expect(eventsOfType(bus.db, DECISION_RECORDED)).toBe(1)
    expect(inForceDecisions(bus.db).map(decision => decision.decisionId)).toEqual([7])
  })

  it('every node a decision woke is still woken by decision.recorded', () => {
    const declared = nodesSection().declared
    const committed = (JSON.parse(readFileSync(path.join(REPO_ROOT, 'contract', 'factory.json'), 'utf8')) as { nodes: ReturnType<typeof nodesSection> }).nodes

    expect(NODE_DECLARATIONS.filter(node => node.on.includes(DECISIONS_IMPORTED)).map(node => node.kind)).toEqual([])
    for (const kind of NODES_WOKEN_BY_A_DECISION)
      expect(declared[kind]!.on).toContain(DECISION_RECORDED)
    expect(Object.values(committed.declared).filter(row => row.on.includes(DECISIONS_IMPORTED))).toEqual([])
    expect(committed).toEqual(nodesSection())
  })
})
