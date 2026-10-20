import type { PauseEnd, SessionEnd } from '../../miko/loop.js'
import type { Status } from '../../shift/relaunch.js'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { openBus } from '../../bus/db.js'
import { FAILURES_TO_STOP } from '../../bus/queue.js'
import { reduce } from '../../bus/reducer.js'
import { failRaise, leaseRole, observeRoleStop, ROLE_RETURNED, roleToOwner } from '../../bus/role.js'
import { HANDOFF_FIELDS } from '../../ghosts/handoff-check.js'
import { claudeCommand, CONTINUE_PROMPT, DEFAULT_CLAUDE, DOUBLE_CTRL_C_WINDOW_MS, doubleCtrlCWatcher, EXIT_REQUEST_NAME, exitRequestFile, HANGUPS, MIKO_HANDOFF_NAME, mikoHandoff, once, PAUSE_MS, pauseUntilCtrlC, runMikoLoop, runSession, sessionAndPauseSharingCtrlCs, sessionCtrlCsStillInFlight, takeExitRequest } from '../../miko/loop.js'
import { waitFor } from '../wait-for.js'

const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..')
const LOOP = path.join(REPO_ROOT, 'scripts', 'miko', 'loop.ts')
const KEY_PRESS_GAP_MS = 300
const READY_DEADLINE_MS = 15_000
const PAUSE_LINE = 'next session in'
const SESSION = 'session-972'
const LIMITS = { contextLimit: 250000, sessionSpend: 3000000, agentSpend: 2000000, runSpend: 3000000, warnRatio: 0.8 }
const WINDOW_DOC = path.join(REPO_ROOT, 'architecture', 'window.md')
const STUB_CLAUDE = `#!/bin/sh
n=$(( $(cat "$STUB_DIR/count" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$STUB_DIR/count"
printf '%s|%s\\n' "$#" "$*" >> "$STUB_DIR/calls"
ps -o pgid= -p $$ | tr -d ' ' >> "$STUB_DIR/groups"
set -- $(sed -n "\${n}p" "$STUB_DIR/plan")
case "$1" in
  continue|owner|stop) echo "STATUS: $(echo "$1" | tr a-z A-Z)" > "$HOME/.construct/handoff/miko.md"; exit "$2" ;;
  quiet) exit "$2" ;;
  deaf) trap '' INT; echo 'STATUS: CONTINUE' > "$HOME/.construct/handoff/miko.md"; : > "$STUB_DIR/ready"; exec sleep 2 ;;
  hang) echo 'STATUS: CONTINUE' > "$HOME/.construct/handoff/miko.md"; : > "$STUB_DIR/ready"; exec sleep 30 ;;
  threshold)
    node --disable-warning=ExperimentalWarning --import tsx scripts/shift/handoff-write.ts "$HOME/.construct/handoff/miko.md" "$STUB_DIR/draft.md" --parking "$STUB_DIR/parking" >> "$STUB_DIR/threshold.log" 2>&1
    node --disable-warning=ExperimentalWarning --import tsx scripts/miko/exit.ts >> "$STUB_DIR/threshold.log" 2>&1
    exec sleep 30 ;;
  write)
    node --disable-warning=ExperimentalWarning --import tsx scripts/shift/handoff-write.ts "$HOME/.construct/handoff/miko.md" "$STUB_DIR/draft.md" --parking "$STUB_DIR/parking" >> "$STUB_DIR/threshold.log" 2>&1
    : > "$STUB_DIR/survived"
    exit 0 ;;
  done)
    echo 'STATUS: DONE' > "$HOME/.construct/handoff/miko.md"
    touch -t 200001010000 "$HOME/.construct/handoff/miko.md"
    node --disable-warning=ExperimentalWarning --import tsx scripts/miko/exit.ts >> "$STUB_DIR/threshold.log" 2>&1
    exec sleep 30 ;;
esac
exit 0
`

const roots: string[] = []
const loopGroups: number[] = []

