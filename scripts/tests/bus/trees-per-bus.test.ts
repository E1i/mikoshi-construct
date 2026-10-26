import type { ShiftTask } from '../../../src/card/task-file.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { busDirOf } from '../../core/bus-path.js'
import { openBus } from '../../core/db.js'
import { cardTreeRoots } from '../../nodes/close/close-worker.js'
import { handoffLadderSteps, realStarterPorts } from '../../nodes/launch/launch-worker.js'
import { cardTree, DEFAULT_WORKTREE_HOME, WORKTREE_HOME_VARIABLE } from '../../ports/worktree-home.js'
import { realRequestTools } from '../../window/window-request-tools.js'

const roots: string[] = []

function newRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'trees-per-bus-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

describe('card trees per bus', () => {
  it('gives card 2 of two buses two different paths, each under its own bus directory', () => {
    const root = newRoot()
    const oldHome = path.join(root, 'old')
    const first = path.join(root, '.construct', 'a--one', 'bus.db')
    const second = path.join(root, '.construct', 'b--two', 'bus.db')
    const treeA = cardTree({}, first, '2', oldHome)
    const treeB = cardTree({}, second, '2', oldHome)
    expect(treeA).toBe(path.join(busDirOf(first), 'worktrees', '2'))
    expect(treeB).toBe(path.join(busDirOf(second), 'worktrees', '2'))
    expect(treeA).not.toBe(treeB)
    expect(path.basename(treeA)).toBe('2')
  })

  it('keeps a tree that already exists at the old mc- path', () => {
    const root = newRoot()
    const oldHome = path.join(root, 'old')
    mkdirSync(path.join(oldHome, 'mc-2'), { recursive: true })
    const bus = path.join(root, '.construct', 'a--one', 'bus.db')
    expect(cardTree({}, bus, '2', oldHome)).toBe(path.join(oldHome, 'mc-2'))
    expect(cardTree({}, bus, '3', oldHome)).toBe(path.join(busDirOf(bus), 'worktrees', '3'))
  })

  it('lets CONSTRUCT_WORKTREE_HOME override the root, keeping the mc- name', () => {
    const root = newRoot()
    const bus = path.join(root, '.construct', 'a--one', 'bus.db')
    expect(cardTree({ [WORKTREE_HOME_VARIABLE]: '/elsewhere/trees' }, bus, '2', path.join(root, 'old'))).toBe(path.join('/elsewhere/trees', 'mc-2'))
  })

  it('the launch ladder looks for the card tree under the bus it serves', () => {
    const root = newRoot()
    const bus = path.join(root, '.construct', 'a--one', 'bus.db')
    const tree = path.join(busDirOf(bus), 'worktrees', '987654')
    const task = { card: { id: 987654 } } as ShiftTask
    const steps = handoffLadderSteps(path.join(root, 'handoff'), path.join(root, 'repo'), {}, bus)
    expect(steps.tree(task)).toBeNull()
    mkdirSync(tree, { recursive: true })
    expect(steps.tree(task)).toBe(tree)
  })

  it('the launch cut returns the per-bus tree of the bus it serves', () => {
    const root = newRoot()
    const repo = path.join(root, 'repo')
    mkdirSync(repo)
    writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts: { 'task:start': 'node -e 0' } }))
    const bus = path.join(root, '.construct', 'a--one', 'bus.db')
    const ports = realStarterPorts(repo, { ...process.env, [WORKTREE_HOME_VARIABLE]: '' }, '', () => 'u', () => null, () => [], null, bus)
    const task = { card: { id: 987654, line: '#987654 x' }, branch: 'feat/x' } as ShiftTask
    expect(ports.cut(task)).toBe(path.join(busDirOf(bus), 'worktrees', '987654'))
  })

  it('the window request tools name the per-bus tree of the bus they serve', () => {
    const root = newRoot()
    const bus = path.join(root, '.construct', 'a--one', 'bus.db')
    const db = openBus(bus)
    const tools = realRequestTools(db, bus, path.join(root, 'repo'), {}, root)
    expect(tools.treeOf(987654)).toBe(path.join(busDirOf(bus), 'worktrees', '987654'))
    db.close()
  })

  it('the close sweep roots hold the per-bus worktrees, the old home and the override when set', () => {
    const root = newRoot()
    const bus = path.join(root, '.construct', 'a--one', 'bus.db')
    const repo = path.join(root, 'repo')
    const plain = cardTreeRoots({}, bus, repo)
    expect(plain.perBus).toBe(path.join(busDirOf(bus), 'worktrees'))
    expect(plain.homes).toEqual(expect.arrayContaining([plain.perBus, DEFAULT_WORKTREE_HOME, root]))
    expect(cardTreeRoots({ [WORKTREE_HOME_VARIABLE]: '/elsewhere/trees' }, bus, repo).homes).toEqual(expect.arrayContaining(['/elsewhere/trees', plain.perBus, DEFAULT_WORKTREE_HOME]))
  })
})
