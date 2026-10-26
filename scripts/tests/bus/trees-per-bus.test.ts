import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { busDirOf } from '../../core/bus-path.js'
import { cardTree, WORKTREE_HOME_VARIABLE } from '../../ports/worktree-home.js'

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
})
