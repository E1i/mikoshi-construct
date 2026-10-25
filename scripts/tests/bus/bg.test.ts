import type { BgResult, DetachedLaunch, ProcessList, RunningProcess } from '../../supervisor/bg.js'
import type { BusCode } from '../../supervisor/supervisor.js'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { busDirOf, machineBusPath } from '../../core/bus-path.js'
import { appendEvent, openBus } from '../../core/db.js'
import { alive, BUS_FLAG, BUS_RUN_LAUNCH, BUS_RUN_MARKERS, busInArgs, carriesMarker, flagsInArgs, instancesOf, launchArgv, launchName, PREFIX, psList, RUN_SCRIPT, runBusBg, runningBus, runningInstance, servesBus, SHADOW_LOG, START_LOCK, START_LOCK_LIMIT_MS, startDetached, withBuses } from '../../supervisor/bg.js'
import { startReviewWorker } from '../../supervisor/review-bg.js'
import { factoryBusOf } from '../../supervisor/start.js'
import { bgCommand, BusSupervisor, entryOf, gitCode, lastMainAdvance, mainAdvancedSince, stopInstance, SUPERVISOR_LAUNCH, switchCommand } from '../../supervisor/supervisor.js'
import { busLaunches, switchDetection, switchedOn, switchWorker, wantedLaunches, WORKERS_FILE } from '../../supervisor/workers.js'
import { settled } from '../shift/fixtures/settled.js'
import { waitFor } from '../wait-for.js'

const roots: string[] = []
const started: number[] = []

afterEach(() => {
  for (const pid of started.splice(0)) {
    try {
      process.kill(-pid, 'SIGKILL')
    }
    catch {}
  }
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

const SYSTEM_BIN_DIRS = ['/bin', '/usr/bin']
const NO_PREFLIGHT = (): string[] => []
const UNREAD_INSTANCE_FILE = 'bus-run.pid'
const SUPERVISOR_ENTRY = path.resolve(import.meta.dirname, '..', '..', 'supervisor', 'supervisor.ts')

function linkFromSystem(bin: string, name: string): void {
  const source = SYSTEM_BIN_DIRS.map(dir => path.join(dir, name)).find(file => existsSync(file))
  if (source === undefined)
    throw new Error(`${name} is in none of ${SYSTEM_BIN_DIRS.join(', ')}`)
  symlinkSync(source, path.join(bin, name))
}

function stub(bin: string, name: string, body: string): void {
  const file = path.join(bin, name)
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
}

function tempRoot(prefix: string): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)))
  roots.push(root)
  return root
}

interface World {
  busDir: string
  out: string
  env: NodeJS.ProcessEnv
  processes: ProcessList
}

function world(): World {
  const root = tempRoot('bus-bg-')
  const bin = path.join(root, 'bin')
  const out = path.join(root, 'out')
  mkdirSync(bin)
  mkdirSync(out)
  linkFromSystem(bin, 'ps')
  linkFromSystem(bin, 'sleep')
  stub(bin, 'nohup', 'exec "$@"')
  stub(bin, 'pnpm', `echo "bus:run output"\nprintf '%s\\n' "$*" >> "$STUB_OUT/pnpm.argv"\necho $$ > "$STUB_OUT/pid"\nsleep 30`)
  const env = { PATH: bin, STUB_OUT: out }
  return { busDir: path.join(root, 'bus'), out, env, processes: () => psList(env)().filter(candidate => candidate.args.includes(bin)) }
}

function detachedSleep(): number {
  const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
  child.unref()
  started.push(child.pid!)
  return child.pid!
}

