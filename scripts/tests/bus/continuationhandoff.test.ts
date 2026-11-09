import type { QueuedCard, StartedCard } from '../../nodes/launch/launch-executor.js'
import type { SessionContinuer } from '../../nodes/launch/launch-starter.js'
import type { SessionStart } from '../../nodes/launch/launch-worker.js'
import type { ProcessTable } from '../../nodes/restart/chain-process.js'
import type { MergeBench } from './merge-bench.js'
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendEvent } from '../../core/db.js'
import { CARD_ADMITTED, CARD_CONTINUED, CARD_STOPPED } from '../../core/events.js'
import { eddiesJournalPath, reportPath } from '../../core/places.js'
import { BUILT_HANDOFF_HEADING, builtHandoff, continuationRefusal, MAX_RESTARTS, QUESTION_LINE, sessionWrittenPart, stoppedOnSpend } from '../../nodes/launch/continuation.js'
import { handoffBuilder, HEADER_FILE, realStarterPorts } from '../../nodes/launch/launch-root.js'
import { pathTokens } from '../../nodes/launch/launch-starter.js'
import { LaunchNode } from '../../nodes/launch/launch-worker.js'
import { transcriptFile } from '../../nodes/launch/session-journal.js'
import { reportClosingOf } from '../../nodes/launch/tree-pr.js'
import { clientAdapter } from '../../ports/client/index.js'
import { DISK_FLOOR_BYTES } from '../../ports/disk.js'
import { HANDOFF_LIMIT } from '../../window/handoff-check.js'
import { eventsOf, mergeBench } from './merge-bench.js'

const benches: MergeBench[] = []
const roots: string[] = []

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const made of benches.splice(0))
    made.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'continuationhandoff-'))
  roots.push(root)
  return root
}

interface LineOptions {
  missing?: string | null
  report?: string | null
  spendStopped?: boolean
}

interface AtLine {
  node: LaunchNode
  made: MergeBench
  order: string[]
  published: string[]
}

async function sessionAtLine(cardId: number, options: LineOptions = {}): Promise<AtLine> {
  const made = mergeBench()
  benches.push(made)
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'policy', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${cardId}`, payload: { lane: 'lane-a', decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${cardId}` }, legacy: false })
  made.tick()
  const order: string[] = []
  const published: string[] = []
  let continued = 0
  const starter: SessionContinuer & { start: (card: QueuedCard) => { kind: 'started', card: StartedCard }, stop: () => void } = {
    start: card => ({ kind: 'started', card: { session: `s-${card.cardId}`, worktree: `/trees/mc-${card.cardId}`, branch: `feat/card-${card.cardId}`, base: 'f'.repeat(40), pid: 4242, pgid: 4242, contour: 'cheap' } }),
    stop: () => {},
    continueFrom: (_card, from) => {
      continued += 1
      order.push('continued')
      return { kind: 'started', card: { ...from, session: `${from.session}-c${continued}` } }
    },
  }
  const exited: ProcessTable = { commandLine: () => null, signalGroup: () => {} }
  const node = new LaunchNode({
    db: made.db,
    starter,
    continuer: starter,
    clock: made.clock.now,
    session: 'node-1',
    mode: 'live',
    env: {},
    processes: exited,
    resulted: () => true,
    handedOff: () => false,
    atContextLine: () => true,
    warned: () => true,
    committed: () => true,
    collected: () => options.missing ?? null,
    reportOf: () => options.report ?? null,
    spendStopped: () => options.spendStopped ?? false,
    buildHandoff: () => order.push('built'),
    publish: card => published.push(card.session),
    disk: () => ({ bavail: 1, bsize: DISK_FLOOR_BYTES }),
    isolation: () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] }),
  })
  const controller = new AbortController()
  await node.run({ pause: async () => controller.abort(), signal: controller.signal })
  made.tick()
  return { node, made, order, published }
}

