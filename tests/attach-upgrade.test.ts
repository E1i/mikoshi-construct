import type { AttachRecord } from '../src/commands/attach/index.js'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BUS_DB_VARIABLE, BUS_FILE } from '../scripts/core/bus-path.js'
import { factoryHomeFor } from '../src/commands/attach/beside.js'
import { ATTACH_RECORD_FILE, EXCLUDE_FILE, planCarriers, readAttachRecord, readExcludeBlockPaths, runAttach, runAttachUpgrade, SETTINGS_FILE } from '../src/commands/attach/index.js'
import { attachedVersionOf, carriersReading, writeAttachRecord } from '../src/commands/attach/record.js'
import { browserLabExcludedCommand } from '../src/commands/attach/settings.js'
import { askDetach } from '../src/commands/detach/index.js'
import { printDoctor, runDoctor } from '../src/commands/doctor/index.js'
import { sha256 } from '../src/manifest.js'
import { ATTACH_CARRIERS } from '../src/presets/index.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { PLAIN_LORE } from '../src/ui/lore.js'
import { resolveTheme } from '../src/ui/theme.js'
import { VERSION } from '../src/version.js'
import { useIsolatedHome } from './isolated-home.js'

const EXISTING_MONOREPO = path.join(import.meta.dirname, 'fixtures/existing-monorepo')
const REPO_ROOT = path.join(import.meta.dirname, '..')
const STALE_CARRIER = 'scripts/construct/browser-lab.mjs'
const OLDER_BYTES = '// the template of an older build\n'
const OLDER_VERSION = '0.45.0'
const HANDOFF = 'handoff/miko.md'

const ui = createUi(resolveTheme({ plain: true }), silentWriter)
useIsolatedHome()
beforeEach(() => {
  vi.stubEnv(BUS_DB_VARIABLE, '')
})
afterEach(() => {
  vi.unstubAllEnvs()
})

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' })
}

function capturingUi(): { ui: ReturnType<typeof createUi>, output: () => string } {
  let captured = ''
  return {
    ui: createUi(resolveTheme({ plain: true }), (text) => {
      captured += text
    }),
    output: () => captured,
  }
}

function recordOf(dir: string): AttachRecord {
  const record = readAttachRecord(dir)
  if (record == null)
    throw new Error('no attach record')
  return record
}

async function attached(settingsBeforeAttach?: string): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-attach-upgrade-'))
  cpSync(EXISTING_MONOREPO, dir, { recursive: true })
  git(dir, 'init', '-q')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'base')
  if (settingsBeforeAttach != null) {
    mkdirSync(path.join(dir, '.claude'), { recursive: true })
    writeFileSync(path.join(dir, SETTINGS_FILE), settingsBeforeAttach)
  }
  expect((await runAttach(ui, { dir, harness: 'pnpm run quality', requiredCheck: 'gate', yes: true })).status).toBe('done')
  return dir
}

function olderBuild(dir: string, change: (record: AttachRecord) => void = () => {}): void {
  writeFileSync(path.join(dir, STALE_CARRIER), OLDER_BYTES)
  const record = recordOf(dir)
  delete record.attachedVersion
  record.construct = OLDER_VERSION
  record.files[STALE_CARRIER] = sha256(OLDER_BYTES)
  change(record)
  writeAttachRecord(dir, record)
}

function everyFile(root: string, relative = ''): string[] {
  return readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap((entry) => {
    const child = relative === '' ? entry.name : `${relative}/${entry.name}`
    if (entry.isDirectory())
      return child === '.git' ? [] : everyFile(root, child)
    return [child]
  })
}

function bytesOutside(dir: string, carriers: readonly string[]): Map<string, string> {
  const files = [...everyFile(dir), EXCLUDE_FILE].filter(file => !carriers.includes(file))
  return new Map(files.map(file => [file, readFileSync(path.join(dir, file), 'latin1')]))
}

