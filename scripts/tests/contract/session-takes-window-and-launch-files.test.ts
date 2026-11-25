import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')

const MOVED_TO_SESSION = [
  'scripts/window/eddies-measure.ts',
  'scripts/nodes/launch/continuation.ts',
  'scripts/window/handoff-check.ts',
  'scripts/nodes/restart/chain-process.ts',
  'scripts/ports/result.ts',
  'scripts/quality/lock.ts',
]

const FORMER_HOLDERS = ['window', 'node-launch', 'node-restart', 'ports', 'quality']

const ROWS_THE_MOVE_EMPTIES = [
  'boundary:node-answer->window',
  'boundary:node-launch->window',
  'boundary:node-launch->node-restart',
  'boundary:session->node-launch',
]

interface Declared {
  paths: string[]
  shared: string[]
}

function declaredBy(module: string): string[] {
  const declared = JSON.parse(readFileSync(path.join(REPO_ROOT, 'declarations', 'modules', `${module}.json`), 'utf8')) as Declared
  return [...declared.paths, ...declared.shared]
}

function ratchet(): Record<string, number> {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, 'contract', 'ratchet.json'), 'utf8')) as Record<string, number>
}

describe('session owns the window and launch files it runs on', () => {
  it('session declares every moved file by name', () => {
    expect(declaredBy('session')).toEqual(expect.arrayContaining(MOVED_TO_SESSION))
  })

  it.each(FORMER_HOLDERS)('%s names none of the moved files', (module) => {
    expect(declaredBy(module).filter(entry => MOVED_TO_SESSION.includes(entry))).toEqual([])
  })

  it('quality no longer holds the whole scripts/quality folder that would take lock.ts back', () => {
    expect(declaredBy('quality')).not.toContain('scripts/quality/')
  })

  it('the ratchet holds no row the move emptied and records window->node-restart as 4', () => {
    const recorded = ratchet()

    expect(ROWS_THE_MOVE_EMPTIES.filter(row => row in recorded)).toEqual([])
    expect(recorded['boundary:window->node-restart']).toBe(4)
  })
})