afterEach(() => {
  for (const group of loopGroups.splice(0)) {
    try {
      process.kill(-group, 'SIGKILL')
    }
    catch {}
  }
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function home(plan: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'miko-loop-'))
  roots.push(dir)
  mkdirSync(path.join(dir, '.construct', 'handoff'), { recursive: true })
  writeFileSync(path.join(dir, 'claude'), STUB_CLAUDE, { mode: 0o755 })
  writeFileSync(path.join(dir, 'plan'), `${plan.join('\n')}\n`)
  mkdirSync(path.join(dir, '.claude'), { recursive: true })
  writeFileSync(path.join(dir, '.claude', 'eddies.json'), JSON.stringify(LIMITS))
  return dir
}

function atTheContextWarn(dir: string): void {
  const transcript = path.join(dir, '.claude', 'projects', '-repo', `${SESSION}.jsonl`)
  mkdirSync(path.dirname(transcript), { recursive: true })
  writeFileSync(transcript, `${JSON.stringify({ type: 'assistant', timestamp: '2026-10-15T00:00:00.000Z', requestId: 'r1', message: { role: 'assistant', usage: { input_tokens: LIMITS.contextLimit * LIMITS.warnRatio } } })}\n`)
}

function exitLines(dir: string): { reason: string }[] {
  return lines(dir, path.join('.construct', 'eddies.jsonl')).map(line => JSON.parse(line) as { reason: string })
}

function lines(dir: string, name: string): string[] {
  return existsSync(path.join(dir, name)) ? readFileSync(path.join(dir, name), 'utf8').split('\n').filter(Boolean) : []
}

function startLoop(dir: string, claude = path.join(dir, 'claude')): { done: Promise<{ code: number | null, stderr: string }>, pid: number, stderr: NodeJS.ReadableStream } {
  const child = spawn(process.execPath, ['--import', 'tsx', LOOP], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: dir, CONSTRUCT_BUS_DB: path.join(dir, '.construct', 'bus.db'), STUB_DIR: dir, MIKO_CLAUDE: claude, CONSTRUCT_CARD: '', CONSTRUCT_HANDOFF: '', CONSTRUCT_HANDOFF_DIR: '', CLAUDE_CODE_SESSION_ID: SESSION, CLAUDE_PROJECT_DIR: dir },
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: true,
  })
  loopGroups.push(child.pid!)
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })
  const done = new Promise<{ code: number | null, stderr: string }>(resolve => child.on('close', code => resolve({ code, stderr })))
  return { done, pid: child.pid!, stderr: child.stderr }
}

function startPnpmMiko(dir: string): { exited: Promise<number | null>, done: Promise<string>, pid: number, stderr: () => string } {
  const child = spawn('pnpm', ['--silent', 'miko'], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: dir, STUB_DIR: dir, MIKO_CLAUDE: path.join(dir, 'claude') },
    stdio: ['ignore', 'ignore', 'pipe'],
    detached: true,
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })
  const exited = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)))
  const done = new Promise<string>(resolve => child.stderr.on('close', () => resolve(stderr)))
  return { exited, done, pid: child.pid!, stderr: () => stderr }
}

async function sessionReady(dir: string): Promise<void> {
  await waitFor(() => existsSync(path.join(dir, 'ready')), () => 'the stub session to write its ready file', READY_DEADLINE_MS)
}

async function pauseLine(stderr: () => string, deadlineMs = READY_DEADLINE_MS): Promise<void> {
  await waitFor(() => stderr().includes(PAUSE_LINE), () => `"${PAUSE_LINE}" on stderr (stderr so far: ${JSON.stringify(stderr())})`, deadlineMs)
}

function writeMikoDraft(dir: string, status: Status): void {
  mkdirSync(path.join(dir, 'parking'))
  const values: Record<string, string> = { ...Object.fromEntries(HANDOFF_FIELDS.filter(field => field.id !== 'stop-reason').map(field => [field.label, field.id === 'decisions' ? LOOP : `${field.id} value`])), 'queue': 'none', 'in-flight': 'none', 'owner waits': 'none', 'next task': '#1 implement' }
  const fields = Object.entries(values).map(([label, value]) => `${label}: ${value}`)
  writeFileSync(path.join(dir, 'draft.md'), `# Handoff\n\nrole: window\nsession: 1\n${fields.join('\n')}\n\nSTATUS: ${status}\n`)
}

