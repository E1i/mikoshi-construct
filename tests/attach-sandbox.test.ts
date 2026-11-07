import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runAttach, SETTINGS_FILE } from '../src/commands/attach/index.js'
import { ATTACH_RECORD_FILE } from '../src/commands/attach/record.js'
import { browserLabExcludedCommand, excludedBrowserLabLocally, isSettingsHook, readSettings } from '../src/commands/attach/settings.js'
import { askDetach } from '../src/commands/detach/index.js'
import { runInit } from '../src/commands/init.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'
import { useIsolatedHome } from './isolated-home.js'

const EXISTING_MONOREPO = path.join(import.meta.dirname, 'fixtures/existing-monorepo')
const ui = createUi(resolveTheme({ plain: true }), silentWriter)
useIsolatedHome()

function fixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-attach-sandbox-'))
  cpSync(EXISTING_MONOREPO, dir, { recursive: true })
  const git = (...args: string[]): string => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' })
  git('init', '-q')
  git('add', '-A')
  git('commit', '-qm', 'base')
  return dir
}

function excludedOf(dir: string): string[] {
  const settings = JSON.parse(readFileSync(path.join(dir, SETTINGS_FILE), 'utf8')) as { sandbox?: { excludedCommands?: string[] } }
  return settings.sandbox?.excludedCommands ?? []
}

async function attach(dir: string): Promise<void> {
  expect((await runAttach(ui, { dir, harness: 'pnpm run quality', requiredCheck: 'gate', yes: true })).status).toBe('done')
}

describe('attach excludes the browser-lab command from the sandbox', () => {
  it('writes exactly one excludedCommands entry, for browser-lab.mjs', async () => {
    const dir = fixture()
    await attach(dir)
    expect(excludedOf(dir)).toEqual([browserLabExcludedCommand()])
    expect(browserLabExcludedCommand()).toContain('/.construct/browser-lab/bin/browser-lab.mjs')
  })

  it('returns a settings.local.json that did not exist to not existing', async () => {
    const dir = fixture()
    await attach(dir)
    expect((await askDetach(ui, { dir, yes: true })).status).toBe('done')
    expect(() => readFileSync(path.join(dir, SETTINGS_FILE))).toThrow()
  })

  it('returns a settings.local.json that existed to its bytes', async () => {
    const dir = fixture()
    const original = `${JSON.stringify({ model: 'opus', sandbox: { enabled: true } })}\n`
    mkdirSync(path.join(dir, '.claude'), { recursive: true })
    writeFileSync(path.join(dir, SETTINGS_FILE), original)
    await attach(dir)
    expect(excludedOf(dir)).toEqual([browserLabExcludedCommand()])
    expect((await askDetach(ui, { dir, yes: true })).status).toBe('done')
    expect(readFileSync(path.join(dir, SETTINGS_FILE), 'utf8')).toBe(original)
  })

  it('keeps an excludedCommands entry held before attach through detach', async () => {
    const dir = fixture()
    const held = { sandbox: { excludedCommands: ['docker *'] } }
    mkdirSync(path.join(dir, '.claude'), { recursive: true })
    writeFileSync(path.join(dir, SETTINGS_FILE), JSON.stringify(held))
    await attach(dir)
    expect(excludedOf(dir)).toEqual(['docker *', browserLabExcludedCommand()])
    expect((await askDetach(ui, { dir, yes: true })).status).toBe('done')
    expect(JSON.parse(readFileSync(path.join(dir, SETTINGS_FILE), 'utf8'))).toEqual(held)
  })

  it('neither adds nor removes the browser-lab entry the repository already held', async () => {
    const dir = fixture()
    const held = { sandbox: { excludedCommands: [browserLabExcludedCommand()] } }
    mkdirSync(path.join(dir, '.claude'), { recursive: true })
    writeFileSync(path.join(dir, SETTINGS_FILE), JSON.stringify(held))
    await attach(dir)
    expect(excludedOf(dir)).toEqual([browserLabExcludedCommand()])
    expect((await askDetach(ui, { dir, yes: true })).status).toBe('done')
    expect(JSON.parse(readFileSync(path.join(dir, SETTINGS_FILE), 'utf8'))).toEqual(held)
  })
})

function capturedUi(): { lines: string[], ui: ReturnType<typeof createUi> } {
  const lines: string[] = []
  return { lines, ui: createUi(resolveTheme({ plain: true }), line => lines.push(line)) }
}

function settingsOf(dir: string, file: string): { sandbox?: unknown } {
  return JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as { sandbox?: unknown }
}

