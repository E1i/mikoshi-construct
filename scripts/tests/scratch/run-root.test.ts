import type { ChildProcess } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { reapOrphanRoots, RUN_ROOT_PREFIX, RUN_ROOT_VARIABLE, RunRoot, RunRootTooLong, scratchDir, SOCKET_NAME_RESERVE_BYTES, UNIX_SOCKET_PATH_BYTES } from '../../scratch/run-root.js'
import { inRunRoot, survivedTheRun } from '../../scratch/run.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const TSX = path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs')
const RUN = path.join(REPO_ROOT, 'scripts/scratch/run.ts')
const RUN_ROOT_MODULE = path.join(REPO_ROOT, 'scripts/scratch/run-root.ts')
const NO_PROCESS = 2 ** 22 + 1

const vitestRoot = (): string => process.env[RUN_ROOT_VARIABLE]!
const systemTmpdir = (): string => path.dirname(vitestRoot())
const rootsOf = (pid: number | undefined): string[] => readdirSync(systemTmpdir()).filter(name => name.startsWith(`${RUN_ROOT_PREFIX}${pid}-`))

function outsideEveryRunRoot(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: systemTmpdir() }
  delete env[RUN_ROOT_VARIABLE]
  return env
}

const LAZY_OWNER = `
import { scratchDir } from ${JSON.stringify(RUN_ROOT_MODULE)}
scratchDir('lazy-owner-')
process.stdout.write(String(process.pid) + '\\n')
if (process.argv.includes('wait')) setInterval(() => {}, 1000)
`

function startLazyOwner(mode: 'exit' | 'wait'): ChildProcess {
  return spawn(process.execPath, [TSX, '--eval', LAZY_OWNER, mode], { env: outsideEveryRunRoot(), stdio: ['ignore', 'pipe', 'inherit'] })
}

function ownerPid(child: ChildProcess): Promise<number> {
  return new Promise(resolve => child.stdout!.once('data', data => resolve(Number(String(data).trim()))))
}

function ended(child: ChildProcess): Promise<void> {
  return new Promise(resolve => child.once('exit', () => resolve()))
}

const owners: number[] = []
afterEach(() => {
  for (const pid of owners.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL')
    }
    catch {}
  }
  reapOrphanRoots(systemTmpdir())
})

describe('a run root', () => {
  it('holds TMPDIR while open and leaves nothing and the previous environment once closed', () => {
    const outer = systemTmpdir()
    const env: NodeJS.ProcessEnv = { TMPDIR: outer }
    const root = RunRoot.open({ outer, env })
    mkdirSync(path.join(root.path, 'left-by-a-test', 'nested'), { recursive: true })

    expect(path.basename(root.path)).toMatch(new RegExp(`^${RUN_ROOT_PREFIX}${process.pid}-[A-Za-z0-9]{6}$`))
    expect(env).toEqual({ TMPDIR: root.path, [RUN_ROOT_VARIABLE]: root.path })
    expect(root.close()).toBe(true)
    expect(existsSync(root.path)).toBe(false)
    expect(env).toEqual({ TMPDIR: outer })
  })

  it('sits directly in TMPDIR with room left for a socket name under the Unix socket path limit', () => {
    expect(Buffer.byteLength(vitestRoot()) + SOCKET_NAME_RESERVE_BYTES).toBeLessThanOrEqual(UNIX_SOCKET_PATH_BYTES)
    expect(path.basename(vitestRoot())).toMatch(new RegExp(`^${RUN_ROOT_PREFIX}\\d+-[A-Za-z0-9]{6}$`))
  })

  it('refuses at once, creating nothing, a root whose path leaves no room for a socket name', () => {
    const deep = path.join(scratchDir('d-'), 'x'.repeat(UNIX_SOCKET_PATH_BYTES))
    mkdirSync(deep)
    expect(() => RunRoot.open({ outer: deep, env: {} })).toThrow(RunRootTooLong)
    expect(() => RunRoot.open({ outer: deep, env: {} })).toThrow(/Unix socket path limit/)
    expect(readdirSync(deep)).toEqual([])
  })

  it('reaps the roots of dead owners and keeps live roots and foreign entries', () => {
    const outer = scratchDir('r-')
    mkdirSync(path.join(outer, `${RUN_ROOT_PREFIX}${NO_PROCESS}-abc123`, 'deep'), { recursive: true })
    mkdirSync(path.join(outer, `${RUN_ROOT_PREFIX}${process.pid}-def456`))
    mkdirSync(path.join(outer, `${RUN_ROOT_PREFIX}${NO_PROCESS}-not-a-mkdtemp-suffix`))
    writeFileSync(path.join(outer, 'foreign-file'), '')

    expect(reapOrphanRoots(outer)).toEqual([`${RUN_ROOT_PREFIX}${NO_PROCESS}-abc123`])
    expect(readdirSync(outer).sort()).toEqual([`${RUN_ROOT_PREFIX}${NO_PROCESS}-not-a-mkdtemp-suffix`, `${RUN_ROOT_PREFIX}${process.pid}-def456`, 'foreign-file'].sort())
  })

  it('puts a scratch directory directly inside the root vitest opened', () => {
    expect(path.dirname(scratchDir('inside-'))).toBe(vitestRoot())
  })
})

