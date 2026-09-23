import type { Buffer } from 'node:buffer'
import type { Ui, Writer } from '../src/ui/console.js'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runAttach } from '../src/commands/attach/index.js'
import { readTrackedPaths, runDetach } from '../src/commands/detach/index.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { PLAIN_LORE } from '../src/ui/lore.js'
import { resolveTheme } from '../src/ui/theme.js'

const EXISTING_MONOREPO = path.join(import.meta.dirname, 'fixtures/existing-monorepo')
const HARNESS = 'pnpm run quality'

const ui = createUi(resolveTheme({ plain: true }), silentWriter)

function capturing(): { ui: Ui, output: () => string } {
  let text = ''
  const write: Writer = (chunk) => {
    text += chunk
  }
  return { ui: createUi(resolveTheme({ plain: true }), write), output: () => text }
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' })
}

function commitAll(dir: string): void {
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'base')
}

function fixture(...initArgs: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-detach-index-'))
  cpSync(EXISTING_MONOREPO, dir, { recursive: true })
  git(dir, 'init', '-q', ...initArgs)
  commitAll(dir)
  return dir
}

function nestedFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-detach-nested-'))
  git(dir, 'init', '-q')
  for (let depth = 0; depth < 4; depth += 1) {
    for (let branch = 0; branch < 4; branch += 1) {
      const directory = path.join(dir, ...Array.from({ length: depth + 1 }, (_, level) => `level-${level}-${branch}`))
      mkdirSync(directory, { recursive: true })
      for (let file = 0; file < 4; file += 1)
        writeFileSync(path.join(directory, `file-${file}.txt`), `${depth}/${branch}/${file}\n`)
    }
  }
  commitAll(dir)
  return dir
}

function lsFiles(dir: string): Set<string> {
  return new Set(git(dir, 'ls-files', '-z').split('\0').filter(entry => entry !== ''))
}

function indexBytes(dir: string): Buffer {
  return readFileSync(path.join(dir, '.git/index'))
}

function tracked(dir: string): Set<string> {
  const reading = readTrackedPaths(dir)
  if (!('tracked' in reading))
    throw new Error(`unreadable: ${reading.unreadable}`)
  return reading.tracked
}

function listing(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .map(entry => `${path.relative(dir, path.join(entry.parentPath, entry.name))}${entry.isDirectory() ? '/' : ''}`)
    .filter(entry => entry !== '.git/' && !entry.startsWith('.git/'))
    .sort()
}

describe('readTrackedPaths reads the same set git ls-files prints', () => {
  it('on the attach fixture', () => {
    const dir = fixture()
    const expected = lsFiles(dir)
    expect(expected.size).toBeGreaterThan(20)
    expect(tracked(dir)).toEqual(expected)
  })

  it('after git add -N, which writes a version 3 index with an extended flag', () => {
    const dir = fixture()
    writeFileSync(path.join(dir, 'intent.txt'), 'intent\n')
    git(dir, 'add', '-N', 'intent.txt')
    expect(indexBytes(dir).readUInt32BE(4)).toBe(3)
    const expected = lsFiles(dir)
    expect(expected).toContain('intent.txt')
    expect(tracked(dir)).toEqual(expected)
  })

  it('on a repository of 64 files in nested directories', () => {
    const dir = nestedFixture()
    const expected = lsFiles(dir)
    expect(expected.size).toBe(64)
    expect(tracked(dir)).toEqual(expected)
  })

  it('on a sha256 repository, whose entries carry 32-byte hashes', () => {
    const dir = fixture('--object-format=sha256')
    expect(readFileSync(path.join(dir, '.git/config'), 'utf8')).toMatch(/objectformat = sha256/i)
    const expected = lsFiles(dir)
    expect(expected.size).toBeGreaterThan(20)
    expect(tracked(dir)).toEqual(expected)
  })

  it('reads an empty set when there is no index yet', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'construct-detach-empty-'))
    git(dir, 'init', '-q')
    expect(readTrackedPaths(dir)).toEqual({ tracked: new Set() })
  })
})

interface UnreadableCase {
  name: string
  reason: 'index-v4' | 'split-index' | 'sparse-index' | 'object-format'
  plain: string
  arrange: (dir: string) => void
  proves: (dir: string) => void
}

const UNREADABLE: UnreadableCase[] = [
  {
    name: 'index version 4',
    reason: 'index-v4',
    plain: PLAIN_LORE.detachRefusedIndexV4,
    arrange: dir => git(dir, 'update-index', '--index-version', '4'),
    proves: dir => expect(indexBytes(dir).readUInt32BE(4)).toBe(4),
  },
  {
    name: 'split index',
    reason: 'split-index',
    plain: PLAIN_LORE.detachRefusedSplitIndex,
    arrange: dir => git(dir, 'update-index', '--split-index'),
    proves: dir => expect(indexBytes(dir).includes('link')).toBe(true),
  },
  {
    name: 'sparse index',
    reason: 'sparse-index',
    plain: PLAIN_LORE.detachRefusedSparseIndex,
    arrange: dir => git(dir, 'sparse-checkout', 'set', '--cone', '--sparse-index', 'packages'),
    proves: dir => expect(indexBytes(dir).includes('sdir')).toBe(true),
  },
  {
    name: 'an object format that is neither sha1 nor sha256',
    reason: 'object-format',
    plain: PLAIN_LORE.detachRefusedObjectFormat,
    arrange: dir => writeFileSync(path.join(dir, '.git/config'), `${readFileSync(path.join(dir, '.git/config'), 'utf8')}[extensions]\n\tobjectformat = sha3\n`),
    proves: dir => expect(readFileSync(path.join(dir, '.git/config'), 'utf8')).toContain('objectformat = sha3'),
  },
]

describe('an index detach cannot read is a refusal with its own reason', () => {
  for (const unreadable of UNREADABLE) {
    it(`${unreadable.name}: readTrackedPaths reports ${unreadable.reason}`, () => {
      const dir = fixture()
      unreadable.arrange(dir)
      unreadable.proves(dir)
      expect(readTrackedPaths(dir)).toEqual({ unreadable: unreadable.reason })
    })

    it(`${unreadable.name}: detach on an attached copy refuses and removes nothing`, async () => {
      const dir = fixture()
      expect((await runAttach(ui, { dir, harness: HARNESS, yes: true })).status).toBe('done')
      unreadable.arrange(dir)
      unreadable.proves(dir)
      const before = listing(dir)
      const { ui: plain, output } = capturing()

      const result = runDetach(plain, { dir })

      expect(result.status).toBe('refused')
      expect(result.refusal).toBe(unreadable.reason)
      expect(output()).toContain(unreadable.plain)
      expect(output()).not.toContain('BREACH')
      expect(listing(dir)).toEqual(before)
    })
  }
})