function git(tree: string, ...args: string[]): string {
  return execFileSync('git', ['-C', tree, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { encoding: 'utf8' }).trim()
}

function assistantLine(content: object[]): string {
  return JSON.stringify({ type: 'assistant', message: { content } })
}

const LEFTOVERS = { cardId: 1801, session: 's-1801', report: null, diff: 'diff --git a/x b/x', body: 'the body', steps: ['Edit x'] }

describe('the session at the context warn with no valid handoff', () => {
  it('a launch session at the context warn with no handoff continues in a fresh session with no push', async () => {
    const { node, made, order, published } = await sessionAtLine(1801)

    expect(node.stopOverdue()).toEqual([])

    expect(order).toEqual(['built', 'continued'])
    expect(published).toEqual([])
    expect(eventsOf(made.db, CARD_STOPPED)).toEqual([])
    expect(eventsOf(made.db, CARD_CONTINUED)).toMatchObject([{ session: 's-1801-c1', continuation: 1, from: 's-1801' }])
  })

  it('a session that left no report at all continues too, not a report-missing stop', async () => {
    const { node, made, order } = await sessionAtLine(1802, { missing: 'report-missing: no report was written there' })

    expect(node.stopOverdue()).toEqual([])

    expect(order).toEqual(['built', 'continued'])
    expect(eventsOf(made.db, CARD_STOPPED)).toEqual([])
  })

  it('past MAX_RESTARTS the card stops with no push, says so and builds nothing over the last report', async () => {
    const { node, made, order, published } = await sessionAtLine(1803)

    for (let restart = 0; restart < MAX_RESTARTS; restart += 1) {
      expect(node.stopOverdue()).toEqual([])
      made.tick()
    }
    expect(node.stopOverdue()).toEqual([1803])

    expect(order.filter(step => step === 'built')).toHaveLength(MAX_RESTARTS)
    expect(published).toEqual([])
    expect(eventsOf(made.db, CARD_STOPPED)).toEqual([expect.objectContaining({ reason: 'fault', detail: expect.stringContaining('continuation-limit') })])
  })

  it('a question in the report still goes to the owner and nothing continues over it', async () => {
    const { node, made, order, published } = await sessionAtLine(1804, { report: 'question: which one, the owner decides\n' })

    expect(node.stopOverdue()).toEqual([1804])

    expect(order).toEqual([])
    expect(published).toEqual([])
    expect(eventsOf(made.db, CARD_STOPPED)).toEqual([expect.objectContaining({ reason: 'question.agent' })])
  })

  it('a session that also hit its spend stop stops with no push and no fresh session', async () => {
    const { node, made, order, published } = await sessionAtLine(1805, { spendStopped: true })

    expect(node.stopOverdue()).toEqual([1805])

    expect(order).toEqual([])
    expect(published).toEqual([])
    expect(eventsOf(made.db, CARD_STOPPED)).toEqual([expect.objectContaining({ reason: 'fault', detail: expect.stringContaining('eddies-stop') })])
  })
})

describe('the handoff the bus builds', () => {
  it('the handoff the bus builds carries the tree diff, the card body and the last steps', () => {
    const root = tempRoot()
    const tree = path.join(root, 'tree')
    mkdirSync(tree)
    git(tree, 'init', '--quiet')
    writeFileSync(path.join(tree, 'kept.txt'), 'before\n')
    git(tree, 'add', '.')
    git(tree, 'commit', '--quiet', '-m', 'base')
    const base = git(tree, 'rev-parse', 'HEAD')
    writeFileSync(path.join(tree, 'kept.txt'), 'after the session\n')
    writeFileSync(path.join(tree, 'untracked.txt'), 'new\n')
    const claudeHome = path.join(root, 'claude')
    const card: StartedCard = { session: 'session-1', worktree: tree, branch: 'feat/x', base, pid: 1, pgid: 1, contour: 'cheap' }
    const transcript = transcriptFile(claudeHome, tree, card.session)!
    mkdirSync(path.dirname(transcript), { recursive: true })
    writeFileSync(transcript, assistantLine([{ type: 'tool_use', name: 'Edit', input: { file_path: 'kept.txt' } }]))
    const launchDir = path.join(root, 'launch')
    const start: SessionStart = { cardId: 1806, ts: '2026-11-05T05:00:00.000Z' }

    vi.stubEnv('CLAUDE_CONFIG_DIR', claudeHome)
    handoffBuilder(launchDir)(card, start, 'the body of the card')
    vi.unstubAllEnvs()

    const built = readFileSync(reportPath(launchDir, '1806'), 'utf8')
    expect(built).toContain('+after the session')
    expect(built).toContain('untracked.txt')
    expect(built).toContain('the body of the card')
    expect(built).toContain('Edit kept.txt')
    expect(continuationRefusal(built)).toBeNull()
  })

  it('a tree git cannot read and a missing transcript still build a valid handoff', () => {
    const root = tempRoot()
    const launchDir = path.join(root, 'launch')
    const card: StartedCard = { session: 'session-2', worktree: path.join(root, 'gone'), branch: 'feat/x', base: 'f'.repeat(40), pid: 1, pgid: 1, contour: 'cheap' }

    vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(root, 'claude'))
    handoffBuilder(launchDir)(card, { cardId: 1807, ts: '2026-11-05T05:00:00.000Z' }, null)
    vi.unstubAllEnvs()

    const built = readFileSync(reportPath(launchDir, '1807'), 'utf8')
    expect(built).toContain('the tree diff cannot be read')
    expect(built).toContain('the transcript of the session cannot be read')
    expect(continuationRefusal(built)).toBeNull()
  })

  it('stays within the handoff limit however much the session left, in any alphabet', () => {
    const huge = 'запись '.repeat(5000)

    const built = builtHandoff({ ...LEFTOVERS, report: huge, diff: huge, body: huge, steps: [huge] })

    expect(Buffer.byteLength(built)).toBeLessThanOrEqual(HANDOFF_LIMIT)
    expect(continuationRefusal(built)).toBeNull()
  })

  it('what it quotes reads as no label, heading or closing line of its own', () => {
    const hostile = 'queue: prose that is no card\n## STOP\n## STOP\nquestion: not asked\rquestion: not asked either\nReport: /x.md\nverification: run\nPR #1\n'

    const built = builtHandoff({ ...LEFTOVERS, report: hostile, diff: hostile, body: hostile, steps: [hostile] })

    expect(continuationRefusal(built)).toBeNull()
    expect(QUESTION_LINE.test(built)).toBe(false)
    expect(reportClosingOf(built)).toBeNull()
  })

  it('names no changed path to the held-tree guard, so the guard still asks the journal', () => {
    const touched = 'scripts/nodes/launch/continuation.ts'
    const built = builtHandoff({ ...LEFTOVERS, report: 'result: left it', diff: `${touched}\n`, body: `touches: ${touched}`, steps: [`Edit ${touched}`] })
    expect(pathTokens(built).has(touched)).toBe(true)
    expect(pathTokens(sessionWrittenPart(built)).has(touched)).toBe(false)

    const file = path.join(tempRoot(), 'report.md')
    writeFileSync(file, built)
    const { readReport } = realStarterPorts('/repo', {}, '', () => 'uuid')
    expect(pathTokens(readReport(file) ?? '').has(touched)).toBe(false)
  })

  it('what the session reported itself still names its paths to the guard', () => {
    const named = 'scripts/own.ts'

    const built = builtHandoff({ ...LEFTOVERS, report: `result: changed ${named}` })

    expect(pathTokens(sessionWrittenPart(built)).has(named)).toBe(true)
    expect(built.split('\n')).toContain(BUILT_HANDOFF_HEADING)
  })

  it('a second build quotes only what the session wrote, never the previous build', () => {
    const first = builtHandoff({ ...LEFTOVERS, body: 'the first body' })

    const second = builtHandoff({ ...LEFTOVERS, report: first, body: 'the second body' })

    expect(second).not.toContain('the first body')
    expect(second.split('\n').filter(line => line === BUILT_HANDOFF_HEADING)).toHaveLength(1)
  })
})

