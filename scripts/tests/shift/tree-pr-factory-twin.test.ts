import type { TreeCard, TreePrPorts, TwinRebuild } from '../../nodes/launch/tree-pr.js'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GENERATED_FILES } from '../../core/generated-files.js'
import { treePr } from '../../nodes/launch/tree-pr.js'

const FACTORY_TWIN = GENERATED_FILES.factory.path
const PORT = 'scripts/ports/gh.ts'
const BRANCH = 'feat/port'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function write(root: string, file: string, text: string): void {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
  writeFileSync(path.join(root, file), text)
}

function contractOf(root: string): string {
  return `${JSON.stringify({ ports: readFileSync(path.join(root, PORT), 'utf8').trim() })}\n`
}

const regenerate: TwinRebuild = (cwd, args) => {
  expect(args).toEqual(GENERATED_FILES.factory.rebuild)
  writeFileSync(path.join(cwd, FACTORY_TWIN), contractOf(cwd))
  return { status: 0, stderr: '' }
}

function cardTree(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'tree-pr-twin-'))
  roots.push(root)
  const origin = path.join(root, 'origin.git')
  const seed = path.join(root, 'seed')
  const tree = path.join(root, 'tree')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
  execFileSync('git', ['init', '-q', '-b', 'main', seed])
  git(seed, ['config', 'user.email', 'bus@example.invalid'])
  git(seed, ['config', 'user.name', 'bus'])
  write(seed, PORT, 'export const port = 1\n')
  write(seed, FACTORY_TWIN, contractOf(seed))
  git(seed, ['add', '-A'])
  git(seed, ['commit', '-q', '-m', 'base'])
  git(seed, ['push', '-q', origin, 'main'])
  execFileSync('git', ['clone', '-q', origin, tree])
  git(tree, ['config', 'user.email', 'bus@example.invalid'])
  git(tree, ['config', 'user.name', 'bus'])
  git(tree, ['checkout', '-q', '-b', BRANCH])
  return tree
}

const CARD: TreeCard = {
  branch: BRANCH,
  title: 'port (#1)',
  commitMessage: 'port (#1)',
  cardLine: '#1 port [implement/construct/S/cheap/auto] · depends — · blocks —',
  contour: 'cheap',
  touches: [PORT],
  runs: [],
  namedPathReason: null,
}

function ports(rebuild: TwinRebuild, created: string[][]): TreePrPorts {
  return {
    git,
    rebuild,
    gh: (args) => {
      if (args[1] === 'list')
        return '[]'
      created.push(args)
      return 'https://github.com/o/r/pull/7\n'
    },
  }
}

describe('the bus rebuilds the factory contract in the card tree', () => {
  it('a port change in a card tree gets contract/factory.json regenerated and committed by the bus without the session', () => {
    const tree = cardTree()
    write(tree, PORT, 'export const port = 2\n')
    const created: string[][] = []
    const outcome = treePr(ports(regenerate, created), CARD, tree, null)
    expect(outcome).toEqual({ kind: 'pr', number: '7', followed: [FACTORY_TWIN] })
    expect(git(tree, ['show', '--name-only', '--format=', 'HEAD']).trim().split('\n').sort()).toEqual([FACTORY_TWIN, PORT])
    expect(git(tree, ['show', `origin/${BRANCH}:${FACTORY_TWIN}`])).toBe(`${JSON.stringify({ ports: 'export const port = 2' })}\n`)
    expect(git(tree, ['status', '--porcelain'])).toBe('')
    expect(created).toHaveLength(1)
  })

  it('a session\'s own edit of contract/factory.json is overwritten by the rebuild', () => {
    const tree = cardTree()
    write(tree, PORT, 'export const port = 3\n')
    write(tree, FACTORY_TWIN, '{"hand":"edit"}\n')
    const outcome = treePr(ports(regenerate, []), CARD, tree, null)
    expect(outcome.kind).toBe('pr')
    expect(git(tree, ['show', `HEAD:${FACTORY_TWIN}`])).toBe(`${JSON.stringify({ ports: 'export const port = 3' })}\n`)
  })

  it('a failed rebuild opens no pull request and returns the card to its session to fix the sources', () => {
    const tree = cardTree()
    write(tree, PORT, 'export const port = \n')
    const created: string[][] = []
    const outcome = treePr(ports(() => ({ status: 1, stderr: 'SyntaxError' }), created), CARD, tree, null)
    expect(outcome.kind).toBe('problem')
    expect(outcome.kind === 'problem' && outcome.gaps.map(gap => gap.reason)).toEqual(['twin-unbuilt'])
    expect(outcome.kind === 'problem' && outcome.why).toContain('pnpm contract:update exited 1: SyntaxError')
    expect(created).toEqual([])
  })
})
