import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { PREPARE_ENV_KEYS } from '../../ports/prepare-tree.js'
import { headlessInvocation, reviewModelOf, SessionCeilingReached, sessionEnv, spawnSession, WINDOW_MARK, WINDOW_VARIABLE, withoutCard } from '../../ports/session.js'

const HEADLESS_FLAGS = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'auto', '--permission-prompts', 'none', '--strict-mcp-config', '--session-id']

function headlessArgv(session: string, prompt: string, addDirs: string[] = [], model: string | undefined = undefined): string[] {
  return headlessInvocation({ session, prompt, addDirs, pick: { model: model ?? null } }).args
}

function stubBinDir(script: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ghosts-session-bin-'))
  const claude = path.join(dir, 'claude')
  writeFileSync(claude, `#!/usr/bin/env bash\n${script}\n`)
  chmodSync(claude, 0o755)
  return dir
}

describe('the headless argv', () => {
  it('is the documented headless flags, the session id, then the prompt', () => {
    const argv = headlessArgv('sess-1', '/implement do it')
    expect(argv).toEqual([...HEADLESS_FLAGS, 'sess-1', '/implement do it'])
    expect(argv).toHaveLength(12)
  })

  it('loads no MCP server from the user\'s configuration, since none is passed with --mcp-config', () => {
    expect(headlessArgv('sess-1', '/implement do it')).toContain('--strict-mcp-config')
    expect(headlessArgv('sess-1', '/implement do it')).not.toContain('--mcp-config')
  })
})

describe('the review model of CONSTRUCT_REVIEW_MODEL', () => {
  it('with CONSTRUCT_REVIEW_MODEL set, argv holds --model <value> before the headless flags', () => {
    const argv = headlessArgv('sess-1', 'review it', ['/reviews'], reviewModelOf({ CONSTRUCT_REVIEW_MODEL: 'claude-sonnet-5-5' }))
    expect(argv).toEqual(['--add-dir', '/reviews', '--model', 'claude-sonnet-5-5', ...HEADLESS_FLAGS, 'sess-1', 'review it'])
  })

  it('with CONSTRUCT_REVIEW_MODEL unset or empty, argv holds no --model', () => {
    expect(headlessArgv('sess-1', 'review it', [], reviewModelOf({}))).not.toContain('--model')
    expect(headlessArgv('sess-1', 'review it', [], reviewModelOf({ CONSTRUCT_REVIEW_MODEL: ' ' }))).not.toContain('--model')
  })
})

