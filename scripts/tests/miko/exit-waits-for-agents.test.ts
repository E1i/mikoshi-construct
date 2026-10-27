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
import { AGENTS_FILE, dirtyOpenCardTrees, liveAgentsOf } from '../../window/window-agents.js'

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

const start = (id: string, type: string | null = 'implementer'): string => JSON.stringify({ event: 'start', id, type })
const stop = (id: string, type: string | null = 'implementer'): string => JSON.stringify({ event: 'stop', id, type })
const hookInput = (name: string, id: string): string => JSON.stringify({ hook_event_name: name, agent_id: id, agent_type: 'implementer' })

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
    expect(liveAgentsOf(root)).toEqual(['implementer'])
  })

  it('a resume starts the same id again: start, stop, start leaves it live', () => {
    const root = journal([start('a1'), stop('a1'), start('a1')])
    expect(liveAgentsOf(root)).toEqual(['implementer'])
  })

  it('names an agent without a type by its id', () => {
    expect(liveAgentsOf(journal([start('a9', null)]))).toEqual(['a9'])
  })

  it('a denied launch leaves no live agent: a PreToolUse input writes nothing', async () => {
    const denied = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'implementer' } })
    expect(await agentLineOf(denied, 't')).toBeNull()
    expect(liveAgentsOf(journal([]))).toEqual([])
  })

  it('a SubagentStart and SubagentStop pair of one agent_id leaves no live agent', async () => {
    const pair = [hookInput('SubagentStart', 'a1'), hookInput('SubagentStop', 'a1')]
    const lines = await Promise.all(pair.map(async text => JSON.stringify(await agentLineOf(text, 't'))))
    expect(liveAgentsOf(journal(lines))).toEqual([])
  })

  it('names only dirty trees of open bus cards: a dirty merged card tree or a clean open one does not count', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'window-trees-'))
    roots.push(root)
    const busPath = path.join(root, 'bus', 'bus.db')
    const db = openBus(busPath)
    db.exec('PRAGMA foreign_keys = OFF')
    const insert = db.prepare('INSERT INTO cards (card_id, state, pr, event_id) VALUES (?, ?, NULL, 1)')
    const cards = [[1, 'running'], [2, 'merged'], [3, 'in_review'], [4, 'closed']] as const
    for (const [id, state] of cards)
      insert.run(id, state)
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