describe('init writes the exclusion where a home path stays on this machine', () => {
  it('writes the absolute entry into .claude/settings.local.json and none into .claude/settings.json', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'construct-init-sandbox-'))
    const captured = capturedUi()
    await runInit(captured.ui, { dir, preset: 'node-backend', yes: true, dryRun: false })
    expect(excludedOf(dir)).toEqual([browserLabExcludedCommand()])
    expect(settingsOf(dir, '.claude/settings.json').sandbox).toBeUndefined()
    expect(captured.lines.join('\n')).not.toContain('without its exclusion')
  })

  it('writes the entry under the home it is given', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'construct-init-sandbox-'))
    const home = mkdtempSync(path.join(tmpdir(), 'construct-init-home-'))
    await runInit(ui, { dir, preset: 'node-backend', yes: true, dryRun: false, home })
    expect(excludedOf(dir)).toEqual([browserLabExcludedCommand(home)])
  })

  it('keeps what an existing .claude/settings.local.json holds', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'construct-init-existing-'))
    mkdirSync(path.join(dir, '.claude'))
    writeFileSync(path.join(dir, SETTINGS_FILE), JSON.stringify({ model: 'opus', sandbox: { excludedCommands: ['docker *'] } }))
    await runInit(ui, { dir, preset: 'node-backend', yes: true, dryRun: false })
    expect(JSON.parse(readFileSync(path.join(dir, SETTINGS_FILE), 'utf8'))).toEqual({ model: 'opus', sandbox: { excludedCommands: ['docker *', browserLabExcludedCommand()] } })
  })

  it('a dry run writes no settings.local.json', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'construct-init-sandbox-'))
    await runInit(ui, { dir, preset: 'node-backend', yes: true, dryRun: true })
    expect(existsSync(path.join(dir, SETTINGS_FILE))).toBe(false)
  })

  it('leaves a tracked settings.local.json as it is and prints that the organ runs without the exclusion', async () => {
    const dir = fixture()
    const held = `${JSON.stringify({ model: 'opus' })}\n`
    mkdirSync(path.join(dir, '.claude'), { recursive: true })
    writeFileSync(path.join(dir, SETTINGS_FILE), held)
    execFileSync('git', ['add', '-f', SETTINGS_FILE], { cwd: dir })
    const captured = capturedUi()
    await runInit(captured.ui, { dir, preset: 'node-backend', yes: true, dryRun: false })
    expect(readFileSync(path.join(dir, SETTINGS_FILE), 'utf8')).toBe(held)
    expect(captured.lines.join('\n')).toContain('runs inside the sandbox without its exclusion')
    expect(captured.lines.join('\n')).toContain(browserLabExcludedCommand())
  })

  it('leaves an unreadable settings.local.json as it is and prints the same line', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'construct-init-existing-'))
    mkdirSync(path.join(dir, '.claude'))
    writeFileSync(path.join(dir, SETTINGS_FILE), '{ not json')
    const captured = capturedUi()
    await runInit(captured.ui, { dir, preset: 'node-backend', yes: true, dryRun: false })
    expect(readFileSync(path.join(dir, SETTINGS_FILE), 'utf8')).toBe('{ not json')
    expect(captured.lines.join('\n')).toContain('runs inside the sandbox without its exclusion')
  })

  it('a fresh repository ignores the file, so git add never commits the home path', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'construct-init-sandbox-'))
    await runInit(ui, { dir, preset: 'node-backend', yes: true, dryRun: false })
    execFileSync('git', ['init', '-q'], { cwd: dir })
    expect(execFileSync('git', ['check-ignore', SETTINGS_FILE], { cwd: dir, encoding: 'utf8' }).trim()).toBe(SETTINGS_FILE)
  })
})

