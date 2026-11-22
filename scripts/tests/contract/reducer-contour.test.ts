import type { RatchetNumbers } from '../../contract/ratchet.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MODULE_GRAPH } from '../../contract/factory/modules.js'
import { specifiersIn } from '../../contract/module-graph/imports.js'
import { ownerOf } from '../../contract/module-graph/ownership.js'
import { generateNumbers, readRatchet, rowsGrownOverBase, thresholdOf } from '../../contract/ratchet.js'
import { CARD_ADMITTED, CARD_DROPPED, DECISION_RECORDED, MAIN_ADVANCED, MERGE_DONE, OWNER_WAIT_OPENED, PR_CLOSED, PR_OBSERVED } from '../../core/events.js'
import { reducedTypes } from '../../core/reducer.js'
import { busProjections } from '../../supervisor/composition.js'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const REDUCER = 'scripts/core/reducer.ts'
const COMPOSITION = 'scripts/supervisor/composition.ts'
const PLAN_FOLDS = 'scripts/window/plan-folds.ts'
const FORBIDDEN_FILES = new Set(['scripts/core/card-automaton.ts', 'scripts/core/card-bodies.ts', 'scripts/core/owner-commands.ts'])
const FORBIDDEN_MODULE = 'decisions'
const BUS = 'bus'
const PLAN_TO_BUS = 'boundary:plan->bus'
const OWNERS: Readonly<Record<string, string>> = {
  'scripts/core/pr-folds.ts': 'pr-record',
  'scripts/core/card-bodies.ts': 'card-record',
  'scripts/policy/decisions/wait-folds.ts': 'decisions',
  'scripts/supervisor/card-waits.ts': 'card-record',
  'scripts/core/stored-event.ts': 'events',
}
const JUDGED_ROWS = /^(?:boundary|lines):/
const BUS_READ = 'overlaps:bus-read'
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

function headNumbers(): RatchetNumbers {
  return generateNumbers(ROOT, thresholdOf(readRatchet(ROOT)))
}

describe('the reducer side of the queue contour', () => {
  it('core/reducer.ts imports no card-automaton, card-bodies, owner-commands or decisions module', () => {
    const imported = relativeImportsOf(REDUCER)
    expect(imported.filter(file => FORBIDDEN_FILES.has(file) || ownerOf(MODULE_GRAPH, file).includes(FORBIDDEN_MODULE))).toEqual([])
    expect(Object.entries(OWNERS).filter(([file, owner]) => !ownerOf(MODULE_GRAPH, file).includes(owner))).toEqual([])
    const listed = relativeImportsOf(COMPOSITION)
    expect(Object.keys(OWNERS).filter(file => file.endsWith('folds.ts') || file.endsWith('card-waits.ts')).filter(file => !listed.includes(file))).toEqual([])
    const types: readonly string[] = reducedTypes(busProjections())
    expect([CARD_ADMITTED, CARD_DROPPED, MERGE_DONE, DECISION_RECORDED, OWNER_WAIT_OPENED, PR_OBSERVED, PR_CLOSED, MAIN_ADVANCED].filter(type => !types.includes(type))).toEqual([])
  })

  it('no boundary or lines row grows over the per-symbol normalized base', () => {
    const head = headNumbers()
    const recorded = readRatchet(ROOT)
    expect(rowsGrownOverBase(ROOT, head, key => JUDGED_ROWS.test(key) && !raisedByTheOwnerTo(recorded, key, head[key]!))).toEqual([])
    expect(rowsGrownOverBase(ROOT, head, key => key === BUS_READ)).toEqual([])
  }, GENERATION_TIMEOUT)

  it('boundary:plan->bus is 0 and plan-folds imports no bus module', () => {
    expect(relativeImportsOf(PLAN_FOLDS).filter(file => ownerOf(MODULE_GRAPH, file).includes(BUS))).toEqual([])
    expect(readRatchet(ROOT)[PLAN_TO_BUS] ?? 0).toBe(0)
    expect(headNumbers()[PLAN_TO_BUS] ?? 0).toBe(0)
  }, GENERATION_TIMEOUT)
})
