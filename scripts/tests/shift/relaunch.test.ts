import type { RoleStop } from '../../bus/role.js'
import type { ClaudeRun } from '../../shift/claude.js'
import type { RelaunchDeps } from '../../shift/relaunch.js'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../bus/db.js'
import { DECISION_FORMAT } from '../../decisions/decisions.js'
import { HANDOFF_FIELDS } from '../../ghosts/handoff-check.js'
import { CONTINUE_PROMPT, MAX_RESTARTS } from '../../shift/continuation.js'
import { boundaryLine, OPERATOR_CONTEXT_THRESHOLD } from '../../shift/operator-boundary.js'
import { operatorWork } from '../../shift/role-bus.js'
import { ALREADY_RUNNING, BOUNDARY_EVENT, boundaryCommand, CHAIN_COMMAND, createExclusive, endedAtThreshold, expandHome, LAUNCH_LINE, liveSessions, lockPath, NO_MODEL, OPERATOR_ROLE, projectDirOf, promptFirstLine, relaunchPrompt, runRelaunch, statusOf, WINDOW_BODY_NOTE } from '../../shift/relaunch.js'
import { MAIN_1 } from '../bus/github-fake.js'

const DECISIONS = fileURLToPath(import.meta.url)
const FIELDS = `## STOP — window 1\nprev: none\nin-flight: none\n${HANDOFF_FIELDS.map(field => `${field.label}: ${field.label === 'queue' ? 'none' : field.id === 'decisions' ? DECISIONS : 'x'}`).join('\n')}`
const roots: string[] = []
const RELAUNCH_PID = 5151

interface World {
  root: string
  handoff: string
  journal: string
  projects: string
  repo: string
}

function newWorld(status: string | null = 'CONTINUE', fields = FIELDS): World {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'relaunch-world-')))
  roots.push(root)
  const repo = path.join(root, 'repo')
  mkdirSync(repo)
  const handoff = path.join(root, 'handoff.md')
  writeFileSync(handoff, `${fields}\n${status === null ? '' : `STATUS: ${status}\n`}`)
  return { root, handoff, journal: path.join(root, 'handoff-dir', 'ghosts.jsonl'), projects: path.join(root, 'projects'), repo }
}

function setStatus(world: World, status: string): void {
  writeFileSync(world.handoff, `${readFileSync(world.handoff, 'utf8')}STATUS: ${status}\n`)
}

function writeTranscript(world: World, name: string, lines: object[], mtime: number): void {
  const dir = projectDirOf(world.projects, world.repo)
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, name)
  writeFileSync(file, lines.map(line => JSON.stringify(line)).join('\n'))
  utimesSync(file, mtime, mtime)
}

interface Seen {
  runs: ClaudeRun[]
  out: string[]
  err: string[]
  stops: RoleStop[]
}

function relaunchDeps(world: World, statuses: string[], seen: Seen): RelaunchDeps {
  let uuids = 0
  let ticks = 0
  return {
    cwd: world.repo,
    home: world.root,
    pid: RELAUNCH_PID,
    claude: 'true',
    journal: world.journal,
    projectsDir: world.projects,
    read: file => readFileSync(file, 'utf8'),
    write: (file, text) => writeFileSync(file, text),
    create: createExclusive,
    remove: file => rmSync(file, { force: true }),
    exists: existsSync,
    parked: () => new Map(),
    listDir: dir => existsSync(dir) ? readdirSync(dir) : [],
    modified: file => statSync(file).mtimeMs,
    now: () => new Date(Date.parse('2026-10-07T01:00:00.000Z') + 1000 * ticks++),
    uuid: () => `00000000-0000-4000-8000-00000000000${++uuids}`,
    run: async (run) => {
      seen.runs.push(run)
      setStatus(world, statuses[seen.runs.length - 1] ?? 'CONTINUE')
      return { kind: 'exited', code: 0, signal: null }
    },
    alive: () => false,
    out: line => seen.out.push(line),
    err: line => seen.err.push(line),
    observeStop: stop => seen.stops.push(stop),
    work: { cursor: () => 0, wait: async () => {} },
  }
}

function journalLines(world: World): Array<Record<string, unknown>> {
  return existsSync(world.journal) ? readFileSync(world.journal, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>) : []
}

