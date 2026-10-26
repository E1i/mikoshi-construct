import type { ExitReadings } from '../../window/eddies-measure.js'
import type { HandoffWriteDeps } from '../../window/handoff-write.js'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { printBoard } from '../../cli/board-page.js'
import { openBus } from '../../core/db.js'
import { HANDOFF_FIELDS } from '../../core/handoff-fields.js'
import { gitIn, runTaskStart } from '../../ports/task-start.js'
import { realMikoExitDeps, runMikoExit, SANDBOX_REFUSAL, stopReasonOf } from '../../window/exit.js'
import { runHandoffWrite } from '../../window/handoff-write.js'
import { productionDeps, tick, watchState } from '../../window/watch.js'

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  const execFileSync = ((file: string, ...rest: unknown[]) => {
    if (file === 'ps')
      throw Object.assign(new Error('spawnSync ps EPERM'), { code: 'EPERM' })
    return (actual.execFileSync as (...args: unknown[]) => unknown)(file, ...rest)
  }) as typeof actual.execFileSync
  return { ...actual, execFileSync }
})

const NOW = new Date('2026-10-17T10:00:00.000Z')
const AT_CONTEXT_WARN: ExitReadings = { sessionId: 's', context: 100, contextWarn: 100, spent: 1, spendWarn: 100 } as ExitReadings
const CARD = '#41 task-41 [implement/ghosts/S/cheap/auto] · depends — · blocks —'
const SETTINGS = path.join('.claude', 'settings.json')
const roots: string[] = []

const readOnly: string[] = []

afterEach(() => {
  for (const target of readOnly.splice(0))
    chmodSync(target, 0o755)
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function scratch(): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'sandbox-law-')))
  roots.push(root)
  return root
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=world', '-c', 'user.email=world@example.invalid', ...args], { encoding: 'utf8', stdio: 'pipe' })
}

function draftOf(): string {
  const values: Record<string, string> = { ...Object.fromEntries(HANDOFF_FIELDS.filter(field => field.id !== 'stop-reason').map(field => [field.label, field.id === 'decisions' ? import.meta.filename : `${field.id} value`])), 'queue': '#650 → #652', 'in-flight': '#650 brief', 'owner waits': 'none', 'next task': '#650 brief' }
  return `# Handoff\n\nrole: window\nsession: 2\n${Object.entries(values).map(([label, value]) => `${label}: ${value}`).join('\n')}\n\nSTATUS: CONTINUE\n`
}

function handoffWriteDeps(dir: string, out: string[], err: string[]): HandoffWriteDeps {
  return {
    cwd: dir,
    handoffDir: dir,
    sessionHandoff: null,
    exists: existsSync,
    read: file => readFileSync(file, 'utf8'),
    listDir: readdirSync,
    makeDir: target => mkdirSync(target, { recursive: true }),
    write: (file, text) => writeFileSync(file, text),
    writeNew: (file, text) => writeFileSync(file, text, { flag: 'wx' }),
    rename: renameSync,
    parked: () => new Map<number, number[]>([[650, []], [652, [650]]]),
    state: () => ({ kind: 'unread', why: 'no bus' }),
    merged: () => ({ kind: 'read', cards: [], merges: 0, updates: 0 }),
    prState: () => 'OPEN',
    decisionsShard: () => null,
    readings: () => AT_CONTEXT_WARN,
    stopReason: stopReasonOf,
    now: () => NOW,
    home: '/home/x',
    out: line => out.push(line),
    err: line => err.push(line),
  }
}

function worldWithSettings(): { root: string, repo: string, bus: string } {
  const root = scratch()
  const origin = path.join(root, 'origin.git')
  const repo = path.join(root, 'main-tree')
  mkdirSync(origin)
  git(origin, ['init', '-q', '--bare', '-b', 'main'])
  git(root, ['clone', '-q', origin, repo])
  mkdirSync(path.join(repo, '.claude'))
  writeFileSync(path.join(repo, SETTINGS), '{}\n')
  writeFileSync(path.join(repo, 'README.md'), 'world\n')
  git(repo, ['checkout', '-q', '-b', 'main'])
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'world'])
  git(repo, ['push', '-q', 'origin', 'main'])
  const bus = path.join(root, 'bus', 'bus.db')
  openBus(bus).close()
  return { root, repo, bus }
}

