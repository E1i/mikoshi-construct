import type { DatabaseSync as Bus } from 'node:sqlite'
import type { SeedEvent } from '../../../tests/board/bus-fixture.js'
import type { CardService, EventSlices, SessionCardParts, SessionView, SlicedRow } from '../../cli/board-page/session-card.js'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parkingFileText } from '../../../src/card/parking.js'
import { textSha } from '../../../src/card/text-sha.js'
import { witnessFieldsLine } from '../../../src/card/witness-fields.js'
import { writeBus } from '../../../tests/board/bus-fixture.js'
import { printBoard } from '../../cli/board-page.js'
import { nodeViewOf, sessionCard, SESSIONLESS_ROLES } from '../../cli/board-page/session-card.js'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_ADMITTED, CARD_CLOSED, MERGE_DONE, PR_OBSERVED, TASK_LEASED, UPDATE_DONE, WITNESS_PHASE, WITNESS_RECORDED } from '../../core/events.js'
import { reduce } from '../../core/reducer.js'
import { realTimedShell } from '../../nodes/witness/witness-executor.js'
import { WitnessNode } from '../../nodes/witness/witness-worker.js'
import { SetupTurns, withWorktreeAsync } from '../../ports/worktree.js'
import { busProjections } from '../../supervisor/composition.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'

const NOW = new Date('2026-11-27T08:00:00.000Z')
const CARD = 2361
const ON_BASE = 'base'
const ON_HEAD = 'head'
const TRANSCRIPT_CAPTIONS = /NO TRANSCRIPT READ|LAST · |NOW · |CAUSE UNKNOWN|class="term/
const PARTS: SessionCardParts = { opener: '', hint: '', bars: '', agents: '', over: false, now: NOW.toISOString() }
const OTHER_SESSION_TERMINAL = { name: 'Write', at: '2026-11-27T07:50:00.000Z', endedAt: '2026-11-27T07:51:00.000Z', command: 'report.md' }
const NO_VIEW: SessionView = { startedAt: null, expectedMs: null, steps: [], terminal: null }

interface Seeded extends SlicedRow {
  type: string
}

function minutesAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString()
}

function service(role: string): CardService {
  return { role, task: `#${CARD}`, step: `${role} abc1234` }
}

function slicesOver(rows: readonly Omit<Seeded, 'id'>[]): EventSlices {
  const seeded = rows.map((row, at) => ({ ...row, id: at + 1 }))
  return (type, _fields, from, last) => {
    const matched = seeded.filter(row => row.type === type && row.id >= from)
    return last ? matched.slice(-1) : matched
  }
}

function row(type: string, minutes: number, fields: Record<string, unknown>): Omit<Seeded, 'id'> {
  return { type, ts: minutesAgo(minutes), fields }
}

function witnessView(phases: { phase: string, witness: string, minutes: number }[], terminal: SessionView['terminal'] = OTHER_SESSION_TERMINAL): SessionView {
  return { startedAt: minutesAgo(6), expectedMs: null, steps: [], terminal, node: { phases: phases.map(({ phase, witness, minutes }) => ({ phase, witness, at: minutesAgo(minutes) })), outcome: null } }
}

