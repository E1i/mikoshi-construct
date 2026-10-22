import type { WindowShard } from '../../bus/shards.js'
import type { ExitReadings } from '../../miko/eddies-measure.js'
import type { HandoffState, MergedReading, PrState, StateReading } from '../../shift/handoff-write.js'
import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendEvent, openBus } from '../../bus/db.js'
import { keyOf, queueTask } from '../../bus/queue.js'
import { COMPLETION_OF } from '../../bus/window.js'
import { NODE_DETECTED } from '../../core/events.js'
import { HANDOFF_FIELDS, HANDOFF_LIMIT, runHandoffCheck } from '../../ghosts/handoff-check.js'
import { UNREAD } from '../../miko/eddies-measure.js'
import { stopReasonOf } from '../../miko/exit.js'
import { archiveOfDay, DAY_FILE_LIMIT, QUESTIONS_HEADING } from '../../shift/day-archive.js'
import { busMerged, nextArchive, OWNER_BOUNDARIES, runHandoffWrite, sessionHandoffOf, withPrev } from '../../shift/handoff-write.js'
import { statusOf } from '../../miko/loop.js'

const roots: string[] = []
const UNBOUNDED_OWNER_STATUSES = [
  'STATUS: OWNER',
  'STATUS: OWNER — review changes',
  'STATUS: OWNER — boundary: red-ci',
  `STATUS: OWNER — boundary: ${OWNER_BOUNDARIES[0]}\n\nSTATUS: OWNER`,
  'STATUS: OWNER.',
  'STATUS: OWNER—boundary: x',
  'STATUS: OWNER\nSTATUS: n/a',
]
const DECISIONS = fileURLToPath(import.meta.url)
const PARKED = new Map<number, number[]>([[650, []], [652, [650]]])
const NO_BUS: StateReading = { kind: 'unread', why: 'no bus at /nowhere/bus.db' }
const STATE_FIELDS = ['current card', 'queue', 'in-flight', 'blocked']
const BUS_STATE: HandoffState = {
  ready: [{ card: '650', lane: 'lane-1', reason: null }, { card: '652', lane: 'lane-1', reason: null }],
  blocked: [{ card: '653', lane: 'lane-2', reason: 'waits question' }],
  lanes: [{ lane: 'lane-1', card: 648, state: 'running', since: null }, { lane: 'lane-2', card: null, state: null, since: null }],
  execution: [{ card: 648, pr: null, stage: 'writing', since: null, review: null, markers: [] }, { card: 640, pr: 701, stage: 'awaiting merge', since: null, review: null, markers: [] }],
}
const HANDOFF_WRITE = fileURLToPath(new URL('../../shift/handoff-write.ts', import.meta.url))
const NOW = new Date('2026-10-17T10:00:00.000Z')
const NO_MERGES: MergedReading = { kind: 'read', cards: [], merges: 0, updates: 0 }
const BELOW_WARN: ExitReadings = { ...UNREAD, context: 10, contextWarn: 100, spent: 1, spendWarn: 100 }
const AT_CONTEXT_WARN: ExitReadings = { ...BELOW_WARN, context: 100 }
let busState: StateReading = NO_BUS
let mergedToday: MergedReading = NO_MERGES
let prStates: Record<number, PrState> = {}
let exitReadings: ExitReadings = BELOW_WARN
let decisionsShard: WindowShard | null = null

afterEach(() => {
  busState = NO_BUS
  decisionsShard = null
  mergedToday = NO_MERGES
  prStates = {}
  exitReadings = BELOW_WARN
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function draft(extra: Record<string, string> = {}): string {
  const values: Record<string, string> = { ...Object.fromEntries(HANDOFF_FIELDS.filter(field => field.id !== 'stop-reason').map(field => [field.label, field.id === 'decisions' ? DECISIONS : `${field.id} value`])), 'queue': '#650 → #652', 'in-flight': '#650 brief', 'owner waits': 'none', 'next task': '#650 brief', ...extra }
  return `# Handoff\n\nrole: window\nsession: 2\n${Object.entries(values).map(([label, value]) => `${label}: ${value}`).join('\n')}\n\nSTATUS: CONTINUE\n`
}

function withoutStateFields(text: string): string {
  return text.split('\n').filter(line => !STATE_FIELDS.some(label => line.startsWith(`${label}:`))).join('\n')
}

function world(): { dir: string, handoff: string, draft: string } {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'handoff-write-')))
  roots.push(dir)
  return { dir, handoff: path.join(dir, 'handoff.md'), draft: path.join(dir, 'draft.md') }
}

