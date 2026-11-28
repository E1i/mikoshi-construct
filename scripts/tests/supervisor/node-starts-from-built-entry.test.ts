import type { ChildProcess } from 'node:child_process'
import type { BuildRun } from '../../core/built-entry.js'
import type { DetachedLaunch, Starter } from '../../supervisor/bg.js'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildOf, BUILT_FROM_FILE, CHECKOUT_BUILD_DIR } from '../../core/built-entry.js'
import { openBus } from '../../core/db.js'
import { FACTORY_WORKERS } from '../../core/factory-paths.js'
import { GENERATION_VARIABLE, nodeProcess, UNHANDED } from '../../core/node.js'
import { builtStart, checkoutBuildOf, installedPackage, isRunningCheckout, pnpmBuild, startDetached } from '../../supervisor/bg.js'
import { REVIEW_WORKER_MARKERS, reviewLaunch } from '../../supervisor/composition.js'
import { recordProcessHeartbeat } from '../../supervisor/heartbeat.js'
import { recordedWorker } from '../../supervisor/recorded-worker.js'
import { builtStarts } from '../../supervisor/supervisor.js'
import { workerLaunches } from '../../supervisor/workers.js'

const HEAD = 'c'.repeat(40)
const NEXT_HEAD = 'd'.repeat(40)
const PROBE_VARIABLE = 'NODE_START_PROBE'
const BUILT_ANSWER = path.join(CHECKOUT_BUILD_DIR, FACTORY_WORKERS.answer.replace(/\.ts$/, '.js'))
const PROBE = [
  `const fs = require('node:fs')`,
  `const out = process.env.${PROBE_VARIABLE}`,
  `fs.writeFileSync(out + '.part', JSON.stringify({ execArgv: process.execArgv, entry: process.argv[1] }))`,
  `fs.renameSync(out + '.part', out)`,
  '',
].join('\n')

const roots: string[] = []
const spawned = vi.hoisted((): ChildProcess[] => [])

vi.mock('node:child_process', async (actual) => {
  const real = await actual<typeof import('node:child_process')>()
  return {
    ...real,
    spawn: (...args: Parameters<typeof real.spawn>) => {
      const child = real.spawn(...args)
      spawned.push(child)
      return child
    },
  }
})

afterEach(() => {
  spawned.splice(0)
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function scratchCheckout(): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'node-built-entry-')))
  roots.push(root)
  mkdirSync(path.join(root, '.git'))
  mkdirSync(path.join(root, 'bin'))
  writeFileSync(path.join(root, 'bin', 'nohup'), '#!/bin/sh\nexec "$@"\n', { mode: 0o755 })
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { 'bus:answer': `node --import tsx ${FACTORY_WORKERS.answer}` } }))
  return root
}

function countedBuild(): { run: BuildRun, runs: string[] } {
  const runs: string[] = []
  const run: BuildRun = (root) => {
    runs.push(root)
    mkdirSync(path.dirname(path.join(root, BUILT_ANSWER)), { recursive: true })
    writeFileSync(path.join(root, BUILT_ANSWER), PROBE)
    return { ok: true, output: '' }
  }
  return { run, runs }
}

interface Probe { execArgv: string[], entry: string }

async function probed(file: string, log: string): Promise<Probe> {
  const child = spawned.at(-1)
  expect(child, 'startDetached spawned no process').toBeDefined()
  if (child!.exitCode === null && child!.signalCode === null)
    await once(child!, 'exit')
  expect(existsSync(file), `the started node wrote no probe; its log: ${existsSync(log) ? readFileSync(log, 'utf8') : 'none'}`).toBe(true)
  return JSON.parse(readFileSync(file, 'utf8')) as Probe
}

function answerLaunch(): DetachedLaunch {
  return workerLaunches(reviewLaunch(() => [])).answer!
}

