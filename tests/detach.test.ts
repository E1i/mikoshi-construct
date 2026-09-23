import type { Ui, Writer } from '../src/ui/console.js'
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ATTACH_RECORD_FILE, EXCLUDE_FILE, readAttachRecord, runAttach } from '../src/commands/attach/index.js'
import { runDetach } from '../src/commands/detach/index.js'
import { runInit } from '../src/commands/init.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { PLAIN_LORE } from '../src/ui/lore.js'
import { resolveTheme } from '../src/ui/theme.js'

const EXISTING_MONOREPO = path.join(import.meta.dirname, 'fixtures/existing-monorepo')
const HARNESS = 'pnpm run quality'
const ADOPTED = 'scripts/construct/implement.workflow.mjs'

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

function fixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-detach-'))
  cpSync(EXISTING_MONOREPO, dir, { recursive: true })
  git(dir, 'init', '-q')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'base')
  return dir
}

function listing(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .map(entry => `${path.relative(dir, path.join(entry.parentPath, entry.name))}${entry.isDirectory() ? '/' : ''}`)
    .filter(entry => entry !== '.git/' && !entry.startsWith('.git/'))
    .sort()
}

interface Snapshot {
  lsFiles: string
  status: string
  exclude: Buffer | null
  listing: string[]
}

function snapshot(dir: string): Snapshot {
  const exclude = path.join(dir, EXCLUDE_FILE)
  return {
    lsFiles: git(dir, 'ls-files', '-s'),
    status: git(dir, 'status', '--porcelain'),
    exclude: existsSync(exclude) ? readFileSync(exclude) : null,
    listing: listing(dir),
  }
}

function expectSameSnapshot(after: Snapshot, before: Snapshot, listingAfter = before.listing): void {
  expect(after.lsFiles).toBe(before.lsFiles)
  expect(after.status).toBe(before.status)
  if (before.exclude == null)
    expect(after.exclude).toBeNull()
  else
    expect(after.exclude?.equals(before.exclude)).toBe(true)
  expect(after.listing).toEqual(listingAfter)
}

async function attached(dir: string): Promise<{ files: string[], directories: string[] }> {
  expect((await runAttach(ui, { dir, harness: HARNESS, yes: true })).status).toBe('done')
  const record = readAttachRecord(dir)
  if (record == null)
    throw new Error('attach wrote no record')
  return { files: Object.keys(record.files), directories: record.directories }
}

function removedLines(output: string): string[] {
  return output.split('\n').flatMap((line) => {
    const match = /^\s+- (\S+)$/.exec(line)
    return match == null ? [] : [match[1]]
  })
}

describe('a4: attach then detach is the identity on a clean repository', () => {
  it('restores ls-files, status, the exclude bytes and the listing, and reports the 12 recorded paths', async () => {
    const dir = fixture()
    const before = snapshot(dir)
    const record = await attached(dir)
    const { ui: plain, output } = capturing()

    const result = runDetach(plain, { dir })

    expect(result.status).toBe('done')
    expectSameSnapshot(snapshot(dir), before)
    for (const target of [...record.files, ...record.directories])
      expect(existsSync(path.join(dir, target)), target).toBe(false)
    expect(existsSync(path.join(dir, '.construct'))).toBe(false)
    const removed = removedLines(output())
    expect(removed.sort()).toEqual([...record.files, ...record.directories].sort())
    expect(removed).toHaveLength(12)
    expect(result.removed).toHaveLength(12)
    expect(output()).toContain(PLAIN_LORE.detached(12))
    expect(output()).not.toContain('JACKED')
  })
})

