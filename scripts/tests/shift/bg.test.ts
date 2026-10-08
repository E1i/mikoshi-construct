import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BG_LOG, launchArgv, runBg, USAGE } from '../../shift/bg.js'

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

function world(withSetsid: boolean): { root: string, dir: string, out: string, env: NodeJS.ProcessEnv } {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'shift-bg-')))
  roots.push(root)
  const bin = path.join(root, 'bin')
  const out = path.join(root, 'out')
  mkdirSync(bin)
  mkdirSync(out)
  stub(bin, 'nohup', `echo nohup >> "$STUB_OUT/chain"\nexec "$@"`)
  if (withSetsid)
    stub(bin, 'setsid', `echo setsid >> "$STUB_OUT/chain"\nexec "$@"`)
  stub(bin, 'pnpm', `echo "pnpm shift output"\nprintf '%s\\n' "$*" > "$STUB_OUT/pnpm.argv"\nps -o pgid= -p $$ | tr -d ' ' > "$STUB_OUT/pgid"\necho $$ > "$STUB_OUT/pid"`)
  return { root, dir: path.join(root, 'shift'), out, env: { PATH: `${bin}:/usr/bin:/bin`, STUB_OUT: out } }
}

async function settled(file: string): Promise<string> {
  for (let attempt = 0; attempt < 200 && !existsSync(file); attempt++)
    await new Promise(resolve => setTimeout(resolve, 25))
  return readFileSync(file, 'utf8').trim()
}

describe('pnpm shift:bg', () => {
  it('spawns one detached nohup setsid pnpm shift <dir> --chain, its output in <dir>, and prints its PID', async () => {
    const w = world(true)
    const result = runBg([w.dir, '--chain'], w.env)
    expect(result.exitCode).toBe(0)
    const pid = await settled(path.join(w.out, 'pid'))
    expect(result.stdout[0]).toBe(pid)
    expect(await settled(path.join(w.out, 'pnpm.argv'))).toBe(`shift ${w.dir} --chain`)
    expect(readFileSync(path.join(w.out, 'chain'), 'utf8').trim().split('\n')).toEqual(['nohup', 'setsid'])
    expect(await settled(path.join(w.out, 'pgid'))).toBe(pid)
    for (let attempt = 0; attempt < 200 && !readFileSync(path.join(w.dir, BG_LOG), 'utf8').includes('pnpm shift output'); attempt++)
      await new Promise(resolve => setTimeout(resolve, 25))
    expect(readFileSync(path.join(w.dir, BG_LOG), 'utf8')).toContain('pnpm shift output')
  })

  it('without setsid on PATH still starts the shift in a session of its own through the detached spawn', async () => {
    const w = world(false)
    const result = runBg([w.dir, '--chain'], w.env)
    expect(result.exitCode).toBe(0)
    const pid = await settled(path.join(w.out, 'pid'))
    expect(result.stdout[0]).toBe(pid)
    expect(await settled(path.join(w.out, 'pgid'))).toBe(pid)
    expect(readFileSync(path.join(w.out, 'chain'), 'utf8').trim()).toBe('nohup')
  })

  it('refuses without a dir and refuses a dir whose shift already ran, spawning nothing', () => {
    const w = world(true)
    expect(runBg([], w.env)).toEqual({ stdout: [], stderr: [USAGE], exitCode: 2 })
    expect(runBg(['--chain'], w.env).exitCode).toBe(2)
    mkdirSync(w.dir)
    writeFileSync(path.join(w.dir, 'shift.jsonl'), '')
    expect(runBg([w.dir, '--chain'], w.env).exitCode).toBe(1)
    expect(existsSync(path.join(w.out, 'chain'))).toBe(false)
  })

  it('puts setsid between nohup and pnpm only when it is there', () => {
    expect(launchArgv(['d', '--chain'], true)).toEqual(['nohup', 'setsid', 'pnpm', 'shift', 'd', '--chain'])
    expect(launchArgv(['d'], false)).toEqual(['nohup', 'pnpm', 'shift', 'd'])
  })
})
