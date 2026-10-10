import type { RoleStop } from '../../bus/role.js'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { ancestors, exitDecision, FRESH_MS, parsePs, runMikoExit } from '../../miko/exit.js'
import { mikoshiHandoff } from '../../miko/loop.js'

const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..')
const LOOP = path.join(REPO_ROOT, 'scripts', 'miko', 'loop.ts')
const EXIT = path.join(REPO_ROOT, 'scripts', 'miko', 'exit.ts')
const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx')
const STUB_CLAUDE = `#!/bin/sh
n=$(( $(cat "$STUB_DIR/count" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$STUB_DIR/count"
echo "$n" >> "$STUB_DIR/calls"
set -- $(sed -n "\${n}p" "$STUB_DIR/plan")
case "$1" in
  write) echo 'STATUS: CONTINUE' > "$HOME/.construct/handoff/mikoshi.md" ;;
  owner) echo 'STATUS: OWNER' > "$HOME/.construct/handoff/mikoshi.md" ;;
esac
case "$2" in
  exit)
    "$TSX" "$EXIT" 2>>"$STUB_DIR/exit.err"
    echo "$?" >> "$STUB_DIR/exit.code"
    sleep "\${3:-30}" >/dev/null 2>&1
    echo survived >> "$STUB_DIR/survived" ;;
esac
exit 0
`

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function home(plan: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'miko-exit-'))
  roots.push(dir)
  mkdirSync(path.join(dir, '.construct', 'handoff'), { recursive: true })
  writeFileSync(path.join(dir, 'claude'), STUB_CLAUDE, { mode: 0o755 })
  writeFileSync(path.join(dir, 'plan'), `${plan.join('\n')}\n`)
  return dir
}

function read(dir: string, name: string): string {
  return existsSync(path.join(dir, name)) ? readFileSync(path.join(dir, name), 'utf8') : ''
}

function run(dir: string, command: string, args: string[]): Promise<{ code: number | null, signal: NodeJS.Signals | null, stderr: string }> {
  const child = spawn(command, args, {
    env: { ...process.env, HOME: dir, STUB_DIR: dir, MIKO_CLAUDE: path.join(dir, 'claude'), TSX, EXIT },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })
  return new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal, stderr })))
}

describe('pnpm miko:exit ends the claude of the current Mikoshi window', () => {
  it('ends a stub session under the loop and the loop starts the next one', async () => {
    const dir = home(['write exit', 'owner'])
    const { code, stderr } = await run(dir, TSX, [LOOP])
    expect(code).toBe(0)
    expect(read(dir, 'calls').split('\n').filter(Boolean)).toEqual(['1', '2'])
    expect(read(dir, 'exit.err')).toContain('ending claude')
    expect(read(dir, 'survived')).toBe('')
    expect(stderr).toContain('STATUS: CONTINUE: next session')
  }, 20_000)

  it('refuses when mikoshi.md is older than two minutes', async () => {
    const dir = home(['quiet exit 1'])
    writeFileSync(mikoshiHandoff(dir), 'old handoff')
    const threeMinutesAgo = (Date.now() - 3 * 60 * 1000) / 1000
    utimesSync(mikoshiHandoff(dir), threeMinutesAgo, threeMinutesAgo)
    const { code } = await run(dir, TSX, [LOOP])
    expect(code).toBe(0)
    expect(read(dir, 'exit.code').trim()).toBe('1')
    expect(read(dir, 'survived').trim()).toBe('survived')
    const age = Number(/mikoshi\.md was written (\d+)s ago/.exec(read(dir, 'exit.err'))?.[1])
    expect(age).toBeGreaterThanOrEqual(180)
  }, 20_000)

  it('refuses outside the miko loop', async () => {
    const dir = home(['owner exit 1'])
    const { code, signal } = await run(dir, path.join(dir, 'claude'), [])
    expect({ code, signal }).toEqual({ code: 0, signal: null })
    expect(read(dir, 'exit.code').trim()).toBe('1')
    expect(read(dir, 'survived').trim()).toBe('survived')
    expect(read(dir, 'exit.err')).toContain('does not run under the pnpm miko loop')
  }, 20_000)
})

