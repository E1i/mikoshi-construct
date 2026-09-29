import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { HEADLESS_FLAGS, sessionArgv, sessionEnv, spawnSession } from '../../ghosts/session.js'

function stubBinDir(script: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ghosts-session-bin-'))
  const claude = path.join(dir, 'claude')
  writeFileSync(claude, `#!/usr/bin/env bash\n${script}\n`)
  chmodSync(claude, 0o755)
  return dir
}

describe('sessionArgv', () => {
  it('is the documented headless flags, the session id, then the prompt', () => {
    const argv = sessionArgv('sess-1', '/implement do it')
    expect(argv).toEqual([...HEADLESS_FLAGS, 'sess-1', '/implement do it'])
    expect(argv).toHaveLength(12)
  })

  it('loads no MCP server from the user\'s configuration, since none is passed with --mcp-config', () => {
    expect(sessionArgv('sess-1', '/implement do it')).toContain('--strict-mcp-config')
    expect(sessionArgv('sess-1', '/implement do it')).not.toContain('--mcp-config')
  })
})

describe('sessionEnv', () => {
  it('sets no idle ceiling on top of the given environment', () => {
    expect(sessionEnv({ PATH: '/bin', OTHER: '1' })).toEqual({ PATH: '/bin', OTHER: '1', CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0' })
  })
})

describe('spawnSession', () => {
  it('spawns claude from PATH with the documented argv, cwd and env, writing stdout byte for byte', async () => {
    const bin = stubBinDir('printf \'%s\\0\' "$@" >"$CAPTURE_ARGV"; pwd -P >"$CAPTURE_CWD"; printf \'%s\' "$CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS" >"$CAPTURE_CEILING"; printf \'line-one\\nline-two\\n\'; exit 0')
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
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CAPTURE_ARGV: argvFile, CAPTURE_CWD: cwdFile, CAPTURE_CEILING: ceilingFile },
    })

    expect(code).toBe(0)
    expect(readFileSync(argvFile, 'utf8').split('\0').filter(Boolean)).toEqual(sessionArgv('sess-1', '/implement do it'))
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
})
