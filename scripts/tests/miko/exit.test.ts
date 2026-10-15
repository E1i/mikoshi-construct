import type { RoleStop } from '../../bus/role.js'
import type { ExitLine, ExitReadings } from '../../miko/eddies-measure.js'
import type { MikoExitDeps } from '../../miko/exit.js'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { appendExitLine, realExitReadings, UNKNOWN, UNREAD } from '../../miko/eddies-measure.js'
import { ancestors, exitDecision, FRESH_MS, NOT_AT_A_STOP_CONDITION, parsePs, runMikoExit } from '../../miko/exit.js'
import { mikoHandoff } from '../../miko/loop.js'

const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..')
const LOOP = path.join(REPO_ROOT, 'scripts', 'miko', 'loop.ts')
const EXIT = path.join(REPO_ROOT, 'scripts', 'miko', 'exit.ts')
const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx')
const SESSION = 'session-972'
const LIMITS = { contextLimit: 250000, sessionSpend: 3000000, agentSpend: 2000000, runSpend: 3000000, warnRatio: 0.8 }
const CONTEXT_WARN = LIMITS.contextLimit * LIMITS.warnRatio
const STUB_CLAUDE = `#!/bin/sh
n=$(( $(cat "$STUB_DIR/count" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$STUB_DIR/count"
echo "$n" >> "$STUB_DIR/calls"
set -- $(sed -n "\${n}p" "$STUB_DIR/plan")
case "$1" in
  write) echo 'STATUS: CONTINUE' > "$HOME/.construct/handoff/miko.md" ;;
  owner) echo 'STATUS: OWNER' > "$HOME/.construct/handoff/miko.md" ;;
esac
case "$2" in
  exit)
    "$TSX" "$EXIT" 2>>"$STUB_DIR/exit.err"
    echo "$?" >> "$STUB_DIR/exit.code"
    sleep "\${3:-30}" >/dev/null 2>&1
    echo survived >> "$STUB_DIR/survived" ;;
esac
exit 0
`

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'miko-exit-'))
  roots.push(dir)
  mkdirSync(path.join(dir, '.construct', 'handoff'), { recursive: true })
  mkdirSync(path.join(dir, '.claude'), { recursive: true })
  writeFileSync(path.join(dir, '.claude', 'eddies.json'), JSON.stringify(LIMITS))
  return dir
}

function usageLine(timestamp: string, requestId: string, usage: { input: number, cacheWrite?: number, cacheRead?: number }): string {
  return JSON.stringify({ type: 'assistant', timestamp, requestId, message: { role: 'assistant', usage: { input_tokens: usage.input, cache_creation_input_tokens: usage.cacheWrite ?? 0, cache_read_input_tokens: usage.cacheRead ?? 0 } } })
}