describe('pnpm miko restarts Miko in its own terminal while miko.md says STATUS: CONTINUE', () => {
  it('a session that exits with STATUS: CONTINUE starts the next session in the same terminal after a pause', async () => {
    const dir = home(['continue 3', 'owner 0'])
    const started = Date.now()
    const loop = startLoop(dir)
    const { code, stderr } = await loop.done
    expect(code).toBe(0)
    expect(Date.now() - started).toBeGreaterThanOrEqual(PAUSE_MS)
    expect(lines(dir, 'calls')).toEqual(['0|', `1|${CONTINUE_PROMPT}`])
    expect(lines(dir, 'groups')).toEqual([String(loop.pid), String(loop.pid)])
    expect(stderr).toContain('STATUS: CONTINUE: next session')
  }, 20_000)

  it.each(['owner', 'stop'])('the loop starts no next session after one that ended itself with STATUS: OWNER or STOP, though the prompt no longer ends a session at OWNER, here %s', async (status) => {
    const dir = home([`${status} 0`, 'continue 0'])
    writeFileSync(mikoHandoff(dir), 'STATUS: CONTINUE\n')
    const { code, stderr } = await startLoop(dir).done
    expect(code).toBe(0)
    expect(lines(dir, 'calls')).toEqual([`1|${CONTINUE_PROMPT}`])
    expect(stderr).toContain(`STATUS: ${status.toUpperCase()}: no next session`)
  }, 20_000)

  it('a Ctrl-C that ends the session leaves the loop in its pause, and a Ctrl+C in the pause ends the loop', async () => {
    const dir = home(['hang', 'owner 0'])
    const loop = startLoop(dir)
    let stderr = ''
    loop.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    await sessionReady(dir)
    process.kill(-loop.pid, 'SIGINT')
    await pauseLine(() => stderr)
    process.kill(-loop.pid, 'SIGINT')
    const { code } = await loop.done
    expect({ code, calls: lines(dir, 'calls'), stderr }).toMatchObject({ code: 0, calls: ['0|'], stderr: expect.stringContaining('Ctrl+C in the pause: no next session') })
  }, 20_000)

  it('a readiness line that never comes fails the wait instead of passing it silently', async () => {
    const dir = home(['hang', 'owner 0'])
    const loop = startLoop(dir)
    let stderr = ''
    loop.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    try {
      await sessionReady(dir)
      await expect(pauseLine(() => stderr, PAUSE_MS)).rejects.toThrow(`"${PAUSE_LINE}" on stderr`)
    }
    finally {
      process.kill(-loop.pid, 'SIGKILL')
    }
  }, 20_000)

  it('a Ctrl-C that ends the session leaves the loop running, and STATUS: CONTINUE starts the next one', async () => {
    const dir = home(['hang', 'owner 0'])
    const loop = startLoop(dir)
    await sessionReady(dir)
    process.kill(-loop.pid, 'SIGINT')
    const { code, stderr } = await loop.done
    expect({ code, calls: lines(dir, 'calls'), stderr }).toMatchObject({ code: 0, calls: ['0|', `1|${CONTINUE_PROMPT}`], stderr: expect.stringContaining('STATUS: OWNER: no next session') })
  }, 20_000)

  it('a double Ctrl-C ends the loop', async () => {
    const dir = home(['deaf', 'owner 0'])
    const loop = startLoop(dir)
    await sessionReady(dir)
    process.kill(-loop.pid, 'SIGINT')
    await new Promise(resolve => setTimeout(resolve, KEY_PRESS_GAP_MS))
    process.kill(-loop.pid, 'SIGINT')
    const outcome = await loop.done
    expect(lines(dir, 'calls')).toEqual(['0|'])
    expect(outcome).toMatchObject({ code: 0, stderr: expect.stringContaining('double Ctrl+C during the session: no next session') })
  }, 20_000)

  it('under pnpm miko, one Ctrl+C in the pause ends pnpm and the loop together, so no session starts orphaned from the terminal', async () => {
    const dir = home(['continue 0', 'owner 0'])
    const miko = startPnpmMiko(dir)
    try {
      await pauseLine(miko.stderr)
      await new Promise(resolve => setTimeout(resolve, KEY_PRESS_GAP_MS))
      process.kill(-miko.pid, 'SIGINT')
      await miko.exited
      const stderr = await miko.done
      expect(lines(dir, 'calls')).toEqual(['0|'])
      expect(stderr).toContain('Ctrl+C in the pause: no next session')
    }
    finally {
      try {
        process.kill(-miko.pid, 'SIGKILL')
      }
      catch {}
    }
  }, 30_000)

  it('own handoff: at the context threshold the window writes miko.md with handoff:write, miko:exit ends it, the loop raises the next session on miko.md, and the Operator mikoshi.md is untouched', async () => {
    const dir = home(['threshold', 'owner 0'])
    atTheContextWarn(dir)
    mkdirSync(path.join(dir, 'parking'))
    const values: Record<string, string> = { ...Object.fromEntries(HANDOFF_FIELDS.filter(field => field.id !== 'stop-reason').map(field => [field.label, field.id === 'decisions' ? LOOP : `${field.id} value`])), 'queue': 'none', 'in-flight': 'none', 'owner waits': 'none', 'next task': '#1 implement' }
    const fields = Object.entries(values).map(([label, value]) => `${label}: ${value}`)
    writeFileSync(path.join(dir, 'draft.md'), `# Handoff\n\nrole: window\nsession: 1\n${fields.join('\n')}\n\nSTATUS: CONTINUE\n`)
    const operator = path.join(dir, '.construct', 'handoff', 'mikoshi.md')
    writeFileSync(operator, '## STOP — Operator\nSTATUS: CONTINUE\n')
    const hourAgo = new Date(Date.now() - 3_600_000)
    utimesSync(operator, hourAgo, hourAgo)
    const settled = statSync(operator).mtimeMs
    await startLoop(dir).done
    expect(lines(dir, 'threshold.log')).toEqual([expect.stringContaining(`${mikoHandoff(dir)}: `), expect.stringContaining('the pnpm miko loop starts the next session')])
    expect(lines(dir, 'calls')).toEqual(['0|', `1|${CONTINUE_PROMPT}`])
    expect(CONTINUE_PROMPT).toContain(MIKO_HANDOFF_NAME)
    expect(readFileSync(operator, 'utf8')).toBe('## STOP — Operator\nSTATUS: CONTINUE\n')
    expect(statSync(operator).mtimeMs).toBe(settled)
  }, 40_000)

  it('handoff:write with STATUS: CONTINUE does not kill the session', async () => {
    const dir = home(['write'])
    atTheContextWarn(dir)
    writeMikoDraft(dir, 'CONTINUE')
    const { stderr } = await startLoop(dir).done
    expect(existsSync(path.join(dir, 'survived'))).toBe(true)
    expect(lines(dir, 'threshold.log')).toEqual([expect.stringContaining(`${mikoHandoff(dir)}: `)])
    expect(readFileSync(mikoHandoff(dir), 'utf8')).toContain('STATUS: CONTINUE')
    expect(lines(dir, 'calls')).toEqual(['0|', `1|${CONTINUE_PROMPT}`])
    expect(stderr).toContain('without rewriting miko.md')
    expect(exitLines(dir)).toEqual([])
  }, 40_000)

  it('a handoff with STATUS DONE kills the session and the loop raises no new one', async () => {
    const dir = home(['done', 'owner 0'])
    const outcome = await startLoop(dir).done
    expect(outcome).toMatchObject({ code: 0, stderr: expect.stringContaining('STATUS: DONE: no next session') })
    expect(lines(dir, 'calls')).toEqual(['0|'])
    expect(exitLines(dir)).toEqual([expect.objectContaining({ reason: 'done' })])
  }, 20_000)

  it('the CONTINUE_PROMPT and window.md name no exit after a handoff outside the three stop reasons', () => {
    const mikoshi = readFileSync(WINDOW_DOC, 'utf8').split('\n\n').find(paragraph => paragraph.startsWith('Mikoshi, the interactive window'))
    expect(mikoshi).toContain('not at a stop condition: wait with pnpm miko:watch --once --card <N> or take the next card')
    expect(mikoshi).toContain('without `pnpm miko:exit`')
    expect(mikoshi).not.toContain('the two commands the warn names')
    expect(CONTINUE_PROMPT).toContain('событие жди через pnpm miko:watch --once в этой же сессии')
    expect(CONTINUE_PROMPT).toContain('следующую карточку бери в этой же сессии')
    expect(CONTINUE_PROMPT).toContain('без pnpm miko:exit')
  })

  it('on STATUS: OWNER the CONTINUE_PROMPT asks the owner in the window and waits in the same session', () => {
    expect(CONTINUE_PROMPT).toContain('прочитай ~/.construct/handoff/miko.md;')
    expect(CONTINUE_PROMPT).toContain('если OWNER — задай вопрос владельцу в окне и жди ответа в этой же сессии')
    expect(CONTINUE_PROMPT).toContain('после ответа pnpm handoff:write со STATUS: CONTINUE, без pnpm miko:exit')
    expect(CONTINUE_PROMPT).not.toContain('STATUS: OWNER либо DONE')
    expect(CONTINUE_PROMPT).toMatch(/pnpm miko:exit — только при .* или STATUS: DONE$/)
    expect(CONTINUE_PROMPT).toContain('pnpm miko:exit — только при контексте или тратах сессии не ниже порога предупреждения Eddies')
  })

  it('the loop starts claude in dontAsk mode unless MIKO_CLAUDE overrides it', () => {
    expect(DEFAULT_CLAUDE).toBe('claude --permission-mode dontAsk')
    expect(claudeCommand({})).toBe('claude --permission-mode dontAsk')
    expect(claudeCommand({ MIKO_CLAUDE: '/opt/other-claude' })).toBe('/opt/other-claude')
  })

  it('handoff:write with STATUS: STOP under the pnpm miko loop does not end claude', async () => {
    const dir = home(['write'])
    writeMikoDraft(dir, 'STOP')
    const { stderr } = await startLoop(dir).done
    expect(existsSync(path.join(dir, 'survived'))).toBe(true)
    expect(stderr).toContain('STATUS: STOP: no next session')
    expect(lines(dir, 'threshold.log')).toEqual([expect.stringContaining(`${mikoHandoff(dir)}: `)])
    expect(readFileSync(mikoHandoff(dir), 'utf8')).toContain('STATUS: STOP')
    expect(lines(dir, 'calls')).toEqual(['0|'])
  }, 40_000)

  it('stops with exit code 1 when MIKO_CLAUDE names a missing command, though miko.md says STATUS: CONTINUE', async () => {
    const dir = home([])
    writeFileSync(mikoHandoff(dir), 'STATUS: CONTINUE\n')
    const outcome = await startLoop(dir, path.join(dir, 'no-such-claude')).done
    expect(outcome).toMatchObject({ code: 1, stderr: expect.stringContaining('the session did not start') })
  }, 20_000)

  it('a session that exits without rewriting miko.md ends the loop, though the previous STATUS: CONTINUE is still there', async () => {
    const dir = home(['quiet 0', 'quiet 0'])
    writeFileSync(mikoHandoff(dir), 'STATUS: CONTINUE\n')
    const outcome = await startLoop(dir).done
    expect(lines(dir, 'calls')).toEqual([`1|${CONTINUE_PROMPT}`])
    expect(outcome).toMatchObject({ code: 0, stderr: expect.stringContaining('without rewriting miko.md') })
  }, 20_000)
})

