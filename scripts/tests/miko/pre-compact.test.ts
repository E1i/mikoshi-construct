import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { HANDOFF_DIR_VARIABLE } from '../../core/handoff-dir.js'
import { HANDOFF_FIELDS } from '../../core/handoff-fields.js'
import { CARD_VARIABLE, EXIT_REQUEST_VARIABLE, LOOP_PID_VARIABLE, WINDOW_VARIABLE } from '../../ports/session.js'
import { FRESH_MS } from '../../window/exit.js'
import { MIKO_HANDOFF_NAME } from '../../window/loop.js'
import { FRESH, HANDOFF_WRITE_SCRIPT, insuranceDraftOf, INSURED, NOT_A_TAB } from '../../window/pre-compact.js'
import { ENTRYPOINT_VARIABLE } from '../../window/tab.js'

const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..')
const PRE_COMPACT = path.join(REPO_ROOT, 'scripts', 'window', 'pre-compact.ts')
const RELAY = path.join(REPO_ROOT, '.claude', 'hooks', 'miko-relay.mjs')
const DECISIONS = fileURLToPath(import.meta.url)
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function draftText(): string {
  const values: Record<string, string> = { ...Object.fromEntries(HANDOFF_FIELDS.filter(field => field.id !== 'stop-reason').map(field => [field.label, field.id === 'decisions' ? DECISIONS : `${field.id} value`])), 'queue': 'none', 'in-flight': '#650 brief', 'owner waits': 'none', 'next task': '#650 brief' }
  return `# Handoff\n\nrole: window\nsession: 2\n${Object.entries(values).map(([label, value]) => `${label}: ${value}`).join('\n')}\n\nSTATUS: CONTINUE\n`
}

interface World { dir: string, handoff: string, env: NodeJS.ProcessEnv }

function world(env: NodeJS.ProcessEnv = {}): World {
  const dir = mkdtempSync(path.join(tmpdir(), 'pre-compact-'))
  roots.push(dir)
  return {
    dir,
    handoff: path.join(dir, MIKO_HANDOFF_NAME),
    env: { ...process.env, HOME: dir, [HANDOFF_DIR_VARIABLE]: dir, CONSTRUCT_HANDOFF: '', CONSTRUCT_BUS_DB: path.join(dir, 'no-bus.db'), CONSTRUCT_BUS_RAISED: '', CLAUDE_CODE_SESSION_ID: 's-tab', [ENTRYPOINT_VARIABLE]: 'cli', [CARD_VARIABLE]: '', [WINDOW_VARIABLE]: '', [LOOP_PID_VARIABLE]: '', [EXIT_REQUEST_VARIABLE]: '', ...env },
  }
}

function node(w: World, args: string[]): { status: number | null, stderr: string } {
  const run = spawnSync(process.execPath, ['--import', 'tsx', ...args], { cwd: REPO_ROOT, env: w.env, encoding: 'utf8' })
  return { status: run.status, stderr: run.stderr }
}

function relay(w: World, script: string): { status: number | null, stdout: string, stderr: string } {
  const run = spawnSync(process.execPath, [RELAY, script], { cwd: REPO_ROOT, env: { ...w.env, CLAUDE_PROJECT_DIR: REPO_ROOT }, input: JSON.stringify({ hook_event_name: 'PreCompact', trigger: 'auto' }), encoding: 'utf8' })
  return { status: run.status, stdout: run.stdout, stderr: run.stderr }
}

function written(w: World): string {
  const draft = path.join(w.dir, 'draft.md')
  writeFileSync(draft, draftText())
  const run = node(w, [HANDOFF_WRITE_SCRIPT, w.handoff, draft])
  expect(run).toEqual({ status: 0, stderr: '' })
  return readFileSync(w.handoff, 'utf8')
}

function age(w: World, ms: number): void {
  const at = (Date.now() - ms) / 1000
  utimesSync(w.handoff, at, at)
}

