import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { heldBy, MODULE_GRAPH } from '../../contract/factory/modules.js'
import { faultLine, ownerOf, ownershipFaults, sourceFiles } from '../../contract/module-graph/ownership.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const MOVED_TO_PORTS = ['src/commands/ci/state.ts', 'scripts/ci/required.ts', 'src/commands/intake/command-word.ts']
const RATCHET: Readonly<Record<string, number>> = JSON.parse(readFileSync(path.join(REPO_ROOT, 'contract/ratchet.json'), 'utf8'))

describe('ci state, ci/required and command-word are ports', () => {
  it.each(MOVED_TO_PORTS)('%s is owned by ports and is in its contract', (file) => {
    expect(ownerOf(MODULE_GRAPH, file)).toEqual(['ports'])
    expect(heldBy(MODULE_GRAPH.modules.ports!.contract, file)).toBe(true)
  })

  it.each(['quality', 'intake'])('the %s contract holds none of the moved files', (module) => {
    expect(MOVED_TO_PORTS.filter(file => heldBy(MODULE_GRAPH.modules[module]!.contract, file))).toEqual([])
  })

  it('no contract glob reaches a file its module does not own', () => {
    const faults = ownershipFaults(MODULE_GRAPH, sourceFiles(REPO_ROOT)).filter(fault => fault.kind === 'contract-outside-owns')

    expect(faults.map(faultLine)).toEqual([])
  })

  it('the ratchet rows from ports into quality and intake fell', () => {
    expect(RATCHET['boundary:ports->quality']).toBeLessThanOrEqual(1)
    expect(RATCHET['boundary:ports->intake']).toBeLessThanOrEqual(4)
  })
})
