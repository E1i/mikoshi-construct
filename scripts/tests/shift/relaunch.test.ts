import type { ClaudeRun } from '../../shift/claude.js'
import type { RelaunchDeps } from '../../shift/relaunch.js'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HANDOFF_FIELDS } from '../../ghosts/handoff-check.js'
import { CONTINUE_PROMPT, MAX_RESTARTS } from '../../shift/continuation.js'
import { LAUNCH_LINE, NO_MODEL, projectDirOf, runRelaunch, statusOf } from '../../shift/relaunch.js'

const FIELDS = HANDOFF_FIELDS.map(field => `${field.label}: x`).join('\n')
const roots: string[] = []

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
}

function relaunchDeps(world: World, statuses: string[], seen: Seen): RelaunchDeps {
  let uuids = 0
  let ticks = 0
  return {
    cwd: world.repo,
    claude: 'true',
    journal: world.journal,
    projectsDir: world.projects,
    read: file => readFileSync(file, 'utf8'),
    listDir: dir => existsSync(dir) ? readdirSync(dir) : [],
    modified: file => statSync(file).mtimeMs,
    now: () => new Date(Date.parse('2026-10-07T01:00:00.000Z') + 1000 * ticks++),
    uuid: () => `00000000-0000-4000-8000-00000000000${++uuids}`,
    run: async (run) => {
      seen.runs.push(run)
      setStatus(world, statuses[seen.runs.length - 1] ?? 'CONTINUE')
      return { kind: 'exited', code: 0, signal: null }
    },
    out: line => seen.out.push(line),
    err: line => seen.err.push(line),
  }
}

function journalLines(world: World): Array<Record<string, unknown>> {
  return existsSync(world.journal) ? readFileSync(world.journal, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>) : []
}

async function relaunch(world: World, args: string[], statuses: string[] = []): Promise<Seen & { code: number }> {
  const seen: Seen = { runs: [], out: [], err: [] }
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
      prompt: `${CONTINUE_PROMPT}\n\n${LAUNCH_LINE}`,
      log: `${world.handoff}.relaunch-1.log`,
      extraArgv: ['--model', 'claude-test'],
    })
    expect(result.runs.map(run => run.log)).toEqual([1, 2, 3].map(n => `${world.handoff}.relaunch-${n}.log`))
  })

  it('stops after one session when the handoff says OWNER', async () => {
    const world = newWorld()
    const result = await relaunch(world, ['--model', 'claude-test'], ['OWNER'])
    expect(result.code).toBe(0)
    expect(result.runs).toHaveLength(1)
    expect(result.out.at(-1)).toBe('[relaunch] STATUS OWNER')
  })

  it('starts nothing on a handoff that fails handoff:check and prints its refusal lines', async () => {
    const world = newWorld('CONTINUE', HANDOFF_FIELDS.slice(1).map(field => `${field.label}: x`).join('\n'))
    const result = await relaunch(world, ['--model', 'claude-test'])
    expect(result.code).toBe(1)
    expect(result.runs).toHaveLength(0)
    expect(result.err).toContain(`[handoff:check] missing: ${HANDOFF_FIELDS[0]!.label} (${HANDOFF_FIELDS[0]!.id}, ${HANDOFF_FIELDS[0]!.group})`)
  })

  it('starts nothing on a handoff with no STATUS line', async () => {
    const world = newWorld(null)
    const result = await relaunch(world, ['--model', 'claude-test'])
    expect(result.code).toBe(1)
    expect(result.runs).toHaveLength(0)
    expect(result.err.at(-1)).toBe('[relaunch] no STATUS line')
  })

  it('stops at --max with CONTINUE forever', async () => {
    const world = newWorld()
    const result = await relaunch(world, ['--max', '2', '--model', 'claude-test'])
    expect(result.code).toBe(0)
    expect(result.runs).toHaveLength(2)
    expect(result.out.at(-1)).toBe('[relaunch] max 2 reached')
  })

  it('defaults --max to the shift\'s restart ceiling', async () => {
    const world = newWorld()
    const result = await relaunch(world, ['--model', 'claude-test'])
    expect(result.runs).toHaveLength(MAX_RESTARTS)
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

  it('journals one relaunch line per session and one relaunch-stop line', async () => {
    const world = newWorld()
    await relaunch(world, ['--model', 'claude-test'], ['CONTINUE', 'DONE'])
    const lines = journalLines(world)
    expect(lines.map(line => line.event)).toEqual(['relaunch', 'relaunch', 'relaunch-stop'])
    expect(lines[0]).toMatchObject({ handoff: world.handoff, session: '00000000-0000-4000-8000-000000000001', model: 'claude-test', n: 1, exit: 0, status: 'CONTINUE' })
    expect(lines[1]).toMatchObject({ session: '00000000-0000-4000-8000-000000000002', model: 'claude-test', n: 2, status: 'DONE' })
    expect(lines[2]).toMatchObject({ handoff: world.handoff, reason: 'STATUS DONE', sessions: 2 })
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
    const seen: Seen = { runs: [], out: [], err: [] }
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
    const seen: Seen = { runs: [], out: [], err: [] }
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
})
