import type { IsolationFacts } from '../../ghosts/isolation.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NO_ISOLATION, readIsolationFacts, realIsolationReader, runtimeIsolation } from '../../ghosts/isolation.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

const ENABLED_AND_CLOSED = { sandbox: { enabled: true, allowUnsandboxedCommands: false } }

function facts(over: Partial<IsolationFacts> = {}): IsolationFacts {
  return { managed: null, local: null, project: null, user: ENABLED_AND_CLOSED, platform: 'darwin', sandboxExec: true, bwrap: true, socat: true, command: [], ...over }
}

function closed(sandbox: Record<string, unknown>): IsolationFacts {
  return facts({ user: { sandbox: { enabled: true, allowUnsandboxedCommands: false, ...sandbox } } })
}

type Expected = { level: 'full' } | { level: 'partial', gaps: string[] } | { level: 'none', why: RegExp }

const ROWS: Record<string, { facts: IsolationFacts, expected: Expected }> = {
  'enabled, backend present, nothing open reads full': { facts: facts(), expected: { level: 'full' } },
  'full on linux with bwrap and socat': { facts: facts({ platform: 'linux', sandboxExec: false }), expected: { level: 'full' } },
  'no layer at all reads none': { facts: facts({ user: null }), expected: { level: 'none', why: /sandbox\.enabled is not true.*user or managed/ } },
  'enabled false reads none': { facts: facts({ user: { sandbox: { enabled: false } } }), expected: { level: 'none', why: /sandbox\.enabled is not true/ } },
  'enabled as a string reads none': { facts: facts({ user: { sandbox: { enabled: 'true' } } }), expected: { level: 'none', why: /sandbox\.enabled is not true/ } },
  'a missing sandbox-exec on darwin reads none': { facts: facts({ sandboxExec: false }), expected: { level: 'none', why: /sandbox-exec is missing/ } },
  'a missing bwrap on linux reads none': { facts: facts({ platform: 'linux', bwrap: false }), expected: { level: 'none', why: /^bwrap not found on PATH/ } },
  'a missing socat on linux reads none': { facts: facts({ platform: 'linux', socat: false }), expected: { level: 'none', why: /^socat not found on PATH/ } },
  'another platform reads none': { facts: facts({ platform: 'win32' }), expected: { level: 'none', why: /no backend on win32/ } },
  'a --settings word reads none': { facts: facts({ command: ['claude', '--settings', '/tmp/x.json'] }), expected: { level: 'none', why: /carries --settings/ } },
  'a --setting-sources word reads none': { facts: facts({ command: ['claude', '--setting-sources=user'] }), expected: { level: 'none', why: /--setting-sources=user/ } },
  'a skipped-permissions flag reads none': { facts: facts({ command: ['claude', '--dangerously-skip-permissions'] }), expected: { level: 'none', why: /dangerously-skip-permissions/ } },
  'a bypassPermissions mode reads none': { facts: facts({ command: ['claude', '--permission-mode', 'bypassPermissions'] }), expected: { level: 'none', why: /bypassPermissions/ } },
  'a plain command word keeps full': { facts: facts({ command: ['claude', '--permission-mode', 'dontAsk'] }), expected: { level: 'full' } },
  'every cause is named at once': { facts: facts({ user: null, sandboxExec: false, command: ['--settings'] }), expected: { level: 'none', why: /sandbox\.enabled.*; .*sandbox-exec.*; .*--settings/ } },
  'an unparsable layer is absent': { facts: facts({ user: null, project: null }), expected: { level: 'none', why: /sandbox\.enabled is not true/ } },
  'a sandbox that is not an object counts as absent': { facts: facts({ managed: { sandbox: 'on' }, user: ENABLED_AND_CLOSED }), expected: { level: 'full' } },
  'a network that is not an object counts as absent': { facts: closed({ network: 'open' }), expected: { level: 'full' } },
  'a managed layer overrides a user layer': { facts: facts({ managed: { sandbox: { enabled: false } }, user: ENABLED_AND_CLOSED }), expected: { level: 'none', why: /sandbox\.enabled is not true/ } },
  'a managed enabled outweighs a user disabled': { facts: facts({ managed: { sandbox: { enabled: true, allowUnsandboxedCommands: false } }, user: { sandbox: { enabled: false } } }), expected: { level: 'full' } },
  'a higher layer silent on a key leaves the lower value in force': { facts: facts({ managed: { sandbox: { enabled: true } }, user: { sandbox: { allowUnsandboxedCommands: false } } }), expected: { level: 'full' } },
  'a local layer outweighs a project layer': { facts: facts({ local: { sandbox: { allowUnsandboxedCommands: true } }, project: { sandbox: { allowUnsandboxedCommands: false } } }), expected: { level: 'partial', gaps: ['sandbox.allowUnsandboxedCommands'] } },
  'allowUnsandboxedCommands absent reads partial': { facts: facts({ user: { sandbox: { enabled: true } } }), expected: { level: 'partial', gaps: ['sandbox.allowUnsandboxedCommands'] } },
  'allowUnsandboxedCommands true reads partial': { facts: closed({ allowUnsandboxedCommands: true }), expected: { level: 'partial', gaps: ['sandbox.allowUnsandboxedCommands'] } },
  'excludedCommands reads partial': { facts: closed({ excludedCommands: ['docker'] }), expected: { level: 'partial', gaps: ['sandbox.excludedCommands'] } },
  'an empty excludedCommands keeps full': { facts: closed({ excludedCommands: [] }), expected: { level: 'full' } },
  'an excluded command named only in a lower layer stays a gap': { facts: facts({ managed: { sandbox: { enabled: true, allowUnsandboxedCommands: false, excludedCommands: [] } }, user: { sandbox: { excludedCommands: ['git'] } } }), expected: { level: 'partial', gaps: ['sandbox.excludedCommands'] } },
  'excluded commands of two layers are unioned': { facts: facts({ managed: { sandbox: { enabled: true, allowUnsandboxedCommands: false, excludedCommands: ['docker'] } }, user: { sandbox: { excludedCommands: ['git'] } } }), expected: { level: 'partial', gaps: ['sandbox.excludedCommands'] } },
  'allowAllUnixSockets reads partial': { facts: closed({ network: { allowAllUnixSockets: true } }), expected: { level: 'partial', gaps: ['sandbox.network.allowAllUnixSockets'] } },
  'allowAllUnixSockets false keeps full': { facts: closed({ network: { allowAllUnixSockets: false } }), expected: { level: 'full' } },
  'allowUnixSockets reads partial': { facts: closed({ network: { allowUnixSockets: ['/var/run/docker.sock'] } }), expected: { level: 'partial', gaps: ['sandbox.network.allowUnixSockets'] } },
  'an empty allowUnixSockets keeps full': { facts: closed({ network: { allowUnixSockets: [] } }), expected: { level: 'full' } },
  'allowUnixSockets in a lower layer stays a gap': { facts: facts({ managed: { sandbox: { enabled: true, allowUnsandboxedCommands: false, network: { allowUnixSockets: [] } } }, user: { sandbox: { network: { allowUnixSockets: ['/x.sock'] } } } }), expected: { level: 'partial', gaps: ['sandbox.network.allowUnixSockets'] } },
  'allowLocalBinding reads partial': { facts: closed({ network: { allowLocalBinding: true } }), expected: { level: 'partial', gaps: ['sandbox.network.allowLocalBinding'] } },
  'enableWeakerNestedSandbox reads partial': { facts: closed({ enableWeakerNestedSandbox: true }), expected: { level: 'partial', gaps: ['sandbox.enableWeakerNestedSandbox'] } },
  'enableWeakerNestedSandbox false keeps full': { facts: closed({ enableWeakerNestedSandbox: false }), expected: { level: 'full' } },
  'every gap is named in a fixed order': {
    facts: facts({ user: { sandbox: { enabled: true, excludedCommands: ['docker'], enableWeakerNestedSandbox: true, network: { allowLocalBinding: true, allowUnixSockets: ['/x'], allowAllUnixSockets: true } } } }),
    expected: { level: 'partial', gaps: ['sandbox.allowUnsandboxedCommands', 'sandbox.excludedCommands', 'sandbox.network.allowAllUnixSockets', 'sandbox.network.allowUnixSockets', 'sandbox.network.allowLocalBinding', 'sandbox.enableWeakerNestedSandbox'] },
  },
}

