import type { ChildProcess } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { reapOrphanRoots, reapVitestLeftovers, RUN_ROOT_PREFIX, RUN_ROOT_VARIABLE, RunRoot, RunRootTooLong, scratchDir, SOCKET_NAME_RESERVE_BYTES, UNIX_SOCKET_PATH_BYTES, VITEST_LEFTOVER_AGE_MS, VITEST_TMP_DIR_NAME } from '../../scratch/run-root.js'
import { inOwnOrInheritedRoot, inRunRoot, survivedTheRun } from '../../scratch/run.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const TSX = path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs')
const RUN = path.join(REPO_ROOT, 'scripts/scratch/run.ts')
const RUN_ROOT_MODULE = path.join(REPO_ROOT, 'scripts/scratch/run-root.ts')
const VITEST = path.join(REPO_ROOT, 'node_modules/vitest/vitest.mjs')
const VITEST_SETUP = path.join(REPO_ROOT, 'scripts/scratch/vitest-setup.ts')
const NO_PROCESS = 2 ** 22 + 1

const vitestRoot = (): string => process.env[RUN_ROOT_VARIABLE]!
const systemTmpdir = (): string => path.dirname(vitestRoot())
const rootsOf = (pid: number | undefined): string[] => readdirSync(systemTmpdir()).filter(name => name.startsWith(`${RUN_ROOT_PREFIX}${pid}-`))

