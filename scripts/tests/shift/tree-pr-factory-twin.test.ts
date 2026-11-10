import type { TreeCard, TreePrPorts, TwinRebuild } from '../../nodes/launch/tree-pr.js'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GENERATED_FILES } from '../../core/generated-files.js'
import { treePr } from '../../nodes/launch/tree-pr.js'

const FACTORY_TWIN = GENERATED_FILES.factory.path
const PORT = 'scripts/ports/gh.ts'
const OTHER_PORT = 'scripts/ports/git.ts'
const PORTS_DIR = 'scripts/ports'
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
  const ports = readdirSync(path.join(root, PORTS_DIR)).sort().map(file => readFileSync(path.join(root, PORTS_DIR, file), 'utf8').trim())
  return `${JSON.stringify({ ports })}\n`
}

function contractText(...ports: string[]): string {
  return `${JSON.stringify({ ports })}\n`
}

const regenerate: TwinRebuild = (cwd, args) => {
  expect(args).toEqual(GENERATED_FILES.factory.rebuild)
  writeFileSync(path.join(cwd, FACTORY_TWIN), contractOf(cwd))
  return { status: 0, stderr: '' }
}

interface CardTree {
  tree: string
  seed: string
  origin: string
}

function moveMain(at: CardTree, file: string, text: string): void {
  write(at.seed, file, text)
  write(at.seed, FACTORY_TWIN, contractOf(at.seed))
  git(at.seed, ['add', '-A'])
  git(at.seed, ['commit', '-q', '-m', `main moves ${file}`])
  git(at.seed, ['push', '-q', at.origin, 'main'])
}

function cardTreeAt(): CardTree {
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
  write(seed, OTHER_PORT, 'export const other = 1\n')
  write(seed, FACTORY_TWIN, contractOf(seed))
  git(seed, ['add', '-A'])
  git(seed, ['commit', '-q', '-m', 'base'])
  git(seed, ['push', '-q', origin, 'main'])
  execFileSync('git', ['clone', '-q', origin, tree])
  git(tree, ['config', 'user.email', 'bus@example.invalid'])
  git(tree, ['config', 'user.name', 'bus'])
  git(tree, ['checkout', '-q', '-b', BRANCH])
  return { tree, seed, origin }
}

function cardTree(): string {
  return cardTreeAt().tree
}

function mergeInProgress(tree: string): boolean {
  try {
    git(tree, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])
    return true
  }
  catch {
    return false
  }
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