function archived(w: World): string[] {
  const dir = path.join(w.dir, 'archive')
  return existsSync(dir) ? readdirSync(dir) : []
}

describe('preCompact keeps the handoff of a tab window fresh before the context is compacted', () => {
  it('a PreCompact with a handoff older than FRESH_MS writes an insurance handoff', () => {
    const w = world()
    const before = written(w)
    age(w, FRESH_MS + 60_000)
    const run = node(w, [PRE_COMPACT])
    expect(run.status).toBe(0)
    expect(run.stderr).toContain(INSURED)
    expect(Date.now() - statSync(w.handoff).mtimeMs).toBeLessThan(FRESH_MS)
    expect(archived(w)).toEqual(['0001.md'])
    expect(readFileSync(path.join(w.dir, 'archive', '0001.md'), 'utf8')).toBe(before)
    const after = readFileSync(w.handoff, 'utf8')
    expect(after).toContain('prev: archive/0001.md')
    expect(after).toContain('next task: #650 brief')
    expect(after.trimEnd().endsWith('STATUS: CONTINUE')).toBe(true)
  }, 30_000)

  it('a PreCompact with a handoff written within FRESH_MS writes nothing', () => {
    const w = world()
    const before = written(w)
    const run = node(w, [PRE_COMPACT])
    expect(run.status).toBe(0)
    expect(run.stderr).toContain(FRESH)
    expect(readFileSync(w.handoff, 'utf8')).toBe(before)
    expect(archived(w)).toEqual([])
  }, 30_000)

  it('a PreCompact in a card session or a loop window insures nothing', () => {
    for (const env of [{ [CARD_VARIABLE]: '1266' }, { [WINDOW_VARIABLE]: '1' }]) {
      const w = world(env)
      writeFileSync(w.handoff, 'STATUS: CONTINUE\n')
      age(w, FRESH_MS + 60_000)
      const run = node(w, [PRE_COMPACT])
      expect(run.status).toBe(0)
      expect(run.stderr).toContain(NOT_A_TAB)
      expect(archived(w)).toEqual([])
    }
  }, 30_000)

  it('the insurance draft turns the written STOP heading back into role and session and drops what handoff:write generates', () => {
    const handoff = '# Handoff\n\n## STOP — window, 2026-10-23, session 7, boundary: none\nprev: archive/0003.md\nmerged today: none\nwindows: merge 0, update 0\nstop reason: none\ncurrent card: none\nqueue: #650\nin-flight:\n- #650 brief\n- #651 review PR #9\nblocked: none\nnext task: #650 brief\n\nSTATUS: CONTINUE\n'
    expect(insuranceDraftOf(handoff, true)).toBe('# Handoff\n\nrole: window\nsession: 7\nnext task: #650 brief\n\nSTATUS: CONTINUE\n')
    expect(insuranceDraftOf(handoff, false)).toBe('# Handoff\n\nrole: window\nsession: 7\ncurrent card: none\nqueue: #650\nin-flight:\n- #650 brief\n- #651 review PR #9\nblocked: none\nnext task: #650 brief\n\nSTATUS: CONTINUE\n')
  })

  it('the PreCompact hook relays to pre-compact and insures a stale handoff', () => {
    const w = world()
    written(w)
    age(w, FRESH_MS + 60_000)
    const run = relay(w, 'pre-compact')
    expect({ status: run.status, stdout: run.stdout }).toEqual({ status: 0, stdout: '' })
    expect(run.stderr).toContain(INSURED)
    expect(archived(w)).toEqual(['0001.md'])
  }, 30_000)

  it('the relay hook runs no script it does not name', () => {
    const w = world()
    const run = relay(w, 'exit')
    expect({ status: run.status, stdout: run.stdout }).toEqual({ status: 0, stdout: '' })
    expect(run.stderr).toContain('is not one of pre-compact')
  })
})