const PACKAGE_SCRIPTS = (JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts

function inOwnTmpdir<T>(run: (outer: string) => T): T {
  const outer = mkdtempSync(path.join(systemTmpdir(), 'vt-'))
  try {
    return run(outer)
  }
  finally {
    rmSync(outer, { recursive: true, force: true })
  }
}

function outsideEveryRunRootIn(outer: string): NodeJS.ProcessEnv {
  return { ...outsideEveryRunRoot(), TMPDIR: outer }
}

const vitestDirsIn = (outer: string): string[] => readdirSync(outer).filter(name => VITEST_TMP_DIR_NAME.test(name))

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
  return spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', LAZY_OWNER, mode], { cwd: REPO_ROOT, env: outsideEveryRunRoot(), stdio: ['ignore', 'pipe', 'inherit'] })
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

  it('is the temp directory every test sees, so a test mkdtemp under tmpdir() dies with the run', () => {
    expect(os.tmpdir()).toBe(vitestRoot())
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

const HUNG_TEST = `
import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
it('hangs past its timeout with its worker kept busy', async () => {
  writeFileSync(process.env.ROOT_SEEN_AT, process.env.${RUN_ROOT_VARIABLE})
  mkdtempSync(path.join(os.tmpdir(), 'left-by-a-hung-test-'))
  setInterval(() => {}, 1000)
  await new Promise(() => {})
})
`

describe('the root vitest runs in', () => {
  it('is gone from the outer TMPDIR after a test timeout leaves its worker to be killed', () => {
    const project = scratchDir('hung-')
    const rootSeenAt = path.join(project, 'root')
    writeFileSync(path.join(project, 'hung.test.mjs'), HUNG_TEST)
    writeFileSync(path.join(project, 'vitest.config.mjs'), `export default ${JSON.stringify({ test: { globals: true, include: ['hung.test.mjs'], globalSetup: [VITEST_SETUP], testTimeout: 300, pool: 'forks' } })}\n`)

    inOwnTmpdir((outer) => {
      const result = spawnSync(process.execPath, [VITEST, 'run', '--root', project, '--config', path.join(project, 'vitest.config.mjs')], { env: { ...outsideEveryRunRootIn(outer), ROOT_SEEN_AT: rootSeenAt }, encoding: 'utf8' })
      const root = readFileSync(rootSeenAt, 'utf8')

      expect(`${result.stdout}${result.stderr}`).toMatch(/timed out/i)
      expect(result.status).not.toBe(0)
      expect(path.dirname(root)).toBe(outer)
      expect(existsSync(root)).toBe(false)
      expect(readdirSync(outer).filter(name => name.startsWith(`${RUN_ROOT_PREFIX}${result.pid}-`))).toEqual([])
    })
  })
})

const PASSING_TEST = `it('passes', () => {})\n`

describe('pnpm test', () => {
  it('runs vitest through run.ts, in watch mode too', () => {
    expect(PACKAGE_SCRIPTS.test).toBe('tsx scripts/scratch/run.ts vitest run')
    expect(PACKAGE_SCRIPTS['test:watch']).toBe('tsx scripts/scratch/run.ts vitest')
  })

  it('leaves no Vitest temp dir in a fresh outer TMPDIR when vitest runs through run.ts', () => {
    const project = scratchDir('pass-')
    writeFileSync(path.join(project, 'ok.test.mjs'), PASSING_TEST)
    writeFileSync(path.join(project, 'vitest.config.mjs'), `export default ${JSON.stringify({ test: { globals: true, include: ['ok.test.mjs'] } })}\n`)

    inOwnTmpdir((outer) => {
      const result = spawnSync(process.execPath, [TSX, RUN, process.execPath, VITEST, 'run', '--root', project, '--config', path.join(project, 'vitest.config.mjs')], { env: outsideEveryRunRootIn(outer), encoding: 'utf8' })

      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0)
      expect(vitestDirsIn(outer)).toEqual([])
    })
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

const NOW_MS = Date.parse('2026-10-12T12:00:00Z')
const STALE_MS = NOW_MS - VITEST_LEFTOVER_AGE_MS - 60_000
const FRESH_MS = NOW_MS - 60_000

interface TmpEntry { children: string[], writtenMs: number, reaped: boolean }

const TMP_ENTRIES: Record<string, TmpEntry> = {
  'stale-ssr0aaaaaaaaaaa': { children: ['ssr'], writtenMs: STALE_MS, reaped: true },
  'stale_both-aaaaaaaaaa': { children: ['ssr', 'client'], writtenMs: STALE_MS, reaped: true },
  'fresh-ssr0aaaaaaaaaaa': { children: ['ssr'], writtenMs: FRESH_MS, reaped: false },
  'foreign-child-aaaaaaa': { children: ['ssr', 'repo'], writtenMs: STALE_MS, reaped: false },
  'empty-dir0aaaaaaaaaaa': { children: [], writtenMs: STALE_MS, reaped: false },
  'not-twenty-one-chars-ssr': { children: ['ssr'], writtenMs: STALE_MS, reaped: false },
  'construct-attach-Ab12Cd': { children: ['ssr'], writtenMs: STALE_MS, reaped: false },
}

function plantTmpEntry(outer: string, name: string, entry: TmpEntry): void {
  const dir = path.join(outer, name)
  mkdirSync(dir)
  for (const child of entry.children) {
    mkdirSync(path.join(dir, child))
    writeFileSync(path.join(dir, child, 'a1b2c3'), 'export {}')
    utimesSync(path.join(dir, child), entry.writtenMs / 1000, entry.writtenMs / 1000)
  }
  utimesSync(dir, entry.writtenMs / 1000, entry.writtenMs / 1000)
}

describe('opening a root', () => {
  it('reaps a stale Vitest temp dir in the outer TMPDIR and keeps a fresh one', () => {
    inOwnTmpdir((outer) => {
      plantTmpEntry(outer, 'stale-ssr0aaaaaaaaaaa', { children: ['ssr'], writtenMs: Date.now() - VITEST_LEFTOVER_AGE_MS - 60_000, reaped: true })
      plantTmpEntry(outer, 'fresh-ssr0aaaaaaaaaaa', { children: ['ssr'], writtenMs: Date.now() - 60_000, reaped: false })

      RunRoot.open({ outer, env: {} }).close()

      expect(readdirSync(outer)).toEqual(['fresh-ssr0aaaaaaaaaaa'])
    })
  })
})

describe('reapVitestLeftovers', () => {
  it('removes only the Vitest temp dirs untouched for longer than the leftover age', () => {
    const outer = scratchDir('vitest-leftovers-')
    for (const [name, entry] of Object.entries(TMP_ENTRIES))
      plantTmpEntry(outer, name, entry)

    const reaped = Object.entries(TMP_ENTRIES).filter(([, entry]) => entry.reaped).map(([name]) => name)
    expect(reapVitestLeftovers(outer, NOW_MS).sort()).toEqual(reaped.sort())
    expect(readdirSync(outer).sort()).toEqual(Object.keys(TMP_ENTRIES).filter(name => !reaped.includes(name)).sort())
  })

  it('treats a file with a Vitest-shaped name as no leftover', () => {
    const outer = scratchDir('vitest-leftovers-file-')
    writeFileSync(path.join(outer, 'a-file-not-a-dir00000'), '')
    expect(reapVitestLeftovers(outer, NOW_MS)).toEqual([])
  })
})

describe('inOwnOrInheritedRoot', () => {
  it('runs inside the inherited root without opening a second one', async () => {
    const before = rootsOf(process.pid)
    const seen: string[] = []
    const env: NodeJS.ProcessEnv = { [RUN_ROOT_VARIABLE]: vitestRoot() }
    expect(await inOwnOrInheritedRoot(['x'], async (_argv, runEnv) => {
      seen.push(runEnv[RUN_ROOT_VARIABLE]!)
      return 3
    }, () => {}, env)).toBe(3)
    expect(seen).toEqual([vitestRoot()])
    expect(rootsOf(process.pid)).toEqual(before)
  })
})