function transcript(dir: string, lines: string[]): string {
  const file = path.join(dir, '.claude', 'projects', '-repo', `${SESSION}.jsonl`)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${lines.join('\n')}\n`)
  return file
}

function home(plan: string[]): string {
  const dir = scratch()
  writeFileSync(path.join(dir, 'claude'), STUB_CLAUDE, { mode: 0o755 })
  writeFileSync(path.join(dir, 'plan'), `${plan.join('\n')}\n`)
  transcript(dir, [usageLine('2026-10-15T00:00:00.000Z', 'r1', { input: CONTEXT_WARN })])
  return dir
}

function read(dir: string, name: string): string {
  return existsSync(path.join(dir, name)) ? readFileSync(path.join(dir, name), 'utf8') : ''
}

function journal(dir: string): ExitLine[] {
  return read(dir, path.join('.construct', 'eddies.jsonl')).split('\n').filter(Boolean).map(line => JSON.parse(line) as ExitLine)
}

function run(dir: string, command: string, args: string[]): Promise<{ code: number | null, signal: NodeJS.Signals | null, stderr: string }> {
  const child = spawn(command, args, {
    env: { ...process.env, HOME: dir, STUB_DIR: dir, MIKO_CLAUDE: path.join(dir, 'claude'), TSX, EXIT, CLAUDE_CODE_SESSION_ID: SESSION, CLAUDE_PROJECT_DIR: dir, CONSTRUCT_BUS_DB: path.join(dir, 'bus.db') },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })
  return new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal, stderr })))
}

const BELOW: ExitReadings = { ...UNREAD, sessionId: SESSION, context: CONTEXT_WARN - 1, contextWarn: CONTEXT_WARN, spent: LIMITS.sessionSpend - 1, sessionSpend: LIMITS.sessionSpend }
const AT_CONTEXT: ExitReadings = { ...BELOW, context: CONTEXT_WARN }
const AT_SPEND: ExitReadings = { ...BELOW, spent: LIMITS.sessionSpend }

const underLoop = parsePs('  1     0 /sbin/launchd\n 10     1 node tsx scripts/miko/loop.ts\n 12    10 claude\n 13    12 zsh\n 14    13 node exit.ts\n')
const outsideLoop = parsePs('  1     0 /sbin/launchd\n 12     1 claude\n 13    12 zsh\n 14    13 node exit.ts\n')

interface Outcome {
  code: number
  kills: number[]
  stops: RoleStop[]
  lines: string[]
  recorded: ExitLine[]
}

function exit(overrides: Partial<MikoExitDeps>): Outcome {
  const outcome: Outcome = { code: 0, kills: [], stops: [], lines: [], recorded: [] }
  outcome.code = runMikoExit({
    pid: 14,
    table: () => underLoop,
    handoffMtime: () => 0,
    now: () => 0,
    kill: pid => outcome.kills.push(pid),
    err: line => outcome.lines.push(line),
    readings: () => BELOW,
    recordExit: line => outcome.recorded.push(line),
    handoff: '/h/miko.md',
    status: () => 'CONTINUE',
    observeStop: stop => outcome.stops.push(stop),
    ...overrides,
  })
  return outcome
}

describe('pnpm miko:exit ends the claude of the current Mikoshi window', () => {
  it('ends a stub session at the context warn under the loop, the loop starts the next one, and the exit is journalled', async () => {
    const dir = home(['write exit', 'owner'])
    const { code, stderr } = await run(dir, TSX, [LOOP])
    expect(code).toBe(0)
    expect(read(dir, 'calls').split('\n').filter(Boolean)).toEqual(['1', '2'])
    expect(read(dir, 'exit.err')).toContain('ending claude')
    expect(read(dir, 'survived')).toBe('')
    expect(stderr).toContain('STATUS: CONTINUE: next session')
    expect(journal(dir)).toEqual([expect.objectContaining({ event: 'session-exit', session_id: SESSION, reason: 'context', start: { input: CONTEXT_WARN, cache_write: 0, cache_read: 0 } })])
  }, 20_000)

  it('refuses when miko.md is older than two minutes', async () => {
    const dir = home(['quiet exit 1'])
    writeFileSync(mikoHandoff(dir), 'old handoff')
    const threeMinutesAgo = (Date.now() - 3 * 60 * 1000) / 1000
    utimesSync(mikoHandoff(dir), threeMinutesAgo, threeMinutesAgo)
    const { code } = await run(dir, TSX, [LOOP])
    expect(code).toBe(0)
    expect(read(dir, 'exit.code').trim()).toBe('1')
    expect(read(dir, 'survived').trim()).toBe('survived')
    const age = Number(/miko\.md was written (\d+)s ago/.exec(read(dir, 'exit.err'))?.[1])
    expect(age).toBeGreaterThanOrEqual(180)
    expect(journal(dir)).toEqual([])
  }, 20_000)

  it('refuses outside the miko loop at the context warn with a stale CONTINUE handoff', async () => {
    const dir = home(['quiet exit 1'])
    writeFileSync(mikoHandoff(dir), 'STATUS: CONTINUE\n')
    const threeMinutesAgo = (Date.now() - 3 * 60 * 1000) / 1000
    utimesSync(mikoHandoff(dir), threeMinutesAgo, threeMinutesAgo)
    const { code, signal } = await run(dir, path.join(dir, 'claude'), [])
    expect({ code, signal }).toEqual({ code: 0, signal: null })
    expect(read(dir, 'exit.code').trim()).toBe('1')
    expect(read(dir, 'survived').trim()).toBe('survived')
    expect(read(dir, 'exit.err')).toContain('does not run under the pnpm miko loop')
  }, 20_000)
})

describe('exitDecision reads the stop reason, the process chain and the age of miko.md', () => {
  const now = 1_000_000_000
  const loop = { pid: 10, ppid: 1, args: 'node /x/node_modules/tsx/dist/cli.mjs /x/scripts/miko/loop.ts' }
  const shell = { pid: 11, ppid: 10, args: 'sh -c claude --permission-mode auto "$@" miko' }
  const claude = { pid: 12, ppid: 11, args: 'claude --permission-mode auto' }
  const zsh = { pid: 13, ppid: 12, args: '/bin/zsh -c -l eval pnpm miko:exit' }

  it('kills the nearest claude when the loop is above it and miko.md is fresh', () => {
    expect(exitDecision([zsh, claude, shell, loop], now - 1000, now, 'CONTINUE', AT_CONTEXT)).toMatchObject({ kill: 12, reason: 'context' })
  })

  it('takes a claude started through node by its script path', () => {
    const viaNode = { ...claude, args: 'node /usr/local/bin/claude --permission-mode auto' }
    expect(exitDecision([zsh, viaNode, shell, loop], now, now, 'CONTINUE', AT_CONTEXT)).toMatchObject({ kill: 12 })
  })

  it('refuses when another claude stands between the nearest claude and the loop', () => {
    const inner = { pid: 20, ppid: 13, args: '/tmp/stub/claude' }
    expect(exitDecision([inner, zsh, claude, shell, loop], now, now, null, AT_CONTEXT)).toMatchObject({ refuse: expect.stringContaining('claude 20 does not run under') })
  })

  it('refuses with no claude in the chain', () => {
    expect(exitDecision([shell, loop], now, now, 'OWNER', AT_CONTEXT)).toMatchObject({ refuse: expect.stringContaining('no claude') })
  })

  it.each([
    { name: 'absent', mtime: undefined, says: 'does not exist' },
    { name: 'older than two minutes', mtime: now - FRESH_MS - 1000, says: 'written 121s ago' },
  ])('refuses at the context warn when miko.md is $name', ({ mtime, says }) => {
    expect(exitDecision([zsh, claude, shell, loop], mtime, now, 'CONTINUE', AT_CONTEXT)).toMatchObject({ refuse: expect.stringContaining(says) })
  })
})

describe('miko:exit ends a session only at a stop reason', () => {
  it('a fresh handoff with STATUS CONTINUE below the context warn and the spend limit is refused with the not-at-a-stop-condition text', () => {
    const outcome = exit({ readings: () => BELOW })
    expect(outcome).toMatchObject({ code: 1, kills: [], stops: [], recorded: [] })
    expect(outcome.lines).toEqual([`[miko] ${NOT_AT_A_STOP_CONDITION}; nothing ended`])
  })

  it('a context at or above the warn ratio kills the session with STATUS CONTINUE', () => {
    expect(exit({ readings: () => AT_CONTEXT })).toMatchObject({ code: 0, kills: [12], recorded: [expect.objectContaining({ reason: 'context' })] })
  })

  it('a session spend at or above the eddies limit kills the session with STATUS CONTINUE', () => {
    expect(exit({ readings: () => AT_SPEND })).toMatchObject({ code: 0, kills: [12], recorded: [expect.objectContaining({ reason: 'spend' })] })
  })

  it('a handoff with STATUS OWNER kills the session without conditions', () => {
    const outcome = exit({ table: () => outsideLoop, handoffMtime: () => undefined, readings: () => UNREAD, status: () => 'OWNER' })
    expect(outcome).toMatchObject({ code: 0, kills: [12], stops: [], recorded: [expect.objectContaining({ reason: 'owner' })] })
  })

  it('an exit at each stop reason writes one eddies.jsonl line whose reason is the decision', () => {
    const cases = [
      { status: 'CONTINUE', readings: AT_CONTEXT, reason: 'context' },
      { status: 'CONTINUE', readings: AT_SPEND, reason: 'spend' },
      { status: 'OWNER', readings: BELOW, reason: 'owner' },
      { status: 'DONE', readings: BELOW, reason: 'done' },
    ]
    for (const { status, readings, reason } of cases) {
      const dir = scratch()
      exit({ status: () => status, readings: () => readings, recordExit: line => appendExitLine(dir, line) })
      expect(journal(dir)).toEqual([{ v: 1, event: 'session-exit', session_id: SESSION, start: UNKNOWN, end: UNKNOWN, spent: readings.spent, measurement_basis: expect.stringContaining('spent = input_tokens'), reason, cards: UNKNOWN, bus_events: UNKNOWN, at: new Date(0).toISOString() }])
    }
  })

  it('a refused exit writes no eddies.jsonl line', () => {
    const dir = scratch()
    expect(exit({ readings: () => BELOW, recordExit: line => appendExitLine(dir, line) }).code).toBe(1)
    expect(existsSync(path.join(dir, '.construct', 'eddies.jsonl'))).toBe(false)
  })

  it('without the session file the counters are unknown and an OWNER or DONE exit still happens', () => {
    const dir = scratch()
    const readings = realExitReadings({ CLAUDE_CODE_SESSION_ID: SESSION }, dir, dir, path.join(dir, 'bus.db'))
    expect(readings).toEqual({ ...UNREAD, sessionId: SESSION, contextWarn: CONTEXT_WARN, sessionSpend: LIMITS.sessionSpend })
    for (const status of ['OWNER', 'DONE']) {
      const outcome = exit({ status: () => status, readings: () => readings, handoffMtime: () => undefined })
      expect(outcome.kills).toEqual([12])
      expect(outcome.recorded).toEqual([expect.objectContaining({ start: UNKNOWN, end: UNKNOWN, spent: UNKNOWN, cards: UNKNOWN, bus_events: UNKNOWN })])
    }
  })

  it('a failed eddies.jsonl write still ends the session at a stop reason and records no zero', () => {
    const outcome = exit({ readings: () => AT_CONTEXT, recordExit: () => {
      throw new Error('disk full')
    } })
    expect(outcome).toMatchObject({ code: 0, kills: [12] })
    expect(outcome.lines[0]).toContain('session-exit line was not written (disk full)')
  })
})

describe('runMikoExit walks the process table from its own pid', () => {
  it('walks ancestors from its own pid', () => {
    expect(ancestors(underLoop, 14).map(row => row.pid)).toEqual([13, 12, 10, 1])
  })

  it.each([
    { mtime: 0, killed: [12], code: 0 },
    { mtime: undefined, killed: [], code: 1 },
  ])('at the context warn with miko.md at $mtime exits $code and kills $killed', ({ mtime, killed, code }) => {
    const outcome = exit({ handoffMtime: () => mtime, readings: () => AT_CONTEXT })
    expect(outcome).toMatchObject({ code, kills: killed })
    expect(outcome.lines).toHaveLength(1)
  })
})

describe('a Miko window outside the pnpm miko loop that stops at a threshold', () => {
  const now = 1_000_000_000
  const claude = { pid: 12, ppid: 1, args: 'claude --permission-mode auto' }
  const zsh = { pid: 13, ppid: 12, args: '/bin/zsh -c -l eval pnpm miko:exit' }

  it.each([
    { readings: AT_CONTEXT, reason: 'context' },
    { readings: AT_SPEND, reason: 'spend' },
  ])('with STATUS: CONTINUE in a fresh miko.md at the $reason limit writes role.stopped for miko and ends its claude', ({ readings, reason }) => {
    const outcome = exit({ table: () => outsideLoop, readings: () => readings, raised: false })
    expect(outcome.stops).toEqual([{ role: 'miko', handoff: '/h/miko.md', status: 'CONTINUE', reason, raised: false }])
    expect(outcome.kills).toEqual([12])
    expect(outcome.lines.at(-1)).toContain('role.stopped goes to the bus')
  })

  it('after handoff:write below every stop reason a raised claude outside the loop with a fresh CONTINUE handoff is refused, not ended, and posts no role.stopped', () => {
    const outcome = exit({ table: () => outsideLoop, handoff: '/h/mikoshi.md', raised: true })
    expect(outcome).toMatchObject({ code: 1, kills: [], stops: [] })
    expect(outcome.lines[0]).toContain(NOT_AT_A_STOP_CONDITION)
  })

  it.each([
    { name: 'STATUS: STOP', status: 'STOP', mtime: now },
    { name: 'no STATUS', status: null, mtime: now },
    { name: 'a stale miko.md', status: 'CONTINUE', mtime: now - FRESH_MS - 1000 },
  ])('at the context warn with $name refuses as before and writes nothing', ({ status, mtime }) => {
    expect(exitDecision([zsh, claude], mtime, now, status, AT_CONTEXT)).toMatchObject({ refuse: expect.stringContaining('does not run under the pnpm miko loop') })
  })
})
