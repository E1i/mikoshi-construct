import type { RoleStop, WindowEnd } from '../../nodes/restart/role.js'
import type { ExitLine, ExitReadings } from '../../window/eddies-measure.js'
import type { MikoExitDeps, ProcessRow } from '../../window/exit.js'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendExitLine, LOADED_CORE_VARIABLE, realExitReadings, UNKNOWN, UNREAD } from '../../window/eddies-measure.js'
import { ancestors, exitDecision, FRESH_MS, loopExitDecision, loopRequestOf, NOT_AT_A_STOP_CONDITION, notAtAStopRefusal, runMikoExit, SANDBOX_REFUSAL, sessionClaudeOf, stopReasonOf, TAB_THRESHOLD } from '../../window/exit.js'
import { MIKO_HANDOFF_NAME, mikoHandoff } from '../../window/loop.js'
import { ENTRYPOINT_VARIABLE, HEADLESS_ENTRYPOINT } from '../../window/tab.js'

function tableOf(text: string): ProcessRow[] {
  return text.trim().split('\n').map((line) => {
    const [pid, ppid, ...args] = line.trim().split(/\s+/)
    return { pid: Number(pid), ppid: Number(ppid), args: args.join(' ') }
  })
}

const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..')
const LOOP = path.join(REPO_ROOT, 'scripts', 'window', 'loop.ts')
const EXIT = path.join(REPO_ROOT, 'scripts', 'window', 'exit.ts')
const TSX = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx')
const TSX_LOADER = pathToFileURL(path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href
const SESSION = 'session-972'
const LIMITS = { contextLimit: 250000, sessionSpend: 3000000, agentSpend: 2000000, runSpend: 3000000, warnRatio: 0.8 }
const CONTEXT_WARN = LIMITS.contextLimit * LIMITS.warnRatio
const SPEND_WARN = LIMITS.sessionSpend * LIMITS.warnRatio
const STUB_CLAUDE = `#!/bin/sh
n=$(( $(cat "$STUB_DIR/count" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$STUB_DIR/count"
echo "$n" >> "$STUB_DIR/calls"
set -- $(sed -n "\${n}p" "$STUB_DIR/plan")
case "$1" in
  write) echo 'STATUS: CONTINUE' > "$HOME/.construct/handoff/miko.md" ;;
  end-loop) echo 'STATUS: OWNER' > "$HOME/.construct/handoff/miko.md" ;;
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

function run(dir: string, command: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null, signal: NodeJS.Signals | null, stderr: string }> {
  const child = spawn(command, args, {
    env: { ...process.env, HOME: dir, STUB_DIR: dir, MIKO_CLAUDE: path.join(dir, 'claude'), TSX, EXIT, CLAUDE_CODE_SESSION_ID: SESSION, CLAUDE_PROJECT_DIR: dir, CONSTRUCT_BUS_DB: path.join(dir, 'bus.db'), CONSTRUCT_CARD: '', ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })
  return new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal, stderr })))
}

const BELOW: ExitReadings = { ...UNREAD, sessionId: SESSION, context: CONTEXT_WARN - 1, contextWarn: CONTEXT_WARN, spent: SPEND_WARN - 1, spendWarn: SPEND_WARN }
const AT_CONTEXT: ExitReadings = { ...BELOW, context: CONTEXT_WARN }
const AT_SPEND_WARN: ExitReadings = { ...BELOW, spent: SPEND_WARN }
const AT_SPEND: ExitReadings = { ...BELOW, spent: LIMITS.sessionSpend }

const underLoop = tableOf('  1     0 /sbin/launchd\n 10     1 node tsx scripts/window/loop.ts\n 12    10 claude\n 13    12 zsh\n 14    13 node exit.ts\n')
const outsideLoop = tableOf('  1     0 /sbin/launchd\n 12     1 claude\n 13    12 zsh\n 14    13 node exit.ts\n')

interface Outcome {
  code: number
  kills: number[]
  stops: RoleStop[]
  ends: WindowEnd[]
  lines: string[]
  recorded: ExitLine[]
}

function exit(overrides: Partial<MikoExitDeps>): Outcome {
  const outcome: Outcome = { code: 0, kills: [], stops: [], ends: [], lines: [], recorded: [] }
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
    endWindow: end => outcome.ends.push(end),
    ...overrides,
  })
  return outcome
}

describe('pnpm miko:exit ends the claude of the current Mikoshi window', () => {
  it('ends a stub session at the context warn under the loop, the loop starts the next one, which ends the loop on its own, the exit is journalled and no exit request is left', async () => {
    const dir = home(['write exit', 'end-loop'])
    const { code, stderr } = await run(dir, TSX, [LOOP])
    expect(code).toBe(0)
    expect(read(dir, 'calls').split('\n').filter(Boolean)).toEqual(['1', '2'])
    expect(read(dir, 'exit.err')).toContain('the loop ends the session at the context limit')
    expect(read(dir, 'survived')).toBe('')
    expect(stderr).toContain('STATUS: CONTINUE: next session')
    expect(journal(dir)).toEqual([expect.objectContaining({ event: 'session-exit', session_id: SESSION, reason: 'context', start: { input: CONTEXT_WARN, cache_write: 0, cache_read: 0 } })])
    expect(readdirSync(path.dirname(mikoHandoff(path.join(dir, '.construct', 'handoff')))).filter(name => name.startsWith('miko-exit.'))).toEqual([])
  }, 20_000)

  it('miko exit at the eddies threshold with a fresh CONTINUE handoff exits 0', async () => {
    const dir = scratch()
    const limits = { ...LIMITS, contextLimit: 150000 }
    writeFileSync(path.join(dir, '.claude', 'eddies.json'), JSON.stringify(limits))
    transcript(dir, [usageLine('2026-11-02T00:00:00.000Z', 'r1', { input: limits.contextLimit * limits.warnRatio + 474 })])
    writeFileSync(path.join(dir, '.construct', 'handoff', MIKO_HANDOFF_NAME), '# Handoff\n\nnext task: #650 brief\n\nSTATUS: CONTINUE\n')
    const request = path.join(dir, 'exit-request')
    const child = spawn(process.execPath, ['--import', pathToFileURL(path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href, EXIT], {
      cwd: dir,
      env: { ...process.env, HOME: dir, CLAUDE_CODE_SESSION_ID: SESSION, CLAUDE_PROJECT_DIR: '', CONSTRUCT_HANDOFF_DIR: path.join(dir, '.construct', 'handoff'), CONSTRUCT_HANDOFF: '', CONSTRUCT_BUS_DB: path.join(dir, 'bus.db'), CONSTRUCT_CARD: '', MIKO_WINDOW: '1', MIKO_LOOP_PID: '1', MIKO_EXIT_REQUEST: request },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    const code = await new Promise<number | null>(resolve => child.on('close', resolve))

    expect({ code, stderr }).toMatchObject({ code: 0, stderr: expect.stringContaining('the loop ends the session at the context limit') })
    expect(existsSync(request)).toBe(true)
    expect(journal(dir)).toEqual([expect.objectContaining({ reason: 'context' })])
  }, 30_000)

  it('refuses when miko.md is older than two minutes', async () => {
    const dir = home(['quiet exit 1'])
    writeFileSync(mikoHandoff(path.join(dir, '.construct', 'handoff')), 'old handoff')
    const threeMinutesAgo = (Date.now() - 3 * 60 * 1000) / 1000
    utimesSync(mikoHandoff(path.join(dir, '.construct', 'handoff')), threeMinutesAgo, threeMinutesAgo)
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
    writeFileSync(mikoHandoff(path.join(dir, '.construct', 'handoff')), 'STATUS: CONTINUE\n')
    const threeMinutesAgo = (Date.now() - 3 * 60 * 1000) / 1000
    utimesSync(mikoHandoff(path.join(dir, '.construct', 'handoff')), threeMinutesAgo, threeMinutesAgo)
    const { code, signal } = await run(dir, path.join(dir, 'claude'), [], { [ENTRYPOINT_VARIABLE]: HEADLESS_ENTRYPOINT })
    expect({ code, signal }).toEqual({ code: 0, signal: null })
    expect(read(dir, 'exit.code').trim()).toBe('1')
    expect(read(dir, 'survived').trim()).toBe('survived')
    expect(read(dir, 'exit.err')).toContain('does not run under the pnpm miko loop')
  }, 20_000)
})

describe('exitDecision reads the stop reason, the process chain and the age of miko.md', () => {
  const now = 1_000_000_000
  const loop = { pid: 10, ppid: 1, args: 'node /x/node_modules/tsx/dist/cli.mjs /x/scripts/window/loop.ts' }
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
  it('a fresh handoff with STATUS CONTINUE below the context warn and the spend warn is refused with the not-at-a-stop-condition text', () => {
    const outcome = exit({ readings: () => BELOW })
    expect(outcome).toMatchObject({ code: 1, kills: [], stops: [], recorded: [] })
    expect(outcome.lines).toEqual([`[miko] ${notAtAStopRefusal(BELOW)}`])
  })

  it('a context at or above the warn ratio kills the session with STATUS CONTINUE', () => {
    expect(exit({ readings: () => AT_CONTEXT })).toMatchObject({ code: 0, kills: [12], recorded: [expect.objectContaining({ reason: 'context' })] })
  })

  it.each([
    { name: 'the spend warn', readings: AT_SPEND_WARN },
    { name: 'the spend limit', readings: AT_SPEND },
  ])('a session spend at or above the spend warn kills the session with STATUS CONTINUE: at $name', ({ readings }) => {
    expect(exit({ readings: () => readings })).toMatchObject({ code: 0, kills: [12], recorded: [expect.objectContaining({ reason: 'spend' })] })
  })

  it('a handoff with STATUS DONE kills the session without conditions', () => {
    const outcome = exit({ table: () => outsideLoop, handoffMtime: () => undefined, readings: () => UNREAD, status: () => 'DONE' })
    expect(outcome).toMatchObject({ code: 0, kills: [12], stops: [], recorded: [expect.objectContaining({ reason: 'done' })] })
  })

  it('with no handoff the exit refuses naming the missing handoff before it reads the process table', () => {
    const table = vi.fn(() => tableOf('  1     0 /sbin/launchd\n 14     1 node exit.ts\n'))
    const outcome = exit({ table, handoffMtime: () => undefined, status: () => null, readings: () => AT_CONTEXT })
    expect(outcome).toMatchObject({ code: 1, kills: [], recorded: [] })
    expect(outcome.lines).toEqual([`[miko] ${MIKO_HANDOFF_NAME} does not exist: write it with pnpm handoff:write first; nothing ended`])
    expect(table).not.toHaveBeenCalled()
  })

  it('a handoff with STATUS OWNER is no stop reason and pnpm miko:exit refuses it', () => {
    expect(stopReasonOf('OWNER', BELOW)).toBeNull()
    const outcome = exit({ status: () => 'OWNER', readings: () => BELOW })
    expect(outcome).toMatchObject({ code: 1, kills: [], stops: [], recorded: [] })
    expect(outcome.lines).toEqual([`[miko] ${notAtAStopRefusal(BELOW)}`])
    expect(exit({ status: () => 'OWNER', readings: () => AT_CONTEXT })).toMatchObject({ code: 0, kills: [12], recorded: [expect.objectContaining({ reason: 'context' })] })
  })

  it('an exit at each stop reason writes one eddies.jsonl line whose reason is the decision', () => {
    const cases = [
      { status: 'CONTINUE', readings: AT_CONTEXT, reason: 'context' },
      { status: 'CONTINUE', readings: AT_SPEND, reason: 'spend' },
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

  it('without the session file the counters are unknown and a DONE exit still happens', () => {
    const dir = scratch()
    const readings = realExitReadings({ CLAUDE_CODE_SESSION_ID: SESSION }, dir, dir, path.join(dir, 'bus.db'))
    expect(readings).toEqual({ ...UNREAD, sessionId: SESSION, contextWarn: CONTEXT_WARN, contextWarnSource: '.claude/eddies.json contextLimit × warnRatio', budgetWarned: false, spendWarn: SPEND_WARN })
    const outcome = exit({ status: () => 'DONE', readings: () => readings, handoffMtime: () => undefined })
    expect(outcome.kills).toEqual([12])
    expect(outcome.recorded).toEqual([expect.objectContaining({ start: UNKNOWN, end: UNKNOWN, spent: UNKNOWN, cards: UNKNOWN, bus_events: UNKNOWN })])
  })

  it.each([
    { name: 'no session id', env: {} },
    { name: 'no transcript of the session', env: { CLAUDE_CODE_SESSION_ID: SESSION } },
  ])('an unread context at the warn ends the session as a context stop and journals its counters as unknown ($name)', ({ env }) => {
    const dir = scratch()
    const readings = realExitReadings(env, dir, dir, path.join(dir, 'bus.db'))
    expect(readings.context).toBe(UNKNOWN)
    const outcome = exit({ readings: () => readings, recordExit: line => appendExitLine(dir, line) })
    expect(outcome).toMatchObject({ code: 0, kills: [12] })
    expect(journal(dir)).toEqual([expect.objectContaining({ reason: 'context', start: UNKNOWN, end: UNKNOWN, spent: UNKNOWN, cards: UNKNOWN, bus_events: UNKNOWN })])
  })

  it('a failed eddies.jsonl write still ends the session at a stop reason and records no zero', () => {
    const outcome = exit({ readings: () => AT_CONTEXT, recordExit: () => {
      throw new Error('disk full')
    } })
    expect(outcome).toMatchObject({ code: 0, kills: [12] })
    expect(outcome.lines[0]).toContain('session-exit line was not written (disk full)')
  })
})

describe('the line this session crossed is the stop, by the record of the hook', () => {
  const COMPACTED = CONTEXT_WARN - 1

  function journalLine(line: Record<string, unknown>): string {
    return JSON.stringify({ v: 1, event: 'budget-warn', level: 'session-context', session_id: SESSION, agent_id: null, spent: CONTEXT_WARN, limit: LIMITS.contextLimit, warn_ratio: LIMITS.warnRatio, ...line })
  }

  function compactedSession(journalLines: string[]): ExitReadings {
    const dir = scratch()
    const file = transcript(dir, [usageLine('2026-11-05T00:00:00.000Z', 'r1', { input: CONTEXT_WARN }), usageLine('2026-11-05T00:10:00.000Z', 'r2', { input: COMPACTED })])
    writeFileSync(path.join(dir, '.construct', 'eddies.jsonl'), `${journalLines.join('\n')}\n`)
    const readings = realExitReadings({ CLAUDE_CODE_SESSION_ID: SESSION }, dir, dir, path.join(dir, 'bus.db'))
    expect(readings).toMatchObject({ context: COMPACTED, contextSource: file })
    return readings
  }

  it('a session the hook warned on context and compaction then shrank is ended by miko:exit', () => {
    const warned = compactedSession([journalLine({})])
    expect(exit({ readings: () => warned })).toMatchObject({ code: 0, kills: [12], recorded: [expect.objectContaining({ reason: 'context' })] })

    const anotherSession = compactedSession([journalLine({ session_id: 'session-other' })])
    expect(anotherSession.budgetWarned).toBe(false)
    expect(exit({ readings: () => anotherSession })).toMatchObject({ code: 1, kills: [], recorded: [] })
  })

  it('a spend warn of this session, a line of another event and a broken line are no context crossing', () => {
    const readings = compactedSession([journalLine({ level: 'session-spend' }), journalLine({ event: 'budget-stop' }), '{"event":"budget-warn"', 'null'])
    expect(readings.budgetWarned).toBe(false)
    expect(stopReasonOf('CONTINUE', readings)).toBeNull()
  })

  it('an unreadable journal counts as no line and its finding prints as unknown', () => {
    const dir = scratch()
    transcript(dir, [usageLine('2026-11-05T00:00:00.000Z', 'r1', { input: COMPACTED })])
    mkdirSync(path.join(dir, '.construct', 'eddies.jsonl'))
    const readings = realExitReadings({ CLAUDE_CODE_SESSION_ID: SESSION }, dir, dir, path.join(dir, 'bus.db'))
    expect(readings.budgetWarned).toBe(UNKNOWN)
    expect(stopReasonOf('CONTINUE', readings)).toBeNull()
    expect(notAtAStopRefusal(readings)).toContain('budget-warn of this session unknown (.construct/eddies.jsonl)')
  })

  it('a tab window the hook warned on context ends nothing and prints TAB_THRESHOLD', () => {
    const outcome = exit({ tab: true, table: () => outsideLoop, readings: () => compactedSession([journalLine({})]) })
    expect(outcome).toMatchObject({ code: 1, kills: [], recorded: [] })
    expect(outcome.lines).toEqual([`[miko] ${TAB_THRESHOLD}`])
  })

  it('a miko:exit refusal prints the context, the line and their source', () => {
    const readings = compactedSession([journalLine({ session_id: 'session-other' })])
    const refusal = `${NOT_AT_A_STOP_CONDITION}; read context ${COMPACTED} (${String(readings.contextSource)}), line ${CONTEXT_WARN} (.claude/eddies.json contextLimit × warnRatio), budget-warn of this session not found (.construct/eddies.jsonl); nothing ended`
    expect(loopExitDecision(0, 0, 'CONTINUE', readings)).toEqual({ refuse: refusal })
    expect(exit({ readings: () => readings }).lines).toEqual([`[miko] ${refusal}`])

    const unread = exit({ readings: () => ({ ...readings, contextWarn: UNKNOWN, contextWarnSource: UNKNOWN }) })
    expect(unread.code).toBe(1)
    expect(unread.lines[0]).toContain('line unknown (unknown)')
  })

  it('the line of a card session names cardContextLine as its source', () => {
    const dir = scratch()
    writeFileSync(path.join(dir, '.claude', 'eddies.json'), JSON.stringify({ ...LIMITS, cardContextLine: 90000 }))
    expect(realExitReadings({ CONSTRUCT_CARD: '7' }, dir, dir, path.join(dir, 'bus.db'))).toMatchObject({ contextWarn: 90000, contextWarnSource: '.claude/eddies.json cardContextLine', budgetWarned: UNKNOWN })
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

describe('pnpm miko:exit reports the end of the window', () => {
  it('a DONE exit ends the window by miko:exit, a threshold stop outside the loop by eddies, and a threshold stop under the loop, which starts the next session, ends nothing', () => {
    expect(exit({ table: () => outsideLoop, readings: () => UNREAD, status: () => 'DONE' }).ends).toEqual(['miko:exit'])
    expect(exit({ table: () => outsideLoop, readings: () => AT_CONTEXT, raised: false }).ends).toEqual(['eddies'])
    expect(exit({ readings: () => AT_CONTEXT }).ends).toEqual([])
    expect(exit({ readings: () => BELOW }).ends).toEqual([])
  })

  it('each exit reports at most one end, whatever the status and the readings', () => {
    for (const status of ['DONE', 'CONTINUE', 'OWNER']) {
      for (const readings of [UNREAD, BELOW, AT_CONTEXT, AT_SPEND]) {
        for (const table of [underLoop, outsideLoop])
          expect(exit({ table: () => table, status: () => status, readings: () => readings, raised: false }).ends.length).toBeLessThanOrEqual(1)
      }
    }
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

describe('under the pnpm miko loop miko:exit asks the loop to end the session and never calls ps or kill', () => {
  const REQUEST = '/h/miko-exit.request'
  const never = (): never => {
    throw new Error('ps or kill was called')
  }

  function underTheLoop(overrides: Partial<MikoExitDeps>): Outcome & { requests: string[] } {
    const requests: string[] = []
    const outcome = exit({ table: never, kill: never, loopRequest: REQUEST, requestEnd: request => requests.push(request), ...overrides })
    return { ...outcome, requests }
  }

  it('writes the request at a stop reason with a fresh handoff, records the exit, and kills nothing', () => {
    const outcome = underTheLoop({ readings: () => AT_CONTEXT })
    expect(outcome).toMatchObject({ code: 0, requests: [REQUEST], recorded: [expect.objectContaining({ reason: 'context' })] })
    expect(outcome.lines.join('\n')).toContain('the pnpm miko loop starts the next session')
  })

  it('writes the request with STATUS DONE and ends the window by miko:exit', () => {
    expect(underTheLoop({ status: () => 'DONE' })).toMatchObject({ code: 0, requests: [REQUEST], ends: ['miko:exit'] })
  })

  it('keeps every refusal: no stop condition, no handoff, a stale handoff', () => {
    expect(underTheLoop({})).toMatchObject({ code: 1, requests: [], recorded: [] })
    expect(underTheLoop({ readings: () => AT_CONTEXT, handoffMtime: () => undefined })).toMatchObject({ code: 1, requests: [] })
    expect(underTheLoop({ readings: () => AT_CONTEXT, now: () => FRESH_MS + 1000 })).toMatchObject({ code: 1, requests: [] })
  })
})

describe('under the loop variables there is one path whatever the process table shows', () => {
  const env = { MIKO_LOOP_PID: '10', MIKO_EXIT_REQUEST: '/h/miko-exit.request' }
  const claudeAbove = tableOf(' 10 1 node tsx scripts/window/loop.ts\n 12 10 claude\n 13 12 zsh\n 14 13 claude\n 15 14 node exit.ts\n')

  it('the request file is the loop variable whenever the loop pid is set, and absent otherwise', () => {
    expect(loopRequestOf(env)).toBe(env.MIKO_EXIT_REQUEST)
    expect(loopRequestOf({})).toBeUndefined()
    expect(loopRequestOf({ MIKO_EXIT_REQUEST: env.MIKO_EXIT_REQUEST })).toBeUndefined()
  })

  it('the request names the nearest claude above the caller, which outlives the caller, and nothing when ps fails or no claude is found', () => {
    expect(sessionClaudeOf(() => claudeAbove, 15)).toBe(14)
    expect(sessionClaudeOf(() => tableOf(' 10 1 node tsx scripts/window/loop.ts\n 15 10 node exit.ts\n'), 15)).toBeUndefined()
    expect(sessionClaudeOf(() => {
      throw Object.assign(new Error('spawnSync ps EPERM'), { code: 'EPERM' })
    }, 15)).toBeUndefined()
  })

  it('a claude above the caller does not change the request path', () => {
    const requests: string[] = []
    const outcome = exit({ pid: 15, table: () => claudeAbove, loopRequest: loopRequestOf(env), requestEnd: request => requests.push(request), readings: () => AT_CONTEXT })
    expect(outcome).toMatchObject({ code: 0, kills: [], recorded: [expect.objectContaining({ reason: 'context' })] })
    expect(requests).toEqual([env.MIKO_EXIT_REQUEST])
    expect(outcome.lines.join('\n')).toContain('the loop ends the session at the context limit')
  })
})

describe('outside the loop an EPERM from ps or kill is one refusing line, not a stack', () => {
  const eperm = (): never => {
    throw Object.assign(new Error('spawnSync ps EPERM'), { code: 'EPERM' })
  }

  it('refuses when ps fails with EPERM', () => {
    const outcome = exit({ table: eperm, readings: () => AT_CONTEXT })
    expect(outcome).toMatchObject({ code: 1, kills: [], recorded: [] })
    expect(outcome.lines).toEqual([`[miko] ${SANDBOX_REFUSAL}`])
  })

  it('refuses when kill fails with EPERM', () => {
    const outcome = exit({ kill: eperm, readings: () => AT_CONTEXT })
    expect(outcome.code).toBe(1)
    expect(outcome.lines.at(-1)).toBe(`[miko] ${SANDBOX_REFUSAL}`)
  })

  it('lets any other error through', () => {
    expect(() => exit({ table: () => {
      throw new Error('boom')
    } })).toThrow('boom')
  })
})

describe('a core version change on main is a stop reason of a session the loop started', () => {
  const NOW = 1_000_000_000
  const CORE_BELOW: ExitReadings = { ...BELOW, coreLoaded: 4, coreOnMain: 5 }

  it('a core version below main with a fresh handoff ends the session with reason core and the loop starts the next one', () => {
    expect(loopExitDecision(NOW - 1000, NOW, 'CONTINUE', CORE_BELOW)).toEqual({ kill: null, reason: 'core', line: 'the loop ends the session at a core change: main carries window-core v5, this session loaded v4: the pnpm miko loop starts the next session' })
    const requests: string[] = []
    const outcome = exit({ loopRequest: '/h/miko-exit.10.request', requestEnd: request => requests.push(request), readings: () => CORE_BELOW })
    expect(outcome).toMatchObject({ code: 0, kills: [], stops: [], ends: [], recorded: [expect.objectContaining({ reason: 'core' })] })
    expect(requests).toEqual(['/h/miko-exit.10.request'])
  })

  it.each<{ name: string, readings: ExitReadings }>([
    { name: 'equal to main', readings: { ...BELOW, coreLoaded: 5, coreOnMain: 5 } },
    { name: 'above main', readings: { ...BELOW, coreLoaded: 6, coreOnMain: 5 } },
    { name: 'not read, as in a session without the variable', readings: { ...BELOW, coreLoaded: UNKNOWN, coreOnMain: 5 } },
    { name: 'read while main is not', readings: { ...BELOW, coreLoaded: 4, coreOnMain: UNKNOWN } },
  ])('a core version equal to main or unread refuses as not at a stop condition: $name', ({ readings }) => {
    expect(loopExitDecision(NOW, NOW, 'CONTINUE', readings)).toEqual({ refuse: notAtAStopRefusal(readings) })
  })

  it('a core version equal to main is no stop, and one below it still needs a fresh handoff: a stale one refuses with the handoff:write line', () => {
    expect(loopExitDecision(NOW - FRESH_MS - 1000, NOW, 'CONTINUE', CORE_BELOW)).toEqual({ refuse: `${MIKO_HANDOFF_NAME} was written 121s ago, more than 120s: write it with pnpm handoff:write first; nothing ended` })
    expect(loopExitDecision(undefined, NOW, 'CONTINUE', CORE_BELOW)).toMatchObject({ refuse: expect.stringContaining('write it with pnpm handoff:write first') })
  })

  it('outside the loop nothing starts a session on the new core, so it ends nothing and posts no role.stopped', () => {
    const outcome = exit({ table: () => outsideLoop, readings: () => CORE_BELOW, raised: false })
    expect(outcome).toMatchObject({ code: 1, kills: [], stops: [], ends: [], recorded: [] })
    expect(outcome.lines[0]).toContain('does not run under the pnpm miko loop')
  })

  it('a threshold reached together with a core change keeps naming the threshold', () => {
    expect(stopReasonOf('CONTINUE', { ...CORE_BELOW, context: CONTEXT_WARN })).toBe('context')
    expect(stopReasonOf('DONE', CORE_BELOW)).toBe('done')
  })

  it('under the real loop a core merged during the session ends it below every threshold, and the next session loads the new core', async () => {
    const dir = scratch()
    const coreFile = path.join(dir, 'architecture', 'window-core.md')
    mkdirSync(path.dirname(coreFile))
    writeFileSync(coreFile, '# Window core\n\nwindow-core v4\n')
    transcript(dir, [usageLine('2026-10-15T00:00:00.000Z', 'r1', { input: 1 })])
    const session = path.join(dir, 'session')
    writeFileSync(session, `#!/bin/sh
echo "$${LOADED_CORE_VARIABLE}" >> "$STUB_DIR/loaded"
if [ "$(wc -l < "$STUB_DIR/loaded")" -gt 1 ]; then
  echo 'STATUS: OWNER' > "$HOME/.construct/handoff/miko.md"
  exit 0
fi
'${process.execPath}' --import '${TSX_LOADER}' "$EXIT" 2>>"$STUB_DIR/refused.err"
echo 'window-core v5' > '${coreFile}'
echo 'STATUS: CONTINUE' > "$HOME/.construct/handoff/miko.md"
'${process.execPath}' --import '${TSX_LOADER}' "$EXIT" 2>>"$STUB_DIR/exit.err"
sleep 10 >/dev/null 2>&1
echo survived >> "$STUB_DIR/survived"
`, { mode: 0o755 })

    const { code, stderr } = await run(dir, process.execPath, ['--import', TSX_LOADER, LOOP], { MIKO_CLAUDE: session, CONSTRUCT_HANDOFF: '', CONSTRUCT_HANDOFF_DIR: '' })

    expect({ code, stderr }).toMatchObject({ code: 0, stderr: expect.stringContaining('STATUS: OWNER: no next session') })
    expect(read(dir, 'refused.err')).toContain(NOT_AT_A_STOP_CONDITION)
    expect(read(dir, 'exit.err')).toContain('at a core change: main carries window-core v5, this session loaded v4')
    expect(read(dir, 'loaded').split('\n').filter(Boolean)).toEqual(['4', '5'])
    expect(read(dir, 'survived')).toBe('')
    expect(journal(dir)).toEqual([expect.objectContaining({ reason: 'core' })])
  }, 30_000)
})

describe('in a tab window a threshold continues the session instead of ending it', () => {
  it('a loop-mode session keeps the pnpm miko:exit path at the threshold', () => {
    for (const readings of [AT_CONTEXT, AT_SPEND_WARN])
      expect(exit({ tab: false, readings: () => readings })).toMatchObject({ code: 0, kills: [12], recorded: [expect.objectContaining({ reason: stopReasonOf('CONTINUE', readings) })] })
    const requests: string[] = []
    expect(exit({ tab: false, loopRequest: '/h/miko-exit.10.request', requestEnd: request => requests.push(request), readings: () => AT_SPEND_WARN })).toMatchObject({ code: 0, kills: [] })
    expect(requests).toEqual(['/h/miko-exit.10.request'])
  })

  it('a tab session at the context or the spend warn with a fresh handoff ends nothing, records no exit and names the compaction route', () => {
    for (const readings of [AT_CONTEXT, AT_SPEND_WARN, AT_SPEND]) {
      const outcome = exit({ tab: true, table: () => outsideLoop, readings: () => readings })
      expect(outcome).toMatchObject({ code: 1, kills: [], stops: [], ends: [], recorded: [] })
      expect(outcome.lines).toEqual([`[miko] ${TAB_THRESHOLD}`])
    }
  })

  it('a tab session at a threshold with a stale handoff is told to write it first', () => {
    const outcome = exit({ tab: true, table: () => outsideLoop, handoffMtime: () => 0, now: () => FRESH_MS + 1000, readings: () => AT_CONTEXT })
    expect(outcome).toMatchObject({ code: 1, kills: [] })
    expect(outcome.lines[0]).toContain('write it with pnpm handoff:write first')
  })

  it('a tab session with STATUS DONE still ends, and below every threshold is still refused', () => {
    expect(exit({ tab: true, table: () => outsideLoop, readings: () => UNREAD, status: () => 'DONE' })).toMatchObject({ code: 0, kills: [12] })
    expect(exit({ tab: true, table: () => outsideLoop, readings: () => BELOW }).lines).toEqual([`[miko] ${notAtAStopRefusal(BELOW)}`])
  })
})
