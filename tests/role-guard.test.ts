import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const HOOK = path.resolve(import.meta.dirname, '../.claude/hooks/role-guard.mjs')
const SESSION = 'sess-roles'
const roots: string[] = []

interface RoleLine { kind: string, [key: string]: unknown }

function repository(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'construct-roles-'))
  roots.push(root)
  mkdirSync(path.join(root, '.claude', 'agents'), { recursive: true })
  writeFileSync(path.join(root, '.claude', 'agents', 'brief.md'), '---\nname: brief\nmodel: sonnet\n---\n\nWrites a brief.\n')
  writeFileSync(path.join(root, '.claude', 'agents', 'scan.md'), '---\nname: scan\n---\n\nLooks things up.\n')
  return root
}

function run(root: string, mode: string, input: Record<string, unknown>): { status: number | null, stdout: string, stderr: string } {
  const result = spawnSync('node', [HOOK, mode], {
    input: JSON.stringify({ session_id: SESSION, cwd: root, ...input }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    encoding: 'utf8',
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function start(root: string, source = 'startup'): void {
  expect(run(root, 'snapshot', { hook_event_name: 'SessionStart', source })).toMatchObject({ status: 0, stdout: '' })
}

function launch(root: string, toolName = 'Agent'): { status: number | null, stdout: string, stderr: string } {
  return run(root, 'guard', { hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: { subagent_type: 'brief', prompt: 'p' } })
}

function roleLines(root: string): RoleLine[] {
  const file = path.join(root, '.construct', 'roles.jsonl')
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(line => line !== '').map(line => JSON.parse(line) as RoleLine) : []
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

describe('the role guard: a role is launched only with the definitions the session started with', () => {
  it('lets a role through when nothing under .claude/agents changed since the session started (W1)', () => {
    const root = repository()
    start(root)

    expect(launch(root)).toMatchObject({ status: 0, stdout: '', stderr: '' })
  })

  it('refuses a role with exit 2 once .claude/agents/brief.md changed, naming .claude/agents and a new session (W2)', () => {
    const root = repository()
    start(root)
    writeFileSync(path.join(root, '.claude', 'agents', 'brief.md'), '---\nname: brief\nmodel: opus\n---\n\nWrites a brief.\n')
    const result = launch(root)

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('.claude/agents')
    expect(result.stderr).toContain('start a new session')
  })

  it('refuses a role with exit 2 once a new definition file appeared under .claude/agents (W3)', () => {
    const root = repository()
    start(root)
    writeFileSync(path.join(root, '.claude', 'agents', 'critic.md'), '---\nname: critic\n---\n')

    expect(launch(root).status).toBe(2)
  })

  it('lets a role through and records no-snapshot when the session started before the snapshot existed (W4)', () => {
    const root = repository()

    expect(launch(root)).toMatchObject({ status: 0, stdout: '' })
    expect(roleLines(root).map(line => [line.kind, line.session])).toEqual([['no-snapshot', SESSION]])
  })

  it('lets every tool but Agent through whatever the definitions are (W8)', () => {
    const root = repository()
    start(root)
    writeFileSync(path.join(root, '.claude', 'agents', 'critic.md'), '---\nname: critic\n---\n')

    expect(launch(root, 'Bash')).toMatchObject({ status: 0, stderr: '' })
  })

  it('keeps the startup snapshot through a compact, and replaces it on a new startup', () => {
    const root = repository()
    start(root)
    writeFileSync(path.join(root, '.claude', 'agents', 'brief.md'), 'changed\n')
    start(root, 'compact')
    expect(launch(root).status).toBe(2)
    start(root, 'startup')
    expect(launch(root).status).toBe(0)
  })

  it('keeps the startup snapshot through a resume, since whether claude --resume re-reads the role definitions is unverified and a needless refusal is the safe error (W9)', () => {
    const root = repository()
    start(root)
    writeFileSync(path.join(root, '.claude', 'agents', 'brief.md'), '---\nname: brief\nmodel: opus\n---\n\nWrites a brief.\n')
    start(root, 'resume')

    expect(launch(root).status).toBe(2)
  })
})

describe('the role guard, when it cannot read what it compares', () => {
  for (const [name, stdin] of [['empty', ''], ['not JSON', 'nope'], ['a JSON array', '[]']] as const) {
    it(`refuses with exit 2 on input that is ${name}`, () => {
      const root = repository()
      const result = spawnSync('node', [HOOK, 'guard'], { input: stdin, env: { ...process.env, CLAUDE_PROJECT_DIR: root }, encoding: 'utf8' })

      expect(result.status).toBe(2)
      expect(result.stderr).toContain('start a new session')
    })
  }

  it('refuses with exit 2 when the snapshot cannot be read', () => {
    const root = repository()
    mkdirSync(path.join(root, '.construct', 'turns.d', `${SESSION}.agents-sha`), { recursive: true })

    expect(launch(root).status).toBe(2)
  })

  it('records an unread line and exits 0 when the snapshot input is not JSON', () => {
    const root = repository()
    const result = spawnSync('node', [HOOK, 'snapshot'], { input: 'nope', env: { ...process.env, CLAUDE_PROJECT_DIR: root }, encoding: 'utf8' })

    expect(result.status).toBe(0)
    expect(roleLines(root).map(line => [line.kind, line.reason])).toEqual([['unread', 'not-an-object']])
  })

  it('records an unread line naming the cause and exits 0 when the snapshot cannot be written', () => {
    const root = repository()
    mkdirSync(path.join(root, '.construct'), { recursive: true })
    writeFileSync(path.join(root, '.construct', 'turns.d'), 'a file where the directory goes')
    start(root)

    expect(roleLines(root).map(line => [line.kind, line.reason])).toEqual([['unread', 'EEXIST']])
  })
})
