import type { AgentCommand, AgentParts, DiffRun } from '../../supervisor/launchd/install.js'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OWNER_AGENT } from '../../core/bus-path.js'
import { agentCommandOf, FACTORY_DIR_VARIABLE, renderAgent, runAgentCommand, systemDiff, TOKEN_SOURCE_VARIABLE } from '../../supervisor/launchd/install.js'
import { LAUNCH_AGENTS } from '../../supervisor/start.js'

const TEMPLATE = readFileSync(path.resolve(import.meta.dirname, '../../supervisor/launchd/dev.mikoshi.bus.plist'), 'utf8')
const FACTORY_DIR = '/factory/checkout'
const TOKEN_SOURCE = 'gh auth token --user someone'
const UID = 501
const DOMAIN = `gui/${UID}`
const OLD_AGENT = '<plist>the agent installed by hand</plist>\n'
const CHANGED: DiffRun = { status: 1, stdout: '--- installed\n+++ rendered\n-old\n+new\n', stderr: '' }
const SAME: DiffRun = { status: 0, stdout: '', stderr: '' }

function shellLineOf(plist: string): string {
  return [...plist.matchAll(/<string>([^<]*)<\/string>/g)].at(-1)![1]!.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', '\'').replaceAll('&amp;', '&')
}

describe('rendering the bus agent', () => {
  it('renders the given factory directory and token source and keeps the template\'s BUS_RERUN, with no placeholder left', () => {
    const rendered = renderAgent(TEMPLATE, { factoryDir: FACTORY_DIR, tokenSource: TOKEN_SOURCE })
    const shellLine = shellLineOf(rendered)
    expect(shellLine).toContain(`cd '${FACTORY_DIR}' &&`)
    expect(shellLine).toContain(`GH_TOKEN="$(${TOKEN_SOURCE})"`)
    expect(shellLine).toContain('BUS_RERUN=by-layers')
    expect(rendered).not.toMatch(/\{\{|\}\}/)
  })

  it('renders values with shell and XML characters so that the job still runs in that directory with that token', () => {
    const scratch = mkdtempSync(path.join(tmpdir(), 'bus-agent-render-'))
    try {
      const factoryDir = path.join(scratch, 'the owner\'s factory & co')
      const bin = path.join(scratch, '.local', 'bin')
      const calls = path.join(scratch, 'calls')
      mkdirSync(factoryDir)
      mkdirSync(bin, { recursive: true })
      writeFileSync(path.join(bin, 'pnpm'), `#!/bin/sh\necho "$(pwd) token=$GH_TOKEN" >> "${calls}"\n`, { mode: 0o755 })
      const rendered = renderAgent(TEMPLATE, { factoryDir, tokenSource: 'echo a$(echo b) | cat && echo c{{factoryDir}}' })
      expect(rendered).not.toMatch(/<string>[^<]*&(?!amp;|lt;|gt;|quot;|apos;)/)
      const run = spawnSync('/bin/sh', ['-c', shellLineOf(rendered)], { env: { HOME: scratch }, encoding: 'utf8' })
      expect(run.status).toBe(0)
      expect(readFileSync(calls, 'utf8').trim().split('\n').join(' ')).toBe(`${factoryDir} token=ab c{{factoryDir}}`)
    }
    finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  it('refuses a template placeholder it has no value for, rather than installing it unfilled', () => {
    expect(() => renderAgent('{{unknown}}', { factoryDir: FACTORY_DIR, tokenSource: TOKEN_SOURCE })).toThrow('{{unknown}}')
  })
})

describe('the values of the command', () => {
  it('reads them from the environment, and a flag wins over it', () => {
    const env = { [FACTORY_DIR_VARIABLE]: '/from/env', [TOKEN_SOURCE_VARIABLE]: 'env-source' }
    expect(agentCommandOf([], env)).toEqual({ factoryDir: '/from/env', tokenSource: 'env-source', apply: false })
    expect(agentCommandOf(['--factory-dir', '/from/flag', '--token-source', 'flag-source', '--apply'], env)).toEqual({ factoryDir: '/from/flag', tokenSource: 'flag-source', apply: true })
  })

  it('answers an unknown flag with the usage, so a mistyped --apply replaces nothing', () => {
    expect(agentCommandOf(['--aply'], {})).toBeNull()
  })
})

describe('the command against the installed file', () => {
  let home: string
  let installed: string
  let calls: string[][]

  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'bus-agent-home-'))
    installed = path.join(home, LAUNCH_AGENTS, `${OWNER_AGENT}.plist`)
    mkdirSync(path.dirname(installed), { recursive: true })
    writeFileSync(installed, OLD_AGENT)
    calls = []
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  function run(command: Partial<AgentCommand>, diff: DiffRun = CHANGED, overrides: Partial<AgentParts> = {}): ReturnType<typeof runAgentCommand> {
    return runAgentCommand({ factoryDir: FACTORY_DIR, tokenSource: TOKEN_SOURCE, apply: false, ...command }, {
      template: TEMPLATE,
      home,
      uid: UID,
      diff: () => diff,
      launchctl: (args) => {
        calls.push(args)
        return { status: 0, stderr: '' }
      },
      ...overrides,
    })
  }

  it('without --apply prints the diff against the installed file and leaves it unchanged', () => {
    const asked: string[][] = []
    const result = run({}, CHANGED, {
      diff: (file, rendered) => {
        asked.push([file, rendered])
        return CHANGED
      },
    })
    expect(asked).toEqual([[installed, renderAgent(TEMPLATE, { factoryDir: FACTORY_DIR, tokenSource: TOKEN_SOURCE })]])
    expect(result.exitCode).toBe(0)
    expect(result.stdout.join('\n')).toContain(CHANGED.stdout.trimEnd())
    expect(readFileSync(installed, 'utf8')).toBe(OLD_AGENT)
    expect(calls).toEqual([])
  })

  it('the real diff compares the installed file with the rendered text, and shows a first install against nothing', () => {
    const changed = systemDiff(installed, 'the rendered agent\n')
    expect(changed.status).toBe(1)
    expect(changed.stdout).toContain('-<plist>the agent installed by hand</plist>')
    expect(changed.stdout).toContain('+the rendered agent')
    expect(systemDiff(installed, OLD_AGENT)).toMatchObject({ status: 0, stdout: '' })
    expect(systemDiff(path.join(home, 'absent.plist'), 'the rendered agent\n')).toMatchObject({ status: 1, stdout: expect.stringContaining('+the rendered agent') })
    expect(readFileSync(installed, 'utf8')).toBe(OLD_AGENT)
  })

  it('reports an installed file that already matches as nothing to do when there is no diff', () => {
    const result = run({}, SAME)
    expect(result.exitCode).toBe(0)
    expect(result.stdout.join('\n')).toContain('already matches')
    expect(calls).toEqual([])
  })

  it('stops on a diff that could not compare, before any --apply write', () => {
    const result = run({ apply: true }, { status: 2, stdout: '', stderr: 'unreadable' })
    expect(result.exitCode).toBe(1)
    expect(result.stderr.join('\n')).toContain('unreadable')
    expect(readFileSync(installed, 'utf8')).toBe(OLD_AGENT)
    expect(calls).toEqual([])
  })

  it('with --apply replaces the file and asks launchctl to reload the agent', () => {
    const result = run({ apply: true })
    expect(result.exitCode).toBe(0)
    expect(readFileSync(installed, 'utf8')).toBe(renderAgent(TEMPLATE, { factoryDir: FACTORY_DIR, tokenSource: TOKEN_SOURCE }))
    expect(calls).toEqual([['bootout', `${DOMAIN}/${OWNER_AGENT}`], ['bootstrap', DOMAIN, installed]])
    expect(result.stdout.join('\n')).toContain('keeps the environment it started with')
  })

  it('with --apply and a missing or relative value refuses, naming it, and writes and reloads nothing', () => {
    for (const [values, named] of [
      [{ factoryDir: '' }, FACTORY_DIR_VARIABLE],
      [{ tokenSource: '' }, TOKEN_SOURCE_VARIABLE],
      [{ factoryDir: 'relative/checkout' }, 'relative/checkout'],
    ] as const) {
      const result = run({ apply: true, ...values })
      expect(result.exitCode).toBe(1)
      expect(result.stderr.join('\n')).toContain(named)
      expect(result.stderr.join('\n')).toContain('nothing was written')
      expect(readFileSync(installed, 'utf8')).toBe(OLD_AGENT)
    }
    expect(calls).toEqual([])
  })

  it('with --apply on a matching and loaded agent neither writes nor reloads', () => {
    const result = run({ apply: true }, SAME)
    expect(result.exitCode).toBe(0)
    expect(readFileSync(installed, 'utf8')).toBe(OLD_AGENT)
    expect(calls).toEqual([['print', `${DOMAIN}/${OWNER_AGENT}`]])
  })

  it('with --apply on a matching agent that is not loaded loads it', () => {
    const result = run({ apply: true }, SAME, {
      launchctl: (args) => {
        calls.push(args)
        return { status: args[0] === 'print' ? 113 : 0, stderr: '' }
      },
    })
    expect(result.exitCode).toBe(0)
    expect(calls.map(([verb]) => verb)).toEqual(['print', 'bootout', 'bootstrap'])
  })

  it('with --apply names the command that finishes the job when launchctl refuses the reload', () => {
    const result = run({ apply: true }, CHANGED, {
      launchctl: (args) => {
        calls.push(args)
        return args[0] === 'bootstrap' ? { status: 5, stderr: 'Input/output error' } : { status: 0, stderr: '' }
      },
    })
    expect(result.exitCode).toBe(1)
    expect(result.stderr.join('\n')).toContain(`launchctl bootstrap ${DOMAIN} ${installed}`)
    expect(result.stderr.join('\n')).toContain('Input/output error')
  })
})