describe('a5: without a record', () => {
  it('state 1: a repository init wrote, with no record and no block, has nothing to detach', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'construct-detach-init-'))
    git(dir, 'init', '-q')
    expect((await runInit(ui, { dir, preset: 'node-library', yes: true, dryRun: false })).status).toBe('done')
    const before = listing(dir)
    const { ui: plain, output } = capturing()

    const result = runDetach(plain, { dir })

    expect(result.status).toBe('nothing-attached')
    expect(output()).toContain(PLAIN_LORE.detachNothingAttached)
    expect(listing(dir)).toEqual(before)
  })

  it('state 2: an exclude block without a record is refused, every block path marked as on disk, nothing written', async () => {
    const dir = fixture()
    const record = await attached(dir)
    rmSync(path.join(dir, ATTACH_RECORD_FILE))
    const before = snapshot(dir)
    const { ui: plain, output } = capturing()

    const result = runDetach(plain, { dir })

    expect(result.status).toBe('refused')
    expect(result.refusal).toBe('orphan-block')
    expect(output()).toContain(PLAIN_LORE.detachRefusedOrphanBlock)
    for (const target of ['.construct/', ...record.files])
      expect(output()).toContain(`${target}  ${PLAIN_LORE.detachPresentOnDisk}`)
    expect(output()).not.toContain(PLAIN_LORE.detachAbsentOnDisk)
    expectSameSnapshot(snapshot(dir), before)
  })
})

describe('a6: what attach did not write is never removed', () => {
  it('leaves the ledger and a local settings file, names both, shows them as untracked once the block is gone, and counts 11', async () => {
    const dir = fixture()
    const before = snapshot(dir)
    await attached(dir)
    writeFileSync(path.join(dir, '.construct/runs.jsonl'), '{"run":"r1"}\n')
    writeFileSync(path.join(dir, '.claude/settings.local.json'), '{}\n')
    const { ui: plain, output } = capturing()

    const result = runDetach(plain, { dir })

    expect(result.status).toBe('done')
    const after = snapshot(dir)
    expect(after.lsFiles).toBe(before.lsFiles)
    expect(after.status).toBe(`${before.status}?? .claude/\n?? .construct/\n`)
    expect(before.exclude).not.toBeNull()
    expect(after.exclude?.equals(before.exclude ?? Buffer.alloc(0))).toBe(true)
    expect(after.listing).toEqual([...before.listing, '.claude/', '.claude/settings.local.json', '.construct/', '.construct/runs.jsonl'].sort())
    expect(output()).toContain(PLAIN_LORE.detachLeftBehind('.claude/settings.local.json'))
    expect(output()).toContain(PLAIN_LORE.detachLeftBehind('.construct/runs.jsonl'))
    expect(result.removed).toHaveLength(11)
    expect(output()).toContain(PLAIN_LORE.detached(11))
  })
})

describe('a carrier that is not what attach wrote', () => {
  it('already absent: named, not counted, its emptied directory removed, count 11', async () => {
    const dir = fixture()
    const before = snapshot(dir)
    await attached(dir)
    rmSync(path.join(dir, '.claude/commands/plan.md'))
    const { ui: plain, output } = capturing()

    const result = runDetach(plain, { dir })

    expect(result.status).toBe('done')
    expect(output()).toContain(PLAIN_LORE.detachAlreadyAbsent('.claude/commands/plan.md'))
    expect(result.removed).toHaveLength(11)
    expect(output()).toContain(PLAIN_LORE.detached(11))
    expectSameSnapshot(snapshot(dir), before)
  })

  it('changed: refused naming the path, nothing removed, record and block still there', async () => {
    const dir = fixture()
    await attached(dir)
    appendFileSync(path.join(dir, '.claude/agents/harness.md'), '\nmine\n')
    const before = snapshot(dir)
    const { ui: plain, output } = capturing()

    const result = runDetach(plain, { dir })

    expect(result.status).toBe('refused')
    expect(result.refusal).toBe('changed')
    expect(output()).toContain(PLAIN_LORE.detachRefusedChanged(1))
    expect(output()).toContain('.claude/agents/harness.md')
    expectSameSnapshot(snapshot(dir), before)
    expect(existsSync(path.join(dir, ATTACH_RECORD_FILE))).toBe(true)
    expect(readFileSync(path.join(dir, EXCLUDE_FILE), 'utf8')).toContain('# construct:begin')
  })

  it('adopted: a carrier committed with git add -f stays with its directory, count 10', async () => {
    const dir = fixture()
    const before = snapshot(dir)
    await attached(dir)
    git(dir, 'add', '-f', ADOPTED)
    git(dir, 'commit', '-qm', 'adopt the ladder')
    const { ui: plain, output } = capturing()

    const result = runDetach(plain, { dir })

    expect(result.status).toBe('done')
    expect(existsSync(path.join(dir, ADOPTED))).toBe(true)
    expect(() => git(dir, 'ls-files', '--error-unmatch', ADOPTED)).not.toThrow()
    expect(output()).toContain(PLAIN_LORE.detachAdopted(ADOPTED))
    expect(result.removed).toHaveLength(10)
    expect(output()).toContain(PLAIN_LORE.detached(10))
    const after = snapshot(dir)
    expect(after.status).toBe(before.status)
    if (before.exclude != null)
      expect(after.exclude?.equals(before.exclude)).toBe(true)
    expect(after.listing).toEqual([...before.listing, 'scripts/construct/', ADOPTED].sort())
  })
})