interface Script {
  statuses: (Status | null | undefined)[]
  pauseEnds?: PauseEnd[]
  doubleCtrlCs?: boolean[]
}

async function drive({ statuses, pauseEnds = [], doubleCtrlCs = [] }: Script): Promise<{ code: number, prompts: (string | undefined)[], pauses: number[], lines: string[], ends: number }> {
  const prompts: (string | undefined)[] = []
  const pauses: number[] = []
  const lines: string[] = []
  let ends = 0
  const code = await runMikoLoop({
    status: () => statuses.shift(),
    handoffMtime: () => prompts.length,
    session: async (prompt) => {
      prompts.push(prompt)
      return { code: 0, signal: null }
    },
    pause: async (ms) => {
      pauses.push(ms)
      return pauseEnds.shift() ?? 'elapsed'
    },
    doubleCtrlC: () => doubleCtrlCs.shift() ?? false,
    err: line => lines.push(line),
    ended: () => {
      ends += 1
    },
  })
  return { code, prompts, pauses, lines, ends }
}

describe('runMikoLoop decides from STATUS in miko.md and a Ctrl+C in the pause', () => {
  it.each([
    { name: 'absent', statuses: [undefined, 'CONTINUE', 'CONTINUE', 'OWNER'] as const, prompts: [undefined, CONTINUE_PROMPT, CONTINUE_PROMPT] },
    { name: 'present', statuses: ['OWNER', 'CONTINUE', 'DONE'] as const, prompts: [CONTINUE_PROMPT, CONTINUE_PROMPT] },
  ])('with miko.md $name at the start, pauses and restarts on each CONTINUE and stops on the first other STATUS', async ({ statuses, prompts }) => {
    const run = await drive({ statuses: [...statuses] })
    expect(run.code).toBe(0)
    expect(run.prompts).toEqual(prompts)
    expect(run.pauses).toEqual(Array.from({ length: prompts.length - 1 }).fill(PAUSE_MS))
  })

  it('continues a STATUS: CONTINUE handoff without asking the owner', () => {
    expect(CONTINUE_PROMPT).toContain(`прочитай ~/.construct/handoff/${MIKO_HANDOFF_NAME}`)
    expect(CONTINUE_PROMPT).toContain('последняя строка STATUS: в нём — CONTINUE')
    expect(CONTINUE_PROMPT).toContain('не спрашивая владельца')
  })

  it('reports the end of the window once, after its last session and never between sessions', async () => {
    const continued = await drive({ statuses: [undefined, 'CONTINUE', 'CONTINUE', 'DONE'] })
    expect({ prompts: continued.prompts.length, ends: continued.ends }).toEqual({ prompts: 3, ends: 1 })
    expect((await drive({ statuses: [undefined, 'CONTINUE', 'CONTINUE'], pauseEnds: ['ctrl-c'] })).ends).toBe(1)
  })

  it('stops when miko.md carries no STATUS line', async () => {
    const run = await drive({ statuses: [undefined, null] })
    expect(run.prompts).toEqual([undefined])
    expect(run.lines.join('\n')).toContain('STATUS: none')
  })

  it('stops on a Ctrl+C in the pause, though STATUS says CONTINUE', async () => {
    const run = await drive({ statuses: [undefined, 'CONTINUE', 'CONTINUE'], pauseEnds: ['elapsed', 'ctrl-c'] })
    expect(run.code).toBe(0)
    expect(run.prompts).toEqual([undefined, CONTINUE_PROMPT])
    expect(run.pauses).toEqual([PAUSE_MS, PAUSE_MS])
    expect(run.lines.at(-2)).toContain('Ctrl+C now stops the loop')
    expect(run.lines.at(-1)).toContain('Ctrl+C in the pause: no next session')
  })

  it('stops after a session in which a double Ctrl-C was seen, though STATUS says CONTINUE', async () => {
    const run = await drive({ statuses: [undefined, 'CONTINUE', 'CONTINUE'], doubleCtrlCs: [false, true] })
    expect(run.code).toBe(0)
    expect(run.prompts).toEqual([undefined, CONTINUE_PROMPT])
    expect(run.pauses).toEqual([PAUSE_MS])
    expect(run.lines.at(-1)).toContain('double Ctrl+C during the session: no next session')
  })

  it('stops with exit code 1 when the session could not start, so a missing claude does not spin', async () => {
    const statuses: (Status | undefined)[] = ['CONTINUE', 'CONTINUE']
    const code = await runMikoLoop({
      status: () => statuses.shift(),
      handoffMtime: () => 0,
      session: async () => ({ code: null, signal: null }),
      pause: async () => 'elapsed',
      doubleCtrlC: () => false,
      err: () => {},
      ended: () => {},
    })
    expect(code).toBe(1)
  })
})

