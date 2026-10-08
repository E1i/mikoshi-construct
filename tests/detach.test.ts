import type { Ui, Writer } from '../src/ui/console.js'
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ATTACH_RECORD_FILE, EXCLUDE_FILE, readAttachRecord, runAttach, SETTINGS_FILE } from '../src/commands/attach/index.js'
import { runDetach } from '../src/commands/detach/index.js'
import { runInit } from '../src/commands/init.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { PLAIN_LORE } from '../src/ui/lore.js'
import { resolveTheme } from '../src/ui/theme.js'
import { useIsolatedHome } from './isolated-home.js'
import { listing } from './repository-listing.js'

const EXISTING_MONOREPO = path.join(import.meta.dirname, 'fixtures/existing-monorepo')
const HARNESS = 'pnpm run quality'
const ADOPTED = 'scripts/construct/implement.workflow'

const ui = createUi(resolveTheme({ plain: true }), silentWriter)
const home = useIsolatedHome()

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
  return { files: [...Object.keys(record.files), SETTINGS_FILE], directories: record.directories }
}

function removedLines(output: string): string[] {
  return output.split('\n').flatMap((line) => {
    const match = /^\s+- (\S+)$/.exec(line)
    return match == null ? [] : [match[1]]
  })
}

describe('a4: attach then detach is the identity on a clean repository', () => {
  it('restores ls-files, status, the exclude bytes and the listing, and reports the 23 recorded paths', async () => {
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
    expect(removed).toHaveLength(23)
    expect(result.removed).toHaveLength(23)
    expect(output()).toContain(PLAIN_LORE.detached(23))
    expect(output()).not.toContain('JACKED')
  })
})

