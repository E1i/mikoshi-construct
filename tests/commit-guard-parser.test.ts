import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runAttach } from '../src/commands/attach/index.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'

const GUARD = '.construct/commit-guard.mjs'
const PARSER = '.construct/shell-parser.mjs'
const ui = createUi(resolveTheme({ plain: true }), silentWriter)

let attached: string

beforeAll(async () => {
  attached = realpathSync(mkdtempSync(path.join(tmpdir(), 'construct-guard-parser-')))
  execFileSync('git', ['init', '-q'], { cwd: attached })
  writeFileSync(path.join(attached, 'main.go'), 'package main\n')
  execFileSync('git', ['add', 'main.go'], { cwd: attached })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base'], { cwd: attached })
  expect((await runAttach(ui, { dir: attached, harness: 'true', yes: true })).status).toBe('done')
})

afterAll(() => {
  rmSync(attached, { recursive: true, force: true })
})

function guardOn(command: string): ReturnType<typeof spawnSync> {
  const input = JSON.stringify({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: attached })
  return spawnSync('node', [path.join(attached, GUARD)], { input, encoding: 'utf8', cwd: attached })
}

describe('the installed guard and its parser, two files that attach writes together', () => {
  it('refuses a commit with the parser in place', () => {
    const result = guardOn('git commit -m x')
    expect(result.status).toBe(2)
    expect(String(result.stderr)).toMatch(/^Refused: git commit targets /)
  })

  it('lets an ordinary call through with the parser in place', () => {
    expect(guardOn('ls').status).toBe(0)
  })

  it('refuses with exit 2 and one line on stderr when the parser file is missing, whatever the call is', () => {
    const parser = path.join(attached, PARSER)
    const kept = path.join(attached, `${PARSER}.kept`)
    execFileSync('mv', [parser, kept])
    try {
      for (const command of ['ls', 'git commit -m x']) {
        const result = guardOn(command)
        expect(result.status, command).toBe(2)
        expect(String(result.stderr).trim().split('\n'), command).toHaveLength(1)
        expect(String(result.stderr), command).toMatch(/^commit-guard: could not check the call: /)
      }
    }
    finally {
      execFileSync('mv', [kept, parser])
    }
  })
})