describe('construct attach --upgrade', () => {
  it('rewrites only the attach carriers: the stale one comes to the installed template, every other file stays byte-identical', async () => {
    const dir = await attached()
    olderBuild(dir)
    const carriers = Object.keys(recordOf(dir).files)
    const planned = planCarriers(dir, recordOf(dir).harness).find(op => op.target === STALE_CARRIER)
    writeFileSync(path.join(dir, 'packages-note.txt'), 'mine\n')
    mkdirSync(path.join(dir, '.construct/subject'), { recursive: true })
    writeFileSync(path.join(dir, '.construct/subject/data.json'), '{"kept":true}\n')
    writeFileSync(path.join(dir, '.construct/runs.jsonl'), '{"run":1}\n')
    const before = bytesOutside(dir, [...carriers, ATTACH_RECORD_FILE])
    const recordBefore = recordOf(dir)

    const result = await runAttachUpgrade(ui, { dir, yes: true })

    expect(result).toEqual({ status: 'done', created: [], rewritten: [STALE_CARRIER], rolledBack: [] })
    expect(readFileSync(path.join(dir, STALE_CARRIER), 'utf8')).toBe(planned?.content)
    expect(bytesOutside(dir, [...carriers, ATTACH_RECORD_FILE])).toEqual(before)
    const record = recordOf(dir)
    expect(record.attachedVersion).toBe(VERSION)
    expect(record.files[STALE_CARRIER]).toBe(sha256(planned?.content ?? ''))
    expect({ ...record, attachedVersion: undefined, files: undefined }).toEqual({ ...recordBefore, attachedVersion: undefined, files: undefined })
  })

  it('keeps the handoff, the bus and the local settings, which detach and attach again do not', async () => {
    const beforeAttach = '{ "permissions": { "allow": ["Bash(ls)"] } }\n'
    const dir = await attached(beforeAttach)
    const home = factoryHomeFor(dir)
    if (home == null)
      throw new Error('no factory home')
    mkdirSync(path.join(home, 'handoff'), { recursive: true })
    writeFileSync(path.join(home, HANDOFF), 'where the window stopped\n')
    writeFileSync(path.join(home, BUS_FILE), 'bus bytes')
    const settings = JSON.parse(readFileSync(path.join(dir, SETTINGS_FILE), 'utf8')) as { permissions: { allow: string[] } }
    settings.permissions.allow.push('Bash(pnpm test)')
    const settingsBytes = `${JSON.stringify(settings, null, 2)}\n`
    writeFileSync(path.join(dir, SETTINGS_FILE), settingsBytes)
    olderBuild(dir)

    expect((await runAttachUpgrade(ui, { dir, yes: true })).status).toBe('done')

    expect(readFileSync(path.join(home, HANDOFF), 'utf8')).toBe('where the window stopped\n')
    expect(readFileSync(path.join(home, BUS_FILE), 'utf8')).toBe('bus bytes')
    expect(readFileSync(path.join(dir, SETTINGS_FILE), 'utf8')).toBe(settingsBytes)

    expect((await askDetach(ui, { dir, yes: true })).status).toBe('done')
    expect(existsSync(path.join(home, HANDOFF))).toBe(false)
    expect(existsSync(path.join(home, BUS_FILE))).toBe(false)
    expect(readFileSync(path.join(dir, SETTINGS_FILE), 'utf8')).not.toBe(settingsBytes)
  })

  it('creates a carrier the older build did not have, hides it and detach takes it away', async () => {
    const dir = await attached()
    const added = 'scripts/construct/daemon.mjs'
    olderBuild(dir, (record) => {
      delete record.files[added]
    })
    rmSync(path.join(dir, added))
    const exclude = path.join(dir, EXCLUDE_FILE)
    writeFileSync(exclude, readFileSync(exclude, 'utf8').replace(`${added}\n`, ''))

    const result = await runAttachUpgrade(ui, { dir, yes: true })

    expect(result.created).toEqual([added])
    expect(recordOf(dir).files[added]).toBeDefined()
    expect(git(dir, 'status', '--porcelain')).toBe('')
    expect(readExcludeBlockPaths(dir).filter(entry => entry === added)).toHaveLength(1)
    expect((await askDetach(ui, { dir, yes: true })).status).toBe('done')
    expect(existsSync(path.join(dir, added))).toBe(false)
    expect(git(dir, 'status', '--porcelain')).toBe('')
  })

  it('leaves a carrier the owner edited and refuses by name, writing nothing', async () => {
    const dir = await attached()
    olderBuild(dir)
    const edited = ATTACH_CARRIERS.targets[0]
    writeFileSync(path.join(dir, edited), 'my own edit\n')
    const before = bytesOutside(dir, [])
    const { ui: seen, output } = capturingUi()

    const result = await runAttachUpgrade(seen, { dir, yes: true })

    expect(result).toMatchObject({ status: 'refused', refusal: 'carrier-changed' })
    expect(bytesOutside(dir, [])).toEqual(before)
    expect(output()).toContain(edited)
  })

  it('never writes over a file at a new carrier path the record does not name', async () => {
    const dir = await attached()
    const added = 'scripts/construct/daemon.mjs'
    olderBuild(dir, (record) => {
      delete record.files[added]
    })
    writeFileSync(path.join(dir, added), 'mine\n')

    expect(await runAttachUpgrade(ui, { dir, yes: true })).toMatchObject({ status: 'refused', refusal: 'carrier-collision' })
    expect(readFileSync(path.join(dir, added), 'utf8')).toBe('mine\n')
  })

  it('refuses a carrier that became a symlink instead of writing through it', async () => {
    const dir = await attached()
    olderBuild(dir)
    const outside = path.join(mkdtempSync(path.join(tmpdir(), 'construct-outside-')), 'target')
    writeFileSync(outside, OLDER_BYTES)
    rmSync(path.join(dir, STALE_CARRIER))
    symlinkSync(outside, path.join(dir, STALE_CARRIER))

    expect(await runAttachUpgrade(ui, { dir, yes: true })).toMatchObject({ status: 'refused', refusal: 'carrier-changed' })
    expect(readFileSync(outside, 'utf8')).toBe(OLDER_BYTES)
  })

  it('leaves a carrier git has adopted as it is', async () => {
    const dir = await attached()
    olderBuild(dir)
    git(dir, 'add', '-f', STALE_CARRIER)
    git(dir, 'commit', '-qm', 'adopt')

    const result = await runAttachUpgrade(ui, { dir, yes: true })

    expect(result.status).toBe('done')
    expect(readFileSync(path.join(dir, STALE_CARRIER), 'utf8')).toBe(OLDER_BYTES)
    expect(git(dir, 'status', '--porcelain')).toBe('')
  })

  it('keeps the mode of a rewritten carrier', async () => {
    const dir = await attached()
    olderBuild(dir)
    chmodSync(path.join(dir, STALE_CARRIER), 0o755)

    await runAttachUpgrade(ui, { dir, yes: true })

    expect(statSync(path.join(dir, STALE_CARRIER)).mode & 0o777).toBe(0o755)
    expect(lstatSync(path.join(dir, STALE_CARRIER)).isFile()).toBe(true)
  })

  it('on an unattached repository refuses and writes nothing', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'construct-attach-upgrade-'))
    git(dir, 'init', '-q')

    expect(await runAttachUpgrade(ui, { dir, yes: true })).toMatchObject({ status: 'refused', refusal: 'not-attached' })
    expect(everyFile(dir)).toEqual([])
  })

  it('refuses a flag the record holds instead of ignoring it', async () => {
    const dir = await attached()
    expect(await runAttachUpgrade(ui, { dir, yes: true, harness: 'other' })).toMatchObject({ status: 'refused', refusal: 'upgrade-flags' })
    expect(recordOf(dir).harness).toMatchObject({ command: 'pnpm run quality' })
  })

  it('refuses a record from a later build and carriers a later build wrote', async () => {
    const dir = await attached()
    olderBuild(dir, (record) => {
      record.recordVersion = 99
    })
    expect(await runAttachUpgrade(ui, { dir, yes: true })).toMatchObject({ status: 'refused', refusal: 'record-ahead' })

    const later = await attached()
    olderBuild(later, (record) => {
      record.attachedVersion = '999.0.0'
    })
    expect(await runAttachUpgrade(ui, { dir: later, yes: true })).toMatchObject({ status: 'refused', refusal: 'carriers-ahead' })
    expect(readFileSync(path.join(later, STALE_CARRIER), 'utf8')).toBe(OLDER_BYTES)
  })

  it('without a terminal or --yes writes nothing', async () => {
    const dir = await attached()
    olderBuild(dir)

    expect((await runAttachUpgrade(ui, { dir, yes: false })).status).toBe('aborted')
    expect(readFileSync(path.join(dir, STALE_CARRIER), 'utf8')).toBe(OLDER_BYTES)
  })

  function withoutInstalledEntry(dir: string): void {
    const settings = JSON.parse(readFileSync(path.join(dir, SETTINGS_FILE), 'utf8')) as Record<string, unknown>
    delete settings.sandbox
    writeFileSync(path.join(dir, SETTINGS_FILE), `${JSON.stringify(settings, null, 2)}\n`)
    const record = recordOf(dir)
    delete record.settingsHook!.sandbox
    delete record.settingsHook!.original
    writeAttachRecord(dir, record)
  }

  function excludedOf(dir: string): unknown {
    return (JSON.parse(readFileSync(path.join(dir, SETTINGS_FILE), 'utf8')) as { sandbox?: { excludedCommands?: unknown } }).sandbox?.excludedCommands
  }

  it('attach upgrade at the current version writes the installed lab exclusion and detach removes it', async () => {
    const dir = await attached()
    withoutInstalledEntry(dir)
    const { ui: seen, output } = capturingUi()

    expect(await runAttachUpgrade(seen, { dir, yes: true })).toEqual({ status: 'done', created: [], rewritten: [], rolledBack: [] })

    expect(excludedOf(dir)).toEqual([browserLabExcludedCommand()])
    expect(recordOf(dir).settingsHook?.sandbox).toEqual({ added: [browserLabExcludedCommand()], createdSandbox: true, createdExcluded: true })
    expect(output()).toContain(browserLabExcludedCommand())

    expect((await askDetach(ui, { dir, yes: true })).status).toBe('done')
    expect(existsSync(path.join(dir, SETTINGS_FILE))).toBe(false)
  })

  it('an upgrade that rewrites carriers writes and records the entry as well', async () => {
    const dir = await attached()
    withoutInstalledEntry(dir)
    olderBuild(dir)

    expect((await runAttachUpgrade(ui, { dir, yes: true })).rewritten).toContain(STALE_CARRIER)

    expect(excludedOf(dir)).toEqual([browserLabExcludedCommand()])
    expect(recordOf(dir).settingsHook?.sandbox?.added).toEqual([browserLabExcludedCommand()])
    expect(recordOf(dir).attachedVersion).toBe(VERSION)
  })

  it('a second upgrade adds nothing and leaves the file and the record byte for byte', async () => {
    const dir = await attached()
    withoutInstalledEntry(dir)
    await runAttachUpgrade(ui, { dir, yes: true })
    const settings = readFileSync(path.join(dir, SETTINGS_FILE), 'utf8')
    const record = readFileSync(path.join(dir, ATTACH_RECORD_FILE), 'utf8')

    await runAttachUpgrade(ui, { dir, yes: true })

    expect(readFileSync(path.join(dir, SETTINGS_FILE), 'utf8')).toBe(settings)
    expect(readFileSync(path.join(dir, ATTACH_RECORD_FILE), 'utf8')).toBe(record)
  })

  it('an entry the repository held before the upgrade stays through detach', async () => {
    const dir = await attached()
    withoutInstalledEntry(dir)
    const settings = JSON.parse(readFileSync(path.join(dir, SETTINGS_FILE), 'utf8')) as Record<string, unknown>
    settings.sandbox = { excludedCommands: ['docker *', browserLabExcludedCommand()] }
    writeFileSync(path.join(dir, SETTINGS_FILE), JSON.stringify(settings))
    const before = readFileSync(path.join(dir, ATTACH_RECORD_FILE), 'utf8')

    await runAttachUpgrade(ui, { dir, yes: true })
    expect(readFileSync(path.join(dir, ATTACH_RECORD_FILE), 'utf8')).toBe(before)

    expect((await askDetach(ui, { dir, yes: true })).status).toBe('done')
    expect(excludedOf(dir)).toEqual(['docker *', browserLabExcludedCommand()])
  })

  it('a repository attached by an earlier build keeps its relative entry until detach, which removes both', async () => {
    const RELATIVE = 'node scripts/construct/browser-lab.mjs *'
    const dir = await attached()
    withoutInstalledEntry(dir)
    const settings = JSON.parse(readFileSync(path.join(dir, SETTINGS_FILE), 'utf8')) as Record<string, unknown>
    settings.sandbox = { excludedCommands: [RELATIVE] }
    writeFileSync(path.join(dir, SETTINGS_FILE), JSON.stringify(settings))
    const record = recordOf(dir)
    record.settingsHook!.sandbox = { added: [RELATIVE], createdSandbox: true, createdExcluded: true }
    writeAttachRecord(dir, record)

    await runAttachUpgrade(ui, { dir, yes: true })

    expect(excludedOf(dir)).toEqual([RELATIVE, browserLabExcludedCommand()])
    expect(recordOf(dir).settingsHook?.sandbox).toEqual({ added: [RELATIVE, browserLabExcludedCommand()], createdSandbox: true, createdExcluded: true })
    expect((await askDetach(ui, { dir, yes: true })).status).toBe('done')
    expect(existsSync(path.join(dir, SETTINGS_FILE))).toBe(false)
  })

  it('a pre-image kept by attach comes back byte for byte after an upgrade added the entry', async () => {
    const held = '{ "model":   "opus" }\n'
    const dir = await attached(held)
    const settings = JSON.parse(readFileSync(path.join(dir, SETTINGS_FILE), 'utf8')) as Record<string, unknown>
    delete settings.sandbox
    writeFileSync(path.join(dir, SETTINGS_FILE), `${JSON.stringify(settings, null, 2)}\n`)
    const record = recordOf(dir)
    delete record.settingsHook!.sandbox
    record.settingsHook!.original!.afterSha256 = sha256(readFileSync(path.join(dir, SETTINGS_FILE), 'utf8'))
    writeAttachRecord(dir, record)

    await runAttachUpgrade(ui, { dir, yes: true })
    expect(recordOf(dir).settingsHook?.original?.afterSha256).toBe(sha256(readFileSync(path.join(dir, SETTINGS_FILE), 'utf8')))

    expect((await askDetach(ui, { dir, yes: true })).status).toBe('done')
    expect(readFileSync(path.join(dir, SETTINGS_FILE), 'utf8')).toBe(held)
  })

  it('a file the owner deleted after attach holds only the entry after an upgrade, and detach removes the file', async () => {
    const dir = await attached()
    rmSync(path.join(dir, SETTINGS_FILE))
    const record = recordOf(dir)
    delete record.settingsHook!.sandbox
    record.settingsHook!.created.file = false
    writeAttachRecord(dir, record)

    await runAttachUpgrade(ui, { dir, yes: true })
    expect(JSON.parse(readFileSync(path.join(dir, SETTINGS_FILE), 'utf8'))).toEqual({ sandbox: { excludedCommands: [browserLabExcludedCommand()] } })

    expect((await askDetach(ui, { dir, yes: true })).status).toBe('done')
    expect(existsSync(path.join(dir, SETTINGS_FILE))).toBe(false)
  })

  it('leaves a tracked or unreadable settings file alone, records nothing and prints why', async () => {
    const tracked = await attached()
    withoutInstalledEntry(tracked)
    git(tracked, 'add', '-f', SETTINGS_FILE)
    const unreadable = await attached()
    writeFileSync(path.join(unreadable, SETTINGS_FILE), '{ not json')
    for (const dir of [tracked, unreadable]) {
      const settings = readFileSync(path.join(dir, SETTINGS_FILE), 'utf8')
      const record = readFileSync(path.join(dir, ATTACH_RECORD_FILE), 'utf8')
      const { ui: seen, output } = capturingUi()

      expect((await runAttachUpgrade(seen, { dir, yes: true })).status).toBe('done')

      expect(readFileSync(path.join(dir, SETTINGS_FILE), 'utf8')).toBe(settings)
      expect(readFileSync(path.join(dir, ATTACH_RECORD_FILE), 'utf8')).toBe(record)
      expect(output()).toContain(PLAIN_LORE.initSettingsSkippedNoExclusion(browserLabExcludedCommand()))
    }
  })

  it('at the installed version rewrites nothing; on an older record with current carriers it only records the version', async () => {
    const dir = await attached()
    const record = readFileSync(path.join(dir, ATTACH_RECORD_FILE), 'utf8')
    expect(await runAttachUpgrade(ui, { dir, yes: true })).toEqual({ status: 'done', created: [], rewritten: [], rolledBack: [] })
    expect(readFileSync(path.join(dir, ATTACH_RECORD_FILE), 'utf8')).toBe(record)

    const older = recordOf(dir)
    delete older.attachedVersion
    writeAttachRecord(dir, older)
    expect((await runAttachUpgrade(ui, { dir, yes: true })).rewritten).toEqual([])
    expect(recordOf(dir).attachedVersion).toBe(VERSION)
  })

  it('runs from the command line through --upgrade', async () => {
    const dir = await attached()
    olderBuild(dir)

    const run = spawnSync(process.execPath, ['--import', 'tsx', path.join(REPO_ROOT, 'src/cli.ts'), 'attach', '--upgrade', '--yes', '--plain', '--dir', dir], { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, HOME: homedir() } })

    expect(run.stdout).toContain(PLAIN_LORE.attachUpgraded(VERSION))
    expect(run.status).toBe(0)
    expect(readFileSync(path.join(dir, STALE_CARRIER), 'utf8')).not.toBe(OLDER_BYTES)
  }, 60_000)
})