describe('exitDecision reads the process chain and the age of mikoshi.md', () => {
  const now = 1_000_000_000
  const loop = { pid: 10, ppid: 1, args: 'node /x/node_modules/tsx/dist/cli.mjs /x/scripts/miko/loop.ts' }
  const shell = { pid: 11, ppid: 10, args: 'sh -c claude --permission-mode auto "$@" miko' }
  const claude = { pid: 12, ppid: 11, args: 'claude --permission-mode auto' }
  const zsh = { pid: 13, ppid: 12, args: '/bin/zsh -c -l eval pnpm miko:exit' }

  it('kills the nearest claude when the loop is above it and mikoshi.md is fresh', () => {
    expect(exitDecision([zsh, claude, shell, loop], now - 1000, now)).toMatchObject({ kill: 12 })
  })

  it('takes a claude started through node by its script path', () => {
    const viaNode = { ...claude, args: 'node /usr/local/bin/claude --permission-mode auto' }
    expect(exitDecision([zsh, viaNode, shell, loop], now, now)).toMatchObject({ kill: 12 })
  })

  it('refuses when another claude stands between the nearest claude and the loop', () => {
    const inner = { pid: 20, ppid: 13, args: '/tmp/stub/claude' }
    expect(exitDecision([inner, zsh, claude, shell, loop], now, now)).toMatchObject({ refuse: expect.stringContaining('claude 20 does not run under') })
  })

  it('refuses with no claude in the chain', () => {
    expect(exitDecision([shell, loop], now, now)).toMatchObject({ refuse: expect.stringContaining('no claude') })
  })

  it.each([
    { name: 'absent', mtime: undefined, says: 'does not exist' },
    { name: 'older than two minutes', mtime: now - FRESH_MS - 1000, says: 'written 121s ago' },
  ])('refuses when mikoshi.md is $name', ({ mtime, says }) => {
    expect(exitDecision([zsh, claude, shell, loop], mtime, now)).toMatchObject({ refuse: expect.stringContaining(says) })
  })
})

describe('a Miko window outside the pnpm miko loop that stops at a threshold', () => {
  const now = 1_000_000_000
  const claude = { pid: 12, ppid: 1, args: 'claude --permission-mode auto' }
  const zsh = { pid: 13, ppid: 12, args: '/bin/zsh -c -l eval pnpm miko:exit' }
  const table = parsePs('  1     0 /sbin/launchd\n 12     1 claude\n 13    12 zsh\n 14    13 node exit.ts\n')

  it('with STATUS: CONTINUE in a fresh mikoshi.md writes role.stopped for miko and ends its claude', () => {
    const kills: number[] = []
    const stops: RoleStop[] = []
    const lines: string[] = []
    expect(runMikoExit({ pid: 14, table: () => table, handoffMtime: () => 0, now: () => 0, kill: pid => kills.push(pid), err: line => lines.push(line), handoff: '/h/mikoshi.md', status: () => 'CONTINUE', raised: false, observeStop: stop => stops.push(stop) })).toBe(0)
    expect(stops).toEqual([{ role: 'miko', handoff: '/h/mikoshi.md', status: 'CONTINUE', reason: 'context', raised: false }])
    expect(kills).toEqual([12])
    expect(lines[0]).toContain('role.stopped goes to the bus')
  })

  it.each([
    { name: 'another STATUS', status: 'OWNER', mtime: now },
    { name: 'no STATUS', status: null, mtime: now },
    { name: 'a stale mikoshi.md', status: 'CONTINUE', mtime: now - FRESH_MS - 1000 },
  ])('with $name refuses as before and writes nothing', ({ status, mtime }) => {
    expect(exitDecision([zsh, claude], mtime, now, status)).toMatchObject({ refuse: expect.stringContaining('does not run under the pnpm miko loop') })
  })
})

describe('runMikoExit kills only on a kill decision', () => {
  const table = parsePs('  1     0 /sbin/launchd\n 10     1 node tsx scripts/miko/loop.ts\n 12    10 claude\n 13    12 zsh\n 14    13 node exit.ts\n')

  it('walks ancestors from its own pid', () => {
    expect(ancestors(table, 14).map(row => row.pid)).toEqual([13, 12, 10, 1])
  })

  it.each([
    { mtime: 0, killed: [12], code: 0 },
    { mtime: undefined, killed: [], code: 1 },
  ])('with mikoshi.md at $mtime exits $code and kills $killed', ({ mtime, killed, code }) => {
    const kills: number[] = []
    const lines: string[] = []
    expect(runMikoExit({ pid: 14, table: () => table, handoffMtime: () => mtime, now: () => 0, kill: pid => kills.push(pid), err: line => lines.push(line) })).toBe(code)
    expect(kills).toEqual(killed)
    expect(lines).toHaveLength(1)
  })
})
