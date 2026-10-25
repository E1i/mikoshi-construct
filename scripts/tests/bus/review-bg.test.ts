import type { ProcessList } from '../../supervisor/bg.js'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { psList, runningBus, runningInstance, startDetached } from '../../supervisor/bg.js'
import { openBus } from '../../core/db.js'
import { NetWatch } from '../../ports/netwatch.js'
import { busShadowProblems, PREFIX, REVIEW_INSTANCE_FILE, REVIEW_LOG, REVIEW_START_LOCK, REVIEW_WORKER_MARKERS, reviewLaunch, startReviewWorker } from '../../supervisor/review-bg.js'
import { BusTick } from '../../supervisor/run.js'
import { settled } from '../shift/fixtures/settled.js'
import { waitFor } from '../wait-for.js'
import { Clock, FakeGitHub, sha } from './github-fake.js'

const ARRIVAL_GUARD_MS = 25_000

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

const WORKER_STUB = `echo "review worker output"\nprintf '%s\\n' "$*" > "$STUB_OUT/pnpm.argv"\necho $$ > "$STUB_OUT/pid"\nsleep 30`
const SILENT_STUB = `echo "stub stderr before any pid" >&2\nsleep 30`
const SHORT_SETTLE_MS = 300

function world(pnpm = WORKER_STUB): World {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'bus-review-bg-')))
  roots.push(root)
  const bin = path.join(root, 'bin')
  const out = path.join(root, 'out')
  mkdirSync(bin)
  mkdirSync(out)
  linkFromSystem(bin, 'ps')
  linkFromSystem(bin, 'sleep')
  stub(bin, 'nohup', 'exec "$@"')
  stub(bin, 'pnpm', pnpm)
  const env = { PATH: bin, STUB_OUT: out }
  return { busDir: path.join(root, 'bus'), out, env, processes: () => psList(env)().filter(candidate => candidate.args.includes(bin)) }
}

const clean = (): string[] => []

function deadPid(): number {
  return spawnSync('/usr/bin/true').pid!
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch {
    return false
  }
}

function argsOf(pid: number): string {
  return execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' })
}

function stubState(w: World, pid: number): string {
  let running = `the stub process ${pid} is not running`
  if (isAlive(pid)) {
    try {
      running = `the stub process ${pid} is running (${argsOf(pid).trim()})`
    }
    catch {}
  }
  const log = path.join(w.busDir, REVIEW_LOG)
  const output = existsSync(log) ? readFileSync(log, 'utf8').trim() : ''
  return `${running}; its output in ${log}: ${output === '' ? 'empty' : output}`
}

function stubPid(w: World, pid: string | undefined, timeoutMs?: number): Promise<string> {
  return settled(path.join(w.out, 'pid'), timeoutMs, () => stubState(w, Number(pid)))
}

