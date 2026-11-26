import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')

function readJson<T>(relative: string): T {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, relative), 'utf8')) as T
}

const RATCHET = readJson<Record<string, number>>('contract/ratchet.json')
const MODULE_FILES = readJson<Record<string, string[]>>('contract/module-files.json')

const PORTS_TO_QUALITY_CEILING = 1
const PORTS_TO_INTAKE_CEILING = 4
const MOVED_TO_PORTS = ['src/commands/ci/state.ts', 'scripts/ci/required.ts', 'src/commands/intake/command-word.ts']

describe('the ci state and command word are ports', () => {
  it('ports->quality and ports->intake fall in the ratchet', () => {
    expect(RATCHET['boundary:ports->quality'] ?? 0).toBeLessThanOrEqual(PORTS_TO_QUALITY_CEILING)
    expect(RATCHET['boundary:ports->intake'] ?? 0).toBeLessThanOrEqual(PORTS_TO_INTAKE_CEILING)
  })

  it('state, ci/required and command-word belong to ports and to neither quality nor intake', () => {
    expect(MODULE_FILES.ports).toEqual(expect.arrayContaining(MOVED_TO_PORTS))
    expect(MODULE_FILES.quality.filter(file => MOVED_TO_PORTS.includes(file))).toEqual([])
    expect(MODULE_FILES.intake.filter(file => MOVED_TO_PORTS.includes(file))).toEqual([])
  })
})
