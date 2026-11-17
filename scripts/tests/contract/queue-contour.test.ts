import type { RatchetNumbers } from '../../contract/ratchet.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MODULE_GRAPH } from '../../contract/factory/modules.js'
import { specifiersIn } from '../../contract/module-graph/imports.js'
import { ownerOf } from '../../contract/module-graph/ownership.js'
import { branchBase, generateNumbers, ownershipMoves, RATCHET_RECORD, readRatchet, thresholdOf } from '../../contract/ratchet.js'
import { deriveQueues } from '../../core/queue.js'
import { processGit } from '../../ports/git.js'
import { mayRequeue, queueSources } from '../../supervisor/composition.js'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const QUEUE = 'scripts/core/queue.ts'
const MAY_IMPORT = new Set(['bus', 'events'])
const IDENTIFIERS = 'scripts/core/identifiers.ts'
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

describe('the queue side of the queue contour', () => {
  it('core/queue.ts imports only bus, events and identifiers files', () => {
    const foreign = relativeImportsOf(QUEUE).filter(file => file !== IDENTIFIERS && !ownerOf(MODULE_GRAPH, file).some(owner => MAY_IMPORT.has(owner)))
    expect(foreign).toEqual([])
    expect(deriveQueues.length).toBe(4)
    expect(typeof mayRequeue()).toBe('function')
    expect(queueSources().length).toBeGreaterThan(0)
  })

  it('no boundary or lines row grows over the per-symbol normalized base', () => {
    const base = baseRecord()
    const head = generateNumbers(ROOT, thresholdOf(readRatchet(ROOT)))
    const grown = Object.keys(head).filter(key => JUDGED_ROWS.test(key) && head[key]! > (base[key] ?? 0)).sort()
    const moved = ownershipMoves(ROOT, grown.filter(key => key.startsWith('boundary:')))
    expect(grown.filter(key => !moved.has(key))).toEqual([])
  }, GENERATION_TIMEOUT)
})