function stepsRead(transcript: string): string[] | null {
  const home = tempRoot()
  const file = transcriptFile(home, '/tree', 'stepped-session')!
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, transcript)
  vi.stubEnv('CLAUDE_CONFIG_DIR', home)
  const { lastSteps } = clientAdapter().reading({ session: 'stepped-session', cwd: '/tree', stdoutPath: null, stderrPath: null, exitCode: null })
  vi.unstubAllEnvs()
  return lastSteps
}

describe('the last steps of a session', () => {
  it('reads tool uses and text of the assistant only, the latest last, and survives a broken line', () => {
    const transcript = [
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'a prompt' }] } }),
      '{ not json',
      assistantLine([{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: 'first\nsaid' }]),
      assistantLine([{ type: 'tool_use', name: 'Bash', input: { command: 'pnpm lint', description: 'Run lint' } }, { type: 'tool_use', name: 'ToolSearch', input: {} }]),
    ].join('\n')

    expect(stepsRead(transcript)).toEqual(['first said', 'Bash Run lint', 'ToolSearch'])
  })

  it('keeps only the latest twelve', () => {
    const transcript = Array.from({ length: 20 }, (_, at) => assistantLine([{ type: 'text', text: `step ${at}` }])).join('\n')

    const steps = stepsRead(transcript)

    expect(steps).toHaveLength(12)
    expect(steps?.at(-1)).toBe('step 19')
  })
})

describe('the spend stop at the line', () => {
  it('is a budget-stop of this session at the spend level, and a context stop is not', () => {
    const root = tempRoot()
    const journal = eddiesJournalPath(root)
    mkdirSync(path.dirname(journal), { recursive: true })
    writeFileSync(journal, [{ event: 'budget-stop', level: 'session-context', session_id: 's' }, { event: 'budget-warn', level: 'session-spend', session_id: 's' }, { event: 'budget-stop', level: 'session-spend', session_id: 'other' }].map(line => JSON.stringify(line)).join('\n'))

    expect(stoppedOnSpend(root, 's')).toBe(false)
    expect(stoppedOnSpend(root, 'other')).toBe(true)
    expect(stoppedOnSpend(path.join(root, 'no-tree'), 's')).toBe(false)
  })
})

describe('the header', () => {
  it('states the form the bus reads at the context warn, with the limit the check holds', () => {
    expect(existsSync(HEADER_FILE)).toBe(true)
    const header = readFileSync(HEADER_FILE, 'utf8')

    expect(header).toContain(`${HANDOFF_LIMIT} bytes at most`)
    expect(header).toContain('The form the bus reads')
    expect(header).toContain('the bus builds a minimal handoff from the tree diff, the card body and your last')
    expect(header).not.toContain('a report without a\n  valid handoff stops the card')
  })
})
