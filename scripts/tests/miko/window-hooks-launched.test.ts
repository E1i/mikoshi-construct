import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { CARD_VARIABLE, EXIT_REQUEST_VARIABLE, LOOP_PID_VARIABLE, WINDOW_MARK, WINDOW_VARIABLE } from '../../ports/session.js'
import { MIKO_HANDOFF_NAME, TAB_MODE } from '../../window/loop.js'
import { ENTRYPOINT_VARIABLE, HEADLESS_ENTRYPOINT } from '../../window/tab.js'

const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..')
const HOOKS = path.join(REPO_ROOT, '.claude/hooks')
const OWNER_HANDOFF_PROMPT = 'прочитай ~/.construct/handoff/miko.md; продолжай'
const tabWindow = await import(pathToFileURL(path.join(HOOKS, 'tab-window.mjs')).href) as { startedByMiko?: (env: NodeJS.ProcessEnv) => boolean, isTabWindowIn: (env: NodeJS.ProcessEnv, dir: string, treeHomes: readonly string[]) => boolean }
const { startedByMiko } = tabWindow
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'window-hooks-')))
  roots.push(dir)
  return dir
}

function foreignProject(): string {
  const project = path.join(scratch(), 'project')
  mkdirSync(path.join(project, 'scripts'), { recursive: true })
  execFileSync('git', ['init', '-q', project])
  execFileSync('git', ['-C', project, 'remote', 'add', 'origin', 'git@github.com:acme/other-factory.git'])
  for (const linked of [path.join('scripts', 'window'), 'node_modules', 'architecture'])
    symlinkSync(path.join(REPO_ROOT, linked), path.join(project, linked))
  return project
}

function hook(name: string, args: readonly string[], project: string, input: object, env: NodeJS.ProcessEnv): { status: number | null, stdout: string, stderr: string } {
  const run = spawnSync(process.execPath, [path.join(HOOKS, name), ...args], {
    cwd: project,
    input: JSON.stringify(input),
    env: { ...process.env, HOME: path.dirname(project), CLAUDE_PROJECT_DIR: project, CONSTRUCT_HANDOFF_DIR: path.dirname(project), CONSTRUCT_HANDOFF: '', CONSTRUCT_BUS_DB: path.join(path.dirname(project), 'bus.db'), CONSTRUCT_WORKTREE_HOME: path.join(path.dirname(project), 'trees'), CONSTRUCT_BUS_RAISED: '', CLAUDE_CODE_SESSION_ID: 's-hook', [ENTRYPOINT_VARIABLE]: 'cli', [CARD_VARIABLE]: '', [WINDOW_VARIABLE]: '', [LOOP_PID_VARIABLE]: '', [EXIT_REQUEST_VARIABLE]: '', ...env },
    encoding: 'utf8',
    timeout: 25_000,
  })
  return { status: run.status, stdout: run.stdout, stderr: run.stderr }
}

const TAB = { [WINDOW_VARIABLE]: TAB_MODE }

describe.runIf(startedByMiko !== undefined)('with .construct/claude.patch applied, the hooks ask who miko started', () => {
  it('names a window exactly when the launcher marked it', () => {
    const started = startedByMiko!
    expect(started({ [WINDOW_VARIABLE]: WINDOW_MARK })).toBe(true)
    expect(started({ [LOOP_PID_VARIABLE]: '42' })).toBe(true)
    expect(started(TAB)).toBe(true)
    expect(started({})).toBe(false)
    expect(started({ [WINDOW_VARIABLE]: '0' })).toBe(false)
    expect(started({ ...TAB, [CARD_VARIABLE]: '1669' })).toBe(false)
    expect(started({ ...TAB, [ENTRYPOINT_VARIABLE]: HEADLESS_ENTRYPOINT })).toBe(false)
    expect(started({ ...TAB, CONSTRUCT_BUS_RAISED: '1' })).toBe(false)
    expect(tabWindow.isTabWindowIn({}, '/repo', ['/trees'])).toBe(false)
    expect(tabWindow.isTabWindowIn(TAB, '/repo', ['/trees'])).toBe(true)
    expect(tabWindow.isTabWindowIn(TAB, '/trees/mc-1', ['/trees'])).toBe(false)
  })

  it('sessionStart tells a bare session it is no window, keeps the core for a marked one, and says nothing to a headless one', () => {
    const project = foreignProject()
    const input = { hook_event_name: 'SessionStart', source: 'startup' }
    const contextOf = (env: NodeJS.ProcessEnv): string => (JSON.parse(hook('window-core.mjs', [], project, input, env).stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext

    const bare = contextOf({})
    expect(bare).toContain('it is no window')
    expect(bare).toContain('pnpm miko --tab')
    expect(bare).not.toContain('# Window core')
    expect(contextOf(TAB)).toContain('# Window core')
    expect(hook('window-core.mjs', [], project, input, { [ENTRYPOINT_VARIABLE]: HEADLESS_ENTRYPOINT })).toEqual({ status: 0, stdout: '', stderr: '' })
  }, 60_000)

  it('preCompact writes no insurance handoff for a bare session', () => {
    const project = foreignProject()
    const handoff = path.join(path.dirname(project), MIKO_HANDOFF_NAME)
    const stale = '# Handoff\n\nSTATUS: CONTINUE\n'
    writeFileSync(handoff, stale)
    utimesSync(handoff, new Date(0), new Date(0))
    const run = hook('miko-relay.mjs', ['pre-compact'], project, { hook_event_name: 'PreCompact', session_id: 's-hook', trigger: 'auto' }, {})
    expect(run).toEqual({ status: 0, stdout: '', stderr: '' })
    expect(readFileSync(handoff, 'utf8')).toBe(stale)
  }, 30_000)

  it('userPromptSubmit refuses a prompt addressed to another factory, naming the right window, and lets the rest through', () => {
    const project = foreignProject()
    const refused = hook('eddies.mjs', ['prompt'], project, { hook_event_name: 'UserPromptSubmit', session_id: 's-hook', prompt: OWNER_HANDOFF_PROMPT }, TAB)
    expect(refused.status).toBe(2)
    expect(refused.stderr).toContain('addressed to the window of the owner checkout')

    const plain = hook('eddies.mjs', ['prompt'], project, { hook_event_name: 'UserPromptSubmit', session_id: 's-hook', prompt: 'почини тест' }, TAB)
    expect(plain.status).toBe(0)
  }, 60_000)
})
