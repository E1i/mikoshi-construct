import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HANDOFF_DIR_VARIABLE } from '../scripts/core/handoff-dir.js'
import { CONTINUE_PROMPT, MIKO_HANDOFF_NAME } from '../scripts/miko/loop.js'
import { ENTRYPOINT_VARIABLE } from '../scripts/miko/tab.js'
import { CARD_VARIABLE, EXIT_REQUEST_VARIABLE, LOOP_PID_VARIABLE, WINDOW_VARIABLE } from '../scripts/ports/session.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const HOOK = path.join(REPO_ROOT, '.claude', 'hooks', 'window-core.mjs')
const CORE_TEXT = '# Window core\n\nwindow-core v1\n\nÅ unicode and `code`\n'
const roots: string[] = []

function project(withCore: boolean): string {
  const root = mkdtempSync(path.join(tmpdir(), 'construct-window-core-'))
  roots.push(root)
  mkdirSync(path.join(root, 'architecture'), { recursive: true })
  if (withCore)
    writeFileSync(path.join(root, 'architecture', 'window-core.md'), CORE_TEXT)
  return root
}

function run(root: string | null) {
  const env = { ...process.env }
  delete env.CLAUDE_PROJECT_DIR
  if (root != null)
    env.CLAUDE_PROJECT_DIR = root
  return spawnSync('node', [HOOK], { input: '{}', env, encoding: 'utf8' })
}

function tabSession(source: string): { additionalContext: string } {
  const handoffDir = mkdtempSync(path.join(tmpdir(), 'construct-window-core-handoff-'))
  roots.push(handoffDir)
  writeFileSync(path.join(handoffDir, MIKO_HANDOFF_NAME), '# Handoff\n\nSTATUS: CONTINUE\n')
  const env = { ...process.env, CLAUDE_PROJECT_DIR: REPO_ROOT, CLAUDE_CODE_SESSION_ID: 's-tab', [HANDOFF_DIR_VARIABLE]: handoffDir, CONSTRUCT_HANDOFF: '', CONSTRUCT_BUS_RAISED: '', [ENTRYPOINT_VARIABLE]: 'cli', [CARD_VARIABLE]: '', [WINDOW_VARIABLE]: '', [LOOP_PID_VARIABLE]: '', [EXIT_REQUEST_VARIABLE]: '' }
  const result = spawnSync('node', [HOOK], { input: JSON.stringify({ hook_event_name: 'SessionStart', source }), env, encoding: 'utf8' })
  expect(result.status).toBe(0)
  const lines = result.stdout.split('\n').filter(line => line !== '')
  expect(lines).toHaveLength(1)
  return (JSON.parse(lines[0]) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

describe('the window-core SessionStart hook', () => {
  it('prints exactly one additionalContext equal to the file text', () => {
    const result = run(project(true))
    expect(result.status).toBe(0)
    const lines = result.stdout.split('\n').filter(line => line !== '')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0])).toEqual({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: CORE_TEXT } })
  })

  it('prints the same bytes on every run', () => {
    const root = project(true)
    expect(run(root).stdout).toBe(run(root).stdout)
  })

  function refusal(result: ReturnType<typeof run>) {
    expect(result.status).toBe(0)
    const lines = result.stdout.split('\n').filter(line => line !== '')
    expect(lines).toHaveLength(1)
    const output = JSON.parse(lines[0])
    expect(output.hookSpecificOutput.hookEventName).toBe('SessionStart')
    expect(output.hookSpecificOutput.additionalContext.startsWith('WINDOW-CORE MISSING: DO NOT COMMIT. DO NOT MERGE. STOP.\n')).toBe(true)
    expect(output.systemMessage.startsWith('WINDOW-CORE MISSING: DO NOT COMMIT. DO NOT MERGE. STOP.')).toBe(true)
    return output
  }

  it('tells the model and the owner to stop, naming the path, when the file is missing', () => {
    const root = project(false)
    const result = run(root)
    const output = refusal(result)
    const file = path.join(root, 'architecture', 'window-core.md')
    expect(output.hookSpecificOutput.additionalContext).toContain(file)
    expect(output.systemMessage).toContain(file)
    expect(result.stderr).toContain(file)
  })

  it('tells the model and the owner to stop when the project directory is not named', () => {
    const result = run(null)
    const output = refusal(result)
    expect(output.hookSpecificOutput.additionalContext).toContain('architecture/window-core.md')
    expect(result.stderr).toContain('architecture/window-core.md')
  })

  it('a tab window on SessionStart with source compact returns the continue prompt as additionalContext', () => {
    const core = readFileSync(path.join(REPO_ROOT, 'architecture', 'window-core.md'), 'utf8')
    const output = tabSession('compact')
    expect(output.additionalContext.startsWith(core)).toBe(true)
    expect(output.additionalContext.trimEnd().endsWith(CONTINUE_PROMPT)).toBe(true)
  }, 20_000)

  it('a tab window on SessionStart with source startup, resume or clear returns the window core alone', () => {
    const core = readFileSync(path.join(REPO_ROOT, 'architecture', 'window-core.md'), 'utf8')
    for (const source of ['startup', 'resume', 'clear'])
      expect(tabSession(source).additionalContext).toBe(core)
  }, 20_000)
})
