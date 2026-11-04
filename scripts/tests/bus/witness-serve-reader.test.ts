import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { serveRecordAt } from '../../ports/serve-record.js'

const IN_MANIFEST = { command: 'pnpm dev', url: 'http://127.0.0.1:4101/', readyTimeoutMs: 1_000 }
const IN_ATTACH = { command: 'npm start', url: 'http://127.0.0.1:4102/', readyTimeoutMs: 30_000 }
const EXECUTOR = path.resolve(import.meta.dirname, '../../nodes/witness/witness-executor.ts')

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, '-c', 'user.name=bus', '-c', 'user.email=bus@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim()
}

interface LinkedTree { repo: string, tree: string, head: string }

function linkedTree(tracked: Record<string, string> = {}): LinkedTree {
  const root = mkdtempSync(path.join(tmpdir(), 'serve-record-'))
  roots.push(root)
  const repo = path.join(root, 'repo')
  execFileSync('git', ['init', '-q', repo])
  for (const [file, text] of Object.entries({ 'README.md': 'base\n', ...tracked }))
    writeFileSync(path.join(repo, file), text)
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'base')
  const tree = path.join(root, 'tree')
  git(repo, 'worktree', 'add', '-q', '--detach', tree, 'HEAD')
  return { repo, tree, head: git(repo, 'rev-parse', 'HEAD') }
}

function attachRecord(repo: string, serve: unknown): void {
  mkdirSync(path.join(repo, '.construct'), { recursive: true })
  writeFileSync(path.join(repo, '.construct/attach.json'), JSON.stringify({ recordVersion: 4, serve }))
}

describe('the one reader of serve', () => {
  it('the witness node reads serve from construct.json or attach.json through one reader', () => {
    const declared = linkedTree({ 'construct.json': JSON.stringify({ serve: IN_MANIFEST }) })
    expect(serveRecordAt(declared.tree, declared.head)).toEqual(IN_MANIFEST)

    const attached = linkedTree()
    attachRecord(attached.repo, IN_ATTACH)
    expect(serveRecordAt(attached.tree, attached.head)).toEqual(IN_ATTACH)

    const executor = readFileSync(EXECUTOR, 'utf8')
    expect(executor).toContain('serveRecordAt(')
    expect(executor).not.toContain('MANIFEST_FILE')
  })

  it('a serve in construct.json at the head wins over one in the attach record', () => {
    const both = linkedTree({ 'construct.json': JSON.stringify({ serve: IN_MANIFEST }) })
    attachRecord(both.repo, IN_ATTACH)
    expect(serveRecordAt(both.tree, both.head)).toEqual(IN_MANIFEST)
  })

  it('reads nothing from a repository with neither record', () => {
    const neither = linkedTree()
    expect(serveRecordAt(neither.tree, neither.head)).toBeNull()
  })

  it('an attach record with no serve, a malformed serve or broken JSON reads as no serve', () => {
    const noServe = linkedTree()
    attachRecord(noServe.repo, undefined)
    expect(serveRecordAt(noServe.tree, noServe.head)).toBeNull()

    const malformed = linkedTree()
    attachRecord(malformed.repo, { command: 'npm start', url: 'not a url', readyTimeoutMs: 30_000 })
    expect(serveRecordAt(malformed.tree, malformed.head)).toBeNull()

    const broken = linkedTree()
    mkdirSync(path.join(broken.repo, '.construct'), { recursive: true })
    writeFileSync(path.join(broken.repo, '.construct/attach.json'), '{ not json')
    expect(serveRecordAt(broken.tree, broken.head)).toBeNull()
  })
})
