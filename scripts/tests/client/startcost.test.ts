import type { Invocation, ReadBudget, SessionPolicy, SessionSpec } from '../../ports/client/contract.js'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os, { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cardToolsOf, parseParkingFile } from '../../../src/card/parking.js'
import { openBus } from '../../core/db.js'
import { windowCommand } from '../../ports/client/claude/adapter.js'
import { clientAdapter } from '../../ports/client/index.js'
import { runtimeIsolation } from '../../ports/isolation.js'
import { clientInvocation } from '../../ports/session.js'
import { CARD_SESSION_SANDBOX } from '../../ports/shift-settings.js'
import { recordHeartbeat, runHeartbeat } from '../../supervisor/heartbeat.js'

const SESSION = '11111111-2222-3333-4444-555555555555'
const PROMPT = 'the prompt'
const SIX_TOOLS = 'Read,Edit,Write,Bash,Grep,Glob'
const USER_INSTRUCTIONS = path.join(os.homedir(), '.claude', 'CLAUDE.md')
const CARD_ROLES = ['launch', 'answer', 'review'] as const
const SANDBOXED: SessionPolicy = { profile: 'sandboxed', gateCommands: ['pnpm run gate'], writePaths: [], mcpOff: true }
const CLIENT_DEFAULT: SessionPolicy = { profile: 'client-default', gateCommands: [], writePaths: [], mcpOff: true }

const roots: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function aRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'startcost-'))
  roots.push(root)
  return root
}

function specOf(fields: Partial<SessionSpec>): SessionSpec {
  return { kind: 'start', role: 'launch', session: SESSION, cwd: '/tree', prompt: PROMPT, addDirs: [], pick: { model: null }, policy: SANDBOXED, ...fields }
}

function settingsOf(invocation: Invocation): Record<string, unknown> {
  return JSON.parse(invocation.args[invocation.args.indexOf('--settings') + 1]!) as Record<string, unknown>
}

function assistant(usage: Record<string, unknown> | null, tool?: string): string {
  return JSON.stringify({ type: 'assistant', message: { role: 'assistant', ...(usage === null ? {} : { usage }), content: tool === undefined ? [{ type: 'text', text: 'x' }] : [{ type: 'tool_use', name: tool, input: {} }] } })
}

function contextUsage(input: number, cacheWrite: number, cacheRead: number): Record<string, unknown> {
  return { input_tokens: input, cache_creation_input_tokens: cacheWrite, cache_read_input_tokens: cacheRead, output_tokens: 1 }
}

function transcriptIn(lines: string[]): string {
  const home = aRoot()
  const project = path.join(home, '.claude', 'projects', 'the-project')
  mkdirSync(project, { recursive: true })
  writeFileSync(path.join(project, `${SESSION}.jsonl`), `${lines.join('\n')}\n`)
  return home
}

