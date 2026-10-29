import type { ShiftTask } from '../../../src/card/task-file.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { busDirOf } from '../../core/bus-path.js'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_STARTED } from '../../core/events.js'
import { handoffLadderSteps, realStarterPorts } from '../../nodes/launch/launch-worker.js'
import { cardTree, cardTreeRoots, DEFAULT_WORKTREE_HOME, WORKTREE_HOME_VARIABLE } from '../../ports/worktree-home.js'
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

  it('a second bus gets its own tree for card 1 while the old mc-1 exists', () => {
    const root = newRoot()
    const oldHome = path.join(root, 'worktrees')
    mkdirSync(path.join(oldHome, 'mc-1'), { recursive: true })
    const bus = path.join(root, 'E1i--clone', 'bus.db')
    openBus(bus).close()
    expect(cardTree({}, bus, '1', oldHome)).toBe(path.join(busDirOf(bus), 'worktrees', '1'))
  })

  it('the old mikoshi-construct bus keeps the old path of a card it already started', () => {
    const root = newRoot()
    const oldHome = path.join(root, 'worktrees')
    mkdirSync(path.join(oldHome, 'mc-2'), { recursive: true })
    const oldBus = path.join(root, 'bus.db')
    expect(cardTree({}, oldBus, '2', oldHome)).toBe(path.join(oldHome, 'mc-2'))
    expect(cardTree({}, oldBus, '3', oldHome)).toBe(path.join(busDirOf(oldBus), 'worktrees', '3'))
  })

  it('a card whose card.started on this bus names the old path keeps it', () => {
    const root = newRoot()
    const oldHome = path.join(root, 'worktrees')
    mkdirSync(path.join(oldHome, 'mc-3'), { recursive: true })
    mkdirSync(path.join(oldHome, 'mc-4'), { recursive: true })
    const bus = path.join(root, 'E1i--clone', 'bus.db')
    const db = openBus(bus)
    appendEvent(db, { ts: '2026-10-26T12:00:00.000Z', type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: 3, pr: null, head: null, dedupeKey: `${CARD_STARTED}:3`, payload: { session: 'card-session-3', worktree: path.join(oldHome, 'mc-3'), branch: 'feat/card-3', base: 'a'.repeat(40) }, legacy: false })
    db.close()
    expect(cardTree({}, bus, '3', oldHome)).toBe(path.join(oldHome, 'mc-3'))
    expect(cardTree({}, bus, '4', oldHome)).toBe(path.join(busDirOf(bus), 'worktrees', '4'))
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
    const tools = realRequestTools(db, bus, path.join(root, 'repo'), {})
    expect(tools.treeOf(987654)).toBe(path.join(busDirOf(bus), 'worktrees', '987654'))
    db.close()
  })

  it.each([
    ['the override', { [WORKTREE_HOME_VARIABLE]: '/elsewhere/trees' }, false],
    ['the old home', {}, true],
    ['the per-bus default', {}, false],
  ] as const)('every tree cardTree gives under %s lies in a close sweep root', (_case, env, oldExists) => {
    const root = newRoot()
    const bus = path.join(root, '.construct', 'a--one', 'bus.db')
    const tree = cardTree(env, bus, '5', DEFAULT_WORKTREE_HOME, () => oldExists)
    expect(cardTreeRoots(env, bus, path.join(root, 'repo')).homes).toContain(path.dirname(tree))
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
