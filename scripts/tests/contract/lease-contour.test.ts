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

function raisedByTheOwnerTo(recordedAtHead: RatchetNumbers, key: string, measured: number): boolean {
  return recordedAtHead[key] === measured
}

describe('the lease contour', () => {
  it('core/lease.ts does not import card-automaton', () => {
    const imported = relativeImportsOf(LEASE)
    expect(imported).not.toContain(CARD_AUTOMATON)
    expect(imported.filter(file => ownerOf(MODULE_GRAPH, file).includes(SESSION))).toEqual([])
    expect(typeof cardTransitions().appendedOnCard).toBe('function')
  })

  it('no boundary or lines row grows over the per-symbol normalized base', () => {
    const recorded = readRatchet(ROOT)
    const head = generateNumbers(ROOT, thresholdOf(recorded))
    expect(head[BUS_TO_SESSION] ?? 0).toBe(0)
    expect(recorded[BUS_TO_SESSION] ?? 0).toBe(0)
    expect(rowsGrownOverBase(ROOT, head, key => JUDGED_ROWS.test(key) && !raisedByTheOwnerTo(recorded, key, head[key]!))).toEqual([])
  }, GENERATION_TIMEOUT)
})