describe('the ledger directory: detach removes it only when the record says attach created it', () => {
  it('keeps an empty .construct/ that existed before attach, and records that attach did not create it', async () => {
    const dir = fixture()
    mkdirSync(path.join(dir, '.construct'))
    await attached(dir)
    expect(readAttachRecord(dir)?.ledgerCreated).toBe(false)

    const result = runDetach(ui, { dir })

    expect(result.status).toBe('done')
    expect(existsSync(path.join(dir, '.construct'))).toBe(true)
  })

  it('records that attach created .construct/ when it was absent, and detach removes it once empty', async () => {
    const dir = fixture()
    await attached(dir)
    expect(readAttachRecord(dir)?.ledgerCreated).toBe(true)

    expect(runDetach(ui, { dir }).status).toBe('done')
    expect(existsSync(path.join(dir, '.construct'))).toBe(false)
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
  it('leaves the ledger and a local settings file, names both, shows them as untracked once the block is gone, and counts 21', async () => {
    const dir = fixture()
    const before = snapshot(dir)
    await attached(dir)
    writeFileSync(path.join(dir, '.construct/runs.jsonl'), '{"run":"r1"}\n')
    writeFileSync(path.join(dir, '.construct/notes.txt'), 'mine\n')
    writeFileSync(path.join(dir, '.claude/settings.local.json'), '{}\n')
    const { ui: plain, output } = capturing()

    const result = runDetach(plain, { dir })

    expect(result.status).toBe('done')
    const after = snapshot(dir)
    expect(after.lsFiles).toBe(before.lsFiles)
    expect(after.status).toBe(`${before.status}?? .claude/\n?? .construct/\n`)
    expect(before.exclude).not.toBeNull()
    expect(after.exclude?.equals(before.exclude ?? Buffer.alloc(0))).toBe(true)
    expect(after.listing).toEqual([...before.listing, '.claude/', '.claude/settings.local.json', '.construct/', '.construct/notes.txt'].sort())
    expect(output()).toContain(PLAIN_LORE.detachLeftBehind('.claude/settings.local.json'))
    expect(output()).not.toContain(PLAIN_LORE.detachLeftBehind('.construct/runs.jsonl'))
    expect(output()).toContain(PLAIN_LORE.detachLeftBehind('.construct/notes.txt'))
    expect(result.removed).toHaveLength(22)
    expect(output()).toContain(PLAIN_LORE.detached(22))
  })
})

describe('a carrier that is not what attach wrote', () => {
  it('already absent: named, not counted, its emptied directory removed, count 22', async () => {
    const dir = fixture()
    const before = snapshot(dir)
    await attached(dir)
    rmSync(path.join(dir, '.claude/commands/plan.md'))
    const { ui: plain, output } = capturing()

    const result = runDetach(plain, { dir })

    expect(result.status).toBe('done')
    expect(output()).toContain(PLAIN_LORE.detachAlreadyAbsent('.claude/commands/plan.md'))
    expect(result.removed).toHaveLength(22)
    expect(output()).toContain(PLAIN_LORE.detached(22))
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

  it('adopted: a carrier committed with git add -f stays with its directory, count 21', async () => {
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
    expect(result.removed).toHaveLength(21)
    expect(output()).toContain(PLAIN_LORE.detached(21))
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
      expect(record.files).toHaveLength(15)
    })
  }
})

const FROZEN_RECORD_V1 = path.join(import.meta.dirname, 'fixtures/attach/record-v1')

function withFrozenRecordV1(dir: string): string[] {
  cpSync(path.join(FROZEN_RECORD_V1, 'tree'), dir, { recursive: true })
  mkdirSync(path.join(dir, '.construct'), { recursive: true })
  cpSync(path.join(FROZEN_RECORD_V1, 'record.json'), path.join(dir, ATTACH_RECORD_FILE))
  const record = JSON.parse(readFileSync(path.join(FROZEN_RECORD_V1, 'record.json'), 'utf8')) as { files: Record<string, string>, directories: string[] }
  return [...Object.keys(record.files), ...record.directories]
}

function rewriteRecordVersion(dir: string, value: unknown): void {
  const file = path.join(dir, ATTACH_RECORD_FILE)
  const record = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  if (value === undefined)
    delete record.recordVersion
  else
    record.recordVersion = value
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`)
}

describe('the record version detach reads', () => {
  it('detaches from a frozen version-1 record written by an earlier build, keeping .construct/, which that record does not say it created', () => {
    const dir = fixture()
    const recorded = withFrozenRecordV1(dir)

    const result = runDetach(ui, { dir })

    expect(result.status).toBe('done')
    expect([...result.removed].sort()).toEqual([...recorded].sort())
    expect(existsSync(path.join(dir, '.construct'))).toBe(true)
  })

  it('refuses a record written by a newer construct, names both versions and removes nothing', async () => {
    const dir = fixture()
    await attached(dir)
    rewriteRecordVersion(dir, 3)
    const before = listing(dir)
    const { ui: plain, output } = capturing()

    const result = runDetach(plain, { dir })

    expect(result.status).toBe('refused')
    expect(result.refusal).toBe('record-ahead')
    expect(listing(dir)).toEqual(before)
    expect(output()).toContain(PLAIN_LORE.recordAhead(ATTACH_RECORD_FILE, 'recordVersion', 3, 2))
  })

  for (const value of [undefined, '1', 1.5, null, 0]) {
    it(`${JSON.stringify(value) ?? 'missing'}: a recordVersion that is not a known integer is refused with its own reason, nothing removed`, async () => {
      const dir = fixture()
      await attached(dir)
      rewriteRecordVersion(dir, value)
      const before = listing(dir)
      const { ui: plain, output } = capturing()

      const result = runDetach(plain, { dir })

      expect(result.status).toBe('refused')
      expect(result.refusal).toBe('record-version')
      expect(listing(dir)).toEqual(before)
      expect(output()).toContain(PLAIN_LORE.detachRefusedRecordVersion)
      expect(output()).toContain(String(value))
    })
  }
})

describe('the bytes before the block are no longer the separator attach wrote', () => {
  it('refuses instead of cutting the owner\'s bytes: nothing removed, exclude untouched', async () => {
    const dir = fixture()
    await attached(dir)
    const file = path.join(dir, EXCLUDE_FILE)
    const edited = readFileSync(file, 'utf8').replace('\n\n# construct:begin', '\n# construct:begin')
    expect(edited).not.toBe(readFileSync(file, 'utf8'))
    writeFileSync(file, edited)
    const before = listing(dir)
    const { ui: plain, output } = capturing()

    const result = runDetach(plain, { dir })

    expect(result.status).toBe('refused')
    expect(result.refusal).toBe('separator-mismatch')
    expect(listing(dir)).toEqual(before)
    expect(readFileSync(file, 'utf8')).toBe(edited)
    expect(existsSync(path.join(dir, ATTACH_RECORD_FILE))).toBe(true)
    expect(output()).toContain(PLAIN_LORE.detachRefusedSeparatorMismatch)
  })
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

const GUARD_ENTRY = {
  matcher: 'Bash',
  hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR"/.construct/commit-guard.mjs', timeout: 30 }],
}

function readSettings(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(dir, SETTINGS_FILE), 'utf8')) as Record<string, unknown>
}

function writeSettings(dir: string, content: unknown): void {
  mkdirSync(path.join(dir, '.claude'), { recursive: true })
  writeFileSync(path.join(dir, SETTINGS_FILE), `${JSON.stringify(content, null, 2)}\n`)
}

function rewriteRecord(dir: string, change: (record: Record<string, unknown>) => void): void {
  const file = path.join(dir, ATTACH_RECORD_FILE)
  const record = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  change(record)
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`)
}

describe('the commit guard: detach takes out the entry attach added and nothing else', () => {
  it('the commit guard: a file whose other parts changed loses only the entry, and the entry line is reported but not counted', async () => {
    const dir = fixture()
    writeSettings(dir, { permissions: { allow: ['Bash(ls:*)'] }, hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'true' }] }] } })
    await attached(dir)
    const settings = readSettings(dir) as { permissions: { allow: string[] }, hooks: Record<string, unknown> }
    settings.permissions.allow.push('Bash(make:*)')
    settings.hooks.PostToolUse = [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'true' }] }]
    writeSettings(dir, settings)
    const { ui: plain, output } = capturing()

    const result = runDetach(plain, { dir })

    expect(result.status).toBe('done')
    const after = readSettings(dir) as { hooks: { PreToolUse: unknown[] } }
    expect(after.hooks.PreToolUse).toEqual([{ matcher: 'Edit', hooks: [{ type: 'command', command: 'true' }] }])
    expect(after).toEqual({ ...settings, hooks: { ...settings.hooks, PreToolUse: after.hooks.PreToolUse } })
    expect(existsSync(path.join(dir, '.construct'))).toBe(false)
    expect(output()).toContain(PLAIN_LORE.detachEntryRemoved(SETTINGS_FILE))
    expect(removedLines(output())).not.toContain(SETTINGS_FILE)
  })

  it('the commit guard: a file attach created keeps grants added after attach, while the empty PreToolUse and hooks go', async () => {
    const dir = fixture()
    await attached(dir)
    writeSettings(dir, { ...readSettings(dir), permissions: { allow: ['Bash(ls:*)'] } })

    expect(runDetach(ui, { dir }).status).toBe('done')

    expect(readSettings(dir)).toEqual({ permissions: { allow: ['Bash(ls:*)'] } })
  })

  it('the commit guard: an edited entry is refused as changed, naming the settings file, and nothing is removed', async () => {
    const dir = fixture()
    await attached(dir)
    writeSettings(dir, { hooks: { PreToolUse: [{ ...GUARD_ENTRY, hooks: [{ ...GUARD_ENTRY.hooks[0], timeout: 5 }] }] } })
    const before = snapshot(dir)
    const { ui: plain, output } = capturing()

    const result = runDetach(plain, { dir })

    expect(result.status).toBe('refused')
    expect(result.refusal).toBe('changed')
    expect(output()).toContain(PLAIN_LORE.detachRefusedChanged(1))
    expect(output()).toContain(SETTINGS_FILE)
    expectSameSnapshot(snapshot(dir), before)
    expect(existsSync(path.join(dir, ATTACH_RECORD_FILE))).toBe(true)
  })

  it('the commit guard: an entry deleted by hand is named as already absent and the guard script is still removed', async () => {
    const dir = fixture()
    await attached(dir)
    writeSettings(dir, { hooks: { PreToolUse: [] } })
    const { ui: plain, output } = capturing()

    const result = runDetach(plain, { dir })

    expect(result.status).toBe('done')
    expect(output()).toContain(PLAIN_LORE.detachAlreadyAbsent(PLAIN_LORE.detachSettingsEntry))
    expect(output()).toContain(`already absent: ${SETTINGS_FILE}`)
    expect(existsSync(path.join(dir, '.construct/commit-guard.mjs'))).toBe(false)
  })

  it('the commit guard: a settings file that became tracked is left byte for byte and named as adopted', async () => {
    const dir = fixture()
    await attached(dir)
    git(dir, 'add', '-f', SETTINGS_FILE)
    git(dir, 'commit', '-qm', 'adopt the settings')
    const bytes = readFileSync(path.join(dir, SETTINGS_FILE))
    const { ui: plain, output } = capturing()

    const result = runDetach(plain, { dir })

    expect(result.status).toBe('done')
    expect(readFileSync(path.join(dir, SETTINGS_FILE)).equals(bytes)).toBe(true)
    expect(output()).toContain(PLAIN_LORE.detachAdopted(PLAIN_LORE.detachSettingsEntry))
  })

  const HOOK_RECORDS: { name: string, change: (record: Record<string, unknown>) => void }[] = [
    { name: 'a version-2 record without settingsHook', change: (record) => { delete record.settingsHook } },
    { name: 'a settingsHook that names another path', change: (record) => { record.settingsHook = { ...(record.settingsHook as object), file: '.claude/settings.json' } } },
    { name: 'a settingsHook whose entry does not name the guard', change: (record) => { record.settingsHook = { ...(record.settingsHook as object), entry: { matcher: 'Bash' } } } },
  ]

  for (const hookRecord of HOOK_RECORDS) {
    it(`the commit guard: ${hookRecord.name} is refused as hook-record, removing nothing`, async () => {
      const dir = fixture()
      await attached(dir)
      rewriteRecord(dir, hookRecord.change)
      const before = snapshot(dir)
      const { ui: plain, output } = capturing()

      const result = runDetach(plain, { dir })

      expect(result.status).toBe('refused')
      expect(result.refusal).toBe('hook-record')
      expect(output()).toContain(PLAIN_LORE.detachRefusedHookRecord)
      expectSameSnapshot(snapshot(dir), before)
    })
  }

  it('the commit guard: a settings file that no longer parses is refused as settings-unreadable, removing nothing', async () => {
    const dir = fixture()
    await attached(dir)
    writeFileSync(path.join(dir, SETTINGS_FILE), '{ nope')
    const before = snapshot(dir)
    const { ui: plain, output } = capturing()

    const result = runDetach(plain, { dir })

    expect(result.status).toBe('refused')
    expect(result.refusal).toBe('settings-unreadable')
    expect(output()).toContain(PLAIN_LORE.detachRefusedSettingsUnreadable)
    expectSameSnapshot(snapshot(dir), before)
  })

  it('the commit guard: a version-1 record seeks no entry and leaves the settings file alone', () => {
    const dir = fixture()
    withFrozenRecordV1(dir)
    writeSettings(dir, { hooks: { PreToolUse: [GUARD_ENTRY] } })
    const bytes = readFileSync(path.join(dir, SETTINGS_FILE))

    expect(runDetach(ui, { dir }).status).toBe('done')

    expect(readFileSync(path.join(dir, SETTINGS_FILE)).equals(bytes)).toBe(true)
  })
})

