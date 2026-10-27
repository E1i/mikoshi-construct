import type { ExitReadings } from '../../window/eddies-measure.js'
import type { MikoExitDeps } from '../../window/exit.js'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { openBus } from '../../core/db.js'
import { taskWorktree, WORKTREE_HOME_VARIABLE } from '../../ports/worktree-home.js'
import { runMikoExit } from '../../window/exit.js'
import { AGENTS_FILE, dirtyOpenCardTrees, dirtyTreesOf, liveAgentsOf } from '../../window/window-agents.js'
import { SESSION_VARIABLE } from '../../window/window-requests.js'

const HOOK = path.resolve(import.meta.dirname, '../../../.claude/hooks/window-agents.mjs')

interface WindowAgentsHook {
  agentLineOf: (text: string, at: string) => unknown
}

async function agentLineOf(text: string, at: string): Promise<unknown> {
  const hook = await import(pathToFileURL(HOOK).href) as WindowAgentsHook
  return hook.agentLineOf(text, at)
}

const ABOVE = { context: 300000, contextWarn: 200000, spent: 0, spendWarn: 2400000 } as unknown as ExitReadings
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function exit(overrides: Partial<MikoExitDeps>): { code: number, lines: string[], requests: string[] } {
  const lines: string[] = []
  const requests: string[] = []
  const code = runMikoExit({
    pid: 14,
    table: () => [],
    handoffMtime: () => 0,
    now: () => 0,
    kill: () => {},
    loopRequest: '/r',
    requestEnd: request => requests.push(request),
    err: line => lines.push(line),
    readings: () => ABOVE,
    recordExit: () => {},
    handoff: '/h/miko.md',
    status: () => 'CONTINUE',
    ...overrides,
  })
  return { code, lines, requests }
}

function journal(events: string[]): string {
  const root = mkdtempSync(path.join(tmpdir(), 'window-agents-'))
  roots.push(root)
  mkdirSync(path.join(root, '.construct'))
  writeFileSync(path.join(root, AGENTS_FILE), events.map(event => `${event}\n`).join(''))
  return root
}

const SESSION = 's-now'
const THIS_SESSION = { [SESSION_VARIABLE]: SESSION }
const start = (id: string, type: string | null = 'implementer', session: string | null = SESSION): string => JSON.stringify({ event: 'start', id, type, session })
const stop = (id: string, type: string | null = 'implementer', session: string | null = SESSION): string => JSON.stringify({ event: 'stop', id, type, session })
const hookInput = (name: string, id: string): string => JSON.stringify({ hook_event_name: name, agent_id: id, agent_type: 'implementer', session_id: SESSION })

