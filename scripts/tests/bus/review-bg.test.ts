import type { ProcessList } from '../../bus/bg.js'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { psList, runningBus, runningInstance, startDetached } from '../../bus/bg.js'
import { openBus } from '../../bus/db.js'
import { busShadowProblems, PREFIX, REVIEW_INSTANCE_FILE, REVIEW_LOG, REVIEW_START_LOCK, REVIEW_WORKER_MARKERS, reviewLaunch } from '../../bus/review-bg.js'
import { FakeGitHub } from './github-fake.js'

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
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'bus-review-bg-')))
  roots.push(root)
  const bin = path.join(root, 'bin')
  const out = path.join(root, 'out')
  mkdirSync(bin)
  mkdirSync(out)
  linkFromSystem(bin, 'ps')
  linkFromSystem(bin, 'sleep')
  stub(bin, 'nohup', 'exec "$@"')
  stub(bin, 'pnpm', `echo "review worker output"\nprintf '%s\\n' "$*" > "$STUB_OUT/pnpm.argv"\necho $$ > "$STUB_OUT/pid"\nsleep 30`)
  const env = { PATH: bin, STUB_OUT: out }
  return { busDir: path.join(root, 'bus'), out, env, processes: () => psList(env)().filter(candidate => candidate.args.includes(bin)) }
}

const clean = (): string[] => []

async function settled(file: string): Promise<string> {
  for (let attempt = 0; attempt < 200 && !existsSync(file); attempt++)
    await new Promise(resolve => setTimeout(resolve, 25))
  return readFileSync(file, 'utf8').trim()
}

function deadPid(): number {
  return spawnSync('/usr/bin/true').pid!
}

function argsOf(pid: number): string {
  return execFileSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' })
}