describe('sessionEnv', () => {
  it('sets no idle ceiling on top of the given environment', () => {
    expect(sessionEnv({ PATH: '/bin' })).toEqual({ PATH: '/bin', CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0', NO_COLOR: '1' })
  })

  it('a variable outside the list does not reach a card session', () => {
    const env = sessionEnv({ PATH: '/bin', OTHER: '1', AWS_SECRET_ACCESS_KEY: 'secret-shaped' }, 1572)
    expect(env).not.toHaveProperty('OTHER')
    expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY')
    expect(env).toEqual({ PATH: '/bin', CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0', NO_COLOR: '1', CONSTRUCT_CARD: '1572' })
  })

  it('a session environment holds exactly the listed names and prefixes', () => {
    const listed = [...PREPARE_ENV_KEYS, 'USER', 'LOGNAME', 'SHELL', 'TERM', 'GH_TOKEN', 'NODE_EXTRA_CA_CERTS', 'CONSTRUCT_HANDOFF', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'LC_ALL']
    const outside = ['OTHER', 'GITHUB_TOKEN', 'NODE_OPTIONS', 'SSH_AUTH_SOCK', 'CONSTRUCT', 'XCLAUDE_KEY', 'LC', 'MIKO_WINDOW', 'FORCE_COLOR', 'CLICOLOR_FORCE', 'CONSTRUCT_BUS_DB']
    const base = Object.fromEntries([...listed, ...outside, 'NO_COLOR'].map(name => [name, 'from-the-bus']))

    const env = sessionEnv(base, 1572)

    const added = ['NO_COLOR', 'CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS', 'CONSTRUCT_CARD']
    expect(Object.keys(env).sort()).toEqual([...listed, ...added].sort())
    expect(Object.fromEntries(listed.map(name => [name, env[name]]))).toEqual(Object.fromEntries(listed.map(name => [name, 'from-the-bus'])))
    expect(env).toMatchObject({ NO_COLOR: '1', CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0', CONSTRUCT_CARD: '1572' })
  })

  it('a session started without a card takes the same list', async () => {
    expect(sessionEnv({ PATH: '/bin', OTHER: '1' })).not.toHaveProperty('OTHER')

    const bin = stubBinDir('test -z "$OTHER" && test -n "$CONSTRUCT_MARK"')
    const work = mkdtempSync(path.join(tmpdir(), 'ghosts-session-list-'))
    const code = await spawnSession({
      cwd: work,
      sessionId: 'sess-list',
      prompt: 'review it',
      stdoutPath: path.join(work, 'out.jsonl'),
      stderrPath: path.join(work, 'out.stderr'),
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OTHER: '1', CONSTRUCT_MARK: '1' },
    })

    expect(code).toBe(0)
  })

  it('names the card in the session environment', () => {
    expect(sessionEnv({ PATH: '/bin' }, 629)).toEqual({ PATH: '/bin', CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0', NO_COLOR: '1', CONSTRUCT_CARD: '629' })
  })

  it('a card session starts without CONSTRUCT_BUS_DB, so it does not inherit the bus that launched it', () => {
    const launcher = { PATH: '/bin', CONSTRUCT_BUS_DB: path.join(tmpdir(), 'launcher-bus', 'bus.db') }
    expect(sessionEnv(launcher, 1295)).not.toHaveProperty('CONSTRUCT_BUS_DB')
    expect(sessionEnv(launcher)).toHaveProperty('CONSTRUCT_BUS_DB', launcher.CONSTRUCT_BUS_DB)
  })
})

describe('sessionEnv witness environment', () => {
  it('witness environment: removes FORCE_COLOR and sets NO_COLOR=1', () => {
    const env = sessionEnv({ PATH: '/bin', FORCE_COLOR: '1', CLICOLOR_FORCE: '1', NO_COLOR: '0' })
    expect(env).not.toHaveProperty('FORCE_COLOR')
    expect(env).not.toHaveProperty('CLICOLOR_FORCE')
    expect(env.NO_COLOR).toBe('1')
  })
})

describe('spawnSession', () => {
  it('spawns claude with --model when the session params name a model', async () => {
    const bin = stubBinDir('printf \'%s\\0\' "$@" >"$CONSTRUCT_CAPTURE_ARGV"; exit 0')
    const work = mkdtempSync(path.join(tmpdir(), 'ghosts-session-model-'))
    const argvFile = path.join(work, 'argv')

    const code = await spawnSession({
      cwd: work,
      sessionId: 'sess-1',
      prompt: 'review it',
      stdoutPath: path.join(work, 'out.jsonl'),
      stderrPath: path.join(work, 'out.stderr'),
      model: 'claude-sonnet-5-5',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CONSTRUCT_CAPTURE_ARGV: argvFile },
    })

    expect(code).toBe(0)
    expect(readFileSync(argvFile, 'utf8').split('\0').filter(Boolean)).toEqual(['--model', 'claude-sonnet-5-5', ...HEADLESS_FLAGS, 'sess-1', 'review it'])
  })

  it('spawns claude from PATH with the documented argv, cwd and env, writing stdout byte for byte', async () => {
    const bin = stubBinDir('printf \'%s\\0\' "$@" >"$CONSTRUCT_CAPTURE_ARGV"; pwd -P >"$CONSTRUCT_CAPTURE_CWD"; printf \'%s\' "$CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS" >"$CONSTRUCT_CAPTURE_CEILING"; printf \'line-one\\nline-two\\n\'; exit 0')
    const work = mkdtempSync(path.join(tmpdir(), 'ghosts-session-work-'))
    const argvFile = path.join(work, 'argv')
    const cwdFile = path.join(work, 'cwd')
    const ceilingFile = path.join(work, 'ceiling')
    const stdoutFile = path.join(work, 'out.jsonl')
    const stderrFile = path.join(work, 'out.stderr')

    const code = await spawnSession({
      cwd: work,
      sessionId: 'sess-1',
      prompt: '/implement do it',
      stdoutPath: stdoutFile,
      stderrPath: stderrFile,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CONSTRUCT_CAPTURE_ARGV: argvFile, CONSTRUCT_CAPTURE_CWD: cwdFile, CONSTRUCT_CAPTURE_CEILING: ceilingFile },
    })

    expect(code).toBe(0)
    expect(readFileSync(argvFile, 'utf8').split('\0').filter(Boolean)).toEqual(headlessArgv('sess-1', '/implement do it'))
    expect(readFileSync(cwdFile, 'utf8').trim()).toBe(realpathSync(work))
    expect(readFileSync(ceilingFile, 'utf8')).toBe('0')
    expect(readFileSync(stdoutFile, 'utf8')).toBe('line-one\nline-two\n')
  })

  it('resolves the exit code the session process exits with', async () => {
    const bin = stubBinDir('exit 3')
    const work = mkdtempSync(path.join(tmpdir(), 'ghosts-session-work-'))

    const code = await spawnSession({
      cwd: work,
      sessionId: 'sess-2',
      prompt: '/implement do it',
      stdoutPath: path.join(work, 'out.jsonl'),
      stderrPath: path.join(work, 'out.stderr'),
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    })

    expect(code).toBe(3)
  })

  it('a session past its ceiling is ended and rejects with a named failure, without waiting for a child that still holds its output', async () => {
    const bin = stubBinDir('sleep 30 &\nsleep 30')
    const work = mkdtempSync(path.join(tmpdir(), 'ghosts-session-work-'))
    const started = Date.now()

    const ended = await spawnSession({
      cwd: work,
      sessionId: 'sess-3',
      prompt: 'review it',
      stdoutPath: path.join(work, 'out.jsonl'),
      stderrPath: path.join(work, 'out.stderr'),
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      ceilingMs: 300,
    }).catch((error: unknown) => error)

    expect(ended).toBeInstanceOf(SessionCeilingReached)
    expect((ended as Error).message).toBe('the session sess-3 ran past its ceiling of 0.005 minutes and was ended')
    expect(Date.now() - started).toBeLessThan(10_000)
  })
})

describe('withoutCard', () => {
  it('a session the window spawns carries neither the card nor the window marker', () => {
    const env = withoutCard({ PATH: '/bin', CONSTRUCT_CARD: '1197', [WINDOW_VARIABLE]: WINDOW_MARK })
    expect(env).toEqual({ PATH: '/bin' })
  })
})
