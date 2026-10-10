import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { launchArgv, RELAUNCH_LOG, runRelaunchBg, USAGE } from '../../shift/relaunch-bg.js'
import { settled } from './fixtures/settled.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function stub(bin: string, name: string, body: string): void {
  const file = path.join(bin, name)
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
}

const SYSTEM_BIN_DIRS = ['/bin', '/usr/bin']

function linkFromSystem(bin: string, name: string): void {
  const source = SYSTEM_BIN_DIRS.map(dir => path.join(dir, name)).find(file => existsSync(file))
  if (source === undefined)
    throw new Error(`${name} is in none of ${SYSTEM_BIN_DIRS.join(', ')}`)
  symlinkSync(source, path.join(bin, name))
}

function ownPgid(): string {
  return execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim()
}

function world(): { home: string, out: string, env: NodeJS.ProcessEnv } {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'relaunch-bg-')))
  roots.push(root)
  const bin = path.join(root, 'bin')
  const out = path.join(root, 'out')
  const home = path.join(root, 'home')
  mkdirSync(bin)
  mkdirSync(out)
  mkdirSync(home)
  linkFromSystem(bin, 'ps')
  linkFromSystem(bin, 'tr')
  stub(bin, 'nohup', `echo nohup >> "$STUB_OUT/chain"\nexec "$@"`)
  stub(bin, 'pnpm', `echo "pnpm relaunch output"\nprintf '%s\\n' "$*" > "$STUB_OUT/pnpm.argv"\nps -o pgid= -p $$ | tr -d ' ' > "$STUB_OUT/pgid"\necho $$ > "$STUB_OUT/pid"`)
  return { home, out, env: { PATH: bin, STUB_OUT: out, HOME: home } }
}

describe('pnpm relaunch:bg', () => {
  it('starts pnpm relaunch with the handoff and its arguments in a session of its own, prints its PID and appends its output to the day log', async () => {
    const w = world()
    const result = runRelaunchBg(['/tmp/handoff.md', '--max', '2'], w.env)
    expect(result.exitCode).toBe(0)
    const pid = await settled(path.join(w.out, 'pid'))
    expect(result.stdout[0]).toBe(pid)
    expect(await settled(path.join(w.out, 'pnpm.argv'))).toBe('relaunch /tmp/handoff.md --max 2')
    expect(readFileSync(path.join(w.out, 'chain'), 'utf8').trim()).toBe('nohup')
    expect(await settled(path.join(w.out, 'pgid'))).not.toBe(ownPgid())
    const log = path.join(w.home, RELAUNCH_LOG)
    for (let attempt = 0; attempt < 800 && !readFileSync(log, 'utf8').includes('pnpm relaunch output'); attempt++)
      await new Promise(resolve => setTimeout(resolve, 25))
    expect(readFileSync(log, 'utf8')).toContain('pnpm relaunch output')
  })

  it('refuses without a handoff, spawning nothing', () => {
    const w = world()
    expect(runRelaunchBg([], w.env)).toEqual({ stdout: [], stderr: [USAGE], exitCode: 2 })
    expect(runRelaunchBg(['--max', '2'], w.env).exitCode).toBe(2)
    expect(existsSync(path.join(w.out, 'chain'))).toBe(false)
  })

  it('launches nohup pnpm relaunch with the relaunch arguments', () => {
    expect(launchArgv(['h.md', '--model', 'm'])).toEqual(['nohup', 'pnpm', 'relaunch', 'h.md', '--model', 'm'])
  })
})
