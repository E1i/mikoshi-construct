import type { Lease } from '../../core/lease.js'
import type { AnswerOutcome } from '../../nodes/answer/duties/index.js'
import type { CardTreeTools } from '../../ports/card-tree.js'
import type { MergeBench } from './merge-bench.js'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PREPUSH_COMMAND } from '../../ci/prepush.js'
import { appendEvent } from '../../core/db.js'
import { CARD_ANSWERED, CARD_STARTED, CARD_STOPPED } from '../../core/events.js'
import { leaseNext } from '../../core/lease.js'
import { queueTask } from '../../core/queue.js'
import { AnswerExecutor, noGateDecisionLine } from '../../nodes/answer/answer-executor.js'
import { claudeAnswerer, gateInShellLine, IN_THE_BACKGROUND, RoundTimer } from '../../nodes/answer/answerer.js'
import { gateLine } from '../../nodes/answer/duties/index.js'
import { cardTransitions } from '../../supervisor/composition.js'
import { SILENT_MS } from '../../supervisor/liveness-sites.js'
import { sha } from './github-fake.js'
import { eventsOf, mergeBench } from './merge-bench.js'

const CARD = 1965
const TYPECHECK = 'pnpm typecheck'
const ROUND = sha('b')
const PREPUSH_ROUND = `${PREPUSH_COMMAND} --round ${ROUND}`
const GATE = [TYPECHECK, PREPUSH_ROUND]
const PIPED_FROM_A_CD = `cd /t; ${TYPECHECK} 2>&1 | tail -15`
const BACKGROUND_START = 'Command running in background with ID: b1. Output is being written to: /tmp/b1.output'

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

interface GateRun {
  command: string
  background?: boolean
  isError?: boolean
  content?: string
}

function bashUse(id: string, run: GateRun): string {
  return JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: run.command, ...(run.background === true ? { run_in_background: true } : {}) } }] } })
}

function bashResult(id: string, run: GateRun): string {
  return JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: run.isError ?? false, content: run.content ?? 'ok' }] } })
}

function streamOf(runs: readonly GateRun[]): string[] {
  return runs.flatMap((run, index) => [bashUse(`t${index}`, run), bashResult(`t${index}`, run)])
}

function timerAfter(runs: readonly GateRun[]): RoundTimer {
  const timer = new RoundTimer(() => 0, GATE)
  streamOf(runs).forEach(line => timer.line(line))
  return timer
}

async function roundWith(runs: readonly GateRun[]): Promise<{ outcome: AnswerOutcome, published: number, made: MergeBench }> {
  const made = mergeBench()
  benches.push(made)
  const trees = mkdtempSync(path.join(tmpdir(), 'answer-gate-forms-'))
  roots.push(trees)
  const worktree = path.join(trees, `mc-${CARD}`)
  mkdirSync(worktree)
  writeFileSync(path.join(worktree, 'construct.json'), `${JSON.stringify({ harness: { command: 'pnpm run quality' }, shift: { prepush: [TYPECHECK, PREPUSH_COMMAND] } })}\n`)
  const ts = made.clock.now().toISOString()
  appendEvent(made.db, { ts, type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:${CARD}`, payload: { session: 'card-session-1', worktree, branch: `feat/card-${CARD}`, base: sha('1') }, legacy: false })
  appendEvent(made.db, { ts, type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${CARD}`, payload: { reason: 'question.agent', detail: 'a question' }, legacy: false })
  const stop = Number((made.db.prepare('SELECT max(id) AS id FROM events WHERE type = ?').get(CARD_STOPPED) as { id: number }).id)
  queueTask(made.db, ts, { queue: 'answer', cardId: CARD, stop })
  const lease = (): Lease => leaseNext(made.db, ts, 'answer', 'worker:answer:worker-1')!
  let published = 0
  const answerer = claudeAnswerer(path.join(trees, 'answers'), {
    cardText: () => null,
    available: () => true,
    remoteHead: () => published === 0 ? sha('a') : sha('e'),
    localHead: () => ROUND,
    spawn: async (run) => {
      const lines = streamOf(runs)
      lines.forEach(line => run.onLine?.(line))
      writeFileSync(run.stdoutPath, `${lines.join('\n')}\n`)
      return 0
    },
    newSession: () => 'new-session-1',
    publish: () => {
      published += 1
    },
  })
  const cardTrees: CardTreeTools = { home: trees, exists: existsSync, branchOf: pr => `feat/card-${pr}`, recreate: () => {}, bringTo: () => {} }
  const executor = new AnswerExecutor({ cards: cardTransitions(), silentMs: SILENT_MS, db: made.db, answerer, ownerMerges: () => '', clock: made.clock.now, trees: cardTrees, liveSession: () => null, prepare: () => null, dirty: () => true, localHead: () => sha('a') })
  return { outcome: await executor.answer(lease()), published, made }
}