describe('pnpm bus:review:bg', () => {
  it('bus:review:bg returns at once with the pid and the log path', async () => {
    const w = world()
    const before = Date.now()
    const result = startDetached(reviewLaunch(clean), w.busDir, w.env, w.processes)
    expect(Date.now() - before).toBeLessThan(5000)
    expect(result.exitCode).toBe(0)
    started.push(Number(result.stdout[0]))
    const log = path.join(w.busDir, REVIEW_LOG)
    expect(result.stdout[0]).toBe(await settled(path.join(w.out, 'pid')))
    expect(result.stdout[1]).toContain(`log ${log}`)
    expect(readFileSync(path.join(w.busDir, REVIEW_INSTANCE_FILE), 'utf8').trim()).toBe(result.stdout[0])
    expect(await settled(path.join(w.out, 'pnpm.argv'))).toBe('--silent bus:review --on')
    expect(argsOf(Number(result.stdout[0]))).toContain('bus:review --on')
    for (let attempt = 0; attempt < 200 && !readFileSync(log, 'utf8').includes('review worker output'); attempt++)
      await new Promise(resolve => setTimeout(resolve, 25))
    expect(readFileSync(log, 'utf8')).toContain('review worker output')
    expect(existsSync(path.join(w.busDir, REVIEW_START_LOCK))).toBe(false)
  })

  it('a second start while the review worker is alive is refused and names its pid', async () => {
    const w = world()
    const first = startDetached(reviewLaunch(clean), w.busDir, w.env, w.processes)
    expect(first.exitCode).toBe(0)
    const pid = first.stdout[0]!
    started.push(Number(pid))
    await settled(path.join(w.out, 'pid'))
    rmSync(path.join(w.out, 'pid'))
    const second = startDetached(reviewLaunch(clean), w.busDir, w.env, w.processes)
    expect(second.exitCode).toBe(1)
    expect(second.stdout).toEqual([])
    expect(second.stderr.join('\n')).toContain(`pid ${pid}`)
    expect(readFileSync(path.join(w.busDir, REVIEW_INSTANCE_FILE), 'utf8').trim()).toBe(pid)
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(existsSync(path.join(w.out, 'pid'))).toBe(false)

    const byHand: ProcessList = () => [{ pid: 4343, args: 'node /x/node_modules/tsx/dist/cli.mjs scripts/bus/review-worker.ts --on' }]
    const third = startDetached(reviewLaunch(clean), w.busDir, w.env, byHand)
    expect(third.exitCode).toBe(1)
    expect(third.stderr.join('\n')).toContain('pid 4343')
  })

  it('an unclean shadow is refused before anything starts', async () => {
    const w = world()
    const problems = ['prs vs GitHub: #947 open on GitHub, missing here', 'replay byte-diff: differs']
    const result = startDetached(reviewLaunch(() => problems), w.busDir, w.env, w.processes)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toEqual([])
    for (const problem of problems)
      expect(result.stderr.join('\n')).toContain(problem)
    expect(existsSync(path.join(w.busDir, REVIEW_INSTANCE_FILE))).toBe(false)
    expect(existsSync(path.join(w.busDir, REVIEW_START_LOCK))).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(existsSync(path.join(w.out, 'pid'))).toBe(false)
  })

  it('a dead recorded pid and a dead start lock are taken over', async () => {
    const w = world()
    mkdirSync(w.busDir, { recursive: true })
    writeFileSync(path.join(w.busDir, REVIEW_START_LOCK), `${deadPid()}\n`)
    writeFileSync(path.join(w.busDir, REVIEW_INSTANCE_FILE), `${deadPid()}\n`)
    const result = startDetached(reviewLaunch(clean), w.busDir, w.env, w.processes)
    expect(result.exitCode).toBe(0)
    started.push(Number(result.stdout[0]))
    expect(result.stdout[0]).toBe(await settled(path.join(w.out, 'pid')))
    expect(readFileSync(path.join(w.busDir, REVIEW_INSTANCE_FILE), 'utf8').trim()).toBe(result.stdout[0])
    expect(existsSync(path.join(w.busDir, REVIEW_START_LOCK))).toBe(false)
  })

  it('a running dry run is not taken for the review worker', async () => {
    const w = world()
    const dryRuns = [
      { pid: 4444, args: 'node /x/node_modules/tsx/dist/cli.mjs scripts/bus/review-worker.ts --dry-run 717' },
      { pid: 4445, args: 'node pnpm.cjs --silent bus:review --dry-run 717' },
    ]
    expect(runningInstance(dryRuns, REVIEW_WORKER_MARKERS)).toBeUndefined()
    const result = startDetached(reviewLaunch(clean), w.busDir, w.env, () => dryRuns)
    expect(result.exitCode).toBe(0)
    started.push(Number(result.stdout[0]))
    expect(result.stdout[0]).toBe(await settled(path.join(w.out, 'pid')))

    const worker = { pid: 4343, args: 'node /x/node_modules/tsx/dist/cli.mjs scripts/bus/review-worker.ts --on' }
    const refused = startDetached(reviewLaunch(clean), w.busDir, w.env, () => [...dryRuns, worker])
    expect(refused.exitCode).toBe(1)
    expect(refused.stderr.join('\n')).toContain('pid 4343')
  })

  it('a missing bus.db or a GitHub error in the preflight is a prefixed refusal', async () => {
    const w = world()
    const gitHub = new FakeGitHub()
    const busPath = path.join(w.busDir, 'bus.db')
    const launch = reviewLaunch(() => busShadowProblems(busPath, gitHub.client))

    const missing = startDetached(launch, w.busDir, w.env, w.processes)
    expect(missing.exitCode).toBe(1)
    expect(missing.stdout).toEqual([])
    expect(missing.stderr[0]!.startsWith(PREFIX)).toBe(true)
    expect(missing.stderr.join('\n')).toContain(busPath)
    expect(existsSync(busPath)).toBe(false)

    openBus(busPath).close()
    gitHub.failing = true
    const failing = startDetached(launch, w.busDir, w.env, w.processes)
    expect(failing.exitCode).toBe(1)
    expect(failing.stdout).toEqual([])
    expect(failing.stderr[0]!.startsWith(PREFIX)).toBe(true)
    expect(failing.stderr.join('\n')).toContain('gh api: connection refused')
    expect(existsSync(path.join(w.busDir, REVIEW_INSTANCE_FILE))).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(existsSync(path.join(w.out, 'pid'))).toBe(false)
  })

  it('the review worker and bus:run are told apart by their markers', () => {
    const review = { pid: 21, args: 'node pnpm.cjs --silent bus:review --on' }
    const run = { pid: 22, args: 'node pnpm.cjs --silent bus:run' }
    expect(runningInstance([run, review], REVIEW_WORKER_MARKERS)?.pid).toBe(21)
    expect(runningBus([review])).toBeUndefined()
    expect(runningInstance([{ pid: 23, args: 'rg bus:review scripts' }], REVIEW_WORKER_MARKERS)).toBeUndefined()
  })
})
