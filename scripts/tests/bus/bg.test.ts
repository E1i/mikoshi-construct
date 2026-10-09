import type { ProcessList } from '../../bus/bg.js'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { INSTANCE_FILE, PREFIX, psList, runBusBg, runningBus, SHADOW_LOG, START_LOCK } from '../../bus/bg.js'

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

interface World {
  busDir: string
  out: string
  env: NodeJS.ProcessEnv
  processes: ProcessList
}

function world(): World {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'bus-bg-')))
  roots.push(root)
  const bin = path.join(root, 'bin')
  const out = path.join(root, 'out')
  mkdirSync(bin)
  mkdirSync(out)
  linkFromSystem(bin, 'ps')
  linkFromSystem(bin, 'sleep')
  stub(bin, 'nohup', 'exec "$@"')
  stub(bin, 'pnpm', `echo "bus:run output"\nprintf '%s\\n' "$*" > "$STUB_OUT/pnpm.argv"\necho $$ > "$STUB_OUT/pid"\nsleep 30`)
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

function deadPid(): number {
  const child = spawnSync('/usr/bin/true')
  return child.pid!
}

function argsOf(pid: number): string {
  return execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' })
}

describe('pnpm bus:bg', () => {
  it('bus:bg returns at once with the pid and the log path', async () => {
    const w = world()
    const before = Date.now()
    const result = runBusBg(w.busDir, w.env, w.processes)
    expect(Date.now() - before).toBeLessThan(5000)
    expect(result.exitCode).toBe(0)
    started.push(Number(result.stdout[0]))
    const log = path.join(w.busDir, SHADOW_LOG)
    expect(result.stdout[0]).toBe(await settled(path.join(w.out, 'pid')))
    expect(result.stdout[1]).toContain(`log ${log}`)
    expect(readFileSync(path.join(w.busDir, INSTANCE_FILE), 'utf8').trim()).toBe(result.stdout[0])
    expect(await settled(path.join(w.out, 'pnpm.argv'))).toBe('--silent bus:run')
    expect(argsOf(Number(result.stdout[0]))).toContain('bus:run')
    for (let attempt = 0; attempt < 200 && !readFileSync(log, 'utf8').includes('bus:run output'); attempt++)
      await new Promise(resolve => setTimeout(resolve, 25))
    expect(readFileSync(log, 'utf8')).toContain('bus:run output')
  })

  it('a second start while bus:run is alive is refused and names its pid', async () => {
    const w = world()
    const first = runBusBg(w.busDir, w.env, w.processes)
    expect(first.exitCode).toBe(0)
    const pid = first.stdout[0]!
    started.push(Number(pid))
    await settled(path.join(w.out, 'pid'))
    rmSync(path.join(w.out, 'pid'))
    const second = runBusBg(w.busDir, w.env, w.processes)
    expect(second.exitCode).toBe(1)
    expect(second.stdout).toEqual([])
    expect(second.stderr.join('\n')).toContain(`pid ${pid}`)
    expect(readFileSync(path.join(w.busDir, INSTANCE_FILE), 'utf8').trim()).toBe(pid)
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(existsSync(path.join(w.out, 'pid'))).toBe(false)
  })

  it('a bus:run started by hand, with no instance file, is refused and named', async () => {
    const w = world()
    const byHand: ProcessList = () => [{ pid: 4242, args: 'node /x/node_modules/tsx/dist/cli.mjs scripts/bus/run.ts' }]
    const result = runBusBg(w.busDir, w.env, byHand)
    expect(result.exitCode).toBe(1)
    expect(result.stderr.join('\n')).toContain('pid 4242')
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
    const result = runBusBg(w.busDir, w.env, w.processes)
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
    const result = runBusBg(w.busDir, w.env, w.processes)
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
})
