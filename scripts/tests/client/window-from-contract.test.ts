import type { ClientRecord } from '../../../src/manifest.js'
import type { Invocation, Refusal, SessionSpec, WindowCommand } from '../../ports/client/contract.js'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MANIFEST_FILE, MANIFEST_VERSION } from '../../../src/manifest.js'
import { WINDOW_COMMAND_VARIABLE, windowCommand } from '../../ports/client/claude/adapter.js'
import { codexAdapter, WINDOW_CENSUS_GAPS } from '../../ports/client/codex/adapter.js'
import { clientAdapter } from '../../ports/client/index.js'
import { CLAUDE_VARIABLE, claudeCommand, DEFAULT_CLAUDE, windowCommandIn } from '../../window/loop.js'

const LOOP_SOURCE = path.join(import.meta.dirname, '..', '..', 'window', 'loop.ts')
const ADAPTER_FILE = /\/ports\/client\/[^/]+\/adapter\.js$/
const CLIENT_INDEX = '../ports/client/index.js'
const CENSUS_ROWS_THE_PROBE_FOUND_MISSING = [8, 9, 15, 16, 18]

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function repositoryWith(client: ClientRecord | null): string {
  const root = mkdtempSync(path.join(tmpdir(), 'window-from-contract-'))
  roots.push(root)
  if (client !== null)
    writeFileSync(path.join(root, MANIFEST_FILE), JSON.stringify({ manifestVersion: MANIFEST_VERSION, client }))
  return root
}

function importsOf(source: string): string[] {
  return [...source.matchAll(/^import\s[^'"]*['"]([^'"]+)['"]/gm)].map(match => match[1]!)
}

function opened(window: WindowCommand | Refusal): WindowCommand {
  if ('kind' in window)
    throw new Error(window.reason)
  return window
}

function windowSpec(): SessionSpec {
  return { kind: 'start', role: 'window', session: 'window-2155', cwd: '/tree', prompt: '', addDirs: [], pick: { model: null }, policy: { profile: 'client-default', gateCommands: [], writePaths: [], mcpOff: false } }
}

function windowInvocation(): Invocation {
  const result = clientAdapter().invocation(windowSpec())
  if ('kind' in result)
    throw new Error(result.reason)
  return result
}

describe('the window takes its command from the client contract', () => {
  it('loop takes the window command from the adapter client.roles.window names and imports no adapter file', () => {
    const imports = importsOf(readFileSync(LOOP_SOURCE, 'utf8'))
    expect(imports.filter(specifier => ADAPTER_FILE.test(specifier))).toEqual([])
    expect(imports).toContain(CLIENT_INDEX)

    expect(windowCommandIn(repositoryWith({ roles: { window: codexAdapter.id } }))).toEqual(codexAdapter.window())
    expect(opened(windowCommandIn(repositoryWith({ id: codexAdapter.id, roles: { window: clientAdapter().id } }))).command).toBe(opened(clientAdapter().window()).command)
    expect(windowCommandIn(repositoryWith({ id: codexAdapter.id }))).toEqual(codexAdapter.window())
    expect(opened(windowCommandIn(repositoryWith(null))).command).toBe(opened(clientAdapter().window()).command)
    expect(windowCommandIn(repositoryWith({ roles: { window: 'no-such-client' } }))).toEqual({ kind: 'refused', reason: expect.stringContaining('no client adapter for id "no-such-client"') })
  })

  it('the claude adapter gives the window command of today', () => {
    const window = opened(clientAdapter().window())
    const invocation = windowInvocation()
    expect(window.command({})).toBe([invocation.command, ...invocation.args].join(' '))
    expect(window.command).toBe(windowCommand)
    expect(window.variable).toBe(WINDOW_COMMAND_VARIABLE)
    expect(window.command({ [window.variable]: '/opt/the-owners-client' })).toBe('/opt/the-owners-client')
    expect(DEFAULT_CLAUDE).toBe(window.command({}))
    expect(claudeCommand).toBe(window.command)
    expect(CLAUDE_VARIABLE).toBe(window.variable)
  })

  it('the second adapter refuses the window naming the census rows it lacks, not with the general refusal', () => {
    const refusal = codexAdapter.window()
    expect(refusal).toEqual({ kind: 'refused', reason: expect.any(String) })
    const { reason } = refusal as Refusal
    expect(WINDOW_CENSUS_GAPS.map(gap => gap.row)).toEqual(CENSUS_ROWS_THE_PROBE_FOUND_MISSING)
    for (const row of CENSUS_ROWS_THE_PROBE_FOUND_MISSING)
      expect(reason).toContain(`row ${row} (`)
    expect(reason).not.toMatch(/read-only review/)
    expect(codexAdapter.invocation(windowSpec())).toEqual(refusal)
  })
})
