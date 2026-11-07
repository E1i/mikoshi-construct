import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { lastSessionPrompted, startContextOf } from '../../ports/client/claude/adapter.js'
import { MIKO_HANDOFF_NAME } from '../../window/loop.js'
import { FIRST_TURN_LIMIT, FIRST_WATCH_LIMIT, startContextReport, verdictOf, WATCH_MARKER } from '../../window/start-context.js'

const WORKTREE = '/a/tree'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'start-context-'))
  roots.push(root)
  return root
}

function prompt(text: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text } })
}

function turn(context: number, command: string | null = null): string {
  const content = command === null ? [{ type: 'text', text: 'ok' }] : [{ type: 'tool_use', name: 'Bash', input: { command } }]
  return JSON.stringify({ type: 'assistant', message: { role: 'assistant', content, usage: { input_tokens: 10, cache_creation_input_tokens: context - 10, cache_read_input_tokens: 0 } } })
}

function sessionIn(home: string, name: string, lines: string[], mtime: number): void {
  const dir = path.join(home, 'projects', WORKTREE.replace(/[^a-z0-9]/gi, '-'))
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${name}.jsonl`)
  writeFileSync(file, `${lines.join('\n')}\n`)
  utimesSync(file, mtime, mtime)
}

const WINDOW_PROMPT = `continue from ~/.construct/handoff/${MIKO_HANDOFF_NAME}`

it('reads the first turn and the context at the first miko:watch', () => {
  const transcript = [prompt(WINDOW_PROMPT), turn(40_000), turn(52_000, 'pnpm board --json --live'), turn(66_000, `pnpm ${WATCH_MARKER}`), turn(80_000, `pnpm ${WATCH_MARKER}`)].join('\n')
  expect(startContextOf(transcript, WATCH_MARKER)).toEqual({ firstTurn: 40_000, atMarker: 66_000 })
  expect(startContextOf(prompt(WINDOW_PROMPT), WATCH_MARKER)).toEqual({ firstTurn: null, atMarker: null })
})

it('passes at or under both limits and fails over either or with no watch', () => {
  expect(verdictOf({ firstTurn: FIRST_TURN_LIMIT, atMarker: FIRST_WATCH_LIMIT }).pass).toBe(true)
  expect(verdictOf({ firstTurn: 70_000, atMarker: 60_000 }).pass).toBe(false)
  expect(verdictOf({ firstTurn: 40_000, atMarker: 98_000 }).pass).toBe(false)
  expect(verdictOf({ firstTurn: 40_000, atMarker: null }).pass).toBe(false)
})

it('picks the newest session the window prompt started, not a newer card session', () => {
  const home = scratch()
  sessionIn(home, 'old-window', [prompt(WINDOW_PROMPT), turn(71_000), turn(98_000, `pnpm ${WATCH_MARKER}`)], 1_000)
  sessionIn(home, 'new-window', [prompt(WINDOW_PROMPT), turn(41_000), turn(65_000, `pnpm ${WATCH_MARKER}`)], 2_000)
  sessionIn(home, 'card', [prompt('# Shift task 1714'), turn(30_000)], 3_000)
  const env = { CLAUDE_CONFIG_DIR: home }
  expect(lastSessionPrompted(env, WORKTREE, MIKO_HANDOFF_NAME)).toMatch(/new-window\.jsonl$/)
  expect(lastSessionPrompted(env, '/no/such/tree', MIKO_HANDOFF_NAME)).toBeNull()
  expect(startContextReport(env, WORKTREE, ['--last'])).toMatchObject({ pass: true })
  expect(startContextReport(env, WORKTREE, []).pass).toBe(false)
  expect(startContextReport(env, '/no/such/tree', ['--last']).pass).toBe(false)
})