const SHORT_PAUSE_MS = 200

describe('the Ctrl-C that ended the session is not read as a Ctrl+C in the pause, whichever the loop dispatches first', () => {
  it.each([
    { end: { code: null, signal: 'SIGINT' }, seen: 0, inFlight: 1 },
    { end: { code: null, signal: 'SIGINT' }, seen: 1, inFlight: 0 },
    { end: { code: 0, signal: null }, seen: 0, inFlight: 0 },
    { end: { code: null, signal: 'SIGTERM' }, seen: 0, inFlight: 0 },
  ] satisfies { end: SessionEnd, seen: number, inFlight: number }[])('a session ended by $end.signal with $seen Ctrl-C seen leaves $inFlight in flight', ({ end, seen, inFlight }) => {
    expect(sessionCtrlCsStillInFlight(end, seen)).toBe(inFlight)
  })

  it.each([
    { sessionCtrlCs: 0, sigints: 1, end: 'ctrl-c' },
    { sessionCtrlCs: 1, sigints: 1, end: 'elapsed' },
    { sessionCtrlCs: 1, sigints: 2, end: 'ctrl-c' },
  ])('a pause owing $sessionCtrlCs session Ctrl-C ends $end after $sigints SIGINT', async ({ sessionCtrlCs, sigints, end }) => {
    const listeners = process.listenerCount('SIGINT')
    const pause = pauseUntilCtrlC(SHORT_PAUSE_MS, sessionCtrlCs)
    for (let n = 0; n < sigints; n++)
      process.emit('SIGINT', 'SIGINT')
    expect(await pause).toBe(end)
    expect(process.listenerCount('SIGINT')).toBe(listeners)
  })

  it.each([
    { pressesInSession: 0, end: 'elapsed' },
    { pressesInSession: 1, end: 'ctrl-c' },
  ])('after a session the SIGINT closed with $pressesInSession press seen, one SIGINT in the pause ends it $end', async ({ pressesInSession, end }) => {
    const ctrlC = doubleCtrlCWatcher(() => 0)
    ctrlC.press()
    const { session, pause } = sessionAndPauseSharingCtrlCs(ctrlC, async () => {
      for (let n = 0; n < pressesInSession; n++)
        ctrlC.press()
      return { code: null, signal: 'SIGINT' }
    })
    await session(undefined)
    const paused = pause(SHORT_PAUSE_MS)
    process.emit('SIGINT', 'SIGINT')
    expect(await paused).toBe(end)
  })
})

