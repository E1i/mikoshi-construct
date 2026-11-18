import type { ChildProcess, SpawnSyncReturns } from 'node:child_process'
import type { DatabaseSync } from 'node:sqlite'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { build } from 'tsup'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { busDirOf } from '../scripts/core/bus-path.js'
import { appendEvent, openBus, openOwnerWait } from '../scripts/core/db.js'
import { CARD_ADMITTED, CARD_CLOSED, CHILD_STARTED, WORKER_STARTED } from '../scripts/core/events.js'
import { QUEUE_ACTOR } from '../scripts/core/queue.js'
import { openDatabase } from '../scripts/core/sqlite.js'
import { publishedTreePr, taskStartCommand } from '../scripts/nodes/launch/launch-root.js'
import { PREFIX as ANSWER_PREFIX, answerWord } from '../scripts/owner/answer.js'
import { ownerChannelOfBus } from '../scripts/owner/channel.js'
import { DISK_FLOOR_BYTES, DISK_LOW, freeBytes, statfsReader } from '../scripts/ports/disk.js'
import { TREE_PR_ENTRY } from '../scripts/ports/tree-publish.js'
import { ADOPTED_KIND } from '../scripts/supervisor/recorded-worker.js'
import { WORKERS_FILE } from '../scripts/supervisor/workers.js'
import { waitFor } from '../scripts/tests/wait-for.js'
import { copyFactoryAssets, factoryBuild, OUT_DIR, productBuild } from '../tsup.config.js'

const REPOSITORY = path.resolve(import.meta.dirname, '..')
const PACKAGE_NAME = 'mikoshi-construct'
const INTAKE_BIN = 'construct-intake'
const CLI_BIN = 'construct'
const ANSWER_BIN = 'construct-answer'
const ANSWER_ENTRY = path.join('scripts', 'owner', 'answer.js')
const BUS_RUN_ENTRY = path.join('scripts', 'supervisor', 'run.js')
const REDUCER_ENTRY = path.join('scripts', 'core', 'reducer.js')
const SUPERVISOR_ENTRY = path.join('scripts', 'supervisor', 'supervisor.js')
const NEXT_VERSION_TAG = 'next.1'
const STOPPED_WITHIN_MS = 10_000
const LAUNCH_WORKER = 'launch'
const LANE_FREED_BY = 'an earlier test launched it, and the next restart needs its lane'
const ANSWER_WORDS = 'go on from the package'
const OWNER_DECIDES = 'pnpm decisions:add "[owner] <decision>"'
const ANSWERED = ['window.request.done', 'window.request.refused']
const GITHUB_WITH_NO_PULL_REQUESTS = 'case "$*" in *pulls*) body=\'[]\' ;; *) body=\'{}\' ;; esac\nprintf \'HTTP/2.0 200 OK\\ncontent-type: application/json\\n\\n%s\\n\' "$body"'
const PACKED_BESIDE_THE_BUILD = ['package.json', 'README.md', 'LICENSE', 'templates']
const PACK_TIMEOUT_MS = 300_000
const STARTED_WITHIN_MS = 60_000
const SYSTEM_BIN_DIRS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin']
const LINUX_SANDBOX_BINS = ['bwrap', 'socat']
const CLIENT_LISTED_SECONDS = 20
const CARD_ID = 1
const SQLITE_BUSY = 5
const PRIMARY_RESULT_CODE = 0xFF
const BUSY_RETRY_WINDOW_MS = 10_000
const BUSY_RETRY_PAUSE_MS = 25
const WRITER_HOLDS_LOCK_MS = 500
const DRAFT = { cards: [{ name: 'open-question', kind: 'implement', milestone: 'netwatch', size: 'S', contour: 'cheap', decision: 'auto', who: 'shift', touches: ['architecture/open-questions.md'], task: 'Add one open question to architecture/open-questions.md.', witnesses: ['`grep -q probe architecture/open-questions.md` exits 0'] }] }

interface Foreign {
  root: string
  installed: string
  prefix: string
  repo: string
  home: string
  bus: string
  calls: string
  env: NodeJS.ProcessEnv
}

