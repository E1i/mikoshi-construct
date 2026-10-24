import type { SpawnSyncReturns } from 'node:child_process'
import type { LaunchctlRun } from '../scripts/bus/start.js'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { build } from 'tsup'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { BUS_RUN_LAUNCH, carriesMarker, installedPackage, launchArgv } from '../scripts/bus/bg.js'
import { AGENT_LOG, agentLabel, installKeepAlive, KEEP_ALIVE_PLATFORM, LAUNCH_AGENTS, OWNER_AGENT, runStart, USAGE } from '../scripts/bus/start.js'
import { SUPERVISE_FLAG, SUPERVISOR_LAUNCH } from '../scripts/bus/supervisor.js'
import { BUS_DB_VARIABLE, busDirOf } from '../scripts/core/bus-path.js'
import { waitFor } from '../scripts/tests/wait-for.js'
import { copyFactoryAssets, factoryBuild, factoryEntries, OUT_DIR, productBuild } from '../tsup.config.js'

const REPOSITORY = path.resolve(import.meta.dirname, '..')
const PACKAGE_NAME = 'mikoshi-construct'
const START_BIN = 'construct-factory'
const START_ENTRY = 'scripts/bus/start.ts'
const PACKED_BESIDE_THE_BUILD = ['package.json', 'README.md', 'LICENSE', 'templates']
const PACK_TIMEOUT_MS = 300_000
const LAUNCHED_WITHIN_MS = 10_000
const SYSTEM_BIN_DIRS = ['/usr/bin', '/bin']
const UID = 501
const USER_PATH = '/opt/user/bin:/usr/bin:/bin'
const SECURITY_INVARIANTS = path.join(REPOSITORY, 'architecture', 'security-invariants.md')
const FACTORY_SPAWNS = ['launchctl', 'nohup', 'ps']
const LAUNCHCTL_SUBCOMMANDS = ['print', 'bootout', 'bootstrap']
const SPAWN_BOUNDARY_TEST = 'construct-factory spawns only launchctl and the supervisor the package ships'
const SPAWN_BOUNDARY_SANDBOX_LEVEL = 'none'
const SPAWNS_LOG = 'spawns.jsonl'
const NEVER_SPAWNED = ['pnpm', 'git']
const NOHUP_ENTRIES = ['supervisor.js', 'run.js']
const SPAWN_RECORDER = `import childProcess from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import process from 'node:process'
const log = process.env.STUB_OUT + '/${SPAWNS_LOG}'
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
  const original = childProcess[name]
  childProcess[name] = function (command, ...rest) {
    appendFileSync(log, JSON.stringify({ command, args: Array.isArray(rest[0]) ? rest[0] : [] }) + '\\n')
    return original.call(this, command, ...rest)
  }
}
syncBuiltinESMExports()
`

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function tempRoot(prefix: string): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)))
  roots.push(root)
  return root
}

function stub(bin: string, name: string, body: string): void {
  const file = path.join(bin, name)
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
}

function recordingLaunchctl(status = 0): { calls: string[][], run: (args: string[]) => LaunchctlRun } {
  const calls: string[][] = []
  return { calls, run: (args) => {
    calls.push(args)
    return { status: args[0] === 'print' ? 1 : status, stderr: '' }
  } }
}

function keepAliveParts(home: string, launchctl: (args: string[]) => LaunchctlRun, platform: NodeJS.Platform = KEEP_ALIVE_PLATFORM) {
  const busDb = path.join(home, '.construct', 'bus.db')
  return { platform, home, uid: UID, node: process.execPath, path: USER_PATH, busDb, busDir: busDirOf(busDb), launchctl }
}

function plistValue(text: string, key: string): string | undefined {
  return new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(text)?.[1]
}

function linesOf(file: string): string[] {
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(line => line !== '') : []
}