describe('a4 over an exclude file git did not shape: the separator in the record makes the round trip exact', () => {
  const PRIORS: { name: string, content: string, separator: number }[] = [
    { name: 'no trailing newline', content: '# mine\nbuild/', separator: 2 },
    { name: 'one trailing newline', content: '# mine\nbuild/\n', separator: 1 },
    { name: 'two trailing newlines', content: '# mine\nbuild/\n\n', separator: 0 },
  ]

  for (const prior of PRIORS) {
    it(`${prior.name}: records separator ${prior.separator} and gives the file back byte for byte`, async () => {
      const dir = fixture()
      writeFileSync(path.join(dir, EXCLUDE_FILE), prior.content)
      const before = snapshot(dir)

      const record = await attached(dir)
      expect(readAttachRecord(dir)?.excludeSeparator).toBe(prior.separator)
      expect(runDetach(ui, { dir }).status).toBe('done')

      expectSameSnapshot(snapshot(dir), before)
      expect(readFileSync(path.join(dir, EXCLUDE_FILE), 'utf8')).toBe(prior.content)
      expect(record.files).toHaveLength(6)
    })
  }
})

describe('a record whose separator cannot be trusted', () => {
  for (const value of [undefined, 3, -1, '1']) {
    it(`${JSON.stringify(value)}: refuses, names the value and removes nothing`, async () => {
      const dir = fixture()
      await attached(dir)
      const file = path.join(dir, ATTACH_RECORD_FILE)
      const record = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      if (value === undefined)
        delete record.excludeSeparator
      else
        record.excludeSeparator = value
      writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`)
      const before = listing(dir)
      const { ui: plain, output } = capturing()

      const result = runDetach(plain, { dir })

      expect(result.status).toBe('refused')
      expect(result.refusal).toBe('separator')
      expect(listing(dir)).toEqual(before)
      expect(output()).toContain(PLAIN_LORE.detachRefusedSeparator)
      expect(output()).toContain(String(value))
    })
  }
})

describe('the exclude file after detach', () => {
  it('keeps a line appended by hand when attach created the file', async () => {
    const dir = fixture()
    rmSync(path.join(dir, '.git/info'), { recursive: true })
    await attached(dir)
    appendFileSync(path.join(dir, EXCLUDE_FILE), 'mine/\n')

    expect(runDetach(ui, { dir }).status).toBe('done')

    expect(readFileSync(path.join(dir, EXCLUDE_FILE), 'utf8')).toBe('mine/\n')
  })

  it('removes the file attach created when nothing else was written into it', async () => {
    const dir = fixture()
    rmSync(path.join(dir, '.git/info'), { recursive: true })
    await attached(dir)
    mkdirSync(path.join(dir, '.claude'), { recursive: true })

    expect(runDetach(ui, { dir }).status).toBe('done')

    expect(existsSync(path.join(dir, EXCLUDE_FILE))).toBe(false)
  })
})
