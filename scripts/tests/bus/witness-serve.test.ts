import type { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parkingFileText } from '../../../src/card/parking.js'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_ADMITTED, CARD_STOPPED, POLICY_DENIED, PR_OBSERVED, WITNESS_RECORDED } from '../../core/events.js'
import { reduce } from '../../core/reducer.js'
import { realTimedShell } from '../../nodes/witness/witness-executor.js'
import { WitnessNode } from '../../nodes/witness/witness-worker.js'
import { GREEN, UNCHECKED } from '../../policy/policy.js'
import { SetupTurns, withWorktreeAsync } from '../../ports/worktree.js'

const CARD = 1550
const PR = 2550
const roots: string[] = []
const dbs: DatabaseSync[] = []

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const db of dbs.splice(0))
    db.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, '-c', 'user.name=bus', '-c', 'user.email=bus@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim()
}

function commit(repo: string, files: Record<string, string>, message: string): string {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
    writeFileSync(path.join(repo, file), text)
    git(repo, 'add', file)
  }
  git(repo, 'commit', '-q', '-m', message)
  return git(repo, 'rev-parse', 'HEAD')
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => resolve(typeof address === 'object' && address !== null ? address.port : 0))
    })
  })
}

interface World {
  db: DatabaseSync
  repo: string
  base: string
  head: string
  pidFile: string
  ranFile: string
}

const LAB = 'scripts/construct/browser-lab.mjs'

function labText(ranFile: string): string {
  return `import { appendFileSync, existsSync } from 'node:fs'
import process from 'node:process'
appendFileSync(${JSON.stringify(ranFile)}, 'ran\\n')
const url = process.argv[3]
if (url.startsWith('http://127.0.0.1')) {
  const body = await (await fetch(url)).text()
  process.exit(body === 'done' ? 0 : 1)
}
process.exit(existsSync('done.txt') ? 0 : 1)
`
}

function serverText(pidFile: string, port: number): string {
  return `import { existsSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import process from 'node:process'
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
http.createServer((_, response) => response.end(existsSync('done.txt') ? 'done' : 'not yet')).listen(${port}, '127.0.0.1')
`
}

function serveOf(port: number, command = 'node server.mjs', readyTimeoutMs = 10_000): string {
  return JSON.stringify({ serve: { command, url: `http://127.0.0.1:${port}/`, readyTimeoutMs } })
}

interface WorldSpec {
  port: number
  url?: string
  onBase?: Record<string, string>
  onHead?: Record<string, string>
}

function world({ port, url = `http://127.0.0.1:${port}/`, onBase = {}, onHead = {} }: WorldSpec): World {
  const root = mkdtempSync(path.join(tmpdir(), 'witness-serve-'))
  roots.push(root)
  const repo = path.join(root, 'repo')
  const pidFile = path.join(root, 'server.pid')
  const ranFile = path.join(root, 'lab.ran')
  execFileSync('git', ['init', '-q', repo])
  const base = commit(repo, { 'README.md': 'base\n', [LAB]: labText(ranFile), 'server.mjs': serverText(pidFile, port), ...onBase }, 'base')
  const head = commit(repo, { 'done.txt': 'done\n', ...onHead }, 'head')
  const db = openBus(path.join(root, 'bus.db'))
  dbs.push(db)
  const body = `Serve the page.\n\nWitnesses:\n- \`node ${LAB} page ${url}\` exits 0; red on main`
  const text = parkingFileText({ card: `#${CARD} served [implement/construct/S/cheap/auto] · depends — · blocks —`, branch: 'feat/served', touches: ['done.txt'], continue: 'stop', who: 'shift', body })
  appendEvent(db, { ts: '2026-10-21T10:00:00.000Z', type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${CARD}`, payload: { card: `#${CARD}`, lane: 'lane-1', text, textSha: textSha(text), bodySha: textSha(text).slice(0, 12) }, legacy: false })
  appendEvent(db, { ts: '2026-10-21T10:01:00.000Z', type: PR_OBSERVED, actor: 'netwatch', cardId: CARD, pr: PR, head, dedupeKey: `${PR_OBSERVED}:${PR}:${head}`, payload: { card_id: CARD, base: 'main', head, mergeable: 'clean', ci: 'green', auto_merge: false, draft: false, body_sha: 'a'.repeat(64) }, legacy: false })
  reduce(db)
  return { db, repo, base, head, pidFile, ranFile }
}

async function witnessRun(w: World): Promise<void> {
  const turns = new SetupTurns()
  const trees = { baseOf: async () => w.base, withTree: <T>(base: string, run: (tree: string) => Promise<T>) => withWorktreeAsync(w.repo, base, run, turns) }
  const node = new WitnessNode({ db: w.db, clock: () => new Date('2026-10-21T10:02:00.000Z'), session: 'witness-1', mode: 'live', env: {}, shell: realTimedShell, trees })
  for (let round = 0; round < 2; round += 1) {
    const controller = new AbortController()
    await node.run({ pause: async () => controller.abort(), signal: controller.signal })
  }
}

function payloadsOf(w: World, type: string): Record<string, unknown>[] {
  return (w.db.prepare('SELECT payload FROM events WHERE type = ?').all(type) as { payload: string }[]).map(row => JSON.parse(row.payload) as Record<string, unknown>)
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch {
    return false
  }
}

async function refuses(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1_000) })
    return false
  }
  catch {
    return true
  }
}

