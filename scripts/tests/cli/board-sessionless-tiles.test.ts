import type { BusService } from '../../../src/commands/board/bus.js'
import type { SeedEvent } from '../../../tests/board/bus-fixture.js'
import type { SessionCardParts, SessionView } from '../../cli/board-page/session-card.js'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parkingFileText } from '../../../src/card/parking.js'
import { textSha } from '../../../src/card/text-sha.js'
import { writeBus } from '../../../tests/board/bus-fixture.js'
import { printBoard } from '../../cli/board-page.js'
import { nodeViewOf, sessionCard, SESSIONLESS_ROLES } from '../../cli/board-page/session-card.js'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_ADMITTED, CARD_STARTED, MERGE_DONE, PR_OBSERVED, TASK_LEASED, WITNESS_PHASE } from '../../core/events.js'
import { reduce } from '../../core/reducer.js'
import { ON_BASE, ON_HEAD, realTimedShell } from '../../nodes/witness/witness-executor.js'
import { WitnessNode } from '../../nodes/witness/witness-worker.js'
import { BusRead } from '../../ports/bus-read.js'
import { SetupTurns, withWorktreeAsync } from '../../ports/worktree.js'
import { busProjections } from '../../supervisor/composition.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'

const NOW = new Date('2026-11-27T08:00:00.000Z')
const CARD = 2361
const PR = 2401
const TRANSCRIPT_CAPTIONS = /NO TRANSCRIPT READ|LAST · |NOW · |CAUSE UNKNOWN|class="term/
const PARTS: SessionCardParts = { opener: '', hint: '', bars: '', agents: '', over: false, now: NOW.toISOString() }
const OTHER_SESSION_TERMINAL = { name: 'Write', at: '2026-11-27T07:50:00.000Z', endedAt: '2026-11-27T07:51:00.000Z', command: 'report.md' }
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

function scratch(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function minutesAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString()
}

function event(type: string, minutes: number, payload: Record<string, unknown>): SeedEvent {
  return { ts: minutesAgo(minutes), type, card: CARD, payload: JSON.stringify(payload) }
}

function boardWith(queue: string, events: SeedEvent[]): string {
  const root = scratch('board-sessionless-')
  const busPath = path.join(root, 'bus.db')
  writeBus(busPath, { cards: [{ id: CARD, state: 'review', lane: 'lane-1', line: `#${CARD} sessionless [implement/construct/L/cheap/auto]`, since: minutesAgo(30) }], tasks: [{ queue, card: CARD, pr: PR, head: 'abc1234', state: 'leased' }], events })
  const db = new DatabaseSync(busPath)
  db.exec('ALTER TABLE card_bodies ADD COLUMN admission_event_id INTEGER; ALTER TABLE card_bodies ADD COLUMN text_sha TEXT NOT NULL DEFAULT \'\'')
  db.close()
  const eddiesFile = path.join(root, 'eddies.json')
  writeFileSync(eddiesFile, JSON.stringify({ contextLimit: 1_000_000, sessionSpend: 10_000_000, agentSpend: 1_000_000, warnRatio: 0.8 }))
  let html = ''
  expect(printBoard(busPath, NOW, (text) => {
    html += text
  }, path.join(root, 'miko.md'), 'html', eddiesFile)).toBe(0)
  return html
}

function tileOf(html: string, role: string): string {
  const start = html.indexOf(`<div class="svc bevel" data-role="${role}"`)
  expect(start).toBeGreaterThanOrEqual(0)
  return html.slice(start, !html.includes('<div class="svc bevel"', start + 1) ? undefined : html.indexOf('<div class="svc bevel"', start + 1))
}

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, '-c', 'user.name=bus', '-c', 'user.email=bus@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim()
}

function commit(repo: string, file: string): string {
  writeFileSync(path.join(repo, file), `${file}\n`)
  git(repo, 'add', file)
  git(repo, 'commit', '-q', '-m', file)
  return git(repo, 'rev-parse', 'HEAD')
}

