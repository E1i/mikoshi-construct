import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { INSTANCE_FILE, runBusBg, SHADOW_LOG } from '../../bus/bg.js'

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

function world(): { busDir: string, out: string, env: NodeJS.ProcessEnv } {
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
  return { busDir: path.join(root, 'bus'), out, env: { PATH: bin, STUB_OUT: out } }
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
    const result = runBusBg(w.busDir, w.env)
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
    const first = runBusBg(w.busDir, w.env)
    expect(first.exitCode).toBe(0)
    const pid = first.stdout[0]!
    started.push(Number(pid))
    await settled(path.join(w.out, 'pid'))
    rmSync(path.join(w.out, 'pid'))
    const second = runBusBg(w.busDir, w.env)
    expect(second.exitCode).toBe(1)
    expect(second.stdout).toEqual([])
    expect(second.stderr.join('\n')).toContain(`pid ${pid}`)
    expect(readFileSync(path.join(w.busDir, INSTANCE_FILE), 'utf8').trim()).toBe(pid)
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(existsSync(path.join(w.out, 'pid'))).toBe(false)
  })

  it('a dead recorded pid is taken over', async () => {
    const w = world()
    const dead = deadPid()
    mkdirSync(w.busDir, { recursive: true })
    writeFileSync(path.join(w.busDir, INSTANCE_FILE), `${dead}\n`)
    const result = runBusBg(w.busDir, w.env)
    expect(result.exitCode).toBe(0)
    started.push(Number(result.stdout[0]))
    expect(result.stdout[1]).toContain(`dead pid ${dead}`)
    expect(result.stdout[0]).toBe(await settled(path.join(w.out, 'pid')))
    expect(readFileSync(path.join(w.busDir, INSTANCE_FILE), 'utf8').trim()).toBe(result.stdout[0])
  })

  it('a recorded pid that is alive but not bus:run is taken over', async () => {
    const w = world()
    mkdirSync(w.busDir, { recursive: true })
    writeFileSync(path.join(w.busDir, INSTANCE_FILE), `${process.pid}\n`)
    const result = runBusBg(w.busDir, w.env)
    expect(result.exitCode).toBe(0)
    started.push(Number(result.stdout[0]))
    expect(result.stdout[0]).toBe(await settled(path.join(w.out, 'pid')))
  })
})
