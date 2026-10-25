import type { OwnerCommandPorts } from '../../window/owner-command.js'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { COMMAND_FILE, ownerCommand, PATCH_FILE, probeDirOf, runOwnerCommand } from '../../window/owner-command.js'

const CARD = 4242
const TOUCHES = ['scripts/shift/x.ts', 'scripts/tests/shift/**']
const IDENTITY = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com']
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

interface Scene {
  root: string
  tree: string
  owner: string
  probes: string
  lines: string[]
  ports: OwnerCommandPorts
}

function scene(): Scene {
  const root = mkdtempSync(path.join(tmpdir(), 'owner-command-'))
  roots.push(root)
  const tree = path.join(root, 'tree')
  mkdirSync(path.join(tree, 'scripts', 'shift'), { recursive: true })
  git(root, ['init', '-q', tree])
  writeFileSync(path.join(tree, 'scripts', 'shift', 'x.ts'), 'export const x = 1\n')
  git(tree, ['add', '-A'])
  git(tree, [...IDENTITY, 'commit', '-q', '-m', 'base'])
  const owner = path.join(root, 'owner')
  git(root, ['clone', '-q', tree, owner])
  const probes = path.join(root, 'probes')
  const lines: string[] = []
  const ports: OwnerCommandPorts = { git, touches: () => TOUCHES, probesDir: probes, out: line => lines.push(line), err: line => lines.push(line) }
  return { root, tree, owner, probes, lines, ports }
}

const ARGV = (tree: string): string[] => ['--tree', tree, '--card', String(CARD), '--message', `x (#${CARD})`]

describe('owner:command builds the patch and the command the window hands the owner', () => {
  it('a file the card created untracked is in the patch and lands in the commit the owner command makes', () => {
    const { tree, owner, probes, ports } = scene()
    writeFileSync(path.join(tree, 'scripts', 'shift', 'x.ts'), 'export const x = 2\n')
    mkdirSync(path.join(tree, 'scripts', 'tests', 'shift'), { recursive: true })
    writeFileSync(path.join(tree, 'scripts', 'tests', 'shift', 'x.test.ts'), 'new file\n')

    expect(runOwnerCommand(ARGV(tree), ports)).toBe(0)

    const dir = probeDirOf(probes, CARD)
    expect(readFileSync(path.join(dir, PATCH_FILE), 'utf8')).toContain('scripts/tests/shift/x.test.ts')
    const command = readFileSync(path.join(dir, COMMAND_FILE), 'utf8')
    expect(command).toBe(ownerCommand(path.join(dir, PATCH_FILE), `x (#${CARD})`))
    expect(command).not.toMatch(/commit\s+-\S*a/)
    execFileSync('sh', ['-c', command], { cwd: owner, env: { ...process.env, GIT_AUTHOR_NAME: 'Owner', GIT_AUTHOR_EMAIL: 'o@example.com', GIT_COMMITTER_NAME: 'Owner', GIT_COMMITTER_EMAIL: 'o@example.com' } })
    expect(git(owner, ['show', '--name-only', '--format=%s', 'HEAD']).trim().split('\n')).toEqual([`x (#${CARD})`, '', 'scripts/shift/x.ts', 'scripts/tests/shift/x.test.ts'])
    expect(git(owner, ['status', '--porcelain'])).toBe('')
  })

  it('an untracked file outside the card touches refuses the owner command and names the path', () => {
    const { tree, probes, lines, ports } = scene()
    writeFileSync(path.join(tree, 'scripts', 'shift', 'x.ts'), 'export const x = 2\n')
    writeFileSync(path.join(tree, 'stray.md'), 'not the card\n')
    mkdirSync(path.join(tree, 'scripts', 'tests', 'shift'), { recursive: true })
    writeFileSync(path.join(tree, 'scripts', 'tests', 'shift', 'x.test.ts'), 'new file\n')

    expect(runOwnerCommand(ARGV(tree), ports)).toBe(1)

    expect(lines.filter(line => line.includes('outside the touches:'))).toEqual(['[owner:command] outside the touches: stray.md'])
    expect(existsSync(probeDirOf(probes, CARD))).toBe(false)
    expect(git(tree, ['diff', '--name-only'])).toBe('scripts/shift/x.ts\n')
  })

  it('a card the bus cannot read refuses and writes nothing', () => {
    const { tree, probes, ports } = scene()
    writeFileSync(path.join(tree, 'scripts', 'shift', 'x.ts'), 'export const x = 2\n')

    expect(runOwnerCommand(ARGV(tree), { ...ports, touches: () => null })).toBe(1)

    expect(existsSync(probeDirOf(probes, CARD))).toBe(false)
  })

  it('a tree with no change against HEAD refuses and writes nothing', () => {
    const { tree, probes, ports } = scene()

    expect(runOwnerCommand(ARGV(tree), ports)).toBe(1)

    expect(existsSync(probeDirOf(probes, CARD))).toBe(false)
  })

  it.each([
    [[]],
    [['--tree', '/x', '--card', '0', '--message', 'm']],
    [['--tree', '/x', '--card', '1']],
    [['--tree', '/x', '--card', '1', '--message', 'm', 'extra']],
  ])('usage %j exits 2', (argv) => {
    const { ports } = scene()
    expect(runOwnerCommand(argv, ports)).toBe(2)
  })

  it('quotes a message with a single quote so the shell commits it verbatim', () => {
    expect(ownerCommand('/p/claude.patch', `it's`)).toBe(`git apply --index '/p/claude.patch' && git commit -q -m 'it'\\''s'\n`)
  })
})
