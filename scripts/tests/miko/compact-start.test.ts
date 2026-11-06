import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { HANDOFF_DIR_VARIABLE } from '../../core/handoff-dir.js'
import { CARD_VARIABLE, WINDOW_MARK, WINDOW_VARIABLE } from '../../ports/session.js'
import { busWorktreeHome } from '../../ports/worktree-home.js'
import { compactContextOf, sourceOf, startContextOf, WAKE_UP } from '../../window/compact-start.js'
import { CONTINUE_PROMPT, MIKO_HANDOFF_NAME, repositoryContinuePrompt, TAB_MODE } from '../../window/loop.js'
import { cardTreeHomes, ENTRYPOINT_VARIABLE, HEADLESS_ENTRYPOINT } from '../../window/tab.js'

const TAB = { CLAUDE_CODE_SESSION_ID: 's-tab', [HANDOFF_DIR_VARIABLE]: '/h', [WINDOW_VARIABLE]: TAB_MODE }
const always = (): boolean => true
const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..')
const WINDOW_CORE = path.join(REPO_ROOT, '.claude', 'hooks', 'window-core.mjs')

function projectOutsideCardTrees(dir: string): string {
  const project = path.join(realpathSync(dir), 'project')
  mkdirSync(project)
  for (const linked of ['scripts', 'node_modules', 'architecture'])
    symlinkSync(path.join(REPO_ROOT, linked), path.join(project, linked))
  return project
}

function sessionStart(source: string): { context: string, continuePrompt: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'compact-start-'))
  try {
    const project = projectOutsideCardTrees(dir)
    writeFileSync(path.join(dir, MIKO_HANDOFF_NAME), '# Handoff\n\nnext task: #650 brief\n\nSTATUS: CONTINUE\n')
    const env = { ...process.env, HOME: dir, CONSTRUCT_WORKTREE_HOME: path.join(dir, 'worktrees'), CONSTRUCT_BUS_DB: path.join(dir, 'bus.db'), CLAUDE_PROJECT_DIR: project, CLAUDE_CODE_SESSION_ID: 's-tab', [HANDOFF_DIR_VARIABLE]: dir, CONSTRUCT_HANDOFF: '', [CARD_VARIABLE]: '', [WINDOW_VARIABLE]: TAB_MODE, MIKO_LOOP_PID: '', MIKO_EXIT_REQUEST: '', CONSTRUCT_BUS_RAISED: '', [ENTRYPOINT_VARIABLE]: 'cli' }
    const run = spawnSync(process.execPath, [WINDOW_CORE], { cwd: project, env, input: JSON.stringify({ hook_event_name: 'SessionStart', source }), encoding: 'utf8' })
    expect(run.status).toBe(0)
    const context = (JSON.parse(run.stdout) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext
    return { context: context.replaceAll(path.join(dir, MIKO_HANDOFF_NAME), '<handoff>'), continuePrompt: repositoryContinuePrompt(project, '<handoff>') }
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('a compacted tab window is handed the continue prompt', () => {
  it('a tab window with a handoff gets CONTINUE_PROMPT after compaction', () => {
    expect(compactContextOf('compact', TAB, file => file === '/h/miko.md')).toBe(CONTINUE_PROMPT)
  })

  it('a tab window without a handoff, a loop window, a card session and a headless session get nothing', () => {
    expect(compactContextOf('compact', TAB, () => false)).toBeNull()
    expect(compactContextOf('compact', { ...TAB, [WINDOW_VARIABLE]: WINDOW_MARK }, always)).toBeNull()
    expect(compactContextOf('compact', { ...TAB, [CARD_VARIABLE]: '1266' }, always)).toBeNull()
    expect(compactContextOf('compact', { ...TAB, [ENTRYPOINT_VARIABLE]: HEADLESS_ENTRYPOINT }, always)).toBeNull()
    expect(compactContextOf('compact', { ...TAB, [WINDOW_VARIABLE]: '' }, always)).toBeNull()
  })

  it('a session started, resumed or cleared gets nothing, and so does unreadable input', () => {
    for (const source of ['startup', 'resume', 'clear', null])
      expect(compactContextOf(source, TAB, always)).toBeNull()
    expect([sourceOf('{"source":"compact"}'), sourceOf('{}'), sourceOf('not json'), sourceOf('null')]).toEqual(['compact', null, null, null])
  })
})

describe('a tab window goes on after compaction without the owner', () => {
  it('session start after compact continues on CONTINUE and sets the wake-up', () => {
    const { context: compacted, continuePrompt } = sessionStart('compact')
    const { context: started } = sessionStart('startup')

    expect(compacted.endsWith(`\n\n${continuePrompt}\n\n${WAKE_UP}\n`)).toBe(true)
    expect(started.endsWith(`\n\n${WAKE_UP}\n`)).toBe(true)
    expect(started).not.toContain('<handoff>')
  }, 30_000)
})

describe('a tab window sets its own wake-up on every start', () => {
  it('a tab window without compaction gets the wake-up line at start', () => {
    const homes = cardTreeHomes({ CONSTRUCT_WORKTREE_HOME: '/w' }, '/b/bus.db')
    const handoff = (file: string): boolean => file === '/h/miko.md'

    for (const source of ['startup', 'resume', 'clear'])
      expect(startContextOf(source, TAB, handoff, '/repo', homes)).toBe(WAKE_UP)
    expect(startContextOf('compact', TAB, handoff, '/repo', homes)).toBe(`${compactContextOf('compact', TAB, handoff, '/repo')}\n\n${WAKE_UP}`)
    for (const tree of ['/w/mc-1436', path.join(busWorktreeHome('/b/bus.db'), '1436')])
      expect(startContextOf('startup', TAB, handoff, tree, homes)).toBeNull()
    expect(startContextOf('startup', { ...TAB, [CARD_VARIABLE]: '1436' }, handoff, '/repo', homes)).toBeNull()
    expect(startContextOf('startup', { ...TAB, [WINDOW_VARIABLE]: WINDOW_MARK }, handoff, '/repo', homes)).toBeNull()
  })
})