describe('a process that opened its own root', () => {
  it('removes it on a normal exit', async () => {
    const child = startLazyOwner('exit')
    const owner = await ownerPid(child)
    await ended(child)
    expect(rootsOf(owner)).toEqual([])
  })

  it.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)('removes it on %s', async (signal) => {
    const child = startLazyOwner('wait')
    const owner = await ownerPid(child)
    owners.push(owner)
    expect(rootsOf(owner)).toHaveLength(1)
    process.kill(owner, signal)
    await ended(child)
    expect(rootsOf(owner)).toEqual([])
  })

  it('leaves it on SIGKILL, and the next root opened beside it reaps it', async () => {
    const child = startLazyOwner('wait')
    const owner = await ownerPid(child)
    process.kill(owner, 'SIGKILL')
    await ended(child)
    expect(rootsOf(owner)).toHaveLength(1)

    RunRoot.open({ env: {}, outer: systemTmpdir() }).close()
    expect(rootsOf(owner)).toEqual([])
  })
})

describe('run.ts, the root quality runs in', () => {
  const run = (...argv: string[]): ReturnType<typeof spawnSync> =>
    spawnSync(process.execPath, [TSX, RUN, 'sh', '-c', ...argv], { env: outsideEveryRunRoot(), encoding: 'utf8' })
  const rootIn = (stdout: unknown): string => String(stdout).trim().split('\n').at(-1)!

  it('passes and leaves nothing when the command creates temp directories inside the root', () => {
    const result = run('mktemp -d >/dev/null && mkdir "$TMPDIR/left-behind" && test "$TMPDIR" = "$CONSTRUCT_RUN_ROOT" && echo "$TMPDIR"')
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(path.dirname(rootIn(result.stdout))).toBe(systemTmpdir())
    expect(existsSync(rootIn(result.stdout))).toBe(false)
  })

  it('keeps the exit code of a failing command and still removes the root', () => {
    const result = run('mktemp -d >/dev/null; echo "$TMPDIR"; exit 3')
    expect(result.status).toBe(3)
    expect(existsSync(rootIn(result.stdout))).toBe(false)
  })

  it('goes red when a process the run left behind keeps the root alive after the run', () => {
    const pidFile = path.join(scratchDir('leak-'), 'pid')
    const result = run('(while :; do mkdir -p "$TMPDIR/written-after-the-run"; sleep 0.05; done) </dev/null >/dev/null 2>&1 & echo $! > "$0"; echo "$TMPDIR"; exit 0', pidFile)
    const leaker = Number(readFileSync(pidFile, 'utf8'))
    expect(leaker).toBeGreaterThan(1)
    process.kill(leaker, 'SIGKILL')

    expect(result.status).toBe(1)
    expect(result.stderr).toContain(survivedTheRun(rootIn(result.stdout)))
  })
})

describe('inRunRoot', () => {
  it('turns a green run red when the root is still there after it settles', async () => {
    const lines: string[] = []
    const root = { path: '/nowhere/mkr-1-abcdef', close: () => false, exists: () => true }
    expect(await inRunRoot([], async () => 0, line => lines.push(line), root, 0)).toBe(1)
    expect(lines).toEqual([survivedTheRun(root.path)])
  })

  it('keeps a red exit code red and says nothing when the root is gone', async () => {
    const lines: string[] = []
    const root = { path: '/nowhere/mkr-1-abcdef', close: () => true, exists: () => false }
    expect(await inRunRoot([], async () => 4, line => lines.push(line), root, 0)).toBe(4)
    expect(lines).toEqual([])
  })
})
