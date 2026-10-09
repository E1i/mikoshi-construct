import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { CONTINUE_PROMPT, mikoshiHandoff, runMikoLoop } from '../../miko/loop.js'

const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..')
const LOOP = path.join(REPO_ROOT, 'scripts', 'miko', 'loop.ts')
const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx')
const STUB_CLAUDE = `#!/bin/sh
n=$(( $(cat "$STUB_DIR/count" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$STUB_DIR/count"
printf '%s|%s\\n' "$#" "$*" >> "$STUB_DIR/calls"
set -- $(sed -n "\${n}p" "$STUB_DIR/plan")
case "$1" in
  write) echo handoff > "$HOME/.construct/handoff/mikoshi.md"; exit "$2" ;;
  quiet) exit "$2" ;;
  hang) echo handoff > "$HOME/.construct/handoff/mikoshi.md"; touch "$STUB_DIR/ready"; sleep 30 ;;
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

function calls(dir: string): string[] {
  return existsSync(path.join(dir, 'calls')) ? readFileSync(path.join(dir, 'calls'), 'utf8').split('\n').filter(Boolean) : []
}

function startLoop(dir: string): { done: Promise<{ code: number | null, stderr: string }>, pid: number } {
  const child = spawn(TSX, [LOOP], {
    env: { ...process.env, HOME: dir, STUB_DIR: dir, MIKO_CLAUDE: path.join(dir, 'claude') },
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

describe('pnpm miko restarts Miko in place when it wrote mikoshi.md', () => {
  it('starts the next session with the continue prompt after a write, whatever the exit code, and stops on an exit without a write', async () => {
    const dir = home(['write 0', 'write 3', 'quiet 0'])
    const { code } = await startLoop(dir).done
    expect(code).toBe(0)
    expect(calls(dir)).toEqual(['0|', `1|${CONTINUE_PROMPT}`, `1|${CONTINUE_PROMPT}`])
  })

  it('stops after the first session when it exited without writing mikoshi.md, even with an old one in place and a failing exit code', async () => {
    const dir = home(['quiet 1', 'write 0'])
    writeFileSync(mikoshiHandoff(dir), 'old handoff')
    const { code, stderr } = await startLoop(dir).done
    expect(code).toBe(0)
    expect(calls(dir)).toEqual(['0|'])
    expect(stderr).toContain('without writing mikoshi.md')
  })

  it('stops on Ctrl+C and starts nothing, even though the interrupted session wrote mikoshi.md', async () => {
    const dir = home(['hang', 'write 0'])
    const loop = startLoop(dir)
    await until(() => existsSync(path.join(dir, 'ready')))
    process.kill(-loop.pid, 'SIGINT')
    const { stderr } = await loop.done
    expect(calls(dir)).toEqual(['0|'])
    expect(stderr).toContain('Ctrl+C')
  })
})

describe('runMikoLoop decides from the mtime of mikoshi.md alone', () => {
  it('restarts while each session changed the mtime, and stops on the first that did not', async () => {
    const mtimes = [undefined, 1, 1, 2, 2, 2]
    const prompts: (string | undefined)[] = []
    const code = await runMikoLoop({
      handoffMtime: () => mtimes.shift(),
      session: async (prompt) => {
        prompts.push(prompt)
      },
      interrupted: () => false,
      err: () => {},
    })
    expect(code).toBe(0)
    expect(prompts).toEqual([undefined, CONTINUE_PROMPT, CONTINUE_PROMPT])
  })
})
