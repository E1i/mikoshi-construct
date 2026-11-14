import type { ChildProcess, SpawnSyncReturns } from 'node:child_process'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { build } from 'tsup'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { busPathOf } from '../scripts/core/bus-path.js'
import { openBus, openOwnerWait } from '../scripts/core/db.js'
import { QUEUE_ACTOR } from '../scripts/core/queue.js'
import { openDatabase } from '../scripts/core/sqlite.js'
import { answerWord, PREFIX } from '../scripts/owner/answer.js'
import { ownerChannelOfBus } from '../scripts/owner/channel.js'
import { waitFor } from '../scripts/tests/wait-for.js'
import { copyFactoryAssets, factoryBuild, OUT_DIR, productBuild } from '../tsup.config.js'

const REPOSITORY = path.resolve(import.meta.dirname, '..')
const PACKAGE_NAME = 'mikoshi-construct'
const ANSWER_BIN = 'construct-answer'
const OWNER_ANSWER_ENTRY = path.join('scripts', 'owner', 'answer.js')
const BUS_RUN_ENTRY = path.join('scripts', 'supervisor', 'run.js')
const PACKED_BESIDE_THE_BUILD = ['package.json', 'README.md', 'LICENSE', 'templates']
const PACK_TIMEOUT_MS = 300_000
const ANSWERED_WITHIN_MS = 60_000
const SYSTEM_BIN_DIRS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin']
const WORDS = 'option c from the package'
const OWNER_DECIDES = 'pnpm decisions:add "[owner] <decision>"'
const ANSWERED = ['window.request.done', 'window.request.refused']
const GITHUB_WITH_NO_PULL_REQUESTS = 'case "$*" in *pulls*) body=\'[]\' ;; *) body=\'{}\' ;; esac\nprintf \'HTTP/2.0 200 OK\\ncontent-type: application/json\\n\\n%s\\n\' "$body"'

interface Foreign {
  root: string
  installed: string
  prefix: string
  home: string
  env: NodeJS.ProcessEnv
}

interface Request {
  id: number
  payload: string
}

let foreign: Foreign

function stub(bin: string, name: string, body: string): void {
  const file = path.join(bin, name)
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

async function packAndInstall(root: string): Promise<{ installed: string, prefix: string }> {
  const stage = path.join(root, 'stage')
  for (const file of PACKED_BESIDE_THE_BUILD)
    cpSync(path.join(REPOSITORY, file), path.join(stage, file), { recursive: true })
  const outDir = path.join(stage, OUT_DIR)
  await build({ ...productBuild, outDir, config: false, silent: true })
  await build({ ...factoryBuild, outDir, config: false, silent: true, onSuccess: async () => copyFactoryAssets(outDir) })
  const env = { ...process.env, npm_config_cache: path.join(root, 'npm-cache'), npm_config_update_notifier: 'false' }
  const [tarball] = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', root], { cwd: stage, env, encoding: 'utf8' })) as { filename: string }[]
  const prefix = path.join(root, 'prefix')
  execFileSync('npm', ['install', '--global', '--prefix', prefix, path.join(root, tarball!.filename), '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: root, env, encoding: 'utf8' })
  return { installed: path.join(prefix, 'lib', 'node_modules', PACKAGE_NAME), prefix }
}

function repository(name: string): string {
  const repo = path.join(foreign.root, name)
  mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'config', 'user.email', 'user@example.invalid')
  git(repo, 'config', 'user.name', 'user')
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init')
  return repo
}

function answerFrom(repo: string, args: string[]): SpawnSyncReturns<string> {
  return spawnSync(path.join(foreign.prefix, 'bin', ANSWER_BIN), args, { cwd: repo, env: foreign.env, encoding: 'utf8' })
}

function eventsOf(bus: string, types: string[]): Request[] {
  const db = openDatabase(bus, { readOnly: true })
  try {
    return db.prepare(`SELECT id, payload FROM events WHERE type IN (${types.map(() => '?').join(', ')}) ORDER BY id`).all(...types) as unknown as Request[]
  }
  finally {
    db.close()
  }
}

function wordsIn(channel: string): string[] {
  return existsSync(channel) ? readdirSync(channel).map(file => readFileSync(path.join(channel, file), 'utf8').split('\n')[1]!) : []
}

beforeAll(async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'construct-answer-from-package-')))
  const { installed, prefix } = await packAndInstall(root)
  const bin = path.join(root, 'stub-bin')
  const home = path.join(root, 'home')
  for (const directory of [bin, home])
    mkdirSync(directory, { recursive: true })
  stub(bin, 'gh', GITHUB_WITH_NO_PULL_REQUESTS)
  const env = { PATH: [bin, path.join(prefix, 'bin'), path.dirname(process.execPath), ...SYSTEM_BIN_DIRS].join(path.delimiter), HOME: home }
  foreign = { root, installed, prefix, home, env }
}, PACK_TIMEOUT_MS)

