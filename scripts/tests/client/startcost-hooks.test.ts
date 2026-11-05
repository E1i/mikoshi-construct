import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { CARD_VARIABLE, EXIT_REQUEST_VARIABLE, LOOP_PID_VARIABLE, WINDOW_VARIABLE } from '../../ports/session.js'
import { AGENTS_FILE } from '../../window/window-agents.js'

const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..')
const HOOKS = path.join(REPO_ROOT, '.claude', 'hooks')
const CORE_TEXT = '# Window core\n\nwindow-core v1\n'
const CARD = { [CARD_VARIABLE]: '1585' }
const WINDOW = { [CARD_VARIABLE]: '', [WINDOW_VARIABLE]: '1' }
const SUBAGENT_START = JSON.stringify({ hook_event_name: 'SubagentStart', agent_id: 'a-1', agent_type: 'implementer', session_id: 's-1' })
const PRE_COMPACT = JSON.stringify({ hook_event_name: 'PreCompact', trigger: 'auto' })
const STOP = JSON.stringify({ session_id: 's-1', stop_hook_active: false })
const SESSION_START = JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' })
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function project(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'startcost-hooks-'))
  roots.push(root)
  mkdirSync(path.join(root, 'architecture'))
  writeFileSync(path.join(root, 'architecture', 'window-core.md'), CORE_TEXT)
  return root
}

function hook(root: string, name: string, args: string[], input: string, env: NodeJS.ProcessEnv): { status: number | null, stdout: string, stderr: string } {
  const run = spawnSync(process.execPath, [path.join(HOOKS, name), ...args], {
    cwd: root,
    input,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, [LOOP_PID_VARIABLE]: '', [EXIT_REQUEST_VARIABLE]: '', ...env },
  })
  return { status: run.status, stdout: run.stdout, stderr: run.stderr }
}

describe('window hooks add nothing under a card and still deliver to a window', () => {
  const silentUnderACard: Array<[string, string[], string]> = [
    ['window-core.mjs', [], SESSION_START],
    ['window-agents.mjs', [], SUBAGENT_START],
    ['miko-relay.mjs', ['pre-compact'], PRE_COMPACT],
    ['miko-relay.mjs', ['not-a-relayed-script'], PRE_COMPACT],
    ['turn-watch.mjs', [], STOP],
  ]

  it.each(silentUnderACard)('%s %j says nothing under a card', (name, args, input) => {
    expect(hook(project(), name, args, input, CARD)).toEqual({ status: 0, stdout: '', stderr: '' })
  })

  it('window-agents records no line under a card and records the line in a window', () => {
    const card = project()
    hook(card, 'window-agents.mjs', [], SUBAGENT_START, CARD)
    expect(existsSync(path.join(card, AGENTS_FILE))).toBe(false)
    const window = project()
    hook(window, 'window-agents.mjs', [], SUBAGENT_START, WINDOW)
    expect(existsSync(path.join(window, AGENTS_FILE))).toBe(true)
  })

  it('a window still receives window-core', () => {
    const run = hook(project(), 'window-core.mjs', [], SESSION_START, WINDOW)
    expect(run.status).toBe(0)
    expect((JSON.parse(run.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext).toContain(CORE_TEXT)
  })

  it('the relay still speaks in a window', () => {
    const run = hook(project(), 'miko-relay.mjs', ['not-a-relayed-script'], PRE_COMPACT, WINDOW)
    expect(run.stderr).toContain('miko-relay hook')
  })
})
