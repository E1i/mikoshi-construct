import type { Lease } from '../../../core/lease.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { repositoryReport } from '../../../contract/module-graph/report.js'
import { CARD_VERSION_KEY } from '../../../core/bus-version.js'
import { appendEvent, openBus } from '../../../core/db.js'
import { UNDERSTOOD_NOW } from '../../../core/node.js'
import { nodeSupply, refusesForeignCard } from '../../../supervisor/composition.js'

const NODE = 'scripts/core/node.ts'
const CARD_BODIES = 'scripts/core/card-bodies.ts'
const COMPOSITION = 'scripts/supervisor/composition.ts'
const FOREIGN = 9
const CARD = 4242
const UNADMITTED = 4243

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function leaseOf(cardId: number): Lease {
  return { taskKey: `review:${cardId}`, queue: 'review', cardId, pr: null, head: null, leaseGen: 1, actor: 'worker:review:injected' }
}

describe('the node refuses a foreign card through an injected check', () => {
  it('node.ts imports no card-bodies; the composition module does, and hands the check through the supply', () => {
    const { graph } = repositoryReport()
    expect(graph.imports.filter(({ from, to }) => from === NODE && to === CARD_BODIES)).toEqual([])
    expect(graph.imports.some(({ from, to }) => from === COMPOSITION && to === CARD_BODIES)).toBe(true)
    expect(nodeSupply().refuses).toBe(refusesForeignCard)
  })

  it('the injected check refuses a card admitted at a foreign version and passes an unadmitted or known one', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'node-refuses-injected-'))
    roots.push(root)
    const db = openBus(path.join(root, 'bus.db'))
    appendEvent(db, { ts: new Date().toISOString(), type: 'probe.admitted', actor: 'owner', cardId: CARD, pr: null, head: null, dedupeKey: `probe.admitted:${CARD}`, payload: { [CARD_VERSION_KEY]: FOREIGN }, legacy: false })
    const admission = Number((db.prepare('SELECT MAX(id) AS id FROM events').get() as { id: number }).id)
    db.prepare('INSERT INTO card_bodies (card_id, admission_event_id, text, text_sha) VALUES (?, ?, ?, ?)').run(CARD, admission, '# card\n', 'sha')

    expect(refusesForeignCard(db, leaseOf(CARD), UNDERSTOOD_NOW)).toContain(`card #${CARD} (review:${CARD}) carries card version ${FOREIGN}`)
    expect(refusesForeignCard(db, leaseOf(CARD), { ...UNDERSTOOD_NOW, card: [FOREIGN] })).toBeNull()
    expect(refusesForeignCard(db, leaseOf(UNADMITTED), UNDERSTOOD_NOW)).toBeNull()
    db.close()
  })
})