describe('doubleCtrlCWatcher sees two Ctrl-C within DOUBLE_CTRL_C_WINDOW_MS as a double Ctrl-C', () => {
  it.each([
    { name: 'one press', presses: [0], seen: false },
    { name: 'two presses within the window', presses: [0, DOUBLE_CTRL_C_WINDOW_MS], seen: true },
    { name: 'two presses further apart than the window', presses: [0, DOUBLE_CTRL_C_WINDOW_MS + 1], seen: false },
    { name: 'a close pair after a lone press', presses: [0, 5000, 5300], seen: true },
  ])('$name', ({ presses, seen }) => {
    const times = [...presses]
    const watcher = doubleCtrlCWatcher(() => times.shift()!)
    presses.forEach(() => watcher.press())
    expect({ seen: watcher.seen(), presses: watcher.presses() }).toEqual({ seen, presses: presses.length })
  })
})

function roleWithTheOwner(file: string): void {
  const db = openBus(file)
  const at = (ms: number): string => new Date(Date.parse('2026-10-20T10:00:00.000Z') + ms).toISOString()
  observeRoleStop(db, at(0), 'worker:miko:7', { role: 'miko', handoff: '/handoff/miko.md', status: 'CONTINUE', reason: 'context', raised: false })
  reduce(db)
  for (let failure = 1; failure <= FAILURES_TO_STOP; failure += 1)
    failRaise(db, at(failure), leaseRole(db, at(failure), 'worker:restart:w')!, 'relaunch did not start')
  roleToOwner(db, at(10), 'worker:restart:w')
  db.close()
}

