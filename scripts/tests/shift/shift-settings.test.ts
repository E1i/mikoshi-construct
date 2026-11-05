import type { ShiftGate } from '../../../src/manifest.js'
import type { ShiftSettings } from '../../ports/shift-settings.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { browserLabExcludedCommand, browserLabInstalledScript } from '../../../src/commands/attach/settings.js'
import { runInit } from '../../../src/commands/init.js'
import { readManifest, readShiftGate } from '../../../src/manifest.js'
import { createUi, silentWriter } from '../../../src/ui/console.js'
import { resolveTheme } from '../../../src/ui/theme.js'
import { treeReportPath } from '../../core/places.js'
import { CARD_SESSION_SANDBOX, settingsFlag, shiftSettings } from '../../ports/shift-settings.js'

function editCovers(rule: string, file: string): boolean {
  const pattern = /^Edit\(\/(.+)\)$/.exec(rule)?.[1]
  if (pattern === undefined)
    return false
  return pattern.endsWith('/**') ? file.startsWith(pattern.slice(0, -2)) : file === pattern
}

describe('the settings a card session is started with in a repository after construct init --preset node-library', () => {
  let tree = ''

  beforeAll(async () => {
    tree = mkdtempSync(path.join(tmpdir(), 'construct-shift-settings-'))
    await runInit(createUi(resolveTheme({ plain: true }), silentWriter), { dir: tree, preset: 'node-library', name: 'shift-settings-fixture', yes: true, dryRun: false })
  })

  afterAll(() => rmSync(tree, { recursive: true, force: true }))

  it('keep the sandbox on with no way to start without it or to run a command outside it', () => {
    expect(shiftSettings(tree, readShiftGate(tree), [], tree).sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false })
  })

  it('bus sessions may listen on the tsx pipe and no other socket', () => {
    const uid = userInfo().uid
    expect(shiftSettings(tree, readShiftGate(tree), [], tree).sandbox.network).toEqual({ allowLocalBinding: true, allowUnixSockets: [`/tmp/claude-${uid}/tsx-${uid}`] })
  })

  it('allow exactly the gate commands of the tree\'s construct config and edits inside the card tree, and no other rule', () => {
    const command = readManifest(tree)!.harness.command
    expect(shiftSettings(tree, readShiftGate(tree), [], tree).permissions).toEqual({ allow: [`Bash(${command})`, `Edit(/${tree}/**)`] })
  })

  it('cover the tree report and a file inside the tree, and nothing beside the tree', () => {
    const { allow } = shiftSettings(tree, readShiftGate(tree)).permissions
    const covered = (file: string): boolean => allow.some(rule => editCovers(rule, file))
    expect([treeReportPath(tree), path.join(tree, 'src', 'index.ts'), `${tree}-beside/x`, path.join(path.dirname(tree), 'canary')].map(covered)).toEqual([true, true, false, false])
  })

  it('allow an edit outside the tree only on a file the starter names', () => {
    const question = path.join(tmpdir(), 'answers', 'owner-question.md')
    expect(shiftSettings(tree, readShiftGate(tree), [question]).permissions.allow.at(-1)).toBe(`Edit(/${question})`)
  })

  it('travel as one --settings argument holding the settings as JSON, behind --setting-sources that leaves out the user settings', () => {
    const settings = shiftSettings(tree, readShiftGate(tree))
    const [sourcesFlag, sources, flag, json] = settingsFlag(settings)
    expect({ sourcesFlag, sources, flag, settings: JSON.parse(json!) }).toEqual({ sourcesFlag: '--setting-sources', sources: 'project,local', flag: '--settings', settings })
  })
})

