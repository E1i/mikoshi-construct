import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HANDOFF_DIR_VARIABLE } from '../scripts/core/handoff-dir.js'
import { CARD_VARIABLE, EXIT_REQUEST_VARIABLE, LOOP_PID_VARIABLE, WINDOW_MARK, WINDOW_VARIABLE } from '../scripts/ports/session.js'
import { WAKE_UP } from '../scripts/window/compact-start.js'
import { MIKO_HANDOFF_NAME, repositoryContinuePrompt, TAB_MODE } from '../scripts/window/loop.js'
import { ENTRYPOINT_VARIABLE } from '../scripts/window/tab.js'

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
  const env: NodeJS.ProcessEnv = { ...process.env, [WINDOW_VARIABLE]: WINDOW_MARK }
  delete env.CLAUDE_PROJECT_DIR
  delete env[CARD_VARIABLE]
  if (root != null)
    env.CLAUDE_PROJECT_DIR = root
  return spawnSync('node', [HOOK], { input: '{}', env, encoding: 'utf8' })
}

function projectOutsideCardTrees(): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'construct-window-core-project-')))
  roots.push(root)
  for (const linked of ['scripts', 'node_modules', 'architecture'])
    symlinkSync(path.join(REPO_ROOT, linked), path.join(root, linked))
  return root
}

function tabSession(source: string): { additionalContext: string, handoff: string, project: string } {
  const handoffDir = mkdtempSync(path.join(tmpdir(), 'construct-window-core-handoff-'))
  roots.push(handoffDir)
  writeFileSync(path.join(handoffDir, MIKO_HANDOFF_NAME), '# Handoff\n\nSTATUS: CONTINUE\n')
  const project = projectOutsideCardTrees()
  const env = { ...process.env, HOME: handoffDir, CONSTRUCT_WORKTREE_HOME: path.join(handoffDir, 'worktrees'), CONSTRUCT_BUS_DB: path.join(handoffDir, 'bus.db'), CLAUDE_PROJECT_DIR: project, CLAUDE_CODE_SESSION_ID: 's-tab', [HANDOFF_DIR_VARIABLE]: handoffDir, CONSTRUCT_HANDOFF: '', CONSTRUCT_BUS_RAISED: '', [ENTRYPOINT_VARIABLE]: 'cli', [CARD_VARIABLE]: '', [WINDOW_VARIABLE]: TAB_MODE, [LOOP_PID_VARIABLE]: '', [EXIT_REQUEST_VARIABLE]: '' }
  const result = spawnSync('node', [HOOK], { cwd: project, input: JSON.stringify({ hook_event_name: 'SessionStart', source }), env, encoding: 'utf8' })
  expect(result.status).toBe(0)
  const lines = result.stdout.split('\n').filter(line => line !== '')
  expect(lines).toHaveLength(1)
  return { ...(JSON.parse(lines[0]) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput, handoff: path.join(handoffDir, MIKO_HANDOFF_NAME), project }
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

const SECTION_POINTER = /\[window\.md § ([^\]]+), lines (\d+)–(\d+)\]\(window\.md#[^)]+\)/g
const ANY_WINDOW_MD_LINK = /\]\(window\.md[#)]/g

function sectionRanges(text: string): Map<string, [number, number]> {
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n')
  const heads = lines.flatMap((line, at) => line.startsWith('## ') ? [{ title: line.slice(3), line: at + 1 }] : [])
  return new Map(heads.map((head, at) => [head.title, [head.line, at + 1 < heads.length ? heads[at + 1]!.line - 1 : lines.length]]))
}

it('every window.md pointer in window-core names its section with a line range that matches the file', () => {
  const core = readFileSync(path.join(REPO_ROOT, 'architecture', 'window-core.md'), 'utf8')
  const ranges = sectionRanges(readFileSync(path.join(REPO_ROOT, 'architecture', 'window.md'), 'utf8'))
  const pointers = [...core.matchAll(SECTION_POINTER)]
  expect(pointers.length).toBeGreaterThan(0)
  expect(pointers).toHaveLength([...core.matchAll(ANY_WINDOW_MD_LINK)].length)
  for (const [, title, start, end] of pointers)
    expect([Number(start), Number(end)], title).toEqual(ranges.get(title!))
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

  it('a tab window on SessionStart with source compact returns the continue prompt and the wake-up as additionalContext', () => {
    const core = readFileSync(path.join(REPO_ROOT, 'architecture', 'window-core.md'), 'utf8')
    const output = tabSession('compact')
    expect(output.additionalContext).toBe(`${core}\n\n${repositoryContinuePrompt(output.project, output.handoff)}\n\n${WAKE_UP}\n`)
  }, 20_000)

  it('a tab window on SessionStart with source startup, resume or clear returns the window core and the wake-up', () => {
    const core = readFileSync(path.join(REPO_ROOT, 'architecture', 'window-core.md'), 'utf8')
    for (const source of ['startup', 'resume', 'clear'])
      expect(tabSession(source).additionalContext).toBe(`${core}\n\n${WAKE_UP}\n`)
  }, 30_000)
})