describe('pnpm bus:review:bg', () => {
  it('bus:review:bg returns at once with the pid and the log path', async () => {
    const w = world()
    const result = startDetached(reviewLaunch(clean), w.busDir, w.env, w.processes)
    expect(result.exitCode).toBe(0)
    started.push(Number(result.stdout[0]))
    expect(isAlive(Number(result.stdout[0]))).toBe(true)
    const log = path.join(w.busDir, REVIEW_LOG)
    expect(result.stdout[0]).toBe(await stubPid(w, result.stdout[0]))
    expect(result.stdout[1]).toContain(`log ${log}`)
    expect(readFileSync(path.join(w.busDir, REVIEW_INSTANCE_FILE), 'utf8').trim()).toBe(result.stdout[0])
    expect(await settled(path.join(w.out, 'pnpm.argv'))).toBe('--silent bus:review --on')
    expect(argsOf(Number(result.stdout[0]))).toContain('bus:review --on')
    await waitFor(() => readFileSync(log, 'utf8').includes('review worker output'), () => `"review worker output" in ${log}`, ARRIVAL_GUARD_MS)
    expect(existsSync(path.join(w.busDir, REVIEW_START_LOCK))).toBe(false)
  })

  it('a second start while the review worker is alive is refused and names its pid', async () => {
    const w = world()
    const first = startDetached(reviewLaunch(clean), w.busDir, w.env, w.processes)
    expect(first.exitCode).toBe(0)
    const pid = first.stdout[0]!
    started.push(Number(pid))
    await stubPid(w, pid)
    const second = startDetached(reviewLaunch(clean), w.busDir, w.env, w.processes)
    expect(w.processes().map(candidate => candidate.pid)).toEqual([Number(pid)])
    expect(second.exitCode).toBe(1)
    expect(second.stdout).toEqual([])
    expect(second.stderr.join('\n')).toContain(`pid ${pid}`)
    expect(readFileSync(path.join(w.busDir, REVIEW_INSTANCE_FILE), 'utf8').trim()).toBe(pid)

    const byHand: ProcessList = () => [{ pid: 4343, args: 'node /x/node_modules/tsx/dist/cli.mjs scripts/nodes/review/review-worker.ts --on' }]
    const third = startDetached(reviewLaunch(clean), w.busDir, w.env, byHand)
    expect(third.exitCode).toBe(1)
    expect(third.stderr.join('\n')).toContain('pid 4343')
  })

  it('a second review worker is not started while one runs', async () => {
    const w = world()
    mkdirSync(w.busDir, { recursive: true })
    const survivor = String(process.ppid)
    writeFileSync(path.join(w.busDir, REVIEW_INSTANCE_FILE), `${survivor}\n`)

    const second = startReviewWorker(reviewLaunch(clean), w.busDir, w.env, () => [])
    expect(second.exitCode).toBe(1)
    expect(second.stderr.join('\n')).toContain(`pid ${survivor}`)
    expect(second.alreadyRunning?.pid).toBe(Number(survivor))
    expect(w.processes()).toEqual([])
    expect(readFileSync(path.join(w.busDir, REVIEW_INSTANCE_FILE), 'utf8').trim()).toBe(survivor)

    const reused: ProcessList = () => [{ pid: Number(survivor), args: 'vim notes.md' }]
    const third = startReviewWorker(reviewLaunch(clean), w.busDir, w.env, reused)
    expect(third.exitCode).toBe(0)
    started.push(Number(third.stdout[0]))
  })

  it('an unclean shadow is refused before anything starts', async () => {
    const w = world()
    const problems = ['prs vs GitHub: #947 open on GitHub, missing here', 'replay byte-diff: differs']
    const result = startDetached(reviewLaunch(() => problems), w.busDir, w.env, w.processes)
    expect(w.processes()).toEqual([])
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toEqual([])
    for (const problem of problems)
      expect(result.stderr.join('\n')).toContain(problem)
    expect(existsSync(path.join(w.busDir, REVIEW_INSTANCE_FILE))).toBe(false)
    expect(existsSync(path.join(w.busDir, REVIEW_START_LOCK))).toBe(false)
  })

  it('a dead recorded pid and a dead start lock are taken over', async () => {
    const w = world()
    mkdirSync(w.busDir, { recursive: true })
    writeFileSync(path.join(w.busDir, REVIEW_START_LOCK), `${deadPid()}\n`)
    writeFileSync(path.join(w.busDir, REVIEW_INSTANCE_FILE), `${deadPid()}\n`)
    const result = startDetached(reviewLaunch(clean), w.busDir, w.env, w.processes)
    expect(result.exitCode).toBe(0)
    started.push(Number(result.stdout[0]))
    expect(result.stdout[0]).toBe(await stubPid(w, result.stdout[0]))
    expect(readFileSync(path.join(w.busDir, REVIEW_INSTANCE_FILE), 'utf8').trim()).toBe(result.stdout[0])
    expect(existsSync(path.join(w.busDir, REVIEW_START_LOCK))).toBe(false)
  })

  it('a stub that never writes its pid fails naming the pid file, whether the stub started, and its stderr', async () => {
    const w = world(SILENT_STUB)
    const result = startDetached(reviewLaunch(clean), w.busDir, w.env, w.processes)
    expect(result.exitCode).toBe(0)
    const pid = result.stdout[0]!
    started.push(Number(pid))
    const log = path.join(w.busDir, REVIEW_LOG)
    await waitFor(() => existsSync(log) && readFileSync(log, 'utf8').includes('stub stderr before any pid'), () => `the stub's stderr in ${log}`, ARRIVAL_GUARD_MS)

    const failure = stubPid(w, pid, SHORT_SETTLE_MS)
    await expect(failure).rejects.toThrow(path.join(w.out, 'pid'))
    await expect(failure).rejects.toThrow(`the stub process ${pid} is running`)
    await expect(failure).rejects.toThrow('stub stderr before any pid')
  })

  it('a running dry run is not taken for the review worker', async () => {
    const w = world()
    const dryRuns = [
      { pid: 4444, args: 'node /x/node_modules/tsx/dist/cli.mjs scripts/nodes/review/review-worker.ts --dry-run 717' },
      { pid: 4445, args: 'node pnpm.cjs --silent bus:review --dry-run 717' },
    ]
    expect(runningInstance(dryRuns, REVIEW_WORKER_MARKERS)).toBeUndefined()
    const result = startDetached(reviewLaunch(clean), w.busDir, w.env, () => dryRuns)
    expect(result.exitCode).toBe(0)
    started.push(Number(result.stdout[0]))
    expect(result.stdout[0]).toBe(await stubPid(w, result.stdout[0]))

    const worker = { pid: 4343, args: 'node /x/node_modules/tsx/dist/cli.mjs scripts/nodes/review/review-worker.ts --on' }
    const refused = startDetached(reviewLaunch(clean), w.busDir, w.env, () => [...dryRuns, worker])
    expect(refused.exitCode).toBe(1)
    expect(refused.stderr.join('\n')).toContain('pid 4343')
  })

  it('a missing bus.db in the preflight is a prefixed refusal', async () => {
    const w = world()
    const busPath = path.join(w.busDir, 'bus.db')
    const launch = reviewLaunch(() => busShadowProblems(busPath))

    const missing = startDetached(launch, w.busDir, w.env, w.processes)
    expect(missing.exitCode).toBe(1)
    expect(missing.stdout).toEqual([])
    expect(missing.stderr[0]!.startsWith(PREFIX)).toBe(true)
    expect(missing.stderr.join('\n')).toContain(busPath)
    expect(existsSync(busPath)).toBe(false)
    expect(existsSync(path.join(w.busDir, REVIEW_INSTANCE_FILE))).toBe(false)
  })

  it('the preflight reads the bus alone: GitHub offline and a prs head behind it still start review', async () => {
    const w = world()
    const gitHub = new FakeGitHub()
    const clock = new Clock()
    const busPath = path.join(w.busDir, 'bus.db')
    const db = openBus(busPath)
    gitHub.open({ number: 966 })
    new BusTick(db, new NetWatch(db, gitHub.client, clock.now), clock.now).run()
    db.close()
    gitHub.open({ number: 966, head: sha('c') })
    gitHub.failing = true
    const calls = gitHub.calls.length

    expect(busShadowProblems(busPath)).toEqual([])
    const result = startDetached(reviewLaunch(() => busShadowProblems(busPath)), w.busDir, w.env, w.processes)
    expect(result.exitCode).toBe(0)
    started.push(Number(result.stdout[0]))
    expect(result.stdout[0]).toBe(await stubPid(w, result.stdout[0]))
    expect(gitHub.calls).toHaveLength(calls)
  })

  it('the review worker and bus:run are told apart by their markers', () => {
    const review = { pid: 21, args: 'node pnpm.cjs --silent bus:review --on' }
    const run = { pid: 22, args: 'node pnpm.cjs --silent bus:run' }
    expect(runningInstance([run, review], REVIEW_WORKER_MARKERS)?.pid).toBe(21)
    expect(runningBus([review])).toBeUndefined()
    expect(runningInstance([{ pid: 23, args: 'rg bus:review scripts' }], REVIEW_WORKER_MARKERS)).toBeUndefined()
  })
})
