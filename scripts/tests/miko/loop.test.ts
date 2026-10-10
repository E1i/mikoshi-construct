import type { Status } from '../../shift/relaunch.js'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { CONTINUE_PROMPT, isDoubleCtrlC, mikoshiHandoff, PAUSE_MS, runMikoLoop } from '../../miko/loop.js'

const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..')
const LOOP = path.join(REPO_ROOT, 'scripts', 'miko', 'loop.ts')
const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx')
const KEY_PRESS_GAP_MS = 300
const STUB_CLAUDE = `#!/bin/sh
n=$(( $(cat "$STUB_DIR/count" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$STUB_DIR/count"
printf '%s|%s\\n' "$#" "$*" >> "$STUB_DIR/calls"
ps -o pgid= -p $$ | tr -d ' ' >> "$STUB_DIR/groups"
set -- $(sed -n "\${n}p" "$STUB_DIR/plan")
case "$1" in
  continue|owner|stop) echo "STATUS: $(echo "$1" | tr a-z A-Z)" > "$HOME/.construct/handoff/mikoshi.md"; exit "$2" ;;
  quiet) exit "$2" ;;
  hang) echo 'STATUS: CONTINUE' > "$HOME/.construct/handoff/mikoshi.md"; touch "$STUB_DIR/ready"; sleep 30 ;;
esac
exit 0
`

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function home(plan: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'miko-loop-'))
  roots.push(dir)
  mkdirSync(path.join(dir, '.construct', 'handoff'), { recursive: true })
  writeFileSync(path.join(dir, 'claude'), STUB_CLAUDE, { mode: 0o755 })
  writeFileSync(path.join(dir, 'plan'), `${plan.join('\n')}\n`)
  return dir
}

function lines(dir: string, name: string): string[] {
  return existsSync(path.join(dir, name)) ? readFileSync(path.join(dir, name), 'utf8').split('\n').filter(Boolean) : []
}

function startLoop(dir: string, claude = path.join(dir, 'claude')): { done: Promise<{ code: number | null, stderr: string }>, pid: number } {
  const child = spawn(TSX, [LOOP], {
    env: { ...process.env, HOME: dir, STUB_DIR: dir, MIKO_CLAUDE: claude },
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: true,
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })
  const done = new Promise<{ code: number | null, stderr: string }>(resolve => child.on('close', code => resolve({ code, stderr })))
  return { done, pid: child.pid! }
}

async function until(condition: () => boolean): Promise<void> {
  for (let tries = 0; tries < 200 && !condition(); tries++)
    await new Promise(resolve => setTimeout(resolve, 50))
}

async function endsWithin(loop: ReturnType<typeof startLoop>, ms: number): Promise<{ code: number | null, stderr: string } | 'still running'> {
  const timeout = new Promise<'still running'>(resolve => setTimeout(resolve, ms, 'still running'))
  const outcome = await Promise.race([loop.done, timeout])
  if (outcome === 'still running')
    process.kill(-loop.pid, 'SIGKILL')
  return outcome
}

describe('pnpm miko restarts Miko in its own terminal while mikoshi.md says STATUS: CONTINUE', () => {
  it('a session that exits with STATUS: CONTINUE starts the next session in the same terminal after a pause', async () => {
    const dir = home(['continue 3', 'owner 0'])
    const started = Date.now()
    const loop = startLoop(dir)
    const { code, stderr } = await loop.done
    expect(code).toBe(0)
    expect(Date.now() - started).toBeGreaterThanOrEqual(PAUSE_MS)
    expect(lines(dir, 'calls')).toEqual(['0|', `1|${CONTINUE_PROMPT}`])
    expect(lines(dir, 'groups')).toEqual([String(loop.pid), String(loop.pid)])
    expect(stderr).toContain('STATUS: CONTINUE: next session')
  }, 20_000)

  it.each(['owner', 'stop'])('a session that exits with STATUS: OWNER or STOP ends the loop, here %s', async (status) => {
    const dir = home([`${status} 0`, 'continue 0'])
    writeFileSync(mikoshiHandoff(dir), 'STATUS: CONTINUE\n')
    const { code, stderr } = await startLoop(dir).done
    expect(code).toBe(0)
    expect(lines(dir, 'calls')).toEqual([`1|${CONTINUE_PROMPT}`])
    expect(stderr).toContain(`STATUS: ${status.toUpperCase()}: no next session`)
  }, 20_000)

  it('a double Ctrl-C ends the loop, though the interrupted session left STATUS: CONTINUE', async () => {
    const dir = home(['hang', 'owner 0'])
    const loop = startLoop(dir)
    await until(() => existsSync(path.join(dir, 'ready')))
    process.kill(-loop.pid, 'SIGINT')
    await new Promise(resolve => setTimeout(resolve, KEY_PRESS_GAP_MS))
    process.kill(-loop.pid, 'SIGINT')
    const { stderr } = await loop.done
    expect(lines(dir, 'calls')).toEqual(['0|'])
    expect(stderr).toContain('double Ctrl+C')
  }, 20_000)

  it('a single Ctrl-C ends only the session, and STATUS: CONTINUE starts the next one', async () => {
    const dir = home(['hang', 'owner 0'])
    const loop = startLoop(dir)
    await until(() => existsSync(path.join(dir, 'ready')))
    process.kill(-loop.pid, 'SIGINT')
    const { code } = await loop.done
    expect(code).toBe(0)
    expect(lines(dir, 'calls')).toEqual(['0|', `1|${CONTINUE_PROMPT}`])
  }, 20_000)

  it('stops with exit code 1 when MIKO_CLAUDE names a missing command, though mikoshi.md says STATUS: CONTINUE', async () => {
    const dir = home([])
    writeFileSync(mikoshiHandoff(dir), 'STATUS: CONTINUE\n')
    const outcome = await endsWithin(startLoop(dir, path.join(dir, 'no-such-claude')), 2 * PAUSE_MS)
    expect(outcome).not.toBe('still running')
    expect(outcome).toMatchObject({ code: 1, stderr: expect.stringContaining('the session did not start') })
  }, 20_000)

  it('a session that exits without rewriting mikoshi.md ends the loop, though the previous STATUS: CONTINUE is still there', async () => {
    const dir = home(['quiet 0', 'quiet 0'])
    writeFileSync(mikoshiHandoff(dir), 'STATUS: CONTINUE\n')
    const outcome = await endsWithin(startLoop(dir), 2 * PAUSE_MS)
    expect(outcome).not.toBe('still running')
    expect(lines(dir, 'calls')).toEqual([`1|${CONTINUE_PROMPT}`])
    expect(outcome).toMatchObject({ code: 0, stderr: expect.stringContaining('without rewriting mikoshi.md') })
  }, 20_000)
})