describe('the one function that writes the exclusion', () => {
  const HOME = '/home/someone'
  const ENTRY = browserLabExcludedCommand(HOME)
  const ENTRY_JSON = JSON.stringify(ENTRY)

  function written(before: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'construct-exclusion-'))
    mkdirSync(path.join(dir, '.claude'))
    writeFileSync(path.join(dir, SETTINGS_FILE), before)
    excludedBrowserLabLocally(dir, HOME)
    return readFileSync(path.join(dir, SETTINGS_FILE), 'utf8')
  }

  const LAYOUTS: Record<string, { before: string, after: string }> = {
    'no sandbox, compact': {
      before: '{"model":"opus"}',
      after: `{"model":"opus","sandbox": {"excludedCommands":[${ENTRY_JSON}]}}`,
    },
    'no sandbox, indented by four with odd values': {
      before: '{\n    "n": 1.0,\n    "u": "\\u00e9",\n    "1": [ 1,2 ]\n}\n',
      after: `{\n    "n": 1.0,\n    "u": "\\u00e9",\n    "1": [ 1,2 ],\n    "sandbox": {\n      "excludedCommands": [\n        ${ENTRY_JSON}\n      ]\n    }\n}\n`,
    },
    'an empty object': {
      before: '{}\n',
      after: `{\n  "sandbox": {\n    "excludedCommands": [\n      ${ENTRY_JSON}\n    ]\n  }\n}\n`,
    },
    'a sandbox without the list': {
      before: '{ "sandbox": { "enabled": true }, "z": "}" }',
      after: `{ "sandbox": { "enabled": true, "excludedCommands": [${ENTRY_JSON}] }, "z": "}" }`,
    },
    'an empty sandbox': {
      before: '{\n  "sandbox": {}\n}\n',
      after: `{\n  "sandbox": {\n    "excludedCommands": [\n      ${ENTRY_JSON}\n    ]\n  }\n}\n`,
    },
    'a list with entries, a string holding brackets and a quote': {
      before: '{\n  "sandbox": {\n    "excludedCommands": [\n      "a ] \\" }"\n    ]\n  },\n  "after": null\n}\n',
      after: `{\n  "sandbox": {\n    "excludedCommands": [\n      "a ] \\" }",\n      ${ENTRY_JSON}\n    ]\n  },\n  "after": null\n}\n`,
    },
    'an empty list': {
      before: '{"sandbox":{"excludedCommands":[ ]}}',
      after: `{"sandbox":{"excludedCommands":[\n  ${ENTRY_JSON}\n]}}`,
    },
    'crlf line ends': {
      before: '{\r\n  "a": true\r\n}\r\n',
      after: `{\r\n  "a": true,\r\n  "sandbox": {\n    "excludedCommands": [\n      ${ENTRY_JSON}\n    ]\n  }\r\n}\r\n`,
    },
    'a key repeated, the last one the parser reads': {
      before: '{"sandbox":{"excludedCommands":["x"]},"sandbox":{"excludedCommands":["y"]}}',
      after: `{"sandbox":{"excludedCommands":["x"]},"sandbox":{"excludedCommands":["y",${ENTRY_JSON}]}}`,
    },
    'a key written with an escape': {
      before: '{"s\\u0061ndbox":{"enabled":false}}',
      after: `{"s\\u0061ndbox":{"enabled":false,"excludedCommands": [${ENTRY_JSON}]}}`,
    },
  }

  for (const [layout, { before, after }] of Object.entries(LAYOUTS)) {
    it(`keeps every other byte: ${layout}`, () => {
      expect(written(before)).toBe(after)
      expect((JSON.parse(after) as { sandbox: { excludedCommands: string[] } }).sandbox.excludedCommands).toContain(ENTRY)
    })
  }

  it('an entry already held is not added twice and the file is not rewritten', () => {
    const before = `{ "sandbox" : { "excludedCommands" : [ ${ENTRY_JSON} ] } }`
    expect(written(before)).toBe(before)
  })

  it('reports what it added, and nothing when the entry was held', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'construct-exclusion-'))
    expect(excludedBrowserLabLocally(dir, HOME)).toMatchObject({ added: [ENTRY], createdSandbox: true, createdExcluded: true, createdFile: true, beforeSha256: null })
    expect(excludedBrowserLabLocally(dir, HOME)).toMatchObject({ added: [], createdSandbox: false, createdExcluded: false, createdFile: false })
  })

  it('refuses a linked worktree, whose index this reader cannot see, and does not create the file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'construct-exclusion-'))
    writeFileSync(path.join(dir, '.git'), 'gitdir: /somewhere/else\n')
    expect(excludedBrowserLabLocally(dir, HOME)).toBeNull()
    expect(existsSync(path.join(dir, SETTINGS_FILE))).toBe(false)
  })
})

describe('attach refuses a settings.local.json whose sandbox it cannot extend', () => {
  function readingOf(settings: unknown): string {
    const dir = fixture()
    mkdirSync(path.join(dir, '.claude'), { recursive: true })
    writeFileSync(path.join(dir, SETTINGS_FILE), JSON.stringify(settings))
    return readSettings(dir).kind
  }

  it('reads a non-object sandbox as unreadable', () => {
    expect(readingOf({ sandbox: 'on' })).toBe('unreadable')
  })

  it('reads a non-array excludedCommands as unreadable', () => {
    expect(readingOf({ sandbox: { excludedCommands: 'docker *' } })).toBe('unreadable')
  })

  it('reads an object sandbox with an array excludedCommands as read', () => {
    expect(readingOf({ sandbox: { excludedCommands: [] } })).toBe('read')
  })
})

describe('a hand-edited sandbox record in the attach record', () => {
  async function recordedHook(): Promise<Record<string, unknown>> {
    const dir = fixture()
    await attach(dir)
    const record = JSON.parse(readFileSync(path.join(dir, ATTACH_RECORD_FILE), 'utf8')) as { settingsHook: Record<string, unknown> }
    return record.settingsHook
  }

  it('is accepted as recorded', async () => {
    expect(isSettingsHook(await recordedHook())).toBe(true)
  })

  it('is rejected when it names a command other than browser-lab', async () => {
    const hook = await recordedHook()
    expect(isSettingsHook({ ...hook, sandbox: { added: ['rm -rf *'], createdSandbox: true, createdExcluded: true } })).toBe(false)
  })

  it('is accepted when an earlier attach recorded the relative entry, so detach still removes it', async () => {
    const hook = await recordedHook()
    expect(isSettingsHook({ ...hook, sandbox: { added: ['node scripts/construct/browser-lab.mjs *'], createdSandbox: true, createdExcluded: true } })).toBe(true)
  })

  it('is rejected when a flag is not a boolean', async () => {
    const hook = await recordedHook()
    expect(isSettingsHook({ ...hook, sandbox: { added: [], createdSandbox: 'yes', createdExcluded: true } })).toBe(false)
  })
})