const PREPUSH_PIPED_FROM_A_CD = `cd /t; ${PREPUSH_ROUND} | tail -20`

describe('a gate command is recognised inside any shell line', () => {
  it('a gate run inside a cd-prefixed piped line is recorded as a gate run', async () => {
    const timer = timerAfter([{ command: PREPUSH_PIPED_FROM_A_CD }, { command: PIPED_FROM_A_CD }])
    expect(timer.decision()).toBe('unrun')
    expect(timer.offFormGateCommands()).toEqual([])

    const { outcome, published } = await roundWith([{ command: PREPUSH_PIPED_FROM_A_CD }, { command: PIPED_FROM_A_CD }])
    expect(published).toBe(1)
    expect(outcome).toMatchObject({ kind: 'answered' })
  })

  it.each([
    [`cd /t && ${TYPECHECK} | tail -15`, 'unrun'],
    [`cd /t; pnpm --dir /t run typecheck 2>&1 | tail`, 'unrun'],
    [`pnpm --dir /t typecheck 2>&1`, 'green'],
    [`cd /t; set -o pipefail; ${TYPECHECK} | tail -15`, 'green'],
  ])('the line %s records the typecheck run as %s', (command, outcome) => {
    const timer = timerAfter([{ command }, { command: PREPUSH_ROUND }])

    expect(timer.decision()).toBe(outcome)
    expect(timer.offFormGateCommands()).toEqual([])
  })

  it.each([
    ' ELIFECYCLE  Typecheck failed.',
    ' ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  the gate failed',
    'Command failed with exit code 2.',
  ])('a piped gate whose output shows its own failure as %s is recorded red', (content) => {
    const timer = timerAfter([{ command: PIPED_FROM_A_CD, content }, { command: PREPUSH_ROUND }])

    expect(timer.decision()).toBe('red')
  })

  it('a piped gate whose output shows a zero exit code is not recorded red', () => {
    const timer = timerAfter([{ command: PIPED_FROM_A_CD, content: 'Command failed with exit code 0.' }, { command: PREPUSH_ROUND }])

    expect(timer.decision()).toBe('unrun')
  })

  it.each([
    [`set -o pipefail && ${TYPECHECK} | tail`, true, 'red'],
    [`set -o pipefail; cd /t; ${TYPECHECK} | tail`, true, 'red'],
    [`set -o pipefail; cd /t; ${TYPECHECK} | tail`, false, 'green'],
  ])('the pipefail line %s exiting in error %s takes the gate exit from the line exit as %s', (command, isError, outcome) => {
    const timer = timerAfter([{ command, isError, content: isError ? 'Exit code 2' : 'ok' }, { command: PREPUSH_ROUND }])

    expect(timer.decision()).toBe(outcome)
  })

  it.each([
    `${TYPECHECK} && pnpm lint`,
    `${TYPECHECK}; echo done`,
    `cd /t && ${TYPECHECK} && pnpm lint`,
    `${TYPECHECK} || echo failed`,
    `cd /t; ${TYPECHECK} || echo failed`,
  ])('a gate chained to another command in %s is recorded as a gate run, as before', (command) => {
    const timer = timerAfter([{ command }, { command: PREPUSH_ROUND }])

    expect(timer.decision()).toBe('green')
    expect(timer.offFormGateCommands()).toEqual([])
  })

  it('a gate line whose only bar is an or-else is a gate run, not a piped one', () => {
    const timer = timerAfter([{ command: `${TYPECHECK} || echo failed` }, { command: `${PREPUSH_ROUND} || echo failed` }])

    expect(timer.decision()).toBe('green')
    expect(gateInShellLine(`${TYPECHECK} || echo failed`, GATE)).toEqual({ gate: TYPECHECK, piped: false, pipefail: false })
    expect(gateInShellLine(`${TYPECHECK} || echo failed | tail`, GATE)).toEqual({ gate: TYPECHECK, piped: true, pipefail: false })
  })

  it('a gate declared with a trailing stream merge and run exactly as declared is recorded as a gate run', () => {
    const declaredWithMerge = `${TYPECHECK} 2>&1`

    expect(gateInShellLine(declaredWithMerge, [declaredWithMerge, PREPUSH_ROUND])).toEqual({ gate: declaredWithMerge, piped: false, pipefail: false })
    expect(gateInShellLine(`cd /t; ${declaredWithMerge} | tail`, [declaredWithMerge])).toEqual({ gate: declaredWithMerge, piped: true, pipefail: false })
  })

  it('a line that only mentions the gate is not recorded as a gate run', () => {
    const timer = timerAfter([{ command: 'grep prepush.ts notes.md' }, { command: `echo ${TYPECHECK}` }, { command: TYPECHECK }, { command: PREPUSH_PIPED_FROM_A_CD, background: true, content: BACKGROUND_START }])

    expect(timer.decision()).toBeNull()
    expect(timer.offFormGateCommands()).toEqual([`echo ${TYPECHECK}`, `${PREPUSH_PIPED_FROM_A_CD}${IN_THE_BACKGROUND}`])
  })
})

