import type { BgResult, DetachedLaunch, ProcessList, RunningProcess } from '../../bus/bg.js'
import type { BusCode } from '../../bus/supervisor.js'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { alive, BUS_RUN_LAUNCH, INSTANCE_FILE, launchName, PREFIX, psList, runBusBg, runningBus, SHADOW_LOG, START_LOCK } from '../../bus/bg.js'
import { appendEvent, openBus } from '../../bus/db.js'
import { bgCommand, BusSupervisor, gitCode, lastMainAdvance, mainAdvancedSince, stopInstance, switchCommand } from '../../bus/supervisor.js'
import { busLaunches, switchedOn, switchWorker, wantedLaunches, WORKERS_FILE } from '../../bus/workers.js'

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

async function settled(file: string): Promise<string> {
  for (let attempt = 0; attempt < 200 && !existsSync(file); attempt++)
    await new Promise(resolve => setTimeout(resolve, 25))
  return readFileSync(file, 'utf8').trim()
}

async function argvLines(w: World, count: number): Promise<string[]> {
  const file = path.join(w.out, 'pnpm.argv')
  const read = (): string[] => existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n') : []
  for (let attempt = 0; attempt < 200 && read().length < count; attempt++)
    await new Promise(resolve => setTimeout(resolve, 25))
  await new Promise(resolve => setTimeout(resolve, 200))
  return read()
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

describe('pnpm bus:bg', () => {
  it('bus:bg returns at once with the pid and the log path', async () => {
    const w = world()
    const before = Date.now()
    const result = runBusBg(w.busDir, [BUS_RUN_LAUNCH], w.env, w.processes)
    expect(Date.now() - before).toBeLessThan(5000)
    expect(result.exitCode).toBe(0)
    started.push(Number(result.stdout[0]))
    const log = path.join(w.busDir, SHADOW_LOG)
    expect(result.stdout[0]).toBe(await settled(path.join(w.out, 'pid')))
    expect(result.stdout[1]).toContain(`log ${log}`)
    expect(readFileSync(path.join(w.busDir, INSTANCE_FILE), 'utf8').trim()).toBe(result.stdout[0])
    expect(await argvLines(w, 1)).toEqual(['--silent bus:run'])
    expect(argsOf(Number(result.stdout[0]))).toContain('bus:run')
    for (let attempt = 0; attempt < 200 && !readFileSync(log, 'utf8').includes('bus:run output'); attempt++)
      await new Promise(resolve => setTimeout(resolve, 25))
    expect(readFileSync(log, 'utf8')).toContain('bus:run output')
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
    expect(readFileSync(path.join(w.busDir, INSTANCE_FILE), 'utf8').trim()).toBe(pid)
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(existsSync(path.join(w.out, 'pid'))).toBe(false)
  })

  it('a bus:run started by hand, with no instance file, is left alone and named', async () => {
    const w = world()
    const byHand: ProcessList = () => [{ pid: 4242, args: 'node /x/node_modules/tsx/dist/cli.mjs scripts/bus/run.ts' }]
    const result = runBusBg(w.busDir, [BUS_RUN_LAUNCH], w.env, byHand)
    expect(result.exitCode).toBe(0)
    expect(result.stdout.join('\n')).toContain('pid 4242')
    expect(existsSync(path.join(w.busDir, INSTANCE_FILE))).toBe(false)
    expect(existsSync(path.join(w.busDir, START_LOCK))).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(existsSync(path.join(w.out, 'pid'))).toBe(false)
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
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(existsSync(path.join(w.out, 'pid'))).toBe(false)
  })

  it('a start lock and an instance file left by dead processes do not block a start', async () => {
    const w = world()
    mkdirSync(w.busDir, { recursive: true })
    writeFileSync(path.join(w.busDir, START_LOCK), `${deadPid()}\n`)
    writeFileSync(path.join(w.busDir, INSTANCE_FILE), `${deadPid()}\n`)
    const result = runBusBg(w.busDir, [BUS_RUN_LAUNCH], w.env, w.processes)
    expect(result.exitCode).toBe(0)
    started.push(Number(result.stdout[0]))
    expect(result.stdout[0]).toBe(await settled(path.join(w.out, 'pid')))
    expect(readFileSync(path.join(w.busDir, INSTANCE_FILE), 'utf8').trim()).toBe(result.stdout[0])
    expect(existsSync(path.join(w.busDir, START_LOCK))).toBe(false)
  })

  it('a running bus is recognised by its script, not by any mention of bus:run', () => {
    expect(runningBus([{ pid: 11, args: 'rg bus:run scripts' }])).toBeUndefined()
    expect(runningBus([{ pid: 12, args: 'node tsx/dist/cli.mjs scripts/bus/run.ts' }])?.pid).toBe(12)
    expect(runningBus([{ pid: 13, args: 'node pnpm.cjs --silent bus:run' }])?.pid).toBe(13)
  })

  it('bus:bg starts bus:run and every switched-on worker once and leaves a running one alone', async () => {
    const w = world()
    switchWorker(w.busDir, 'review', true)
    switchWorker(w.busDir, 'merge', true)
    const mergeByHand: RunningProcess = { pid: 4242, args: 'node /x/node_modules/tsx/dist/cli.mjs scripts/bus/merge-worker.ts --on' }
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
    expect(await argvLines(w, 3)).toHaveLength(2)
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
    expect(await argvLines(w, 2)).toEqual(['--silent bus:run'])
    for (const worker of ['review', 'merge', 'update'])
      expect(existsSync(path.join(w.busDir, `bus-${worker}.pid`))).toBe(false)
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

  it('a stopped instance is signalled as a group and waited for', async () => {
    const pid = detachedSleep()
    const processes: ProcessList = () => alive(pid) ? [{ pid, args: `sleep 30 marker-${pid}` }] : []
    await stopInstance({ pid, args: '' }, [`marker-${pid}`], processes)
    for (let attempt = 0; attempt < 40 && alive(pid); attempt++)
      await new Promise(resolve => setTimeout(resolve, 25))
    expect(alive(pid)).toBe(false)
  })
})

interface Repo {
  dir: string
  commit: (file: string) => string
}

function repo(): Repo {
  const dir = tempRoot('bus-bg-code-')
  const git = (...args: string[]): string => execFileSync('git', ['-c', 'user.name=bus', '-c', 'user.email=bus@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' }).trim()
  git('init', '--quiet')
  let n = 0
  const commit = (file: string): string => {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    writeFileSync(path.join(dir, file), `${n++}\n`)
    git('add', '.')
    git('commit', '--quiet', '-m', file)
    return git('rev-parse', 'HEAD')
  }
  commit('scripts/bus/run.ts')
  return { dir, commit }
}

interface Supervised {
  supervisor: BusSupervisor
  advance: (sha: string) => void
  stopped: number[]
  starts: { name: string, head: string }[]
}

function supervised(r: Repo, busDir: string, running: RunningProcess[]): Supervised {
  const db = openBus(path.join(busDir, 'bus.db'))
  const code: BusCode = gitCode(r.dir)
  const stopped: number[] = []
  const starts: { name: string, head: string }[] = []
  let alive = [...running]
  const supervisor = new BusSupervisor({
    known: busLaunches(NO_PREFLIGHT),
    wanted: () => wantedLaunches(busDir, NO_PREFLIGHT),
    start: (launch: DetachedLaunch) => {
      starts.push({ name: launchName(launch), head: code.head() })
      return { stdout: [`started ${launchName(launch)}`], stderr: [], exitCode: 0 }
    },
    stop: async (instance) => {
      stopped.push(instance.pid)
      alive = alive.filter(candidate => candidate.pid !== instance.pid)
    },
    processes: () => alive,
    mainSince: afterId => mainAdvancedSince(db, afterId),
    code,
  }, lastMainAdvance(db))
  const advance = (sha: string): void => {
    appendEvent(db, { ts: new Date().toISOString(), type: 'main.advanced', actor: 'netwatch', cardId: null, pr: null, head: null, dedupeKey: `main:${sha}`, payload: { sha, touches_mechanics: true }, legacy: false })
  }
  return { supervisor, advance, stopped, starts }
}

const RUNNING: RunningProcess[] = [
  { pid: 101, args: 'node pnpm.cjs --silent bus:run' },
  { pid: 102, args: 'node pnpm.cjs --silent bus:review --on' },
  { pid: 103, args: 'node pnpm.cjs --silent bus:update --on' },
]

describe('bus:bg --supervise', () => {
  it('main advancing with a change under scripts/bus restarts every running bus process on the new code', async () => {
    const r = repo()
    const busDir = path.join(tempRoot('bus-bg-sup-'), 'bus')
    switchWorker(busDir, 'review', true)
    switchWorker(busDir, 'merge', true)
    const s = supervised(r, busDir, RUNNING)
    expect(await s.supervisor.step()).toEqual([])
    const next = r.commit('scripts/bus/queue.ts')
    s.advance(next)
    const lines = await s.supervisor.step()
    expect(s.stopped).toEqual([101, 102, 103])
    expect(s.starts.map(start => start.name).sort()).toEqual(['bus:merge --on', 'bus:review --on', 'bus:run', 'bus:update --on'])
    expect(s.starts.every(start => start.head === next)).toBe(true)
    expect(lines[0]).toContain(`main advanced to ${next} with a change under scripts/bus`)
    expect(await s.supervisor.step()).toEqual([])
    expect(s.starts).toHaveLength(4)
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
    const next = r.commit('scripts/bus/lease.ts')
    s.advance(next)
    await s.supervisor.step()
    expect(s.stopped).toEqual([101])
    expect(s.starts).toEqual([{ name: 'bus:run', head: next }])
  })

  it('main advancing with no change under scripts/bus restarts nothing', async () => {
    const r = repo()
    const busDir = path.join(tempRoot('bus-bg-sup-'), 'bus')
    switchWorker(busDir, 'merge', true)
    const s = supervised(r, busDir, RUNNING)
    const next = r.commit('scripts/board/gh.ts')
    s.advance(next)
    expect(await s.supervisor.step()).toEqual([`${PREFIX}main advanced to ${next} with no change under scripts/bus; nothing restarted`])
    expect(s.stopped).toEqual([])
    expect(s.starts).toEqual([])
    const later = r.commit('scripts/bus/run.ts')
    s.advance(later)
    await s.supervisor.step()
    expect(s.stopped).toEqual([101, 102, 103])
  })
})