describe('the browser lab exclusion a card session takes from the settings of its repository', () => {
  const OTHER_ENTRY = 'bash *'
  const RELATIVE_ENTRY = 'node scripts/construct/browser-lab.mjs *'
  const GATE: ShiftGate = { prepush: ['pnpm run quality'], handoffWrite: null, codeMatrix: null }
  let tree = ''
  let home = ''
  let entry = ''

  beforeEach(() => {
    tree = mkdtempSync(path.join(tmpdir(), 'construct-shift-lab-'))
    home = mkdtempSync(path.join(tmpdir(), 'construct-shift-home-'))
    entry = browserLabExcludedCommand(home)
    mkdirSync(path.join(tree, '.claude'))
    mkdirSync(path.dirname(browserLabInstalledScript(home)), { recursive: true })
    writeFileSync(browserLabInstalledScript(home), '')
  })

  afterEach(() => {
    rmSync(tree, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  })

  function holdSettings(file: string, excludedCommands: unknown): void {
    writeFileSync(path.join(tree, '.claude', file), JSON.stringify({ sandbox: { excludedCommands } }))
  }

  function settings(): ShiftSettings {
    return shiftSettings(tree, GATE, [], home)
  }

  function excludedBy(pattern: string, call: string): boolean {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
    return new RegExp(`^${escaped}$`).test(call)
  }

  const SETTINGS_FILES = ['settings.json', 'settings.local.json']

  it('a repository that excludes the lab in settings.json or settings.local.json gets exactly that one entry', () => {
    const excluded = SETTINGS_FILES.map((file) => {
      holdSettings(file, [entry])
      const { excludedCommands } = settings().sandbox
      rmSync(path.join(tree, '.claude', file))
      return excludedCommands
    })
    expect(excluded).toEqual([[entry], [entry]])
  })

  it('any other entry the repository excludes never reaches the session settings', () => {
    holdSettings('settings.json', [OTHER_ENTRY, entry])
    holdSettings('settings.local.json', [OTHER_ENTRY])
    const together = settings().sandbox.excludedCommands
    holdSettings('settings.json', [OTHER_ENTRY])
    expect({ together, alone: settings().sandbox.excludedCommands }).toEqual({ together: [entry], alone: undefined })
  })

  it('the excluded command names the absolute lab script outside the tree and no copy in the tree', () => {
    holdSettings('settings.json', [RELATIVE_ENTRY])
    const relative = settings()
    holdSettings('settings.json', [entry])
    const absolute = settings()
    rmSync(browserLabInstalledScript(home))
    const notInstalled = settings()
    expect(entry).toBe(`node ${home}/.construct/browser-lab/bin/browser-lab.mjs *`)
    expect(path.isAbsolute(browserLabInstalledScript(home))).toBe(true)
    expect(browserLabInstalledScript(home).startsWith(`${tree}${path.sep}`)).toBe(false)
    expect({ relative: relative.sandbox.excludedCommands, absolute: absolute.sandbox.excludedCommands, notInstalled: notInstalled.sandbox.excludedCommands }).toEqual({ relative: undefined, absolute: [entry], notInstalled: undefined })
    expect(excludedBy(entry, `node ${browserLabInstalledScript(home)} page about:blank`)).toBe(true)
    for (const call of ['node scripts/construct/browser-lab.mjs page about:blank', `node ${tree}/scripts/construct/browser-lab.mjs page about:blank`, `node ${tree}/sub/scripts/construct/browser-lab.mjs page about:blank`, 'node sub/scripts/construct/browser-lab.mjs page about:blank'])
      expect(excludedBy(entry, call), call).toBe(false)
  })

  it('a session excluded for the lab may not rewrite the lab', () => {
    const lab = path.join(tree, 'scripts', 'construct', 'browser-lab.mjs')
    const without = settings()
    holdSettings('settings.local.json', [entry])
    const excluded = settings()
    expect(excluded.permissions.deny).toContain(`Edit(/${lab})`)
    expect(excluded.sandbox.filesystem?.denyWrite).toContain(lab)
    expect({ deny: without.permissions.deny, filesystem: without.sandbox.filesystem }).toEqual({ deny: undefined, filesystem: undefined })
  })

  it('a session excluded for the lab may not write the lab cache', () => {
    const labHome = path.join(home, '.construct', 'browser-lab')
    const without = settings()
    holdSettings('settings.json', [entry])
    const excluded = settings()
    expect(excluded.permissions.deny).toContain(`Edit(/${labHome}/**)`)
    expect(excluded.sandbox.filesystem?.denyWrite).toContain(labHome)
    expect(JSON.stringify(without)).not.toContain(labHome)
  })

  it('a missing file, an unparsable file or a malformed excludedCommands excludes nothing and leaves the settings as they are without the entry', () => {
    const plain = { sandbox: CARD_SESSION_SANDBOX, permissions: { allow: ['Bash(pnpm run quality)', `Edit(/${tree}/**)`] } }
    const missing = settings()
    writeFileSync(path.join(tree, '.claude', 'settings.json'), '{ not json')
    const unparsable = settings()
    holdSettings('settings.json', entry)
    const malformed = settings()
    expect([missing, unparsable, malformed]).toStrictEqual([plain, plain, plain])
  })

  it('leaves the network and the unsandboxed-command refusal of the card session unchanged with the entry present', () => {
    holdSettings('settings.json', [entry])
    expect(settings().sandbox).toMatchObject(CARD_SESSION_SANDBOX)
  })

  it('keeps the entry and the protection across the --settings flag', () => {
    holdSettings('settings.local.json', [entry])
    const built = settings()
    expect(JSON.parse(settingsFlag(built).at(-1)!)).toEqual(built)
  })
})