describe('the attach record carries the version that wrote its carriers', () => {
  it('a fresh attach records the installed version', async () => {
    expect(attachedVersionOf(recordOf(await attached()))).toBe(VERSION)
  })

  it('an older record reads as unknown', async () => {
    const dir = await attached()
    olderBuild(dir)
    expect(attachedVersionOf(recordOf(dir))).toBeNull()
  })

  it.each([
    [null, '1.0.0', 'unknown'],
    ['1.0.0', '1.0.0', 'current'],
    ['0.9.0', '0.10.0', 'stale'],
    ['0.10.0', '0.9.0', 'ahead'],
  ] as const)('%s read by %s is %s', (attachedAt, installed, reading) => {
    expect(carriersReading(attachedAt, installed)).toBe(reading)
  })
})

describe('doctor on an attached repository', () => {
  function doctorOutput(dir: string, installed: string): string {
    const { ui: seen, output } = capturingUi()
    expect(printDoctor(seen, runDoctor(dir, installed))).toBe(0)
    return output()
  }

  it('doctor shows the attached and the installed version, and a stale-carriers line when they differ', async () => {
    const dir = await attached()

    const current = doctorOutput(dir, VERSION)
    expect(current).toContain(PLAIN_LORE.doctorAttachedVersions(VERSION, VERSION))
    expect(current).not.toContain(PLAIN_LORE.doctorCarriersStale(VERSION, VERSION))

    const newer = doctorOutput(dir, '999.0.0')
    expect(newer).toContain(PLAIN_LORE.doctorAttachedVersions(VERSION, '999.0.0'))
    expect(newer).toContain(PLAIN_LORE.doctorCarriersStale(VERSION, '999.0.0'))
  })

  it('says an older record is unknown and what would make it known', async () => {
    const dir = await attached()
    olderBuild(dir)

    const output = doctorOutput(dir, VERSION)
    expect(output).toContain(PLAIN_LORE.doctorAttachedVersions(null, VERSION))
    expect(output).toContain(PLAIN_LORE.doctorCarriersUnknown)
    expect(PLAIN_LORE.doctorCarriersUnknown).toContain('construct attach --upgrade')
  })

  it('says to update the CLI, not the carriers, when a later build wrote them', async () => {
    const dir = await attached()
    expect(doctorOutput(dir, '0.0.1')).toContain(PLAIN_LORE.doctorCarriersAhead(VERSION, '0.0.1'))
  })

  it('carries both versions in the report --json prints', async () => {
    const dir = await attached()
    expect(runDoctor(dir, '999.0.0')).toMatchObject({ state: 'attached', attachedVersion: VERSION, installedVersion: '999.0.0', carriers: 'stale' })
  })
})
