import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { build } from 'tsup'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { copyFactoryAssets, factoryBuild, OUT_DIR, productBuild } from '../tsup.config.js'

const REPOSITORY = path.resolve(import.meta.dirname, '..')
const PACKAGE_NAME = 'mikoshi-construct'
const PACKED_BESIDE_THE_BUILD = ['package.json', 'README.md', 'LICENSE', 'templates']
const TARBALL_ROOT = 'package'
const PACK_TIMEOUT_MS = 300_000
const BUS_RUN = 'scripts/supervisor/run.ts'
const BOARD_PAGE = 'scripts/cli/board-page.ts'
const BOARD_WINDOW = 'scripts/window/board.ts'
const EVENTS = 'scripts/core/events.ts'
const BOARD_TIMER = 'scripts/cli/board-page/timer.ts'
const BUS_DB = 'bus.db'
const PROJECTED = 'board projected'
const PROJECTIONS_SEEN = 2
const KILLED_THREAD_PERIOD_MS = 500
const KILLED_THREAD_DEADLINE_MS = 30_000
const KILLED_THREAD_SCRIPT = 'kill-the-board-thread.mjs'
const KILLED_BY = 'the board thread was killed by an exception'
const MISSING_FILE = /ENOENT|ERR_MODULE_NOT_FOUND|Cannot find module/

interface Shipped {
  BOARD_DATA_FILE: string
  BOARD_FILE: string
  BOARD_PERIOD_MS: number
  BOARD_THREAD: string
  WORKER_DOWN: string
}

interface Consumer {
  root: string
  directory: string
  installed: string
}

interface BusRun {
  output: string
  boardHtmlAtMs: number | null
  projectedAtMs: number[]
  busPath: string
}

let consumer: Consumer
let shipped: Shipped
let busRun: Promise<BusRun> | null = null

function builtPathOf(source: string): string {
  return path.join(consumer.installed, OUT_DIR, source.replace(/\.ts$/, '.js'))
}

function consumerEnv(home: string): NodeJS.ProcessEnv {
  const homeDir = path.join(consumer.root, home)
  mkdirSync(homeDir, { recursive: true })
  return { PATH: process.env.PATH, HOME: homeDir, CONSTRUCT_BUS_DB: path.join(consumer.root, home, 'bus', BUS_DB) }
}