const ARRIVAL_GUARD_MS = 25_000
const ISO_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z (?=\S)/
const TSX_LOADER = pathToFileURL(path.resolve(import.meta.dirname, '..', '..', '..', 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')).href
const STAMPED_ENTRY = path.join(import.meta.dirname, 'stamp-entry.ts')

function readArgv(w: World): string[] {
  const file = path.join(w.out, 'pnpm.argv')
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n') : []
}

async function argvLines(w: World, count: number): Promise<string[]> {
  await waitFor(() => readArgv(w).length >= count, () => `${count} pnpm.argv lines (read: ${JSON.stringify(readArgv(w))})`, ARRIVAL_GUARD_MS)
  return readArgv(w)
}

function deadPid(): number {
  const child = spawnSync('/usr/bin/true')
  return child.pid!
}

function argsOf(pid: number): string {
  return execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' })
}

function pidsOf(result: BgResult): number[] {
  return result.stdout.filter(line => /^\d+$/.test(line)).map(Number)
}

function ownBus(w: World): string {
  return path.join(path.dirname(w.busDir), 'bus.db')
}

function overMachineBus(w: World): { machine: string, own: string } {
  const home = tempRoot('bus-bg-home-')
  const machine = machineBusPath(home)
  mkdirSync(path.dirname(machine), { recursive: true })
  writeFileSync(machine, '')
  return { machine, own: factoryBusOf(w.env, home, tempRoot('bus-bg-clone-')) }
}

function supervisorServing(bus: string | undefined): RunningProcess {
  return { pid: 16780, args: `node /x/node_modules/mikoshi-construct/dist/${SUPERVISOR_LAUNCH.markers[0]!.replace('.ts', '.js')}`, ...bus === undefined ? {} : { bus } }
}

describe('pnpm bus:bg', () => {
  it('bus:bg returns at once with the pid and the log path', async () => {
    const w = world()
    const result = runBusBg(w.busDir, [BUS_RUN_LAUNCH], w.env, w.processes)
    expect(result.exitCode).toBe(0)
    started.push(Number(result.stdout[0]))
    expect(alive(Number(result.stdout[0]))).toBe(true)
    const log = path.join(w.busDir, SHADOW_LOG)
    expect(result.stdout[0]).toBe(await settled(path.join(w.out, 'pid')))
    expect(result.stdout[1]).toContain(`log ${log}`)
    expect(existsSync(path.join(w.busDir, UNREAD_INSTANCE_FILE))).toBe(false)
    expect(await argvLines(w, 1)).toEqual(['--silent bus:run'])
    expect(argsOf(Number(result.stdout[0]))).toContain('bus:run')
    await waitFor(() => readFileSync(log, 'utf8').includes('bus:run output'), () => `"bus:run output" in ${log}`, ARRIVAL_GUARD_MS)
  })

  it('every line a detached bus process appends to its log starts with an ISO timestamp', async () => {
    const w = world()
    const bin = path.join(path.dirname(w.out), 'bin')
    rmSync(path.join(bin, 'pnpm'))
    stub(bin, 'pnpm', `TSX_DISABLE_CACHE=1 exec "${process.execPath}" --import "${TSX_LOADER}" "${STAMPED_ENTRY}"`)
    const log = path.join(w.busDir, SHADOW_LOG)
    mkdirSync(w.busDir, { recursive: true })
    writeFileSync(log, 'written before\n')
    const result = startDetached(BUS_RUN_LAUNCH, w.busDir, w.env, () => [])
    started.push(...pidsOf(result))
    expect(result.exitCode).toBe(0)
    await waitFor(() => readFileSync(log, 'utf8').endsWith('no newline'), () => `the last line in ${log} (read: ${JSON.stringify(readFileSync(log, 'utf8'))})`, ARRIVAL_GUARD_MS)
    const [before, ...appended] = readFileSync(log, 'utf8').split('\n')
    expect(before).toBe('written before')
    expect(appended.map(line => line.replace(ISO_STAMP, '')).sort()).toEqual(['env cleared', 'first line', 'no newline', 'to stderr'])
    expect(appended.every(line => ISO_STAMP.test(line))).toBe(true)
  })

  it('a second start while bus:run is alive leaves it alone and names its pid', async () => {
    const w = world()
    const first = runBusBg(w.busDir, [BUS_RUN_LAUNCH], w.env, w.processes)
    expect(first.exitCode).toBe(0)
    const pid = first.stdout[0]!
    started.push(Number(pid))
    await settled(path.join(w.out, 'pid'))
    rmSync(path.join(w.out, 'pid'))
    const second = runBusBg(w.busDir, [BUS_RUN_LAUNCH], w.env, w.processes)
    expect(second.exitCode).toBe(0)
    expect(second.stderr).toEqual([])
    expect(second.stdout).toEqual([`${PREFIX}bus:run is already running as pid ${pid}; left alone`])
    expect(w.processes().map(candidate => candidate.pid)).toEqual([Number(pid)])
  })

  it('a bus:run started by hand, with no instance file, is left alone and named', async () => {
    const w = world()
    const byHand: ProcessList = () => [{ pid: 4242, args: 'node /x/node_modules/tsx/dist/cli.mjs scripts/supervisor/run.ts' }]
    const result = runBusBg(w.busDir, [BUS_RUN_LAUNCH], w.env, byHand)
    expect(result.exitCode).toBe(0)
    expect(result.stdout.join('\n')).toContain('pid 4242')
    expect(existsSync(path.join(w.busDir, START_LOCK))).toBe(false)
    expect(w.processes()).toEqual([])
  })

  it('a start while another start holds the lock is refused naming its pid', async () => {
    const w = world()
    const other = detachedSleep()
    mkdirSync(w.busDir, { recursive: true })
    const lock = path.join(w.busDir, START_LOCK)
    writeFileSync(lock, `${other}\n`)
    const result = runBusBg(w.busDir, [BUS_RUN_LAUNCH], w.env, w.processes)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toEqual([])
    expect(result.stderr).toEqual([`${PREFIX}another start (pid ${other}) is starting bus:run (${lock}); nothing started`])
    expect(readFileSync(path.join(w.busDir, START_LOCK), 'utf8').trim()).toBe(String(other))
    expect(w.processes()).toEqual([])
  })

  it('a start lock on a live foreign pid is removed and the start proceeds', async () => {
    const w = world()
    const other = detachedSleep()
    mkdirSync(w.busDir, { recursive: true })
    writeFileSync(path.join(w.busDir, START_LOCK), `${other}\n`)
    const recycled: ProcessList = () => [{ pid: process.pid, args: 'node review-bg.ts' }, { pid: other, args: 'sleep 30' }]
    const result = runBusBg(w.busDir, [BUS_RUN_LAUNCH], w.env, recycled)
    expect(result.exitCode).toBe(0)
    started.push(Number(result.stdout[0]))
    expect(result.stderr).toEqual([])
    expect(existsSync(path.join(w.busDir, START_LOCK))).toBe(false)
  })

  it('a start lock that vanishes after the start found it does not crash the start', async () => {
    const w = world()
    mkdirSync(w.busDir, { recursive: true })
    symlinkSync(path.join(w.busDir, 'gone'), path.join(w.busDir, START_LOCK))
    const result = runBusBg(w.busDir, [BUS_RUN_LAUNCH], w.env, w.processes)
    expect(result.exitCode).toBe(0)
    started.push(Number(result.stdout[0]))
    expect(result.stderr).toEqual([])
  })

  it('a start lock of a live start of the same script refuses the start', async () => {
    const w = world()
    const other = detachedSleep()
    mkdirSync(w.busDir, { recursive: true })
    const lock = path.join(w.busDir, START_LOCK)
    writeFileSync(lock, `${other}\n`)
    const sameStart: ProcessList = () => [{ pid: process.pid, args: 'node review-bg.ts' }, { pid: other, args: 'node review-bg.ts' }]
    const result = runBusBg(w.busDir, [BUS_RUN_LAUNCH], w.env, sameStart)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toEqual([`${PREFIX}another start (pid ${other}) is starting bus:run (${lock}); nothing started`])
    expect(existsSync(lock)).toBe(true)
    expect(w.processes()).toEqual([])
  })

  it('a start lock older than the limit is removed and the start proceeds', async () => {
    const w = world()
    const other = detachedSleep()
    mkdirSync(w.busDir, { recursive: true })
    const lock = path.join(w.busDir, START_LOCK)
    writeFileSync(lock, `${other}\n`)
    const old = new Date(Date.now() - START_LOCK_LIMIT_MS - 1000)
    utimesSync(lock, old, old)
    const result = runBusBg(w.busDir, [BUS_RUN_LAUNCH], w.env, w.processes)
    expect(result.exitCode).toBe(0)
    started.push(Number(result.stdout[0]))
    expect(result.stderr).toEqual([])
  })

  it('a start lock and an old pid file left by dead processes do not block a start, and no pid file is written', async () => {
    const w = world()
    mkdirSync(w.busDir, { recursive: true })
    const dead = String(deadPid())
    writeFileSync(path.join(w.busDir, START_LOCK), `${dead}\n`)
    writeFileSync(path.join(w.busDir, UNREAD_INSTANCE_FILE), `${dead}\n`)
    const result = runBusBg(w.busDir, [BUS_RUN_LAUNCH], w.env, w.processes)
    expect(result.exitCode).toBe(0)
    started.push(Number(result.stdout[0]))
    expect(result.stdout[0]).toBe(await settled(path.join(w.out, 'pid')))
    expect(readFileSync(path.join(w.busDir, UNREAD_INSTANCE_FILE), 'utf8').trim()).toBe(dead)
    expect(existsSync(path.join(w.busDir, START_LOCK))).toBe(false)
  })

  it('a running bus is recognised by its script, not by any mention of bus:run', () => {
    expect(runningBus([{ pid: 11, args: 'rg bus:run scripts' }])).toBeUndefined()
    expect(runningBus([{ pid: 12, args: 'node tsx/dist/cli.mjs scripts/supervisor/run.ts' }])?.pid).toBe(12)
    expect(runningBus([{ pid: 13, args: 'node pnpm.cjs --silent bus:run' }])?.pid).toBe(13)
  })

  it('bus:bg starts bus:run and every switched-on worker once and leaves a running one alone', async () => {
    const w = world()
    switchWorker(w.busDir, 'review', true)
    switchWorker(w.busDir, 'merge', true)
    const mergeByHand: RunningProcess = { pid: 4242, args: 'node /x/node_modules/tsx/dist/cli.mjs scripts/nodes/merge/merge-worker.ts --on' }
    const processes: ProcessList = () => [...w.processes(), mergeByHand]
    const first = runBusBg(w.busDir, wantedLaunches(w.busDir, NO_PREFLIGHT), w.env, processes)
    started.push(...pidsOf(first))
    expect(first.exitCode).toBe(0)
    expect(pidsOf(first)).toHaveLength(2)
    expect(first.stdout).toContain(`${PREFIX}bus:merge --on is already running as pid 4242; left alone`)
    expect(existsSync(path.join(w.busDir, 'bus-merge.pid'))).toBe(false)
    expect(readFileSync(path.join(w.busDir, 'bus-review.pid'), 'utf8').trim()).toBe(String(pidsOf(first)[1]))
    expect((await argvLines(w, 2)).sort()).toEqual(['--silent bus:review --on', '--silent bus:run'])
    const second = runBusBg(w.busDir, wantedLaunches(w.busDir, NO_PREFLIGHT), w.env, processes)
    expect(second.exitCode).toBe(0)
    expect(pidsOf(second)).toEqual([])
    expect(second.stdout).toHaveLength(3)
    expect(second.stdout.every(line => line.endsWith('; left alone'))).toBe(true)
    expect(w.processes().map(candidate => candidate.pid).sort()).toEqual(pidsOf(first).sort())
  })

  it('bus:bg leaves a review worker the supervisor recorded alone', () => {
    const w = world()
    switchWorker(w.busDir, 'review', true)
    writeFileSync(path.join(w.busDir, 'bus-review.pid'), `${process.ppid}\n`)
    const result = runBusBg(w.busDir, wantedLaunches(w.busDir, NO_PREFLIGHT).filter(launch => launch.script === 'bus:review'), w.env, () => [], startReviewWorker)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toEqual([`${PREFIX}bus:review --on is already running as pid ${process.ppid}; left alone`])
    expect(w.processes()).toEqual([])
  })

  it('a worker that is switched off is not started', async () => {
    const w = world()
    switchWorker(w.busDir, 'merge', true)
    switchWorker(w.busDir, 'update', true)
    expect(switchWorker(w.busDir, 'merge', false)).toEqual(['update'])
    switchWorker(w.busDir, 'update', false)
    expect(switchedOn(w.busDir)).toEqual([])
    const result = runBusBg(w.busDir, wantedLaunches(w.busDir, NO_PREFLIGHT), w.env, w.processes)
    started.push(...pidsOf(result))
    expect(result.exitCode).toBe(0)
    expect(pidsOf(result)).toHaveLength(1)
    expect(await argvLines(w, 1)).toEqual(['--silent bus:run'])
    expect(w.processes().map(candidate => candidate.pid)).toEqual(pidsOf(result))
    for (const worker of ['review', 'merge', 'update'])
      expect(existsSync(path.join(w.busDir, `bus-${worker}.pid`))).toBe(false)
  })

  it('a pnpm.argv line that comes six seconds late is still awaited', async () => {
    const w = world()
    const late = setTimeout(() => appendFileSync(path.join(w.out, 'pnpm.argv'), '--silent bus:run\n'), 6000)
    try {
      expect(await argvLines(w, 1)).toEqual(['--silent bus:run'])
    }
    finally {
      clearTimeout(late)
    }
  })

  it('switch writes the flag without ps or kill', () => {
    const root = tempRoot('bus-bg-switch-flag-')
    const bin = path.join(root, 'bin')
    const calls = path.join(root, 'calls')
    mkdirSync(bin)
    for (const name of ['ps', 'pgrep', 'kill', 'pkill', 'nohup', 'pnpm'])
      stub(bin, name, `echo "${name} $*" >> "${calls}"`)
    const env = { ...process.env, HOME: root, PATH: [bin, path.dirname(process.execPath), ...SYSTEM_BIN_DIRS].join(path.delimiter), CONSTRUCT_BUS_DB: path.join(root, 'bus.db') }
    const busDir = path.join(root, 'bus')

    for (const [flag, worker] of [['--on', 'merge'], ['--on', 'update'], ['--off', 'merge']] as const) {
      const run = spawnSync(process.execPath, ['--import', TSX_LOADER, SUPERVISOR_ENTRY, flag, worker], { cwd: root, env, encoding: 'utf8' })
      expect(run.status, run.stderr).toBe(0)
      expect(existsSync(calls) ? readFileSync(calls, 'utf8') : '').toBe('')
      expect(run.stdout).toContain('the supervisor starts what is switched on and stops what is switched off on its next tick')
    }

    expect(switchedOn(busDir)).toEqual(['update'])
    expect(existsSync(calls) ? readFileSync(calls, 'utf8') : '').toBe('')
  })

  it('bus:bg --on and --off take one known worker and write the switch file', () => {
    const busDir = path.join(tempRoot('bus-bg-switch-'), 'bus')
    expect(bgCommand(['--on', 'merge'])).toEqual({ kind: 'switch', worker: 'merge', on: true })
    expect(bgCommand(['--off', 'review'])).toEqual({ kind: 'switch', worker: 'review', on: false })
    expect(bgCommand([])).toEqual({ kind: 'start' })
    expect(bgCommand(['--supervise'])).toEqual({ kind: 'supervise' })
    expect(switchCommand(busDir, 'deploy', true).exitCode).toBe(1)
    expect(switchCommand(busDir, '', true).exitCode).toBe(1)
    expect(existsSync(path.join(busDir, WORKERS_FILE))).toBe(false)
    expect(switchCommand(busDir, 'update', true).exitCode).toBe(0)
    expect(JSON.parse(readFileSync(path.join(busDir, WORKERS_FILE), 'utf8'))).toEqual({ on: ['update'] })
    writeFileSync(path.join(busDir, WORKERS_FILE), '{"on":["deploy"]}')
    expect(() => switchedOn(busDir)).toThrow(WORKERS_FILE)
  })

  it('a supervisor of another bus does not hold this bus lock', async () => {
    const w = world()
    const probe = supervisorServing(path.join(tempRoot('bus-bg-probe-'), 'bus.db'))
    const result = startDetached(SUPERVISOR_LAUNCH, w.busDir, { ...w.env, CONSTRUCT_BUS_DB: ownBus(w) }, () => [probe])
    started.push(...pidsOf(result))
    expect(result.stderr).toEqual([])
    expect(result.exitCode).toBe(0)
    expect(pidsOf(result)).toHaveLength(1)
    expect(await argvLines(w, 1)).toEqual([`--silent ${launchName(SUPERVISOR_LAUNCH)} ${BUS_FLAG} ${ownBus(w)}`])
    expect(runningInstance([probe], SUPERVISOR_LAUNCH.markers, ownBus(w))).toBeUndefined()
  })

  it('a second supervisor of the same bus is refused', () => {
    const w = world()
    for (const same of [supervisorServing(ownBus(w)), supervisorServing(path.join(w.busDir, '..', 'bus.db')), supervisorServing(undefined)]) {
      const result = startDetached(SUPERVISOR_LAUNCH, w.busDir, { ...w.env, CONSTRUCT_BUS_DB: ownBus(w) }, () => [same])
      expect(result.exitCode).toBe(1)
      expect(result.alreadyRunning).toEqual(same)
    }
    expect(readArgv(w)).toEqual([])
  })

  it('with a factory running over bus A, a start over bus B starts every process of B', async () => {
    const w = world()
    const { machine, own } = overMachineBus(w)
    expect(own).not.toBe(machine)
    const busDir = busDirOf(own)
    switchWorker(busDir, 'review', true)
    const launches = wantedLaunches(busDir, NO_PREFLIGHT)
    const factoryOfA = launches.map((launch, index) => ({ pid: 4242 + index, args: `node /x/node_modules/tsx/dist/cli.mjs ${launch.markers[0]}`, bus: machine }))
    const result = runBusBg(busDir, launches, w.env, () => [...w.processes(), ...factoryOfA], startReviewWorker)
    started.push(...pidsOf(result))
    expect(result.stderr).toEqual([])
    expect(result.exitCode).toBe(0)
    expect(pidsOf(result)).toHaveLength(launches.length)
    await argvLines(w, launches.length)
    expect(w.processes().map(candidate => candidate.bus)).toEqual(launches.map(() => own))
  })

  it('a start over bus B takes no start lock of bus A', () => {
    const w = world()
    const { machine, own } = overMachineBus(w)
    const lockOfA = path.join(busDirOf(machine), START_LOCK)
    mkdirSync(path.dirname(lockOfA), { recursive: true })
    writeFileSync(lockOfA, `${detachedSleep()}\n`)
    const result = runBusBg(busDirOf(own), [BUS_RUN_LAUNCH], w.env, w.processes)
    started.push(...pidsOf(result))
    expect(result.stderr).toEqual([])
    expect(result.exitCode).toBe(0)
    expect(pidsOf(result)).toHaveLength(1)
    expect(existsSync(lockOfA)).toBe(true)
  })

  it('a running process whose bus could not be read is left alone but not counted, so a start that found only such exits 1', () => {
    const w = world()
    const unread: ProcessList = () => [{ pid: 4242, args: 'node /x/node_modules/tsx/dist/cli.mjs scripts/supervisor/run.ts' }]
    const result = runBusBg(w.busDir, [BUS_RUN_LAUNCH], { ...w.env, CONSTRUCT_BUS_DB: ownBus(w) }, unread)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toEqual([`${PREFIX}bus:run is running as pid 4242, whose bus could not be read as ${ownBus(w)}; left alone and not counted as running for it`])
    expect(result.stderr).toEqual([`${PREFIX}started nothing for ${ownBus(w)} and found nothing of it running; its factory is not up`])
    expect(w.processes()).toEqual([])
  })

  it('a bus is read from the last --bus argument of a command line, never from an assignment in it', () => {
    expect(busInArgs('node dist/scripts/supervisor/supervisor.js --supervise --bus /args/bus.db --bus /x/bus.db')).toBe('/x/bus.db')
    expect(busInArgs('node scripts/supervisor/supervisor.ts --supervise CONSTRUCT_BUS_DB=/y/bus.db')).toBeUndefined()
    expect(busInArgs('node scripts/supervisor/supervisor.ts --supervise --busy /y/bus.db')).toBeUndefined()
  })

  it('a bus path with a space in it is read back whole from the command line its launch carries', () => {
    const bus = '/Users/Jane Doe/.construct/a1b2/bus.db'
    for (const launch of [BUS_RUN_LAUNCH, SUPERVISOR_LAUNCH])
      expect(busInArgs(launchArgv(launch, null, bus).slice(1).join(' '))).toBe(bus)
  })

  it('withBuses stamps the bus a command line carries and leaves one that carries none unchanged', () => {
    const read = { pid: 1, args: `node dist/scripts/supervisor/run.js ${BUS_FLAG} /x/bus.db` }
    const unread = { pid: 2, args: 'node dist/scripts/supervisor/run.js' }
    expect(withBuses([read, unread])).toEqual([{ ...read, bus: '/x/bus.db' }, unread])
  })

  it('a relative bus on another process command line counts as unreadable, since it was relative to that process cwd', () => {
    const relative = { ...supervisorServing('bus.db'), pid: 1 }
    expect(servesBus(relative, '/x/bus.db')).toBe(true)
    expect(servesBus(relative, path.resolve('elsewhere', 'bus.db'))).toBe(true)
    expect(servesBus({ ...relative, bus: '/y/bus.db' }, '/x/bus.db')).toBe(false)
  })

  it('the instances a stop signals are only those of its own bus', () => {
    const own = { ...supervisorServing('/x/bus.db'), pid: 1 }
    const unread = { ...supervisorServing(undefined), pid: 2 }
    const probe = { ...supervisorServing('/y/bus.db'), pid: 3 }
    expect(instancesOf([own, unread, probe], SUPERVISOR_LAUNCH.markers, '/x/bus.db')).toEqual([own, unread])
  })

  it('a stopped instance is signalled as a group and waited for', async () => {
    const pid = detachedSleep()
    const processes: ProcessList = () => alive(pid) ? [{ pid, args: `sleep 30 marker-${pid}` }] : []
    await stopInstance({ pid, args: '' }, [`marker-${pid}`], processes)
    await waitFor(() => !alive(pid), () => `pid ${pid} gone after stopInstance`, ARRIVAL_GUARD_MS)
  })
})

interface Repo {
  dir: string
  commit: (file: string) => string
}

const ENTRIES = ['scripts/supervisor/supervisor.ts', ...busLaunches(() => []).map(launch => entryOf(launch)!)]
const SHARED_IMPORTS = `import './db.js'\nimport { LEASE_MS } from './lease.js'\nexport * from './queue.js'\n`
const SHARED_FILE = 'scripts/core/db.ts'

function repo(): Repo {
  const dir = tempRoot('bus-bg-code-')
  const git = (...args: string[]): string => execFileSync('git', ['-c', 'user.name=bus', '-c', 'user.email=bus@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' }).trim()
  git('init', '--quiet')
  let n = 0
  const write = (file: string): void => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    writeFileSync(path.join(dir, file), `${ENTRIES.includes(file) ? SHARED_IMPORTS : ''}export const version = ${n++}\n`)
  }
  const commit = (file: string): string => {
    write(file)
    git('add', '.')
    git('commit', '--quiet', '-m', file)
    return git('rev-parse', 'HEAD')
  }
  for (const file of [...ENTRIES, 'scripts/core/db.ts', 'scripts/core/lease.ts'])
    write(file)
  commit('scripts/core/queue.ts')
  return { dir, commit }
}

interface Supervised {
  supervisor: BusSupervisor
  advance: (sha: string) => void
  stopped: number[]
  starts: { name: string, head: string }[]
  freed: string[][]
  journal: Record<string, unknown>[]
}

const FREED_LINE = 'freed the leases of'

function supervised(r: Repo, busDir: string, running: RunningProcess[], code: BusCode = gitCode(r.dir), reviewPreflight: () => string[] = NO_PREFLIGHT, startedAs: (launch: DetachedLaunch) => BgResult | null = () => null): Supervised {
  const db = openBus(path.join(busDir, 'bus.db'))
  const stopped: number[] = []
  const starts: { name: string, head: string }[] = []
  const journal: Record<string, unknown>[] = []
  const freed: string[][] = []
  let alive = [...running]
  const supervisor = new BusSupervisor({
    known: busLaunches(reviewPreflight),
    wanted: () => wantedLaunches(busDir, reviewPreflight),
    start: (launch: DetachedLaunch) => {
      const answered = startedAs(launch)
      if (answered !== null)
        return answered
      const problems = launch.preflight?.() ?? []
      if (problems.length > 0)
        return { stdout: [], stderr: [`${launch.prefix}refused to start ${launch.script}:`, ...problems.map(problem => `  ${problem}`)], exitCode: 1 }
      starts.push({ name: launchName(launch), head: code.head() })
      return { stdout: [`started ${launchName(launch)}`], stderr: [], exitCode: 0 }
    },
    stop: async (instance) => {
      stopped.push(instance.pid)
      alive = alive.filter(candidate => candidate.pid !== instance.pid)
    },
    freeLeases: (stopped) => {
      const names = stopped.map(launch => launchName(launch))
      freed.push(names)
      return names.map(name => `${FREED_LINE} ${name}`)
    },
    processes: () => alive,
    mainSince: afterId => mainAdvancedSince(db, afterId),
    code,
    journal: entry => journal.push(entry),
    now: () => Date.parse('2026-10-12T10:22:10Z'),
  }, lastMainAdvance(db))
  const advance = (sha: string): void => {
    appendEvent(db, { ts: new Date().toISOString(), type: 'main.advanced', actor: 'netwatch', cardId: null, pr: null, head: null, dedupeKey: `main:${sha}`, payload: { sha, touches_mechanics: true }, legacy: false })
  }
  return { supervisor, advance, stopped, starts, freed, journal }
}

const GITHUB_MISMATCH = 'prs vs GitHub: #782 at 37e3eecf here, f0d7481a on GitHub'
const OLD_REDUCER_DIFF = 'replay byte-diff: prs 782: head live "37e3eecf", replay "f0d7481a"'

const RUNNING: RunningProcess[] = [
  { pid: 101, args: 'node pnpm.cjs --silent bus:run' },
  { pid: 102, args: 'node pnpm.cjs --silent bus:review --on' },
  { pid: 103, args: 'node pnpm.cjs --silent bus:update --on' },
]

describe('bus:bg --supervise', () => {
  it('a bus:run started before --bus, with no bus on its command line, holds a start over its own bus: no second bus:run is started', () => {
    const w = world()
    const beforeBusFlag: RunningProcess = { pid: 101, args: 'node pnpm.cjs --silent bus:run' }
    const result = startDetached(BUS_RUN_LAUNCH, w.busDir, { ...w.env, CONSTRUCT_BUS_DB: ownBus(w) }, () => [beforeBusFlag])
    expect(result.exitCode).toBe(1)
    expect(result.alreadyRunning).toEqual(beforeBusFlag)
    expect(pidsOf(result)).toEqual([])
    expect(readArgv(w)).toEqual([])
  })

  it('on main.advanced a bus:run started before --bus is stopped and started once over the same bus with --bus, never a second beside it', async () => {
    const w = world()
    const r = repo()
    const bus = ownBus(w)
    const beforeBusFlag: RunningProcess = { pid: 101, args: 'node pnpm.cjs --silent bus:run' }
    const results: BgResult[] = []
    let stopped: number[] = []
    const s = supervised(r, w.busDir, [beforeBusFlag], gitCode(r.dir), NO_PREFLIGHT, (launch) => {
      const result = startDetached(launch, w.busDir, { ...w.env, CONSTRUCT_BUS_DB: bus }, () => stopped.includes(beforeBusFlag.pid) ? [] : [beforeBusFlag])
      results.push(result)
      started.push(...pidsOf(result))
      return result
    })
    stopped = s.stopped
    await s.supervisor.step()
    s.advance(r.commit('scripts/core/queue.ts'))
    await s.supervisor.step()
    expect(s.stopped).toEqual([beforeBusFlag.pid])
    expect(results.map(result => result.exitCode)).toEqual([0])
    expect(await argvLines(w, 1)).toEqual([`--silent ${RUN_SCRIPT} ${BUS_FLAG} ${bus}`])
  })

  it('a worker running with --on while workers.json lists it live is restarted by the supervisor with --live, and back to shadow when it is no longer listed live', async () => {
    const r = repo()
    const busDir = path.join(tempRoot('bus-bg-mode-'), 'bus')
    switchWorker(busDir, 'review', true)
    switchWorker(busDir, 'update', true)
    const s = supervised(r, busDir, RUNNING)
    expect(await s.supervisor.step()).toEqual([])
    switchDetection(busDir, 'update', true)
    const lines = await s.supervisor.step()
    expect(s.stopped).toEqual([103])
    expect(s.starts.map(start => start.name)).toEqual(['bus:update --on --live'])
    expect(s.freed).toEqual([['bus:update --on --live']])
    expect(lines.join('\n')).toContain('restarting it live')
    expect(lines).toContain(`${FREED_LINE} bus:update --on --live`)
    const live = supervised(r, busDir, [{ pid: 103, args: 'node pnpm.cjs --silent bus:update --on --live' }])
    switchDetection(busDir, 'update', false)
    await live.supervisor.step()
    expect(live.stopped).toEqual([103])
    expect(live.starts.map(start => start.name)).toEqual(['bus:update --on'])
    expect(live.freed).toEqual([['bus:update --on']])
  })

  it('live in the bus path: a shadow worker over a bus whose path carries --live is left in shadow, and one with --live before --bus is restarted in shadow', async () => {
    const r = repo()
    const busDir = path.join(tempRoot('bus-bg-mode-'), 'bus')
    switchWorker(busDir, 'review', true)
    const bus = '/x/E1i--live-0-44/bus.db'
    const busRun: RunningProcess = { pid: 101, args: `node /p/dist/scripts/supervisor/run.js --bus ${bus}` }
    const shadow = supervised(r, busDir, [busRun, { pid: 102, args: `node /p/dist/scripts/nodes/review/review-worker.js --on --bus ${bus}` }])
    expect(await shadow.supervisor.step()).toEqual([])
    expect(shadow.stopped).toEqual([])
    const live = supervised(r, busDir, [busRun, { pid: 102, args: `node /p/dist/scripts/nodes/review/review-worker.js --on --live --bus ${bus}` }])
    await live.supervisor.step()
    expect(live.stopped).toEqual([102])
    expect(live.starts.map(start => start.name)).toEqual(['bus:review --on'])
  })

  it('live in the bus path: flags and markers are read before the last --bus, never inside the bus path', () => {
    const args = 'node /p/dist/scripts/nodes/review/review-worker.js --on --bus /x/E1i--live-0-44/bus.db'
    expect(flagsInArgs(args)).toEqual(['node', '/p/dist/scripts/nodes/review/review-worker.js', '--on'])
    expect(flagsInArgs(`node w.js --on --live --bus /x/bus.db`)).toContain('--live')
    expect(carriesMarker('node /p/w.js --bus /x/scripts/supervisor/run.js/bus.db', BUS_RUN_MARKERS)).toBe(false)
    expect(carriesMarker('node /p/dist/scripts/supervisor/run.js --bus /x/bus.db', BUS_RUN_MARKERS)).toBe(true)
  })

  it('main advancing with a change under scripts/bus restarts every switched-on bus process on the new code, and a switched-off one is stopped, not brought back', async () => {
    const r = repo()
    const busDir = path.join(tempRoot('bus-bg-sup-'), 'bus')
    switchWorker(busDir, 'review', true)
    switchWorker(busDir, 'merge', true)
    const s = supervised(r, busDir, RUNNING)
    expect(await s.supervisor.step()).toEqual([`${PREFIX}bus:update --on is switched off and was running as pid 103; stopped it`, `${FREED_LINE} bus:update --on`])
    const next = r.commit('scripts/core/queue.ts')
    s.advance(next)
    const lines = await s.supervisor.step()
    expect(s.stopped).toEqual([103, 101, 102])
    expect(s.starts.map(start => start.name).sort()).toEqual(['bus:merge --on', 'bus:review --on', 'bus:run'])
    expect(s.starts.every(start => start.head === next)).toBe(true)
    expect(lines[0]).toContain(`main advanced to ${next} with a change to the code every bus process runs`)
    expect(await s.supervisor.step()).toEqual([])
    expect(s.starts).toHaveLength(3)
  })

  it('a restart waits until the checkout holds the advanced main', async () => {
    const r = repo()
    const busDir = path.join(tempRoot('bus-bg-sup-'), 'bus')
    const s = supervised(r, busDir, RUNNING.slice(0, 1))
    const remote = 'a'.repeat(40)
    s.advance(remote)
    expect((await s.supervisor.step()).join('\n')).toContain('the restart waits')
    expect(await s.supervisor.step()).toEqual([])
    expect(s.starts).toEqual([])
    const next = r.commit('scripts/core/lease.ts')
    s.advance(next)
    await s.supervisor.step()
    expect(s.stopped).toEqual([101])
    expect(s.starts).toEqual([{ name: 'bus:run', head: next }])
  })

  it('a main.advanced pulls the main checkout fast-forward and restarts the touched workers on the new sha', async () => {
    const r = repo()
    const busDir = path.join(tempRoot('bus-bg-sup-'), 'bus')
    switchWorker(busDir, 'review', true)
    const remote = 'b'.repeat(40)
    let head = 'a'.repeat(40)
    let pulls = 0
    const code: BusCode = {
      head: () => head,
      holds: sha => sha === head,
      changedSince: () => [SHARED_FILE],
      runs: () => new Set([SHARED_FILE]),
      pull: () => {
        pulls += 1
        head = remote
      },
    }
    const s = supervised(r, busDir, RUNNING.slice(0, 2), code)
    expect(await s.supervisor.step()).toEqual([])
    expect(pulls).toBe(0)
    s.advance(remote)
    const lines = await s.supervisor.step()
    expect(pulls).toBe(1)
    expect(s.stopped).toEqual([101, 102])
    expect(s.starts).toEqual([{ name: 'bus:run', head: remote }, { name: 'bus:review --on', head: remote }])
    expect(lines[0]).toContain(`main advanced to ${remote} with a change to the code every bus process runs`)
    expect(await s.supervisor.step()).toEqual([])
    expect(pulls).toBe(1)
  })

  it('a pull that fails keeps the advance pending and names the failure', async () => {
    const r = repo()
    const busDir = path.join(tempRoot('bus-bg-sup-'), 'bus')
    const remote = 'c'.repeat(40)
    const head = 'a'.repeat(40)
    let pulls = 0
    const code: BusCode = {
      head: () => head,
      holds: sha => sha === head,
      changedSince: () => [SHARED_FILE],
      runs: () => new Set([SHARED_FILE]),
      pull: () => {
        pulls += 1
        throw new Error('git pull --ff-only exited 128')
      },
    }
    const s = supervised(r, busDir, RUNNING.slice(0, 1), code)
    s.advance(remote)
    const lines = await s.supervisor.step()
    expect(lines.join('\n')).toContain('git pull --ff-only exited 128')
    expect(lines.join('\n')).toContain('the restart waits')
    expect(s.stopped).toEqual([])
    expect(await s.supervisor.step()).toEqual([])
    expect(pulls).toBe(2)
  })

  it('a merge that changes answer-worker.ts restarts only answer on the new sha', async () => {
    const r = repo()
    const busDir = path.join(tempRoot('bus-bg-sup-'), 'bus')
    switchWorker(busDir, 'answer', true)
    switchWorker(busDir, 'close', true)
    const running = [...RUNNING.slice(0, 1), { pid: 104, args: 'node pnpm.cjs --silent bus:answer --on' }, { pid: 105, args: 'node pnpm.cjs --silent bus:close --on' }]
    const s = supervised(r, busDir, running)
    const next = r.commit('scripts/nodes/answer/answer-worker.ts')
    s.advance(next)
    const lines = await s.supervisor.step()
    expect(s.stopped).toEqual([104])
    expect(s.starts).toEqual([{ name: 'bus:answer --on', head: next }])
    expect(lines[0]).toBe(`${PREFIX}main advanced to ${next} with a change to the code of bus:answer; restarting only those on ${next}, and every other bus process runs on`)
    expect(s.supervisor.ownCodeBehind).toBeNull()
    expect(switchCommand(busDir, 'answer', true).exitCode).toBe(0)
    expect(switchCommand(busDir, 'close', false).exitCode).toBe(0)
  })

  it('main advancing with no change to the code a bus process runs restarts nothing', async () => {
    const r = repo()
    const busDir = path.join(tempRoot('bus-bg-sup-'), 'bus')
    for (const worker of ['merge', 'review', 'update'] as const)
      switchWorker(busDir, worker, true)
    const s = supervised(r, busDir, RUNNING)
    const next = r.commit('scripts/board/gh.ts')
    s.advance(next)
    expect(await s.supervisor.step()).toEqual([`${PREFIX}main advanced to ${next} with no change to the code a bus process runs; nothing restarted`])
    expect(s.stopped).toEqual([])
    expect(s.starts).toEqual([])
    const unreached = r.commit('scripts/window/board.ts')
    s.advance(unreached)
    expect(await s.supervisor.step()).toEqual([`${PREFIX}main advanced to ${unreached} with no change to the code a bus process runs; nothing restarted`])
    const later = r.commit('scripts/core/db.ts')
    s.advance(later)
    await s.supervisor.step()
    expect(s.stopped).toEqual([101, 102, 103])
  })

  it('an unreadable switch file stops nothing, keeps the advance pending and the loop alive', async () => {
    const r = repo()
    const busDir = path.join(tempRoot('bus-bg-sup-'), 'bus')
    mkdirSync(busDir, { recursive: true })
    writeFileSync(path.join(busDir, WORKERS_FILE), '{"on":["merge",]}')
    const s = supervised(r, busDir, RUNNING.slice(0, 2))
    const next = r.commit('scripts/core/queue.ts')
    s.advance(next)
    const failed = await s.supervisor.step()
    expect(failed).toHaveLength(1)
    expect(failed[0]).toContain('supervisor step failed')
    expect(failed[0]).toContain(`main.advanced to ${next} stays pending`)
    expect(s.stopped).toEqual([])
    expect(s.starts).toEqual([])
    writeFileSync(path.join(busDir, WORKERS_FILE), '{"on":["merge"]}\n')
    await s.supervisor.step()
    expect(s.stopped).toEqual([101, 102])
    expect(s.starts.map(start => start.name).sort()).toEqual(['bus:merge --on', 'bus:run'])
  })

  it('a restart whose review preflight refuses journals worker.down and names the worker it did not bring back', async () => {
    const r = repo()
    const busDir = path.join(tempRoot('bus-bg-sup-'), 'bus')
    switchWorker(busDir, 'review', true)
    const s = supervised(r, busDir, RUNNING.slice(0, 2), gitCode(r.dir), () => [GITHUB_MISMATCH, OLD_REDUCER_DIFF])
    const next = r.commit('scripts/core/queue.ts')
    s.advance(next)
    const lines = await s.supervisor.step()
    expect(s.stopped).toEqual([101, 102])
    expect(s.starts.map(start => start.name)).toEqual(['bus:run'])
    expect(lines[0]).toBe(`${PREFIX}main advanced to ${next} with a change to the code every bus process runs; restarting every running bus process on ${next}; not brought back: bus:review --on`)
    expect(s.journal).toEqual([{ ts: '2026-10-12T10:22:10.000Z', event: 'worker.down', worker: 'bus:review --on', failures: [expect.stringContaining(GITHUB_MISMATCH)], restart: next }])
    expect(String((s.journal[0]!.failures as string[])[0])).toContain(OLD_REDUCER_DIFF)
  })

  it('a restart whose start finds the worker already running neither journals worker.down nor names it as not brought back', async () => {
    const r = repo()
    const busDir = path.join(tempRoot('bus-bg-sup-'), 'bus')
    switchWorker(busDir, 'review', true)
    const lingering: RunningProcess = { pid: 202, args: 'node pnpm.cjs --silent bus:review --on' }
    const s = supervised(r, busDir, RUNNING.slice(0, 2), gitCode(r.dir), NO_PREFLIGHT, launch => launch.script === 'bus:review' ? { stdout: [], stderr: [`${PREFIX}bus:review is already running as pid 202`], exitCode: 1, alreadyRunning: lingering } : null)
    const next = r.commit('scripts/core/queue.ts')
    s.advance(next)
    const lines = await s.supervisor.step()
    expect(lines[0]).toBe(`${PREFIX}main advanced to ${next} with a change to the code every bus process runs; restarting every running bus process on ${next}`)
    expect(s.journal).toEqual([])
  })

  it('a git failure keeps the advance pending and the next step retries it', async () => {
    const r = repo()
    const busDir = path.join(tempRoot('bus-bg-sup-'), 'bus')
    const git = gitCode(r.dir)
    let failures = 1
    const flaky: BusCode = {
      ...git,
      changedSince: (sha) => {
        if (failures-- > 0)
          throw new Error('git diff exited 128')
        return git.changedSince(sha)
      },
    }
    const s = supervised(r, busDir, RUNNING.slice(0, 1), flaky)
    const next = r.commit('scripts/core/lease.ts')
    s.advance(next)
    expect(await s.supervisor.step()).toEqual([`${PREFIX}supervisor step failed: git diff exited 128; main.advanced to ${next} stays pending and is retried on the next tick`])
    expect(s.stopped).toEqual([])
    await s.supervisor.step()
    expect(s.stopped).toEqual([101])
    expect(s.starts).toEqual([{ name: 'bus:run', head: next }])
  })
})
