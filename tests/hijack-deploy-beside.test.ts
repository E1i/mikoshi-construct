import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BUS_DB_VARIABLE, BUS_DIR, BUS_FILE } from '../scripts/core/bus-path.js'
import { readAttachRecord, runAttach } from '../src/commands/attach/index.js'
import { runDetach } from '../src/commands/detach/index.js'
import { writeEngram } from '../src/model/discovery.js'
import { ATTACH_CARRIERS, ATTACH_GUARD, ATTACH_WINDOW_HOOKS } from '../src/presets/index.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'
import { useIsolatedHome } from './isolated-home.js'
import { listing } from './repository-listing.js'

const HARNESS = 'pnpm run quality'
const ORIGIN = 'https://github.com/example/own-construct.git'
const OWN_FACTORY_HOME = path.join('.construct', 'example--own-construct')

const ui = createUi(resolveTheme({ plain: true }), silentWriter)
const home = useIsolatedHome()

let namedBus: string | undefined
beforeEach(() => {
  namedBus = process.env[BUS_DB_VARIABLE]
  delete process.env[BUS_DB_VARIABLE]
})
afterEach(() => {
  if (namedBus !== undefined)
    process.env[BUS_DB_VARIABLE] = namedBus
})

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' })
}

function cloneCarryingItsOwnConstruct(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-own-'))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'remote', 'add', 'origin', ORIGIN)
  writeFileSync(path.join(dir, 'construct.json'), '{ "manifestVersion": 1 }\n')
  writeFileSync(path.join(dir, 'package.json'), '{ "name": "own-construct" }\n')
  for (const target of ATTACH_CARRIERS.targets) {
    mkdirSync(path.dirname(path.join(dir, target)), { recursive: true })
    writeFileSync(path.join(dir, target), `its own ${target}\n`)
  }
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'its own construct')
  git(dir, 'tag', 'v1.0.0')
  return dir
}

function snapshot(dir: string): { files: Record<string, string>, exclude: string, status: string } {
  const files = Object.fromEntries(listing(dir).map((entry) => {
    const absolute = path.join(dir, entry)
    return [entry, statSync(absolute).isDirectory() ? 'dir' : createHash('sha256').update(readFileSync(absolute)).digest('hex')]
  }))
  return {
    files,
    exclude: readFileSync(path.join(dir, '.git/info/exclude'), 'utf8'),
    status: git(dir, 'status', '--porcelain', '--ignored', '--untracked-files=all'),
  }
}

describe('attach on a repository that carries its own construct', () => {
  it('attach on a clone that carries its own construct deploys the factory beside it', async () => {
    const dir = cloneCarryingItsOwnConstruct()

    const result = await runAttach(ui, { dir, harness: HARNESS, yes: true })

    expect(result.status).toBe('done')
    const factoryHome = path.join(home(), OWN_FACTORY_HOME)
    expect(existsSync(path.join(factoryHome, BUS_FILE))).toBe(true)
    const record = readAttachRecord(dir)
    expect(record?.factoryBeside?.home).toBe(factoryHome)
    expect(Object.keys(record?.files ?? {}).sort()).toEqual([ATTACH_GUARD.target, ATTACH_GUARD.parser, ATTACH_WINDOW_HOOKS.target].sort())
    for (const target of ATTACH_CARRIERS.targets)
      expect(readFileSync(path.join(dir, target), 'utf8'), target).toBe(`its own ${target}\n`)
    expect(git(dir, 'status', '--porcelain')).toBe('')
  })

  it('a carrier present but not tracked by its construct is still a collision', async () => {
    const dir = cloneCarryingItsOwnConstruct()
    git(dir, 'rm', '-q', '--cached', ATTACH_CARRIERS.targets[0]!)
    git(dir, 'commit', '-qm', 'untrack one carrier')

    const result = await runAttach(ui, { dir, harness: HARNESS, yes: true })

    expect(result.refusal).toBe('collision')
    expect(existsSync(path.join(home(), OWN_FACTORY_HOME))).toBe(false)
  })

  it('a factory home that already exists is not deployed, recorded or later removed', async () => {
    const dir = cloneCarryingItsOwnConstruct()
    const factoryHome = path.join(home(), OWN_FACTORY_HOME)
    mkdirSync(factoryHome, { recursive: true })
    writeFileSync(path.join(factoryHome, BUS_FILE), 'already here')

    await runAttach(ui, { dir, harness: HARNESS, yes: true })
    expect(readAttachRecord(dir)?.factoryBeside).toBeUndefined()
    expect(runDetach(ui, { dir }).status).toBe('done')

    expect(readFileSync(path.join(factoryHome, BUS_FILE), 'utf8')).toBe('already here')
  })

  it('a bus named in the environment is where the factory runs, so nothing is deployed beside', async () => {
    const dir = cloneCarryingItsOwnConstruct()
    process.env[BUS_DB_VARIABLE] = path.join(home(), 'elsewhere.db')

    await runAttach(ui, { dir, harness: HARNESS, yes: true })

    expect(readAttachRecord(dir)?.factoryBeside).toBeUndefined()
    expect(existsSync(path.join(home(), OWN_FACTORY_HOME))).toBe(false)
  })
})