describe('runtimeIsolation', () => {
  for (const [name, row] of Object.entries(ROWS)) {
    it(name, () => {
      const reading = runtimeIsolation(row.facts)
      expect(reading.level).toBe(row.expected.level)
      if (row.expected.level === 'none' && reading.level === 'none')
        expect(reading.why).toMatch(row.expected.why)
      if (row.expected.level === 'partial' && reading.level === 'partial')
        expect(reading.gaps.map(gap => gap.split(' ')[0])).toEqual(row.expected.gaps)
      if (row.expected.level === 'full' && reading.level === 'full')
        expect(reading).toEqual({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] })
    })
  }

  it('an enabled sandbox that allows unsandboxed commands reads partial', () => {
    const base = facts({ managed: { sandbox: { enabled: true } }, user: { sandbox: { enabled: false } } })
    const reading = runtimeIsolation(base)
    expect(reading).toMatchObject({ level: 'partial', mechanism: 'claude-code-sandbox' })
    expect(reading.level === 'partial' && reading.gaps.map(gap => gap.split(' ')[0])).toEqual(['sandbox.allowUnsandboxedCommands'])
    const allowed = runtimeIsolation({ ...base, project: { sandbox: { enabled: true, allowUnsandboxedCommands: true } } })
    expect(allowed).toEqual(reading)
  })

  it('names the refusal word once', () => {
    expect(NO_ISOLATION).toBe('no_isolation')
  })
})

describe('readIsolationFacts', () => {
  it('reads the local, project and user layers, the command words and treats an unparsable file as absent', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'isolation-facts-'))
    roots.push(root)
    const cwd = path.join(root, 'work')
    const config = path.join(root, 'config')
    mkdirSync(path.join(cwd, '.claude'), { recursive: true })
    mkdirSync(config)
    writeFileSync(path.join(cwd, '.claude', 'settings.local.json'), JSON.stringify({ sandbox: { enabled: true } }))
    writeFileSync(path.join(cwd, '.claude', 'settings.json'), '{ not json')
    writeFileSync(path.join(config, 'settings.json'), JSON.stringify({ sandbox: { allowUnsandboxedCommands: false } }))
    const env = { CLAUDE_CONFIG_DIR: config, SHIFT_CLAUDE: '  claude  --settings /tmp/s.json ', PATH: '' }

    const read = readIsolationFacts(env, cwd)
    expect(read.local).toEqual({ sandbox: { enabled: true } })
    expect(read.project).toBeNull()
    expect(read.user).toEqual({ sandbox: { allowUnsandboxedCommands: false } })
    expect(read.command).toEqual(['claude', '--settings', '/tmp/s.json'])
    expect(read.bwrap).toBe(false)
    expect(read.socat).toBe(false)
    expect(readIsolationFacts({ CLAUDE_CONFIG_DIR: config, PATH: '' }, cwd).command).toEqual([])
    expect(realIsolationReader(env, cwd)()).toMatchObject({ level: 'none', why: expect.stringContaining('--settings') as unknown })
  })
})
