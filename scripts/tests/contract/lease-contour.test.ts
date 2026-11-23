import type { RatchetNumbers } from '../../contract/ratchet.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MODULE_GRAPH } from '../../contract/factory/modules.js'
import { specifiersIn } from '../../contract/module-graph/imports.js'
import { ownerOf } from '../../contract/module-graph/ownership.js'
import { generateNumbers, readRatchet, rowsGrownOverBase, thresholdOf } from '../../contract/ratchet.js'
import { cardTransitions } from '../../supervisor/composition.js'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const LEASE = 'scripts/core/lease.ts'
const CARD_AUTOMATON = 'scripts/core/card-automaton.ts'
const SESSION = 'session'
const BUS_TO_SESSION = 'boundary:bus->session'
const JUDGED_ROWS = /^(?:boundary|lines):/
const GENERATION_TIMEOUT = 300_000

function relativeImportsOf(file: string): string[] {
  return specifiersIn(file, readFileSync(path.join(ROOT, file), 'utf8'))
    .map(specifier => specifier.text)
    .filter(text => text.startsWith('.'))
    .map(text => path.posix.join(path.posix.dirname(file), text.replace(/\.js$/, '.ts')))
}

const RAISED_BY_THE_OWNER: RatchetNumbers = { 'boundary:board->project': 2, 'boundary:node-review->decisions': 1, 'boundary:quality->events': 5, 'boundary:quality->ports': 10, 'boundary:window->quality': 1, 'boundary:decisions->card-record': 2, 'boundary:intake->card-record': 10, 'boundary:ports->card-record': 3, 'boundary:ports->pr-record': 1, 'boundary:pr-record->card-record': 3, 'boundary:rules->card-record': 4, 'boundary:window->card-record': 15, 'boundary:board->card-record': 4, 'boundary:board->layout': 1, 'boundary:ports->layout': 7, 'boundary:session->layout': 5, 'boundary:ports->bus': 17, 'boundary:window->bus': 39, 'boundary:card-record->ports': 2, 'boundary:ports->project': 10 }

function raisedByTheOwnerTo(recordedAtHead: RatchetNumbers, key: string, measured: number): boolean {
  return Object.hasOwn(RAISED_BY_THE_OWNER, key) && RAISED_BY_THE_OWNER[key] === measured && recordedAtHead[key] === measured
}

describe('the lease contour', () => {
  it('core/lease.ts does not import card-automaton', () => {
    const imported = relativeImportsOf(LEASE)
    expect(imported).not.toContain(CARD_AUTOMATON)
    expect(imported.filter(file => ownerOf(MODULE_GRAPH, file).includes(SESSION))).toEqual([])
    expect(typeof cardTransitions().appendedOnCard).toBe('function')
  })

  it('only the row the owner raised, at the value the owner allowed, is exempt from the growth check', () => {
    const recorded: RatchetNumbers = { 'boundary:node-review->decisions': 1, 'boundary:node-review->ports': 17, 'lines:scripts/core/queue.ts': 900 }
    expect(raisedByTheOwnerTo(recorded, 'boundary:node-review->decisions', 1)).toBe(true)
    expect(raisedByTheOwnerTo({ ...recorded, 'boundary:node-review->decisions': 2 }, 'boundary:node-review->decisions', 2)).toBe(false)
    expect(raisedByTheOwnerTo(recorded, 'boundary:node-review->ports', 17)).toBe(false)
    expect(raisedByTheOwnerTo(recorded, 'lines:scripts/core/queue.ts', 900)).toBe(false)
    expect(raisedByTheOwnerTo({}, 'boundary:node-review->decisions', 1)).toBe(false)
  })

  it('no boundary or lines row grows over the per-symbol normalized base', () => {
    const recorded = readRatchet(ROOT)
    const head = generateNumbers(ROOT, thresholdOf(recorded))
    expect(head[BUS_TO_SESSION] ?? 0).toBe(0)
    expect(recorded[BUS_TO_SESSION] ?? 0).toBe(0)
    expect(rowsGrownOverBase(ROOT, head, key => JUDGED_ROWS.test(key) && !raisedByTheOwnerTo(recorded, key, head[key]!))).toEqual([])
  }, GENERATION_TIMEOUT)
})