function write(args: string[], handoffDir?: string, sessionHandoff: string | null = path.resolve(handoffDir ?? '/nowhere', args[0] ?? '')): { code: number, out: string[], err: string[] } {
  const out: string[] = []
  const err: string[] = []
  const code = runHandoffWrite(args, {
    cwd: '/nowhere',
    handoffDir,
    sessionHandoff,
    exists: existsSync,
    read: file => readFileSync(file, 'utf8'),
    listDir: readdirSync,
    makeDir: dir => mkdirSync(dir, { recursive: true }),
    write: (file, text) => writeFileSync(file, text),
    writeNew: (file, text) => writeFileSync(file, text, { flag: 'wx' }),
    rename: renameSync,
    parked: () => PARKED,
    state: () => busState,
    merged: () => mergedToday,
    prState: pr => prStates[pr] ?? 'OPEN',
    decisionsShard: () => decisionsShard,
    readings: () => exitReadings,
    stopReason: stopReasonOf,
    now: () => NOW,
    home: '/home/x',
    out: line => out.push(line),
    err: line => err.push(line),
  })
  return { code, out, err }
}

describe('handoff:write', () => {
  it('measures the limit as handoff:check does', () => {
    const { handoff, draft: file } = world()
    const bloated = draft({ 'not done': 'é'.repeat(HANDOFF_LIMIT / 2 - 100) })
    expect(bloated.length).toBeLessThan(HANDOFF_LIMIT)
    expect(Buffer.byteLength(bloated)).toBeGreaterThan(HANDOFF_LIMIT)
    writeFileSync(file, bloated)
    const refused = write([handoff, file])
    expect(refused.code).toBe(1)
    expect(refused.err.join('\n')).toContain('bytes over the limit of 6000')
    const checked: string[] = []
    const code = runHandoffCheck([file, '--parking', '/p'], { exists: existsSync, read: f => readFileSync(f, 'utf8'), parked: () => PARKED, home: '/home/x', out: () => {}, err: line => checked.push(line) })
    expect(code).toBe(1)
    expect(checked.join('\n')).toContain('bytes over the limit of 6000')
    writeFileSync(file, draft())
    const ok = write([handoff, file])
    expect(ok.code).toBe(0)
    expect(ok.out[0]).toContain(`${Buffer.byteLength(readFileSync(handoff, 'utf8'))} bytes`)
  })

  it('archives the old handoff and writes prev', () => {
    const { dir, handoff, draft: file } = world()
    const old = '# Handoff\n\n## STOP — window 1\nold\n\n## STOP — window 0\nolder\n'
    writeFileSync(handoff, old)
    writeFileSync(file, draft())
    expect(write([handoff, file]).code).toBe(0)
    expect(readFileSync(path.join(dir, 'archive', '0001.md'), 'utf8')).toBe(old)
    const written = readFileSync(handoff, 'utf8')
    expect(written.split('\n').slice(2, 4)).toEqual(['## STOP — window, 2026-10-17, session 2, boundary: none', 'prev: archive/0001.md'])
    writeFileSync(file, draft({ prev: 'archive/0009.md' }))
    expect(write([handoff, file]).code).toBe(0)
    expect(readFileSync(path.join(dir, 'archive', '0002.md'), 'utf8')).toBe(written)
    expect(readFileSync(handoff, 'utf8')).toContain('prev: archive/0002.md\n')
    expect(readFileSync(handoff, 'utf8')).not.toContain('0009')
  })

  it('writes prev: none for the first handoff and archives nothing', () => {
    const { dir, handoff, draft: file } = world()
    writeFileSync(file, draft())
    expect(write([handoff, file]).code).toBe(0)
    expect(readFileSync(handoff, 'utf8')).toContain('prev: none\n')
    expect(existsSync(path.join(dir, 'archive'))).toBe(false)
  })

  it('refuses a draft that fails the check, archiving nothing and leaving the handoff unchanged', () => {
    const { dir, handoff, draft: file } = world()
    writeFileSync(handoff, 'old\n')
    for (const bad of [draft({ queue: '#650 then the rest' }), draft({ 'not done': 'x'.repeat(HANDOFF_LIMIT) }), `${draft()}\n## STOP — again\n`]) {
      writeFileSync(file, bad)
      const result = write([handoff, file])
      expect(result.code).toBe(1)
      expect(result.err.at(-1)).toContain('nothing archived')
    }
    expect(readFileSync(handoff, 'utf8')).toBe('old\n')
    expect(existsSync(path.join(dir, 'archive'))).toBe(false)
  })

  it('writes into the directory CONSTRUCT_HANDOFF_DIR names, with the archive and prev: there', () => {
    const { dir, draft: file } = world()
    const ghostDir = path.join(dir, 'ghost-handoff')
    mkdirSync(ghostDir)
    writeFileSync(path.join(ghostDir, 'handoff.md'), 'old\n')
    writeFileSync(file, draft())
    expect(write(['handoff.md', file], ghostDir).code).toBe(0)
    expect(readFileSync(path.join(ghostDir, 'archive', '0001.md'), 'utf8')).toBe('old\n')
    expect(readFileSync(path.join(ghostDir, 'handoff.md'), 'utf8')).toContain('prev: archive/0001.md\n')
    expect(existsSync(path.join(dir, 'archive'))).toBe(false)
  })

  it('refuses a new handoff file that is not the session handoff, writes the session handoff and an existing file', () => {
    const { dir, handoff, draft: file } = world()
    const session = path.join(dir, 'mikoshi.md')
    writeFileSync(file, draft())
    const refused = write([handoff, file], undefined, session)
    expect(refused.code).toBe(1)
    expect(refused.err.join('\n')).toContain(session)
    expect(existsSync(handoff)).toBe(false)
    expect(write([session, file], undefined, session).code).toBe(0)
    expect(existsSync(session)).toBe(true)
    writeFileSync(handoff, 'old\n')
    expect(write([handoff, file], undefined, session).code).toBe(0)
  })

  it('lets a card session with no CONSTRUCT_HANDOFF create its task handoff', () => {
    const { dir, draft: file } = world()
    const task = path.join(dir, '866-handoff.md')
    writeFileSync(file, draft())
    const session = sessionHandoffOf({ CONSTRUCT_CARD: '866', CONSTRUCT_HANDOFF_DIR: dir }, '/home')
    expect(session).toBeNull()
    expect(write([task, file], undefined, session).code).toBe(0)
    expect(existsSync(task)).toBe(true)
  })

  it('lets a card session that inherited the Operator CONSTRUCT_HANDOFF create its task handoff', () => {
    const { dir, draft: file } = world()
    const operator = path.join(dir, 'operator.md')
    const task = path.join(dir, '866-handoff.md')
    writeFileSync(file, draft())
    const session = sessionHandoffOf({ CONSTRUCT_CARD: '866', CONSTRUCT_HANDOFF: operator, CONSTRUCT_HANDOFF_DIR: dir }, '/home')
    expect(session).toBeNull()
    expect(write([task, file], undefined, session).code).toBe(0)
    expect(existsSync(task)).toBe(true)
    expect(existsSync(operator)).toBe(false)
  })

  it.each([
    ['unset variables', {}, '/home/.construct/handoff/miko.md'],
    ['empty variables', { CONSTRUCT_HANDOFF: '', CONSTRUCT_HANDOFF_DIR: '', CONSTRUCT_CARD: '' }, '/home/.construct/handoff/miko.md'],
    ['a handoff dir', { CONSTRUCT_HANDOFF_DIR: '/d' }, '/d/miko.md'],
    ['CONSTRUCT_HANDOFF over the dir', { CONSTRUCT_HANDOFF: '/r/h.md', CONSTRUCT_HANDOFF_DIR: '/d' }, '/r/h.md'],
    ['a card session with an inherited CONSTRUCT_HANDOFF', { CONSTRUCT_HANDOFF: '/r/operator.md', CONSTRUCT_HANDOFF_DIR: '/d', CONSTRUCT_CARD: '1' }, null],
    ['a card session with no CONSTRUCT_HANDOFF', { CONSTRUCT_CARD: '866', CONSTRUCT_HANDOFF: '' }, null],
  ] as const)('reads the session handoff from %s', (_, env, expected) => {
    expect(sessionHandoffOf(env, '/home')).toBe(expected)
  })

  it('numbers the archive after the highest archive already there', () => {
    expect(nextArchive([])).toBe('0001.md')
    expect(nextArchive(['0001.md', '0007.md', 'notes.md'])).toBe('0008.md')
  })

  it('puts prev right under the STOP heading and drops any prev the draft carried', () => {
    expect(withPrev('# H\n## STOP\nprev: x\nqueue: #1', 'archive/0003.md')).toBe('# H\n## STOP\nprev: archive/0003.md\nqueue: #1')
  })

  it.each(UNBOUNDED_OWNER_STATUSES)('reads the refused draft %j as OWNER, as relaunch does', (status) => {
    expect(statusOf(draft().replace('STATUS: CONTINUE', status))).toBe('OWNER')
  })

  it.each(UNBOUNDED_OWNER_STATUSES)('refuses STATUS: OWNER with no boundary from the list, archiving nothing and naming the list: %j', (status) => {
    const { dir, handoff, draft: file } = world()
    writeFileSync(handoff, 'old\n')
    writeFileSync(file, draft().replace('STATUS: CONTINUE', status))
    const result = write([handoff, file])
    expect(result.code).toBe(1)
    expect(result.err.join('\n')).toContain(OWNER_BOUNDARIES.join(', '))
    expect(result.err.at(-1)).toContain('nothing archived')
    expect(readFileSync(handoff, 'utf8')).toBe('old\n')
    expect(existsSync(path.join(dir, 'archive'))).toBe(false)
  })

  it('writes STATUS: OWNER that names a boundary from the list, and leaves CONTINUE and DONE as they were', () => {
    for (const status of [...OWNER_BOUNDARIES.map(name => `STATUS: OWNER — boundary: ${name}`), 'STATUS: CONTINUE', 'STATUS: DONE']) {
      const { handoff, draft: file } = world()
      writeFileSync(file, draft().replace('STATUS: CONTINUE', status))
      expect(write([handoff, file]).code).toBe(0)
      expect(readFileSync(handoff, 'utf8')).toContain(`${status}\n`)
    }
  })

  it('refuses STATUS: OWNER while the bus holds a card the window can take', () => {
    const { handoff, draft: file } = world()
    writeFileSync(file, withoutStateFields(draft()).replace('STATUS: CONTINUE', 'STATUS: OWNER — boundary: owner-question'))
    busState = { kind: 'read', state: BUS_STATE }
    const result = write([handoff, file])
    expect(result.code).toBe(1)
    expect(result.err.join('\n')).toContain('owner questions go into the day file and the next card is taken')
    expect(existsSync(handoff)).toBe(false)
  })

  it('handoff:write refuses STATUS: OWNER under an active decisions shard', () => {
    decisionsShard = { id: 'ws-1', by: 'Eli', scope: 'merge+decisions', until: '2026-10-17T16:00:00.000Z' }
    for (const boundary of OWNER_BOUNDARIES.slice(1)) {
      const { handoff, draft: file } = world()
      writeFileSync(file, draft().replace('STATUS: CONTINUE', `STATUS: OWNER — boundary: ${boundary}`))
      const result = write([handoff, file])
      expect(result.code).toBe(1)
      expect(result.err.join('\n')).toContain('under the active merge+decisions shard ws-1')
      expect(existsSync(handoff)).toBe(false)
    }
    for (const status of [`STATUS: OWNER — boundary: ${OWNER_BOUNDARIES[0]}`, 'STATUS: CONTINUE']) {
      const { handoff, draft: file } = world()
      writeFileSync(file, draft().replace('STATUS: CONTINUE', status))
      expect(write([handoff, file]).code).toBe(0)
    }
  })

  it('writes STATUS: OWNER when no card can be taken without the owner', () => {
    const nothingQueued: HandoffState = { ...BUS_STATE, ready: [] }
    const heldForOwner: HandoffState = { ...nothingQueued, blocked: [{ card: '653', lane: 'lane-2', reason: 'waits question' }] }
    for (const state of [nothingQueued, heldForOwner]) {
      const { handoff, draft: file } = world()
      writeFileSync(file, withoutStateFields(draft()).replace('STATUS: CONTINUE', 'STATUS: OWNER — boundary: owner-question'))
      busState = { kind: 'read', state }
      const result = write([handoff, file])
      expect(result.err).toEqual([])
      expect(result.code).toBe(0)
    }
  })

  it('the in-flight and queue fields are generated from the bus state, not from the draft', () => {
    const { handoff, draft: file } = world()
    writeFileSync(file, withoutStateFields(draft()))
    busState = { kind: 'read', state: BUS_STATE }
    const result = write([handoff, file])
    expect(result.err).toEqual([])
    expect(result.code).toBe(0)
    const written = readFileSync(handoff, 'utf8')
    expect(written).toContain('## STOP — window, 2026-10-17, session 2, boundary: none\nprev: none\ncurrent card: #648 lane-1 running\nqueue: #650 → #652\nin-flight:\n- #648 writing\n- #640 awaiting-merge PR #701\nblocked: #653 waits question\n')
    expect(written).toContain('stop reason: none\n')
    expect(written).toContain('continue when: continue-when value\n')
    expect(result.out[0]).toContain(`${STATE_FIELDS.join(', ')} from the bus state`)
  })

  it('writes none for every state field the bus holds nothing for', () => {
    const { handoff, draft: file } = world()
    writeFileSync(file, withoutStateFields(draft()))
    expect(write([handoff, file]).code).toBe(1)
    busState = { kind: 'read', state: { ready: [], blocked: [], lanes: [], execution: [] } }
    expect(write([handoff, file]).code).toBe(0)
    expect(readFileSync(handoff, 'utf8')).toContain('current card: none\nqueue: none\nin-flight: none\nblocked: none\n')
  })

  it.each([
    ['a state field in the STOP section', (text: string) => text, 'queue'],
    ['a state field as a heading with prose under it', (text: string) => `${withoutStateFields(text)}\n## blocked\n\nWhy I stopped, in prose.\n`, 'blocked'],
    ['a state field above the STOP section', (text: string) => `in-flight: #999 brief\n${withoutStateFields(text)}`, 'in-flight'],
  ])('refuses a draft that carries %s when the bus state is read, so no word of the draft is dropped', (_, shape, label) => {
    const { dir, handoff, draft: file } = world()
    writeFileSync(handoff, 'old\n')
    writeFileSync(file, shape(draft()))
    busState = { kind: 'read', state: BUS_STATE }
    const result = write([handoff, file])
    expect(result.code).toBe(1)
    expect(result.err.join('\n')).toContain(`${label}: generated from the bus state`)
    expect(result.err.at(-1)).toContain('nothing archived')
    expect(readFileSync(handoff, 'utf8')).toBe('old\n')
    expect(existsSync(path.join(dir, 'archive'))).toBe(false)
  })

  it('writes the owner waits the draft names, the version PR among them, beside the blocked cards the bus state holds', () => {
    const { handoff, draft: file } = world()
    writeFileSync(file, withoutStateFields(draft({ 'owner waits': 'Q3 open PR #900' })))
    busState = { kind: 'read', state: BUS_STATE }
    const result = write([handoff, file])
    expect(result.err).toEqual([])
    expect(result.code).toBe(0)
    const written = readFileSync(handoff, 'utf8')
    expect(written).toContain('owner waits: Q3 open PR #900\n')
    expect(written).toContain('blocked: #653 waits question\n')
  })

  it('keeps the draft fields and names why when no bus state is read', () => {
    const { handoff, draft: file } = world()
    writeFileSync(file, draft())
    const result = write([handoff, file])
    expect(result.code).toBe(0)
    expect(readFileSync(handoff, 'utf8')).toContain('queue: #650 → #652\n')
    expect(result.out[0]).toContain(`no bus at /nowhere/bus.db: ${STATE_FIELDS.join(', ')} as the draft wrote them`)
  })

  it.each([
    ['an empty bus', (bus: string) => openBus(bus).close(), 'from the bus state'],
    ['no bus', () => {}, 'no bus at'],
    ['a bus path that is a directory', (bus: string) => mkdirSync(bus), 'unreadable'],
  ])('the command reads the bus and the parking it is given, and writes the handoff from %s', (_, make, source) => {
    const { dir, handoff, draft: file } = world()
    const bus = path.join(dir, 'bus.db')
    make(bus)
    writeFileSync(file, source === 'from the bus state' ? withoutStateFields(draft()) : draft().replace(/queue: .*/, 'queue: none'))
    const run = spawnSync(process.execPath, ['--import', 'tsx', HANDOFF_WRITE, handoff, file, '--parking', path.join(dir, 'parking')], { encoding: 'utf8', env: { ...process.env, HOME: dir, CONSTRUCT_BUS_DB: bus, CONSTRUCT_CARD: '843', CONSTRUCT_HANDOFF_DIR: dir, NODE_NO_WARNINGS: '1' } })
    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    expect(run.stdout).toContain(source)
    expect(readFileSync(handoff, 'utf8')).toContain('queue: none\n')
  })

  it('the windows line is the bus:window count of merge and update', () => {
    const { dir } = world()
    const bus = path.join(dir, 'bus.db')
    const db = openBus(bus)
    const ts = NOW.toISOString()
    for (const [queue, card, detected] of [['merge', 990, true], ['merge', 991, false], ['update', 992, true]] as const) {
      const task = { queue, cardId: card, pr: card, head: card.toString(16).padStart(40, 'b') }
      queueTask(db, ts, task)
      const key = keyOf(task)
      if (detected)
        appendEvent(db, { ts, type: NODE_DETECTED, actor: `worker:${queue}:s1`, cardId: card, pr: card, head: task.head, dedupeKey: `${NODE_DETECTED}:${queue}:${key}`, payload: { key, via: 'event', event_id: 1, outcome: 'queued' }, legacy: false })
      appendEvent(db, { ts, type: COMPLETION_OF[queue], actor: `worker:${queue}:s1`, cardId: card, pr: card, head: task.head, dedupeKey: `${COMPLETION_OF[queue]}:${key}`, payload: {}, legacy: false })
    }
    db.close()
    expect(busMerged(bus, '2026-10-17T00:00:00.000Z')).toEqual({ kind: 'read', cards: [990, 991], merges: 0, updates: 1 })
  })

  it('handoff:write with STATUS: CONTINUE does not kill the session', () => {
    const { dir, draft: file } = world()
    const handoff = path.join(dir, 'miko.md')
    const stub = path.join(dir, 'claude')
    writeFileSync(file, draft().replace(/queue: .*/, 'queue: none'))
    writeFileSync(stub, '#!/bin/sh\n"$NODE" --import tsx "$HANDOFF_WRITE" "$HANDOFF" "$DRAFT" --parking "$STUB_DIR/parking" >"$STUB_DIR/write.log" 2>&1\nsleep 2\necho survived > "$STUB_DIR/survived"\n', { mode: 0o755 })
    const { CLAUDE_CODE_SESSION_ID: _session, CONSTRUCT_HANDOFF: _handoff, CONSTRUCT_CARD: _card, ...env } = process.env
    const run = spawnSync(stub, [], { encoding: 'utf8', env: { ...env, HOME: dir, STUB_DIR: dir, NODE: process.execPath, HANDOFF_WRITE, HANDOFF: handoff, DRAFT: file, CONSTRUCT_HANDOFF_DIR: dir, CONSTRUCT_BUS_DB: path.join(dir, 'bus.db'), CLAUDE_PROJECT_DIR: dir, NODE_NO_WARNINGS: '1' } })
    expect({ status: run.status, signal: run.signal }).toEqual({ status: 0, signal: null })
    expect(readFileSync(path.join(dir, 'write.log'), 'utf8')).toContain(`${handoff}: `)
    expect(statusOf(readFileSync(handoff, 'utf8'))).toBe('CONTINUE')
    expect(readFileSync(path.join(dir, 'survived'), 'utf8')).toBe('survived\n')
  }, 20_000)

  it('handoff:write does not import miko:exit', () => {
    const source = readFileSync(HANDOFF_WRITE, 'utf8')
    expect(source).not.toMatch(/\b(?:runMikoExit|realMikoExitDeps|exitDecision)\b/)
    expect(source.match(/from ['"]\.\.\/miko\/exit(?:\.js)?['"]/g)).toEqual(['from \'../miko/exit.js\''])
    expect(source).toMatch(/import \{ stopReasonOf \} from '\.\.\/miko\/exit\.js'/)
  })

  it('generates the STOP heading, merged today and the stop reason, and refuses them in the draft', () => {
    const { handoff, draft: file } = world()
    mergedToday = { kind: 'read', cards: [992, 1013], merges: 2, updates: 3 }
    exitReadings = AT_CONTEXT_WARN
    writeFileSync(file, draft({ 'next task': 'item 2 of the queue' }).replace('session: 2', 'session: 13'))
    const written = write([handoff, file])
    expect(written.err).toEqual([])
    expect(written.code).toBe(0)
    const text = readFileSync(handoff, 'utf8')
    expect(text).toContain('## STOP — window, 2026-10-17, session 13, boundary: context\n')
    expect(text).toContain('merged today: #992, #1013\nwindows: merge 2, update 3\nstop reason: context (100/100 tokens, 1/100 spend)\n')
    expect(text).not.toContain('role:')
    expect(text).not.toContain('session:')
    mergedToday = { kind: 'unread', why: 'no bus' }
    writeFileSync(file, draft())
    expect(write([handoff, file]).code).toBe(0)
    expect(readFileSync(handoff, 'utf8')).toContain('merged today: unread (no bus)\nwindows: unread\n')
    const before = readFileSync(handoff, 'utf8')
    const bad = draft({ 'merged today': '#1', 'windows': 'merge 1', 'stop reason': 'context', 'next task': 'whatever' }).replace('role: window\nsession: 2', '## STOP — x\nrole: owner\nsession: x')
    writeFileSync(file, bad)
    const refused = write([handoff, file])
    expect(refused.code).toBe(1)
    const lines = refused.err.join('\n')
    for (const part of ['STOP heading: generated', 'merged today: generated', 'windows: generated', 'stop reason: generated', 'role: "owner"', 'session: "x"', 'next task: "whatever"'])
      expect(lines).toContain(part)
    expect(refused.err.at(-1)).toContain('nothing archived')
    expect(readFileSync(handoff, 'utf8')).toBe(before)
    writeFileSync(file, draft().replace('STATUS: CONTINUE', 'STATUS: DONE'))
    expect(write([handoff, file]).code).toBe(0)
    expect(readFileSync(handoff, 'utf8')).toContain('boundary: done\n')
    expect(readFileSync(handoff, 'utf8')).toContain('stop reason: done (100/100 tokens, 1/100 spend)\n')
  })

  it('refuses an owner wait naming a merged or closed pull request', () => {
    const { handoff, draft: file } = world()
    writeFileSync(handoff, 'old\n')
    writeFileSync(file, draft({ 'owner waits': 'Q3 open PR #669; Q4 answered PR #824; Q5 open' }))
    prStates = { 669: 'OPEN', 824: 'MERGED' }
    const merged = write([handoff, file])
    expect(merged.code).toBe(1)
    expect(merged.err.filter(line => line.includes('owner waits'))).toEqual(['[handoff:write] owner waits: PR #824 is merged; drop it'])
    expect(readFileSync(handoff, 'utf8')).toBe('old\n')
    prStates = { 669: 'CLOSED', 824: 'OPEN' }
    expect(write([handoff, file]).err.filter(line => line.includes('owner waits'))).toEqual(['[handoff:write] owner waits: PR #669 is closed; drop it'])
    prStates = { 669: 'unread', 824: 'OPEN' }
    expect(write([handoff, file]).code).toBe(0)
    expect(readFileSync(handoff, 'utf8')).toContain('owner waits: Q3 open PR #669 (PR #669 unread); Q4 answered PR #824; Q5 open\n')
    writeFileSync(file, draft({ 'owner waits': 'waiting for the owner' }))
    const prose = write([handoff, file])
    expect(prose.code).toBe(1)
    expect(prose.err.join('\n')).toContain('owner waits: "waiting for the owner" is not Q<N>')
  })

  it('runHandoffWrite with STATUS: CONTINUE kills nothing', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      const { handoff, draft: file } = world()
      writeFileSync(file, draft())
      expect(write([handoff, file]).code).toBe(0)
      expect(statusOf(readFileSync(handoff, 'utf8'))).toBe('CONTINUE')
      expect(kill).not.toHaveBeenCalled()
    }
    finally {
      kill.mockRestore()
    }
  })

  it('after handoff:write the day file is at most the limit and the handoff has no whole reading', () => {
    const { dir, handoff, draft: file } = world()
    const dayFile = path.join(dir, 'day-2026-10-17.md')
    const progress = `## Progress (window-maintained)\n\n${'- session 1, a step.\n'.repeat(600)}`
    writeFileSync(dayFile, `# Day\n\n## Owner order, session 1\n\nold order\n\n## Owner order, session 2\n\nthis order\n\n${QUESTIONS_HEADING}\n\n- Q1 answered — one\n- Q2 open — two\n\n${progress}`)
    expect(Buffer.byteLength(readFileSync(dayFile, 'utf8'))).toBeGreaterThan(DAY_FILE_LIMIT)
    writeFileSync(file, draft({ 'not done': `owner answers in ${dayFile}, read them whole` }))
    const refused = write([handoff, file])
    expect(refused.code).toBe(1)
    expect(refused.err.join('\n')).toContain('orders a whole reading')
    expect(existsSync(handoff)).toBe(false)
    expect(existsSync(archiveOfDay(dayFile))).toBe(false)

    writeFileSync(file, draft({ 'not done': `owner order in ${dayFile}; the earlier one in ${archiveOfDay(dayFile)} § Owner order, session 1` }))
    const ok = write([handoff, file])
    expect(ok.code).toBe(0)
    const kept = readFileSync(dayFile, 'utf8')
    expect(Buffer.byteLength(kept)).toBeLessThanOrEqual(DAY_FILE_LIMIT)
    expect(kept).toBe(`# Day\n\n## Owner order, session 2\n\nthis order\n\n${QUESTIONS_HEADING}\n\n- Q2 open — two\n`)
    const archive = readFileSync(archiveOfDay(dayFile), 'utf8')
    expect(archive).toContain('## Owner order, session 1\n\nold order')
    expect(archive).toContain('- Q1 answered — one')
    expect(archive).toContain(progress.trimEnd())
    expect(readFileSync(handoff, 'utf8')).not.toMatch(/read them whole/)
  })

  it('a day file over the limit after the archive refuses as a question for the owner and writes nothing', () => {
    const { dir, handoff, draft: file } = world()
    const dayFile = path.join(dir, 'day-2026-10-17.md')
    const text = `# Day\n\n${QUESTIONS_HEADING}\n\n${'- Q1 open — a long question\n'.repeat(400)}`
    writeFileSync(dayFile, text)
    writeFileSync(file, draft({ 'not done': `questions in ${dayFile}` }))
    const refused = write([handoff, file])
    expect(refused.code).toBe(1)
    expect(refused.err.join('\n')).toMatch(new RegExp(`over the limit of ${DAY_FILE_LIMIT}; a question for the owner`))
    expect(readFileSync(dayFile, 'utf8')).toBe(text)
    expect(existsSync(archiveOfDay(dayFile))).toBe(false)
    expect(existsSync(handoff)).toBe(false)
  })

  it('refuses a draft that names the day archive without a heading', () => {
    const { handoff, draft: file } = world()
    writeFileSync(file, draft({ 'not done': 'see day-2026-10-17.archive.md' }))
    const refused = write([handoff, file])
    expect(refused.code).toBe(1)
    expect(refused.err.join('\n')).toContain('names the day archive without a heading')
  })

  it('refuses a bad argv', () => {
    expect(write([]).code).toBe(2)
    expect(write(['a.md']).code).toBe(2)
    expect(write(['a.md', 'b.md', '--parking']).code).toBe(2)
  })
})
