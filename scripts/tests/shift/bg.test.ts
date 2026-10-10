import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { BG_LOG, launchArgv, runBg, USAGE } from '../../shift/bg.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function stub(bin: string, name: string, body: string): void {
  const file = path.join(bin, name)
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
}

const SYSTEM_BIN_DIRS = ['/bin', '/usr/bin']

function linkFromSystem(bin: string, name: string): void {
  const source = SYSTEM_BIN_DIRS.map(dir => path.join(dir, name)).find(file => existsSync(file))
  if (source === undefined)
    throw new Error(`${name} is in none of ${SYSTEM_BIN_DIRS.join(', ')}`)
  symlinkSync(source, path.join(bin, name))
}

function ownPgid(): string {
  return execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim()
}

function world(withSetsid: boolean): { root: string, dir: string, out: string, env: NodeJS.ProcessEnv } {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'shift-bg-')))
  roots.push(root)
  const bin = path.join(root, 'bin')
  const out = path.join(root, 'out')
  mkdirSync(bin)
  mkdirSync(out)
  linkFromSystem(bin, 'ps')
  linkFromSystem(bin, 'tr')
  stub(bin, 'nohup', `echo nohup >> "$STUB_OUT/chain"\nexec "$@"`)
  if (withSetsid)
    stub(bin, 'setsid', `echo setsid >> "$STUB_OUT/chain"\n"$@" &\nexit 0`)
  stub(bin, 'pnpm', `echo "pnpm shift output"\nprintf '%s\\n' "$*" > "$STUB_OUT/pnpm.argv"\nps -o pgid= -p $$ | tr -d ' ' > "$STUB_OUT/pgid"\nps -o args= -p $$ > "$STUB_OUT/self"\necho $$ > "$STUB_OUT/pid"`)
  const handoff = path.join(root, 'handoff')
  mkdirSync(handoff)
  return { root, dir: path.join(root, 'shift'), out, env: { PATH: bin, STUB_OUT: out, CONSTRUCT_HANDOFF_DIR: handoff } }
}

function ranShift(dir: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'shift.jsonl'), '')
}

function journal(w: { env: NodeJS.ProcessEnv }, ...lines: object[]): void {
  writeFileSync(path.join(w.env.CONSTRUCT_HANDOFF_DIR!, 'ghosts.jsonl'), lines.map(line => `${JSON.stringify(line)}\n`).join(''))
}

function answerArgv(dir: string): string[] {
  return [dir, '--answer', '758', '--prompt', path.join(dir, 'answer-758.md')]
}

async function settled(file: string): Promise<string> {
  for (let attempt = 0; attempt < 200 && !existsSync(file); attempt++)
    await new Promise(resolve => setTimeout(resolve, 25))
  return readFileSync(file, 'utf8').trim()
}