function labRuns(w: World): number {
  return existsSync(w.ranFile) ? readFileSync(w.ranFile, 'utf8').trim().split('\n').length : 0
}

describe('a browser witness and the serve field', () => {
  it('a browser witness is green on a fixture server the node starts and stops', async () => {
    const port = await freePort()
    const w = world({ port, onBase: { 'construct.json': serveOf(port) } })
    await witnessRun(w)
    expect(payloadsOf(w, WITNESS_RECORDED).map(payload => payload.verdict)).toEqual([GREEN])
    expect(labRuns(w)).toBe(2)
    const pid = Number(readFileSync(w.pidFile, 'utf8'))
    await sleep(100)
    expect(alive(pid)).toBe(false)
    expect(await refuses(port)).toBe(true)
  })

  it('a browser witness with no serve in construct.json refuses rather than falls', async () => {
    const port = await freePort()
    const w = world({ port })
    await witnessRun(w)
    expect(payloadsOf(w, WITNESS_RECORDED)).toEqual([])
    expect(payloadsOf(w, CARD_STOPPED)).toEqual([])
    const denied = payloadsOf(w, POLICY_DENIED)
    expect(denied).toHaveLength(1)
    expect(denied[0]?.detail).toContain('no serve in construct.json')
    expect(labRuns(w)).toBe(0)
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).toContain('no serve in construct.json')
  })

  it('a browser witness in an attached repository is served from .construct/attach.json', async () => {
    const port = await freePort()
    const w = world({ port })
    mkdirSync(path.join(w.repo, '.construct'), { recursive: true })
    writeFileSync(path.join(w.repo, '.construct/attach.json'), serveOf(port))
    await witnessRun(w)
    expect(payloadsOf(w, WITNESS_RECORDED).map(payload => payload.verdict)).toEqual([GREEN])
    expect(payloadsOf(w, POLICY_DENIED)).toEqual([])
    expect(labRuns(w)).toBe(2)
  })

  it('a serve declared only on the head counts for the base run too', async () => {
    const port = await freePort()
    const w = world({ port, onHead: { 'construct.json': serveOf(port) } })
    await witnessRun(w)
    expect(payloadsOf(w, WITNESS_RECORDED).map(payload => payload.verdict)).toEqual([GREEN])
  })

  it('a browser witness on a public URL runs with no serve', async () => {
    const port = await freePort()
    const w = world({ port, url: 'https://example.invalid/' })
    await witnessRun(w)
    expect(payloadsOf(w, WITNESS_RECORDED).map(payload => payload.verdict)).toEqual([GREEN])
    expect(payloadsOf(w, POLICY_DENIED)).toEqual([])
  })

  it('a serve that never answers could not check, naming the url, and leaves nothing running', async () => {
    const port = await freePort()
    const w = world({ port, onBase: { 'construct.json': serveOf(port, 'sleep 60', 300) } })
    await witnessRun(w)
    const [record] = payloadsOf(w, WITNESS_RECORDED)
    expect(record?.verdict).toBe(UNCHECKED)
    expect(record?.detail).toContain(`http://127.0.0.1:${port}/ did not answer`)
    expect(labRuns(w)).toBe(0)
  })

  it('a server already answering on the url is not taken for the repository\'s own', async () => {
    const port = await freePort()
    const stranger = createServer(socket => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\ndone')).listen(port, '127.0.0.1')
    try {
      const w = world({ port, onBase: { 'construct.json': serveOf(port) } })
      await witnessRun(w)
      expect(payloadsOf(w, WITNESS_RECORDED)).toEqual([])
      expect(labRuns(w)).toBe(0)
    }
    finally {
      stranger.close()
    }
  })
})