function spawnBoundaryRow(): string | undefined {
  const text = readFileSync(SECURITY_INVARIANTS, 'utf8')
  const block = text.slice(text.indexOf('<!-- construct:discover:security-invariants -->'), text.indexOf('<!-- /construct:discover:security-invariants -->'))
  return block.split('\n').find(line => line.startsWith('| `construct-factory`'))
}

function clauseAfter(text: string, label: string): string {
  const start = text.indexOf(label)
  return start === -1 ? '' : text.slice(start + label.length, text.indexOf('. ', start))
}

function listAfter(text: string, label: string): string[] {
  const clause = clauseAfter(text, label)
  return [...clause.slice(0, clause.includes(';') ? clause.indexOf(';') : clause.length).matchAll(/`([^`]+)`/g)].map(match => match[1]!)
}

interface RecordedSpawn {
  command: string
  args: string[]
}

function recordedSpawns(file: string): RecordedSpawn[] {
  return linesOf(file).map(line => JSON.parse(line) as RecordedSpawn)
}

describe('the construct-factory spawn boundary', () => {
  it('security-invariants names the construct-factory spawn boundary and the test that holds it', () => {
    const row = spawnBoundaryRow()
    expect(row, 'a row starting | `construct-factory` inside the discovery block').toBeDefined()
    const [invariant, enforcedBy] = row!.split(' | ')
    expect(listAfter(invariant!, 'Spawns only: ')).toEqual(FACTORY_SPAWNS)
    expect(listAfter(invariant!, '`launchctl` subcommands only: ')).toEqual(LAUNCHCTL_SUBCOMMANDS)
    expect(listAfter(invariant!, 'Never spawned: ')).toEqual(NEVER_SPAWNED)
    for (const entry of NOHUP_ENTRIES)
      expect(clauseAfter(invariant!, '`nohup` targets only: ')).toContain(`\`${entry}\``)
    expect(clauseAfter(invariant!, 'Sandbox: ')).toContain(`run at level \`${SPAWN_BOUNDARY_SANDBOX_LEVEL}\``)
    expect(enforcedBy).toContain('`tests/factory-start.test.ts`')
    expect(enforcedBy).toContain(`\`${SPAWN_BOUNDARY_TEST}\``)
  })
})

describe('a factory process is launched as the package it runs from', () => {
  it('runs a worker as pnpm --silent <script> in this checkout and as node on its built file from an installed package', () => {
    expect(installedPackage(`file://${path.join(REPOSITORY, 'scripts', 'bus', 'bg.ts')}`)).toBeNull()
    expect(launchArgv(BUS_RUN_LAUNCH, null)).toEqual(['nohup', 'pnpm', '--silent', BUS_RUN_LAUNCH.script])
    const installed = installedPackage(`file://${path.join(REPOSITORY, OUT_DIR, 'scripts', 'bus', 'bg.js')}`)
    expect(installed).toBe(`${REPOSITORY}/`)
    expect(launchArgv(SUPERVISOR_LAUNCH, installed)).toEqual(['nohup', process.execPath, path.join(REPOSITORY, OUT_DIR, 'scripts', 'bus', 'supervisor.js'), SUPERVISE_FLAG])
  })

  it('refuses a script the package names no factory entry for, rather than starting something else', () => {
    expect(() => launchArgv({ ...BUS_RUN_LAUNCH, script: 'lint' }, REPOSITORY)).toThrow(/names no factory entry for lint/)
  })

  it('knows a running instance by its built file as well as by its source file', () => {
    expect(carriesMarker(`node /x/${OUT_DIR}/scripts/bus/supervisor.js ${SUPERVISE_FLAG}`, SUPERVISOR_LAUNCH.markers)).toBe(true)
    expect(carriesMarker(`node --import tsx scripts/bus/supervisor.ts ${SUPERVISE_FLAG}`, SUPERVISOR_LAUNCH.markers)).toBe(true)
    expect(carriesMarker(`node /x/${OUT_DIR}/scripts/bus/supervisor.js`, SUPERVISOR_LAUNCH.markers)).toBe(false)
    expect(carriesMarker(`node /x/${OUT_DIR}/scripts/bus/run.js`, BUS_RUN_LAUNCH.markers)).toBe(true)
  })
})

