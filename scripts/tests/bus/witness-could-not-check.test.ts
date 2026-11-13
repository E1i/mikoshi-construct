import type { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parkingFileText } from '../../../src/card/parking.js'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_ADMITTED, POLICY_DENIED, PR_OBSERVED, WITNESS_RECORDED } from '../../core/events.js'
import { answerCandidates, witnessCandidates } from '../../core/queue.js'
import { reduce } from '../../core/reducer.js'
import { realTimedShell } from '../../nodes/witness/witness-executor.js'
import { WitnessNode } from '../../nodes/witness/witness-worker.js'
import { GREEN, RED, UNCHECKED, witnessDenial, witnessRecordOf, witnessSubjectOf } from '../../policy/policy.js'
import { SetupTurns, withWorktreeAsync } from '../../ports/worktree.js'
import { greenWitnesses } from '../../release/evidence.js'
import { busProjections } from '../../supervisor/composition.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'

const CARD = 1698
const PR = 2698
const NOW = '2026-11-07T10:02:00.000Z'
const LAB = 'scripts/construct/browser-lab.mjs'
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

const LAB_TEXT = `import process from 'node:process'
const body = await (await fetch(process.argv[3])).text()
process.exit(body === 'done' ? 0 : 1)
`

function serverText(port: number, body: string): string {
  return `import http from 'node:http'
http.createServer((_, response) => response.end(${JSON.stringify(body)})).listen(${port}, '127.0.0.1')
`
}

function serveOf(port: number, command: string, readyTimeoutMs: number): string {
  return JSON.stringify({ serve: { command, url: `http://127.0.0.1:${port}/`, readyTimeoutMs } })
}

interface World {
  db: DatabaseSync
  bus: string
  repo: string
  base: string
  head: string
}