const RUNTIME_FILES = ['runs.jsonl', 'steps.jsonl', 'implement-agreed.txt', 'implement-args.json'].map(name => `.construct/${name}`)
const RUN_DIRECTORY = '.construct/browser/20261007T101010123Z-4242'

function statusWithIgnored(dir: string): string {
  return git(dir, 'status', '--ignored', '--porcelain', '--untracked-files=all')
}

function filesInHome(): string[] {
  return listing(home()).filter(entry => !entry.endsWith('/'))
}

function writeHostSettings(dir: string, content: string): void {
  mkdirSync(path.join(dir, '.claude'), { recursive: true })
  writeFileSync(path.join(dir, SETTINGS_FILE), content)
}

function writeRuntime(dir: string): void {
  mkdirSync(path.join(dir, RUN_DIRECTORY), { recursive: true })
  for (const target of RUNTIME_FILES)
    writeFileSync(path.join(dir, target), '{}\n')
  writeFileSync(path.join(dir, RUN_DIRECTORY, '1280.png'), '')
}

function keptCopy(dir: string): string {
  const copy = readAttachRecord(dir)?.settingsHook?.original?.copy
  if (copy == null)
    throw new Error('attach kept no copy')
  return copy
}

function present(dir: string, target: string): boolean {
  return existsSync(path.join(dir, target))
}

