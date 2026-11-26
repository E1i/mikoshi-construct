import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { taskWorktree } from '../../ports/worktree.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')

function readJson<T>(relative: string): T {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, relative), 'utf8')) as T
}

const RATCHET = readJson<Record<string, number>>('contract/ratchet.json')
const MODULE_FILES = readJson<Record<string, string[]>>('contract/module-files.json')

const PORTS_TO_BUS_CEILING = 6
const PORTS_TO_EVENTS_CEILING = 2
const MOVED_TO_LAYOUT = ['scripts/core/bus-path.ts', 'scripts/core/errors.ts']
const DECLARED_IN_BUS = ['scripts/ports/bus-read.ts', 'scripts/ports/worktree-home.ts']

describe('the ports layer files settle', () => {
  it('ports->bus and ports->events fall in the ratchet', () => {
    expect(RATCHET['boundary:ports->bus']).toBeLessThanOrEqual(PORTS_TO_BUS_CEILING)
    expect(RATCHET['boundary:ports->events']).toBeLessThanOrEqual(PORTS_TO_EVENTS_CEILING)
  })

  it('bus-path and errors belong to layout, bus-read and worktree-home to bus, and none of them to ports', () => {
    expect(MODULE_FILES.layout).toEqual(expect.arrayContaining(MOVED_TO_LAYOUT))
    expect(MODULE_FILES.bus).toEqual(expect.arrayContaining(DECLARED_IN_BUS))
    expect(MODULE_FILES.bus.filter(file => MOVED_TO_LAYOUT.includes(file))).toEqual([])
    expect(MODULE_FILES.ports.filter(file => [...MOVED_TO_LAYOUT, ...DECLARED_IN_BUS].includes(file))).toEqual([])
  })

  it('taskWorktree lives in the worktree port', () => {
    expect(taskWorktree('/home', '7')).toBe(path.join('/home', 'mc-7'))
  })
})