function world(port: number, onBase: Record<string, string>, onHead: Record<string, string>): World {
  const root = mkdtempSync(path.join(tmpdir(), 'witness-could-not-check-'))
  roots.push(root)
  const repo = path.join(root, 'repo')
  execFileSync('git', ['init', '-q', repo])
  const base = commit(repo, { 'README.md': 'base\n', [LAB]: LAB_TEXT, ...onBase }, 'base')
  const head = commit(repo, { 'done.txt': 'done\n', ...onHead }, 'head')
  const bus = path.join(root, 'bus.db')
  const db = openBus(bus)
  dbs.push(db)
  const body = `Serve the page.\n\nWitnesses:\n- \`node ${LAB} page http://127.0.0.1:${port}/\` exits 0; red on main`
  const text = parkingFileText({ card: `#${CARD} unchecked [implement/construct/S/cheap/auto] · depends — · blocks —`, branch: 'feat/unchecked', touches: ['done.txt'], continue: 'stop', who: 'shift', body })
  appendEvent(db, { ts: '2026-11-07T10:00:00.000Z', type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${CARD}`, payload: { card: `#${CARD}`, lane: 'lane-1', text, textSha: textSha(text), bodySha: textSha(text).slice(0, 12) }, legacy: false })
  appendEvent(db, { ts: '2026-11-07T10:01:00.000Z', type: PR_OBSERVED, actor: 'netwatch', cardId: CARD, pr: PR, head, dedupeKey: `${PR_OBSERVED}:${PR}:${head}`, payload: { card_id: CARD, base: 'main', head, mergeable: 'clean', ci: 'green', auto_merge: false, draft: false, body_sha: 'a'.repeat(64) }, legacy: false })
  reduce(db, 'pending', busProjections())
  return { db, bus, repo, base, head }
}

async function neverAnswering(): Promise<World> {
  const port = await freePort()
  return world(port, { 'construct.json': serveOf(port, 'sleep 60', 300) }, {})
}

async function answeringButFailing(): Promise<World> {
  const port = await freePort()
  return world(port, { 'construct.json': serveOf(port, 'node server.mjs', 10_000), 'server.mjs': serverText(port, 'not yet') }, {})
}

async function witnessRun(w: World): Promise<void> {
  const turns = new SetupTurns()
  const trees = { baseOf: async () => w.base, withTree: <T>(base: string, run: (tree: string) => Promise<T>) => withWorktreeAsync(w.repo, base, run, turns) }
  const node = new WitnessNode({ silentMs: SILENT_MS, db: w.db, clock: () => new Date(NOW), session: 'witness-1', mode: 'live', env: {}, shell: realTimedShell, trees })
  for (let round = 0; round < 2; round += 1) {
    const controller = new AbortController()
    await node.run({ pause: async () => controller.abort(), signal: controller.signal })
  }
}

function verdictsOf(w: World): unknown[] {
  return (w.db.prepare('SELECT payload FROM events WHERE type = ?').all(WITNESS_RECORDED) as { payload: string }[]).map(row => (JSON.parse(row.payload) as { verdict: unknown }).verdict)
}

function stored(w: World, verdict: unknown, at: string): void {
  const cardBody = witnessSubjectOf(w.db, CARD)!.cardBody
  appendEvent(w.db, { ts: at, type: WITNESS_RECORDED, actor: 'worker:witness:older', cardId: CARD, pr: PR, head: w.head, dedupeKey: `${WITNESS_RECORDED}:older:${at}`, payload: { head: w.head, base: w.base, cardBody, verdict, detail: `stored ${String(verdict)}` }, legacy: false })
}

function readVerdict(w: World): unknown {
  return witnessRecordOf(w.db, CARD, w.head, w.base, witnessSubjectOf(w.db, CARD)!.cardBody)?.verdict
}

function answeredCards(w: World): number[] {
  reduce(w.db, 'pending', busProjections())
  return answerCandidates(w.db, NOW).map(task => task.cardId)
}

describe('the witness tells could not check from failed', () => {
  it('a server that never answered records could not check and not red', async () => {
    const w = await neverAnswering()
    await witnessRun(w)
    expect(verdictsOf(w)).toEqual([UNCHECKED])
  })

  it('could not check queues no answer round', async () => {
    const w = await neverAnswering()
    await witnessRun(w)
    expect(answeredCards(w)).not.toContain(CARD)
  })

  it('could not check does not let the pull request merge', async () => {
    const w = await neverAnswering()
    await witnessRun(w)
    const denial = witnessDenial(w.db, CARD, w.head, w.base)
    expect(denial?.detail).toContain('could not check')
    expect(denial?.detail).not.toContain('is red')
  })

  it('a witness that ran and failed stays red', async () => {
    const w = await answeringButFailing()
    await witnessRun(w)
    expect(verdictsOf(w)).toEqual([RED])
    expect(witnessDenial(w.db, CARD, w.head, w.base)?.detail).toContain('is red')
    expect(answeredCards(w)).toContain(CARD)
  })

  it('an older event keeps its verdict and is not rewritten', async () => {
    const w = world(await freePort(), {}, {})
    stored(w, 'failed', '2026-11-07T10:01:10.000Z')
    expect(readVerdict(w)).toBe(RED)
    stored(w, RED, '2026-11-07T10:01:20.000Z')
    expect(readVerdict(w)).toBe(RED)
    stored(w, GREEN, '2026-11-07T10:01:30.000Z')
    expect(readVerdict(w)).toBe(GREEN)
    expect(verdictsOf(w)).toEqual(['failed', RED, GREEN])
  })

  it('an unchecked last witness is not counted green in the release evidence', async () => {
    const w = world(await freePort(), {}, {})
    stored(w, GREEN, '2026-11-07T10:01:10.000Z')
    expect(greenWitnesses(w.bus).map(green => green.task)).toEqual([String(CARD)])
    stored(w, UNCHECKED, '2026-11-07T10:01:20.000Z')
    expect(readVerdict(w)).toBe(UNCHECKED)
    expect(greenWitnesses(w.bus)).toEqual([])
  })

  it('could not check runs the witness again when a merge is denied on a newer base, and not on the same one', async () => {
    const w = world(await freePort(), {}, {})
    stored(w, UNCHECKED, '2026-11-07T10:01:10.000Z')
    const witnessed = (): number[] => {
      reduce(w.db, 'pending', busProjections())
      return witnessCandidates(w.db, NOW).map(task => task.cardId)
    }
    const deniedOn = (base: string, at: string): void => {
      appendEvent(w.db, { ts: at, type: POLICY_DENIED, actor: 'policy', cardId: CARD, pr: PR, head: w.head, dedupeKey: `${POLICY_DENIED}:merge:${at}`, payload: { command: 'merge', reason: 'witness', base, detail: 'denied' }, legacy: false })
    }
    expect(witnessed()).not.toContain(CARD)
    deniedOn(w.base, '2026-11-07T10:01:20.000Z')
    expect(witnessed()).not.toContain(CARD)
    deniedOn('c'.repeat(40), '2026-11-07T10:01:30.000Z')
    expect(witnessed()).toContain(CARD)
  })
})