function ports(rebuild: TwinRebuild | undefined, created: string[][]): TreePrPorts {
  return {
    git,
    ...(rebuild === undefined ? {} : { rebuild }),
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
    expect(git(tree, ['show', `origin/${BRANCH}:${FACTORY_TWIN}`])).toBe(`${JSON.stringify({ ports: ['export const port = 2', 'export const other = 1'] })}\n`)
    expect(git(tree, ['status', '--porcelain'])).toBe('')
    expect(created).toHaveLength(1)
  })

  it('a session\'s own edit of contract/factory.json is overwritten by the rebuild', () => {
    const tree = cardTree()
    write(tree, PORT, 'export const port = 3\n')
    write(tree, FACTORY_TWIN, '{"hand":"edit"}\n')
    const outcome = treePr(ports(regenerate, []), CARD, tree, null)
    expect(outcome.kind).toBe('pr')
    expect(git(tree, ['show', `HEAD:${FACTORY_TWIN}`])).toBe(`${JSON.stringify({ ports: ['export const port = 3', 'export const other = 1'] })}\n`)
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

  it('a conflict on the twin with a moved main takes main\'s side and is rebuilt from both sides\' sources in the merge commit', () => {
    const at = cardTreeAt()
    moveMain(at, OTHER_PORT, 'export const other = 2\n')
    write(at.tree, PORT, 'export const port = 2\n')
    const outcome = treePr(ports(regenerate, []), CARD, at.tree, null)
    expect(outcome.kind).toBe('pr')
    expect(git(at.tree, ['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(' ')).toHaveLength(3)
    expect(git(at.tree, ['show', `origin/${BRANCH}:${FACTORY_TWIN}`])).toBe(contractText('export const port = 2', 'export const other = 2'))
    expect(git(at.tree, ['status', '--porcelain'])).toBe('')
  })

  it('a moved main with no conflict still gets the twin rebuilt in the merge commit', () => {
    const at = cardTreeAt()
    write(at.seed, 'scripts/ports/new.ts', 'export const fresh = 1\n')
    git(at.seed, ['add', '-A'])
    git(at.seed, ['commit', '-q', '-m', 'main adds a port without its twin'])
    git(at.seed, ['push', '-q', at.origin, 'main'])
    write(at.tree, PORT, 'export const port = 2\n')
    const outcome = treePr(ports(regenerate, []), CARD, at.tree, null)
    expect(outcome.kind).toBe('pr')
    expect(git(at.tree, ['show', `origin/${BRANCH}:${FACTORY_TWIN}`])).toBe(contractText('export const port = 2', 'export const other = 1', 'export const fresh = 1'))
  })

  it('without a rebuild port a conflict on the twin stays a conflict for the session', () => {
    const at = cardTreeAt()
    moveMain(at, OTHER_PORT, 'export const other = 2\n')
    write(at.tree, PORT, 'export const port = 2\n')
    write(at.tree, FACTORY_TWIN, contractOf(at.tree))
    const outcome = treePr(ports(undefined, []), CARD, at.tree, null)
    expect(outcome.kind === 'problem' && outcome.gaps).toEqual([expect.objectContaining({ reason: 'stale-base', paths: [FACTORY_TWIN] })])
  })

  it('a rebuild that fails after the fresh-main merge aborts the merge and names the failure', () => {
    const at = cardTreeAt()
    moveMain(at, OTHER_PORT, 'export const other = 2\n')
    write(at.tree, PORT, 'export const port = 2\n')
    let calls = 0
    const failsSecond: TwinRebuild = (cwd, args) => {
      calls += 1
      return calls === 1 ? regenerate(cwd, args) : { status: 2, stderr: 'broken after merge' }
    }
    const created: string[][] = []
    const outcome = treePr(ports(failsSecond, created), CARD, at.tree, null)
    expect(calls).toBe(2)
    expect(outcome.kind).toBe('problem')
    expect(outcome.kind === 'problem' && outcome.gaps.map(gap => gap.reason)).toEqual(['stale-base'])
    expect(outcome.kind === 'problem' && outcome.why).toContain(`the bus could not rebuild ${FACTORY_TWIN} after the merge: pnpm contract:update exited 2: broken after merge`)
    expect(mergeInProgress(at.tree)).toBe(false)
    expect(created).toEqual([])
  })

  it('a session that committed its port change itself gets the twin rebuilt and committed by the bus', () => {
    const tree = cardTree()
    write(tree, PORT, 'export const port = 4\n')
    git(tree, ['commit', '-q', '-am', 'session commit'])
    expect(git(tree, ['status', '--porcelain'])).toBe('')
    const outcome = treePr(ports(regenerate, []), CARD, tree, null)
    expect(outcome.kind).toBe('pr')
    expect(git(tree, ['show', `origin/${BRANCH}:${FACTORY_TWIN}`])).toBe(contractText('export const port = 4', 'export const other = 1'))
    expect(git(tree, ['status', '--porcelain'])).toBe('')
  })

  it('a tree that carries no contract/factory.json is never rebuilt', () => {
    const tree = cardTree()
    git(tree, ['rm', '-q', FACTORY_TWIN])
    write(tree, PORT, 'export const port = 5\n')
    const outcome = treePr(ports(() => {
      throw new Error('no rebuild is expected in a tree without the twin')
    }, []), { ...CARD, touches: [PORT, FACTORY_TWIN] }, tree, null)
    expect(outcome.kind).toBe('pr')
  })

  it('without a rebuild port the shift commits the tree as the session left it', () => {
    const tree = cardTree()
    write(tree, PORT, 'export const port = 6\n')
    const outcome = treePr(ports(undefined, []), CARD, tree, null)
    expect(outcome).toEqual({ kind: 'pr', number: '7', followed: [] })
    expect(git(tree, ['show', `origin/${BRANCH}:${FACTORY_TWIN}`])).toBe(contractText('export const port = 1', 'export const other = 1'))
  })
})
