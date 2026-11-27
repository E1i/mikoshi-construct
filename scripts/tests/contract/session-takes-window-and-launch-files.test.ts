import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')

const MOVED_TO_SESSION = [
  'scripts/window/eddies-measure.ts',
  'scripts/window/handoff-check.ts',
  'scripts/nodes/launch/continuation.ts',
  'scripts/nodes/restart/chain-process.ts',
  'scripts/ports/result.ts',
  'scripts/quality/lock.ts',
] as const

const FORMER_HOLDERS = ['window', 'node-launch', 'node-restart', 'ports', 'quality'] as const

const GONE_ROWS = [
  'boundary:node-answer->window',
  'boundary:node-launch->window',
  'boundary:node-launch->node-restart',
  'boundary:session->node-launch',
] as const

const WINDOW_TO_RESTART = 'boundary:window->node-restart'
const WINDOW_TO_RESTART_RECORDED = 4

const SESSION_TO_INTAKE = 'boundary:session->intake'
const SESSION_TO_INTAKE_AT_CUT = 2
const PARKING_READS = 'scripts/intake/parking-reads.ts'

interface Declaration {
  paths: string[]
  shared: string[]
}

function jsonAt<T>(file: string): T {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, file), 'utf8')) as T
}

function declared(module: string): string[] {
  const { paths, shared } = jsonAt<Declaration>(`declarations/modules/${module}.json`)
  return [...paths, ...shared]
}

describe('session owns the window and launch files it runs on', () => {
  it('session declares every moved file by name', () => {
    const session = declared('session')
    expect(MOVED_TO_SESSION.filter(file => !session.includes(file))).toEqual([])
  })

  it.each(FORMER_HOLDERS)('%s declares none of the moved files', (module) => {
    const held = declared(module)
    expect(MOVED_TO_SESSION.filter(file => held.includes(file))).toEqual([])
  })

  it('the boundary rows the move retires are gone and window->node-restart is recorded as 4', () => {
    const ratchet = jsonAt<Record<string, number>>('contract/ratchet.json')
    expect(GONE_ROWS.filter(row => row in ratchet)).toEqual([])
    expect(ratchet[WINDOW_TO_RESTART]).toBe(WINDOW_TO_RESTART_RECORDED)
  })

  it('handoff-check reaches parking-reads in card-record, so session->intake does not grow', () => {
    expect(declared('card-record')).toContain(PARKING_READS)
    expect(declared('intake')).not.toContain(PARKING_READS)
    const ratchet = jsonAt<Record<string, number>>('contract/ratchet.json')
    expect(ratchet[SESSION_TO_INTAKE] ?? 0).toBeLessThanOrEqual(SESSION_TO_INTAKE_AT_CUT)
  })
})