describe('a bus node starts from the built entry of its checkout', () => {
  it('builds the checkout once for its head and starts the node as node on the built file, with no --import tsx', async () => {
    const root = scratchCheckout()
    const busDir = path.join(root, 'bus')
    const { run, runs } = countedBuild()
    const inCheckout: Starter = (launch, dir, env, processes) => startDetached(launch, dir, env, processes, { checkout: root })
    const start = builtStart(inCheckout, checkoutBuildOf(root, null, run))
    const probe = path.join(root, 'probe.json')

    const env = { ...process.env, PATH: `${path.join(root, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`, [GENERATION_VARIABLE]: HEAD, [PROBE_VARIABLE]: probe }
    const started = start(answerLaunch(), busDir, env, () => [])

    expect(started.exitCode).toBe(0)
    expect(started.stdout.join('\n')).toContain(`built the factory once for ${HEAD}`)
    expect(readFileSync(path.join(root, CHECKOUT_BUILD_DIR, BUILT_FROM_FILE), 'utf8').trim()).toBe(HEAD)
    const log = path.join(busDir, answerLaunch().log)
    const seen = await probed(probe, log)
    expect(seen.entry).toBe(path.join(root, BUILT_ANSWER))
    expect(seen.execArgv.join(' ')).not.toContain('tsx')
    expect(seen.execArgv).not.toContain('--import')

    rmSync(probe)
    start(answerLaunch(), busDir, env, () => [])
    expect((await probed(probe, log)).entry).toBe(path.join(root, BUILT_ANSWER))
    expect(runs).toEqual([root])
  })

  it('a build stamped for another head is not run: the next head builds again', () => {
    const root = scratchCheckout()
    const { run, runs } = countedBuild()
    const build = checkoutBuildOf(root, null, run)!
    build.ensure(HEAD)
    expect(buildOf(root, HEAD)).toBe(root)
    expect(buildOf(root, NEXT_HEAD)).toBeNull()
    build.ensure(NEXT_HEAD)
    expect(buildOf(root, NEXT_HEAD)).toBe(root)
    expect(runs).toEqual([root, root])
  })

  it('an unhanded generation and an installed package build nothing', () => {
    const root = scratchCheckout()
    const { run, runs } = countedBuild()
    const passed: string[] = []
    const start = builtStart(() => {
      passed.push('started')
      return { stdout: [], stderr: [], exitCode: 0 }
    }, checkoutBuildOf(root, null, run))
    start(answerLaunch(), root, { [GENERATION_VARIABLE]: UNHANDED }, () => [])
    expect(runs).toEqual([])
    expect(passed).toEqual(['started'])
    expect(checkoutBuildOf(root, '/installed/', run)).toBeNull()
  })

  it('a failed build is reported once per head, and the node starts from its sources', () => {
    const root = scratchCheckout()
    let builds = 0
    const build = checkoutBuildOf(root, null, () => {
      builds += 1
      return { ok: false, output: 'esbuild: error\n' }
    })!
    expect(build.ensure(HEAD).join('\n')).toContain(`the factory build of ${HEAD} failed`)
    expect(build.ensure(HEAD)).toEqual([])
    expect(builds).toBe(1)
    expect(buildOf(root, HEAD)).toBeNull()
  })

  it('a built module inside the checkout it runs in is not an installed package, so its generation stays the checkout head', () => {
    const root = scratchCheckout()
    const builtModule = `file://${path.join(root, CHECKOUT_BUILD_DIR, 'scripts', 'supervisor', 'bg.js')}`
    expect(isRunningCheckout(root, root)).toBe(true)
    expect(installedPackage(builtModule, built => isRunningCheckout(built, root))).toBeNull()
    expect(installedPackage(builtModule, () => false)).toBe(`${root}/`)
    expect(isRunningCheckout(root, tmpdir())).toBe(false)
  })

  it('a built package run from its own root with no .git is an installed package, not a checkout', () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'node-built-package-')))
    roots.push(root)
    const builtModule = `file://${path.join(root, CHECKOUT_BUILD_DIR, 'scripts', 'supervisor', 'bg.js')}`
    expect(isRunningCheckout(root, root)).toBe(false)
    expect(installedPackage(builtModule, built => isRunningCheckout(built, root))).toBe(`${root}/`)
  })

  it('the build runner reports a failed pnpm build as failed and a passing one as built', () => {
    const failing = scratchCheckout()
    writeFileSync(path.join(failing, 'package.json'), JSON.stringify({ scripts: { build: 'exit 3' } }))
    expect(pnpmBuild(failing).ok).toBe(false)
    expect(buildOf(failing, HEAD)).toBeNull()
    const passing = scratchCheckout()
    writeFileSync(path.join(passing, 'package.json'), JSON.stringify({ scripts: { build: 'exit 0' } }))
    expect(pnpmBuild(passing).ok).toBe(true)
  })

  it('the supervisor starts its nodes, relaunches itself and bus:bg starts its processes through the checkout build', () => {
    const root = scratchCheckout()
    const { run, runs } = countedBuild()
    const starts = builtStarts(checkoutBuildOf(root, null, run))
    const refused: DetachedLaunch = { ...answerLaunch(), preflight: () => ['refused before any spawn'] }
    const env = { [GENERATION_VARIABLE]: HEAD }

    const node = starts.node(refused, path.join(root, 'bus'), env, () => [])
    expect(node.stdout.join('\n')).toContain(`built the factory once for ${HEAD}`)
    expect(node.stderr.join('\n')).toContain('refused before any spawn')
    expect(buildOf(root, HEAD)).toBe(root)

    const supervisor = starts.supervisor(refused, path.join(root, 'bus'), { [GENERATION_VARIABLE]: NEXT_HEAD }, () => [])
    expect(supervisor.stdout.join('\n')).toContain(`built the factory once for ${NEXT_HEAD}`)
    expect(runs).toEqual([root, root])
    expect(spawned).toEqual([])
  })

  it('a recorded review worker running from its built dist entry is found as that worker', () => {
    const root = scratchCheckout()
    const busPath = path.join(root, 'bus.db')
    const db = openBus(busPath)
    const nowMs = Date.parse('2026-11-28T08:00:00Z')
    recordProcessHeartbeat(db, new Date(nowMs).toISOString(), nodeProcess('review'))
    db.close()
    const file = path.join(root, 'review.pid')
    const pid = process.pid + 100_000
    writeFileSync(file, `${pid}\n`)
    const listed = { pid, args: `node ${path.join(root, CHECKOUT_BUILD_DIR, FACTORY_WORKERS.review.replace(/\.ts$/, '.js'))} --on` }
    expect(recordedWorker({ file, node: nodeProcess('review'), markers: REVIEW_WORKER_MARKERS, bus: busPath }, () => [listed], () => true, nowMs)).toEqual(listed)
  })
})