async function packIntoAnEmptyConsumer(): Promise<Consumer> {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'board-thread-lives-')))
  const stage = path.join(root, 'stage')
  for (const file of PACKED_BESIDE_THE_BUILD)
    cpSync(path.join(REPOSITORY, file), path.join(stage, file), { recursive: true })
  const outDir = path.join(stage, OUT_DIR)
  await build({ ...productBuild, outDir, config: false, silent: true })
  await build({ ...factoryBuild, outDir, config: false, silent: true, onSuccess: async () => copyFactoryAssets(outDir) })
  const env = { ...process.env, npm_config_cache: path.join(root, 'npm-cache'), npm_config_update_notifier: 'false' }
  const [tarball] = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', root], { cwd: stage, env, encoding: 'utf8' })) as { filename: string }[]
  const directory = path.join(root, 'consumer')
  const modules = path.join(directory, 'node_modules')
  mkdirSync(modules, { recursive: true })
  writeFileSync(path.join(directory, 'package.json'), `${JSON.stringify({ name: 'consumer', private: true }, null, 2)}\n`)
  execFileSync('tar', ['-xzf', path.join(root, tarball!.filename), '-C', modules])
  renameSync(path.join(modules, TARBALL_ROOT), path.join(modules, PACKAGE_NAME))
  const installed = path.join(modules, PACKAGE_NAME)
  const { dependencies = {} } = JSON.parse(readFileSync(path.join(installed, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
  for (const dependency of Object.keys(dependencies)) {
    const link = path.join(modules, dependency)
    mkdirSync(path.dirname(link), { recursive: true })
    symlinkSync(path.join(REPOSITORY, 'node_modules', dependency), link, 'dir')
  }
  return { root, directory, installed }
}

async function shippedReadings(): Promise<Shipped> {
  const imported = await Promise.all([BOARD_PAGE, BOARD_WINDOW, BUS_RUN, EVENTS].map(async source => import(pathToFileURL(builtPathOf(source)).href) as Promise<Partial<Shipped>>))
  return Object.assign({}, ...imported) as Shipped
}

function twoPeriodsMs(): number {
  return 2 * shipped.BOARD_PERIOD_MS
}

async function runTheBusForTwoPeriods(): Promise<BusRun> {
  const env = consumerEnv('home-bus-run')
  const busPath = env.CONSTRUCT_BUS_DB!
  const boardHtml = path.join(path.dirname(busPath), shipped.BOARD_FILE)
  const started = performance.now()
  const child = spawn(process.execPath, [builtPathOf(BUS_RUN)], { cwd: consumer.directory, env, stdio: ['ignore', 'pipe', 'pipe'], signal: AbortSignal.timeout(twoPeriodsMs()), killSignal: 'SIGKILL' })
  const ended = once(child, 'close')
  let output = ''
  let boardHtmlAtMs: number | null = null
  const projectedAtMs: number[] = []
  const read = (text: string): void => {
    output += text
    const at = performance.now() - started
    if (boardHtmlAtMs === null && existsSync(boardHtml))
      boardHtmlAtMs = at
    projectedAtMs.push(...text.split('\n').filter(line => line.includes(PROJECTED)).map(() => at))
    if (projectedAtMs.length >= PROJECTIONS_SEEN)
      child.kill('SIGKILL')
  }
  child.stdout.setEncoding('utf8').on('data', read)
  child.stderr.setEncoding('utf8').on('data', read)
  child.on('error', () => {})
  await ended
  return { output, boardHtmlAtMs, projectedAtMs, busPath }
}

function theBusRun(): Promise<BusRun> {
  busRun ??= runTheBusForTwoPeriods()
  return busRun
}

describe('the board thread of bus:run started from the packed package in an empty consumer', () => {
  beforeAll(async () => {
    consumer = await packIntoAnEmptyConsumer()
    shipped = await shippedReadings()
  }, PACK_TIMEOUT_MS)

  afterAll(() => {
    if (consumer !== undefined)
      rmSync(consumer.root, { recursive: true, force: true })
  })

  it('ships the board thread entry as .js beside the module that starts it', () => {
    expect(existsSync(builtPathOf(BOARD_TIMER))).toBe(true)
  })

  it('the bus started from the packed package in an empty consumer writes board.html within two board periods', async () => {
    const run = await theBusRun()
    expect(run.output).not.toMatch(MISSING_FILE)
    expect(run.boardHtmlAtMs, run.output).not.toBeNull()
    expect(run.boardHtmlAtMs!).toBeLessThan(twoPeriodsMs())
  }, PACK_TIMEOUT_MS)

  it('bus:run started from the packed package in an empty consumer rewrites board-data.js within two board periods', async () => {
    const run = await theBusRun()
    expect(run.output).not.toMatch(MISSING_FILE)
    expect(existsSync(path.join(path.dirname(run.busPath), shipped.BOARD_DATA_FILE)), run.output).toBe(true)
    expect(run.projectedAtMs.filter(at => at < twoPeriodsMs()).length, run.output).toBeGreaterThanOrEqual(2)
  }, PACK_TIMEOUT_MS)

  it('in a consumer running the packed package, a board thread killed by an exception writes a bus event and the board is rewritten again', () => {
    const env = consumerEnv('home-killed-thread')
    const busPath = env.CONSTRUCT_BUS_DB!
    const dataFile = path.join(path.dirname(busPath), shipped.BOARD_DATA_FILE)
    const evaluate = [
      'const { Worker } = await import(\'node:worker_threads\')',
      'const { setTimeout: sleep } = await import(\'node:timers/promises\')',
      'const { existsSync } = await import(\'node:fs\')',
      'const { openBus } = await import(process.env.DB_MODULE)',
      'const { startBoardThread } = await import(process.env.RUN_MODULE)',
      'const busPath = process.env.CONSTRUCT_BUS_DB',
      'const db = openBus(busPath)',
      'let spawned = 0',
      'const killer = \'throw new Error(\' + JSON.stringify(process.env.KILLED_BY) + \')\'',
      'const spawnThread = (entry, workerData) => ++spawned === 1 ? new Worker(killer, { eval: true }) : new Worker(entry, { workerData })',
      'const board = startBoardThread(db, busPath, Number(process.env.PERIOD_MS), spawnThread)',
      'const deadline = Date.now() + Number(process.env.DEADLINE_MS)',
      'while (Date.now() < deadline && !existsSync(process.env.DATA_FILE)) await sleep(50)',
      'await board.stop()',
      'const downs = db.prepare(\'SELECT actor, payload FROM events WHERE type = ?\').all(process.env.WORKER_DOWN).map(row => ({ actor: row.actor, ...JSON.parse(row.payload) }))',
      'db.close()',
      'console.log(JSON.stringify({ spawned, downs, rewritten: existsSync(process.env.DATA_FILE) }))',
    ].join('\n')
    const script = path.join(consumer.root, KILLED_THREAD_SCRIPT)
    writeFileSync(script, `${evaluate}\n`)
    const run = spawnSync(process.execPath, [script], {
      cwd: consumer.directory,
      env: { ...env, DB_MODULE: pathToFileURL(builtPathOf('scripts/core/db.ts')).href, RUN_MODULE: pathToFileURL(builtPathOf(BUS_RUN)).href, KILLED_BY, PERIOD_MS: String(KILLED_THREAD_PERIOD_MS), DEADLINE_MS: String(KILLED_THREAD_DEADLINE_MS), DATA_FILE: dataFile, WORKER_DOWN: shipped.WORKER_DOWN },
      encoding: 'utf8',
      timeout: KILLED_THREAD_DEADLINE_MS * 2,
    })
    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0)
    expect(run.stderr).not.toMatch(MISSING_FILE)
    expect(run.stderr).toContain(KILLED_BY)
    expect(run.stderr).toContain('the board thread ended')
    const result = JSON.parse(run.stdout.trim().split('\n').at(-1)!) as { spawned: number, downs: Record<string, unknown>[], rewritten: boolean }
    expect(result.spawned).toBeGreaterThanOrEqual(2)
    expect(result.downs).toEqual([expect.objectContaining({ worker: shipped.BOARD_THREAD, failures: 1, cause: expect.stringContaining(KILLED_BY) })])
    expect(result.rewritten).toBe(true)
  }, PACK_TIMEOUT_MS)
})