describe('the invocation of a card session', () => {
  it('launch answer and review invocations narrow tools and exclude the user instructions and memory', () => {
    for (const role of CARD_ROLES) {
      for (const kind of ['start', 'resume'] as const) {
        for (const policy of [SANDBOXED, CLIENT_DEFAULT]) {
          const invocation = clientInvocation(specOf({ role, kind, policy }))
          const { args } = invocation
          const label = `${role} ${kind} ${policy.profile}`
          expect(args[args.indexOf('--tools') + 1], label).toBe(SIX_TOOLS)
          expect(args, label).toContain('--disable-slash-commands')
          expect(args[args.indexOf('--tools') + 2], label).toMatch(/^--/)
          expect(settingsOf(invocation), label).toMatchObject({ autoMemoryEnabled: false, claudeMdExcludes: [USER_INSTRUCTIONS] })
          if (invocation.stdin === null)
            expect(args.at(-1), label).toBe(PROMPT)
          else
            expect(invocation.stdin, label).toBe(PROMPT)
        }
      }
    }
  })

  it('a client-default card session gains a settings flag holding only the two keys', () => {
    const invocation = clientInvocation(specOf({ role: 'review', policy: CLIENT_DEFAULT }))
    expect(settingsOf(invocation)).toEqual({ autoMemoryEnabled: false, claudeMdExcludes: [USER_INSTRUCTIONS] })
    expect(invocation.args).not.toContain('--setting-sources')
  })

  it('a sandboxed card session keeps its sandbox settings and no setting source is narrowed', () => {
    for (const role of CARD_ROLES) {
      const { args } = clientInvocation(specOf({ role }))
      expect(args[args.indexOf('--setting-sources') + 1], role).toBe('project,local')
      expect(settingsOf(clientInvocation(specOf({ role }))).sandbox, role).toEqual(CARD_SESSION_SANDBOX)
    }
    expect(clientInvocation(specOf({ role: 'review', policy: CLIENT_DEFAULT })).args).not.toContain('--setting-sources')
  })

  it('a window invocation is the window command and a tools line widens only that card', () => {
    const window = clientInvocation(specOf({ role: 'window', policy: CLIENT_DEFAULT, prompt: '' }))
    expect(window.args).toEqual(windowCommand({}).split(' ').slice(1))
    expect(window.args).not.toContain('--tools')

    const plain = clientInvocation(specOf({ role: 'launch' })).args
    expect(plain[plain.indexOf('--tools') + 1]).toBe(SIX_TOOLS)

    const web = clientInvocation(specOf({ role: 'launch', policy: { ...SANDBOXED, tools: ['web'] } })).args
    expect(web[web.indexOf('--tools') + 1]).toBe(`${SIX_TOOLS},WebFetch,WebSearch`)
    expect(web).toContain('--disable-slash-commands')

    const agents = clientInvocation(specOf({ role: 'answer', policy: { ...SANDBOXED, tools: ['agents'] } })).args
    expect(agents[agents.indexOf('--tools') + 1]).toBe(`${SIX_TOOLS},Agent`)

    const skills = clientInvocation(specOf({ role: 'launch', policy: { ...SANDBOXED, tools: ['skills'] } })).args
    expect(skills[skills.indexOf('--tools') + 1]).toBe(`${SIX_TOOLS},Skill`)
    expect(skills).not.toContain('--disable-slash-commands')
    expect(skills[skills.indexOf('--tools') + 2]).toMatch(/^--/)
  })

  it('a ladder session and a Ghost keep every tool, their slash commands and the user instructions', () => {
    for (const role of ['ladder', 'ghost'] as const) {
      const invocation = clientInvocation(specOf({ role, policy: CLIENT_DEFAULT }))
      expect(invocation.args, role).not.toContain('--tools')
      expect(invocation.args, role).not.toContain('--disable-slash-commands')
      expect(invocation.args, role).not.toContain('--settings')
    }
    const gated = settingsOf(clientInvocation(specOf({ role: 'ladder', kind: 'resume' })))
    expect(gated).not.toHaveProperty('claudeMdExcludes')
    expect(gated).not.toHaveProperty('autoMemoryEnabled')
  })

  it('the isolation command of the review and answer workers names no settings flag, so the reader does not refuse them', () => {
    const command = clientAdapter().processes.isolationCommand()
    expect(command.join(' ')).not.toContain('--settings')
    const facts = { managed: null, flag: null, local: null, project: null, user: { sandbox: { enabled: true } }, platform: 'darwin', sandboxExec: true, bwrap: false, socat: false, command }
    expect(runtimeIsolation(facts).level).not.toBe('none')
  })
})

describe('the tools line of a card header', () => {
  const card = (header: string): string => `card: #5 a-card [implement/construct/S/cheap/auto] · depends — · blocks —\nbranch: feat/5\ntouches: scripts/x.ts\ncontinue: stop\nwho: shift\n${header}\ndo it\n`

  it('reads comma or space separated words into the card, and no line is no widening', () => {
    expect(cardToolsOf('5.md', card('tools: web, agents\n'))).toEqual(['web', 'agents'])
    expect(cardToolsOf('5.md', card('tools: skills web\n'))).toEqual(['skills', 'web'])
    expect(cardToolsOf('5.md', card('\n'))).toEqual([])
    expect(cardToolsOf('5.md', null)).toEqual([])
  })

  it('refuses an empty line and a word outside the list', () => {
    expect(parseParkingFile('5.md', card('tools:\n'))).toMatchObject({ kind: 'refused', reason: expect.stringContaining('names no tool') as string })
    expect(parseParkingFile('5.md', card('tools: browser\n'))).toMatchObject({ kind: 'refused', reason: expect.stringContaining('\'browser\'') as string })
  })
})

