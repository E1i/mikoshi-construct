import type { BudgetDeps } from '../../quality/lock.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os, { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, expect, it, vi } from 'vitest'
import { MACHINE_DIR_VARIABLE, MACHINE_LIMIT_FILE, machineSessions, MachineSessions, setMachineLimit } from '../../core/machine-sessions.js'
import { joinSession, LOCK_DIR_VARIABLE, sessionWorkers } from '../../quality/lock.js'

const CORES = 16
const QUARTER_OF_THE_CORES = 4
const CLAIMANT = { bus: '/home/.construct/bus.db', role: 'launch' as const }
const roots: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'machine-limit-'))
  roots.push(root)
  return root
}

function sessionsOn(cores: number, dir: string = scratch()): MachineSessions {
  return new MachineSessions(dir, () => true, cores)
}

function withLimitFile(content: string): string {
  const dir = scratch()
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, MACHINE_LIMIT_FILE), content)
  return dir
}

function run(over: Partial<BudgetDeps> = {}): BudgetDeps {
  return { dir: scratch(), tree: '/tree/a', pid: 101, cores: CORES, sessionLimit: QUARTER_OF_THE_CORES, isAlive: () => true, ...over }
}

it('no limit file gives a quarter of the cores and refuses the session past it', () => {
  const machine = sessionsOn(CORES)
  expect(machine.limit()).toBe(QUARTER_OF_THE_CORES)
  for (const cardId of [1, 2, 3, 4])
    expect(machine.claim({ ...CLAIMANT, cardId }).kind).toBe('claimed')
  expect(machine.free()).toBe(0)
  expect(machine.held()).toEqual({ live: QUARTER_OF_THE_CORES, limit: QUARTER_OF_THE_CORES })
  expect(machine.claim({ ...CLAIMANT, cardId: 5 })).toEqual({ kind: 'refused', hold: { live: QUARTER_OF_THE_CORES, limit: QUARTER_OF_THE_CORES } })
})

it.each([[1, 1], [3, 1], [4, 1], [7, 1], [8, 2], [32, 8]])('the default on %i cores is %i sessions', (cores, sessions) => {
  expect(sessionsOn(cores).limit()).toBe(sessions)
})

it('the default construction reads the cores of the machine', () => {
  vi.spyOn(os, 'availableParallelism').mockReturnValue(CORES)
  expect(machineSessions(() => true, { [MACHINE_DIR_VARIABLE]: scratch() }).limit()).toBe(QUARTER_OF_THE_CORES)
})

it('an invalid limit file gives the default and a valid one wins', () => {
  for (const invalid of ['not json', '{}', 'null', '{"sessions":0}', '{"sessions":-1}', '{"sessions":1.5}', '{"sessions":"3"}'])
    expect(sessionsOn(CORES, withLimitFile(invalid)).limit()).toBe(QUARTER_OF_THE_CORES)
  expect(sessionsOn(CORES, withLimitFile('{"sessions":9}')).limit()).toBe(9)
  expect(sessionsOn(CORES, withLimitFile('{"sessions":1}')).limit()).toBe(1)
})

it('a set limit is the limit that directory reads back, in a directory that did not exist', () => {
  const dir = path.join(scratch(), 'not-yet')
  setMachineLimit(dir, 7)
  expect(sessionsOn(CORES, dir).limit()).toBe(7)
})

it('the suite runs under a limit of its own, above the default of any machine it runs on', () => {
  const suite = machineSessions(() => true)
  expect(suite.limit()).toBeGreaterThan(os.availableParallelism())
  expect(machineSessions(() => true, { [MACHINE_DIR_VARIABLE]: scratch() }).limit()).toBeLessThanOrEqual(os.availableParallelism())
})

it('a lone session gets cores divided by the limit in workers', () => {
  expect(joinSession(run())).toBe(CORES / QUARTER_OF_THE_CORES)
  expect(joinSession(run({ sessionLimit: 2 }))).toBe(CORES / 2)
  expect(joinSession(run({ sessionLimit: 3 }))).toBe(5)
})

it('workers never fall below one, even with a limit above the cores', () => {
  expect(joinSession(run({ sessionLimit: CORES * 2 }))).toBe(1)
})

it('the ceiling leaves the grant alone where the grant is already lower', () => {
  const dir = scratch()
  const reads = [dir]
  const others = ['/tree/b', '/tree/c', '/tree/d', '/tree/e', '/tree/f', '/tree/g', '/tree/h']
  others.forEach((tree, at) => joinSession(run({ dir, reads, tree, pid: 200 + at })))
  expect(joinSession(run({ dir, reads, pid: 300 }))).toBe(1)
})

it('a registry that cannot be written still holds the run to the ceiling', () => {
  const blocked = path.join(scratch(), 'a-file')
  writeFileSync(blocked, '')
  expect(joinSession(run({ dir: path.join(blocked, 'below') }))).toBe(QUARTER_OF_THE_CORES)
})

it('the session workers of a tree read the limit of the machine', () => {
  vi.spyOn(os, 'availableParallelism').mockReturnValue(CORES)
  vi.stubEnv(LOCK_DIR_VARIABLE, scratch())
  vi.stubEnv(MACHINE_DIR_VARIABLE, scratch())
  expect(sessionWorkers(`/tree/default-${process.pid}`)).toBe(QUARTER_OF_THE_CORES)
  vi.stubEnv(LOCK_DIR_VARIABLE, scratch())
  vi.stubEnv(MACHINE_DIR_VARIABLE, withLimitFile('{"sessions":2}'))
  expect(sessionWorkers(`/tree/chosen-${process.pid}`)).toBe(CORES / 2)
})
