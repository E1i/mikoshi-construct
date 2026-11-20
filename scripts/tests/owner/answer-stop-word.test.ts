import type { ChildProcess } from 'node:child_process'
import type { ProcessTable } from '../../nodes/restart/chain-process.js'
import type { Executed, RequestPayload } from '../../window/requests/request.js'
import type { MergeBench } from '../bus/merge-bench.js'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent } from '../../core/db.js'
import { CARD_ADMITTED, CARD_STARTED, CARD_STOPPED, COMMAND_EXECUTED, WINDOW_REQUEST } from '../../core/events.js'
import { OWNER } from '../../core/inbox.js'
import { reduce } from '../../core/reducer.js'
import { LaunchNode } from '../../nodes/launch/launch-worker.js'
import { REAL_PROCESSES } from '../../nodes/restart/chain-process.js'
import { runOwnerAnswer, stopReasonOf } from '../../owner/answer.js'
import { DISK_FLOOR_BYTES } from '../../ports/disk.js'
import { busProjections } from '../../supervisor/composition.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { RequestContext } from '../../window/requests/context.js'
import { OWNER_STOP_CODE, ownerStopExecutor } from '../../window/requests/owner-stop.js'
import { requestFromWindow } from '../../window/window-requests.js'
import { mergeBench } from '../bus/merge-bench.js'

const CARD = 1950
const SESSION = 's-1950-stop-word'
const REASON = 'the round went the wrong way'
const BODY = `card: #${CARD} stop-word [implement/construct/S/cheap/owner] · depends — · blocks —\n\nThe owner stops it.\n`

interface Room {
  bench: MergeBench
  root: string
  tree: string
  child: ChildProcess | null
}

const rooms: Room[] = []

afterEach(() => {
  for (const made of rooms.splice(0)) {
    if (made.child?.pid !== undefined && made.child.exitCode === null && made.child.signalCode === null)
      process.kill(-made.child.pid, 'SIGKILL')
    made.bench.close()
    rmSync(made.root, { recursive: true, force: true })
  }
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch {
    return false
  }
}

async function ended(child: ChildProcess): Promise<NodeJS.Signals | null> {
  if (child.exitCode !== null || child.signalCode !== null)
    return child.signalCode
  const [, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null]
  return signal
}

function now(made: Room): string {
  return made.bench.clock.now().toISOString()
}

function room(): Room {
  const root = mkdtempSync(path.join(tmpdir(), 'stop-word-'))
  const tree = path.join(root, 'tree')
  mkdirSync(tree)
  writeFileSync(path.join(tree, 'uncommitted.ts'), 'export const halfDone = 1\n')
  const made: Room = { bench: mergeBench(), root, tree, child: null }
  rooms.push(made)
  appendEvent(made.bench.db, { ts: now(made), type: CARD_ADMITTED, actor: 'policy', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:stop-word`, payload: { lane: 'lane-a', decision: 'auto', contour: 'cheap', depends: [], admission: 'stop-word', text: BODY, textSha: textSha(BODY) }, legacy: false })
  made.bench.tick()
  return made
}

function liveSession(made: Room): number {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', SESSION], { detached: true, stdio: 'ignore' })
  made.child = child
  const pid = child.pid!
  appendEvent(made.bench.db, { ts: now(made), type: CARD_STARTED, actor: 'worker:launch:node-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:stop-word`, payload: { session: SESSION, worktree: made.tree, branch: `feat/card-${CARD}`, base: 'f'.repeat(40), pid, pgid: pid, contour: 'cheap' }, legacy: false })
  reduce(made.bench.db, 'pending', busProjections())
  return pid
}

function running(made: Room): boolean {
  return made.child !== null && made.child.exitCode === null && made.child.signalCode === null
}

function processes(made: Room): ProcessTable {
  return { commandLine: pid => running(made) && pid === made.child!.pid ? `${process.execPath} -e setInterval ${SESSION}` : null, signalGroup: REAL_PROCESSES.signalGroup }
}

function busRuns(made: Room): Executed {
  const refuse = (): never => {
    throw new Error('the owner stop calls no other tool')
  }
  const request = made.bench.db.prepare('SELECT id, payload FROM events WHERE type = ? ORDER BY id DESC LIMIT 1').get(WINDOW_REQUEST) as { id: number, payload: string }
  const context = new RequestContext(made.bench.db, made.bench.clock.now, { treeOf: refuse, exists: existsSync, cutTree: refuse, dryRunOf: refuse, addDecision: refuse, causeHolds: () => null, closePr: refuse, closeDropped: () => [] }, path.join(made.root, 'owner-answers'), () => null, made.root, made.bench.gitHub.client)
  return ownerStopExecutor(processes(made))(context, request.id, JSON.parse(request.payload) as RequestPayload)
}

function launchNode(made: Room): LaunchNode {
  const starter = { start: (): never => {
    throw new Error('nothing starts here')
  }, stop: () => {} }
  return new LaunchNode({ silentMs: SILENT_MS, db: made.bench.db, starter, clock: made.bench.clock.now, session: 'node-1', mode: 'live', env: {}, processes: processes(made), pidAlive: () => running(made), collected: () => null, disk: () => ({ bavail: 1, bsize: DISK_FLOOR_BYTES }), isolation: () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] }) })
}