describe('the heartbeat of a card session', () => {
  const ENV = { CONSTRUCT_CARD: '5', CONSTRUCT_STEP: 'launch' }

  function budgetIn(home: string): ReadBudget {
    vi.stubEnv('HOME', home)
    return clientAdapter().readBudget({ session: SESSION, cwd: '/tree', stdoutPath: null })
  }

  function payloadOf(home: string): Record<string, unknown> {
    vi.stubEnv('HOME', home)
    const file = path.join(aRoot(), 'bus.db')
    expect(runHeartbeat(ENV, SESSION, file, () => new Date('2026-11-05T00:00:00.000Z'), home, home)).toBe(0)
    const db = openBus(file)
    try {
      const row = db.prepare(`SELECT payload FROM events WHERE type = 'session.heartbeat'`).get() as { payload: string }
      return JSON.parse(row.payload) as Record<string, unknown>
    }
    finally {
      db.close()
    }
  }

  it('the heartbeat records the context read before the first edit', () => {
    const before = transcriptIn([assistant(contextUsage(100, 20_000, 0)), assistant(contextUsage(100, 500, 20_000), 'Read')])
    expect(payloadOf(before)).toMatchObject({ start_context: 20_100, read_before_edit: null })

    const after = transcriptIn([assistant(contextUsage(100, 20_000, 0)), assistant(contextUsage(100, 5_000, 20_000), 'Read'), assistant(contextUsage(100, 900, 25_000), 'Edit'), assistant(contextUsage(100, 9_000, 26_000), 'Write')])
    expect(payloadOf(after)).toMatchObject({ start_context: 20_100, read_before_edit: 5_900 })

    const written = transcriptIn([assistant(contextUsage(10, 0, 0)), assistant(contextUsage(10, 0, 40), 'Write')])
    expect(payloadOf(written)).toMatchObject({ start_context: 10, read_before_edit: 40 })
  })

  it('the budget and the gauges read one place when the client config variable names another', () => {
    const home = transcriptIn([assistant(contextUsage(100, 20_000, 0)), assistant(contextUsage(100, 500, 20_000), 'Edit')])
    vi.stubEnv('CLAUDE_CONFIG_DIR', aRoot())
    expect(payloadOf(home)).toMatchObject({ context: 20_600, start_context: 20_100, read_before_edit: 500 })
  })

  it('a value the client did not report is null, never zero', () => {
    const missing = transcriptIn([assistant({ output_tokens: 1 }), assistant(contextUsage(1, 1, 1), 'Edit')])
    expect(budgetIn(missing)).toEqual({ startContext: null, readBeforeEdit: null })
    expect(budgetIn(aRoot())).toEqual({ startContext: null, readBeforeEdit: null })

    const file = path.join(aRoot(), 'bus.db')
    const db = openBus(file)
    recordHeartbeat(db, '2026-11-05T00:00:00.000Z', { card: 5, pr: null, head: null, step: 'launch', session: SESSION, lease: null }, () => ({ reason: 'no-transcript' }))
    const row = db.prepare(`SELECT payload FROM events WHERE type = 'session.heartbeat'`).get() as { payload: string }
    db.close()
    expect(JSON.parse(row.payload)).toMatchObject({ start_context: null, read_before_edit: null })
  })
})

describe('the launch header', () => {
  it('the launch header sends the session to the touches and forbids a survey', () => {
    const header = readFileSync(path.join(import.meta.dirname, '..', '..', 'nodes', 'launch', 'header.md'), 'utf8')
    expect(header).toMatch(/Open the paths this task declares first/)
    expect(header).toMatch(/read only those, the tests importing them and the files\s+the task names/)
    expect(header).toMatch(/Do no survey of the repository/)
  })
})