const HOST_SETTINGS: Record<string, string> = {
  'compact with no final newline': '{"permissions":{"allow":["Bash(ls:*)"]}}',
  'two-space with a final newline': '{\n  "permissions": {\n    "allow": [\n      "Bash(ls:*)"\n    ]\n  }\n}\n',
  'tab-indented with a number and an escape attach cannot reproduce': '{\n\t"a":1e2,\n\t"name":"caf\\u00e9"\n}\n',
}

describe('detach leaves no trace of the guest in the repository or under the home directory', () => {
  it('after attach, the ladder\'s runtime writes and detach, git status --ignored equals the status before attach', async () => {
    const dir = fixture()
    const before = statusWithIgnored(dir)
    await attached(dir)
    writeRuntime(dir)

    expect(runDetach(ui, { dir }).status).toBe('done')

    expect(statusWithIgnored(dir)).toBe(before)
    expect(statusWithIgnored(dir)).toBe('')
    expect(filesInHome()).toEqual([])
  })

  for (const [name, original] of Object.entries(HOST_SETTINGS)) {
    it(`a host settings file ${name} is byte-identical and git status equals the status before attach`, async () => {
      const dir = fixture()
      writeHostSettings(dir, original)
      const before = statusWithIgnored(dir)
      await attached(dir)
      writeRuntime(dir)

      expect(runDetach(ui, { dir }).status).toBe('done')

      expect(readFileSync(path.join(dir, SETTINGS_FILE)).equals(Buffer.from(original))).toBe(true)
      expect(statusWithIgnored(dir)).toBe(before)
      expect(filesInHome()).toEqual([])
    })
  }

  it('a record without original restores nothing and cuts the entry as before', async () => {
    const dir = fixture()
    const host = { permissions: { allow: ['Bash(ls:*)'] } }
    writeHostSettings(dir, JSON.stringify(host))
    await attached(dir)
    const copy = keptCopy(dir)
    rewriteRecord(dir, (record) => {
      delete (record.settingsHook as Record<string, unknown>).original
    })

    expect(runDetach(ui, { dir }).status).toBe('done')

    expect(readFileSync(path.join(dir, SETTINGS_FILE), 'utf8')).toBe(`${JSON.stringify(host, null, 2)}\n`)
    expect(existsSync(copy)).toBe(true)
  })

  it('a settings file the host edited during the session is cut, not overwritten, and the copy is removed', async () => {
    const dir = fixture()
    writeHostSettings(dir, '{"permissions":{"allow":["Bash(ls:*)"]}}')
    await attached(dir)
    const copy = keptCopy(dir)
    const edited = readSettings(dir) as { permissions: { allow: string[] } }
    edited.permissions.allow.push('Bash(make:*)')
    writeSettings(dir, edited)

    expect(runDetach(ui, { dir }).status).toBe('done')

    expect(readSettings(dir)).toEqual({ permissions: { allow: ['Bash(ls:*)', 'Bash(make:*)'] } })
    expect(existsSync(copy)).toBe(false)
    expect(filesInHome()).toEqual([])
  })

  it('a settings file whose guard entry the host already took out is not written and the copy is removed', async () => {
    const dir = fixture()
    writeHostSettings(dir, '{"permissions":{"allow":["Bash(ls:*)"]}}')
    await attached(dir)
    const copy = keptCopy(dir)
    writeHostSettings(dir, '{"mine":true}')

    expect(runDetach(ui, { dir }).status).toBe('done')

    expect(readFileSync(path.join(dir, SETTINGS_FILE), 'utf8')).toBe('{"mine":true}')
    expect(existsSync(copy)).toBe(false)
  })
})

