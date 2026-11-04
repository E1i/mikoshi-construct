import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { HANDOFF_DIR_VARIABLE } from '../../core/handoff-dir.js'
import { HANDOFF_FIELDS } from '../../core/handoff-fields.js'
import { CARD_VARIABLE, EXIT_REQUEST_VARIABLE, LOOP_PID_VARIABLE, WINDOW_VARIABLE } from '../../ports/session.js'
import { UNREAD } from '../../window/eddies-measure.js'
import { FRESH_MS, stopReasonOf } from '../../window/exit.js'
import { runHandoffWrite } from '../../window/handoff-write.js'
import { MIKO_HANDOFF_NAME } from '../../window/loop.js'
import { NOT_A_TAB } from '../../window/pre-compact.js'
import { ENTRYPOINT_VARIABLE } from '../../window/tab.js'

const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..')
const PRE_COMPACT = path.join(REPO_ROOT, 'scripts', 'window', 'pre-compact.ts')
const TSX = pathToFileURL(path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href
const DECISIONS = fileURLToPath(import.meta.url)
const STALE_HANDOFF = 'role: window\nsession: 2\nnext task: #650 brief\n\nSTATUS: CONTINUE\n'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'handoff-writers-')))
  roots.push(dir)
  return dir
}

function draftText(session: string): string {
  const values: Record<string, string> = { ...Object.fromEntries(HANDOFF_FIELDS.filter(field => field.id !== 'stop-reason').map(field => [field.label, field.id === 'decisions' ? DECISIONS : `${field.id} value`])), 'queue': 'none', 'in-flight': '#650 brief', 'owner waits': 'none', 'next task': '#650 brief' }
  return `# Handoff\n\nrole: window\nsession: ${session}\n${Object.entries(values).map(([label, value]) => `${label}: ${value}`).join('\n')}\n\nSTATUS: CONTINUE\n`
}

function writer(dir: string, listDir: (dir: string) => string[]): (draft: string) => { code: number, err: string[] } {
  return (draft) => {
    const err: string[] = []
    const code = runHandoffWrite([MIKO_HANDOFF_NAME, draft], {
      cwd: dir,
      handoffDir: dir,
      sessionHandoff: path.join(dir, MIKO_HANDOFF_NAME),
      exists: existsSync,
      read: file => readFileSync(file, 'utf8'),
      listDir,
      makeDir: made => mkdirSync(made, { recursive: true }),
      write: (file, text) => writeFileSync(file, text),
      writeNew: (file, text) => writeFileSync(file, text, { flag: 'wx' }),
      rename: renameSync,
      parked: () => new Map(),
      state: () => ({ kind: 'unread', why: 'no bus' }),
      merged: () => ({ kind: 'unread', why: 'no bus' }),
      prState: () => 'OPEN',
      decisionsShard: () => null,
      openQuestion: () => ({ kind: 'unread', why: 'no bus' }),
      readings: () => ({ ...UNREAD, context: 0, contextWarn: 160000, spent: 0, spendWarn: 2400000 }),
      stopReason: stopReasonOf,
      now: () => new Date('2026-11-02T12:00:00Z'),
      home: '/home/x',
      out: () => {},
      err: line => err.push(line),
    })
    return { code, err }
  }
}

describe('only the window writes miko.md, and each archive number is taken once', () => {
  it('a non-window session hook at the threshold leaves miko.md unchanged', () => {
    const home = scratch()
    const handoffDir = path.join(home, 'handoff')
    const tree = path.join(home, 'worktrees', 'mc-1436')
    mkdirSync(handoffDir, { recursive: true })
    mkdirSync(tree, { recursive: true })
    const miko = path.join(handoffDir, MIKO_HANDOFF_NAME)
    writeFileSync(miko, STALE_HANDOFF)
    const at = (Date.now() - FRESH_MS - 60_000) / 1000
    utimesSync(miko, at, at)
    const env = { ...process.env, HOME: home, [HANDOFF_DIR_VARIABLE]: handoffDir, CONSTRUCT_HANDOFF: '', CONSTRUCT_WORKTREE_HOME: path.join(home, 'worktrees'), CONSTRUCT_BUS_DB: path.join(home, 'no-bus.db'), CONSTRUCT_BUS_RAISED: '', CLAUDE_CODE_SESSION_ID: 's-1436', CLAUDE_PROJECT_DIR: tree, [ENTRYPOINT_VARIABLE]: 'cli', [CARD_VARIABLE]: '', [WINDOW_VARIABLE]: '', [LOOP_PID_VARIABLE]: '', [EXIT_REQUEST_VARIABLE]: '' }

    const run = spawnSync(process.execPath, ['--import', TSX, PRE_COMPACT], { cwd: tree, env, encoding: 'utf8', input: JSON.stringify({ hook_event_name: 'PreCompact', trigger: 'auto' }) })

    expect(run.status).toBe(0)
    expect(run.stderr).toContain(NOT_A_TAB)
    expect(readFileSync(miko, 'utf8')).toBe(STALE_HANDOFF)
    expect(existsSync(path.join(handoffDir, 'archive'))).toBe(false)
  }, 30_000)

  it('two writers racing for one archive number write two archives without an error', () => {
    const dir = scratch()
    writeFileSync(path.join(dir, MIKO_HANDOFF_NAME), STALE_HANDOFF)
    const first = path.join(dir, 'first.md')
    const second = path.join(dir, 'second.md')
    writeFileSync(first, draftText('2'))
    writeFileSync(second, draftText('3'))
    const listedBeforeEitherArchived: string[] = []

    const firstRun = writer(dir, () => listedBeforeEitherArchived)(first)
    const secondRun = writer(dir, () => listedBeforeEitherArchived)(second)

    expect(firstRun).toEqual({ code: 0, err: [] })
    expect(secondRun).toEqual({ code: 0, err: [] })
    expect(readdirSync(path.join(dir, 'archive')).sort()).toEqual(['0001.md', '0002.md'])
    expect(readFileSync(path.join(dir, 'archive', '0001.md'), 'utf8')).toBe(STALE_HANDOFF)
    expect(readFileSync(path.join(dir, 'archive', '0002.md'), 'utf8')).toContain('session 2')
    const handoff = readFileSync(path.join(dir, MIKO_HANDOFF_NAME), 'utf8')
    expect(handoff).toContain('session 3')
    expect(handoff).toContain('prev: archive/0002.md')
    expect(handoff).not.toContain('prev: archive/0001.md')
    expect(readdirSync(dir).filter(name => name.endsWith('.writing'))).toEqual([])
  })
})