function returnedEnds(file: string): { ended: string, state: string } {
  const db = openBus(file)
  try {
    const events = db.prepare('SELECT payload FROM events WHERE type = ?').all(ROLE_RETURNED) as { payload: string }[]
    const state = (db.prepare('SELECT state FROM roles WHERE role = ?').get('miko') as { state: string }).state
    return { ended: events.map(row => (JSON.parse(row.payload) as { ended: string }).ended).join(','), state }
  }
  finally {
    db.close()
  }
}

describe('the end of the window the loop runs returns the role', () => {
  it('reports the end once, however many times it is called', () => {
    let ends = 0
    const ended = once(() => {
      ends += 1
    })
    ended()
    ended()
    expect(ends).toBe(1)
    expect(HANGUPS).toEqual(['SIGHUP', 'SIGTERM'])
  })

  it.each(['SIGHUP', 'SIGTERM'] as const)('a window closed under the loop (%s) returns the role as an event before the loop exits', async (signal) => {
    const dir = home(['hang'])
    const bus = path.join(dir, '.construct', 'bus.db')
    roleWithTheOwner(bus)
    const loop = startLoop(dir)
    await sessionReady(dir)
    process.kill(-loop.pid, signal)
    const { code } = await loop.done
    expect(code).toBe(128 + (signal === 'SIGHUP' ? 1 : 15))
    expect(returnedEnds(bus)).toEqual({ ended: 'close', state: 'stopped' })
  }, 20_000)

  it('a loop that returns after its last session returns the role once', async () => {
    const dir = home(['owner 0'])
    const bus = path.join(dir, '.construct', 'bus.db')
    roleWithTheOwner(bus)
    const { code } = await startLoop(dir).done
    expect(code).toBe(0)
    expect(returnedEnds(bus)).toEqual({ ended: 'close', state: 'stopped' })
  }, 20_000)
})

