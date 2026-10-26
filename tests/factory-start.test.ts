import type { SpawnSyncReturns } from 'node:child_process'
import type { BusEvent } from '../scripts/core/db.js'
import type { WindowShard } from '../scripts/policy/shards.js'
import type { LaunchctlRun, ModeParts } from '../scripts/supervisor/start.js'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { build } from 'tsup'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { BUS_DB_VARIABLE, busDirOf, repoIdOf } from '../scripts/core/bus-path.js'
import { SHARD_ISSUED, SHARD_REVOKED } from '../scripts/core/events.js'
import { FACTORY_WORKERS } from '../scripts/core/factory-paths.js'
import { LIVE_FLAG } from '../scripts/core/node.js'
import { sayToOwnerChannel, USED_WORD } from '../scripts/owner/channel.js'
import { BUS_FLAG, BUS_RUN_LAUNCH, carriesMarker, installedPackage, launchArgv, runBusBg } from '../scripts/supervisor/bg.js'
import { AGENT_LOG, agentLabel, factoryBusOf, ghostProtocolWord, installKeepAlive, KEEP_ALIVE_PLATFORM, KEEP_ALIVE_PROGRAM, LAUNCH_AGENTS, OWNER_AGENT, OWNER_AGENT_FILE, runMode, runStart, sayCommand, START_BIN, startCommandOf, USAGE } from '../scripts/supervisor/start.js'
import { SUPERVISE_FLAG, SUPERVISOR_LAUNCH } from '../scripts/supervisor/supervisor.js'
import { liveWorkers, MODE_WORKERS, modeOf, returnToWindowAtTermEnd, switchDetection, switchedOn, switchWorker, termEndOf, wantedLaunches, WORKERS, WORKERS_FILE } from '../scripts/supervisor/workers.js'
import { waitFor } from '../scripts/tests/wait-for.js'
import { copyFactoryAssets, factoryBuild, factoryEntries, OUT_DIR, productBuild } from '../tsup.config.js'

const REPOSITORY = path.resolve(import.meta.dirname, '..')
const PACKAGE_NAME = 'mikoshi-construct'
const START_ENTRY = 'scripts/supervisor/start.ts'
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
const FRESH_LAUNCHES = [...NOHUP_ENTRIES, ...MODE_WORKERS.window.map(worker => `${path.basename(FACTORY_WORKERS[worker], '.ts')}.js`)]
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
  return { platform, home, uid: UID, path: USER_PATH, busDb, busDir: busDirOf(busDb), launchctl }
}

function plistValue(text: string, key: string): string | undefined {
  return new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(text)?.[1]
}

