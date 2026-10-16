import type { Equivalence } from '../../bus/node.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../bus/db.js'
import { runNodeEquivalence, USAGE } from '../../bus/node-equivalence.js'
import { NODE_EQUIVALENCE } from '../../bus/node.js'

const roots: string[] = []
let sequence = 0

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function newBus(): ReturnType<typeof openBus> {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-node-equivalence-'))
  roots.push(root)
  return openBus(path.join(root, 'bus.db'))
}

function tick(db: ReturnType<typeof openBus>, actor: string, ts: string, equivalence: Equivalence): void {
  sequence += 1
  appendEvent(db, { ts, type: NODE_EQUIVALENCE, actor, cardId: null, pr: null, head: null, dedupeKey: `${NODE_EQUIVALENCE}:test-${sequence}`, payload: { ...equivalence, event_id: sequence }, legacy: false })
}

function run(db: ReturnType<typeof openBus>, argv: string[]): { code: number, lines: string[] } {
  const lines: string[] = []
  const code = runNodeEquivalence(db, argv, line => lines.push(line))
  return { code, lines }
}

const SAME: Equivalence = { same: ['merge:1:7:a'], only_node: [], only_derive: [] }

describe('bus:node-equivalence', () => {
  it('counts the ticks of the named kind and exits 0 when none diverged', () => {
    const db = newBus()
    tick(db, 'worker:merge:s1', '2026-10-16T08:00:00.000Z', SAME)
    tick(db, 'worker:merge:s1', '2026-10-16T08:01:00.000Z', { same: [], only_node: [], only_derive: [] })
    tick(db, 'worker:review:s2', '2026-10-16T08:01:00.000Z', { same: [], only_node: ['review:1:7:a'], only_derive: [] })
    expect(run(db, ['merge'])).toEqual({ code: 0, lines: ['[bus:node-equivalence] merge over the whole log: 2 tick(s), 0 with a divergence'] })
  })

  it('lists every only_* key with the ticks it appeared in and exits 1 on a divergence', () => {
    const db = newBus()
    tick(db, 'worker:merge:s1', '2026-10-16T08:00:00.000Z', { same: [], only_node: ['merge:2:9:b'], only_derive: ['merge:3:4:c'] })
    tick(db, 'worker:merge:s1', '2026-10-16T08:01:00.000Z', { same: [], only_node: ['merge:2:9:b'], only_derive: [] })
    tick(db, 'worker:merge:s1', '2026-10-16T08:02:00.000Z', SAME)
    expect(run(db, ['merge'])).toEqual({
      code: 1,
      lines: [
        '[bus:node-equivalence] merge over the whole log: 3 tick(s), 2 with a divergence',
        '[bus:node-equivalence] only_node merge:2:9:b in 2 tick(s)',
        '[bus:node-equivalence] only_derive merge:3:4:c in 1 tick(s)',
      ],
    })
  })

  it('reads only the ticks at or after --since', () => {
    const db = newBus()
    tick(db, 'worker:merge:s1', '2026-10-16T08:00:00.000Z', { same: [], only_node: ['merge:2:9:b'], only_derive: [] })
    tick(db, 'worker:merge:s1', '2026-10-16T09:00:00.000Z', SAME)
    expect(run(db, ['merge', '--since', '2026-10-16T09:00:00.000Z'])).toEqual({ code: 0, lines: ['[bus:node-equivalence] merge since 2026-10-16T09:00:00.000Z: 1 tick(s), 0 with a divergence'] })
  })

  it('refuses a kind that is not a queue with the usage line', () => {
    expect(run(newBus(), ['merges'])).toEqual({ code: 1, lines: [USAGE] })
    expect(run(newBus(), [])).toEqual({ code: 1, lines: [USAGE] })
  })
})