describe('the loop owns the end of a session: a request file asks it to end the claude it started', () => {
  const POLL_MS = 20

  function request(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'miko-request-'))
    roots.push(dir)
    return path.join(dir, EXIT_REQUEST_NAME)
  }

  it('names the request next to miko.md', () => {
    expect(exitRequestFile('/h')).toBe(path.join(path.dirname(mikoHandoff('/h')), EXIT_REQUEST_NAME))
  })

  it('takes a request once and removes it', () => {
    const file = request()
    expect(takeExitRequest(file)).toBe(false)
    writeFileSync(file, '1\n')
    expect(takeExitRequest(file)).toBe(true)
    expect(existsSync(file)).toBe(false)
    expect(takeExitRequest(file)).toBe(false)
  })

  it('ends the session with SIGTERM when a request appears, and removes the request', async () => {
    const file = request()
    const ending = runSession('sleep 30', undefined, file, POLL_MS)
    setTimeout(writeFileSync, 100, file, '1\n')
    expect(await ending).toEqual({ code: null, signal: 'SIGTERM' })
    expect(existsSync(file)).toBe(false)
  }, 10_000)

  it('does not obey a request left from before the session started', async () => {
    const file = request()
    writeFileSync(file, 'stale\n')
    expect(await runSession('sleep 0.3', undefined, file, POLL_MS)).toEqual({ code: 0, signal: null })
    expect(existsSync(file)).toBe(false)
  }, 10_000)

  it('runs the session as the loop\'s own child, so the SIGTERM of a request reaches the session and not only its shell', async () => {
    const file = request()
    const seen = `${file}.parent`
    const session = `${file}.session.sh`
    writeFileSync(session, `#!/bin/sh\necho "$PPID" > '${seen}'\nexec sleep 30\n`, { mode: 0o755 })
    const ending = runSession(session, undefined, file, POLL_MS)
    await waitFor(() => existsSync(seen) && readFileSync(seen, 'utf8').trim() !== '', () => 'the session to name its parent', 5_000)
    writeFileSync(file, '1\n')
    expect(await ending).toEqual({ code: null, signal: 'SIGTERM' })
    expect(readFileSync(seen, 'utf8').trim()).toBe(String(process.pid))
  }, 10_000)

  it('names the loop and the request to the session through its environment', async () => {
    const file = request()
    const seen = `${file}.seen`
    expect(await runSession(`sh -c 'echo "$MIKO_LOOP_PID $MIKO_EXIT_REQUEST" > ${seen}'`, undefined, file, POLL_MS)).toEqual({ code: 0, signal: null })
    expect(readFileSync(seen, 'utf8').trim()).toBe(`${process.pid} ${file}`)
  }, 10_000)
})