describe('detach removes what the factory deployed beside the repository and nothing more', () => {
  it('after detach the repository is byte for byte as before attach, the Engram is removed and user files outside the factory are intact', async () => {
    const dir = cloneCarryingItsOwnConstruct()
    const userConstructFile = path.join(home(), '.construct', 'notes.md')
    const userHomeFile = path.join(home(), 'keep.txt')
    mkdirSync(path.dirname(userConstructFile), { recursive: true })
    writeFileSync(userConstructFile, 'mine\n')
    writeFileSync(userHomeFile, 'mine too\n')
    const before = snapshot(dir)

    expect((await runAttach(ui, { dir, harness: HARNESS, yes: true })).status).toBe('done')
    const engram = writeEngram(dir, { attached: true, home: home() })
    const factoryHome = path.join(home(), OWN_FACTORY_HOME)
    mkdirSync(path.join(factoryHome, BUS_DIR))
    writeFileSync(path.join(factoryHome, BUS_DIR, 'supervisor.log'), 'ran\n')
    expect(existsSync(engram)).toBe(true)

    const result = runDetach(ui, { dir })

    expect(result.status).toBe('done')
    expect(snapshot(dir)).toEqual(before)
    expect(existsSync(engram)).toBe(false)
    expect(existsSync(path.dirname(engram))).toBe(false)
    expect(existsSync(factoryHome)).toBe(false)
    expect(readFileSync(userConstructFile, 'utf8')).toBe('mine\n')
    expect(readFileSync(userHomeFile, 'utf8')).toBe('mine too\n')
  })

  it('a keep-alive naming another place does not hold detach', async () => {
    const dir = cloneCarryingItsOwnConstruct()
    await runAttach(ui, { dir, harness: HARNESS, yes: true })
    const agents = path.join(home(), 'Library', 'LaunchAgents')
    mkdirSync(agents, { recursive: true })
    writeFileSync(path.join(agents, 'dev.someone.else.plist'), `<string>${path.join(home(), '.construct', 'example--own-construct-two', BUS_FILE)}</string>\n`)

    expect(runDetach(ui, { dir }).status).toBe('done')
    expect(existsSync(path.join(agents, 'dev.someone.else.plist'))).toBe(true)
  })

  it('removes the directories attach created above the factory home, and only those', async () => {
    const dir = cloneCarryingItsOwnConstruct()

    await runAttach(ui, { dir, harness: HARNESS, yes: true })
    expect(readAttachRecord(dir)?.factoryBeside?.createdFrom).toBe(path.join(home(), '.construct'))
    runDetach(ui, { dir })

    expect(existsSync(path.join(home(), '.construct'))).toBe(false)
    expect(existsSync(home())).toBe(true)
  })

  it('leaves no emptied Engram directory under the construct home attach created', async () => {
    const dir = cloneCarryingItsOwnConstruct()

    await runAttach(ui, { dir, harness: HARNESS, yes: true })
    writeEngram(dir, { attached: true, home: home() })
    runDetach(ui, { dir })

    expect(existsSync(path.join(home(), '.construct'))).toBe(false)
  })

  it('keeps the Engram directory a construct home attach did not create already held', async () => {
    const dir = cloneCarryingItsOwnConstruct()
    const engramRoot = path.join(home(), '.construct', 'engram')
    mkdirSync(engramRoot, { recursive: true })

    await runAttach(ui, { dir, harness: HARNESS, yes: true })
    writeEngram(dir, { attached: true, home: home() })
    runDetach(ui, { dir })

    expect(existsSync(engramRoot)).toBe(true)
  })

  it('refuses while a keep-alive names the factory home, and removes nothing', async () => {
    const dir = cloneCarryingItsOwnConstruct()
    await runAttach(ui, { dir, harness: HARNESS, yes: true })
    const factoryHome = path.join(home(), OWN_FACTORY_HOME)
    const engram = writeEngram(dir, { attached: true, home: home() })
    const attached = snapshot(dir)
    const agents = path.join(home(), 'Library', 'LaunchAgents')
    mkdirSync(agents, { recursive: true })
    writeFileSync(path.join(agents, 'dev.mikoshi.factory.own-construct.plist'), `<string>${path.join(factoryHome, BUS_FILE)}</string>\n`)
    writeFileSync(path.join(agents, 'dev.someone.else.plist'), '<string>/elsewhere/bus.db</string>\n')

    const result = runDetach(ui, { dir })

    expect(result).toEqual({ status: 'refused', refusal: 'factory-kept-alive', removed: [] })
    expect(snapshot(dir)).toEqual(attached)
    expect(existsSync(path.join(factoryHome, BUS_FILE))).toBe(true)
    expect(existsSync(engram)).toBe(true)
  })
})