describe('the keep-alive of the start command', () => {
  it('the start command installs a keep-alive for the user repository and not for the owner checkout', async () => {
    const home = tempRoot('factory-home-')
    const user = path.join(tempRoot('factory-user-'), 'shop')
    mkdirSync(user)
    const userLaunchctl = recordingLaunchctl()
    const started: string[] = []
    const startOf = (repository: string) => async () => {
      started.push(repository)
      return { stdout: [], stderr: [], exitCode: 0 }
    }

    const forUser = await runStart(user, REPOSITORY, keepAliveParts(home, userLaunchctl.run), startOf(user))

    expect(forUser.exitCode, forUser.stderr.join('\n')).toBe(0)
    const label = agentLabel(user)
    const plist = path.join(home, LAUNCH_AGENTS, `${label}.plist`)
    const text = readFileSync(plist, 'utf8')
    expect(plistValue(text, 'Label')).toBe(label)
    expect(plistValue(text, 'WorkingDirectory')).toBe(user)
    expect(plistValue(text, 'PATH')).toBe(USER_PATH)
    expect(plistValue(text, BUS_DB_VARIABLE)).toBe(path.join(home, '.construct', 'bus.db'))
    expect(plistValue(text, 'StandardOutPath')).toBe(path.join(home, '.construct', 'bus', AGENT_LOG))
    expect([...text.matchAll(/<array>([\s\S]*?)<\/array>/g)][0]![1]!.match(/<string>[^<]*<\/string>/g)).toEqual([`<string>${process.execPath}</string>`, `<string>${path.join(REPOSITORY, OUT_DIR, 'scripts', 'bus', 'supervisor.js')}</string>`])
    expect(text).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/)
    expect(text).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/)
    expect(text).not.toContain(OWNER_AGENT)
    expect(userLaunchctl.calls.at(-1)).toEqual(['bootstrap', `gui/${UID}`, plist])

    const ownerHome = tempRoot('factory-owner-home-')
    const ownerLaunchctl = recordingLaunchctl()
    const forOwner = await runStart(REPOSITORY, null, keepAliveParts(ownerHome, ownerLaunchctl.run), startOf(REPOSITORY))

    expect(forOwner.exitCode, forOwner.stderr.join('\n')).toBe(0)
    expect(forOwner.stdout.join('\n')).toContain(OWNER_AGENT)
    expect(existsSync(path.join(ownerHome, LAUNCH_AGENTS))).toBe(false)
    expect(ownerLaunchctl.calls).toEqual([])
    expect(started).toEqual([user, REPOSITORY])
  })

  it('leaves a keep-alive that is already installed and loaded as it is', () => {
    const home = tempRoot('factory-home-')
    const user = tempRoot('factory-user-')
    installKeepAlive(user, REPOSITORY, keepAliveParts(home, recordingLaunchctl().run))
    const calls: string[][] = []
    const again = installKeepAlive(user, REPOSITORY, keepAliveParts(home, (args) => {
      calls.push(args)
      return { status: 0, stderr: '' }
    }))
    expect(again.exitCode).toBe(0)
    expect(calls).toEqual([['print', `gui/${UID}/${agentLabel(user)}`]])
  })

  it('fails naming launchctl when it refuses the agent', () => {
    const result = installKeepAlive(tempRoot('factory-user-'), REPOSITORY, keepAliveParts(tempRoot('factory-home-'), recordingLaunchctl(5).run))
    expect(result.exitCode).toBe(1)
    expect(result.stderr.join('\n')).toContain('launchctl bootstrap')
  })

  it('refuses to install a keep-alive for a user repository when it runs from source, since the agent starts the built factory', () => {
    const home = tempRoot('factory-home-')
    const launchctl = recordingLaunchctl()
    const result = installKeepAlive(tempRoot('factory-user-'), null, keepAliveParts(home, launchctl.run))
    expect(result.exitCode).toBe(1)
    expect(result.stderr.join('\n')).toContain('runs from source')
    expect(existsSync(path.join(home, LAUNCH_AGENTS))).toBe(false)
    expect(launchctl.calls).toEqual([])
  })

  it('installs no agent where launchd does not exist and says how the factory survives there', () => {
    const home = tempRoot('factory-home-')
    const launchctl = recordingLaunchctl()
    const result = installKeepAlive(tempRoot('factory-user-'), REPOSITORY, keepAliveParts(home, launchctl.run, 'linux'))
    expect(result.exitCode).toBe(0)
    expect(result.stdout.join('\n')).toContain('survives closing the terminal')
    expect(existsSync(path.join(home, LAUNCH_AGENTS))).toBe(false)
    expect(launchctl.calls).toEqual([])
  })

  it('exits 2 with its usage when given an argument, starting nothing', () => {
    const run = spawnSync(process.execPath, ['--import', 'tsx', START_ENTRY, 'extra'], { cwd: REPOSITORY, encoding: 'utf8' })
    expect(run.status, run.stderr).toBe(2)
    expect(run.stderr.trim()).toBe(USAGE)
    expect(run.stdout).toBe('')
  })

  it('gives two repositories of one name two agents', () => {
    expect(agentLabel('/a/shop')).not.toBe(agentLabel('/b/shop'))
  })
})

