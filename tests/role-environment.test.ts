import type { FirstStep, RoleSituation } from '../src/commands/doctor/factory.js'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { OWNER_AGENT_FILE, repoIdOf } from '../scripts/core/bus-path.js'
import { openBus } from '../scripts/core/db.js'
import { HANDOFF_DIR_VARIABLE } from '../scripts/core/handoff-dir.js'
import { OWNER_CHANNEL_HOME } from '../scripts/owner/channel.js'
import { windowCommand } from '../scripts/ports/client/claude/adapter.js'
import { shiftSettings } from '../scripts/ports/shift-settings.js'
import { allowRule } from '../src/commands/attach/daemon-commands.js'
import { excludedBrowserLabInTheConstruct, settledProjectSettings } from '../src/commands/attach/index.js'
import { browserLabExcludedCommand, browserLabInstalledScript, cardTreeGitWrites, GITHUB_API_DOMAIN, OWNER_CHANNEL_ENTRY, RECORDED_BY_AN_EARLIER_ATTACH, ROLE_DOMAINS, SETTINGS_FILE } from '../src/commands/attach/settings.js'
import { browserLabStep, cardFirstSteps, factoryChecklist, LAB_ROLES, readStep, roleSituations, windowFirstSteps } from '../src/commands/doctor/factory.js'
import { FileReadings } from '../src/commands/doctor/readings.js'
import { printFactoryChecklist } from '../src/commands/doctor/report.js'
import { runInit } from '../src/commands/init.js'
import { applySync, runSync } from '../src/commands/sync/index.js'
import { readManifest } from '../src/manifest.js'
import { ownedSha } from '../src/sync/ownership.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { PLAIN_LORE } from '../src/ui/lore.js'
import { resolveTheme } from '../src/ui/theme.js'
import { VERSION } from '../src/version.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const PROJECT_SETTINGS = '.claude/settings.json'
const INSTALLED_PREFIX = '<home>/.construct/browser-lab/bin/'
const LAB_CALL = /(\S*)browser-lab\.mjs(?= [^`\n]*\S)/g
const NOT_A_CALLER = new Set(['templates/ai/claude/scripts/construct/browser-lab.mjs', 'templates/attach/earlier-carriers.json'])
const NOW = new Date('2026-11-23T12:00:00.000Z')

type Json = Record<string, any>

interface Consumer {
  dir: string
  home: string
}

const ui = createUi(resolveTheme({ plain: true }), silentWriter)

function scratch(prefix: string): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)))
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' })
}

async function consumer(): Promise<Consumer> {
  const dir = scratch('role-environment-')
  const home = scratch('role-environment-home-')
  git(dir, 'init', '-q', '-b', 'main')
  await runInit(ui, { dir, preset: 'node-backend', ai: 'claude', yes: true, dryRun: false, env: {}, home })
  return { dir, home }
}

function json(dir: string, file: string): Json {
  return JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as Json
}

function writeJson(dir: string, file: string, value: unknown): void {
  writeFileSync(path.join(dir, file), `${JSON.stringify(value, null, 2)}\n`)
}

function handoffOf({ dir, home }: Consumer): string {
  return path.join(home, '.construct', repoIdOf(dir), 'handoff', 'miko.md')
}

function windowOf({ dir, home }: Consumer): RoleSituation {
  return roleSituations(new FileReadings(dir), dir, home).window
}

function refusals(situation: RoleSituation, steps: FirstStep[]): Record<string, string | null> {
  return Object.fromEntries(steps.map(step => [step.step, readStep(situation, step).refused]))
}

function withoutTheEnvironment(dir: string): void {
  const { sandbox: _sandbox, ...settings } = json(dir, PROJECT_SETTINGS)
  const allow = (settings.permissions.allow as string[]).filter(rule => !rule.startsWith('Read(~/'))
  writeJson(dir, PROJECT_SETTINGS, { ...settings, permissions: { ...settings.permissions, allow } })
}

function checklistOf({ dir, home }: Consumer) {
  const bus = path.join(scratch('role-environment-bus-'), 'bus.db')
  openBus(bus).close()
  return factoryChecklist(dir, { env: { CONSTRUCT_BUS_DB: bus, [HANDOFF_DIR_VARIABLE]: scratch('role-environment-handoff-') }, home, now: NOW })
}

function itemOf(consumer: Consumer, name: string) {
  return checklistOf(consumer).items.find(item => item.item === name)
}

function resolved(entry: string, base: string, home: string): string {
  return entry.startsWith('~/') ? path.join(home, entry.slice(2)) : path.resolve(base, entry)
}

function inside(target: string, directory: string): boolean {
  return target === directory || target.startsWith(`${directory}${path.sep}`)
}

function installTheLab(home: string): void {
  mkdirSync(path.dirname(browserLabInstalledScript(home)), { recursive: true })
  writeFileSync(browserLabInstalledScript(home), '')
}

interface CardTree {
  tree: string
  gitDir: string
  commonDir: string
}

function cardTreeOf({ dir, home }: Consumer): CardTree {
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'init')
  const tree = path.join(home, '.construct', repoIdOf(dir), 'bus', 'worktrees', 'wt')
  mkdirSync(path.dirname(tree), { recursive: true })
  git(dir, 'worktree', 'add', '-q', '-b', 'card', tree)
  const pointer = /^gitdir:\s*(\S.*)$/m.exec(readFileSync(path.join(tree, '.git'), 'utf8'))![1]!.trim()
  return { tree, gitDir: path.resolve(tree, pointer), commonDir: path.join(dir, '.git') }
}

function cardSessionOf(card: CardTree, home: string): RoleSituation {
  const flag = shiftSettings(card.tree, { prepush: [], handoffWrite: null, codeMatrix: null }, [], home) as unknown as Json
  return { cwd: card.tree, home, layers: [{ settings: json(card.tree, PROJECT_SETTINGS), base: card.tree }, { settings: flag, base: card.tree }] }
}

function labCallersUnder(directory: string): string[] {
  return readdirSync(path.join(REPO_ROOT, directory), { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => path.relative(REPO_ROOT, path.join(entry.parentPath, entry.name)))
    .filter(file => !NOT_A_CALLER.has(file))
}

describe('the environment of every role comes from the product, not from the owner\'s user settings', () => {
  it('a consumer after init with no user settings gives the window a launch that reads its handoff and runs miko watch --once with no refusal', async () => {
    const made = await consumer()
    expect(windowCommand({})).toContain('--setting-sources project,local')
    const situation = windowOf(made)
    expect(situation.layers.map(layer => layer.base)).toEqual([made.dir, made.dir])
    const [read, watch] = windowFirstSteps(made.dir, made.home, handoffOf(made))
    expect(refusals(situation, [read!, watch!])).toEqual({ 'read the handoff': null, 'miko watch --once': null })
    expect(json(made.dir, PROJECT_SETTINGS).permissions.allow).toContain(`Read(~/.construct/${repoIdOf(made.dir)}/**)`)
    expect(json(made.dir, PROJECT_SETTINGS).sandbox.network.allowedDomains).toEqual(expect.arrayContaining([...ROLE_DOMAINS]))
  })

  it('a consumer brought up to date by sync --apply with no user settings gives the window the same environment as a fresh init', async () => {
    const made = await consumer()
    const fresh = json(made.dir, PROJECT_SETTINGS)
    withoutTheEnvironment(made.dir)
    expect(Object.values(refusals(windowOf(made), windowFirstSteps(made.dir, made.home, handoffOf(made)))).every(reason => reason !== null)).toBe(true)

    applySync(made.dir, VERSION, made.home)

    const synced = json(made.dir, PROJECT_SETTINGS)
    expect(synced.sandbox).toEqual(fresh.sandbox)
    expect(synced.permissions.allow).toEqual(expect.arrayContaining(fresh.permissions.allow as string[]))
    expect(Object.values(refusals(windowOf(made), windowFirstSteps(made.dir, made.home, handoffOf(made))))).toEqual([null, null, null])
  })

  it('the environment of the consumer window lets git commit in a branch write the .git of the repository', async () => {
    const made = await consumer()
    const commit = windowFirstSteps(made.dir, made.home, handoffOf(made)).find(step => step.step === 'git commit in a branch')!
    expect(commit.writes.every(target => inside(target, path.join(made.dir, '.git')))).toBe(true)
    expect(readStep(windowOf(made), commit).refused).toBeNull()
    expect(readStep(windowOf(made), { ...commit, step: 'write a hook', writes: [path.join(made.dir, '.git', 'hooks', 'pre-commit')] }).refused).not.toBeNull()
  })

  it('the environment of the consumer window never allows a write to the owner channel', async () => {
    const made = await consumer()
    const channel = path.join(made.home, OWNER_CHANNEL_HOME, 'answers', 'word.md')
    for (const file of [PROJECT_SETTINGS, SETTINGS_FILE]) {
      const allowWrite = (json(made.dir, file).sandbox?.filesystem?.allowWrite ?? []) as string[]
      for (const entry of allowWrite)
        expect(inside(channel, resolved(entry, made.dir, made.home)), `${file} ${entry}`).toBe(false)
    }
    const deniedWrites = (json(made.dir, PROJECT_SETTINGS).sandbox.filesystem.denyWrite as string[]).map(entry => resolved(entry, made.dir, made.home))
    expect(deniedWrites).toContain(path.join(made.home, OWNER_CHANNEL_HOME))
    const widened: RoleSituation = { ...windowOf(made), layers: [...windowOf(made).layers, { settings: { sandbox: { filesystem: { allowWrite: ['~/'] } } }, base: made.dir }] }
    expect(readStep(widened, { role: 'window', step: 'write the owner channel', command: 'touch word.md', writes: [channel], domains: [] }).refused).toBe(`the sandbox refuses the write to ${channel}`)
  })

  it('doctor names the role whose first step its environment refuses', async () => {
    const made = await consumer()
    expect(itemOf(made, 'role-environment')).toMatchObject({ goes: true, command: null })

    const settings = json(made.dir, PROJECT_SETTINGS)
    writeJson(made.dir, PROJECT_SETTINGS, { ...settings, sandbox: { ...settings.sandbox, filesystem: { ...settings.sandbox.filesystem, denyWrite: [...settings.sandbox.filesystem.denyWrite, './.git'] } } })
    const denied = itemOf(made, 'role-environment')!
    expect(denied).toMatchObject({ goes: false, refused: ['window: git commit in a branch'] })

    withoutTheEnvironment(made.dir)
    const checklist = checklistOf(made)
    const bare = checklist.items.find(item => item.item === 'role-environment')!
    expect(bare.refused).toEqual(['window: read the handoff', 'window: miko watch --once', 'window: git commit in a branch'])
    const lines: string[] = []
    printFactoryChecklist(createUi(resolveTheme({ plain: true }), text => lines.push(text)), checklist)
    expect(lines.join('')).toContain(PLAIN_LORE.factoryRefusedRoles(PLAIN_LORE.factoryItem['role-environment']!, bare.refused!))
  })
})

describe('browser-lab is called only at its installed path, and starts where a role needs it', () => {
  it('every consumer caller of browser-lab names the installed absolute path and never the tree copy', () => {
    const calls = labCallersUnder('templates').flatMap(file => [...readFileSync(path.join(REPO_ROOT, file), 'utf8').matchAll(LAB_CALL)].map(found => ({ file, prefix: found[1] })))
    expect(calls.length).toBeGreaterThan(10)
    expect(calls.filter(call => call.prefix !== INSTALLED_PREFIX)).toEqual([])
  })

  it('sync --apply removes the dead relative browser-lab entry from the excluded commands', async () => {
    const made = await consumer()
    const entry = browserLabExcludedCommand(made.home)
    writeFileSync(path.join(made.dir, SETTINGS_FILE), `{\n  "sandbox": {\n    "excludedCommands": [\n      "${RECORDED_BY_AN_EARLIER_ATTACH}",\n      "${entry}"\n    ]\n  },\n  "model": "opus"\n}\n`)
    const project = json(made.dir, PROJECT_SETTINGS)
    writeJson(made.dir, PROJECT_SETTINGS, { ...project, sandbox: { ...project.sandbox, excludedCommands: [RECORDED_BY_AN_EARLIER_ATTACH] } })

    applySync(made.dir, VERSION, made.home)

    expect(readFileSync(path.join(made.dir, SETTINGS_FILE), 'utf8')).toBe(`{\n  "sandbox": {\n    "excludedCommands": [\n      "${entry}"\n    ]\n  },\n  "model": "opus",\n  "permissions": {\n    "allow": [\n      "${allowRule(entry)}"\n    ]\n  }\n}\n`)
    expect(json(made.dir, PROJECT_SETTINGS).sandbox.excludedCommands).toBeUndefined()
  })

  it('doctor names the role whose environment does not let browser-lab start', async () => {
    const made = await consumer()
    installTheLab(made.home)
    expect(itemOf(made, 'browser-lab-roles')).toMatchObject({ goes: true })

    writeJson(made.dir, SETTINGS_FILE, {})
    expect(itemOf(made, 'browser-lab-roles')).toMatchObject({ goes: false, refused: ['window', 'launch', 'answer'] })

    const situations = roleSituations(new FileReadings(made.dir), made.dir, made.home)
    expect(readStep(situations.window, browserLabStep('window', made.home)).outsideTheSandbox).toBe(false)
  })

  it('a call of the tree copy of browser-lab stays inside the card sandbox', async () => {
    const made = await consumer()
    installTheLab(made.home)
    const card = cardTreeOf(made)
    const settings = shiftSettings(card.tree, { prepush: [], handoffWrite: null, codeMatrix: null }, [], made.home)
    expect(settings.sandbox.excludedCommands).toEqual([browserLabExcludedCommand(made.home)])
    for (const entry of settings.sandbox.excludedCommands ?? []) {
      expect(entry).not.toBe(RECORDED_BY_AN_EARLIER_ATTACH)
      expect(entry.startsWith('node scripts/')).toBe(false)
    }
  })
})

describe('a card session of a consumer commits in a tree whose git data lives in the main checkout', () => {
  it('a card session in a consumer with no user settings makes commit+PR', async () => {
    const made = await consumer()
    const card = cardTreeOf(made)
    const session = cardSessionOf(card, made.home)
    const steps = cardFirstSteps(card.gitDir, card.commonDir)
    expect(shiftSettings(card.tree, { prepush: [], handoffWrite: null, codeMatrix: null }, [], made.home).sandbox.filesystem?.allowWrite).toEqual(expect.arrayContaining(cardTreeGitWrites(card.gitDir, card.commonDir)))
    expect(Object.fromEntries(steps.map(step => [step.role, readStep(session, step).refused]))).toEqual({ launch: null, answer: null, review: null })
  })

  it('a consumer card session under the sandbox commits, pushes and opens a PR from a tree whose git data lives in the main checkout', async () => {
    const made = await consumer()
    const card = cardTreeOf(made)
    const session = cardSessionOf(card, made.home)
    const write = (target: string): string | null => readStep(session, { role: 'launch', step: target, command: 'git commit -m step', writes: [target], domains: [] }).refused
    const committed = [
      path.join(card.gitDir, 'index.lock'),
      path.join(card.gitDir, 'logs', 'HEAD'),
      path.join(card.commonDir, 'objects', 'ab', 'cdef'),
      path.join(card.commonDir, 'refs', 'heads', 'card'),
      path.join(card.commonDir, 'refs', 'remotes', 'origin', 'card'),
      path.join(card.commonDir, 'logs', 'refs', 'heads', 'card'),
    ]
    expect(Object.fromEntries(committed.map(target => [target, write(target)]))).toEqual(Object.fromEntries(committed.map(target => [target, null])))
    for (const running of [path.join(card.commonDir, 'hooks', 'pre-commit'), path.join(card.commonDir, 'config'), path.join(made.home, OWNER_CHANNEL_HOME, 'answers', 'x.md')])
      expect(write(running), running).not.toBeNull()

    git(card.tree, 'commit', '-q', '--allow-empty', '-m', 'step')
    expect(git(made.dir, 'log', '-1', '--format=%s', 'card').trim()).toBe('step')
  })
})

describe('the owner channel the environment keeps out of every write', () => {
  it('is the channel the owner module writes into', () => {
    expect(resolved(OWNER_CHANNEL_ENTRY, '/r', '/h')).toBe(path.join('/h', OWNER_CHANNEL_HOME))
  })
})

describe('browser-lab steps of the roles that need it', () => {
  it('names the installed lab in every lab step', () => {
    for (const role of LAB_ROLES)
      expect(browserLabStep(role, '/h').command.startsWith(`node ${browserLabInstalledScript('/h')} `)).toBe(true)
  })
})

describe('the role environment is a planned write of sync and init, never a side effect', () => {
  it('sync reports, writes and records the environment a kept construct settings file lacks', async () => {
    const made = await consumer()
    const settings = json(made.dir, PROJECT_SETTINGS)
    const { sandbox: _sandbox, ...rest } = settings
    writeJson(made.dir, PROJECT_SETTINGS, { ...rest, model: 'opus' })

    const applied = applySync(made.dir, VERSION, made.home)!

    expect(applied.written).toContain(PROJECT_SETTINGS)
    expect(applied.report.classifications.find(entry => entry.target === PROJECT_SETTINGS)?.class).toBe('update')
    const text = readFileSync(path.join(made.dir, PROJECT_SETTINGS), 'utf8')
    expect(readManifest(made.dir)!.sync?.files[PROJECT_SETTINGS]).toBe(ownedSha(PROJECT_SETTINGS, text))
    expect(JSON.parse(text)).toMatchObject({ model: 'opus', sandbox: settings.sandbox })
    expect(runSync(made.dir, VERSION)!.classifications.find(entry => entry.target === PROJECT_SETTINGS)?.class).toBe('keep')
  })

  it('sync writes the environment into a construct settings file whose template hooks moved on', async () => {
    const made = await consumer()
    const settings = json(made.dir, PROJECT_SETTINGS)
    const { sandbox: _sandbox, hooks, ...rest } = settings
    const allow = (settings.permissions.allow as string[]).filter(rule => !rule.startsWith('Read(~/'))
    writeJson(made.dir, PROJECT_SETTINGS, { ...rest, permissions: { ...settings.permissions, allow }, hooks: { PreToolUse: hooks.PreToolUse } })
    expect(runSync(made.dir, VERSION)!.classifications.find(entry => entry.target === PROJECT_SETTINGS)?.class).toBe('update')

    const applied = applySync(made.dir, VERSION, made.home)!

    expect(applied.written).toContain(PROJECT_SETTINGS)
    const written = json(made.dir, PROJECT_SETTINGS)
    expect(written.hooks).toEqual(hooks)
    expect(written.sandbox).toEqual(settings.sandbox)
    expect(written.permissions.allow).toEqual(expect.arrayContaining(settings.permissions.allow as string[]))
    expect(readManifest(made.dir)!.sync?.files[PROJECT_SETTINGS]).toBe(ownedSha(PROJECT_SETTINGS, readFileSync(path.join(made.dir, PROJECT_SETTINGS), 'utf8')))
  })

  it('the browser lab exclusion never writes the project settings', async () => {
    const made = await consumer()
    withoutTheEnvironment(made.dir)
    const before = readFileSync(path.join(made.dir, PROJECT_SETTINGS), 'utf8')
    excludedBrowserLabInTheConstruct(made.dir, made.home)
    expect(readFileSync(path.join(made.dir, PROJECT_SETTINGS), 'utf8')).toBe(before)
  })

  it('leaves a settings file the construct did not write untouched', async () => {
    const made = await consumer()
    const foreign = `${JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo own' }] }] } }, null, 2)}\n`
    expect(settledProjectSettings(made.dir, foreign)).toBeNull()
    expect(settledProjectSettings(made.dir, readFileSync(path.join(made.dir, PROJECT_SETTINGS), 'utf8'))).not.toBeNull()
  })

  it('never rewrites the project settings of the owner checkout', async () => {
    const made = await consumer()
    const text = readFileSync(path.join(made.dir, PROJECT_SETTINGS), 'utf8')
    withoutTheEnvironment(made.dir)
    const bare = readFileSync(path.join(made.dir, PROJECT_SETTINGS), 'utf8')
    expect(settledProjectSettings(made.dir, bare)).toBe(text)
    mkdirSync(path.dirname(path.join(made.dir, OWNER_AGENT_FILE)), { recursive: true })
    writeFileSync(path.join(made.dir, OWNER_AGENT_FILE), '')
    expect(settledProjectSettings(made.dir, bare)).toBeNull()
  })
})

describe('doctor reads every refusal a role environment can carry', () => {
  it('names the step a deny rule refuses', async () => {
    const made = await consumer()
    const settings = json(made.dir, PROJECT_SETTINGS)
    writeJson(made.dir, PROJECT_SETTINGS, { ...settings, permissions: { ...settings.permissions, deny: ['Bash(miko watch:*)'] } })
    expect(itemOf(made, 'role-environment')).toMatchObject({ goes: false, refused: ['window: miko watch --once'] })
  })

  it('names the role whose sandbox does not reach the GitHub API', async () => {
    const made = await consumer()
    const settings = json(made.dir, PROJECT_SETTINGS)
    const allowedDomains = (settings.sandbox.network.allowedDomains as string[]).filter(domain => domain !== GITHUB_API_DOMAIN)
    writeJson(made.dir, PROJECT_SETTINGS, { ...settings, sandbox: { ...settings.sandbox, network: { ...settings.sandbox.network, allowedDomains } } })
    expect(itemOf(made, 'role-environment')).toMatchObject({ goes: false, refused: ['window: miko watch --once'] })
  })
})