function programArguments(text: string): string[] {
  return [...[...text.matchAll(/<array>([\s\S]*?)<\/array>/g)][0]![1]!.matchAll(/<string>([^<]*)<\/string>/g)].map(match => match[1]!)
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
    expect(installedPackage(`file://${path.join(REPOSITORY, 'scripts', 'supervisor', 'bg.ts')}`)).toBeNull()
    expect(launchArgv(BUS_RUN_LAUNCH, null)).toEqual(['nohup', 'pnpm', '--silent', BUS_RUN_LAUNCH.script])
    const installed = installedPackage(`file://${path.join(REPOSITORY, OUT_DIR, 'scripts', 'supervisor', 'bg.js')}`)
    expect(installed).toBe(`${REPOSITORY}/`)
    expect(launchArgv(SUPERVISOR_LAUNCH, installed)).toEqual(['nohup', process.execPath, path.join(REPOSITORY, OUT_DIR, 'scripts', 'supervisor', 'supervisor.js'), SUPERVISE_FLAG])
  })

  it('carries the absolute path of its bus as --bus after its own args, so ps reads the bus from the command line', () => {
    expect(launchArgv(BUS_RUN_LAUNCH, null, 'bus.db')).toEqual(['nohup', 'pnpm', '--silent', BUS_RUN_LAUNCH.script, BUS_FLAG, path.resolve('bus.db')])
    expect(launchArgv(SUPERVISOR_LAUNCH, `${REPOSITORY}/`, '/x/bus.db')).toEqual(['nohup', process.execPath, path.join(REPOSITORY, OUT_DIR, 'scripts', 'supervisor', 'supervisor.js'), SUPERVISE_FLAG, BUS_FLAG, '/x/bus.db'])
  })

  it('refuses a script the package names no factory entry for, rather than starting something else', () => {
    expect(() => launchArgv({ ...BUS_RUN_LAUNCH, script: 'lint' }, REPOSITORY)).toThrow(/names no factory entry for lint/)
  })

  it('knows a running instance by its built file as well as by its source file', () => {
    expect(carriesMarker(`node /x/${OUT_DIR}/scripts/supervisor/supervisor.js ${SUPERVISE_FLAG}`, SUPERVISOR_LAUNCH.markers)).toBe(true)
    expect(carriesMarker(`node --import tsx scripts/supervisor/supervisor.ts ${SUPERVISE_FLAG}`, SUPERVISOR_LAUNCH.markers)).toBe(true)
    expect(carriesMarker(`node /x/${OUT_DIR}/scripts/supervisor/supervisor.js`, SUPERVISOR_LAUNCH.markers)).toBe(false)
    expect(carriesMarker(`node /x/${OUT_DIR}/scripts/supervisor/run.js`, BUS_RUN_LAUNCH.markers)).toBe(true)
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
    expect(programArguments(text)).toEqual(KEEP_ALIVE_PROGRAM)
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

  it('the keep-alive plist names no install path of node or the supervisor', () => {
    const home = tempRoot('factory-home-')
    const user = tempRoot('factory-user-')
    expect(installKeepAlive(user, REPOSITORY, keepAliveParts(home, recordingLaunchctl().run)).exitCode).toBe(0)
    const text = readFileSync(path.join(home, LAUNCH_AGENTS, `${agentLabel(user)}.plist`), 'utf8')
    expect(programArguments(text)).toEqual(['/usr/bin/env', START_BIN])
    for (const pinned of [process.execPath, path.dirname(process.execPath), REPOSITORY, OUT_DIR, 'supervisor.js'])
      expect(text, pinned).not.toContain(pinned)
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

describe('the bus the start command runs over', () => {
  it('the owner checkout keeps the machine bus and a clone gets its own, even before it exists', () => {
    const home = tempRoot('factory-home-')
    const machine = path.join(home, '.construct', 'bus.db')
    mkdirSync(path.dirname(machine), { recursive: true })
    writeFileSync(machine, '')
    const owner = tempRoot('factory-owner-')
    mkdirSync(path.join(owner, path.dirname(OWNER_AGENT_FILE)), { recursive: true })
    writeFileSync(path.join(owner, OWNER_AGENT_FILE), '')
    const clone = tempRoot('factory-clone-')
    const ownerEnv: NodeJS.ProcessEnv = {}
    const cloneEnv: NodeJS.ProcessEnv = {}

    expect(factoryBusOf(ownerEnv, home, owner)).toBe(machine)
    const own = factoryBusOf(cloneEnv, home, clone)

    expect(own).toBe(path.join(home, '.construct', repoIdOf(clone), 'bus.db'))
    expect(existsSync(own)).toBe(false)
    expect(ownerEnv[BUS_DB_VARIABLE]).toBe(machine)
    expect(cloneEnv[BUS_DB_VARIABLE]).toBe(own)
  })
})

describe('the exit code of the start command', () => {
  it('a start that started nothing for its own bus exits non-zero', async () => {
    const parts = keepAliveParts(tempRoot('factory-home-'), recordingLaunchctl().run, 'linux')
    const unreadBusRun = () => [{ pid: 4242, args: `node /x/${OUT_DIR}/scripts/supervisor/run.js` }]
    const startOverOwnBus = async () => runBusBg(parts.busDir, [BUS_RUN_LAUNCH], { [BUS_DB_VARIABLE]: parts.busDb }, unreadBusRun)

    const result = await runStart(tempRoot('factory-user-'), REPOSITORY, parts, startOverOwnBus)

    expect(result.exitCode).toBe(1)
    expect(result.stderr.join('\n')).toContain(`started nothing for ${parts.busDb}`)
  })

  it('a second construct-factory over a running or starting factory exits 0', async () => {
    const parts = keepAliveParts(tempRoot('factory-home-'), recordingLaunchctl().run, 'linux')
    const env = { [BUS_DB_VARIABLE]: parts.busDb }
    const startArgs = `node /x/${OUT_DIR}/scripts/supervisor/start.js`
    const otherStart = 4243
    const supervisor = { pid: 4244, args: `node /x/${OUT_DIR}/scripts/supervisor/supervisor.js ${SUPERVISE_FLAG} ${BUS_FLAG} ${parts.busDb}`, bus: parts.busDb }
    const servedBus = () => [{ pid: process.pid, args: startArgs }, { pid: otherStart, args: startArgs }, supervisor]
    mkdirSync(parts.busDir, { recursive: true })
    writeFileSync(path.join(parts.busDir, BUS_RUN_LAUNCH.startLock), `${otherStart}\n`)

    const second = await runStart(tempRoot('factory-user-'), REPOSITORY, parts, async () => runBusBg(parts.busDir, [BUS_RUN_LAUNCH, SUPERVISOR_LAUNCH], env, servedBus))

    expect(second.exitCode, second.stderr.join('\n')).toBe(0)
    expect(second.stdout.join('\n')).toContain(`pid ${otherStart}`)
    expect(second.stdout.join('\n')).toContain(`pid ${supervisor.pid}`)

    const unserved = () => [{ pid: process.pid, args: startArgs }, { pid: otherStart, args: startArgs }]
    const startingOnly = await runStart(tempRoot('factory-user-'), REPOSITORY, parts, async () => runBusBg(parts.busDir, [BUS_RUN_LAUNCH], env, unserved))
    expect(startingOnly.exitCode, startingOnly.stderr.join('\n')).toBe(0)
  })
})

const SHARD_ID = 'shard-1'
const NOW = new Date('2026-10-25T12:00:00.000Z')
const WINDOW_WORKERS = ['review', 'launch', 'answer', 'witness']
const TERM_END = '2026-10-25T20:00:00.000Z'

interface ModeBench {
  parts: ModeParts
  events: BusEvent[]
  channel: string
}

function modeBench(active: WindowShard[] = []): ModeBench {
  const root = tempRoot('factory-mode-')
  const events: BusEvent[] = []
  const channel = path.join(root, 'answers')
  return { events, channel, parts: { busDir: path.join(root, 'bus'), channel, now: () => NOW, uuid: () => SHARD_ID, record: event => events.push(event), activeWindows: () => active } }
}

function modeCommand(...argv: string[]) {
  const command = startCommandOf(argv)
  if (command === null || command.kind === 'start')
    throw new Error(`${argv.join(' ')} is not a mode command`)
  return command
}

const fresh = async () => ({ stdout: [], stderr: [], exitCode: 0 })

describe('the modes of the factory', () => {
  it('a fresh factory starts in WINDOW with merge off', async () => {
    const home = tempRoot('factory-home-')
    const parts = keepAliveParts(home, recordingLaunchctl().run, 'linux')

    const result = await runStart(tempRoot('factory-user-'), REPOSITORY, parts, fresh)

    expect(result.exitCode, result.stderr.join('\n')).toBe(0)
    expect(modeOf(parts.busDir)).toBe('window')
    expect(switchedOn(parts.busDir)).toEqual(WINDOW_WORKERS)
    expect(switchedOn(parts.busDir)).not.toContain('merge')
    expect(result.stdout.join('\n')).toContain('merge off')
  })

  it('a fresh bus started in window mode runs launch, witness, review and answer live and merge in shadow', async () => {
    const parts = keepAliveParts(tempRoot('factory-home-'), recordingLaunchctl().run, 'linux')

    await runStart(tempRoot('factory-user-'), REPOSITORY, parts, fresh)
    const launches = wantedLaunches(parts.busDir, () => [], [], NOW)

    expect(liveWorkers(parts.busDir)).toEqual(WINDOW_WORKERS)
    expect(launches.filter(launch => launch.args.includes(LIVE_FLAG)).map(launch => launch.script).sort()).toEqual(['bus:answer', 'bus:launch', 'bus:review', 'bus:witness'])
    expect(launches.filter(launch => launch.script === 'bus:merge' && launch.args.includes(LIVE_FLAG))).toEqual([])
  })

  it('window to ghost-protocol to window keeps the window live set', () => {
    const bench = modeBench()
    runMode(modeCommand('--mode', 'window'), bench.parts)
    sayToOwnerChannel(bench.channel, ghostProtocolWord(8), NOW)
    runMode(modeCommand('--mode', 'ghost-protocol', '--hours', '8'), bench.parts)
    expect(liveWorkers(bench.parts.busDir)).toEqual(WINDOW_WORKERS)

    runMode(modeCommand('--mode', 'window'), bench.parts)

    expect(modeOf(bench.parts.busDir)).toBe('window')
    expect(liveWorkers(bench.parts.busDir)).toEqual(WINDOW_WORKERS)
  })

  it('construct-factory --mode window brings a worker the operator put in shadow back to the window live set', () => {
    const bench = modeBench()
    runMode(modeCommand('--mode', 'window'), bench.parts)
    switchDetection(bench.parts.busDir, 'review', false)

    runMode(modeCommand('--mode', 'window'), bench.parts)

    expect(liveWorkers(bench.parts.busDir)).toEqual(WINDOW_WORKERS)
  })

  it('a ghost-protocol term ending on its own keeps a worker the operator put in shadow', () => {
    const bench = modeBench()
    runMode(modeCommand('--mode', 'window'), bench.parts)
    switchDetection(bench.parts.busDir, 'review', false)
    sayToOwnerChannel(bench.channel, ghostProtocolWord(8), NOW)
    runMode(modeCommand('--mode', 'ghost-protocol', '--hours', '8'), bench.parts)

    expect(returnToWindowAtTermEnd(bench.parts.busDir, new Date(Date.parse(termEndOf(bench.parts.busDir)!) + 1))).toBe(true)

    expect(modeOf(bench.parts.busDir)).toBe('window')
    expect(liveWorkers(bench.parts.busDir)).toEqual(WINDOW_WORKERS.filter(worker => worker !== 'review'))
  })

  it('a factory that already has its workers keeps them on start', async () => {
    const home = tempRoot('factory-home-')
    const parts = keepAliveParts(home, recordingLaunchctl().run, 'linux')
    switchWorker(parts.busDir, 'merge', true)

    await runStart(tempRoot('factory-user-'), REPOSITORY, parts, fresh)

    expect(switchedOn(parts.busDir)).toEqual(['merge'])
    expect(modeOf(parts.busDir)).toBeNull()
  })

  it('the switch to GHOST PROTOCOL without an unused owner word is refused with the ready command', () => {
    const bench = modeBench()

    const result = runMode(modeCommand('--mode', 'ghost-protocol', '--hours', '8'), bench.parts)

    expect(result.exitCode).toBe(1)
    expect(result.stderr.join('\n')).toContain(`${sayCommand(ghostProtocolWord(8))} && ${START_BIN} --mode ghost-protocol --hours 8`)
    expect(existsSync(path.join(bench.parts.busDir, WORKERS_FILE))).toBe(false)
    expect(bench.events).toEqual([])
  })

  it('the switch to GHOST PROTOCOL on an unused owner word issues a window shard for its term and switches every worker on', () => {
    const bench = modeBench()
    const said = sayToOwnerChannel(bench.channel, ghostProtocolWord(8), NOW)

    const result = runMode(modeCommand('--mode', 'ghost-protocol', '--hours', '8'), bench.parts)

    expect(result.exitCode, result.stderr.join('\n')).toBe(0)
    expect(modeOf(bench.parts.busDir)).toBe('ghost-protocol')
    expect(switchedOn(bench.parts.busDir)).toEqual([...WORKERS])
    expect(bench.events.map(event => [event.type, event.payload])).toEqual([[SHARD_ISSUED, { id: SHARD_ID, by: said, run: null, window: true, scope: 'merge', until: '2026-10-25T20:00:00.000Z' }]])
    expect(existsSync(`${said}${USED_WORD}`)).toBe(true)
    expect(runMode(modeCommand('--mode', 'ghost-protocol', '--hours', '8'), modeBench().parts).exitCode).toBe(1)
  })

  it('the supervisor returns Miko to WINDOW on its first tick past the GHOST PROTOCOL term', () => {
    const bench = modeBench()
    sayToOwnerChannel(bench.channel, ghostProtocolWord(8), NOW)
    runMode(modeCommand('--mode', 'ghost-protocol', '--hours', '8'), bench.parts)
    const scripts = (now: Date) => wantedLaunches(bench.parts.busDir, () => [], [], now).map(launch => launch.script)

    expect(termEndOf(bench.parts.busDir)).toBe(TERM_END)
    expect(scripts(new Date('2026-10-25T19:59:59.000Z'))).toContain('bus:merge')
    expect(modeOf(bench.parts.busDir)).toBe('ghost-protocol')

    expect(scripts(new Date(TERM_END))).not.toContain('bus:merge')
    expect(modeOf(bench.parts.busDir)).toBe('window')
    expect(switchedOn(bench.parts.busDir)).toEqual(WINDOW_WORKERS)
    expect(termEndOf(bench.parts.busDir)).toBeNull()
  })

  it('the mode is read from the workers switched on, so an on/off switch after a mode switch leaves no stale label', () => {
    const bench = modeBench()
    runMode(modeCommand('--mode', 'window'), bench.parts)
    switchWorker(bench.parts.busDir, 'merge', true)
    expect(modeOf(bench.parts.busDir)).toBeNull()
    switchWorker(bench.parts.busDir, 'merge', false)
    expect(modeOf(bench.parts.busDir)).toBe('window')
    expect(Object.keys(JSON.parse(readFileSync(path.join(bench.parts.busDir, WORKERS_FILE), 'utf8')) as object)).not.toContain('mode')
  })

  it('a GHOST PROTOCOL switch that cannot write its workers revokes its shard and leaves the owner word unused', () => {
    const bench = modeBench()
    const said = sayToOwnerChannel(bench.channel, ghostProtocolWord(8), NOW)
    writeFileSync(bench.parts.busDir, 'not a directory')

    const result = runMode(modeCommand('--mode', 'ghost-protocol', '--hours', '8'), bench.parts)

    expect(result.exitCode).toBe(1)
    expect(result.stderr.join('\n')).toContain('was not switched')
    expect(bench.events.map(event => event.type)).toEqual([SHARD_ISSUED, SHARD_REVOKED])
    expect(existsSync(said)).toBe(true)
  })

  it('a WINDOW switch that cannot write its workers revokes no shard', () => {
    const bench = modeBench([{ id: SHARD_ID, by: 'owner', scope: 'merge', until: TERM_END }])
    writeFileSync(bench.parts.busDir, 'not a directory')

    const result = runMode(modeCommand('--mode', 'window'), bench.parts)

    expect(result.exitCode).toBe(1)
    expect(bench.events).toEqual([])
  })

  it('a corrupt workers.json is named in every switch, and a live switch on it leaves the owner word unused', () => {
    const bench = modeBench()
    mkdirSync(bench.parts.busDir, { recursive: true })
    const file = path.join(bench.parts.busDir, WORKERS_FILE)
    writeFileSync(file, '{"on": [')
    const said = sayToOwnerChannel(bench.channel, 'allow-live launch', NOW)

    expect(() => switchWorker(bench.parts.busDir, 'merge', true)).toThrow(file)
    expect(() => modeOf(bench.parts.busDir)).toThrow(file)
    const live = runMode(modeCommand('--live', 'launch'), bench.parts)
    expect(live.exitCode).toBe(1)
    expect(live.stderr.join('\n')).toContain(file)
    expect(existsSync(said)).toBe(true)
    expect(runMode(modeCommand('--shadow', 'launch'), bench.parts).stderr.join('\n')).toContain(file)
  })

  it('an owner word for another term opens no GHOST PROTOCOL', () => {
    const bench = modeBench()
    const said = sayToOwnerChannel(bench.channel, ghostProtocolWord(8), NOW)

    expect(runMode(modeCommand('--mode', 'ghost-protocol'), bench.parts).exitCode).toBe(1)
    expect(existsSync(said)).toBe(true)
  })

  it('wINDOW needs no owner word, switches merge off and revokes the window shard', () => {
    const bench = modeBench([{ id: SHARD_ID, by: 'owner', scope: 'merge', until: '2026-10-25T20:00:00.000Z' }])
    switchWorker(bench.parts.busDir, 'merge', true)

    const result = runMode(modeCommand('--mode', 'window'), bench.parts)

    expect(result.exitCode).toBe(0)
    expect(modeOf(bench.parts.busDir)).toBe('window')
    expect(switchedOn(bench.parts.busDir)).toEqual(WINDOW_WORKERS)
    expect(bench.events.map(event => [event.type, event.payload])).toEqual([[SHARD_REVOKED, { id: SHARD_ID }]])
  })

  it('a queue goes live only on an unused owner word and back to shadow without one', () => {
    const bench = modeBench()
    const refused = runMode(modeCommand('--live', 'launch'), bench.parts)
    expect(refused.exitCode).toBe(1)
    expect(refused.stderr.join('\n')).toContain(sayCommand('allow-live launch'))
    expect(refused.stderr.join('\n')).not.toContain('decisions:add')
    expect(liveWorkers(bench.parts.busDir)).toEqual([])

    sayToOwnerChannel(bench.channel, 'allow-live launch', NOW)
    expect(runMode(modeCommand('--live', 'launch'), bench.parts).exitCode).toBe(0)
    expect(liveWorkers(bench.parts.busDir)).toEqual(['launch'])

    expect(runMode(modeCommand('--shadow', 'launch'), bench.parts).exitCode).toBe(0)
    expect(liveWorkers(bench.parts.busDir)).toEqual([])
  })

  it('refuses an unknown mode, a term on WINDOW and a term that is not a whole number of hours', () => {
    for (const argv of [['--mode', 'turbo'], ['--mode', 'window', '--hours', '2'], ['--mode', 'ghost-protocol', '--hours', '1.5'], ['--live', 'nobody'], ['extra']])
      expect(startCommandOf(argv), argv.join(' ')).toBeNull()
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
    await waitFor(() => launchedLines().length >= FRESH_LAUNCHES.length, () => `${FRESH_LAUNCHES.length} launches in ${argv}`, LAUNCHED_WITHIN_MS)
    const launched = launchedLines()
    expect(launched).toHaveLength(FRESH_LAUNCHES.length)
    expect(launched.filter(line => line.includes('pnpm'))).toEqual([])
    const built = (source: string): string => path.join(packed.installed, OUT_DIR, 'scripts', 'supervisor', source)
    const busArgument = ` ${BUS_FLAG} ${path.join(packed.root, 'bus.db')}`
    expect(launched.filter(line => !line.endsWith(busArgument))).toEqual([])
    const targets = launched.map(line => line.slice(line.indexOf(' ') + 1, -busArgument.length))
    expect(targets).toContain(built('run.js'))
    expect(targets).toContain(`${built('supervisor.js')} ${SUPERVISE_FLAG}`)
    expect(targets.map(target => path.basename(target.split(' ')[0]!)).sort()).toEqual([...FRESH_LAUNCHES].sort())
    expect(targets.filter(target => !target.startsWith(path.join(packed.installed, OUT_DIR)))).toEqual([])
    expect(existsSync(path.join(busDirOf(path.join(packed.root, 'bus.db')), SUPERVISOR_LAUNCH.instanceFile!))).toBe(true)
  })

  it(SPAWN_BOUNDARY_TEST, async () => {
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0)
    const log = path.join(out, SPAWNS_LOG)
    const nohups = (): RecordedSpawn[] => recordedSpawns(log).filter(spawn => spawn.command === 'nohup')
    await waitFor(() => nohups().length >= FRESH_LAUNCHES.length, () => `${FRESH_LAUNCHES.length} launches in ${log}`, LAUNCHED_WITHIN_MS)
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
    expect(nohups().map(spawn => path.basename(spawn.args[1]!)).sort()).toEqual([...FRESH_LAUNCHES].sort())
    const ps = spawns.filter(spawn => spawn.command === 'ps')
    expect(ps.length > 0).toBe(true)
    expect(ps.filter(spawn => !spawn.args[0]?.startsWith('-'))).toEqual([])
  })

  it.runIf(process.platform === KEEP_ALIVE_PLATFORM)('the published command loads a keep-alive that reruns the installed starter in the user repository', () => {
    const plist = path.join(home, LAUNCH_AGENTS, `${agentLabel(user)}.plist`)
    const text = readFileSync(plist, 'utf8')
    expect(programArguments(text)).toEqual(KEEP_ALIVE_PROGRAM)
    expect(text).not.toContain(packed.installed)
    expect(text).not.toContain(process.execPath)
    expect(plistValue(text, 'WorkingDirectory')).toBe(user)
    expect(plistValue(text, BUS_DB_VARIABLE)).toBe(path.join(packed.root, 'bus.db'))
    expect(readFileSync(path.join(out, 'launchctl.argv'), 'utf8')).toContain(`bootstrap gui/${process.getuid!()} ${plist}`)
  })
})