describe('a sessionless node tile', () => {
  it('a witness tile renders its base and head steps and no transcript line', () => {
    const tile = sessionCard(service('witness'), witnessView([{ phase: ON_BASE, witness: 'W1', minutes: 5 }, { phase: ON_HEAD, witness: 'W1', minutes: 2 }]), PARTS)
    expect(tile).toContain('<div class="round-steps" data-node="witness"><ol><li data-passed>base</li><li data-current>head</li><li>verdict</li></ol><span class="round-step-now">W1 · head · 2 min</span></div>')
    expect(tile).toContain('<div class="svc-state" data-state="acting">RUNNING · W1 ON HEAD</div>')
    expect(tile).not.toMatch(TRANSCRIPT_CAPTIONS)
    expect(tile).not.toContain('report.md')
    const leased = sessionCard(service('witness'), { ...NO_VIEW, startedAt: minutesAgo(3) }, PARTS)
    expect(leased).toContain('<ol><li>base</li><li>head</li><li>verdict</li></ol><span class="round-step-now">leased · 3 min</span>')
    expect(leased).not.toMatch(TRANSCRIPT_CAPTIONS)
  })

  it('a witness tile shows the verdict once recorded', () => {
    const view: SessionView = { ...witnessView([{ phase: ON_BASE, witness: 'W1', minutes: 5 }, { phase: ON_HEAD, witness: 'W1', minutes: 2 }]), node: { phases: [], outcome: { word: 'green', at: minutesAgo(1) } } }
    const tile = sessionCard(service('witness'), view, PARTS)
    expect(tile).toContain('<ol><li data-passed>base</li><li data-passed>head</li><li data-passed>verdict</li></ol><span class="round-step-now">green · recorded 07:59:00</span>')
    expect(tile).toContain('RECORDED · GREEN')
    expect(tile).not.toMatch(TRANSCRIPT_CAPTIONS)
  })

  it('update, merge and close tiles show their lease time and recorded outcome and no transcript line', () => {
    expect([...SESSIONLESS_ROLES].sort()).toEqual(['close', 'merge', 'update', 'witness'])
    for (const role of ['update', 'merge', 'close']) {
      const tile = sessionCard(service(role), { startedAt: minutesAgo(4), expectedMs: null, steps: [], terminal: OTHER_SESSION_TERMINAL }, PARTS)
      expect(tile).toContain(`<div class="round-steps" data-node="${role}"><span class="round-step-now">leased · 4 min</span></div>`)
      expect(tile).not.toMatch(TRANSCRIPT_CAPTIONS)
    }
    const merged = sessionCard(service('merge'), nodeViewOf(slicesOver([row(TASK_LEASED, 3, { queue: 'merge' }), row(MERGE_DONE, 1, { commit: 'f'.repeat(40) })]), 'merge'), PARTS)
    expect(merged).toContain('<span class="round-step-now">merged · recorded 07:59:00</span>')
    expect(merged).toContain('RECORDED · MERGED')
  })

  it('the node view reads only the steps and outcome recorded after its own lease', () => {
    const slices = slicesOver([
      row(WITNESS_PHASE, 30, { phase: ON_BASE, witness: 'W9' }),
      row(WITNESS_RECORDED, 29, { verdict: 'red' }),
      row(TASK_LEASED, 7, { queue: 'answer' }),
      row(TASK_LEASED, 6, { queue: 'witness' }),
      row(WITNESS_PHASE, 5, { phase: ON_BASE, witness: 'W1' }),
      row(WITNESS_PHASE, 2, { phase: ON_HEAD, witness: 'W1' }),
    ])
    const view = nodeViewOf(slices, 'witness')
    expect(view).toEqual({ startedAt: minutesAgo(6), expectedMs: null, steps: [], terminal: null, node: { phases: [{ phase: ON_BASE, witness: 'W1', at: minutesAgo(5) }, { phase: ON_HEAD, witness: 'W1', at: minutesAgo(2) }], outcome: null } })
  })

  it('the node view anchors on its own queue lease when a later lease of another queue follows it', () => {
    const slices = slicesOver([
      row(TASK_LEASED, 6, { queue: 'witness' }),
      row(WITNESS_PHASE, 5, { phase: ON_BASE, witness: 'W1' }),
      row(TASK_LEASED, 4, { queue: 'review' }),
      row(WITNESS_PHASE, 2, { phase: ON_HEAD, witness: 'W1' }),
    ])
    const view = nodeViewOf(slices, 'witness')
    expect(view.startedAt).toBe(minutesAgo(6))
    expect(view.node?.phases.map(({ phase }) => phase)).toEqual([ON_BASE, ON_HEAD])
  })

  it('a witness tile reads its verdict from the witness.recorded row after its lease', () => {
    const slices = slicesOver([
      row(TASK_LEASED, 6, { queue: 'witness' }),
      row(WITNESS_PHASE, 5, { phase: ON_BASE, witness: 'W1' }),
      row(WITNESS_PHASE, 2, { phase: ON_HEAD, witness: 'W1' }),
      row(WITNESS_RECORDED, 1, { verdict: 'green' }),
    ])
    const tile = sessionCard(service('witness'), nodeViewOf(slices, 'witness'), PARTS)
    expect(tile).toContain('RECORDED · GREEN')
    expect(tile).toContain('<span class="round-step-now">green · recorded 07:59:00</span>')
  })

  it('update and close tiles read their recorded outcome after their own lease', () => {
    const updated = sessionCard(service('update'), nodeViewOf(slicesOver([row(TASK_LEASED, 3, { queue: 'update' }), row(UPDATE_DONE, 1, { head: 'a'.repeat(40) })]), 'update'), PARTS)
    expect(updated).toContain('<span class="round-step-now">updated · recorded 07:59:00</span>')
    expect(updated).toContain('RECORDED · UPDATED')
    const closed = sessionCard(service('close'), nodeViewOf(slicesOver([row(TASK_LEASED, 3, { queue: 'close' }), row(CARD_CLOSED, 1, { reason: 'merged' })]), 'close'), PARTS)
    expect(closed).toContain('<span class="round-step-now">closed · recorded 07:59:00</span>')
    expect(closed).toContain('RECORDED · CLOSED')
  })

  it('an update tile reads no witness phase recorded after its lease and stays leased', () => {
    const view = nodeViewOf(slicesOver([row(TASK_LEASED, 4, { queue: 'update' }), row(WITNESS_PHASE, 2, { phase: ON_BASE, witness: 'W1' })]), 'update')
    expect(view.node?.phases).toEqual([])
    expect(sessionCard(service('update'), view, PARTS)).toContain('<span class="round-step-now">leased · 4 min</span>')
  })
})