describe('a sessionless node tile', () => {
  it('a witness tile renders its base and head steps and no transcript line', () => {
    const html = boardWith('witness', [
      event(CARD_STARTED, 20, { session: 'launch-session', worktree: '/nowhere/2361' }),
      event(TASK_LEASED, 6, { queue: 'witness' }),
      event(WITNESS_PHASE, 5, { phase: ON_BASE, witness: 'W1', task_key: 'witness:2361' }),
      event(WITNESS_PHASE, 2, { phase: ON_HEAD, witness: 'W1', task_key: 'witness:2361' }),
    ])
    const tile = tileOf(html, 'witness')
    expect(tile).toContain('<div class="round-steps" data-node="witness"><ol><li data-passed>base</li><li data-current>head</li><li>verdict</li></ol><span class="round-step-now">W1 · head · 2 min</span></div>')
    expect(tile).toContain('<div class="svc-state" data-state="acting">RUNNING · W1 ON HEAD</div>')
    expect(tile).not.toMatch(TRANSCRIPT_CAPTIONS)
  })

  it('a witness tile never renders a terminal handed to it, and shows the verdict once recorded', () => {
    const service: BusService = { role: 'witness', task: `#${CARD}`, tree: null, step: 'witness abc1234' }
    const view: SessionView = { startedAt: minutesAgo(6), expectedMs: null, steps: [], terminal: OTHER_SESSION_TERMINAL, node: { phases: [{ phase: ON_BASE, witness: 'W1', at: minutesAgo(5) }, { phase: ON_HEAD, witness: 'W1', at: minutesAgo(2) }], outcome: { word: 'green', at: minutesAgo(1) } } }
    const tile = sessionCard(service, view, PARTS)
    expect(tile).toContain('<ol><li data-passed>base</li><li data-passed>head</li><li data-passed>verdict</li></ol><span class="round-step-now">green · recorded 07:59:00</span>')
    expect(tile).toContain('RECORDED · GREEN')
    expect(tile).not.toMatch(TRANSCRIPT_CAPTIONS)
    expect(tile).not.toContain('report.md')
  })

  it('update, merge and close tiles show their lease time and recorded outcome and no transcript line', () => {
    expect([...SESSIONLESS_ROLES].sort()).toEqual(['close', 'merge', 'update', 'witness'])
    const merge = tileOf(boardWith('merge', [event(CARD_STARTED, 20, { session: 'launch-session', worktree: '/nowhere/2361' }), event(TASK_LEASED, 3, { queue: 'merge' })]), 'merge')
    expect(merge).toContain('<div class="round-steps" data-node="merge"><span class="round-step-now">leased · 3 min</span></div>')
    expect(merge).toContain('ROUND TIME ELAPSED')
    expect(merge).not.toMatch(TRANSCRIPT_CAPTIONS)
    const merged = tileOf(boardWith('merge', [event(TASK_LEASED, 3, { queue: 'merge' }), event(MERGE_DONE, 1, { commit: 'f'.repeat(40) })]), 'merge')
    expect(merged).toContain('<span class="round-step-now">merged · recorded 07:59:00</span>')
    expect(merged).toContain('RECORDED · MERGED')
    for (const role of ['update', 'close']) {
      const tile = sessionCard({ role, task: `#${CARD}`, tree: null, step: role }, { startedAt: minutesAgo(4), expectedMs: null, steps: [], terminal: OTHER_SESSION_TERMINAL }, PARTS)
      expect(tile).toContain('leased · 4 min')
      expect(tile).not.toMatch(TRANSCRIPT_CAPTIONS)
    }
  })

  it('the witness executor records one step per phase with the witness id, and the board reads them', async () => {
    const root = scratch('witness-phases-')
    const repo = path.join(root, 'repo')
    execFileSync('git', ['init', '-q', repo])
    const base = commit(repo, 'README.md')
    const head = commit(repo, 'done.txt')
    const db = openBus(path.join(root, 'bus.db'))
    dbs.push(db)
    const text = parkingFileText({ card: `#${CARD} phases [implement/netwatch/S/cheap/auto] · depends — · blocks —`, branch: 'feat/phases', touches: ['done.txt'], continue: 'stop', who: 'shift', body: 'Write done.txt.\n\nWitnesses:\n- `test -f done.txt` exits 0; red on main\n- `test -f README.md` exits 0' })
    appendEvent(db, { ts: '2026-11-27T07:00:00.000Z', type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${CARD}`, payload: { card: `#${CARD}`, lane: 'lane-1', text, textSha: textSha(text), bodySha: textSha(text).slice(0, 12) }, legacy: false })
    appendEvent(db, { ts: '2026-11-27T07:01:00.000Z', type: PR_OBSERVED, actor: 'netwatch', cardId: CARD, pr: PR, head, dedupeKey: `${PR_OBSERVED}:${PR}:${head}`, payload: { card_id: CARD, base: 'main', head, mergeable: 'clean', ci: 'green', auto_merge: false, draft: false, body_sha: 'a'.repeat(64) }, legacy: false })
    reduce(db, 'pending', busProjections())
    const turns = new SetupTurns()
    const node = new WitnessNode({ silentMs: SILENT_MS, db, clock: () => new Date('2026-11-27T07:02:00.000Z'), session: 'witness-1', mode: 'live', env: {}, shell: realTimedShell, trees: { baseOf: async () => base, withTree: (tree, run) => withWorktreeAsync(repo, tree, run, turns) } })
    for (let round = 0; round < 2; round += 1) {
      const controller = new AbortController()
      await node.run({ pause: async () => controller.abort(), signal: controller.signal })
    }
    const phases = (db.prepare('SELECT payload FROM events WHERE type = ? ORDER BY id').all(WITNESS_PHASE) as { payload: string }[]).map(row => JSON.parse(row.payload) as Record<string, string>)
    expect(phases.map(({ phase, witness }) => `${witness} ${phase}`)).toEqual(['W1 base', 'W2 base', 'W1 head', 'W2 head'])
    expect(new Set(phases.map(phase => phase.task_key)).size).toBe(1)
    const view = nodeViewOf(new BusRead(db).where({ card: CARD }), 'witness')
    expect(view.node).toEqual({ phases: [expect.objectContaining({ phase: ON_BASE, witness: 'W1' }), expect.objectContaining({ phase: ON_BASE, witness: 'W2' }), expect.objectContaining({ phase: ON_HEAD, witness: 'W1' }), expect.objectContaining({ phase: ON_HEAD, witness: 'W2' })], outcome: { word: 'green', at: '2026-11-27T07:02:00.000Z' } })
    expect(view.terminal).toBeNull()
  })
})