afterAll(() => {
  if (foreign !== undefined)
    rmSync(foreign.root, { recursive: true, force: true })
})

describe('construct-answer from the installed package, in a repository other than mikoshi-construct', () => {
  it('construct answer reaches the owner answer command', async () => {
    const repo = repository('user-repo')
    const bus = busPathOf({}, foreign.home, repo, false)
    const db = openBus(bus)
    const wait = openOwnerWait(db, new Date().toISOString(), QUEUE_ACTOR, { need: 'decision', text: 'which option?', command: OWNER_DECIDES })
    db.close()

    const run = answerFrom(repo, [wait, WORDS])

    expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0)
    expect(run.stdout.startsWith(PREFIX)).toBe(true)
    expect(wordsIn(ownerChannelOfBus(foreign.home, bus))).toEqual([answerWord(wait, WORDS)])
    const [request, ...more] = eventsOf(bus, ['window.request'])
    expect(more).toEqual([])
    expect(JSON.parse(request!.payload)).toEqual({ kind: 'owner.answer', id: wait, text: WORDS, from: 'answer' })

    const log = path.join(foreign.root, 'bus-run.log')
    const output = openSync(log, 'w')
    let worker: ChildProcess | undefined
    try {
      worker = spawn(process.execPath, [path.join(foreign.installed, OUT_DIR, BUS_RUN_ENTRY)], { cwd: repo, env: foreign.env, stdio: ['ignore', output, output] })
      await waitFor(() => eventsOf(bus, ANSWERED).some(answered => JSON.parse(answered.payload).request === request!.id), () => `window.request.done or window.request.refused for ${request!.id} in ${bus}; bus:run said: ${readFileSync(log, 'utf8')}`, ANSWERED_WITHIN_MS)
    }
    finally {
      worker?.kill('SIGKILL')
      closeSync(output)
    }
    const [answered] = eventsOf(bus, ANSWERED).filter(event => JSON.parse(event.payload).request === request!.id)
    expect(JSON.parse(answered!.payload)).toMatchObject({ request: request!.id, kind: 'owner.answer', detail: expect.stringContaining(`closed ${wait}: ${WORDS}`) })
    expect(eventsOf(bus, ['window.request.done']).map(event => JSON.parse(event.payload).request)).toContain(request!.id)
  }, ANSWERED_WITHIN_MS * 2)

  it('is its own bin, and the published construct imports no owner answer script', () => {
    const bins = (JSON.parse(readFileSync(path.join(foreign.installed, 'package.json'), 'utf8')) as { bin: Record<string, string> }).bin
    expect(bins[ANSWER_BIN]).toBe(path.join(OUT_DIR, OWNER_ANSWER_ENTRY))
    expect(readFileSync(path.join(foreign.installed, OUT_DIR, 'cli.js'), 'utf8')).not.toMatch(/runOwnerAnswer|owner\.answer\b/)
  })
})