const roots: string[] = []
const buses: Bus[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const bus of buses.splice(0))
    bus.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function rootOf(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix))
  roots.push(root)
  return root
}

function nodeEvent(type: string, minutes: number, payload: Record<string, unknown>): SeedEvent {
  return { ts: minutesAgo(minutes), type, card: CARD, payload: JSON.stringify(payload) }
}

function boardTileOf(queue: string, events: SeedEvent[]): string {
  const root = rootOf('board-sessionless-tile-')
  const busPath = path.join(root, 'bus.db')
  writeBus(busPath, { cards: [{ id: CARD, state: 'review', lane: 'lane-1', line: `#${CARD} sessionless [implement/construct/S/cheap/auto]`, since: minutesAgo(40) }], tasks: [{ queue, card: CARD, pr: 15, head: 'abc1234', state: 'leased' }], events })
  const db = new DatabaseSync(busPath)
  db.exec('ALTER TABLE card_bodies ADD COLUMN admission_event_id INTEGER; ALTER TABLE card_bodies ADD COLUMN text_sha TEXT NOT NULL DEFAULT \'\'')
  db.close()
  const eddiesFile = path.join(root, 'eddies.json')
  writeFileSync(eddiesFile, JSON.stringify({ contextLimit: 1_000_000, sessionSpend: 10_000_000, agentSpend: 1_000_000, warnRatio: 0.8 }))
  let html = ''
  expect(printBoard(busPath, NOW, (text) => {
    html += text
  }, path.join(root, 'miko.md'), 'html', eddiesFile)).toBe(0)
  const start = html.indexOf(`<div class="svc bevel" data-role="${queue}"`)
  expect(start).toBeGreaterThanOrEqual(0)
  const next = html.indexOf('<div class="svc bevel"', start + 1)
  return html.slice(start, next === -1 ? undefined : next)
}