function stops(made: Room): { actor: string, payload: Record<string, unknown> }[] {
  return (made.bench.db.prepare('SELECT actor, payload FROM events WHERE type = ? AND card_id = ? ORDER BY id').all(CARD_STOPPED, CARD) as { actor: string, payload: string }[]).map(row => ({ actor: row.actor, payload: JSON.parse(row.payload) as Record<string, unknown> }))
}

function leasedTasks(made: Room): unknown[] {
  return made.bench.db.prepare(`SELECT task_key FROM tasks WHERE card_id = ? AND state = 'leased'`).all(CARD)
}

describe('owner:answer with a stop word', () => {
  it('reads the reason only from a stop word', () => {
    expect(stopReasonOf(`stop: ${REASON}`)).toBe(REASON)
    expect(stopReasonOf('Stop:   wrong tree ')).toBe('wrong tree')
    expect(stopReasonOf('stop:')).toBeNull()
    expect(stopReasonOf('please stop: later')).toBeNull()
  })

  it('owner:answer with a stop word ends the process group and keeps uncommitted changes and frees the lease', async () => {
    const made = room()
    const pid = liveSession(made)
    expect(alive(pid)).toBe(true)
    const said: string[] = []

    expect(runOwnerAnswer([`#${CARD}`, `stop: ${REASON}`], made.bench.db, path.join(made.root, 'owner-answers'), made.bench.clock.now(), line => said.push(line), requestFromWindow)).toBe(0)
    expect(said.join('\n')).toContain('owner.stop')
    expect(busRuns(made)).toMatchObject({ done: true })
    reduce(made.bench.db, 'pending', busProjections())

    expect(stops(made)).toHaveLength(1)
    expect(await ended(made.child!)).toBe('SIGTERM')
    expect(alive(pid)).toBe(false)
    expect(readFileSync(path.join(made.tree, 'uncommitted.ts'), 'utf8')).toBe('export const halfDone = 1\n')
    expect(leasedTasks(made)).toEqual([])
    expect(stops(made)).toEqual([{ actor: OWNER, payload: expect.objectContaining({ code: OWNER_STOP_CODE, stop_reason: REASON, detail: expect.stringContaining(`${REASON}; its tree ${made.tree} and its uncommitted changes are kept`) }) }])
    const executed = made.bench.db.prepare('SELECT actor, payload FROM events WHERE type = ? AND card_id = ?').all(COMMAND_EXECUTED, CARD) as { actor: string, payload: string }[]
    expect(executed.map(row => [row.actor, (JSON.parse(row.payload) as { text: string }).text])).toEqual([[OWNER, expect.stringContaining(REASON)]])

    launchNode(made).stopOverdue()
    expect(stops(made)).toHaveLength(1)
    expect(made.bench.db.prepare('SELECT state FROM cards WHERE card_id = ?').get(CARD)).toEqual({ state: 'stopped' })
  })
})