describe('pnpm miko:exit waits for the window\'s subagents and card trees', () => {
  it('refuses while a recorded agent lives, naming it', () => {
    const { code, lines, requests } = exit({ liveAgents: () => ['implementer'], dirtyTrees: () => [] })
    expect(code).toBe(1)
    expect(lines.join('\n')).toContain('implementer')
    expect(requests).toEqual([])
  })

  it('refuses while a card tree holds uncommitted changes, naming it', () => {
    const { code, lines, requests } = exit({ liveAgents: () => [], dirtyTrees: () => ['/w/1379'] })
    expect(code).toBe(1)
    expect(lines.join('\n')).toContain('/w/1379')
    expect(requests).toEqual([])
  })

  it('passes when both are empty', () => {
    const { code, requests } = exit({ liveAgents: () => [], dirtyTrees: () => [] })
    expect(code).toBe(0)
    expect(requests).toEqual(['/r'])
  })

  it('pairs by agent id: of two agents of one type, a stop strikes only its own', () => {
    const root = journal([start('a1'), start('a2'), stop('a1'), 'not json', JSON.stringify({ event: 'start', type: 'review' })])
    expect(liveAgentsOf(root, THIS_SESSION)).toEqual(['implementer'])
  })

  it('a resume starts the same id again: start, stop, start leaves it live', () => {
    const root = journal([start('a1'), stop('a1'), start('a1')])
    expect(liveAgentsOf(root, THIS_SESSION)).toEqual(['implementer'])
  })

  it('names an agent without a type by its id', () => {
    expect(liveAgentsOf(journal([start('a9', null)]), THIS_SESSION)).toEqual(['a9'])
  })

  it('a start line left by another session counts as no live agent', () => {
    const root = journal([start('old', 'implementer', 's-crashed'), start('legacy', 'implementer', null), start('a1')])
    expect(liveAgentsOf(root, THIS_SESSION)).toEqual(['implementer'])
  })

  it('with the session variable unset counts no agent, so exit is never locked forever', () => {
    expect(liveAgentsOf(journal([start('a1')]), {})).toEqual([])
  })

  it('the hook and the reader name one journal file', async () => {
    const hook = await import(pathToFileURL(HOOK).href) as { AGENTS_FILE: string }
    expect(hook.AGENTS_FILE).toBe(AGENTS_FILE)
  })

  it('the hook records the session id of its input', async () => {
    const line = await agentLineOf(hookInput('SubagentStart', 'a1'), 't')
    expect(line).toMatchObject({ event: 'start', id: 'a1', session: SESSION })
  })

  it('a denied launch leaves no live agent: a PreToolUse input writes nothing', async () => {
    const denied = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'implementer' } })
    expect(await agentLineOf(denied, 't')).toBeNull()
    expect(liveAgentsOf(journal([]), THIS_SESSION)).toEqual([])
  })

  it('a SubagentStart and SubagentStop pair of one agent_id leaves no live agent', async () => {
    const pair = [hookInput('SubagentStart', 'a1'), hookInput('SubagentStop', 'a1')]
    const lines = await Promise.all(pair.map(async text => JSON.stringify(await agentLineOf(text, 't'))))
    expect(liveAgentsOf(journal(lines), THIS_SESSION)).toEqual([])
  })

  it('a SubagentStart input written through the hook is read back as live', async () => {
    const root = journal([])
    execFileSync(process.execPath, [HOOK], { input: hookInput('SubagentStart', 'a1'), env: { ...process.env, CLAUDE_PROJECT_DIR: root } })
    expect(liveAgentsOf(root, THIS_SESSION)).toEqual(['implementer'])
  })

  it('names a directory that is not a git repository as unreadable', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'window-notgit-'))
    roots.push(root)
    expect(dirtyTreesOf([root])).toEqual([`${root} (unreadable: git status failed)`])
  })

  it('names only dirty trees of the window\'s open cards: a running card of another who does not count', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'window-owned-'))
    roots.push(root)
    const busPath = path.join(root, 'bus', 'bus.db')
    const db = openBus(busPath)
    db.exec('PRAGMA foreign_keys = OFF')
    db.prepare('INSERT INTO cards (card_id, state, pr, event_id) VALUES (?, ?, NULL, 1)').run(1, 'running')
    db.prepare('INSERT INTO cards (card_id, state, pr, event_id) VALUES (?, ?, NULL, 1)').run(2, 'running')
    const body = db.prepare('INSERT INTO card_bodies (card_id, admission_event_id, text, text_sha, who) VALUES (?, 1, \'\', \'\', ?)')
    body.run(1, 'window')
    body.run(2, 'worker')
    db.close()
    const home = path.join(root, 'trees')
    for (const id of [1, 2]) {
      const tree = taskWorktree(home, String(id))
      mkdirSync(tree, { recursive: true })
      execFileSync('git', ['init', '-q', tree])
      writeFileSync(path.join(tree, 'dirty.txt'), 'x')
    }
    expect(dirtyOpenCardTrees({ [WORKTREE_HOME_VARIABLE]: home }, busPath)).toEqual([taskWorktree(home, '1')])
  })

  it('names only dirty trees of open bus cards: a dirty merged card tree or a clean open one does not count', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'window-trees-'))
    roots.push(root)
    const busPath = path.join(root, 'bus', 'bus.db')
    const db = openBus(busPath)
    db.exec('PRAGMA foreign_keys = OFF')
    const insert = db.prepare('INSERT INTO cards (card_id, state, pr, event_id) VALUES (?, ?, NULL, 1)')
    const body = db.prepare('INSERT INTO card_bodies (card_id, admission_event_id, text, text_sha, who) VALUES (?, 1, \'\', \'\', \'window\')')
    const cards = [[1, 'running'], [2, 'merged'], [3, 'in_review'], [4, 'closed']] as const
    for (const [id, state] of cards) {
      insert.run(id, state)
      body.run(id)
    }
    db.close()
    const home = path.join(root, 'trees')
    for (const [id] of cards) {
      const tree = taskWorktree(home, String(id))
      mkdirSync(tree, { recursive: true })
      execFileSync('git', ['init', '-q', tree])
      if (id !== 3)
        writeFileSync(path.join(tree, 'dirty.txt'), 'x')
    }
    const env = { [WORKTREE_HOME_VARIABLE]: home }
    expect(dirtyOpenCardTrees(env, busPath)).toEqual([taskWorktree(home, '1')])
  })

  it('reads no agents from a missing journal', () => {
    expect(liveAgentsOf(path.join(tmpdir(), 'no-such-window-root'))).toEqual([])
  })
})