interface Packed {
  root: string
  installed: string
  prefix: string
}

let packed: Packed

async function packAndInstall(): Promise<Packed> {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'factory-start-')))
  const stage = path.join(root, 'stage')
  for (const file of PACKED_BESIDE_THE_BUILD)
    cpSync(path.join(REPOSITORY, file), path.join(stage, file), { recursive: true })
  const outDir = path.join(stage, OUT_DIR)
  await build({ ...productBuild, outDir, config: false, silent: true })
  await build({ ...factoryBuild, outDir, config: false, silent: true, onSuccess: async () => copyFactoryAssets(outDir) })
  const env = { ...process.env, npm_config_cache: path.join(root, 'npm-cache'), npm_config_update_notifier: 'false' }
  const [tarball] = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', root], { cwd: stage, env, encoding: 'utf8' })) as { filename: string }[]
  const prefix = path.join(root, 'prefix')
  execFileSync('npm', ['install', '--global', '--prefix', prefix, path.join(root, tarball!.filename), '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: root, env, encoding: 'utf8' })
  return { root, installed: path.join(prefix, 'lib', 'node_modules', PACKAGE_NAME), prefix }
}

describe('the start command in the published package', () => {
  let run: SpawnSyncReturns<string>
  let home: string
  let user: string
  let out: string

  beforeAll(async () => {
    packed = await packAndInstall()
    const bin = path.join(packed.root, 'stub-bin')
    out = path.join(packed.root, 'stub-out')
    home = path.join(packed.root, 'home')
    user = path.join(packed.root, 'user-repo')
    for (const directory of [bin, out, home, user])
      mkdirSync(directory, { recursive: true })
    stub(bin, 'ps', 'exit 0')
    stub(bin, 'nohup', 'printf \'%s\\n\' "$*" >> "$STUB_OUT/nohup.argv"')
    stub(bin, 'launchctl', 'printf \'%s\\n\' "$*" >> "$STUB_OUT/launchctl.argv"\n[ "$1" = print ] && exit 1\nexit 0')
    const recorder = path.join(packed.root, 'record-spawns.mjs')
    writeFileSync(recorder, SPAWN_RECORDER)
    const env = { PATH: [bin, path.dirname(process.execPath), ...SYSTEM_BIN_DIRS].join(path.delimiter), HOME: home, STUB_OUT: out, CONSTRUCT_BUS_DB: path.join(packed.root, 'bus.db'), NODE_OPTIONS: `--import ${pathToFileURL(recorder).href}` }
    run = spawnSync(path.join(packed.prefix, 'bin', START_BIN), [], { cwd: user, env, encoding: 'utf8' })
  }, PACK_TIMEOUT_MS)

  afterAll(() => {
    if (packed !== undefined)
      rmSync(packed.root, { recursive: true, force: true })
  })

  it('one published command starts the factory from the installed package', async () => {
    expect(factoryEntries()).toContain(START_ENTRY)
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0)
    const argv = path.join(out, 'nohup.argv')
    const launchedLines = (): string[] => existsSync(argv) ? readFileSync(argv, 'utf8').trim().split('\n') : []
    await waitFor(() => launchedLines().length >= 2, () => `two launches in ${argv}`, LAUNCHED_WITHIN_MS)
    const launched = launchedLines()
    expect(launched).toHaveLength(2)
    expect(launched.filter(line => line.includes('pnpm'))).toEqual([])
    const built = (source: string): string => path.join(packed.installed, OUT_DIR, 'scripts', 'bus', source)
    expect(launched.map(line => line.slice(line.indexOf(' ') + 1)).sort()).toEqual([built('run.js'), `${built('supervisor.js')} ${SUPERVISE_FLAG}`].sort())
    expect(existsSync(path.join(busDirOf(path.join(packed.root, 'bus.db')), SUPERVISOR_LAUNCH.instanceFile!))).toBe(true)
  })

  it(SPAWN_BOUNDARY_TEST, async () => {
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0)
    const log = path.join(out, SPAWNS_LOG)
    const nohups = (): RecordedSpawn[] => recordedSpawns(log).filter(spawn => spawn.command === 'nohup')
    await waitFor(() => nohups().length >= 2, () => `two launches in ${log}`, LAUNCHED_WITHIN_MS)
    const spawns = recordedSpawns(log)
    expect(spawns.map(spawn => spawn.command).filter(command => !FACTORY_SPAWNS.includes(command))).toEqual([])
    expect(spawns.filter(spawn => NEVER_SPAWNED.includes(path.basename(spawn.command)) || spawn.args.some(arg => NEVER_SPAWNED.includes(arg)))).toEqual([])
    const launchctl = spawns.filter(spawn => spawn.command === 'launchctl')
    expect(launchctl.length > 0).toBe(process.platform === KEEP_ALIVE_PLATFORM)
    expect(launchctl.map(spawn => spawn.args[0]).filter(subcommand => !LAUNCHCTL_SUBCOMMANDS.includes(subcommand!))).toEqual([])
    const shipped = `${path.join(packed.installed, OUT_DIR)}${path.sep}`
    for (const { args } of nohups()) {
      expect(path.basename(args[0]!), args.join(' ')).toBe(path.basename(process.execPath))
      expect(args[1]!.startsWith(shipped), args.join(' ')).toBe(true)
    }
    expect(nohups().map(spawn => path.basename(spawn.args[1]!)).sort()).toEqual([...NOHUP_ENTRIES].sort())
    const ps = spawns.filter(spawn => spawn.command === 'ps')
    expect(ps.length > 0).toBe(true)
    expect(ps.filter(spawn => !spawn.args[0]?.startsWith('-'))).toEqual([])
  })

  it.runIf(process.platform === KEEP_ALIVE_PLATFORM)('the published command loads a keep-alive that reruns the installed starter in the user repository', () => {
    const plist = path.join(home, LAUNCH_AGENTS, `${agentLabel(user)}.plist`)
    const text = readFileSync(plist, 'utf8')
    expect(text).toContain(`<string>${path.join(packed.installed, OUT_DIR, 'scripts', 'bus', 'supervisor.js')}</string>`)
    expect(plistValue(text, 'WorkingDirectory')).toBe(user)
    expect(plistValue(text, BUS_DB_VARIABLE)).toBe(path.join(packed.root, 'bus.db'))
    expect(readFileSync(path.join(out, 'launchctl.argv'), 'utf8')).toContain(`bootstrap gui/${process.getuid!()} ${plist}`)
  })
})
