import type { RatchetNumbers } from '../../contract/ratchet.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MODULE_GRAPH } from '../../contract/factory/modules.js'
import { specifiersIn } from '../../contract/module-graph/imports.js'
import { ownerOf } from '../../contract/module-graph/ownership.js'
import { branchBase, generateNumbers, ownershipMoves, RATCHET_RECORD, readRatchet, thresholdOf } from '../../contract/ratchet.js'
import { processGit } from '../../ports/git.js'
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

function baseRecord(): RatchetNumbers {
  const base = branchBase(ROOT)
  return JSON.parse(processGit.readOrNull(ROOT, ['show', `${base}:${RATCHET_RECORD}`]) ?? '{}') as RatchetNumbers
}

function headNumbers(): RatchetNumbers {
  return generateNumbers(ROOT, thresholdOf(readRatchet(ROOT)))
}

describe('the lease contour', () => {
  it('core/lease.ts imports no card-automaton and no session module; card transitions arrive from the composition', () => {
    const imported = relativeImportsOf(LEASE)
    expect(imported).not.toContain(CARD_AUTOMATON)
    expect(imported.filter(file => ownerOf(MODULE_GRAPH, file).includes(SESSION))).toEqual([])
    expect(typeof cardTransitions().appendedOnCard).toBe('function')
  })

  it('boundary:bus->session is 0 and no boundary or lines row grows over the base', () => {
    const base = baseRecord()
    const head = headNumbers()
    expect(head[BUS_TO_SESSION] ?? 0).toBe(0)
    expect(readRatchet(ROOT)[BUS_TO_SESSION] ?? 0).toBe(0)
    const grown = Object.keys(head).filter(key => JUDGED_ROWS.test(key) && head[key]! > (base[key] ?? 0)).sort()
    const moved = ownershipMoves(ROOT, grown.filter(key => key.startsWith('boundary:')))
    expect(grown.filter(key => !moved.has(key))).toEqual([])
  }, GENERATION_TIMEOUT)
})