interface Script {
  statuses: (Status | null | undefined)[]
  doubles?: boolean[]
}

async function drive({ statuses, doubles = [] }: Script): Promise<{ code: number, prompts: (string | undefined)[], pauses: number[], lines: string[] }> {
  const prompts: (string | undefined)[] = []
  const pauses: number[] = []
  const lines: string[] = []
  const code = await runMikoLoop({
    status: () => statuses.shift(),
    handoffMtime: () => prompts.length,
    session: async (prompt) => {
      prompts.push(prompt)
      return { code: 0, signal: null }
    },
    pause: async (ms) => {
      pauses.push(ms)
    },
    doubleCtrlC: () => doubles.shift() ?? false,
    err: line => lines.push(line),
  })
  return { code, prompts, pauses, lines }
}

describe('runMikoLoop decides from STATUS in mikoshi.md and the Ctrl+C presses', () => {
  it.each([
    { name: 'absent', statuses: [undefined, 'CONTINUE', 'CONTINUE', 'OWNER'] as const, prompts: [undefined, CONTINUE_PROMPT, CONTINUE_PROMPT] },
    { name: 'present', statuses: ['OWNER', 'CONTINUE', 'DONE'] as const, prompts: [CONTINUE_PROMPT, CONTINUE_PROMPT] },
  ])('with mikoshi.md $name at the start, pauses and restarts on each CONTINUE and stops on the first other STATUS', async ({ statuses, prompts }) => {
    const run = await drive({ statuses: [...statuses] })
    expect(run.code).toBe(0)
    expect(run.prompts).toEqual(prompts)
    expect(run.pauses).toEqual(Array.from({ length: prompts.length - 1 }).fill(PAUSE_MS))
  })

  it('stops when mikoshi.md carries no STATUS line', async () => {
    const run = await drive({ statuses: [undefined, null] })
    expect(run.prompts).toEqual([undefined])
    expect(run.lines.join('\n')).toContain('STATUS: none')
  })

  it.each([
    { name: 'during the session', doubles: [true], pauses: [] },
    { name: 'during the pause', doubles: [false, true], pauses: [PAUSE_MS] },
  ])('stops on a double Ctrl+C $name, though STATUS says CONTINUE', async ({ doubles, pauses }) => {
    const run = await drive({ statuses: [undefined, 'CONTINUE', 'CONTINUE'], doubles: [...doubles] })
    expect(run.code).toBe(0)
    expect(run.prompts).toEqual([undefined])
    expect(run.pauses).toEqual(pauses)
    expect(run.lines.join('\n')).toContain('double Ctrl+C')
  })

  it('stops with exit code 1 when the session could not start, so a missing claude does not spin', async () => {
    const statuses: (Status | undefined)[] = ['CONTINUE', 'CONTINUE']
    const code = await runMikoLoop({
      status: () => statuses.shift(),
      handoffMtime: () => 0,
      session: async () => ({ code: null, signal: null }),
      pause: async () => {},
      doubleCtrlC: () => false,
      err: () => {},
    })
    expect(code).toBe(1)
  })
})

describe('isDoubleCtrlC', () => {
  it.each([
    { presses: [], double: false },
    { presses: [1000], double: false },
    { presses: [1000, 1000 + 2000], double: true },
    { presses: [1000, 1000 + 2001], double: false },
    { presses: [0, 10_000, 10_500], double: true },
  ])('reads $presses as double: $double', ({ presses, double }) => {
    expect(isDoubleCtrlC(presses)).toBe(double)
  })
})