describe('pnpm shift:bg', () => {
  it('with a setsid on PATH that forks and exits, never runs it and prints the PID of the running pnpm shift', async () => {
    const w = world(true)
    const result = runBg([w.dir, '--chain'], w.env)
    expect(result.exitCode).toBe(0)
    const pid = await settled(path.join(w.out, 'pid'))
    expect(result.stdout[0]).toBe(pid)
    expect(await settled(path.join(w.out, 'self'))).toContain('pnpm shift')
    expect(await settled(path.join(w.out, 'pnpm.argv'))).toBe(`shift ${w.dir} --chain`)
    expect(readFileSync(path.join(w.out, 'chain'), 'utf8')).not.toContain('setsid')
    expect(readFileSync(path.join(w.out, 'chain'), 'utf8').trim()).toBe('nohup')
    expect(await settled(path.join(w.out, 'pgid'))).not.toBe(ownPgid())
    for (let attempt = 0; attempt < 200 && !readFileSync(path.join(w.dir, BG_LOG), 'utf8').includes('pnpm shift output'); attempt++)
      await new Promise(resolve => setTimeout(resolve, 25))
    expect(readFileSync(path.join(w.dir, BG_LOG), 'utf8')).toContain('pnpm shift output')
  })

  it('without setsid on PATH starts the shift in a session of its own through the detached spawn', async () => {
    const w = world(false)
    const result = runBg([w.dir, '--chain'], w.env)
    expect(result.exitCode).toBe(0)
    const pid = await settled(path.join(w.out, 'pid'))
    expect(result.stdout[0]).toBe(pid)
    expect(await settled(path.join(w.out, 'pgid'))).not.toBe(ownPgid())
    expect(readFileSync(path.join(w.out, 'chain'), 'utf8').trim()).toBe('nohup')
  })

  it('refuses without a dir and refuses a dir whose shift already ran, spawning nothing', () => {
    const w = world(true)
    expect(runBg([], w.env)).toEqual({ stdout: [], stderr: [USAGE], exitCode: 2 })
    expect(runBg(['--chain'], w.env).exitCode).toBe(2)
    mkdirSync(w.dir)
    writeFileSync(path.join(w.dir, 'shift.jsonl'), '')
    expect(runBg([w.dir, '--chain'], w.env).exitCode).toBe(1)
    expect(existsSync(path.join(w.out, 'chain'))).toBe(false)
  })

  it('shift:bg --answer starts on a shift directory whose shift.jsonl exists', async () => {
    const w = world(false)
    ranShift(w.dir)
    journal(w, { event: 'path', task: '758', path: 'cheap', shift: w.dir }, { event: 'stop', task: '758', at: 'question', why: 'which way', shift: w.dir }, { event: 'intake', task: '758' }, { event: 'answer-brief', task: '758', file: path.join(w.dir, 'answer-758.md') }, { event: 'stop', task: '759', at: 'fault', shift: w.dir })
    const result = runBg(answerArgv(w.dir), w.env)
    expect(result.stderr).toEqual([])
    expect(result.exitCode).toBe(0)
    await settled(path.join(w.out, 'pid'))
    expect(await settled(path.join(w.out, 'pnpm.argv'))).toBe(`shift ${answerArgv(w.dir).join(' ')}`)
  })

  it('shift:bg without --answer still refuses a directory whose shift.jsonl exists', () => {
    const w = world(false)
    ranShift(w.dir)
    journal(w, { event: 'stop', task: '758', at: 'question', why: 'which way', shift: w.dir })
    const result = runBg([w.dir, '--chain'], w.env)
    expect(result.exitCode).toBe(1)
    expect(result.stderr[0]).toContain('shift.jsonl exists')
    expect(existsSync(path.join(w.out, 'chain'))).toBe(false)
  })

  it('shift:bg --answer refuses a card whose last journal line is not a stop', () => {
    const w = world(false)
    ranShift(w.dir)
    const elsewhere = path.join(w.root, 'other-shift')
    const cases: Record<string, { lines: object[], reason: string }> = {
      'no journal line': { lines: [], reason: 'no journal line' },
      'a path line after the stop': { lines: [{ event: 'stop', task: '758', at: 'question', shift: w.dir }, { event: 'path', task: '758', path: 'cheap', shift: w.dir }], reason: 'event:path' },
      'a stop at fault': { lines: [{ event: 'stop', task: '758', at: 'fault', shift: w.dir }], reason: 'event:stop at fault' },
      'a stop in another shift': { lines: [{ event: 'stop', task: '758', at: 'question', shift: elsewhere }], reason: 'event:stop at question' },
      'a non-stop line at question in this shift': { lines: [{ event: 'path', task: '758', at: 'question', shift: w.dir }], reason: 'event:path' },
    }
    for (const { lines, reason } of Object.values(cases)) {
      journal(w, ...lines)
      const result = runBg(answerArgv(w.dir), w.env)
      expect(result.exitCode).toBe(1)
      expect(result.stderr[0]).toContain('#758')
      expect(result.stderr[0]).toContain(reason)
    }
    expect(existsSync(path.join(w.out, 'chain'))).toBe(false)
  })

  it('shift:bg --answer refuses when a state line without shift follows the stop', async () => {
    const w = world(false)
    ranShift(w.dir)
    const stop = { event: 'stop', task: '758', at: 'question', why: 'which way', shift: w.dir }
    const cases: Record<string, { lines: object[], refused: string | null }> = {
      'a hand task:start path line': { lines: [stop, { event: 'path', task: '758', path: 'cheap', started: '2026-10-09T10:00:00.000Z', worktree: w.root }], refused: 'event:path' },
      'the task:close end line': { lines: [stop, { event: 'path', task: '758', path: 'cheap', verification: 'run', ended: '2026-10-09T11:00:00.000Z' }], refused: 'event:path' },
      'the task:merged merge line': { lines: [stop, { event: 'merge', task: '758', pr: 703, by: 'E1i', commit: 'abc', merged: '2026-10-09T11:00:00Z' }], refused: 'event:merge' },
      'only stateless lines after the stop': { lines: [stop, { event: 'note', task: '758' }, { event: 'intake', task: '758' }, { event: 'intake-move', task: '758' }, { event: 'answer-brief', task: '758', file: path.join(w.dir, 'answer-758.md') }], refused: null },
    }
    for (const { lines, refused } of Object.values(cases)) {
      journal(w, ...lines)
      const result = runBg(answerArgv(w.dir), w.env)
      if (refused === null) {
        expect(result.stderr).toEqual([])
        expect(result.exitCode).toBe(0)
        await settled(path.join(w.out, 'pid'))
        expect(await settled(path.join(w.out, 'pnpm.argv'))).toBe(`shift ${answerArgv(w.dir).join(' ')}`)
      }
      else {
        expect(result.exitCode).toBe(1)
        expect(result.stderr[0]).toContain('#758')
        expect(result.stderr[0]).toContain(refused)
      }
    }
  })

  describe('a pr-review line as the last state of the card', () => {
    const HEAD = 'e16c475f00000000000000000000000000000000'
    const OLDER = 'a0a0a0a000000000000000000000000000000000'

    function openPr(head: string, state = 'OPEN'): (args: string[]) => string {
      return (args) => {
        expect(args.slice(0, 3)).toEqual(['pr', 'view', '705'])
        return JSON.stringify({ state, headRefOid: head })
      }
    }

    function reviewed(w: ReturnType<typeof world>, verdict: string, commit: string): void {
      ranShift(w.dir)
      journal(w, { event: 'path', task: '758', path: 'cheap', shift: w.dir }, { event: 'stop', task: '758', at: 'merge', why: 'armed', shift: w.dir }, { event: 'pr-review', task: '758', pr: 705, verdict, commit, ts: '2026-10-09T10:00:00.000Z' }, { event: 'answer-brief', task: '758', file: path.join(w.dir, 'answer-758.md') })
    }

    it('a pr-review changes at the head of the card open pull request is answered', async () => {
      const w = world(false)
      reviewed(w, 'changes', HEAD)
      const result = runBg(answerArgv(w.dir), w.env, openPr(HEAD))
      expect(result.stderr).toEqual([])
      expect(result.exitCode).toBe(0)
      await settled(path.join(w.out, 'pid'))
      expect(await settled(path.join(w.out, 'pnpm.argv'))).toBe(`shift ${answerArgv(w.dir).join(' ')}`)
    })

    it('a pr-review changes at an older head is refused', () => {
      const w = world(false)
      reviewed(w, 'changes', OLDER)
      const result = runBg(answerArgv(w.dir), w.env, openPr(HEAD))
      expect(result.exitCode).toBe(1)
      expect(result.stderr[0]).toContain(`event:pr-review changes at ${OLDER} on PR #705`)
      expect(result.stderr[0]).toContain(HEAD)
      expect(existsSync(path.join(w.out, 'chain'))).toBe(false)
    })

    it('a pr-review changes on a pull request that is no longer open is refused', () => {
      const w = world(false)
      reviewed(w, 'changes', HEAD)
      const result = runBg(answerArgv(w.dir), w.env, openPr(HEAD, 'MERGED'))
      expect(result.exitCode).toBe(1)
      expect(result.stderr[0]).toContain('not open (MERGED)')
      expect(existsSync(path.join(w.out, 'chain'))).toBe(false)
    })

    it('a pr-review pass is refused', () => {
      const w = world(false)
      reviewed(w, 'pass', HEAD)
      const result = runBg(answerArgv(w.dir), w.env, openPr(HEAD))
      expect(result.exitCode).toBe(1)
      expect(result.stderr[0]).toContain(`event:pr-review pass at ${HEAD} on PR #705`)
      expect(result.stderr[0]).toContain('not a changes verdict')
      expect(existsSync(path.join(w.out, 'chain'))).toBe(false)
    })

    it('a pr-review changes of a card whose last shift line is another shift is refused', () => {
      const w = world(false)
      ranShift(w.dir)
      journal(w, { event: 'stop', task: '758', at: 'merge', shift: path.join(w.root, 'other-shift') }, { event: 'pr-review', task: '758', pr: 705, verdict: 'changes', commit: HEAD })
      const result = runBg(answerArgv(w.dir), w.env, openPr(HEAD))
      expect(result.exitCode).toBe(1)
      expect(result.stderr[0]).toContain('other-shift')
      expect(existsSync(path.join(w.out, 'chain'))).toBe(false)
    })
  })

  it('a card stopped at merge with a later review-missing line is answered', async () => {
    const w = world(false)
    ranShift(w.dir)
    journal(w, { event: 'stop', task: '758', at: 'merge', why: 'armed', shift: w.dir }, { event: 'review-missing', task: '758', pr: 705, head: 'e16c475f', greenSince: '2026-10-09T10:00:00.000Z' })
    const result = runBg(answerArgv(w.dir), w.env)
    expect(result.stderr).toEqual([])
    expect(result.exitCode).toBe(0)
    await settled(path.join(w.out, 'pid'))
  })

  it('a card whose last line is ready-for-owner is still refused', () => {
    const w = world(false)
    ranShift(w.dir)
    journal(w, { event: 'stop', task: '758', at: 'merge', shift: w.dir }, { event: 'ready-for-owner', task: '758', pr: 705, head: 'e16c475f' })
    const result = runBg(answerArgv(w.dir), w.env)
    expect(result.exitCode).toBe(1)
    expect(result.stderr[0]).toContain('event:ready-for-owner')
  })

  it('launches nohup pnpm shift with the shift arguments and no setsid', () => {
    expect(launchArgv(['d', '--chain'])).toEqual(['nohup', 'pnpm', 'shift', 'd', '--chain'])
    expect(launchArgv(['d'])).toEqual(['nohup', 'pnpm', 'shift', 'd'])
  })
})