describe('a sessionless node tile on the board page', () => {
  it('a witness tile shows no step or outcome the bus recorded before its own lease', () => {
    const tile = boardTileOf('witness', [
      nodeEvent(WITNESS_PHASE, 30, { phase: ON_BASE, witness: 'W9', task_key: `witness:${CARD}` }),
      nodeEvent(WITNESS_RECORDED, 29, { verdict: 'red' }),
      nodeEvent(MERGE_DONE, 28, { commit: 'e'.repeat(40) }),
      nodeEvent(TASK_LEASED, 6, { queue: 'witness' }),
      nodeEvent(WITNESS_PHASE, 5, { phase: ON_BASE, witness: 'W1', task_key: `witness:${CARD}` }),
    ])
    expect(tile).toContain('<span class="round-step-now">W1 · base · 5 min</span>')
    expect(tile).not.toContain('W9')
    expect(tile).not.toContain('RECORDED · RED')
  })

  it('a witness tile shows the latest of two verdicts recorded after its lease', () => {
    const tile = boardTileOf('witness', [
      nodeEvent(TASK_LEASED, 6, { queue: 'witness' }),
      nodeEvent(WITNESS_RECORDED, 4, { verdict: 'red' }),
      nodeEvent(WITNESS_RECORDED, 1, { verdict: 'green' }),
    ])
    expect(tile).toContain('RECORDED · GREEN')
    expect(tile).toContain('<span class="round-step-now">green · recorded 07:59:00</span>')
    expect(tile).not.toContain('RECORDED · RED')
  })
})

const WITNESSED_CARD = 2371
const WITNESSED_PR = 1371

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, '-c', 'user.name=bus', '-c', 'user.email=bus@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim()
}

function commit(repo: string, file: string): string {
  writeFileSync(path.join(repo, file), `${file}\n`)
  git(repo, 'add', file)
  git(repo, 'commit', '-q', '-m', file)
  return git(repo, 'rev-parse', 'HEAD')
}

async function phasesWitnessedOn(body: string): Promise<string[]> {
  const root = rootOf('witness-steps-')
  const repo = path.join(root, 'repo')
  execFileSync('git', ['init', '-q', repo])
  const base = commit(repo, 'README.md')
  const head = commit(repo, 'done.txt')
  const db = openBus(path.join(root, 'bus.db'))
  buses.push(db)
  const text = parkingFileText({ card: `#${WITNESSED_CARD} witnessed [implement/netwatch/S/cheap/auto] · depends — · blocks —`, branch: 'feat/witnessed', touches: ['done.txt'], continue: 'stop', who: 'shift', body })
  appendEvent(db, { ts: '2026-10-21T10:00:00.000Z', type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: WITNESSED_CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${WITNESSED_CARD}`, payload: { card: `#${WITNESSED_CARD}`, lane: 'lane-1', text, textSha: textSha(text), bodySha: textSha(text).slice(0, 12) }, legacy: false })
  appendEvent(db, { ts: '2026-10-21T10:01:00.000Z', type: PR_OBSERVED, actor: 'netwatch', cardId: WITNESSED_CARD, pr: WITNESSED_PR, head, dedupeKey: `${PR_OBSERVED}:${WITNESSED_PR}:${head}`, payload: { card_id: WITNESSED_CARD, base: 'main', head, mergeable: 'clean', ci: 'green', auto_merge: false, draft: false, body_sha: 'a'.repeat(64) }, legacy: false })
  reduce(db, 'pending', busProjections())
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const turns = new SetupTurns()
  const node = new WitnessNode({ silentMs: SILENT_MS, db, clock: () => new Date('2026-10-21T10:02:00.000Z'), session: 'witness-1', mode: 'live', env: {}, shell: realTimedShell, trees: { baseOf: async () => base, withTree: (onBase, run) => withWorktreeAsync(repo, onBase, run, turns) } })
  for (let round = 0; round < 2; round += 1) {
    const controller = new AbortController()
    await node.run({ pause: async () => controller.abort(), signal: controller.signal })
  }
  return (db.prepare('SELECT payload FROM events WHERE type = ? ORDER BY id').all(WITNESS_PHASE) as { payload: string }[]).map(({ payload }) => JSON.parse(payload) as Record<string, string>).map(({ phase, witness }) => `${witness} ${phase}`)
}

describe('the steps a witness tile reads', () => {
  it('a witness whose base runs another command than its head records its base step under its witness id', async () => {
    const body = `Write done.txt.\n\n${witnessFieldsLine([{ id: 'W4', run: 'test ! -f done.txt || exit 3', test: null, head: 'exit:3', base: 'pass', proves: 'the head exits 3 where the base passes' }])}`
    expect(await phasesWitnessedOn(body)).toEqual(['W4 base', 'W4 head'])
  })
})