let foreign: Foreign
let intake: SpawnSyncReturns<string>
let beside: SpawnSyncReturns<string>
let packagedVersion: string
let attempts = 0

function freshName(name: string): string {
  attempts += 1
  return `${name}-${attempts}`
}

function isBusy(error: unknown): boolean {
  const code = (error as { errcode?: unknown } | null)?.errcode
  return typeof code === 'number' && (code & PRIMARY_RESULT_CODE) === SQLITE_BUSY
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)), 0, 0, ms)
}

function readBus<T>(bus: string, read: (db: DatabaseSync) => T, windowMs = BUSY_RETRY_WINDOW_MS): T {
  const started = Date.now()
  for (;;) {
    try {
      const db = openDatabase(bus, { readOnly: true })
      try {
        return read(db)
      }
      finally {
        db.close()
      }
    }
    catch (error) {
      if (!isBusy(error) || Date.now() - started >= windowMs)
        throw error
      pause(BUSY_RETRY_PAUSE_MS)
    }
  }
}

function stub(bin: string, name: string, body: string): void {
  const file = path.join(bin, name)
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function cardEvents(bus: string): string[] {
  if (!existsSync(bus))
    return []
  return readBus(bus, db => (db.prepare('SELECT type FROM events WHERE card_id = ? ORDER BY id').all(CARD_ID) as { type: string }[]).map(row => row.type))
}

interface BusEvent {
  id: number
  payload: string
}

function eventsOf(bus: string, types: string[]): BusEvent[] {
  return readBus(bus, db => db.prepare(`SELECT id, payload FROM events WHERE type IN (${types.map(() => '?').join(', ')}) ORDER BY id`).all(...types) as unknown as BusEvent[])
}

function wordsIn(channel: string): string[] {
  return existsSync(channel) ? readdirSync(channel).map(file => readFileSync(path.join(channel, file), 'utf8').split('\n')[1]!) : []
}

function launchDenials(bus: string): Record<string, unknown>[] {
  if (!existsSync(bus))
    return []
  return readBus(bus, db => (db.prepare('SELECT payload FROM events WHERE card_id = ? AND type = \'policy.denied\' ORDER BY id').all(CARD_ID) as { payload: string }[]).map(row => JSON.parse(row.payload) as Record<string, unknown>))
}

async function packAndInstall(root: string): Promise<{ installed: string, prefix: string }> {
  const stage = path.join(root, 'stage')
  for (const file of PACKED_BESIDE_THE_BUILD)
    cpSync(path.join(REPOSITORY, file), path.join(stage, file), { recursive: true })
  const outDir = path.join(stage, OUT_DIR)
  await build({ ...productBuild, outDir, config: false, silent: true })
  await build({ ...factoryBuild, outDir, config: false, silent: true, onSuccess: async () => copyFactoryAssets(outDir) })
  return installStage(root, stage)
}

function installStage(root: string, stage: string): { installed: string, prefix: string } {
  const env = { ...process.env, npm_config_cache: path.join(root, 'npm-cache'), npm_config_update_notifier: 'false' }
  const [tarball] = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', root], { cwd: stage, env, encoding: 'utf8' })) as { filename: string }[]
  const prefix = path.join(root, 'prefix')
  execFileSync('npm', ['install', '--global', '--prefix', prefix, path.join(root, tarball!.filename), '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: root, env, encoding: 'utf8' })
  return { installed: path.join(prefix, 'lib', 'node_modules', PACKAGE_NAME), prefix }
}

function foreignRepository(root: string, prefix: string, env: NodeJS.ProcessEnv): string {
  const repo = path.join(root, 'user-repo')
  const origin = path.join(root, 'user-repo.origin.git')
  mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'user@example.invalid')
  git(repo, 'config', 'user.name', 'user')
  execFileSync(path.join(prefix, 'bin', CLI_BIN), ['init', '--yes', '--preset', 'node-backend', '--dir', repo, '--plain'], { cwd: repo, env, encoding: 'utf8' })
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', 'init')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
  git(repo, 'remote', 'add', 'origin', origin)
  git(repo, 'push', '-q', 'origin', 'main')
  return repo
}

describe('a factory installed from the packed package', () => {
  beforeAll(async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'intake-from-package-')))
    const { installed, prefix } = await packAndInstall(root)
    const bin = path.join(root, 'stub-bin')
    const home = path.join(root, 'home')
    const calls = path.join(root, 'claude.calls')
    for (const directory of [bin, path.join(home, '.claude')])
      mkdirSync(directory, { recursive: true })
    writeFileSync(path.join(home, '.claude', 'settings.json'), `${JSON.stringify({ sandbox: { enabled: true } })}\n`)
    stub(bin, 'claude', `printf '%s\\t%s\\n' "$PWD" "$*" >> '${calls}'\nsleep ${CLIENT_LISTED_SECONDS}`)
    stub(bin, 'pnpm', 'exit 0')
    stub(bin, 'npx', 'exit 0')
    for (const name of LINUX_SANDBOX_BINS)
      stub(bin, name, 'exit 0')
    const bus = path.join(root, 'bus.db')
    const env = { PATH: [bin, path.join(prefix, 'bin'), path.dirname(process.execPath), ...SYSTEM_BIN_DIRS].join(path.delimiter), HOME: home, CONSTRUCT_BUS_DB: bus, CONSTRUCT_WORKTREE_HOME: path.join(root, 'worktrees') }
    const repo = foreignRepository(root, prefix, env)
    const draft = path.join(root, 'draft.json')
    const taken = path.join(root, 'taken.txt')
    writeFileSync(draft, JSON.stringify(DRAFT))
    writeFileSync(taken, '')
    foreign = { root, installed, prefix, repo, home, bus, calls, env }
    packagedVersion = installedVersion()
    intake = spawnSync(path.join(prefix, 'bin', INTAKE_BIN), ['--draft', draft, '--taken', taken, '--auto-confirm', '--plain'], { cwd: repo, env, encoding: 'utf8' })
    beside = spawnSync(path.join(prefix, 'bin', CLI_BIN), ['intake', '--draft', draft, '--taken', taken, '--auto-confirm', '--plain'], { cwd: repo, env, encoding: 'utf8' })
  }, PACK_TIMEOUT_MS)

  afterAll(() => {
    if (foreign !== undefined)
      rmSync(foreign.root, { recursive: true, force: true })
  })

  describe('the published factory path takes a card from intake to a session', () => {
    it('runs task:start and the pull request step through pnpm in this checkout and through built files from an installed package', () => {
      expect(taskStartCommand(null)).toEqual({ file: 'pnpm', args: ['--silent', 'task:start'] })
      expect(taskStartCommand(REPOSITORY)).toEqual({ file: process.execPath, args: [path.join(REPOSITORY, OUT_DIR, 'scripts', 'ports', 'task-start.js')] })
      expect(publishedTreePr('/repo', null)).toContain('pnpm')
      expect(publishedTreePr('/repo', REPOSITORY)).toBe(`'${process.execPath}' '${path.join(REPOSITORY, OUT_DIR, `${TREE_PR_ENTRY}.js`)}'`)
    })

    it('the published intake records the card on the bus', () => {
      expect(intake.status, `${intake.stdout}\n${intake.stderr}`).toBe(0)
      expect(cardEvents(foreign.bus)).toEqual(['card.admitted'])
    })

    it('the published construct intake parks nothing beside the bus and names construct-intake', () => {
      expect(beside.status).toBe(1)
      expect(`${beside.stdout}${beside.stderr}`).toContain(INTAKE_BIN)
      expect(cardEvents(foreign.bus).filter(type => type === 'card.admitted')).toHaveLength(1)
    })

    it('the published launch path starts a session for an admitted card, or denies it disk_low on a runner under the disk floor', async () => {
      const built = (entry: string): string => path.join(foreign.installed, OUT_DIR, 'scripts', entry)
      const reduce = spawnSync(process.execPath, [built('core/reducer.js')], { cwd: foreign.repo, env: foreign.env, encoding: 'utf8' })
      expect(reduce.status, reduce.stderr).toBe(0)
      const underTheFloor = freeBytes(statfsReader(foreign.repo)) < DISK_FLOOR_BYTES
      let worker: ChildProcess | undefined
      try {
        worker = spawn(process.execPath, [built('nodes/launch/launch-root.js'), '--on', '--live'], { cwd: foreign.repo, env: foreign.env, stdio: 'ignore' })
        if (underTheFloor) {
          await waitFor(() => launchDenials(foreign.bus).length > 0, () => `policy.denied for #${CARD_ID} in ${foreign.bus}`, STARTED_WITHIN_MS)
        }
        else {
          await waitFor(() => cardEvents(foreign.bus).includes('card.started'), () => `card.started for #${CARD_ID} in ${foreign.bus}`, STARTED_WITHIN_MS)
          await waitFor(() => existsSync(foreign.calls), () => `a claude call in ${foreign.calls}`, STARTED_WITHIN_MS)
        }
      }
      finally {
        worker?.kill('SIGKILL')
      }
      if (underTheFloor) {
        expect(launchDenials(foreign.bus)[0]).toMatchObject({ command: 'launch', kind: 'technical', reason: DISK_LOW })
        expect(cardEvents(foreign.bus)).not.toContain('card.started')
        return
      }
      const [call] = readFileSync(foreign.calls, 'utf8').trim().split('\n')
      expect(call).toMatch(new RegExp(`^${path.join(foreign.root, 'worktrees')}/\\S+\\t.*--session-id `))
    }, STARTED_WITHIN_MS * 2)
  })

  describe('the published construct-answer, from a repository other than mikoshi-construct', () => {
    it('construct-answer is its own bin of the package and reaches scripts/owner/answer.ts', () => {
      const bins = (JSON.parse(readFileSync(path.join(foreign.installed, 'package.json'), 'utf8')) as { bin: Record<string, string> }).bin
      expect(bins[ANSWER_BIN]).toBe(path.join(OUT_DIR, ANSWER_ENTRY))
      expect(bins[ANSWER_BIN]).not.toBe(bins[CLI_BIN])
      const usage = spawnSync(path.join(foreign.prefix, 'bin', ANSWER_BIN), [], { cwd: foreign.repo, env: foreign.env, encoding: 'utf8' })
      expect(usage.status).toBe(2)
      expect(usage.stdout).toContain(`${ANSWER_PREFIX}usage: ${ANSWER_BIN} `)
    })

    it('construct-answer from a foreign repository writes the owner word and owner.answer and the bus answers done or refused', async () => {
      const db = openBus(foreign.bus)
      const wait = openOwnerWait(db, new Date().toISOString(), QUEUE_ACTOR, { need: 'decision', text: 'which option?', command: OWNER_DECIDES })
      db.close()
      const before = eventsOf(foreign.bus, ['window.request']).length

      const run = spawnSync(path.join(foreign.prefix, 'bin', ANSWER_BIN), [wait, ANSWER_WORDS], { cwd: foreign.repo, env: foreign.env, encoding: 'utf8' })

      expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0)
      expect(run.stdout.startsWith(ANSWER_PREFIX)).toBe(true)
      expect(wordsIn(ownerChannelOfBus(foreign.home, foreign.bus))).toContain(answerWord(wait, ANSWER_WORDS))
      const requests = eventsOf(foreign.bus, ['window.request']).slice(before)
      expect(requests).toHaveLength(1)
      const request = requests[0]!
      expect(JSON.parse(request.payload)).toEqual({ kind: 'owner.answer', id: wait, text: ANSWER_WORDS, from: 'answer' })

      stub(path.join(foreign.root, 'stub-bin'), 'gh', GITHUB_WITH_NO_PULL_REQUESTS)
      const log = path.join(foreign.root, 'bus-run.log')
      const output = openSync(log, 'w')
      let worker: ChildProcess | undefined
      const answeredFor = (): BusEvent[] => eventsOf(foreign.bus, ANSWERED).filter(answered => JSON.parse(answered.payload).request === request.id)
      try {
        worker = spawn(process.execPath, [path.join(foreign.installed, OUT_DIR, BUS_RUN_ENTRY)], { cwd: foreign.repo, env: foreign.env, stdio: ['ignore', output, output] })
        await waitFor(() => answeredFor().length > 0, () => `window.request.done or window.request.refused for ${request.id} in ${foreign.bus}; bus:run said: ${readFileSync(log, 'utf8')}`, STARTED_WITHIN_MS)
      }
      finally {
        worker?.kill('SIGKILL')
        closeSync(output)
      }
      expect(JSON.parse(answeredFor()[0]!.payload)).toMatchObject({ request: request.id, kind: 'owner.answer' })
    }, STARTED_WITHIN_MS * 2)

    it('the published dist/cli.js imports no factory script for the owner answer', () => {
      expect(readFileSync(path.join(foreign.installed, OUT_DIR, 'cli.js'), 'utf8')).not.toMatch(/runOwnerAnswer|requestFromWindow|owner\.answer\b|scripts\/owner\/answer/)
      expect(existsSync(path.join(foreign.prefix, 'bin', ANSWER_BIN))).toBe(true)
      const help = spawnSync(path.join(foreign.prefix, 'bin', CLI_BIN), ['--help'], { cwd: foreign.repo, env: foreign.env, encoding: 'utf8' })
      expect(help.status, help.stderr).toBe(0)
      expect(help.stdout).not.toMatch(/\|answer\b|\banswer\|/)
      expect(help.stdout).not.toMatch(/^\s+answer\s{2,}/m)
    })
  })

  interface Start {
    type: string
    worker?: unknown
    generation: unknown
    pid: unknown
    pgid: unknown
  }

  function lastEventId(bus: string): number {
    return readBus(bus, db => Number((db.prepare('SELECT coalesce(max(id), 0) AS id FROM events').get() as { id: number }).id))
  }

  function startsSince(bus: string, after: number): Start[] {
    return readBus(bus, db => (db.prepare('SELECT type, payload FROM events WHERE id > ? AND type IN (?, ?) ORDER BY id').all(after, WORKER_STARTED, CHILD_STARTED) as { type: string, payload: string }[])
      .map(row => ({ type: row.type, ...(JSON.parse(row.payload) as Omit<Start, 'type'>) })))
  }

  function killed(start: Start): boolean {
    const targets = [...start.pgid === start.pid && typeof start.pgid === 'number' ? [-start.pgid] : [], ...typeof start.pid === 'number' ? [start.pid] : []]
    return targets.map((target) => {
      try {
        process.kill(target, 'SIGKILL')
        return true
      }
      catch {
        return false
      }
    }).some(Boolean)
  }

  async function stopEverythingStartedSince(after: number): Promise<void> {
    await waitFor(() => !startsSince(foreign.bus, after).map(killed).some(Boolean), () => `every process started on ${foreign.bus} since event ${after} gone`, STOPPED_WITHIN_MS)
  }

  function diskLowSince(bus: string, after: number): boolean {
    return readBus(bus, db => (db.prepare('SELECT payload FROM events WHERE id > ? AND type = \'policy.denied\'').all(after) as { payload: string }[]).some(row => (JSON.parse(row.payload) as { reason?: unknown }).reason === DISK_LOW))
  }

  function admittedCards(): number[] {
    return readBus(foreign.bus, db => (db.prepare('SELECT DISTINCT card_id AS card FROM events WHERE type = ?').all(CARD_ADMITTED) as { card: number }[]).map(row => Number(row.card)))
  }

  function closeSoItsLaneIsFree(cardId: number): void {
    const db = openBus(foreign.bus)
    try {
      appendEvent(db, { ts: new Date().toISOString(), type: CARD_CLOSED, actor: QUEUE_ACTOR, cardId, pr: null, head: null, dedupeKey: `${CARD_CLOSED}:${cardId}`, payload: { report: LANE_FREED_BY }, legacy: false })
    }
    finally {
      db.close()
    }
  }

  function reduced(): void {
    const reduce = spawnSync(process.execPath, [path.join(foreign.installed, OUT_DIR, REDUCER_ENTRY)], { cwd: foreign.repo, env: foreign.env, encoding: 'utf8' })
    expect(reduce.status, reduce.stderr).toBe(0)
  }

  function admitLaunchableCard(name: string): void {
    admittedCards().forEach(closeSoItsLaneIsFree)
    reduced()
    const draft = path.join(foreign.root, `${name}.draft.json`)
    const taken = path.join(foreign.root, `${name}.taken.txt`)
    writeFileSync(draft, JSON.stringify({ cards: DRAFT.cards.map(card => ({ ...card, name, touches: [`${name}.md`], creates: [`${name}.md`] })) }))
    writeFileSync(taken, '')
    const admitted = spawnSync(path.join(foreign.prefix, 'bin', INTAKE_BIN), ['--draft', draft, '--taken', taken, '--auto-confirm', '--plain'], { cwd: foreign.repo, env: foreign.env, encoding: 'utf8' })
    expect(admitted.status, `${admitted.stdout}\n${admitted.stderr}`).toBe(0)
    const busDir = busDirOf(foreign.bus)
    mkdirSync(busDir, { recursive: true })
    writeFileSync(path.join(busDir, WORKERS_FILE), `${JSON.stringify({ on: [LAUNCH_WORKER], live: [LAUNCH_WORKER] })}\n`)
    reduced()
  }

  const LOG_TAIL_CHARS = 4000

  function busLogs(): string {
    const busDir = busDirOf(foreign.bus)
    return readdirSync(busDir).filter(file => file.endsWith('.log')).map(file => `${file}: ${readFileSync(path.join(busDir, file), 'utf8').slice(-LOG_TAIL_CHARS)}`).join('\n')
  }

  async function restartedFactory(card: string): Promise<{ starts: Start[], childStarted: boolean }> {
    admitLaunchableCard(freshName(card))
    const after = lastEventId(foreign.bus)
    const run = spawnSync(process.execPath, [path.join(foreign.installed, OUT_DIR, SUPERVISOR_ENTRY)], { cwd: foreign.repo, env: foreign.env, encoding: 'utf8', timeout: STARTED_WITHIN_MS })
    try {
      expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0)
      await waitFor(() => diskLowSince(foreign.bus, after) || startsSince(foreign.bus, after).some(start => start.type === CHILD_STARTED), () => `a child.started of the launch worker in ${foreign.bus}: ${JSON.stringify(startsSince(foreign.bus, after))}\n${run.stdout}\n${run.stderr}\n${busLogs()}`, STARTED_WITHIN_MS)
      return { starts: startsSince(foreign.bus, after), childStarted: !diskLowSince(foreign.bus, after) }
    }
    finally {
      await stopEverythingStartedSince(after)
    }
  }

  const adoptedPrefix = `worker:${ADOPTED_KIND}:`

  function adoptedRecord(start: Start): boolean {
    return start.type === WORKER_STARTED && typeof start.worker === 'string' && start.worker.startsWith(adoptedPrefix)
  }

  function expectGeneration(restarted: { starts: Start[], childStarted: boolean }, generation: string): void {
    const handed = restarted.starts.filter(start => !adoptedRecord(start))
    const handedPids = new Set(handed.filter(start => start.type === WORKER_STARTED && start.generation === generation).map(start => start.pid))
    expect(restarted.starts.filter(adoptedRecord).map(start => start.pid).filter(pid => !handedPids.has(pid))).toEqual([])
    expect(generationsOf(handed, WORKER_STARTED)).toEqual([generation])
    expect(generationsOf(handed, CHILD_STARTED)).toEqual(restarted.childStarted ? [generation] : [])
  }

  function installedVersion(): string {
    return (JSON.parse(readFileSync(path.join(foreign.installed, 'package.json'), 'utf8')) as { version: string }).version
  }

  function generationsOf(starts: Start[], type: string): unknown[] {
    return [...new Set(starts.filter(start => start.type === type).map(start => start.generation))]
  }

  describe('the generation of a factory started from the installed package', () => {
    it('a bus started from the installed package records the package version as generation in worker.started and child.started', async () => {
      expectGeneration(await restartedFactory('generation-first'), installedVersion())
    }, STARTED_WITHIN_MS * 3)

    it('installing another version of the package gives a new generation on the next restart', async () => {
      const stage = path.join(foreign.root, 'stage')
      const manifest = JSON.parse(readFileSync(path.join(stage, 'package.json'), 'utf8')) as { version: string }
      const upgraded = `${packagedVersion}-${NEXT_VERSION_TAG}`
      writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify({ ...manifest, version: upgraded }, null, 2)}\n`)
      installStage(foreign.root, stage)
      expect(installedVersion()).toBe(upgraded)
      expectGeneration(await restartedFactory('generation-upgraded'), upgraded)
    }, PACK_TIMEOUT_MS)

    it('a commit in the user repository does not change the generation of the installed factory', async () => {
      writeFileSync(path.join(foreign.repo, `${freshName('USER_CHANGE')}.md`), 'a change of the user\n')
      git(foreign.repo, 'add', '-A')
      git(foreign.repo, 'commit', '-qm', 'a change of the user')
      const head = execFileSync('git', ['-C', foreign.repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
      const restarted = await restartedFactory('generation-after-commit')
      expectGeneration(restarted, installedVersion())
      expect(generationsOf(restarted.starts, WORKER_STARTED)).not.toContain(head)
    }, STARTED_WITHIN_MS * 3)
  })
})

const LOCKED_ROWS_BEFORE = 2
const LOCKED_ROWS_WRITTEN = 3
const WRITER_HOLDS_THE_LOCK = `
const { writeFileSync } = process.getBuiltinModule('node:fs')
const { DatabaseSync } = process.getBuiltinModule('node:sqlite')
const [file, ready, rows, holdMs] = process.argv.slice(1)
const db = new DatabaseSync(file)
db.exec('BEGIN EXCLUSIVE')
for (let row = 0; row < Number(rows); row++)
  db.prepare('INSERT INTO events (type) VALUES (?)').run('written')
writeFileSync(ready, '')
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(holdMs))
db.exec('COMMIT')
db.close()
`

function eventCount(db: DatabaseSync): number {
  return Number((db.prepare('SELECT count(*) AS n FROM events').get() as { n: number }).n)
}

describe('the test reads its bus through one reader', () => {
  it('a bus read retries SQLITE_BUSY while a writer holds the lock', async () => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'bus-busy-')))
    try {
      const bus = path.join(dir, 'bus.db')
      const ready = path.join(dir, 'locked')
      const seed = openDatabase(bus)
      seed.exec('PRAGMA journal_mode = DELETE; CREATE TABLE events (id INTEGER PRIMARY KEY, type TEXT)')
      for (let row = 0; row < LOCKED_ROWS_BEFORE; row++)
        seed.prepare('INSERT INTO events (type) VALUES (?)').run('before')
      seed.close()
      const writer = spawn(process.execPath, ['-e', WRITER_HOLDS_THE_LOCK, bus, ready, String(LOCKED_ROWS_WRITTEN), String(WRITER_HOLDS_LOCK_MS)], { stdio: 'ignore' })
      const exited = new Promise<unknown>(resolve => writer.once('exit', resolve))
      try {
        await waitFor(() => existsSync(ready), () => `the writer to hold the lock on ${bus}`, STARTED_WITHIN_MS)
        expect(() => readBus(bus, eventCount, 0)).toThrow(expect.objectContaining({ errcode: SQLITE_BUSY }))
        expect(readBus(bus, eventCount)).toBe(LOCKED_ROWS_BEFORE + LOCKED_ROWS_WRITTEN)
      }
      finally {
        writer.kill('SIGKILL')
      }
      await exited
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, STARTED_WITHIN_MS)
})