describe('the copy attach kept is checked before detach writes anything', () => {
  const MISMATCHES: Record<string, (copy: string) => void> = {
    'changed bytes': copy => writeFileSync(copy, 'tampered'),
    'a deleted copy': copy => rmSync(copy),
  }

  it('detach refuses and writes nothing when the copy does not match its recorded sha256', async () => {
    for (const [name, arrange] of Object.entries(MISMATCHES)) {
      const dir = fixture()
      writeHostSettings(dir, '{"permissions":{"allow":[]}}')
      await attached(dir)
      const copy = keptCopy(dir)
      arrange(copy)
      const before = snapshot(dir)
      const record = readFileSync(path.join(dir, ATTACH_RECORD_FILE))
      const homeBefore = listing(home())
      const settingsBefore = readFileSync(path.join(dir, SETTINGS_FILE))

      const result = runDetach(ui, { dir })

      expect(result.status, name).toBe('refused')
      expect(result.refusal, name).toBe('original-copy')
      expectSameSnapshot(snapshot(dir), before)
      expect(readFileSync(path.join(dir, ATTACH_RECORD_FILE)).equals(record), name).toBe(true)
      expect(readFileSync(path.join(dir, SETTINGS_FILE)).equals(settingsBefore), name).toBe(true)
      expect(listing(home()), name).toEqual(homeBefore)
    }
  })

  it('a copy that does not match is kept as the witness', async () => {
    const dir = fixture()
    writeHostSettings(dir, '{"permissions":{"allow":[]}}')
    await attached(dir)
    const copy = keptCopy(dir)
    writeFileSync(copy, 'tampered')

    expect(runDetach(ui, { dir }).status).toBe('refused')

    expect(readFileSync(copy, 'utf8')).toBe('tampered')
  })

  it('a matched copy is removed with its directory and ~/.construct/attach, and ~/.construct stays', async () => {
    const dir = fixture()
    writeHostSettings(dir, '{"permissions":{"allow":[]}}')
    await attached(dir)
    const copy = keptCopy(dir)

    expect(runDetach(ui, { dir }).status).toBe('done')

    expect(existsSync(copy)).toBe(false)
    expect(existsSync(path.dirname(copy))).toBe(false)
    expect(existsSync(path.join(home(), '.construct/attach'))).toBe(false)
    expect(existsSync(path.join(home(), '.construct'))).toBe(true)
  })

  it('a record whose original copy lies outside the attach directory is refused as original-copy and the file it names is untouched', async () => {
    const dir = fixture()
    writeHostSettings(dir, '{"permissions":{"allow":[]}}')
    await attached(dir)
    const victim = path.join(dir, 'victim.txt')
    writeFileSync(victim, 'not a copy\n')
    rewriteRecord(dir, (record) => {
      const original = (record.settingsHook as { original: Record<string, string> }).original
      original.copy = victim
      original.sha256 = createHash('sha256').update('not a copy\n').digest('hex')
    })
    const before = snapshot(dir)

    const result = runDetach(ui, { dir })

    expect(result.refusal).toBe('original-copy')
    expect(readFileSync(victim, 'utf8')).toBe('not a copy\n')
    expectSameSnapshot(snapshot(dir), before)
  })
})