async function relaunch(world: World, args: string[], statuses: string[] = []): Promise<Seen & { code: number }> {
  const seen: Seen = { runs: [], out: [], err: [], stops: [] }
  const code = await runRelaunch([world.handoff, ...args], relaunchDeps(world, statuses, seen))
  return { ...seen, code }
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

describe('statusOf', () => {
  it.each([
    ['CONTINUE', 'STATUS: CONTINUE\n', 'CONTINUE'],
    ['OWNER', 'STATUS: OWNER — the merge waits\n', 'OWNER'],
    ['DONE', 'STATUS:DONE\n', 'DONE'],
    ['STOP', 'STATUS: STOP\n', 'STOP'],
    ['the last line over an earlier one', 'STATUS: CONTINUE\nmore\nSTATUS: DONE\n', 'DONE'],
    ['the last known word over an unknown later one', 'STATUS: OWNER\nSTATUS: MAYBE\n', 'OWNER'],
    ['no line', 'nothing here\n', null],
    ['a STATUS inside a line', 'see STATUS: DONE\n', null],
    ['a word that only starts with a status', 'STATUS: DONEISH\n', null],
  ] as const)('reads %s', (_, text, status) => {
    expect(statusOf(text)).toBe(status)
  })
})

describe('runRelaunch', () => {
  it('runs a session per CONTINUE and stops at DONE', async () => {
    const world = newWorld()
    const result = await relaunch(world, ['--model', 'claude-test'], ['CONTINUE', 'CONTINUE', 'DONE'])
    expect(result.code).toBe(0)
    expect(result.runs).toHaveLength(3)
    expect(result.out.at(-1)).toBe('[relaunch] STATUS DONE')
    expect(result.runs[0]).toMatchObject({
      command: 'true',
      cwd: world.repo,
      prompt: relaunchPrompt(world.handoff, DECISIONS, '00000000-0000-4000-8000-000000000001'),
      log: `${world.handoff}.relaunch-1.log`,
      extraArgv: ['--model', 'claude-test'],
    })
    expect(result.runs.map(run => run.log)).toEqual([1, 2, 3].map(n => `${world.handoff}.relaunch-${n}.log`))
  })

  it('names the handoff it watches on the first line of every session\'s prompt', async () => {
    const world = newWorld()
    const result = await relaunch(world, ['--model', 'claude-test'], ['CONTINUE', 'DONE'])
    expect(result.runs.map(run => run.prompt.split('\n')[0])).toEqual([1, 2].map(() => promptFirstLine(world.handoff)))
    expect(result.runs.every(run => run.prompt.endsWith(LAUNCH_LINE))).toBe(true)
  })

  it('reads, journals and names a handoff given as a literal ~ path under the home directory', async () => {
    const world = newWorld()
    const seen: Seen = { runs: [], out: [], err: [], stops: [] }
    const code = await runRelaunch(['~/handoff.md', '--model', 'claude-test'], relaunchDeps(world, ['DONE'], seen))
    expect(code).toBe(0)
    expect(seen.runs.map(run => run.prompt.split('\n')[0])).toEqual([promptFirstLine(world.handoff)])
    expect(journalLines(world)[0]).toMatchObject({ event: 'relaunch-start', handoff: world.handoff })
  })

  it('resolves a relative handoff path against the current directory before it reads, journals or names it', async () => {
    const world = newWorld()
    const seen: Seen = { runs: [], out: [], err: [], stops: [] }
    const code = await runRelaunch([path.relative(world.repo, world.handoff), '--model', 'claude-test'], relaunchDeps(world, ['DONE'], seen))
    expect(code).toBe(0)
    expect(seen.runs.map(run => run.prompt.split('\n')[0])).toEqual([promptFirstLine(world.handoff)])
    expect(journalLines(world).map(line => line.handoff)).toEqual([world.handoff, world.handoff, world.handoff])
  })

  it.each([
    ['~', '/home/x'],
    ['~/a/b.md', '/home/x/a/b.md'],
    ['~other/b.md', '~other/b.md'],
    ['a/~/b.md', 'a/~/b.md'],
  ])('expandHome %s', (file, expanded) => {
    expect(expandHome(file, '/home/x')).toBe(expanded)
  })

  it('stops after one session when the handoff says OWNER', async () => {
    const world = newWorld()
    const result = await relaunch(world, ['--model', 'claude-test'], ['OWNER'])
    expect(result.code).toBe(0)
    expect(result.runs).toHaveLength(1)
    expect(result.out.at(-1)).toBe('[relaunch] STATUS OWNER')
  })

  it('starts nothing on a handoff that fails handoff:check and prints its refusal lines', async () => {
    const world = newWorld('CONTINUE', FIELDS.replace(`${HANDOFF_FIELDS[0]!.label}: x`, ''))
    const result = await relaunch(world, ['--model', 'claude-test'])
    expect(result.code).toBe(1)
    expect(result.runs).toHaveLength(0)
    expect(result.err).toContain(`[handoff:check] missing: ${HANDOFF_FIELDS[0]!.label} (${HANDOFF_FIELDS[0]!.id}, ${HANDOFF_FIELDS[0]!.group})`)
  })

  it('stops with handoff-invalid and starts no further session once a session leaves a second STOP section', async () => {
    const world = newWorld()
    const result = await relaunch(world, ['--model', 'claude-test'], [`CONTINUE\n\n${FIELDS}\nSTATUS: CONTINUE`])
    expect(result.code).toBe(1)
    expect(result.runs).toHaveLength(1)
    expect(result.err).toContain('[handoff:check] STOP sections: 2; a handoff holds exactly one, the older ones go to the archive through pnpm handoff:write')
    expect(result.err.at(-1)).toBe('[relaunch] handoff-invalid')
    expect(journalLines(world).at(-1)).toMatchObject({ event: 'relaunch-stop', reason: 'handoff-invalid', sessions: 1, refusals: expect.arrayContaining(['[handoff:check] STOP sections: 2; a handoff holds exactly one, the older ones go to the archive through pnpm handoff:write']) })
  })

  it('names pnpm handoff:write in the first line of the prompt and as the only way to write the handoff', () => {
    expect(relaunchPrompt('/h/handoff.md', '/d/owner-decisions.md', 's-1').split('\n')[0]).toBe(`${OPERATOR_ROLE} ${CONTINUE_PROMPT}: /h/handoff.md — write it only with pnpm handoff:write /h/handoff.md <draft>`)
    expect(relaunchPrompt('/h/handoff.md', '/d/owner-decisions.md', 's-1')).toContain('only with pnpm handoff:write /h/handoff.md <draft>, never by editing it')
  })

  it('the first line of the relaunch prompt names the Operator role and carries its tag', () => {
    const first = relaunchPrompt('/h/handoff.md', null, 's-1').split('\n')[0]!
    expect(first.startsWith(OPERATOR_ROLE)).toBe(true)
    expect(promptFirstLine('/h/handoff.md')).toContain('[operator]')
    expect(first).toContain(`start the who: shift cards as a shift chain with \`${CHAIN_COMMAND}\` and never run pnpm task:start for them`)
    expect(CHAIN_COMMAND).toBe('pnpm shift:bg <dir> --parking <parking> --chain')
    expect(first).toContain(`you never take a card body, except a who: window card, whose body you take yourself and journal as ${WINDOW_BODY_NOTE}`)
  })

  it('the operator role says the owner order is priority and not-before lives only in depends', () => {
    expect(OPERATOR_ROLE).toContain('the order in the owner\'s messages is priority, never a dependency; a "not before" exists only as depends in a card, set with construct intake --admit')
    expect(promptFirstLine('/h/handoff.md')).toContain('the order in the owner\'s messages is priority')
  })

  it('every session prompt names the owner decisions file', async () => {
    const world = newWorld()
    const result = await relaunch(world, ['--model', 'claude-test'], ['CONTINUE', 'DONE'])
    expect(result.runs).toHaveLength(2)
    for (const run of result.runs) {
      expect(run.prompt).toContain(DECISIONS)
      expect(run.prompt).toContain(`append each decision there as the next \`${DECISION_FORMAT}\` line, read the decisions in force with pnpm decisions ${DECISIONS}, and never copy them into the handoff`)
    }
  })

  it('starts nothing on a handoff ending in STATUS: STOP and stops with reason STATUS STOP', async () => {
    const world = newWorld('STOP')
    const result = await relaunch(world, ['--model', 'claude-test'])
    expect(result.code).toBe(0)
    expect(result.runs).toHaveLength(0)
    expect(result.out.at(-1)).toBe('[relaunch] STATUS STOP')
    expect(result.stops).toEqual([])
    expect(journalLines(world).at(-1)).toMatchObject({ event: 'relaunch-stop', reason: 'STATUS STOP', sessions: 0 })
  })

  it('starts nothing on a handoff with no STATUS line', async () => {
    const world = newWorld(null)
    const result = await relaunch(world, ['--model', 'claude-test'])
    expect(result.code).toBe(1)
    expect(result.runs).toHaveLength(0)
    expect(result.err.at(-1)).toBe('[relaunch] no STATUS line')
  })

  it('stops at --max with CONTINUE forever and writes the Operator\'s spend stop to the bus', async () => {
    const world = newWorld()
    const result = await relaunch(world, ['--max', '2', '--model', 'claude-test'])
    expect(result.code).toBe(0)
    expect(result.runs).toHaveLength(1 + 2)
    expect(result.out.at(-1)).toBe('[relaunch] max 2 reached')
    expect(result.stops).toEqual([{ role: 'operator', handoff: world.handoff, status: 'CONTINUE', reason: 'spend', raised: false }])
  })

  it('a relaunch the bus raised says so in its spend stop', async () => {
    const world = newWorld()
    const seen: Seen = { runs: [], out: [], err: [], stops: [] }
    expect(await runRelaunch([world.handoff, '--max', '1', '--model', 'claude-test'], { ...relaunchDeps(world, [], seen), raised: true })).toBe(0)
    expect(seen.stops).toMatchObject([{ reason: 'spend', raised: true }])
  })

  it('defaults --max to the shift\'s restart ceiling', async () => {
    const world = newWorld()
    const result = await relaunch(world, ['--model', 'claude-test'])
    expect(result.runs).toHaveLength(1 + MAX_RESTARTS)
  })

  it('refuses with no --model and no transcript, before any session', async () => {
    const world = newWorld()
    const result = await relaunch(world, [])
    expect(result.code).toBe(1)
    expect(result.runs).toHaveLength(0)
    expect(result.err).toEqual([`[relaunch] ${NO_MODEL}`])
  })

  it('takes the model of the last line that has one in the newest transcript', async () => {
    const world = newWorld()
    writeTranscript(world, 'old.jsonl', [{ model: 'claude-old' }], 1_000_000)
    writeTranscript(world, 'new.jsonl', [{ model: 'claude-first' }, { message: { model: 'claude-last' } }, { type: 'user' }], 2_000_000)
    const result = await relaunch(world, [], ['DONE'])
    expect(result.runs[0]!.extraArgv).toEqual(['--model', 'claude-last'])
  })

  it('lets --model win over the transcript', async () => {
    const world = newWorld()
    writeTranscript(world, 'new.jsonl', [{ model: 'claude-transcript' }], 2_000_000)
    const result = await relaunch(world, ['--model', 'claude-flag'], ['DONE'])
    expect(result.runs[0]!.extraArgv).toEqual(['--model', 'claude-flag'])
  })

  it('journals one relaunch-start line, one relaunch line per session and one relaunch-stop line', async () => {
    const world = newWorld()
    await relaunch(world, ['--model', 'claude-test'], ['CONTINUE', 'DONE'])
    const lines = journalLines(world)
    expect(lines.map(line => line.event)).toEqual(['relaunch-start', 'relaunch', 'relaunch', 'relaunch-stop'])
    expect(lines[0]).toMatchObject({ handoff: world.handoff, max: MAX_RESTARTS })
    expect(lines[1]).toMatchObject({ handoff: world.handoff, session: '00000000-0000-4000-8000-000000000001', model: 'claude-test', n: 1, exit: 0, status: 'CONTINUE' })
    expect(lines[2]).toMatchObject({ session: '00000000-0000-4000-8000-000000000002', model: 'claude-test', n: 2, status: 'DONE' })
    expect(lines[3]).toMatchObject({ handoff: world.handoff, reason: 'STATUS DONE', sessions: 2 })
    expect(lines.every(line => typeof line.ts === 'string')).toBe(true)
  })

  it('refuses a --model value that is a flag', async () => {
    const world = newWorld()
    const result = await relaunch(world, ['--model', '-p'])
    expect(result.code).toBe(1)
    expect(result.runs).toHaveLength(0)
  })

  it('stops after a session that exits nonzero, though the handoff still says CONTINUE', async () => {
    const world = newWorld()
    const seen: Seen = { runs: [], out: [], err: [], stops: [] }
    const deps = relaunchDeps(world, [], seen)
    const code = await runRelaunch([world.handoff, '--model', 'claude-test'], { ...deps, run: async (run) => {
      seen.runs.push(run)
      return { kind: 'exited', code: 2, signal: null }
    } })
    expect(code).toBe(1)
    expect(seen.runs).toHaveLength(1)
    expect(journalLines(world).at(-1)).toMatchObject({ event: 'relaunch-stop', reason: 'session 1 exited 2', sessions: 1 })
  })

  it('stops after a session that could not start', async () => {
    const world = newWorld()
    const seen: Seen = { runs: [], out: [], err: [], stops: [] }
    const deps = relaunchDeps(world, [], seen)
    const code = await runRelaunch([world.handoff, '--model', 'claude-test'], { ...deps, run: async (run) => {
      seen.runs.push(run)
      return { kind: 'unspawnable', error: 'ENOENT' }
    } })
    expect(code).toBe(1)
    expect(seen.runs).toHaveLength(1)
    expect(journalLines(world).at(-1)).toMatchObject({ event: 'relaunch-stop', reason: 'session 1 could not start: ENOENT' })
  })

  it('refuses a bad argv', async () => {
    const world = newWorld()
    const result = await relaunch(world, ['--max', '0', '--model', 'claude-test'])
    expect(result.code).toBe(1)
    expect(result.runs).toHaveLength(0)
  })

  it('the relaunch line carries the session pid', async () => {
    const world = newWorld()
    const seen: Seen = { runs: [], out: [], err: [], stops: [] }
    const deps = relaunchDeps(world, ['DONE'], seen)
    const code = await runRelaunch([world.handoff, '--model', 'claude-test'], { ...deps, run: async (run) => {
      run.onSpawn?.(4242)
      return deps.run(run)
    } })
    expect(code).toBe(0)
    const session = journalLines(world).filter(line => line.event === 'relaunch-session' || line.event === 'relaunch')
    expect(session).toMatchObject([
      { event: 'relaunch-session', session: '00000000-0000-4000-8000-000000000001', pid: 4242, n: 1, handoff: world.handoff },
      { event: 'relaunch', session: '00000000-0000-4000-8000-000000000001', pid: 4242, n: 1 },
    ])
  })

  it('a second relaunch on the same handoff refuses with already-running and the live pid', async () => {
    const world = newWorld()
    writeFileSync(lockPath(world.handoff), '7777\n')
    const seen: Seen = { runs: [], out: [], err: [], stops: [] }
    const code = await runRelaunch([world.handoff, '--model', 'claude-test'], { ...relaunchDeps(world, ['DONE'], seen), alive: pid => pid === 7777 })
    expect(code).toBe(1)
    expect(seen.runs).toHaveLength(0)
    expect(seen.err.at(-1)).toBe(`[relaunch] ${ALREADY_RUNNING} 7777`)
    expect(journalLines(world).at(-1)).toMatchObject({ event: 'relaunch-stop', reason: `${ALREADY_RUNNING} 7777`, sessions: 0 })
    expect(readFileSync(lockPath(world.handoff), 'utf8')).toBe('7777\n')
  })

  it('a lock whose pid is dead is taken over', async () => {
    const world = newWorld()
    writeFileSync(lockPath(world.handoff), '8888\n')
    const result = await relaunch(world, ['--model', 'claude-test'], ['DONE'])
    expect(result.code).toBe(0)
    expect(result.runs).toHaveLength(1)
    expect(readFileSync(lockPath(world.handoff), 'utf8')).toBe(`${RELAUNCH_PID}\n`)
  })

  it('a missing handoff refuses before the lock and writes no lock file', async () => {
    const world = newWorld()
    rmSync(world.handoff)
    const result = await relaunch(world, ['--model', 'claude-test'])
    expect(result.code).toBe(1)
    expect(result.err.at(-1)).toBe(`[relaunch] no handoff at ${world.handoff}`)
    expect(journalLines(world).at(-1)).toMatchObject({ event: 'relaunch-stop', reason: `no handoff at ${world.handoff}`, sessions: 0 })
    expect(existsSync(lockPath(world.handoff))).toBe(false)
  })

  it('a handoff whose directory is missing refuses with no handoff and creates nothing', async () => {
    const world = newWorld()
    const handoff = path.join(world.root, 'nodir', 'h.md')
    const seen: Seen = { runs: [], out: [], err: [], stops: [] }
    const code = await runRelaunch([handoff, '--model', 'claude-test'], relaunchDeps(world, [], seen))
    expect(code).toBe(1)
    expect(seen.err.at(-1)).toBe(`[relaunch] no handoff at ${handoff}`)
    expect(existsSync(path.dirname(handoff))).toBe(false)
  })

  it('a dead lock under a live takeover refuses with the taker\'s pid', async () => {
    const world = newWorld()
    writeFileSync(lockPath(world.handoff), '8888\n')
    writeFileSync(`${lockPath(world.handoff)}.takeover`, '6666\n')
    const seen: Seen = { runs: [], out: [], err: [], stops: [] }
    const code = await runRelaunch([world.handoff, '--model', 'claude-test'], { ...relaunchDeps(world, ['DONE'], seen), alive: pid => pid === 6666 })
    expect(code).toBe(1)
    expect(seen.runs).toHaveLength(0)
    expect(seen.err.at(-1)).toBe(`[relaunch] ${ALREADY_RUNNING} 6666`)
    expect(readFileSync(lockPath(world.handoff), 'utf8')).toBe('8888\n')
  })

  it('a takeover left by a dead pid is cleared and the dead lock taken over', async () => {
    const world = newWorld()
    writeFileSync(lockPath(world.handoff), '8888\n')
    writeFileSync(`${lockPath(world.handoff)}.takeover`, '6666\n')
    const result = await relaunch(world, ['--model', 'claude-test'], ['DONE'])
    expect(result.code).toBe(0)
    expect(readFileSync(lockPath(world.handoff), 'utf8')).toBe(`${RELAUNCH_PID}\n`)
    expect(existsSync(`${lockPath(world.handoff)}.takeover`)).toBe(false)
  })

  it('of two starts that both find a dead lock, the second refuses with the first\'s pid', async () => {
    const world = newWorld()
    writeFileSync(lockPath(world.handoff), '8888\n')
    const first: Seen = { runs: [], out: [], err: [], stops: [] }
    const second: Seen = { runs: [], out: [], err: [], stops: [] }
    const alive = (pid: number): boolean => pid === RELAUNCH_PID || pid === 9999
    const [a, b] = await Promise.all([
      runRelaunch([world.handoff, '--model', 'claude-test'], { ...relaunchDeps(world, ['DONE'], first), alive }),
      runRelaunch([world.handoff, '--model', 'claude-test'], { ...relaunchDeps(world, ['DONE'], second), pid: 9999, alive }),
    ])
    expect([a, b].sort()).toEqual([0, 1])
    expect(first.runs.length + second.runs.length).toBe(1)
    expect(existsSync(`${lockPath(world.handoff)}.takeover`)).toBe(false)
  })

  it('the lock is created exclusively: a second create of the same file fails and leaves the first pid', () => {
    const world = newWorld()
    const lock = lockPath(world.handoff)
    expect(createExclusive(lock, '1111\n')).toBe(true)
    expect(createExclusive(lock, '2222\n')).toBe(false)
    expect(readFileSync(lock, 'utf8')).toBe('1111\n')
  })

  it('a relaunch writes its own pid into the lock beside the handoff', async () => {
    const world = newWorld()
    const result = await relaunch(world, ['--model', 'claude-test'], ['DONE'])
    expect(result.code).toBe(0)
    expect(readFileSync(lockPath(world.handoff), 'utf8')).toBe(`${RELAUNCH_PID}\n`)
  })

  it('live sessions are read from the journal pid, not from the command text', async () => {
    const line = (event: string, session: string, pid: number): string => JSON.stringify({ event, handoff: '/h.md', session, pid, n: 1, command: 'claude --permission-mode auto -p' })
    const journal = [line('relaunch-session', 'running', 111), line('relaunch-session', 'ended', 222), line('relaunch', 'ended', 222), line('relaunch-session', 'dead', 333), 'not json'].join('\n')
    const asked: number[] = []
    const live = liveSessions(journal, (pid) => {
      asked.push(pid)
      return pid !== 333
    })
    expect(live).toEqual([{ session: 'running', pid: 111, n: 1, handoff: '/h.md' }])
    expect(asked.sort()).toEqual([111, 333])
    const world = newWorld()
    mkdirSync(path.dirname(world.journal), { recursive: true })
    writeFileSync(world.journal, `${journal}\n`)
    const seen: Seen = { runs: [], out: [], err: [], stops: [] }
    expect(await runRelaunch(['--live'], { ...relaunchDeps(world, [], seen), alive: pid => pid === 111 })).toBe(0)
    expect(seen.out).toEqual(['[relaunch] live: session 1 running pid 111 on /h.md'])
    expect(seen.runs).toEqual([])
  })
})

describe('the Operator at a task boundary', () => {
  function usageLine(context: number): object {
    return { message: { role: 'assistant', usage: { input_tokens: 10, cache_creation_input_tokens: 90, cache_read_input_tokens: context - 100 } } }
  }

  async function boundaryOf(world: World, session: string): Promise<string> {
    const seen: Seen = { runs: [], out: [], err: [], stops: [] }
    const code = await runRelaunch(['--boundary', session], relaunchDeps(world, [], seen))
    expect(code).toBe(0)
    return seen.out.join('\n')
  }

  async function operatorShift(world: World, contexts: number[]): Promise<{ code: number, runs: ClaudeRun[], taken: number[] }> {
    const seen: Seen = { runs: [], out: [], err: [], stops: [] }
    const taken: number[] = []
    const deps = relaunchDeps(world, [], seen)
    const code = await runRelaunch([world.handoff, '--model', 'claude-test'], { ...deps, run: async (run) => {
      seen.runs.push(run)
      const n = seen.runs.length
      writeTranscript(world, `${run.sessionId}.jsonl`, [usageLine(contexts[n - 1]!)], 1_000_000)
      const move = await boundaryOf(world, run.sessionId!)
      if (move.startsWith('[relaunch] end:')) {
        setStatus(world, 'CONTINUE')
      }
      else {
        taken.push(n)
        setStatus(world, 'DONE')
      }
      return { kind: 'exited', code: 0, signal: null }
    } })
    return { code, runs: seen.runs, taken }
  }

  it('a session above the threshold ends with STATUS: CONTINUE and the next session starts from the handoff; one below it takes the next task', async () => {
    const world = newWorld()
    const result = await operatorShift(world, [OPERATOR_CONTEXT_THRESHOLD + 1, OPERATOR_CONTEXT_THRESHOLD - 1])
    expect(result.code).toBe(0)
    expect(result.runs).toHaveLength(2)
    expect(result.taken).toEqual([2])
    expect(result.runs[1]!.prompt.split('\n')[0]).toBe(promptFirstLine(world.handoff))
    expect(journalLines(world).filter(line => line.event === 'relaunch').map(line => line.status)).toEqual(['CONTINUE', 'DONE'])
  })

  function idleOrThreshold(world: World, seen: Seen, plan: Array<'idle' | 'threshold' | 'done'>): RelaunchDeps['run'] {
    return async (run) => {
      seen.runs.push(run)
      const step = plan[seen.runs.length - 1] ?? 'idle'
      if (step === 'threshold') {
        writeTranscript(world, `${run.sessionId}.jsonl`, [usageLine(OPERATOR_CONTEXT_THRESHOLD + 1)], 1_000_000)
        await boundaryOf(world, run.sessionId!)
      }
      setStatus(world, step === 'done' ? 'DONE' : 'CONTINUE')
      return { kind: 'exited', code: 0, signal: null }
    }
  }

  it('a session that exits on idle is not followed until a bus event gives the Operator work', async () => {
    const world = newWorld()
    const bus = path.join(world.root, 'bus.db')
    const db = openBus(bus)
    const event = (type: string, n: number, head: string | null = null): void => {
      appendEvent(db, { ts: `2026-10-10T00:00:0${n}.000Z`, type, actor: 'worker:test:1', cardId: 809, pr: 732, head, dedupeKey: `${type}:${n}`, payload: {}, legacy: false })
    }
    event('pr.observed', 0, MAIN_1)
    const startsSeen: number[] = []
    const pauses: Array<() => void> = [
      () => event('pr.observed', 1, MAIN_1),
      () => event('task.renewed', 2),
      () => event('review.recorded', 3),
    ]
    const seen: Seen = { runs: [], out: [], err: [], stops: [] }
    const deps = relaunchDeps(world, [], seen)
    const code = await runRelaunch([world.handoff, '--model', 'claude-test'], {
      ...deps,
      run: idleOrThreshold(world, seen, ['idle', 'done']),
      work: operatorWork(bus, async () => {
        startsSeen.push(seen.runs.length)
        pauses.shift()?.()
      }),
    })
    db.close()

    expect(code).toBe(0)
    expect(seen.runs).toHaveLength(2)
    expect(startsSeen).toEqual([1, 1, 1])
    expect(journalLines(world).filter(line => line.event === 'relaunch').map(line => [line.trigger, line.idle])).toEqual([['start', true], ['event', false]])
  })

  it('an idle exit does not count toward --max', async () => {
    const world = newWorld()
    const seen: Seen = { runs: [], out: [], err: [], stops: [] }
    const code = await runRelaunch([world.handoff, '--max', '1', '--model', 'claude-test'], { ...relaunchDeps(world, [], seen), run: idleOrThreshold(world, seen, ['idle', 'threshold', 'idle']) })

    expect(code).toBe(0)
    expect(seen.runs).toHaveLength(2)
    expect(seen.out.at(-1)).toBe('[relaunch] max 1 reached')
    expect(journalLines(world).filter(line => line.event === 'relaunch').map(line => [line.trigger, line.counted, line.idle])).toEqual([['start', 0, true], ['event', 1, false]])
    expect(seen.stops).toMatchObject([{ reason: 'spend' }])
  })

  it('tells an idle exit from a threshold exit by the relaunch-boundary line the session wrote', () => {
    const line = (session: string, move: string): string => JSON.stringify({ event: BOUNDARY_EVENT, session, move })
    const journal = [line('s-1', 'end'), line('s-2', 'next'), line('s-3', 'end'), line('s-3', 'next')].join('\n')
    expect(['s-1', 's-2', 's-3', 's-4'].map(session => endedAtThreshold(journal, session))).toEqual([true, false, false, false])
  })

  it('names the boundary command with the session\'s own id in every session prompt', async () => {
    const world = newWorld()
    const result = await relaunch(world, ['--model', 'claude-test'], ['CONTINUE', 'DONE'])
    expect(result.runs.map(run => run.prompt.includes(boundaryCommand(run.sessionId!)))).toEqual([true, true])
  })

  it.each([
    ['end at the threshold', OPERATOR_CONTEXT_THRESHOLD, '[relaunch] end:'],
    ['take the next task below it', OPERATOR_CONTEXT_THRESHOLD - 1, '[relaunch] next:'],
  ])('reads the last response of the session\'s transcript and says %s', async (_, context, start) => {
    const world = newWorld()
    writeTranscript(world, 's-1.jsonl', [usageLine(OPERATOR_CONTEXT_THRESHOLD * 2), { type: 'user' }, usageLine(context)], 1_000_000)
    const line = await boundaryOf(world, 's-1')
    expect(line.startsWith(start)).toBe(true)
    expect(line).toContain(String(context))
  })

  it('finds the session\'s transcript by its id in another project directory than the one it runs from and ends past the threshold', async () => {
    const world = newWorld()
    const other = path.join(world.projects, '-elsewhere-main-checkout')
    mkdirSync(other, { recursive: true })
    writeFileSync(path.join(other, 's-1.jsonl'), JSON.stringify(usageLine(OPERATOR_CONTEXT_THRESHOLD)))
    expect(await boundaryOf(world, 's-1')).toBe(`[relaunch] ${boundaryLine(OPERATOR_CONTEXT_THRESHOLD, path.join(other, 's-1.jsonl'))}`)
  })

  it('ends the session and names where it looked when no transcript carries the session id', async () => {
    const world = newWorld()
    writeTranscript(world, 's-other.jsonl', [usageLine(1000)], 1_000_000)
    const line = await boundaryOf(world, 's-missing')
    expect(line).toBe(`[relaunch] ${boundaryLine(null, path.join(world.projects, '*', 's-missing.jsonl'))}`)
    expect(line.startsWith('[relaunch] end: context unread in ')).toBe(true)
  })

  it('tells an ending session and every relaunch prompt to write STATUS: CONTINUE', () => {
    expect(boundaryLine(OPERATOR_CONTEXT_THRESHOLD, 't.jsonl')).toContain('STATUS: CONTINUE')
    expect(boundaryLine(null, 't.jsonl')).toContain('STATUS: CONTINUE')
    expect(relaunchPrompt('/h/handoff.md', null, 's-1')).toContain(`run ${boundaryCommand('s-1')}: on end, write STOP with STATUS: CONTINUE and exit`)
  })

  it('ends the session before the Eddies warning fires', () => {
    const eddies = JSON.parse(readFileSync(fileURLToPath(new URL('../../../.claude/eddies.json', import.meta.url)), 'utf8')) as { contextLimit: number, warnRatio: number }
    expect(OPERATOR_CONTEXT_THRESHOLD).toBeLessThan(eddies.contextLimit * eddies.warnRatio)
  })

  it('refuses a session id that is not a plain id', async () => {
    const world = newWorld()
    const seen: Seen = { runs: [], out: [], err: [], stops: [] }
    expect(await runRelaunch(['--boundary', '../x'], relaunchDeps(world, [], seen))).toBe(1)
    expect(seen.out).toEqual([])
  })
})