describe('a gate command counts only in a form the bus reads (D-627)', () => {
  it('a round with a gate command only in a background run is denied naming that command', async () => {
    const { outcome, published, made } = await roundWith([{ command: TYPECHECK }, { command: PREPUSH_ROUND, background: true, content: BACKGROUND_START }])
    expect(published).toBe(0)
    expect(eventsOf(made.db, CARD_ANSWERED)).toEqual([])
    expect(outcome).toMatchObject({ kind: 'denied', denial: { reason: 'answer_failed', detail: expect.stringContaining('recorded no gate decision') } })
    expect(outcome).toMatchObject({ denial: { detail: expect.stringContaining(`\`${PREPUSH_ROUND}${IN_THE_BACKGROUND}\``) } })
  })

  it('a gate command started in the background records no outcome from its start line', () => {
    const backgroundPrepush = `cd /t; ${PREPUSH_ROUND} 2>&1 | tail -40`
    const timer = timerAfter([{ command: TYPECHECK }, { command: backgroundPrepush, background: true, content: BACKGROUND_START }])

    expect(timer.decision()).toBeNull()
    expect(timer.decision()).not.toBe('green')
  })

  it('a gate command in its declared form run in the background is named and never green', () => {
    const timer = timerAfter([{ command: TYPECHECK }, { command: PREPUSH_ROUND, background: true, content: BACKGROUND_START }])

    expect(timer.decision()).toBeNull()
    expect(timer.offFormGateCommands()).toEqual([`${PREPUSH_ROUND}${IN_THE_BACKGROUND}`])
  })

  it('a session that ran every gate command as declared names no command and decides the gate', () => {
    const timer = timerAfter([{ command: TYPECHECK }, { command: `pnpm --dir /t run typecheck` }, { command: 'pnpm exec vitest run' }, { command: PREPUSH_ROUND }])

    expect(timer.decision()).toBe('green')
    expect(timer.offFormGateCommands()).toEqual([])
  })

  it('a denial naming two off-form gate commands counts them and joins both', () => {
    const backgroundPrepush = `${PREPUSH_ROUND}${IN_THE_BACKGROUND}`
    const line = noGateDecisionLine(CARD, { session: 's', before: null, offFormGateCommands: [PIPED_FROM_A_CD, backgroundPrepush] })

    expect(line).toContain(`the session ran 2 gate commands not in its declared form, which the bus does not record (D-627): \`${PIPED_FROM_A_CD}\`, \`${backgroundPrepush}\``)
  })

  it('a denial with no command off its form reads as before', () => {
    expect(noGateDecisionLine(CARD, { session: 's', before: null })).not.toContain('D-627')
  })

  it('a denial whose round carries an empty list of off-form commands reads as before', () => {
    expect(noGateDecisionLine(CARD, { session: 's', before: null, offFormGateCommands: [] })).toBe(noGateDecisionLine(CARD, { session: 's', before: null }))
  })

  it('the answer prompt names the gate commands to run as declared from the tree', () => {
    const line = gateLine({ prepush: GATE, handoffWrite: null, codeMatrix: null })

    expect(line).toContain(GATE.join(', '))
    expect(line).toContain('run each gate command exactly as declared, from the tree as cwd, with no cd prefix, no pipe and no background run')
  })
})