describe('the window commands under the sandbox law', () => {
  it('miko:exit, board, miko:watch and handoff:write complete when ps fails with EPERM, and task:start cuts its tree when .claude/settings.json is not writable', () => {
    const dir = scratch()
    const handoff = path.join(dir, 'miko.md')
    const lines: string[] = []
    const outside = runMikoExit({ ...realMikoExitDeps(handoff), loopRequest: undefined, readings: () => AT_CONTEXT_WARN, recordExit: () => {}, endWindow: undefined, observeStop: undefined, err: line => lines.push(line) })
    expect(outside).toBe(1)
    expect(lines).toEqual([`[miko] ${SANDBOX_REFUSAL}`])

    const request = path.join(dir, 'miko-exit.request')
    writeFileSync(handoff, 'STATUS: CONTINUE\n')
    const underLoop = runMikoExit({ ...realMikoExitDeps(handoff), loopRequest: request, readings: () => AT_CONTEXT_WARN, recordExit: () => {}, endWindow: undefined, observeStop: undefined, err: () => {}, handoffMtime: () => Date.now(), now: () => Date.now(), status: () => 'CONTINUE' })
    expect(underLoop).toBe(0)
    expect(existsSync(request)).toBe(true)

    const busPath = path.join(dir, 'bus.db')
    openBus(busPath).close()
    let page = ''
    expect(printBoard(busPath, NOW, (text) => {
      page += text
    })).toBe(0)
    expect(page).toContain('</html>')

    const handoffDir = path.join(dir, 'handoff')
    mkdirSync(handoffDir)
    const deps = productionDeps(handoffDir, busPath)
    expect(tick(watchState(deps), deps)).toEqual([])

    const out: string[] = []
    const err: string[] = []
    writeFileSync(path.join(dir, 'draft.md'), draftOf())
    expect(runHandoffWrite([path.join(dir, 'next.md'), path.join(dir, 'draft.md')], handoffWriteDeps(dir, out, err))).toBe(0)
    expect(err).toEqual([])

    const world = worldWithSettings()
    const worktreeHome = path.join(world.root, 'worktrees')
    const calls: string[][] = []
    const result = runTaskStart(['feat/x', '--card', CARD, '--without-intake', 'sandbox law'], {
      cwd: world.repo,
      git: (cwd, args) => {
        calls.push(args)
        if (args[0] === 'worktree' && args[1] === 'add') {
          const target = args[4]!
          gitIn(cwd, ['worktree', 'add', '--no-checkout', ...args.slice(2)])
          mkdirSync(path.join(target, '.claude'))
          chmodSync(path.join(target, '.claude'), 0o555)
          readOnly.push(path.join(target, '.claude'))
          throw new Error(`error: unable to create file ${SETTINGS.replaceAll(path.sep, '/')}: Operation not permitted\nfatal: Could not reset index file to revision 'origin/main'.`)
        }
        return gitIn(cwd, args)
      },
      install: () => {},
      exists: existsSync,
      bus: world.bus,
      now: () => NOW,
      session: undefined,
      worktreeHome,
    })
    expect(result.stderr).toEqual([])
    expect(result.exitCode).toBe(0)
    expect(result.stdout.join('\n')).toContain(SETTINGS)
    const tree = result.worktree!
    expect(readFileSync(path.join(tree, 'README.md'), 'utf8')).toBe('world\n')
    expect(existsSync(path.join(tree, SETTINGS))).toBe(false)
    expect(git(tree, ['status', '--porcelain'])).toBe('')
    expect(calls.some(args => args[0] === 'update-index' && args.includes('--skip-worktree') && args.includes(SETTINGS))).toBe(true)
  }, 30_000)
})