describe('the runtime files the ladder writes come off a closed list', () => {
  it('a listed file the host tracks in git is never removed', async () => {
    const dir = fixture()
    await attached(dir)
    writeFileSync(path.join(dir, '.construct/runs.jsonl'), '{"run":"tracked"}\n')
    git(dir, 'add', '-f', '.construct/runs.jsonl')
    git(dir, 'commit', '-qm', 'track the ledger')
    const { ui: plain, output } = capturing()

    expect(runDetach(plain, { dir }).status).toBe('done')

    expect(readFileSync(path.join(dir, '.construct/runs.jsonl'), 'utf8')).toBe('{"run":"tracked"}\n')
    expect(output()).toContain(PLAIN_LORE.detachLeftBehind('.construct/runs.jsonl'))
  })

  it('a listed file present at attach stays', async () => {
    const dir = fixture()
    mkdirSync(path.join(dir, '.construct'))
    writeFileSync(path.join(dir, '.construct/runs.jsonl'), '{"run":"mine"}\n')
    await attached(dir)
    expect(readAttachRecord(dir)?.ledgerHeld).toEqual(['.construct/runs.jsonl'])
    writeFileSync(path.join(dir, '.construct/steps.jsonl'), '{}\n')

    expect(runDetach(ui, { dir }).status).toBe('done')

    expect(readFileSync(path.join(dir, '.construct/runs.jsonl'), 'utf8')).toBe('{"run":"mine"}\n')
    expect(present(dir, '.construct/steps.jsonl')).toBe(false)
  })

  it('a host file in .construct/ that is not on the list stays and is named left behind', async () => {
    const dir = fixture()
    await attached(dir)
    writeFileSync(path.join(dir, '.construct/notes.txt'), 'mine\n')
    const { ui: plain, output } = capturing()

    expect(runDetach(plain, { dir }).status).toBe('done')

    expect(readFileSync(path.join(dir, '.construct/notes.txt'), 'utf8')).toBe('mine\n')
    expect(output()).toContain(PLAIN_LORE.detachLeftBehind('.construct/notes.txt'))
  })

  it('a run directory with a non-png entry, or a name off the pattern, stays', async () => {
    const dir = fixture()
    await attached(dir)
    const withNote = '.construct/browser/20261007T101010123Z-1'
    const offPattern = '.construct/browser/latest'
    mkdirSync(path.join(dir, withNote), { recursive: true })
    mkdirSync(path.join(dir, offPattern), { recursive: true })
    writeFileSync(path.join(dir, withNote, '1280.png'), '')
    writeFileSync(path.join(dir, withNote, 'notes.txt'), 'mine\n')
    writeFileSync(path.join(dir, offPattern, '1280.png'), '')

    expect(runDetach(ui, { dir }).status).toBe('done')

    expect(present(dir, `${withNote}/1280.png`)).toBe(true)
    expect(present(dir, `${withNote}/notes.txt`)).toBe(true)
    expect(present(dir, `${offPattern}/1280.png`)).toBe(true)
  })

  it('a run directory of only png files is removed with .construct/browser when it was not there at attach', async () => {
    const dir = fixture()
    await attached(dir)
    writeRuntime(dir)
    const { ui: plain, output } = capturing()

    const result = runDetach(plain, { dir })

    expect(result.removed).toEqual(expect.arrayContaining([`${RUN_DIRECTORY}/1280.png`, RUN_DIRECTORY, '.construct/browser', ...RUNTIME_FILES]))
    expect(removedLines(output())).toEqual(expect.arrayContaining([`${RUN_DIRECTORY}/1280.png`, RUN_DIRECTORY, '.construct/browser']))
    expect(present(dir, '.construct/browser')).toBe(false)
  })

  it('a run directory under a .construct/browser present at attach stays', async () => {
    const dir = fixture()
    mkdirSync(path.join(dir, '.construct/browser'), { recursive: true })
    writeRuntime(dir)
    await attached(dir)
    const { ui: plain, output } = capturing()

    expect(runDetach(plain, { dir }).status).toBe('done')

    expect(present(dir, `${RUN_DIRECTORY}/1280.png`)).toBe(true)
    expect(present(dir, RUN_DIRECTORY)).toBe(true)
    expect(present(dir, '.construct/browser')).toBe(true)
    expect(output()).toContain(PLAIN_LORE.detachLeftBehind('.construct/browser'))
  })

  it('removes the run directories the guest created inside a .construct/browser that existed before attach', async () => {
    const dir = fixture()
    const earlier = '.construct/browser/20200101T000000000Z-1'
    mkdirSync(path.join(dir, '.construct/browser', path.basename(earlier)), { recursive: true })
    writeFileSync(path.join(dir, earlier, '1280.png'), 'mine')
    writeFileSync(path.join(dir, '.construct/browser/notes.txt'), 'mine\n')
    await attached(dir)
    const attachedAt = readAttachRecord(dir)?.attachedAt ?? ''
    const later = `.construct/browser/${new Date(Date.parse(attachedAt) + 1000).toISOString().replace(/[-:.]/g, '')}-4242`
    mkdirSync(path.join(dir, later), { recursive: true })
    writeFileSync(path.join(dir, later, '1280.png'), '')
    const { ui: plain, output } = capturing()

    const result = runDetach(plain, { dir })

    expect(result.status).toBe('done')
    expect(result.removed).toEqual(expect.arrayContaining([`${later}/1280.png`, later]))
    expect(present(dir, later)).toBe(false)
    expect(readFileSync(path.join(dir, earlier, '1280.png'), 'utf8')).toBe('mine')
    expect(readFileSync(path.join(dir, '.construct/browser/notes.txt'), 'utf8')).toBe('mine\n')
    expect(removedLines(output())).not.toContain('.construct/browser')
  })

  it('a run directory under a .construct/browser present at attach with a non-png entry stays even when the guest created it', async () => {
    const dir = fixture()
    mkdirSync(path.join(dir, '.construct/browser'), { recursive: true })
    await attached(dir)
    const attachedAt = readAttachRecord(dir)?.attachedAt ?? ''
    const later = `.construct/browser/${new Date(Date.parse(attachedAt) + 1000).toISOString().replace(/[-:.]/g, '')}-4242`
    mkdirSync(path.join(dir, later), { recursive: true })
    writeFileSync(path.join(dir, later, 'notes.txt'), 'mine\n')

    expect(runDetach(ui, { dir }).status).toBe('done')

    expect(present(dir, `${later}/notes.txt`)).toBe(true)
  })

  it('a run directory that existed before attach stays with a fresh mtime and a name stamped after attachedAt', async () => {
    const dir = fixture()
    const earlier = '.construct/browser/20991231T235959999Z-7'
    mkdirSync(path.join(dir, earlier), { recursive: true })
    writeFileSync(path.join(dir, earlier, '1280.png'), 'mine')
    await attached(dir)
    const now = new Date()
    utimesSync(path.join(dir, earlier), now, now)
    utimesSync(path.join(dir, earlier, '1280.png'), now, now)

    const result = runDetach(ui, { dir })

    expect(result.status).toBe('done')
    expect(result.removed).not.toContain(earlier)
    expect(readFileSync(path.join(dir, earlier, '1280.png'), 'utf8')).toBe('mine')
  })

  it('a record without browserHeld leaves every run directory in a .construct/browser present at attach', async () => {
    const dir = fixture()
    mkdirSync(path.join(dir, '.construct/browser'), { recursive: true })
    await attached(dir)
    rewriteRecord(dir, (record) => {
      delete record.browserHeld
    })
    writeRuntime(dir)

    expect(runDetach(ui, { dir }).status).toBe('done')

    expect(present(dir, `${RUN_DIRECTORY}/1280.png`)).toBe(true)
  })

  it('says the original bytes came back after a byte restore', async () => {
    const dir = fixture()
    writeHostSettings(dir, HOST_SETTINGS['two-space with a final newline'])
    await attached(dir)
    const { ui: plain, output } = capturing()

    expect(runDetach(plain, { dir }).status).toBe('done')

    expect(output()).toContain(PLAIN_LORE.detachOriginalRestored(SETTINGS_FILE))
    expect(output()).not.toContain(PLAIN_LORE.detachEntryRemoved(SETTINGS_FILE))
  })

  it('a record without ledgerHeld removes the list only when ledgerCreated is true', async () => {
    const dir = fixture()
    await attached(dir)
    rewriteRecord(dir, (record) => {
      delete record.ledgerHeld
    })
    writeRuntime(dir)

    expect(runDetach(ui, { dir }).status).toBe('done')

    expect(present(dir, '.construct')).toBe(false)
  })

  it('a record without ledgerHeld and with ledgerCreated false removes none', async () => {
    const dir = fixture()
    mkdirSync(path.join(dir, '.construct'))
    await attached(dir)
    rewriteRecord(dir, (record) => {
      delete record.ledgerHeld
    })
    writeRuntime(dir)

    expect(runDetach(ui, { dir }).status).toBe('done')

    for (const target of [...RUNTIME_FILES, `${RUN_DIRECTORY}/1280.png`])
      expect(present(dir, target), target).toBe(true)
  })
})
